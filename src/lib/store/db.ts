import { MongoClient, MongoServerError, type Db } from "mongodb";
import type { MarketSnapshot, TrackedOrder } from "../types";
import type { EngineStore, LogLevel } from "../engine";

/*
 * MongoDB storage (works with the free MongoDB Atlas M0 cluster).
 *
 * collections
 *   sb_kv      { _id: key, value, updatedAt }             bot state, config, 2FA secret, login guard
 *   sb_orders  { _id: clientOrderId, ...order }            order history
 *   sb_logs    { ts, level, message, data }                TTL 30 days
 *   sb_prices  { _id: minute (ms), ts, bid, ask, last }    one point per minute, TTL 14 days
 *   sb_lock    { _id: "engine", holder, lockedUntil }      lease lock
 */

declare global {
  // eslint-disable-next-line no-var
  var __sbMongo: Promise<MongoClient> | undefined;
  // eslint-disable-next-line no-var
  var __sbIndexes: Promise<void> | undefined;
}

function client(): Promise<MongoClient> {
  if (!globalThis.__sbMongo) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI تنظیم نشده است");
    globalThis.__sbMongo = new MongoClient(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10_000,
      appName: "step-bot",
    })
      .connect()
      .catch((e) => {
        globalThis.__sbMongo = undefined;
        throw e;
      });
  }
  return globalThis.__sbMongo;
}

async function rawDb(): Promise<Db> {
  return (await client()).db(process.env.MONGODB_DB || "stepbot");
}

async function ensureIndexes(d: Db) {
  await Promise.all([
    d.collection("sb_orders").createIndex({ created_at: -1 }),
    d.collection("sb_orders").createIndex({ mode: 1, created_at: -1 }),
    d.collection("sb_logs").createIndex({ ts: -1 }),
    d.collection("sb_logs").createIndex({ ts: 1 }, { expireAfterSeconds: 30 * 86400, name: "ttl_30d" }),
    d.collection("sb_prices").createIndex({ ts: 1 }, { expireAfterSeconds: 14 * 86400, name: "ttl_14d" }),
  ]);
}

export async function db(): Promise<Db> {
  const d = await rawDb();
  if (!globalThis.__sbIndexes) {
    globalThis.__sbIndexes = ensureIndexes(d).catch((e) => {
      globalThis.__sbIndexes = undefined;
      throw e;
    });
  }
  await globalThis.__sbIndexes;
  return d;
}

// ------------------------------------------------------------------ key/value

interface KvDoc {
  _id: string;
  value: unknown;
  updatedAt: Date;
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const doc = await (await db()).collection<KvDoc>("sb_kv").findOne({ _id: key });
  return (doc?.value as T) ?? null;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db())
    .collection<KvDoc>("sb_kv")
    .updateOne({ _id: key }, { $set: { value, updatedAt: new Date() } }, { upsert: true });
}

// ------------------------------------------------------------------ lock

interface LockDoc {
  _id: string;
  holder: string;
  lockedUntil: Date;
}

/** Lease lock: only one engine step (cron or dashboard action) runs at a time. */
export async function acquireLock(holder: string, seconds: number): Promise<boolean> {
  const now = new Date();
  try {
    await (await db())
      .collection<LockDoc>("sb_lock")
      .updateOne(
        { _id: "engine", lockedUntil: { $lt: now } },
        { $set: { holder, lockedUntil: new Date(now.getTime() + seconds * 1000) } },
        { upsert: true },
      );
  } catch (e) {
    // the lock document exists and is still held => the upsert collides on _id
    if (e instanceof MongoServerError && e.code === 11000) return false;
    throw e;
  }
  const doc = await (await db()).collection<LockDoc>("sb_lock").findOne({ _id: "engine" });
  return doc?.holder === holder;
}

export async function releaseLock(holder: string): Promise<void> {
  await (await db())
    .collection<LockDoc>("sb_lock")
    .updateOne({ _id: "engine", holder }, { $set: { lockedUntil: new Date(0) } });
}

// ------------------------------------------------------------------ engine store

/** order document; field names match what the dashboard renders */
export interface OrderDoc {
  _id: string;
  client_order_id: string;
  exchange_id: string | null;
  mode: string;
  cycle: number;
  side: string;
  level: number;
  ladder_rev: number;
  price: number;
  amount: number;
  filled: number;
  avg_price: number;
  fee: number;
  pnl_rls: number | null;
  status: string;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export const store: EngineStore = {
  async log(level: LogLevel, message: string, data?: unknown) {
    await (await db()).collection("sb_logs").insertOne({ ts: new Date(), level, message, data: data ?? null });
  },
  async upsertOrder(o: TrackedOrder) {
    const doc: OrderDoc = {
      _id: o.clientOrderId,
      client_order_id: o.clientOrderId,
      exchange_id: o.exchangeId ?? null,
      mode: o.mode,
      cycle: o.cycle,
      side: o.side,
      level: o.level,
      ladder_rev: o.ladderRev,
      price: o.price,
      amount: o.amount,
      filled: o.filled,
      avg_price: o.avgPrice,
      fee: o.fee,
      pnl_rls: o.pnlRls ?? null,
      status: o.status,
      error: o.error ?? null,
      created_at: new Date(o.createdAt),
      updated_at: new Date(o.updatedAt),
    };
    await (await db()).collection<OrderDoc>("sb_orders").replaceOne({ _id: o.clientOrderId }, doc, { upsert: true });
  },
  async recordPrice(m: MarketSnapshot) {
    // one document per minute keeps the free 512 MB tier far from full
    const ts = new Date(m.at);
    const minute = Math.floor(ts.getTime() / 60000) * 60000;
    await (await db())
      .collection<{ _id: number }>("sb_prices")
      .updateOne({ _id: minute }, { $set: { ts, bid: m.bid, ask: m.ask, last: m.last } }, { upsert: true });
  },
};

// ------------------------------------------------------------------ queries for the dashboard

export async function listOrders(limit: number, mode?: string | null) {
  const rows = await (await db())
    .collection<OrderDoc>("sb_orders")
    .find(mode ? { mode } : {})
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
  return rows.map(({ _id, ...r }) => r);
}

export async function listLogs(limit: number, level?: string | null) {
  const rows = await (await db())
    .collection("sb_logs")
    .find(level ? { level } : {})
    .sort({ ts: -1, _id: -1 })
    .limit(limit)
    .toArray();
  return rows.map(({ _id, ...r }) => ({ id: String(_id), ...r }));
}

/** mid-price series for the chart, downsampled to ~300 points */
export async function priceSeries(hours: number) {
  const since = Date.now() - hours * 3600_000;
  const rows = await (await db())
    .collection<{ _id: number; bid: number; ask: number }>("sb_prices")
    .find({ _id: { $gte: since } }, { projection: { bid: 1, ask: 1 } })
    .sort({ _id: 1 })
    .toArray();
  const bucket = Math.max(60_000, Math.ceil((hours * 3600_000) / 300 / 60_000) * 60_000);
  const out: { t: number; price: number }[] = [];
  let key = -1;
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    const k = Math.floor(r._id / bucket) * bucket;
    if (k !== key && n > 0) {
      out.push({ t: key, price: sum / n });
      sum = 0;
      n = 0;
    }
    key = k;
    sum += (Number(r.bid) + Number(r.ask)) / 2;
    n += 1;
  }
  if (n > 0) out.push({ t: key, price: sum / n });
  return out;
}
