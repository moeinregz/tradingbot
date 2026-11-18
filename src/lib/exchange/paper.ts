import { roundTo } from "../math";
import type { Balances, MarketSnapshot, PaperBook, PaperOrder, Side } from "../types";
import { ExchangeError, type Exchange, type ExchangeOrder, type OrderRef } from "./types";

export type PriceSource = (book: PaperBook) => Promise<MarketSnapshot>;

/** Random-walk price source for demos when Nobitex is unreachable. */
export function simulatedSource(startPrice: number, now: () => Date = () => new Date()): PriceSource {
  return async (book) => {
    const t = now();
    const prev = book.sim ?? { price: startPrice, at: t.toISOString() };
    const dtMin = Math.max(0, Math.min(60, (t.getTime() - new Date(prev.at).getTime()) / 60000));
    // gaussian step, ~0.35% per sqrt(minute)
    const g = Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
    const price = Math.max(1000, prev.price * (1 + 0.0035 * Math.sqrt(dtMin) * g));
    book.sim = { price, at: t.toISOString() };
    const half = price * 0.0005;
    return { bid: Math.round(price - half), ask: Math.round(price + half), last: Math.round(price), at: t.toISOString() };
  };
}

/**
 * Paper exchange: real (or simulated) prices, simulated balances and fills.
 * Its whole state lives in `book`, which is persisted with the bot state.
 * A limit order fills completely as soon as the market crosses its price,
 * at the better market price (taker-style), paying `feeRate`.
 */
export class PaperExchange implements Exchange {
  readonly name = "paper";
  private market?: MarketSnapshot;

  constructor(
    private book: PaperBook,
    private source: PriceSource,
    private feeRate: number,
    private now: () => Date = () => new Date(),
  ) {}

  async getMarket(): Promise<MarketSnapshot> {
    this.market = await this.source(this.book);
    this.match();
    return this.market;
  }

  private locked() {
    let rls = 0;
    let usdt = 0;
    for (const o of this.book.orders) {
      if (o.status !== "active") continue;
      const rem = o.amount - o.filled;
      if (o.side === "buy") rls += rem * o.price;
      else usdt += rem;
    }
    return { rls, usdt };
  }

  async getBalances(): Promise<Balances> {
    const l = this.locked();
    return {
      rls: { total: this.book.rls, free: Math.max(0, this.book.rls - l.rls) },
      usdt: { total: this.book.usdt, free: Math.max(0, roundTo(this.book.usdt - l.usdt, 8)) },
      at: this.now().toISOString(),
    };
  }

  private toExchange(o: PaperOrder): ExchangeOrder {
    return { ...o };
  }

  async placeLimitOrder(p: { side: Side; price: number; amount: number; clientOrderId: string }): Promise<ExchangeOrder> {
    if (this.book.orders.some((o) => o.clientOrderId === p.clientOrderId)) {
      throw new ExchangeError("DUPLICATE", "DuplicateClientOrderId", false);
    }
    if (!(p.amount > 0) || !(p.price > 0)) throw new ExchangeError("REJECTED", "invalid order", false);
    const bal = await this.getBalances();
    if (p.side === "buy" && p.amount * p.price > bal.rls.free + 1e-6) {
      throw new ExchangeError("INSUFFICIENT_BALANCE", "موجودی ریالی کافی نیست", false);
    }
    if (p.side === "sell" && p.amount > bal.usdt.free + 1e-9) {
      throw new ExchangeError("INSUFFICIENT_BALANCE", "موجودی تتر کافی نیست", false);
    }
    this.book.seq += 1;
    const o: PaperOrder = {
      id: `paper-${this.book.seq}`,
      clientOrderId: p.clientOrderId,
      side: p.side,
      price: p.price,
      amount: p.amount,
      filled: 0,
      avgPrice: 0,
      fee: 0,
      status: "active",
      createdAt: this.now().toISOString(),
    };
    this.book.orders.push(o);
    this.match();
    this.prune();
    return this.toExchange(o);
  }

  private match() {
    const m = this.market;
    if (!m) return;
    for (const o of this.book.orders) {
      if (o.status !== "active") continue;
      const rem = o.amount - o.filled;
      if (o.side === "buy" && m.ask <= o.price) {
        const px = m.ask;
        const fee = roundTo(rem * this.feeRate, 8);
        this.book.rls -= rem * px;
        this.book.usdt = roundTo(this.book.usdt + rem - fee, 8);
        this.fill(o, rem, px, fee);
      } else if (o.side === "sell" && m.bid >= o.price) {
        const px = m.bid;
        const fee = rem * px * this.feeRate;
        this.book.usdt = roundTo(this.book.usdt - rem, 8);
        this.book.rls += rem * px - fee;
        this.fill(o, rem, px, fee);
      }
    }
  }

  private fill(o: PaperOrder, qty: number, px: number, fee: number) {
    o.avgPrice = o.filled > 0 ? (o.avgPrice * o.filled + px * qty) / (o.filled + qty) : px;
    o.filled = roundTo(o.filled + qty, 8);
    o.fee += fee;
    o.status = "done";
  }

  private prune() {
    const inactive = this.book.orders.filter((o) => o.status !== "active");
    if (inactive.length > 100) {
      const drop = new Set(inactive.slice(0, inactive.length - 100));
      this.book.orders = this.book.orders.filter((o) => !drop.has(o));
    }
  }

  private find(ref: OrderRef) {
    return this.book.orders.find((o) => (ref.id ? o.id === ref.id : o.clientOrderId === ref.clientOrderId));
  }

  async getOrder(ref: OrderRef): Promise<ExchangeOrder | null> {
    this.match();
    const o = this.find(ref);
    return o ? this.toExchange(o) : null;
  }

  async cancelOrder(ref: OrderRef): Promise<void> {
    const o = this.find(ref);
    if (o && o.status === "active") o.status = "canceled";
  }
}
