import type { Balances, MarketSnapshot, Side } from "../types";

export interface ExchangeOrder {
  id: string;
  clientOrderId?: string;
  side: Side;
  price: number;
  amount: number;
  filled: number;
  avgPrice: number;
  /** buy: fee in USDT (received asset); sell: fee in rial */
  fee: number;
  status: "active" | "done" | "canceled";
}

export interface OrderRef {
  id?: string;
  clientOrderId?: string;
}

export interface Exchange {
  readonly name: string;
  getMarket(): Promise<MarketSnapshot>;
  getBalances(): Promise<Balances>;
  placeLimitOrder(p: { side: Side; price: number; amount: number; clientOrderId: string }): Promise<ExchangeOrder>;
  /** returns null when the exchange does not know the order */
  getOrder(ref: OrderRef): Promise<ExchangeOrder | null>;
  cancelOrder(ref: OrderRef): Promise<void>;
}

export type ExchangeErrorCode =
  | "NETWORK"
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "SERVER"
  | "AUTH"
  | "DUPLICATE"
  | "INSUFFICIENT_BALANCE"
  | "NOT_FOUND"
  | "REJECTED";

export class ExchangeError extends Error {
  constructor(
    public code: ExchangeErrorCode,
    message: string,
    public retryable: boolean,
  ) {
    super(message);
    this.name = "ExchangeError";
  }
}

export function isRetryable(e: unknown): boolean {
  return e instanceof ExchangeError ? e.retryable : true;
}
