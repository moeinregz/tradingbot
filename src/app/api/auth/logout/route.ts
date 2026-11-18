import { clearSessionCookie } from "@/lib/auth/server";
import { ok } from "@/lib/http";

export async function POST() {
  await clearSessionCookie();
  return ok({ ok: true });
}
