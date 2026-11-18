import { verifyTotp } from "@/lib/auth/server";
import { emergencyStop, resetCycle } from "@/lib/engine";
import { fail, handle, ok } from "@/lib/http";
import { env, tickOnce, withBot } from "@/lib/runtime";
import { newState, randomEpoch } from "@/lib/strategy";
import { store } from "@/lib/store/db";
import type { Mode } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = { action?: string; mode?: Mode; code?: string };

export async function POST(req: Request) {
  return handle(async () => {
    const body = (await req.json().catch(() => ({}))) as Body;
    const action = body.action;

    if (action === "tick") return ok(await tickOnce("manual"));

    const result = await withBot(async ({ state, cfg, ctx }) => {
      switch (action) {
        case "start": {
          if (state.mode === "live" && (!env.liveAllowed || !env.hasToken)) {
            throw new Error("معامله‌ی واقعی فعال نیست (LIVE_TRADING_ENABLED و NOBITEX_API_TOKEN)");
          }
          const from = state.status;
          state.status = "running";
          state.consecutiveErrors = 0;
          await store.log("info", `▶️ ربات در حالت ${state.mode === "live" ? "واقعی" : "آزمایشی"} روشن شد (قبلی: ${from})`);
          return { status: state.status };
        }
        case "stop": {
          state.status = "stopped";
          await store.log("info", "⏸ ربات متوقف شد؛ سفارش جدیدی ثبت نمی‌شود (سفارش‌های باز پیگیری می‌شوند)");
          return { status: state.status };
        }
        case "emergency": {
          await emergencyStop(state, cfg, ctx);
          return { status: state.status, open: state.activeOrders.length };
        }
        case "reset-cycle": {
          if (state.status === "emergency") throw new Error("ابتدا ربات را از حالت اضطراری خارج کنید");
          await resetCycle(state, cfg, ctx);
          return { cycle: state.cycle };
        }
        case "reset-paper": {
          if (state.mode !== "paper") throw new Error("فقط در حالت آزمایشی");
          if (state.status === "running") throw new Error("ابتدا ربات را متوقف کنید");
          const fresh = newState(cfg, "paper");
          Object.assign(state, { ...fresh, cycle: state.cycle, revCounter: state.revCounter });
          await store.log("info", "حساب آزمایشی با موجودی اولیه بازنشانی شد");
          return { ok: true };
        }
        case "set-mode": {
          const mode = body.mode;
          if (mode !== "paper" && mode !== "live") throw new Error("حالت نامعتبر");
          if (state.status === "running") throw new Error("ابتدا ربات را متوقف کنید");
          if (state.activeOrders.length > 0) throw new Error("سفارش باز وجود دارد؛ ابتدا توقف اضطراری بزنید");
          if (mode === "live") {
            if (!env.liveAllowed) throw new Error("در متغیرهای محیطی LIVE_TRADING_ENABLED=true نیست");
            if (!env.hasToken) throw new Error("NOBITEX_API_TOKEN تنظیم نشده است");
            if (!(await verifyTotp(String(body.code ?? "")))) throw new Error("کد دومرحله‌ای برای فعال‌سازی حالت واقعی لازم است");
          }
          if (mode === state.mode) return { mode };
          state.mode = mode;
          state.epoch = randomEpoch();
          state.buyLadder = null;
          state.sellLadder = null;
          state.buyLocked = false;
          state.position = { usdt: 0, costRls: 0 };
          state.realizedPnlRls = 0;
          state.feesRls = 0;
          state.feesUsdt = 0;
          state.tradesCount = 0;
          state.lastBalances = undefined;
          await store.log("warn", `حالت معامله به «${mode === "live" ? "واقعی" : "آزمایشی"}» تغییر کرد`);
          return { mode };
        }
        default:
          throw new Error("عملیات نامعتبر");
      }
    });
    return ok(result);
  });
}

export async function GET() {
  return fail("method not allowed", 405);
}
