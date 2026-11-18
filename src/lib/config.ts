import type { BotConfig, LevelConfig } from "./types";

export const DEFAULT_CONFIG: BotConfig = {
  buyLevels: [
    { pct: 2, share: 15 },
    { pct: 4, share: 20 },
    { pct: 7, share: 25 },
    { pct: 10, share: 40 },
  ],
  sellLevels: [
    { pct: 2.5, share: 20 },
    { pct: 5, share: 25 },
    { pct: 8, share: 25 },
    { pct: 12, share: 30 },
  ],
  minOrderRls: 3_000_000,
  priceTickRls: 10,
  amountDecimals: 2,
  orderTimeoutMin: 30,
  failCooldownMin: 5,
  paperFeeRate: 0.0025,
  paperInitialRls: 1_000_000_000,
  paperInitialUsdt: 0,
  maxConsecutiveErrors: 5,
};

function num(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) {
    throw new Error(`مقدار «${name}» نامعتبر است (بین ${min} و ${max})`);
  }
  return n;
}

function levels(v: unknown, name: string): LevelConfig[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 10) {
    throw new Error(`«${name}» باید بین ۱ تا ۱۰ پله داشته باشد`);
  }
  const out = v.map((l, i) => ({
    pct: num((l as LevelConfig)?.pct, `${name} پله ${i + 1} فاصله`, 0.05, 90),
    share: num((l as LevelConfig)?.share, `${name} پله ${i + 1} سهم`, 0.1, 100),
  }));
  for (let i = 1; i < out.length; i++) {
    if (out[i].pct <= out[i - 1].pct) {
      throw new Error(`فاصله‌ی پله‌های «${name}» باید صعودی باشد`);
    }
  }
  return out;
}

export function validateConfig(input: unknown): BotConfig {
  const c = (input ?? {}) as Record<string, unknown>;
  return {
    buyLevels: levels(c.buyLevels, "خرید"),
    sellLevels: levels(c.sellLevels, "فروش"),
    minOrderRls: num(c.minOrderRls, "حداقل سفارش", 0, 1e13),
    priceTickRls: num(c.priceTickRls, "گام قیمت", 0, 1e7),
    amountDecimals: Math.round(num(c.amountDecimals, "اعشار مقدار", 0, 8)),
    orderTimeoutMin: num(c.orderTimeoutMin, "مهلت سفارش", 0, 60 * 24 * 30),
    failCooldownMin: num(c.failCooldownMin, "مکث پس از خطا", 0, 60 * 24),
    paperFeeRate: num(c.paperFeeRate, "کارمزد آزمایشی", 0, 0.05),
    paperInitialRls: num(c.paperInitialRls, "موجودی ریالی آزمایشی", 0, 1e15),
    paperInitialUsdt: num(c.paperInitialUsdt, "موجودی تتر آزمایشی", 0, 1e9),
    maxConsecutiveErrors: Math.round(num(c.maxConsecutiveErrors, "حداکثر خطای پیاپی", 1, 1000)),
  };
}

export function mergeConfig(stored: unknown): BotConfig {
  try {
    return validateConfig({ ...DEFAULT_CONFIG, ...((stored as object) ?? {}) });
  } catch {
    return DEFAULT_CONFIG;
  }
}
