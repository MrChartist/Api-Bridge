/**
 * Shape checks for what a plugin returns. A plugin's answer is data from an untrusted process: it is re-validated here
 * with the same strictness as a broker adapter's output (finite positive prices, ascending candle times, ISO expiry
 * dates, bid not above ask) and unknown keys are dropped. Anything that does not fit is a BAD_RESPONSE, never a partial
 * success.
 */
import { z } from "zod";

const MAX_QUOTES = 200;
const MAX_CANDLES = 20_000;
const MAX_ROWS = 2_000;
const FUTURE_SLACK_MS = 5_000;

const price = z.number().finite().positive();
const nonNeg = z.number().finite().min(0);
const optPrice = price.nullish().transform((v) => v ?? null);
const optNonNeg = nonNeg.nullish().transform((v) => v ?? null);
const optNum = z.number().finite().nullish().transform((v) => v ?? null);
const symbol = z.string().min(1).max(60).regex(/^[A-Za-z0-9:._&-]+$/, "symbol has unexpected characters");

const quoteFields = z.object({
  ltp: price,
  open: optPrice,
  high: optPrice,
  low: optPrice,
  close: optPrice,
  volume: optNonNeg,
  oi: optNonNeg,
  bid: optPrice,
  ask: optPrice,
  bidQty: optNonNeg,
  askQty: optNonNeg,
});

const legFields = z.object({
  ltp: optPrice,
  bid: optPrice,
  ask: optPrice,
  oi: optNonNeg,
  volume: optNonNeg,
  bidQty: optNonNeg,
  askQty: optNonNeg,
  iv: optNonNeg,
  delta: optNum,
  gamma: optNum,
  theta: optNum,
  vega: optNum,
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "not a calendar date");

/** A timestamp in epoch milliseconds that is not from the future. */
const at = (now) => z.number().finite().positive().refine((t) => t <= now + FUTURE_SLACK_MS, "timestamp is in the future");

function dropCrossed(f) {
  if (f.bid !== null && f.ask !== null && f.bid > f.ask) return { ...f, bid: null, ask: null };
  return f;
}

const schemas = (now) => ({
  quotes: z.object({
    items: z.array(z.object({ symbol, fields: quoteFields.transform(dropCrossed), at: at(now) })).max(MAX_QUOTES),
  }),
  history: z.object({
    candles: z
      .array(z.object({ time: z.number().int().positive(), open: price, high: price, low: price, close: price, volume: nonNeg.default(0) }).refine((c) => c.high >= c.low, "high is below low"))
      .max(MAX_CANDLES)
      .refine((cs) => cs.every((c, i) => i === 0 || c.time > cs[i - 1].time), "candle times must ascend"),
    partial: z.boolean().optional(),
    at: at(now),
  }),
  expiries: z.object({ expiries: z.array(isoDate).max(200), at: at(now) }),
  optionChain: z.object({
    underlyingLtp: price.nullable(),
    rows: z
      .array(z.object({ strike: price, ce: legFields.transform(dropCrossed).nullish().transform((v) => v ?? null), pe: legFields.transform(dropCrossed).nullish().transform((v) => v ?? null) }))
      .max(MAX_ROWS),
    at: at(now),
  }),
  test: z.object({ ok: z.boolean(), latencyMs: nonNeg.optional(), detail: z.string().max(200).optional() }),
});

/**
 * Validate and clean a plugin's `result` payload for a method.
 * @param {"quotes"|"history"|"expiries"|"optionChain"|"test"} method
 * @param {unknown} data
 * @param {number} now  epoch ms from the Bridge clock
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
export function validateResult(method, data, now) {
  const schema = schemas(now)[method];
  if (!schema) return { ok: false, error: `unknown method ${method}` };
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, value: r.data };
  const i = r.error.issues[0];
  return { ok: false, error: `${method} result: ${i.path.join(".") || "shape"} ${i.message}`.slice(0, 200) };
}
