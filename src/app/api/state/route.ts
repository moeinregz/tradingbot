import { env, loadConfig, loadState } from "@/lib/runtime";
import { listLogs, listOrders } from "@/lib/store/db";
import { handle, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const cfg = await loadConfig();
    const state = await loadState(cfg);
    const { paper, ...rest } = state;
    const recentOrders = await listOrders(12);
    const lastLogs = await listLogs(8);
    return ok({
      state: { ...rest, paper: { rls: paper.rls, usdt: paper.usdt } },
      config: cfg,
      env,
      recentOrders,
      lastLogs,
      serverTime: new Date().toISOString(),
    });
  });
}
