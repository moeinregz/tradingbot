import { handle, ok } from "@/lib/http";
import { listOrders } from "@/lib/store/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const mode = url.searchParams.get("mode");
    return ok({ orders: await listOrders(limit, mode === "paper" || mode === "live" ? mode : null) });
  });
}
