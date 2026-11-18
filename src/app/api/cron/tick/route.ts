import { timingSafeEqual } from "node:crypto";
import { fail, handle, ok } from "@/lib/http";
import { tickLoop } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(req.url);
  const header = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const given = header || url.searchParams.get("secret") || "";
  return given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

async function run(req: Request) {
  return handle(async () => {
    if (!authorized(req)) return fail("unauthorized", 401);
    const results = await tickLoop("cron", 45_000);
    return ok({ results });
  });
}

export const GET = run;
export const POST = run;
