"use client";

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: { "Content-Type": "application/json", "x-sb-request": "1" },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth")) {
    window.location.href = "/login";
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
  return json as T;
}

const fa = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });
const fa2 = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 });

/** rial -> formatted toman */
export const toman = (rls: number | string | null | undefined) => fa.format(Number(rls ?? 0) / 10);
export const usdt = (v: number | string | null | undefined) => fa2.format(Number(v ?? 0));
export const pct = (v: number) => fa2.format(v) + "٪";
export const n0 = (v: number) => fa.format(v);

export function ago(iso?: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${n0(s)} ثانیه پیش`;
  if (s < 3600) return `${n0(Math.floor(s / 60))} دقیقه پیش`;
  if (s < 86400) return `${n0(Math.floor(s / 3600))} ساعت پیش`;
  return `${n0(Math.floor(s / 86400))} روز پیش`;
}

export function time(iso: string): string {
  return new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "medium" });
}

export const STATUS_FA: Record<string, [string, string]> = {
  submitting: ["در حال ثبت", "amber"],
  active: ["باز", "blue"],
  done: ["اجرا شد", "green"],
  canceled: ["لغو شد", "gray"],
  failed: ["ناموفق", "red"],
  pending: ["در انتظار", "gray"],
  ordered: ["سفارش باز", "blue"],
  filled: ["اجرا شد", "green"],
};
