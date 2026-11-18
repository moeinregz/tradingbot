const EPS = 1e-9;

export function floorTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(value * f + EPS) / f;
}

export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function floorTick(price: number, tick: number): number {
  if (tick <= 0) return price;
  return Math.floor(price / tick + EPS) * tick;
}

export function ceilTick(price: number, tick: number): number {
  if (tick <= 0) return price;
  return Math.ceil(price / tick - EPS) * tick;
}

export function midPrice(m: { bid: number; ask: number }): number {
  return (m.bid + m.ask) / 2;
}

export function minutesBetween(a: string | Date, b: Date): number {
  return (b.getTime() - new Date(a).getTime()) / 60000;
}
