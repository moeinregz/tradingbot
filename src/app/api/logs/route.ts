import { handle, ok } from "@/lib/http";
import { listLogs } from "@/lib/store/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
    const level = url.searchParams.get("level");
    return ok({ logs: await listLogs(limit, ["info", "warn", "error"].includes(level ?? "") ? level : null) });
  });
}
