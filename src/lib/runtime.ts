import "server-only";
import { randomUUID } from "node:crypto";
import { mergeConfig } from "./config";
import { runTick, type EngineContext, type TickSummary } from "./engine";
import { NobitexExchange } from "./exchange/nobitex";
import { PaperExchange, simulatedSource, type PriceSource } from "./exchange/paper";
import { ExchangeError, isRetryable, type Exchange } from "./exchange/types";
import { newState } from "./strategy";
import { acquireLock, kvGet, kvSet, releaseLock, store } from "./store/db";
import type { BotConfig, BotState } from "./types";

export const env = {
  liveAllowed: process.env.LIVE_TRADING_ENABLED === "true",
  hasToken: !!process.env.NOBITEX_API_TOKEN,
  priceSource: (process.env.PAPER_PRICE_SOURCE === "simulated" ? "simulated" : "nobitex") as "simulated" | "nobitex",
};

function nobitex() {
  return new NobitexExchange({
    token: process.env.NOBITEX_API_TOKEN,
    baseUrl: process.env.NOBITEX_BASE_URL,
    userAgent: process.env.NOBITEX_USER_AGENT,
  });
}

export async function loadConfig(): Promise<BotConfig> {
  return mergeConfig(await kvGet("config"));
}

export async function loadState(cfg: BotConfig): Promise<BotState> {
  const s = await kvGet<BotState>("state");
  return s ?? newState(cfg, "paper");
}

export async function saveState(s: BotState) {
  await kvSet("state", s);
}

export function buildExchange(state: BotState, cfg: BotConfig): Exchange {
  if (state.mode === "live") {
    if (!env.liveAllowed) throw new ExchangeError("AUTH", "معامله‌ی واقعی با LIVE_TRADING_ENABLED فعال نشده است", false);
    return nobitex();
  }
  let source: PriceSource;
  if (env.priceSource === "simulated") {
    source = simulatedSource(Number(process.env.PAPER_SIM_START_PRICE) || 1_050_000);
  } else {
    const pub = nobitex();
    source = () => pub.getMarket();
  }
  return new PaperExchange(state.paper, source, cfg.paperFeeRate);
}

export interface Session {
  state: BotState;
  cfg: BotConfig;
  ctx: EngineContext;
}

/**
 * Runs `fn` while holding the engine lock with freshly loaded state, then saves the state
 * (even if `fn` throws). Waits up to `waitMs` for the lock.
 */
export async function withBot<T>(fn: (s: Session) => Promise<T>, waitMs = 10_000): Promise<T> {
  const holder = randomUUID();
  const deadline = Date.now() + waitMs;
  while (!(await acquireLock(holder, 90))) {
    if (Date.now() > deadline) throw new Error("موتور مشغول است؛ چند ثانیه بعد دوباره تلاش کنید");
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    const cfg = await loadConfig();
    const state = await loadState(cfg);
    let exchange: Exchange | null = null;
    const ctx: EngineContext = {
      get exchange() {
        exchange ??= buildExchange(state, cfg);
        return exchange;
      },
      store: store,
      now: () => new Date(),
      persist: () => saveState(state),
    };
    try {
      return await fn({ state, cfg, ctx });
    } finally {
      await saveState(state);
    }
  } finally {
    await releaseLock(holder).catch(() => {});
  }
}

/** One engine step with error accounting. Never throws for exchange problems. */
export async function tickOnce(source: string): Promise<TickSummary & { error?: string }> {
  return withBot(async ({ state, cfg, ctx }) => {
    try {
      return await runTick(state, cfg, ctx);
    } catch (e) {
      const msg = (e as Error).message;
      state.lastError = msg;
      state.lastTickAt = new Date().toISOString();
      if (isRetryable(e)) {
        // outage of the exchange / internet: keep the state, try again next tick
        await store.log("warn", `تیک (${source}) ناموفق، تلاش مجدد در تیک بعد: ${msg}`);
      } else {
        state.consecutiveErrors += 1;
        await store.log("error", `خطای تیک (${source}): ${msg}`);
        if (state.status === "running" && state.consecutiveErrors >= cfg.maxConsecutiveErrors) {
          state.status = "stopped";
          await store.log("error", `ربات پس از ${state.consecutiveErrors} خطای پیاپی متوقف شد`);
        }
      }
      return { placed: 0, filled: 0, canceled: 0, status: state.status, error: msg };
    }
  });
}

/** Several ticks within one serverless invocation (used by the cron endpoint). */
export async function tickLoop(source: string, budgetMs: number) {
  const ticks = Math.max(1, Math.min(10, Number(process.env.TICKS_PER_RUN) || 3));
  const interval = Math.max(3, Number(process.env.TICK_INTERVAL_SEC) || 15) * 1000;
  const start = Date.now();
  const results = [];
  for (let i = 0; i < ticks; i++) {
    const t0 = Date.now();
    try {
      results.push(await tickOnce(source));
    } catch (e) {
      results.push({ error: (e as Error).message });
    }
    const next = t0 + interval;
    if (i === ticks - 1 || next - start > budgetMs) break;
    await new Promise((r) => setTimeout(r, Math.max(0, next - Date.now())));
  }
  return results;
}
