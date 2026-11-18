import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@/lib/config";
import { emergencyStop, runTick, type EngineContext } from "@/lib/engine";
import { PaperExchange } from "@/lib/exchange/paper";
import { ExchangeError } from "@/lib/exchange/types";
import { newState } from "@/lib/strategy";
import type { BotConfig, BotState, MarketSnapshot, TrackedOrder } from "@/lib/types";

const REF = 1_000_000; // rial

class Harness {
  price = REF;
  clock = new Date("2026-01-01T00:00:00Z");
  orders = new Map<string, TrackedOrder>();
  logs: string[] = [];
  state: BotState;
  cfg: BotConfig;
  ex: PaperExchange;
  ctx: EngineContext;

  constructor(cfg: Partial<BotConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, priceTickRls: 1, paperFeeRate: 0, paperInitialRls: 1_000_000_000, ...cfg };
    this.state = newState(this.cfg, "paper");
    this.state.status = "running";
    this.ex = new PaperExchange(this.state.paper, async () => this.market(), this.cfg.paperFeeRate, () => this.clock);
    this.ctx = {
      exchange: this.ex,
      now: () => this.clock,
      persist: async () => {},
      store: {
        log: async (_l, m) => void this.logs.push(m),
        upsertOrder: async (o) => void this.orders.set(o.clientOrderId, { ...o }),
        recordPrice: async () => {},
      },
    };
  }
  market(): MarketSnapshot {
    // zero spread keeps the arithmetic in the tests obvious
    return { bid: this.price, ask: this.price, last: this.price, at: this.clock.toISOString() };
  }
  async tick(price?: number) {
    if (price !== undefined) this.price = price;
    this.clock = new Date(this.clock.getTime() + 15_000);
    return runTick(this.state, this.cfg, this.ctx);
  }
  buyPrices() {
    return this.state.buyLadder!.levels.map((l) => l.price);
  }
  sellPrices() {
    return this.state.sellLadder!.levels.map((l) => l.price);
  }
  filledOrders(side: "buy" | "sell") {
    return [...this.orders.values()].filter((o) => o.side === side && o.status === "done");
  }
}

/** Makes the next placements rest on the book: the market bounces away right before the order arrives. */
function restingPlacements(t: Harness) {
  const real = t.ex.placeLimitOrder.bind(t.ex);
  t.ex.placeLimitOrder = async (p) => {
    t.price = 1_000_000;
    await t.ex.getMarket();
    return real(p);
  };
}

/** order value must equal the target, rounded DOWN to one 0.01 USDT step */
function expectSized(value: number, target: number, price: number) {
  expect(value).toBeLessThanOrEqual(target + 1e-6);
  expect(value).toBeGreaterThan(target - price * 0.01);
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

describe("ladder construction", () => {
  it("builds 4 buy and 4 sell levels from the reference price", async () => {
    await h.tick();
    expect(h.state.cycle).toBe(1);
    expect(h.buyPrices()).toEqual([980_000, 960_000, 930_000, 900_000]);
    expect(h.sellPrices()).toEqual([1_025_000, 1_050_000, 1_080_000, 1_120_000]);
  });
});

describe("step buying", () => {
  it("buys level 1 with 15% of the free rial balance, other levels untouched", async () => {
    await h.tick();
    await h.tick(980_000);
    const [b1] = h.filledOrders("buy");
    expect(b1.level).toBe(0);
    expectSized(b1.amount * b1.price, 1_000_000_000 * 0.15, b1.price);
    expect(h.buyPrices()).toEqual([980_000, 960_000, 930_000, 900_000]);
    expect(h.state.buyLadder!.levels.map((l) => l.status)).toEqual(["filled", "pending", "pending", "pending"]);
  });

  it("sizes each order on the free balance at that moment", async () => {
    await h.tick();
    await h.tick(980_000);
    await h.tick(960_000);
    const buys = h.filledOrders("buy").sort((a, b) => a.level - b.level);
    const freeAfterFirst = 1_000_000_000 - buys[0].amount * 980_000;
    expectSized(buys[1].amount * buys[1].price, freeAfterFirst * 0.2, buys[1].price);
  });

  it("locks buying after the last level until a sell happens", async () => {
    await h.tick();
    await h.tick(890_000); // gap through all four levels in one tick
    expect(h.filledOrders("buy")).toHaveLength(4);
    expect(h.state.buyLocked).toBe(true);
    await h.tick(700_000);
    expect(h.filledOrders("buy")).toHaveLength(4);
    expect(h.state.activeOrders).toHaveLength(0);
  });
});

describe("step selling", () => {
  it("a sell rebuilds ONLY the buy ladder, from the sell execution price", async () => {
    await h.tick();
    await h.tick(890_000); // buy all 4 => have USDT, buys locked
    const sellBefore = h.sellPrices();
    await h.tick(1_025_000); // sell level 1
    const [s1] = h.filledOrders("sell");
    expect(s1.level).toBe(0);
    expect(h.state.buyLocked).toBe(false);
    expect(h.state.buyLadder!.ref).toBe(1_025_000);
    expect(h.buyPrices()).toEqual([1_004_500, 984_000, 953_250, 922_500]);
    expect(h.sellPrices()).toEqual(sellBefore);
    expect(h.state.sellLadder!.levels.map((l) => l.status)).toEqual(["filled", "pending", "pending", "pending"]);
    expect(h.state.cycle).toBe(1);
  });

  it("sells 20% of the free USDT on level 1", async () => {
    await h.tick();
    await h.tick(890_000);
    const usdt = h.state.paper.usdt;
    await h.tick(1_025_000);
    const [s1] = h.filledOrders("sell");
    expect(s1.amount).toBeCloseTo(Math.floor(usdt * 0.2 * 100) / 100, 6);
  });

  it("remaining sell levels do not move while price keeps rising without correction", async () => {
    await h.tick();
    await h.tick(890_000);
    const before = h.sellPrices();
    for (const p of [1_030_000, 1_040_000, 1_055_000, 1_070_000]) await h.tick(p);
    expect(h.sellPrices()).toEqual(before);
    expect(h.filledOrders("sell").map((o) => o.level).sort()).toEqual([0, 1]);
  });

  it("starts a new cycle after the last sell level", async () => {
    await h.tick();
    await h.tick(890_000);
    await h.tick(1_130_000); // all sell levels
    expect(h.filledOrders("sell")).toHaveLength(4);
    expect(h.state.cycle).toBe(2);
    expect(h.state.buyLadder!.ref).toBe(1_130_000);
    expect(h.state.sellLadder!.ref).toBe(1_130_000);
    expect(h.state.sellLadder!.levels.every((l) => l.status === "pending")).toBe(true);
  });

  it("records positive realized PnL for a buy-low / sell-high round trip", async () => {
    await h.tick();
    await h.tick(980_000);
    await h.tick(1_025_000);
    expect(h.state.realizedPnlRls).toBeGreaterThan(0);
  });
});

describe("safety", () => {
  it("skips orders below the minimum value", async () => {
    h = new Harness({ paperInitialRls: 10_000_000, minOrderRls: 3_000_000 });
    await h.tick();
    await h.tick(980_000); // 15% of 10M = 1.5M < min
    expect(h.filledOrders("buy")).toHaveLength(0);
    expect(h.state.buyLadder!.levels[0].status).toBe("pending");
  });

  it("does not duplicate an order when the placement response is lost", async () => {
    await h.tick();
    const real = h.ex.placeLimitOrder.bind(h.ex);
    let calls = 0;
    h.ex.placeLimitOrder = async (p) => {
      calls++;
      await real(p); // the order lands on the exchange...
      throw new ExchangeError("NETWORK", "connection reset", true); // ...but the response is lost
    };
    await h.tick(980_000);
    for (let i = 0; i < 4; i++) await h.tick(980_000);
    expect(calls).toBe(1);
    expect(h.state.paper.orders.filter((o) => o.side === "buy")).toHaveLength(1);
    expect(h.state.buyLadder!.levels[0].status).toBe("filled");
    expect(h.state.activeOrders).toHaveLength(0);
  });

  it("re-arms a level when its order times out unfilled", async () => {
    h = new Harness({ orderTimeoutMin: 1 });
    await h.tick();
    restingPlacements(h);
    await h.tick(980_000);
    expect(h.state.activeOrders).toHaveLength(1);
    h.clock = new Date(h.clock.getTime() + 2 * 60_000);
    await h.tick(1_000_000);
    expect(h.state.activeOrders).toHaveLength(0);
    const lvl = h.state.buyLadder!.levels[0];
    expect(lvl.status).toBe("pending");
    expect(lvl.attempt).toBe(1);
  });

  it("emergency stop cancels open orders and blocks new ones", async () => {
    await h.tick();
    restingPlacements(h);
    await h.tick(980_000);
    expect(h.state.activeOrders).toHaveLength(1);
    await emergencyStop(h.state, h.cfg, h.ctx);
    expect(h.state.status).toBe("emergency");
    expect(h.state.activeOrders).toHaveLength(0);
    expect(h.state.paper.orders.every((o) => o.status !== "active")).toBe(true);
    await h.tick(900_000);
    expect(h.filledOrders("buy")).toHaveLength(0);
  });

  it("recovers after a crash using only persisted state", async () => {
    await h.tick();
    await h.tick(980_000);
    const saved = JSON.parse(JSON.stringify(h.state)) as BotState;
    // "restart": new engine objects on top of the persisted snapshot
    const h2 = new Harness();
    h2.state = saved;
    h2.ex = new PaperExchange(saved.paper, async () => h2.market(), 0, () => h2.clock);
    h2.ctx.exchange = h2.ex;
    h2.clock = h.clock;
    await h2.tick(960_000);
    expect(h2.state.buyLadder!.levels.map((l) => l.status)).toEqual(["filled", "filled", "pending", "pending"]);
  });
});
