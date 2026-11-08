/**
 * Space and density preferences (pure logic, no DOM): the sidebar (full, icon rail, or automatic) and the density
 * (compact, comfortable, or automatic). app.js reads the stored choice, resolves it for the screen and sets
 * `data-sb` and `data-density` on <html>; app.css section 16 draws the rest from tokens.
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

