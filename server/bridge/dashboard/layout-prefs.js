/**
 * Space and density preferences (pure logic, no DOM): the sidebar (full, icon rail, or automatic) and the density
 * (compact, comfortable, or automatic). app.js reads the stored choice, resolves it for the screen and sets
 * `data-sb` and `data-density` on <html>; app.css section 15 draws the rest from tokens.
 *
 * Automatic sidebar: the icon rail from 1024 to 1279 px, the full sidebar from 1280 px; below 1024 px there is no
 * sidebar (the tab bar). Automatic density: compact with a fine pointer (mouse, trackpad) on a screen 1024 px or wider,
 * comfortable otherwise. A coarse pointer (touch) is always comfortable, so every target stays 44 px.
 */

export const SIDEBAR_SLOT = "mcb.dashboard.sidebar";
export const DENSITY_SLOT = "mcb.dashboard.density";

/** Below this width there is no sidebar (the phone and tablet tab bar). */
export const SIDEBAR_MIN = 1024;
/** From this width the automatic sidebar is the full one; below it, the icon rail. */
export const SIDEBAR_FULL_MIN = 1280;

/** A stored sidebar choice: "rail", "full" or "auto" (anything else, a missing value included). */
export const parseSidebar = (v) => (v === "rail" || v === "full" ? v : "auto");
/** A stored density choice: "compact", "comfortable" or "auto" (anything else, a missing value included). */
export const parseDensity = (v) => (v === "compact" || v === "comfortable" ? v : "auto");

/** The sidebar to draw: "none" (below 1024 px), "rail" or "full". */
export function resolveSidebar(pref, width) {
  const w = Number(width);
  if (!Number.isFinite(w) || w < SIDEBAR_MIN) return "none";
  const p = parseSidebar(pref);
  if (p !== "auto") return p;
  return w < SIDEBAR_FULL_MIN ? "rail" : "full";
}

/** The density to draw: "compact" or "comfortable". A coarse pointer is always comfortable (44 px targets). */
export function resolveDensity(pref, { fine = false, width = 0 } = {}) {
  if (!fine) return "comfortable";
  const p = parseDensity(pref);
  if (p !== "auto") return p;
  return Number(width) >= SIDEBAR_MIN ? "compact" : "comfortable";
}

/**
 * The stored value after the sidebar toggle is pressed while `current` ("rail" or "full") is shown: the other one,
 * unless that is what automatic would draw at this width anyway (then "auto", so a later resize still adapts).
 */
export function toggleSidebar(current, width) {
  const next = current === "rail" ? "full" : "rail";
  return resolveSidebar("auto", width) === next ? "auto" : next;
}

/**
 * Wide-screen extra chain columns (docs/design/ui-pass-3.md, space pass): when a preset's columns all fit with room
 * to spare, these are added (in order) while the room lasts. Only the presets: a custom column list is the user's own.
 */
export const WIDE_EXTRAS = Object.freeze({
  oi: ["delta", "theta", "vega", "gamma", "pitm"],
  buyer: ["iv", "oi", "chg", "vega"],
  seller: ["iv", "chg", "vol", "theta"],
  hedger: ["iv", "oi", "theta"],
  arb: ["oi", "vol"],
  greeks: ["oi", "chg", "potm"],
  value: ["oi", "delta", "theta"],
});

/**
 * Pick the extra columns that fit: `slack` is the room left (px) once the chosen columns are laid at their minimum
 * widths; each extra costs `sides` × its minimum width plus a share of `spare` (0.12 = keep 12 % breathing room on the
 * whole row). Pure: returns the keys to add, in order.
 */
export function wideExtras({ preset, cols = [], slack = 0, sides = 2, widths = {}, used = 0, spare = 0.12 } = {}) {
  const list = WIDE_EXTRAS[preset];
  if (!list || sides <= 0) return [];
  const have = new Set(cols);
  const w = (k) => widths[k] ?? widths.default ?? 64;
  const out = [];
  let room = Number(slack) - Number(used) * spare;
  for (const k of list) {
    if (have.has(k)) continue;
    const cost = sides * w(k) * (1 + spare);
    if (cost > room) break;
    out.push(k);
    room -= cost;
  }
  return out;
}
