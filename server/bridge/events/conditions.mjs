/**
 * Live custom conditions (stream S28). A condition is written in the scanner's language (scanner/expr.mjs, the same
 * parser) but evaluated on every tick over a symbol's live registers instead of over candles:
 *
 *   ltp, close   last price             open, high, low   today's open and range so far
 *   pclose, phigh, plow   previous day  pivot   floor pivot (H + L + C) / 3 of the previous day
 *   vwap         today's VWAP           volume  today's volume      avgvol20   20-day average volume
 *   changepct    % change from the previous close (change_pct and prev_close are accepted too)
 *
 * Example: close = high and close > pclose and close > open and close > pivot
 *
 * Candle-only parts (functions such as sma(20), offsets like close[1], "crosses") are refused with a clear message:
 * a tick has no bar history. The compiled condition is a closure over the tree, so a tick costs O(nodes) per
 * condition, a constant. It fires on the false-to-true edge only (the first evaluation sets the starting state).
 */
import { randomBytes } from "node:crypto";
import { BridgeError } from "../core/errors.mjs";
import { parseExpression } from "../scanner/expr.mjs";

export const MAX_CONDITIONS = 50;
export const LIVE_FIELDS = Object.freeze(["ltp", "close", "open", "high", "low", "pclose", "phigh", "plow", "pivot", "vwap", "volume", "avgvol20", "changepct", "change_pct", "prev_close"]);
const ALIAS = Object.freeze({ close: "ltp", change_pct: "changepct", prev_close: "pclose" });

const bad = (msg) => new BridgeError("VALIDATION_FAILED", `Condition: ${msg}`, { errors: [{ path: "expr", message: msg }] });

/** Compile a condition to (regs) => boolean. Throws VALIDATION_FAILED for anything a tick cannot evaluate. */
export function compileCondition(src) {
  const tree = parseExpression(src, { fields: [...LIVE_FIELDS] });
  const build = (n) => {
    switch (n.t) {
      case "num": {
        const v = n.v;
        return () => v;
      }
      case "field": {
        if (!LIVE_FIELDS.includes(n.name)) throw bad(`${n.name} needs candles; live conditions read ${LIVE_FIELDS.filter((f) => !ALIAS[f]).join(", ")}.`);
        const k = ALIAS[n.name] ?? n.name;
        return (r) => r[k];
      }
      case "call":
        throw bad(`${n.name}(...) needs candles and cannot run on live ticks. Use it in Screeners > Stocks, or the live fields ${LIVE_FIELDS.filter((f) => !ALIAS[f]).join(", ")}.`);
      case "shift":
        throw bad("offsets like close[1] need candles; use pclose, phigh or plow for the previous day.");
      case "cross":
        throw bad('"crosses" needs the previous bar; a live condition already fires only when it turns true, so write "close > vwap".');
      case "neg": {
        const x = build(n.x);
        return (r) => -x(r);
      }
      case "not": {
        const x = build(n.x);
        return (r) => (x(r) === true ? false : true);
      }
      case "and": {
        const l = build(n.l);
        const rr = build(n.r);
        return (r) => l(r) === true && rr(r) === true;
      }
      case "or": {
        const l = build(n.l);
        const rr = build(n.r);
        return (r) => l(r) === true || rr(r) === true;
      }
      case "bin": {
        const l = build(n.l);
        const rr = build(n.r);
        if (n.op === "+") return (r) => l(r) + rr(r);
        if (n.op === "-") return (r) => l(r) - rr(r);
        if (n.op === "*") return (r) => l(r) * rr(r);
        return (r) => {
          const d = rr(r);
          return d === 0 ? NaN : l(r) / d;
        };
      }
      case "cmp": {
        const l = build(n.l);
        const rr = build(n.r);
        const ok = (a, b) => Number.isFinite(a) && Number.isFinite(b);
        if (n.op === ">") return (r) => ((a, b) => ok(a, b) && a > b)(l(r), rr(r));
        if (n.op === ">=") return (r) => ((a, b) => ok(a, b) && a >= b)(l(r), rr(r));
        if (n.op === "<") return (r) => ((a, b) => ok(a, b) && a < b)(l(r), rr(r));
        if (n.op === "<=") return (r) => ((a, b) => ok(a, b) && a <= b)(l(r), rr(r));
        // Prices compare equal within half a paisa (a tick-rounded close = high).
        if (n.op === "==") return (r) => ((a, b) => ok(a, b) && Math.abs(a - b) < 0.005)(l(r), rr(r));
        return (r) => ((a, b) => ok(a, b) && Math.abs(a - b) >= 0.005)(l(r), rr(r));
      }
      default:
        throw bad(`unsupported part "${n.t}".`);
    }
  };
  const fn = build(tree);
  return (regs) => fn(regs) === true;
}

/** Validate a create request: { name, expr, side? }. Returns the stored condition. */
export function newCondition(body, existing = []) {
  if (!body || typeof body !== "object") throw bad("send { name, expr, side? }.");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60) throw new BridgeError("VALIDATION_FAILED", "Give the condition a name of 1 to 60 characters.", { errors: [{ path: "name", message: "required" }] });
  if (typeof body.expr !== "string") throw bad("expr is required.");
  const side = body.side === undefined ? "neutral" : body.side;
  if (!["bull", "bear", "neutral"].includes(side)) throw new BridgeError("VALIDATION_FAILED", "side is bull, bear or neutral.", { errors: [{ path: "side", message: "unknown" }] });
  compileCondition(body.expr);
  if (existing.length >= MAX_CONDITIONS) throw new BridgeError("VALIDATION_FAILED", `At most ${MAX_CONDITIONS} conditions. Delete one first.`, { errors: [{ path: "", message: "limit" }] });
  if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new BridgeError("VALIDATION_FAILED", `A condition named "${name}" exists already.`, { errors: [{ path: "name", message: "duplicate" }] });
  return { id: `cond_${randomBytes(6).toString("hex")}`, name, expr: body.expr.trim(), side, createdAt: new Date().toISOString() };
}
