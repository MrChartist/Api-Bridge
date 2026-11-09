/**
 * Strike windows for an option universe. Pure functions.
 *
 * ATM is the LISTED strike nearest to the price (the lower one on an exact tie: market/chain.mjs atmStrike), so it is
 * rounded to the strike step of that underlying and expiry. Index options list a step of 50 or 100 points; a stock's
 * step depends on its price and changes after corporate actions, so the step is read from the listed strikes
 * (market/chain.mjs strikeStepOf), never assumed.
 *
 * `count` strikes each side means that many LISTED strikes each side, so a grid with a gap (a far strike listed at a
 * wider step) still gives `count` strikes and never a strike that does not exist.
 *
 * When no listed strikes are known the window is a generated grid on the configured step (index underlyings only); the
 * answer says `strikeSource: "grid"` and warns that the contracts may not all be listed.
 */
import { atmStrike, strikeStepOf } from "../market/chain.mjs";

/** @param {number[]} strikes  ascending, distinct */
export function stepOfStrikes(strikes) {
  return strikeStepOf(strikes);
}

/**
 * `count` listed strikes each side of the one nearest to `spot`.
 * @param {number[]} strikes ascending, distinct
 * @param {number} spot
 * @param {number} count
 * @returns {{ atm: number | null, strikes: number[] }}
 */
export function strikesAround(strikes, spot, count) {
  const atm = atmStrike(strikes, spot);
  if (atm === null) return { atm: null, strikes: [] };
  const i = strikes.indexOf(atm);
  return { atm, strikes: strikes.slice(Math.max(0, i - count), i + count + 1) };
}

/** Listed strikes between two prices, both included. */
export function strikesBetween(strikes, from, to) {
  return strikes.filter((k) => k >= from && k <= to);
}

/**
 * A generated grid around `spot`: the multiple of `step` nearest to it (the lower one on a tie) and `count` more each side.
 * @returns {{ atm: number | null, strikes: number[] }}
 */
export function gridAround(spot, step, count) {
  if (!(spot > 0) || !(step > 0)) return { atm: null, strikes: [] };
  const base = Math.floor(spot / step) * step;
  const atm = spot - base > base + step - spot ? base + step : base;
  const out = [];
  for (let i = -count; i <= count; i += 1) {
    const k = round(atm + i * step);
    if (k > 0) out.push(k);
  }
  return { atm: round(atm), strikes: out };
}

/** A generated grid between two prices on `step`. Never more than `limit` strikes. */
export function gridBetween(from, to, step, limit = 1000) {
  if (!(step > 0) || !(from <= to)) return [];
  const out = [];
  for (let k = Math.ceil(from / step) * step; k <= to && out.length < limit; k += step) out.push(round(k));
  return out;
}

const round = (n) => Math.round(n * 10_000) / 10_000;
