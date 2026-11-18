import QRCode from "qrcode";
import {
  activeTotpSecret,
  checkPassword,
  clearFails,
  finishEnrollment,
  guardStatus,
  registerFail,
  setSessionCookie,
  startEnrollment,
  verifyTotp,
} from "@/lib/auth/server";
import { store } from "@/lib/store/db";
import { fail, handle, ok } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return handle(async () => {
    const g = await guardStatus();
    if (g.locked) return fail("به دلیل تلاش‌های ناموفق، ورود موقتاً قفل شده است. ۱۵ دقیقه بعد تلاش کنید.", 429);

    const body = (await req.json().catch(() => ({}))) as { username?: string; password?: string; code?: string };
    const username = String(body.username ?? "");
    const password = String(body.password ?? "");
    const code = String(body.code ?? "").replace(/\s/g, "");

    if (!(await checkPassword(username, password))) {
      await registerFail();
      await store.log("warn", "تلاش ناموفق برای ورود");
      return fail("نام کاربری یا رمز عبور اشتباه است", 401);
    }

    const secret = await activeTotpSecret();
    if (!secret) {
      // first login: enroll an authenticator app
      if (!code) {
        const { secret: s, uri } = await startEnrollment();
        return ok({ step: "enroll", secret: s, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
      }
      if (!(await finishEnrollment(code))) {
        await registerFail();
        return fail("کد تأیید دومرحله‌ای اشتباه است", 401);
      }
      await store.log("info", "احراز هویت دومرحله‌ای فعال شد");
    } else {
      if (!code) return ok({ step: "code" });
      if (!(await verifyTotp(code))) {
        await registerFail();
        return fail("کد تأیید دومرحله‌ای اشتباه است", 401);
      }
    }
    await clearFails();
    await setSessionCookie(username);
    await store.log("info", "ورود موفق به داشبورد");
    return ok({ step: "done" });
  });
}
