import { validateConfig } from "@/lib/config";
import { fail, handle, ok } from "@/lib/http";
import { loadConfig, withBot } from "@/lib/runtime";
import { kvSet, store } from "@/lib/store/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => ok({ config: await loadConfig() }));
}

export async function PUT(req: Request) {
  return handle(async () => {
    let cfg;
    try {
      cfg = validateConfig(await req.json());
    } catch (e) {
      return fail((e as Error).message);
    }
    await withBot(async () => {
      await kvSet("config", cfg);
    });
    await store.log("info", "تنظیمات به‌روزرسانی شد (پله‌های جدید از ساخت بعدی نردبان اعمال می‌شوند)");
    return ok({ config: cfg });
  });
}
