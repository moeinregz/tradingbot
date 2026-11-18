import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

const PUBLIC = [/^\/login$/, /^\/api\/auth\/login$/, /^\/api\/cron\//];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((r) => r.test(pathname))) return NextResponse.next();

  const isApi = pathname.startsWith("/api/");
  // CSRF: state-changing API calls must carry a custom header (forces a CORS preflight cross-site)
  if (isApi && req.method !== "GET" && req.headers.get("x-sb-request") !== "1") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const user = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (user) return NextResponse.next();
  if (isApi) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
