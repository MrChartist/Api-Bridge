/**
 * Deterministic daily candles for the studies tests: weekdays from Mon 5 Jan 2026, stamped at IST midnight in epoch
 * seconds like the Bridge's daily history. A seeded walk with a slow wave, so trends, reversals and patterns all occur.
 */
const IST_MIDNIGHT_OFFSET_S = 330 * 60;

/** @param {number} n @param {number} [seed] */
export function makeCandles(n, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const out = [];
  let day = Date.UTC(2026, 0, 5) / 1000;
  let price = 1000;
  while (out.length < n) {
    const dow = new Date(day * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const i = out.length;
      const open = price;
      const drift = Math.sin(i / 17) * 0.012 + (rnd() - 0.5) * 0.03;
      const close = Math.max(1, open * (1 + drift));
      const high = Math.max(open, close) * (1 + rnd() * 0.012);
      const low = Math.min(open, close) * (1 - rnd() * 0.012);
      out.push({ time: day - IST_MIDNIGHT_OFFSET_S, open, high, low, close, volume: Math.round(100_000 + rnd() * 900_000) });
      price = close;
    }
    day += 86_400;
  }
  return out;
}
