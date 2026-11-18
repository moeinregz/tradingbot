import { ExchangeError, isRetryable, type Exchange, type ExchangeOrder } from "./exchange/types";
import { floorTo, midPrice, minutesBetween, roundTo } from "./math";
import { clientOrderId, isLastLevel, levelOf, rebuildBuyLadder, startCycle } from "./strategy";
import type { Balances, BotConfig, BotState, Level, MarketSnapshot, Side, TrackedOrder } from "./types";

export type LogLevel = "info" | "warn" | "error";

export interface EngineStore {
  log(level: LogLevel, message: string, data?: unknown): Promise<void>;
  upsertOrder(o: TrackedOrder): Promise<void>;
  recordPrice(m: MarketSnapshot): Promise<void>;
}

export interface EngineContext {
  exchange: Exchange;
  store: EngineStore;
  now: () => Date;
  /** durably saves `state` — called before every order submission (crash safety) */
  persist: () => Promise<void>;
}

export interface TickSummary {
  price?: number;
  placed: number;
  filled: number;
  canceled: number;
  status: BotState["status"];
}

const MAX_SUBMIT_ATTEMPTS = 3;
const SUBMIT_GRACE_SEC = 20;

const fmt = (rls: number) => Math.round(rls / 10).toLocaleString("en-US");
const sideFa = (s: Side) => (s === "buy" ? "خرید" : "فروش");

/**
 * One engine step. The caller must hold the engine lock, load `state` before
 * and save it after (also on error). Order of work:
 *   1. fetch market  2. reconcile tracked orders  3. place triggered levels
 *   4. reconcile again (fast fills)  5. refresh balances
 */
export async function runTick(state: BotState, cfg: BotConfig, ctx: EngineContext): Promise<TickSummary> {
  const sum: TickSummary = { placed: 0, filled: 0, canceled: 0, status: state.status };
  const market = await ctx.exchange.getMarket();
  sum.price = midPrice(market);
  state.lastMarket = market;
  await ctx.store.recordPrice(market);

  await reconcile(state, cfg, ctx, sum);

  if (state.status === "running") {
    if (!state.buyLadder || !state.sellLadder) {
      startCycle(state, cfg, midPrice(market), ctx.now(), "start");
      await ctx.store.log("info", `چرخه‌ی ${state.cycle} شروع شد؛ قیمت مرجع ${fmt(midPrice(market))} تومان`);
    }
    const bal = await ctx.exchange.getBalances();
    state.lastBalances = bal;
    await placeTriggered(state, cfg, ctx, market, bal, sum);
    if (sum.placed > 0) await reconcile(state, cfg, ctx, sum);
  }

  if (sum.placed > 0 || sum.filled > 0 || sum.canceled > 0 || !state.lastBalances || state.status !== "running") {
    state.lastBalances = await ctx.exchange.getBalances();
  }
  state.lastTickAt = ctx.now().toISOString();
  state.consecutiveErrors = 0;
  state.lastError = undefined;
  sum.status = state.status;
  return sum;
}

// ---------------------------------------------------------------- placement

async function placeTriggered(
  state: BotState,
  cfg: BotConfig,
  ctx: EngineContext,
  m: MarketSnapshot,
  bal: Balances,
  sum: TickSummary,
) {
  const now = ctx.now();
  let freeRls = bal.rls.free;
  let freeUsdt = bal.usdt.free;

  // ---- buys: trigger when the best ask reaches the level price
  if (state.buyLadder && !state.buyLocked) {
    const ladder = state.buyLadder;
    for (const lvl of ladder.levels) {
      if (lvl.status !== "pending" || m.ask > lvl.price || coolingDown(lvl, now)) continue;
      const budget = (freeRls * lvl.share) / 100;
      const amount = floorTo(budget / lvl.price, cfg.amountDecimals);
      const value = amount * lvl.price;
      if (amount <= 0 || value < cfg.minOrderRls) {
        await noteLevel(ctx, lvl, "insufficient", `خرید پله ${lvl.index + 1}: مبلغ ${fmt(value)} تومان کمتر از حداقل سفارش است`);
        continue;
      }
      const ok = await submit(state, cfg, ctx, "buy", lvl, ladder.rev, amount);
      if (ok) {
        freeRls -= value;
        sum.placed += 1;
      }
    }
  }

  // ---- sells: trigger when the best bid reaches the level price
  if (state.sellLadder) {
    const ladder = state.sellLadder;
    for (const lvl of ladder.levels) {
      if (lvl.status !== "pending" || m.bid < lvl.price || coolingDown(lvl, now)) continue;
      const amount = floorTo((freeUsdt * lvl.share) / 100, cfg.amountDecimals);
      const value = amount * lvl.price;
      if (amount <= 0 || value < cfg.minOrderRls) {
        await noteLevel(ctx, lvl, "insufficient", `فروش پله ${lvl.index + 1}: موجودی آزاد تتر کافی نیست (${amount} USDT)`);
        continue;
      }
      const ok = await submit(state, cfg, ctx, "sell", lvl, ladder.rev, amount);
      if (ok) {
        freeUsdt -= amount;
        sum.placed += 1;
      }
    }
  }
}

function coolingDown(lvl: Level, now: Date) {
  return !!lvl.cooldownUntil && new Date(lvl.cooldownUntil) > now;
}

/** logs only when the note changes, to avoid spamming every tick */
async function noteLevel(ctx: EngineContext, lvl: Level, note: string, message: string) {
  if (lvl.note === note) return;
  lvl.note = note;
  await ctx.store.log("warn", message);
}

async function submit(
  state: BotState,
  cfg: BotConfig,
  ctx: EngineContext,
  side: Side,
  lvl: Level,
  rev: number,
  amount: number,
): Promise<boolean> {
  const now = ctx.now().toISOString();
  const o: TrackedOrder = {
    clientOrderId: clientOrderId(state, side, lvl, rev),
    mode: state.mode,
    cycle: state.cycle,
    side,
    level: lvl.index,
    ladderRev: rev,
    price: lvl.price,
    amount,
    filled: 0,
    avgPrice: 0,
    fee: 0,
    status: "submitting",
    createdAt: now,
    updatedAt: now,
    submitAttempts: 0,
  };
  // duplicate guard: never two live orders for the same level of the same ladder
  if (state.activeOrders.some((x) => x.side === side && x.ladderRev === rev && x.level === lvl.index)) return false;

  lvl.status = "ordered";
  lvl.orderClientId = o.clientOrderId;
  lvl.note = undefined;
  state.activeOrders.push(o);
  // write-ahead: if we crash after this point, recovery looks the order up by clientOrderId
  await ctx.persist();
  await ctx.store.upsertOrder(o);
  return sendOrder(state, cfg, ctx, o);
}

async function sendOrder(state: BotState, cfg: BotConfig, ctx: EngineContext, o: TrackedOrder): Promise<boolean> {
  o.submitAttempts += 1;
  try {
    const r = await ctx.exchange.placeLimitOrder({
      side: o.side,
      price: o.price,
      amount: o.amount,
      clientOrderId: o.clientOrderId,
    });
    o.status = "active";
    sync(o, r);
    await ctx.store.log(
      "info",
      `سفارش ${sideFa(o.side)} پله ${o.level + 1} ثبت شد: ${o.amount} USDT @ ${fmt(o.price)} تومان`,
      { clientOrderId: o.clientOrderId },
    );
  } catch (e) {
    if (e instanceof ExchangeError && e.code === "DUPLICATE") {
      // the exchange already has it (earlier attempt went through) — adopt it
      const r = await ctx.exchange.getOrder({ clientOrderId: o.clientOrderId });
      if (r) {
        o.status = "active";
        sync(o, r);
      }
    } else if (isRetryable(e)) {
      o.error = (e as Error).message;
      await ctx.store.log("warn", `ثبت سفارش ${o.clientOrderId} نامشخص ماند؛ در تیک بعد بررسی می‌شود`, { error: o.error });
    } else {
      await failOrder(state, cfg, ctx, o, (e as Error).message);
      await ctx.store.upsertOrder(o);
      await ctx.persist();
      return false;
    }
  }
  o.updatedAt = ctx.now().toISOString();
  await ctx.store.upsertOrder(o);
  await ctx.persist();
  return true;
}

async function failOrder(state: BotState, cfg: BotConfig, ctx: EngineContext, o: TrackedOrder, msg: string) {
  o.status = "failed";
  o.error = msg;
  const lvl = levelOf(state, o);
  if (lvl && lvl.status === "ordered") {
    lvl.status = "pending";
    lvl.attempt += 1;
    lvl.cooldownUntil = new Date(ctx.now().getTime() + cfg.failCooldownMin * 60000).toISOString();
  }
  state.activeOrders = state.activeOrders.filter((x) => x !== o);
  await ctx.store.log("error", `سفارش ${sideFa(o.side)} پله ${o.level + 1} رد شد: ${msg}`, { clientOrderId: o.clientOrderId });
}

// ---------------------------------------------------------------- reconcile

function sync(o: TrackedOrder, r: ExchangeOrder) {
  if (r.id) o.exchangeId = r.id;
  o.filled = r.filled;
  o.avgPrice = r.avgPrice || o.avgPrice;
  o.fee = r.fee;
}

async function reconcile(state: BotState, cfg: BotConfig, ctx: EngineContext, sum: TickSummary) {
  const now = ctx.now();
  for (const o of [...state.activeOrders]) {
    if (!state.activeOrders.includes(o)) continue;

    if (o.status === "submitting") {
      const r = await ctx.exchange.getOrder({ clientOrderId: o.clientOrderId });
      if (r) {
        o.status = "active";
        sync(o, r);
      } else if ((now.getTime() - new Date(o.updatedAt).getTime()) / 1000 < SUBMIT_GRACE_SEC) {
        continue;
      } else if (o.obsolete || state.status !== "running" || o.submitAttempts >= MAX_SUBMIT_ATTEMPTS) {
        await failOrder(state, cfg, ctx, o, o.obsolete ? "نردبان تغییر کرد" : "ثبت سفارش تأیید نشد");
        await ctx.store.upsertOrder(o);
        continue;
      } else {
        // same clientOrderId => the exchange rejects it if the first attempt actually landed
        await sendOrder(state, cfg, ctx, o);
        continue;
      }
    }

    if (o.status !== "active") continue;
    let r = await ctx.exchange.getOrder({ id: o.exchangeId, clientOrderId: o.clientOrderId });
    if (!r) {
      await ctx.store.log("warn", `سفارش ${o.clientOrderId} در صرافی پیدا نشد`);
      continue;
    }
    sync(o, r);

    if (r.status === "active") {
      const timedOut = cfg.orderTimeoutMin > 0 && minutesBetween(o.createdAt, now) > cfg.orderTimeoutMin;
      const mustCancel = o.obsolete || timedOut || state.status === "emergency";
      if (mustCancel && !o.cancelRequested) {
        await ctx.exchange.cancelOrder({ id: o.exchangeId, clientOrderId: o.clientOrderId });
        o.cancelRequested = true;
        await ctx.store.log(
          "info",
          `لغو سفارش ${sideFa(o.side)} پله ${o.level + 1} (${o.obsolete ? "نردبان جدید" : timedOut ? "پایان مهلت" : "توقف اضطراری"})`,
        );
        r = (await ctx.exchange.getOrder({ id: o.exchangeId, clientOrderId: o.clientOrderId })) ?? r;
        sync(o, r);
      }
    }

    if (r.status === "done" || r.status === "canceled") {
      await finalize(state, cfg, ctx, o, r.status, sum);
    }
    o.updatedAt = now.toISOString();
    await ctx.store.upsertOrder(o);
  }
}

async function finalize(
  state: BotState,
  cfg: BotConfig,
  ctx: EngineContext,
  o: TrackedOrder,
  status: "done" | "canceled",
  sum: TickSummary,
) {
  o.status = status;
  state.activeOrders = state.activeOrders.filter((x) => x !== o);
  const lvl = levelOf(state, o);
  if (o.filled > 0) {
    sum.filled += 1;
    await applyFill(state, cfg, ctx, o, lvl);
  } else {
    sum.canceled += 1;
    if (lvl && lvl.status === "ordered" && lvl.orderClientId === o.clientOrderId) {
      // nothing filled: re-arm the level (new attempt => new clientOrderId)
      lvl.status = "pending";
      lvl.attempt += 1;
    }
  }
}

async function applyFill(state: BotState, cfg: BotConfig, ctx: EngineContext, o: TrackedOrder, lvl: Level | null) {
  const now = ctx.now();
  const px = o.avgPrice || o.price;
  state.tradesCount += 1;

  if (lvl) {
    lvl.status = "filled";
    lvl.filledAmount = o.filled;
    lvl.filledPrice = px;
    lvl.filledAt = now.toISOString();
  }

  if (o.side === "buy") {
    // Nobitex charges the fee in the received asset (USDT) on buys
    state.position.usdt = roundTo(state.position.usdt + o.filled - o.fee, 8);
    state.position.costRls += o.filled * px;
    state.feesUsdt += o.fee;
    await ctx.store.log("info", `✅ خرید پله ${o.level + 1} اجرا شد: ${o.filled} USDT @ ${fmt(px)} تومان`, {
      fee: o.fee,
    });
    if (lvl && isLastLevel(state.buyLadder, o.level)) {
      state.buyLocked = true;
      await ctx.store.log("warn", "آخرین پله‌ی خرید اجرا شد؛ خرید جدید تا انجام یک فروش متوقف است");
    }
    return;
  }

  // ---- sell
  const proceeds = o.filled * px - o.fee; // fee in rial on sells
  const fromPosition = Math.min(o.filled, state.position.usdt);
  const avgCost = state.position.usdt > 0 ? state.position.costRls / state.position.usdt : px;
  const costOut = avgCost * fromPosition + px * (o.filled - fromPosition); // USDT not bought by the bot => zero PnL
  const pnl = proceeds - costOut;
  o.pnlRls = pnl;
  state.realizedPnlRls += pnl;
  state.feesRls += o.fee;
  state.position.usdt = roundTo(Math.max(0, state.position.usdt - fromPosition), 8);
  state.position.costRls = state.position.usdt > 0 ? Math.max(0, state.position.costRls - avgCost * fromPosition) : 0;
  await ctx.store.log(
    "info",
    `✅ فروش پله ${o.level + 1} اجرا شد: ${o.filled} USDT @ ${fmt(px)} تومان؛ سود/زیان ${fmt(pnl)} تومان`,
  );

  if (!lvl) return; // fill of an order from an older ladder: accounting only

  if (isLastLevel(state.sellLadder, o.level)) {
    startCycle(state, cfg, px, now, "آخرین پله‌ی فروش");
    await ctx.store.log("info", `🔁 آخرین پله‌ی فروش اجرا شد؛ چرخه‌ی ${state.cycle} از قیمت ${fmt(px)} تومان شروع شد`);
  } else {
    // core rule: only the BUY ladder is rebuilt from the execution price of this sell
    rebuildBuyLadder(state, cfg, px, now, `فروش پله ${o.level + 1}`);
    await ctx.store.log("info", `نردبان خرید از قیمت فروش ${fmt(px)} تومان بازسازی شد`);
  }
}

// ---------------------------------------------------------------- controls

/** Emergency stop: block new orders and cancel everything that is open. */
export async function emergencyStop(state: BotState, cfg: BotConfig, ctx: EngineContext) {
  state.status = "emergency";
  await ctx.store.log("error", "⛔ توقف اضطراری فعال شد؛ همه‌ی سفارش‌های باز لغو می‌شوند");
  for (const o of state.activeOrders) {
    try {
      if (o.status === "active" || o.status === "submitting") {
        await ctx.exchange.cancelOrder({ id: o.exchangeId, clientOrderId: o.clientOrderId });
        o.cancelRequested = true;
      }
    } catch (e) {
      await ctx.store.log("error", `لغو ${o.clientOrderId} ناموفق بود: ${(e as Error).message}`);
    }
  }
  const sum: TickSummary = { placed: 0, filled: 0, canceled: 0, status: state.status };
  try {
    await reconcile(state, cfg, ctx, sum);
  } catch (e) {
    await ctx.store.log("warn", `بررسی سفارش‌ها پس از توقف اضطراری ناموفق بود: ${(e as Error).message}`);
  }
}

/** Abandon current ladders and start a new cycle from the current market price. */
export async function resetCycle(state: BotState, cfg: BotConfig, ctx: EngineContext) {
  const m = await ctx.exchange.getMarket();
  startCycle(state, cfg, midPrice(m), ctx.now(), "manual");
  await ctx.store.log("info", `چرخه‌ی ${state.cycle} به‌صورت دستی از قیمت ${fmt(midPrice(m))} تومان شروع شد`);
}
