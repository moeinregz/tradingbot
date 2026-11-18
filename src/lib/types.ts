// All prices are in RIAL (Nobitex "rls"), all amounts in USDT.
// The UI converts rial -> toman (IRT) by dividing by 10.

export type Side = "buy" | "sell";
export type Mode = "paper" | "live";
export type BotStatus = "running" | "stopped" | "emergency";

export interface LevelConfig {
  /** distance from the reference price, in percent (e.g. 2 = 2%) */
  pct: number;
  /** share of the FREE balance at placement time, in percent */
  share: number;
}

export interface BotConfig {
  buyLevels: LevelConfig[];
  sellLevels: LevelConfig[];
  /** minimum order value in rial; smaller orders are skipped */
  minOrderRls: number;
  /** price tick in rial; buy prices are rounded down, sell prices up */
  priceTickRls: number;
  /** decimals allowed for USDT amounts */
  amountDecimals: number;
  /** cancel unfilled limit orders after N minutes (0 = never) */
  orderTimeoutMin: number;
  /** after a rejected order, wait this long before retrying the level */
  failCooldownMin: number;
  /** fee rate used by the paper exchange (0.0025 = 0.25%) */
  paperFeeRate: number;
  paperInitialRls: number;
  paperInitialUsdt: number;
  /** stop the bot after this many consecutive non-retryable errors */
  maxConsecutiveErrors: number;
}

export type LevelStatus = "pending" | "ordered" | "filled";

export interface Level {
  index: number;
  pct: number;
  share: number;
  price: number;
  status: LevelStatus;
  attempt: number;
  orderClientId?: string;
  filledAmount?: number;
  filledPrice?: number;
  filledAt?: string;
  cooldownUntil?: string;
  note?: string;
}

export interface Ladder {
  side: Side;
  ref: number;
  rev: number;
  builtAt: string;
  reason: string;
  levels: Level[];
}

export type OrderState = "submitting" | "active" | "done" | "canceled" | "failed";

export interface TrackedOrder {
  clientOrderId: string;
  exchangeId?: string;
  mode: Mode;
  cycle: number;
  side: Side;
  level: number;
  ladderRev: number;
  price: number;
  amount: number;
  filled: number;
  avgPrice: number;
  fee: number;
  status: OrderState;
  createdAt: string;
  updatedAt: string;
  submitAttempts: number;
  cancelRequested?: boolean;
  obsolete?: boolean;
  pnlRls?: number;
  error?: string;
}

export interface MarketSnapshot {
  bid: number;
  ask: number;
  last: number;
  at: string;
}

export interface Balances {
  rls: { total: number; free: number };
  usdt: { total: number; free: number };
  at: string;
}

export interface PaperOrder {
  id: string;
  clientOrderId: string;
  side: Side;
  price: number;
  amount: number;
  filled: number;
  avgPrice: number;
  fee: number;
  status: "active" | "done" | "canceled";
  createdAt: string;
}

export interface PaperBook {
  rls: number;
  usdt: number;
  seq: number;
  orders: PaperOrder[];
  sim?: { price: number; at: string };
}

export interface Position {
  /** USDT acquired by the bot that is still held */
  usdt: number;
  /** rial cost basis of that USDT */
  costRls: number;
}

export interface BotState {
  version: 1;
  /** random prefix so client order ids never collide across resets */
  epoch: string;
  status: BotStatus;
  mode: Mode;
  cycle: number;
  revCounter: number;
  buyLadder: Ladder | null;
  sellLadder: Ladder | null;
  /** true after the LAST buy level fills; cleared by the next sell */
  buyLocked: boolean;
  activeOrders: TrackedOrder[];
  position: Position;
  realizedPnlRls: number;
  feesRls: number;
  feesUsdt: number;
  tradesCount: number;
  lastMarket?: MarketSnapshot;
  lastBalances?: Balances;
  lastTickAt?: string;
  consecutiveErrors: number;
  lastError?: string;
  paper: PaperBook;
}
