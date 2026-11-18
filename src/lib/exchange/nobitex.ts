import type { Balances, MarketSnapshot, Side } from "../types";
import { ExchangeError, type Exchange, type ExchangeOrder, type OrderRef } from "./types";

const DEFAULT_BASE = "https://apiv2.nobitex.ir";
const SYMBOL = "USDTIRT";

interface Opts {
  token?: string;
  baseUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function n(v: unknown): number {
  const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : 0;
}

function mapStatus(s: unknown): ExchangeOrder["status"] {
  const v = String(s ?? "").toLowerCase();
  if (v === "done") return "done";
  if (v === "canceled" || v === "cancelled") return "canceled";
  return "active"; // Active, Inactive (stop orders), New...
}

function mapErrorCode(code: string, message: string): ExchangeError {
  const c = code.toLowerCase();
  if (c.includes("duplicate")) return new ExchangeError("DUPLICATE", message || code, false);
  if (c.includes("balance")) return new ExchangeError("INSUFFICIENT_BALANCE", message || code, false);
  if (c.includes("notfound") || c.includes("not_found")) return new ExchangeError("NOT_FOUND", message || code, false);
  if (c.includes("ratelimit") || c.includes("toomany")) return new ExchangeError("RATE_LIMIT", message || code, true);
  return new ExchangeError("REJECTED", `${code}: ${message}`, false);
}

/** Thin Nobitex REST client for the USDT/IRT market. Prices are in rial. */
export class NobitexExchange implements Exchange {
  readonly name = "nobitex";
  private base: string;
  private ua: string;
  private timeout: number;
  private f: typeof fetch;

  constructor(private opts: Opts = {}) {
    this.base = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
    this.ua = opts.userAgent || "TraderBot/StepLadderBot";
    this.timeout = opts.timeoutMs ?? 10_000;
    this.f = opts.fetchImpl ?? fetch;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    auth = true,
    retries = 0,
  ): Promise<Record<string, unknown>> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      try {
        return await this.once(method, path, body, auth);
      } catch (e) {
        lastErr = e;
        if (!(e instanceof ExchangeError) || !e.retryable) throw e;
      }
    }
    throw lastErr;
  }

  private async once(method: "GET" | "POST", path: string, body: Record<string, unknown> | undefined, auth: boolean) {
    const headers: Record<string, string> = { "User-Agent": this.ua, Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (auth) {
      if (!this.opts.token) throw new ExchangeError("AUTH", "توکن API نوبیتکس تنظیم نشده است", false);
      headers.Authorization = `Token ${this.opts.token}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    let res: Response;
    try {
      res = await this.f(this.base + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: "no-store",
      });
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      throw new ExchangeError(aborted ? "TIMEOUT" : "NETWORK", `ارتباط با نوبیتکس برقرار نشد: ${(e as Error).message}`, true);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ExchangeError("AUTH", `نوبیتکس درخواست را نپذیرفت (HTTP ${res.status})`, false);
    }
    if (res.status === 429) throw new ExchangeError("RATE_LIMIT", "محدودیت تعداد درخواست نوبیتکس", true);
    if (res.status >= 500) throw new ExchangeError("SERVER", `خطای سرور نوبیتکس (HTTP ${res.status})`, true);
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ExchangeError("SERVER", `پاسخ نامعتبر از نوبیتکس (HTTP ${res.status})`, true);
    }
    if (json.status === "failed" || res.status >= 400) {
      throw mapErrorCode(String(json.code ?? `HTTP${res.status}`), String(json.message ?? ""));
    }
    return json;
  }

  async getMarket(): Promise<MarketSnapshot> {
    const j = await this.request("GET", `/v3/orderbook/${SYMBOL}`, undefined, false, 2);
    const bids = (j.bids as unknown[][] | undefined) ?? [];
    const asks = (j.asks as unknown[][] | undefined) ?? [];
    const bid = bids.length ? Math.max(...bids.map((b) => n(b[0]))) : 0;
    const ask = asks.length ? Math.min(...asks.map((a) => n(a[0]))) : 0;
    if (!bid || !ask) throw new ExchangeError("SERVER", "دفتر سفارش نوبیتکس خالی است", true);
    const last = n(j.lastTradePrice) || (bid + ask) / 2;
    return { bid, ask, last, at: new Date().toISOString() };
  }

  async getBalances(): Promise<Balances> {
    const j = await this.request("POST", "/users/wallets/list", {}, true, 2);
    const wallets = (j.wallets as Record<string, unknown>[] | undefined) ?? [];
    const pick = (cur: string) => {
      const w = wallets.find((x) => String(x.currency).toLowerCase() === cur);
      const total = n(w?.balance);
      const blocked = n(w?.blockedBalance);
      const free = w && w.activeBalance !== undefined ? n(w.activeBalance) : Math.max(0, total - blocked);
      return { total, free };
    };
    return { rls: pick("rls"), usdt: pick("usdt"), at: new Date().toISOString() };
  }

  private mapOrder(o: Record<string, unknown>): ExchangeOrder {
    return {
      id: String(o.id),
      clientOrderId: o.clientOrderId ? String(o.clientOrderId) : undefined,
      side: (String(o.type) === "sell" ? "sell" : "buy") as Side,
      price: n(o.price),
      amount: n(o.amount),
      filled: n(o.matchedAmount),
      avgPrice: n(o.averagePrice),
      fee: n(o.fee),
      status: mapStatus(o.status),
    };
  }

  async placeLimitOrder(p: { side: Side; price: number; amount: number; clientOrderId: string }): Promise<ExchangeOrder> {
    // no automatic retry: idempotency is handled by the engine through clientOrderId
    const j = await this.request("POST", "/market/orders/add", {
      type: p.side,
      execution: "limit",
      srcCurrency: "usdt",
      dstCurrency: "rls",
      amount: String(p.amount),
      price: String(Math.round(p.price)),
      clientOrderId: p.clientOrderId,
    });
    return this.mapOrder((j.order as Record<string, unknown>) ?? {});
  }

  async getOrder(ref: OrderRef): Promise<ExchangeOrder | null> {
    const body = ref.id ? { id: Number(ref.id) } : { clientOrderId: ref.clientOrderId };
    try {
      const j = await this.request("POST", "/market/orders/status", body, true, 2);
      return j.order ? this.mapOrder(j.order as Record<string, unknown>) : null;
    } catch (e) {
      if (e instanceof ExchangeError && (e.code === "NOT_FOUND" || (e.code === "REJECTED" && /not\s*found|NotFound/i.test(e.message)))) {
        return null;
      }
      throw e;
    }
  }

  async cancelOrder(ref: OrderRef): Promise<void> {
    const body = ref.id ? { order: Number(ref.id), status: "canceled" } : { clientOrderId: ref.clientOrderId, status: "canceled" };
    try {
      await this.request("POST", "/market/orders/update-status", body, true, 1);
    } catch (e) {
      // already done / canceled orders cannot be canceled again — the next status poll resolves them
      if (e instanceof ExchangeError && !e.retryable && e.code !== "AUTH") return;
      throw e;
    }
  }
}
