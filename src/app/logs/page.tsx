"use client";
import { useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { api, time } from "@/components/client";

interface Log {
  id: string;
  ts: string;
  level: string;
  message: string;
  data: unknown;
}

export default function LogsPage() {
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [level, setLevel] = useState("");
  useEffect(() => {
    const load = () => api<{ logs: Log[] }>(`/api/logs?limit=300${level ? `&level=${level}` : ""}`).then((r) => setLogs(r.logs)).catch(() => {});
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [level]);
  return (
    <Shell>
      <div className="card">
        <h2>
          گزارش رویدادها
          <span style={{ flex: 1 }} />
          <span className="seg">
            {[["", "همه"], ["info", "اطلاعات"], ["warn", "هشدار"], ["error", "خطا"]].map(([v, l]) => (
              <button key={v} className={level === v ? "on" : ""} onClick={() => setLevel(v)}>
                {l}
              </button>
            ))}
          </span>
        </h2>
        {!logs && <div className="muted">در حال بارگذاری…</div>}
        {logs?.length === 0 && <div className="muted">رویدادی وجود ندارد.</div>}
        {logs?.map((l) => (
          <div key={l.id} className="log-line" title={l.data ? JSON.stringify(l.data) : undefined}>
            <span className="log-time">{time(l.ts)}</span>
            <span className={`log-${l.level}`}>{l.message}</span>
          </div>
        ))}
      </div>
    </Shell>
  );
}
