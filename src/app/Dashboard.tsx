"use client";
import { useCallback, useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Shell from "@/components/Shell";
import { STATUS_FA, ago, api, n0, pct, time, toman, usdt } from "@/components/client";
import type { BotConfig, BotState, Ladder } from "@/lib/types";

interface StateResp {
  state: Omit<BotState, "paper"> & { paper: { rls: number; usdt: number } };
  config: BotConfig;
  env: { liveAllowed: boolean; hasToken: boolean; priceSource: string };
  recentOrders: OrderRow[];
  lastLogs: { id: string; ts: string; level: string; message: string }[];
  serverTime: string;
}
export interface OrderRow {
  client_order_id: string;
  mode: string;
  cycle: number;
  side: "buy" | "sell";
  level: number;
  price: string;
  amount: string;
  filled: string;
  avg_price: string;
  fee: string;
  pnl_rls: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

export default function Dashboard() {
  const [data, setData] = useState<StateResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const [points, setPoints] = useState<{ t: number; price: number }[]>([]);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      setData(await api<StateResp>("/api/state"));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  const loadPrices = useCallback(async () => {
    try {
      const r = await api<{ points: { t: number; price: number }[] }>(`/api/prices?hours=${hours}`);
      setPoints(r.points);
    } catch {
      /* chart is optional */
    }
  }, [hours]);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      load();
      setNow(Date.now());
    }, 5000);
    return () => clearInterval(id);
  }, [load]);
  useEffect(() => {
    loadPrices();
    const id = setInterval(loadPrices, 30000);
    return () => clearInterval(id);
  }, [loadPrices]);

  async function act(action: string, confirmMsg?: string, extra?: Record<string, unknown>) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(action);
    try {
      const r = await api<Record<string, unknown>>("/api/bot", { method: "POST", body: { action, ...extra } });
      setToast(action === "tick" ? (r.error ? `خطا: ${r.error}` : "تیک اجرا شد") : "انجام شد");
      await load();
      if (action === "tick") loadPrices();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(null);
      setTimeout(() => setToast(null), 3500);
    }
  }

  if (!data) {
    return (
      <Shell>
        <div className="card">{err ? <span className="err">{err}</span> : "در حال بارگذاری…"}</div>
      </Shell>
    );
  }

  const { state, config, env } = data;
  const m = state.lastMarket;
  const mid = m ? (m.bid + m.ask) / 2 : 0;
  const bal = state.lastBalances;
  const avgCost = state.position.usdt > 0 ? state.position.costRls / state.position.usdt : 0;
  const unrealized = state.position.usdt > 0 && m ? (m.bid - avgCost) * state.position.usdt : 0;
  const equity = bal && m ? bal.rls.total + bal.usdt.total * m.bid : 0;
  const stale = state.lastTickAt ? now - new Date(state.lastTickAt).getTime() > 3 * 60_000 : true;

  const statusPill =
    state.status === "running" ? (
      <span className="pill green">● فعال</span>
    ) : state.status === "emergency" ? (
      <span className="pill red">⛔ توقف اضطراری</span>
    ) : (
      <span className="pill gray">⏸ متوقف</span>
    );

  return (
    <Shell>
      {state.status === "emergency" && (
        <div className="banner red">
          توقف اضطراری فعال است. همه‌ی سفارش‌های باز لغو شده‌اند و سفارش جدیدی ثبت نمی‌شود. برای ادامه «شروع» را بزنید.
        </div>
      )}
      {state.mode === "live" ? (
        <div className="banner red">حالت معامله‌ی واقعی — سفارش‌ها با پول واقعی روی نوبیتکس ثبت می‌شوند.</div>
      ) : (
        <div className="banner blue">
          حالت آزمایشی (Paper Trading) — قیمت‌ها {env.priceSource === "simulated" ? "شبیه‌سازی‌شده" : "واقعی از نوبیتکس"}،
          موجودی و معاملات مجازی هستند.
        </div>
      )}
      {state.status === "running" && stale && (
        <div className="banner amber">
          آخرین تیک موتور {ago(state.lastTickAt, now)} بوده است. زمان‌بند (Cron) را بررسی کنید؛ بدون آن ربات فقط با دکمه‌ی
          «اجرای تیک» کار می‌کند.
        </div>
      )}
      {state.lastError && <div className="banner amber">آخرین خطا: {state.lastError}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="actions">
          {statusPill}
          <span className={`pill ${state.mode === "live" ? "red" : "blue"}`}>{state.mode === "live" ? "واقعی" : "آزمایشی"}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            چرخه {n0(state.cycle)} · آخرین تیک {ago(state.lastTickAt, now)}
          </span>
          <div className="spacer" />
          {state.status !== "running" ? (
            <button className="btn primary" disabled={!!busy} onClick={() => act("start", state.mode === "live" ? "ربات در حالت واقعی روشن شود؟" : undefined)}>
              ▶ شروع
            </button>
          ) : (
            <button className="btn" disabled={!!busy} onClick={() => act("stop")}>
              ⏸ توقف
            </button>
          )}
          <button className="btn" disabled={!!busy} onClick={() => act("tick")}>
            {busy === "tick" ? "…" : "⟳ اجرای تیک"}
          </button>
          <button
            className="btn"
            disabled={!!busy || state.status === "emergency"}
            onClick={() => act("reset-cycle", "نردبان‌ها رها شوند و چرخه‌ی جدید از قیمت فعلی شروع شود؟")}
          >
            چرخه‌ی جدید
          </button>
          <button
            className="btn danger"
            disabled={!!busy || state.status === "emergency"}
            onClick={() => act("emergency", "توقف اضطراری: همه‌ی سفارش‌های باز لغو شوند؟")}
          >
            ⛔ توقف اضطراری
          </button>
        </div>
      </div>

      <div className="grid stats">
        <Stat label="قیمت تتر (تومان)" value={m ? toman(mid) : "—"} hint={m ? `خرید ${toman(m.bid)} · فروش ${toman(m.ask)}` : ""} />
        <Stat
          label="ریال آزاد (تومان)"
          value={bal ? toman(bal.rls.free) : "—"}
          hint={bal ? `کل ${toman(bal.rls.total)}` : ""}
        />
        <Stat label="تتر آزاد" value={bal ? usdt(bal.usdt.free) : "—"} hint={bal ? `کل ${usdt(bal.usdt.total)} USDT` : ""} />
        <Stat
          label="سود محقق‌شده (تومان)"
          value={toman(state.realizedPnlRls)}
          tone={state.realizedPnlRls}
          hint={`${n0(state.tradesCount)} معامله · کارمزد ${toman(state.feesRls)} ت + ${usdt(state.feesUsdt)} USDT`}
        />
        <Stat
          label="سود/زیان شناور (تومان)"
          value={toman(unrealized)}
          tone={unrealized}
          hint={state.position.usdt > 0 ? `${usdt(state.position.usdt)} USDT با میانگین ${toman(avgCost)}` : "بدون موقعیت"}
        />
        <Stat label="ارزش کل حساب (تومان)" value={equity ? toman(equity) : "—"} hint="ریال + تتر به قیمت خرید" />
      </div>

      <div className="card mt">
        <h2>
          نمودار قیمت و پله‌ها
          <span className="spacer" style={{ flex: 1 }} />
          <span className="seg">
            {[6, 24, 72, 168].map((h) => (
              <button key={h} className={hours === h ? "on" : ""} onClick={() => setHours(h)}>
                {h < 24 ? `${n0(h)} ساعت` : `${n0(h / 24)} روز`}
              </button>
            ))}
          </span>
        </h2>
        <PriceChart points={points} buy={state.buyLadder} sell={state.sellLadder} locked={state.buyLocked} />
      </div>

      <div className="grid two mt">
        <LadderCard title="نردبان خرید" ladder={state.buyLadder} locked={state.buyLocked} />
        <LadderCard title="نردبان فروش" ladder={state.sellLadder} />
      </div>

      <div className="grid two mt">
        <div className="card">
          <h2>
            آخرین سفارش‌ها <span className="sub">({n0(state.activeOrders.length)} باز)</span>
          </h2>
          <OrdersTable rows={data.recentOrders} compact />
        </div>
        <div className="card">
          <h2>آخرین رویدادها</h2>
          {data.lastLogs.length === 0 && <div className="muted">رویدادی ثبت نشده است.</div>}
          {data.lastLogs.map((l) => (
            <div key={l.id} className="log-line">
              <span className="log-time">{ago(l.ts, now)}</span>
              <span className={`log-${l.level}`}>{l.message}</span>
            </div>
          ))}
        </div>
      </div>

      <p className="muted mt" style={{ fontSize: 12 }}>
        پله‌ها: خرید {config.buyLevels.map((l) => `${pct(l.pct)}/${pct(l.share)}`).join("، ")} · فروش{" "}
        {config.sellLevels.map((l) => `${pct(l.pct)}/${pct(l.share)}`).join("، ")}
      </p>
      {toast && <div className="toast">{toast}</div>}
    </Shell>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: number }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className={`value ${tone === undefined ? "" : tone > 0 ? "pos" : tone < 0 ? "neg" : ""}`}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function LadderCard({ title, ladder, locked }: { title: string; ladder: Ladder | null; locked?: boolean }) {
  if (!ladder) {
    return (
      <div className="card">
        <h2>{title}</h2>
        <div className="muted">با شروع ربات، نردبان از قیمت لحظه‌ای ساخته می‌شود.</div>
      </div>
    );
  }
  const buy = ladder.side === "buy";
  return (
    <div className="card">
      <h2>
        {title}
        <span className="sub">
          مرجع {toman(ladder.ref)} تومان · {ladder.reason === "start" ? "شروع" : ladder.reason === "manual" ? "دستی" : ladder.reason}
        </span>
        {locked && <span className="pill amber">قفل تا فروش بعدی</span>}
      </h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>پله</th>
              <th>فاصله</th>
              <th>سهم</th>
              <th>قیمت (تومان)</th>
              <th>وضعیت</th>
              <th>اجرا</th>
            </tr>
          </thead>
          <tbody>
            {ladder.levels.map((l) => {
              const [label, tone] = STATUS_FA[l.status];
              return (
                <tr key={l.index} className={l.status === "filled" ? "dim" : ""}>
                  <td>
                    {buy ? "خرید" : "فروش"} {n0(l.index + 1)}
                  </td>
                  <td>
                    {buy ? "−" : "+"}
                    {pct(l.pct)}
                  </td>
                  <td>{pct(l.share)}</td>
                  <td className="num">{toman(l.price)}</td>
                  <td>
                    <span className={`pill ${tone}`}>{label}</span>
                    {l.note === "insufficient" && l.status === "pending" && <span className="pill amber" style={{ marginInlineStart: 4 }}>موجودی کم</span>}
                  </td>
                  <td className="muted">{l.filledAmount ? `${usdt(l.filledAmount)} @ ${toman(l.filledPrice)}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function OrdersTable({ rows, compact }: { rows: OrderRow[]; compact?: boolean }) {
  if (rows.length === 0) return <div className="muted">هنوز سفارشی ثبت نشده است.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>زمان</th>
            <th>نوع</th>
            <th>قیمت</th>
            <th>مقدار</th>
            {!compact && <th>اجرا</th>}
            {!compact && <th>کارمزد</th>}
            <th>سود</th>
            <th>وضعیت</th>
            {!compact && <th>چرخه</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => {
            const [label, tone] = STATUS_FA[o.status] ?? [o.status, "gray"];
            const pnl = o.pnl_rls === null ? null : Number(o.pnl_rls);
            return (
              <tr key={o.client_order_id} title={o.error ?? o.client_order_id}>
                <td className="muted">{time(o.created_at)}</td>
                <td>
                  <span className={`pill ${o.side === "buy" ? "green" : "red"}`}>
                    {o.side === "buy" ? "خرید" : "فروش"} {n0(o.level + 1)}
                  </span>
                  {o.mode === "paper" && !compact && <span className="muted"> · آزمایشی</span>}
                </td>
                <td className="num">{toman(Number(o.avg_price) || Number(o.price))}</td>
                <td className="num">{usdt(o.amount)}</td>
                {!compact && <td className="num">{usdt(o.filled)}</td>}
                {!compact && <td className="num">{o.side === "buy" ? `${usdt(o.fee)} USDT` : `${toman(o.fee)} ت`}</td>}
                <td className={pnl === null ? "muted" : pnl >= 0 ? "pos" : "neg"}>{pnl === null ? "—" : toman(pnl)}</td>
                <td>
                  <span className={`pill ${tone}`}>{label}</span>
                </td>
                {!compact && <td>{n0(o.cycle)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PriceChart({
  points,
  buy,
  sell,
  locked,
}: {
  points: { t: number; price: number }[];
  buy: Ladder | null;
  sell: Ladder | null;
  locked: boolean;
}) {
  if (points.length < 2) return <div className="muted chart-box" style={{ direction: "rtl" }}>داده‌ی قیمت کافی نیست؛ بعد از چند تیک نمودار نمایش داده می‌شود.</div>;
  const data = points.map((p) => ({ t: p.t, p: p.price / 10 }));
  const lines = [
    ...(buy?.levels ?? []).filter((l) => l.status !== "filled" && !locked).map((l) => ({ y: l.price / 10, c: "#22c55e", k: `b${l.index}`, label: `خ${l.index + 1}` })),
    ...(sell?.levels ?? []).filter((l) => l.status !== "filled").map((l) => ({ y: l.price / 10, c: "#f05252", k: `s${l.index}`, label: `ف${l.index + 1}` })),
  ];
  const ys = [...data.map((d) => d.p), ...lines.map((l) => l.y)];
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const pad = (hi - lo) * 0.05 || hi * 0.01;
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 40, left: 8, bottom: 0 }}>
          <CartesianGrid stroke="#233040" strokeDasharray="3 3" />
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(t) => new Date(t).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" })}
            stroke="#8b98a5"
            fontSize={11}
          />
          <YAxis
            domain={[lo - pad, hi + pad]}
            tickFormatter={(v) => Math.round(v).toLocaleString("fa-IR")}
            stroke="#8b98a5"
            fontSize={11}
            width={70}
            orientation="right"
          />
          <Tooltip
            contentStyle={{ background: "#18202b", border: "1px solid #233040", borderRadius: 8, direction: "rtl" }}
            labelFormatter={(t) => new Date(Number(t)).toLocaleString("fa-IR")}
            formatter={(v) => [Math.round(Number(v)).toLocaleString("fa-IR") + " تومان", "قیمت"]}
          />
          {lines.map((l) => (
            <ReferenceLine key={l.k} y={l.y} stroke={l.c} strokeDasharray="4 4" strokeOpacity={0.8} label={{ value: l.label, fill: l.c, fontSize: 11, position: "left" }} />
          ))}
          <Line type="monotone" dataKey="p" stroke="#4f8cff" dot={false} strokeWidth={2} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
