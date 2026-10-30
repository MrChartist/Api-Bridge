/**
 * Trigger maths (pure: no I/O, no clock). A trigger is a GTT: one leg ("single") or two ("oco", one above the price
 * and one below; the first to touch fires and the other is gone). A leg may trail: its trigger follows the best price
 * seen by a fixed distance (points or percent) and never moves back.
 *
 *   leg = { role: "entry"|"stop"|"target", op: "above"|"below", trigger, order: { side, orderType, price?, quantity?, lots? },
 *           trail: { points } | { pct } | null }
 *
 * "above" fires when LTP >= trigger, "below" when LTP <= trigger. A price that gaps through the trigger fires too
 * (the comparison is inclusive and one-sided), exactly once: the caller stops evaluating a trigger once it fires.
 */

export const TRIGGER_TYPES = Object.freeze(["single", "oco"]);
export const TRIGGER_ORIGINS = Object.freeze(["gtt", "bracket", "position", "amo"]);
export const TRIGGER_STATUSES = Object.freeze(["waiting", "active", "firing", "triggered", "cancelled", "failed", "expired"]);
export const OPEN_STATUSES = Object.freeze(new Set(["waiting", "active", "firing"]));

const SCALE = 1e6;
/** Round to a tick without float noise. "down" for a stop under a long, "up" for one over a short. */
export function toTick(value, tick = 0.05, dir = "nearest") {
  const t = Number(tick) > 0 ? Number(tick) : 0.05;
  const units = value / t;
  const r = dir === "down" ? Math.floor(units + 1e-9) : dir === "up" ? Math.ceil(units - 1e-9) : Math.round(units);
  return Math.round(r * t * SCALE) / SCALE;
}

/** The side of the price a trigger sits on, from the price now. Null when it is exactly at the price. */
export function opFor(trigger, ltp) {
  if (!Number.isFinite(trigger) || !Number.isFinite(ltp) || trigger === ltp) return null;
  return trigger > ltp ? "above" : "below";
}

/** Whether a leg's condition holds at this price. */
export function crossed(leg, ltp) {
  if (!Number.isFinite(ltp) || !Number.isFinite(leg?.trigger)) return false;
  return leg.op === "above" ? ltp >= leg.trigger : ltp <= leg.trigger;
}

/** The trail distance at a price: fixed points, or a percent of that price. */
export function trailDistance(trail, price) {
  if (!trail) return null;
  if (Number(trail.points) > 0) return Number(trail.points);
  if (Number(trail.pct) > 0 && Number.isFinite(price)) return (price * Number(trail.pct)) / 100;
  return null;
}

/**
 * Move trailing legs with a new price. A "below" leg (a stop under a long) follows the highest price; an "above" leg
 * (a stop over a short) follows the lowest. The trigger only ever tightens.
 * @returns {boolean} whether any trigger moved
 */
export function trail(t, ltp, tick = 0.05) {
  if (!Number.isFinite(ltp)) return false;
  let moved = false;
  for (const leg of t.legs) {
    if (!leg.trail) continue;
    if (leg.op === "below") {
      leg.best = Math.max(Number.isFinite(leg.best) ? leg.best : ltp, ltp);
      const d = trailDistance(leg.trail, leg.best);
      if (d === null) continue;
      const next = toTick(leg.best - d, tick, "down");
      if (next > leg.trigger) {
        leg.trigger = next;
        moved = true;
      }
    } else {
      leg.best = Math.min(Number.isFinite(leg.best) ? leg.best : ltp, ltp);
      const d = trailDistance(leg.trail, leg.best);
      if (d === null) continue;
      const next = toTick(leg.best + d, tick, "up");
      if (next < leg.trigger) {
        leg.trigger = next;
        moved = true;
      }
    }
  }
  return moved;
}

/**
 * One evaluation at a price: trail first (a new high moves the stop up before it is checked), then the first leg whose
 * condition holds.
 * @returns {{ fire: number | null, moved: boolean }}
 */
export function step(t, ltp, tick = 0.05) {
  const moved = trail(t, ltp, tick);
  const fire = t.legs.findIndex((leg) => crossed(leg, ltp));
  return { fire: fire >= 0 ? fire : null, moved };
}

/**
 * Check the legs of a new trigger against the price now. Returns a list of { path, message } problems (empty: fine).
 * `ltp` null skips the price checks (a bracket waiting for its entry to fill is checked when it arms).
 */
export function legProblems(type, legs, ltp) {
  const out = [];
  if (!TRIGGER_TYPES.includes(type)) return [{ path: "type", message: `type must be ${TRIGGER_TYPES.join(" or ")}.` }];
  if (!Array.isArray(legs) || legs.length !== (type === "oco" ? 2 : 1)) return [{ path: "legs", message: type === "oco" ? "An OCO trigger has two legs: one above the price and one below." : "A single trigger has one leg." }];
  legs.forEach((leg, i) => {
    const p = `legs.${i}`;
    if (!(Number(leg.trigger) > 0)) out.push({ path: `${p}.trigger`, message: "trigger must be a price above zero." });
    if (leg.op !== "above" && leg.op !== "below") out.push({ path: `${p}.op`, message: "op must be above or below." });
    if (Number.isFinite(ltp) && crossed(leg, ltp)) out.push({ path: `${p}.trigger`, message: `The price (${ltp}) is already ${leg.op === "above" ? "at or above" : "at or below"} ${leg.trigger}. Choose a trigger on the other side, or place the order now.` });
    if (leg.trail) {
      const d = trailDistance(leg.trail, leg.trigger);
      if (!(d > 0)) out.push({ path: `${p}.trail`, message: "A trailing leg needs points or pct above zero." });
      if (Number(leg.trail.pct) > 50) out.push({ path: `${p}.trail.pct`, message: "pct must be 50 or less." });
    }
  });
  if (type === "oco" && !out.length) {
    const ops = legs.map((l) => l.op).sort().join(",");
    if (ops !== "above,below") out.push({ path: "legs", message: "An OCO trigger needs one leg above the price and one below." });
    if (legs[0].order?.side !== legs[1].order?.side) out.push({ path: "legs", message: "Both legs of an OCO trigger close the same position, so they must be on the same side." });
    const above = legs.find((l) => l.op === "above");
    const below = legs.find((l) => l.op === "below");
    if (above && below && !(above.trigger > below.trigger)) out.push({ path: "legs", message: "The upper trigger must be above the lower one." });
  }
  return out;
}

/** Plain words for one leg: "Sell when LTP ≤ 98.50 (trails 5 points)". Numbers as the caller formats them. */
export function legWords(leg, fmt = (n) => String(n)) {
  const verb = leg.order?.side === "BUY" ? "Buy" : "Sell";
  const cmp = leg.op === "above" ? "≥" : "≤";
  const tr = leg.trail ? (Number(leg.trail.points) > 0 ? ` (trails ${fmt(leg.trail.points)} points)` : ` (trails ${fmt(leg.trail.pct)}%)`) : "";
  return `${verb} when LTP ${cmp} ${fmt(leg.trigger)}${tr}`;
}

/**
 * Reduce-only sizing for exits (position and bracket triggers): never more than is held, never across zero.
 * @param {number} want   units the leg would send
 * @param {"BUY"|"SELL"} side
 * @param {number|null} held  net quantity held now (signed), null when unknown
 * @returns {{ quantity: number, reason: string | null }}  quantity 0 means do not send
 */
export function reduceOnlyQty(want, side, held) {
  if (held === null || !Number.isFinite(held)) return { quantity: 0, reason: "The position could not be read, so the exit was not sent." };
  if (held === 0) return { quantity: 0, reason: "The position is already closed." };
  const closes = (side === "SELL" && held > 0) || (side === "BUY" && held < 0);
  if (!closes) return { quantity: 0, reason: `The position is now ${held > 0 ? "long" : "short"}; a ${side.toLowerCase()} would add to it, so the exit was not sent.` };
  return { quantity: Math.min(Math.abs(want), Math.abs(held)), reason: null };
}
