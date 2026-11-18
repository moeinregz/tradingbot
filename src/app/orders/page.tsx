"use client";
import { useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { api } from "@/components/client";
import { OrdersTable, type OrderRow } from "../Dashboard";

export default function OrdersPage() {
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [mode, setMode] = useState("");
  useEffect(() => {
    const load = () => api<{ orders: OrderRow[] }>(`/api/orders?limit=300${mode ? `&mode=${mode}` : ""}`).then((r) => setRows(r.orders)).catch(() => {});
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [mode]);
  return (
    <Shell>
      <div className="card">
        <h2>
          تاریخچه‌ی سفارش‌ها
          <span style={{ flex: 1 }} />
          <span className="seg">
            {[["", "همه"], ["paper", "آزمایشی"], ["live", "واقعی"]].map(([v, l]) => (
              <button key={v} className={mode === v ? "on" : ""} onClick={() => setMode(v)}>
                {l}
              </button>
            ))}
          </span>
        </h2>
        {rows ? <OrdersTable rows={rows} /> : <div className="muted">در حال بارگذاری…</div>}
      </div>
    </Shell>
  );
}
