"use client";
import { useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { api, n0 } from "@/components/client";
import type { BotConfig, LevelConfig } from "@/lib/types";

interface StateLite {
  state: { mode: "paper" | "live"; status: string; activeOrders: unknown[] };
  env: { liveAllowed: boolean; hasToken: boolean; priceSource: string };
}

export default function SettingsPage() {
  const [cfg, setCfg] = useState<BotConfig | null>(null);
  const [st, setSt] = useState<StateLite | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const loadState = () => api<StateLite>("/api/state").then(setSt).catch(() => {});
  useEffect(() => {
    api<{ config: BotConfig }>("/api/settings").then((r) => setCfg(r.config));
    loadState();
  }, []);

  async function run(fn: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: okText });
      await loadState();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!cfg || !st) {
    return (
      <Shell>
        <div className="card">در حال بارگذاری…</div>
      </Shell>
    );
  }

  const set = <K extends keyof BotConfig>(k: K, v: BotConfig[K]) => setCfg({ ...cfg, [k]: v });
  const setLevel = (side: "buyLevels" | "sellLevels", i: number, k: keyof LevelConfig, v: number) =>
    set(side, cfg[side].map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const sum = (ls: LevelConfig[]) => ls.reduce((a, l) => a + l.share, 0);

  const numField = (label: string, value: number, onChange: (v: number) => void, step = "any", hint?: string) => (
    <div className="field">
      <label>{label}</label>
      <input className="input num" style={{ display: "block" }} type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <span className="muted" style={{ fontSize: 11 }}>{hint}</span>}
    </div>
  );

  const levelsEditor = (side: "buyLevels" | "sellLevels", title: string) => (
    <div className="card">
      <h2>
        {title} <span className="sub">مجموع سهم‌ها: {n0(sum(cfg[side]))}٪</span>
      </h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>پله</th>
              <th>فاصله از مرجع (٪)</th>
              <th>سهم از موجودی آزاد (٪)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cfg[side].map((l, i) => (
              <tr key={i}>
                <td>{n0(i + 1)}</td>
                <td>
                  <input className="input num" type="number" step="0.1" value={l.pct} onChange={(e) => setLevel(side, i, "pct", Number(e.target.value))} />
                </td>
                <td>
                  <input className="input num" type="number" step="1" value={l.share} onChange={(e) => setLevel(side, i, "share", Number(e.target.value))} />
                </td>
                <td>
                  <button className="btn sm ghost" disabled={cfg[side].length <= 1} onClick={() => set(side, cfg[side].filter((_, j) => j !== i))}>
                    حذف
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        className="btn sm mt"
        disabled={cfg[side].length >= 10}
        onClick={() => {
          const last = cfg[side][cfg[side].length - 1];
          set(side, [...cfg[side], { pct: (last?.pct ?? 0) + 2, share: 20 }]);
        }}
      >
        + افزودن پله
      </button>
    </div>
  );

  const { state, env } = st;
  return (
    <Shell>
      {msg && <div className={`banner ${msg.ok ? "blue" : "red"}`}>{msg.text}</div>}

      <div className="card">
        <h2>حالت معامله</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          حالت فعلی: <b style={{ color: state.mode === "live" ? "var(--red)" : "var(--blue)" }}>{state.mode === "live" ? "واقعی" : "آزمایشی"}</b>
          {" · "}تغییر حالت فقط وقتی ربات متوقف است و سفارش بازی ندارد ممکن است. آمار و نردبان‌ها با تغییر حالت از نو شروع می‌شوند.
        </p>
        {!env.liveAllowed && <div className="banner amber">حالت واقعی غیرفعال است: در Vercel متغیر LIVE_TRADING_ENABLED=true را تنظیم کنید.</div>}
        {env.liveAllowed && !env.hasToken && <div className="banner amber">NOBITEX_API_TOKEN تنظیم نشده است.</div>}
        <div className="actions">
          {state.mode === "paper" ? (
            <>
              <input className="input num" style={{ maxWidth: 140, textAlign: "center" }} placeholder="کد ۲FA" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} inputMode="numeric" />
              <button
                className="btn danger"
                disabled={busy || !env.liveAllowed || !env.hasToken || code.length !== 6}
                onClick={() =>
                  window.confirm("ربات به حالت معامله‌ی واقعی برود؟ سفارش‌ها با پول واقعی ثبت خواهند شد.") &&
                  run(() => api("/api/bot", { method: "POST", body: { action: "set-mode", mode: "live", code } }), "حالت واقعی فعال شد")
                }
              >
                رفتن به حالت واقعی
              </button>
              <button
                className="btn"
                disabled={busy || state.status === "running"}
                onClick={() =>
                  window.confirm("حساب آزمایشی، آمار و نردبان‌ها بازنشانی شوند؟") &&
                  run(() => api("/api/bot", { method: "POST", body: { action: "reset-paper" } }), "حساب آزمایشی بازنشانی شد")
                }
              >
                بازنشانی حساب آزمایشی
              </button>
            </>
          ) : (
            <button className="btn" disabled={busy} onClick={() => run(() => api("/api/bot", { method: "POST", body: { action: "set-mode", mode: "paper" } }), "حالت آزمایشی فعال شد")}>
              بازگشت به حالت آزمایشی
            </button>
          )}
        </div>
      </div>

      <div className="grid two mt">
        {levelsEditor("buyLevels", "پله‌های خرید")}
        {levelsEditor("sellLevels", "پله‌های فروش")}
      </div>

      <div className="card mt">
        <h2>پارامترهای اجرا</h2>
        <div className="form-grid">
          {numField("حداقل ارزش سفارش (تومان)", cfg.minOrderRls / 10, (v) => set("minOrderRls", v * 10), "1000")}
          {numField("گام قیمت (ریال)", cfg.priceTickRls, (v) => set("priceTickRls", v), "1")}
          {numField("تعداد اعشار مقدار تتر", cfg.amountDecimals, (v) => set("amountDecimals", v), "1")}
          {numField("مهلت سفارش باز (دقیقه)", cfg.orderTimeoutMin, (v) => set("orderTimeoutMin", v), "1", "۰ = بدون مهلت؛ پس از مهلت لغو و پله دوباره فعال می‌شود")}
          {numField("مکث پس از رد سفارش (دقیقه)", cfg.failCooldownMin, (v) => set("failCooldownMin", v), "1")}
          {numField("حداکثر خطای پیاپی", cfg.maxConsecutiveErrors, (v) => set("maxConsecutiveErrors", v), "1", "پس از آن ربات خودکار متوقف می‌شود")}
        </div>
        <h2 className="mt">حساب آزمایشی</h2>
        <div className="form-grid">
          {numField("کارمزد شبیه‌سازی (٪)", +(cfg.paperFeeRate * 100).toFixed(4), (v) => set("paperFeeRate", v / 100), "0.01")}
          {numField("موجودی اولیه ریالی (تومان)", cfg.paperInitialRls / 10, (v) => set("paperInitialRls", v * 10), "1000000")}
          {numField("موجودی اولیه تتر", cfg.paperInitialUsdt, (v) => set("paperInitialUsdt", v), "1")}
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          تغییر پله‌ها روی نردبان فعلی اثر ندارد و از ساخت بعدی نردبان (فروش بعدی یا «چرخه‌ی جدید») اعمال می‌شود. موجودی اولیه پس از
          «بازنشانی حساب آزمایشی» اعمال می‌شود.
        </p>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => run(() => api<{ config: BotConfig }>("/api/settings", { method: "PUT", body: cfg }).then((r) => setCfg(r.config)), "تنظیمات ذخیره شد")}
        >
          ذخیره‌ی تنظیمات
        </button>
      </div>
    </Shell>
  );
}
