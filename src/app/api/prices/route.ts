import { handle, ok } from "@/lib/http";
import { priceSeries } from "@/lib/store/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const hours = Math.min(24 * 14, Math.max(1, Number(new URL(req.url).searchParams.get("hours")) || 24));
    return ok({ points: await priceSeries(hours) });
  });
}
