import { ceilTick, floorTick } from "./math";
import type { BotConfig, BotState, Ladder, Level, Mode, Side, TrackedOrder } from "./types";

export function randomEpoch(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function newState(cfg: BotConfig, mode: Mode = "paper"): BotState {
  return {
    version: 1,
    epoch: randomEpoch(),
    status: "stopped",
    mode,
    cycle: 0,
    revCounter: 0,
    buyLadder: null,
    sellLadder: null,
    buyLocked: false,
    activeOrders: [],
    position: { usdt: 0, costRls: 0 },
    realizedPnlRls: 0,
    feesRls: 0,
    feesUsdt: 0,
    tradesCount: 0,
    consecutiveErrors: 0,
    paper: { rls: cfg.paperInitialRls, usdt: cfg.paperInitialUsdt, seq: 0, orders: [] },
  };
}

export function buildLadder(
  state: BotState,
  cfg: BotConfig,
  side: Side,
  ref: number,
  now: Date,
  reason: string,
): Ladder {
  state.revCounter += 1;
  const defs = side === "buy" ? cfg.buyLevels : cfg.sellLevels;
  const levels: Level[] = defs.map((d, index) => ({
    index,
    pct: d.pct,
    share: d.share,
    price:
      side === "buy"
        ? floorTick(ref * (1 - d.pct / 100), cfg.priceTickRls)
        : ceilTick(ref * (1 + d.pct / 100), cfg.priceTickRls),
    status: "pending",
    attempt: 0,
  }));
  return { side, ref, rev: state.revCounter, builtAt: now.toISOString(), reason, levels };
}

/** Marks every live order of the given side(s) as obsolete so the engine cancels it. */
export function obsoleteOrders(state: BotState, side?: Side) {
  for (const o of state.activeOrders) {
    if (!side || o.side === side) o.obsolete = true;
  }
}

export function startCycle(state: BotState, cfg: BotConfig, ref: number, now: Date, reason: string) {
  state.cycle += 1;
  obsoleteOrders(state);
  state.buyLadder = buildLadder(state, cfg, "buy", ref, now, reason);
  state.sellLadder = buildLadder(state, cfg, "sell", ref, now, reason);
  state.buyLocked = false;
}

export function rebuildBuyLadder(state: BotState, cfg: BotConfig, ref: number, now: Date, reason: string) {
  obsoleteOrders(state, "buy");
  state.buyLadder = buildLadder(state, cfg, "buy", ref, now, reason);
  state.buyLocked = false;
}

export function levelOf(state: BotState, o: Pick<TrackedOrder, "side" | "ladderRev" | "level">): Level | null {
  const ladder = o.side === "buy" ? state.buyLadder : state.sellLadder;
  if (!ladder || ladder.rev !== o.ladderRev) return null;
  return ladder.levels[o.level] ?? null;
}

export function isLastLevel(ladder: Ladder | null, index: number): boolean {
  return !!ladder && index === ladder.levels.length - 1;
}

export function clientOrderId(state: BotState, side: Side, level: Level, rev: number): string {
  // kept short: Nobitex limits clientOrderId length
  const m = state.mode === "live" ? "L" : "P";
  return `sb${m}${state.epoch}c${state.cycle}${side[0]}${level.index + 1}r${rev}a${level.attempt}`;
}
