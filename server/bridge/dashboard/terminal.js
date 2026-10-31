// The pure engines behind the terminal-style chrome: the command-line grammar ("banknifty oc", "oi nifty", "help gx"),
// back and forward history of { page, workspace context }, the configurable home page and saved layouts with a strict
// JSON import. DOM-free so it runs in Node tests. Nothing here evaluates input: layouts are plain data that is
// validated field by field, and unknown keys are dropped.
import { DENSITIES, PAGE_CODES, REFRESH_CHOICES, codeTable, normalizeContext, normalizeUnderlying, safeStore } from "./workspace.js";

// ───────────────────────── command grammar ─────────────────────────

/** Instrument-type suffixes. They are never page codes. */
export const ASSET_TOKENS = Object.freeze(["EQ", "FUT", "OPT"]);
/**
 * The instrument types each page can be pointed at. A page lists the type it shows; asking for another one is ignored
 * with a hint. (No page has a type switch of its own yet, so this is the page's one fixed type.)
 */
export const PAGE_ASSETS = Object.freeze({
  chain: ["OPT"],
  oi: ["OPT"],
  gex: ["OPT"],
  skew: ["OPT"],
  expiry: ["OPT"],
  oichange: ["OPT"],
  greeksgrid: ["OPT"],
  unusual: ["OPT"],
  tide: ["OPT"],
  exposure: ["OPT"],
  screener: ["OPT"],
  strategies: ["OPT"],
  payoff: ["OPT", "FUT"],
  futures: ["FUT"],
  scanner: ["EQ"],
});
/** With a symbol and an instrument type but no page code, "reliance fut" opens this page. */
export const ASSET_DEFAULT_PAGE = Object.freeze({ EQ: "scanner", FUT: "futures", OPT: "chain" });

const TOKEN = /^[A-Za-z0-9&_-]{1,30}$/;

/**
 * Parse one line of the command bar.
 *   "banknifty oc" | "oc banknifty" | "oi" | "reliance fut" | "nifty gx opt"  ->  { kind: "go", id, symbol?, asset?, hints }
 *   "help oc" | "? oc" | "help"                                               ->  { kind: "help", id | null }
 * Order does not matter. At most one page code, one symbol and one EQ/FUT/OPT token. Anything else is not a command
 * (null), so ordinary searches fall through to the normal palette. Pure.
 * @param {string} text
 * @param {string[]} pageIds  the pages that exist
 * @returns {null | { kind: "help", id: string | null, code: string | null } | { kind: "go", id: string, code: string, symbol: string | null, asset: string | null, hints: string[] }}
 */
export function parseCommand(text, pageIds) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length > 80) return null;
  const codes = codeTable(pageIds);
  const tokens = raw.replace(/^\?(?=\S)/, "? ").split(/\s+/).filter(Boolean);
  if (tokens.length > 4) return null;
  const upper = tokens.map((t) => t.toUpperCase());
  if (upper[0] === "HELP" || upper[0] === "?") {
    if (upper.length === 1) return { kind: "help", id: null, code: null };
    if (upper.length > 2) return null;
    const id = codes[upper[1]] ?? null;
    return id ? { kind: "help", id, code: upper[1] } : null;
  }
  if (tokens.length > 3 || tokens.some((t) => !TOKEN.test(t))) return null;
  const codeIdx = upper.map((t, i) => (t in codes ? i : -1)).filter((i) => i >= 0);
  const assetIdx = upper.map((t, i) => (ASSET_TOKENS.includes(t) ? i : -1)).filter((i) => i >= 0);
  if (codeIdx.length > 1 || assetIdx.length > 1) return null;
  const rest = tokens.map((_, i) => i).filter((i) => !codeIdx.includes(i) && !assetIdx.includes(i));
  if (rest.length > 1) return null;
  const asset = assetIdx.length ? upper[assetIdx[0]] : null;
  const symbol = rest.length ? normalizeUnderlying(tokens[rest[0]]) : null;
  if (rest.length && !symbol) return null;
  let id = codeIdx.length ? codes[upper[codeIdx[0]]] : null;
  if (!id) {
    // No page code: a symbol with an instrument type picks that type's page ("reliance fut"); a lone symbol is a search.
    if (!(symbol && asset)) return null;
    id = ASSET_DEFAULT_PAGE[asset];
    if (!pageIds.includes(id)) return null;
  }
  const hints = [];
  if (asset && !(PAGE_ASSETS[id] ?? []).includes(asset)) {
    const supported = PAGE_ASSETS[id];
    hints.push(supported ? `${PAGE_CODES[id]} shows ${supported.join(" or ")} only, so ${asset} was ignored.` : `${PAGE_CODES[id]} has no instrument type, so ${asset} was ignored.`);
  }
  return { kind: "go", id, code: PAGE_CODES[id], symbol, asset, hints };
}

// ───────────────────────── back / forward history ─────────────────────────

const sameCtx = (a, b) => a.underlying === b.underlying && a.expiry === b.expiry && a.strikes === b.strikes;
export const HISTORY_MAX = 50;

/**
 * A browser-like history of { page, ctx }. `record` adds a step (dropping anything ahead of the current one);
 * `back` and `forward` return the entry to restore, or null at an end. Recording the entry that is already current is
 * a no-op, which is what lets a restore (that re-draws the page and so records it again) leave the list alone. An
 * expiry that is merely filled in after a page loaded replaces the step instead of adding one. Pure.
 */
export function createHistory(max = HISTORY_MAX) {
  /** @type {{ page: string, ctx: { underlying: string, expiry: string, strikes: number } }[]} */
  let list = [];
  let at = -1;
  const entry = (e) => ({ page: String(e.page), ctx: normalizeContext(e.ctx) });
  return {
    record(e) {
      const next = entry(e);
      const cur = list[at];
      if (cur && cur.page === next.page && sameCtx(cur.ctx, next.ctx)) return false;
      if (cur && cur.page === next.page && cur.ctx.expiry === "" && cur.ctx.underlying === next.ctx.underlying && cur.ctx.strikes === next.ctx.strikes && at === list.length - 1) {
        list[at] = next;
        return true;
      }
      list = [...list.slice(0, at + 1), next].slice(-max);
      at = list.length - 1;
      return true;
    },
    canBack: () => at > 0,
    canForward: () => at >= 0 && at < list.length - 1,
    back() {
      if (at <= 0) return null;
      at -= 1;
      return structuredClone(list[at]);
    },
    forward() {
      if (at < 0 || at >= list.length - 1) return null;
      at += 1;
      return structuredClone(list[at]);
    },
    current: () => (at >= 0 ? structuredClone(list[at]) : null),
    size: () => list.length,
  };
}

// ───────────────────────── home page ─────────────────────────

const HOME_SLOT = "mcb.dashboard.homePage";
/** The page opened when the address has no page in it. Remembered per browser; an unknown page falls back to "home". */
export function createHome(store = safeStore("local"), isPage = () => true, fallback = "home") {
  const read = () => {
    const v = store.get(HOME_SLOT);
    return typeof v === "string" && /^[a-z0-9-]{1,32}$/.test(v) && isPage(v) ? v : fallback;
  };
  return {
    get: read,
    set(id) {
      if (typeof id !== "string" || !isPage(id)) return false;
      store.set(HOME_SLOT, id === fallback ? null : id);
      return true;
    },
    reset() {
      store.set(HOME_SLOT, null);
    },
  };
}

// ───────────────────────── saved layouts ─────────────────────────

const LAYOUT_SLOT = "mcb.dashboard.layouts";
export const LAYOUT_FORMAT = "mcb-layouts";
export const LAYOUT_VERSION = 1;
export const MAX_LAYOUTS = 50;
export const MAX_NAME = 40;
export const MAX_IMPORT_CHARS = 64 * 1024;
const REFRESH_MS = REFRESH_CHOICES.map((c) => c.ms);

const cleanName = (v) =>
  typeof v === "string"
    ? v
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_NAME)
    : "";

/**
 * Check one layout and return a clean copy, or { error }. Known fields only (name, underlying, expiry, strikes, density,
 * autoRefresh, page, collapsed): everything else is dropped, and every value must be the right type and in range.
 * `pageIds` / `groups` (when given) limit `page` and `collapsed` to what exists. Never throws, never evaluates anything.
 * @returns {{ layout: { name: string, underlying: string, expiry: string, strikes: number, density: string, autoRefresh: number, page: string, collapsed: string[] } } | { error: string }}
 */
export function sanitizeLayout(raw, { pageIds, groups } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "A layout must be an object." };
  const name = cleanName(raw.name);
  if (!name) return { error: "A layout needs a name (1 to 40 characters)." };
  const underlying = normalizeUnderlying(raw.underlying);
  if (!underlying) return { error: `“${name}”: the underlying is not a valid symbol.` };
  const expiry = raw.expiry === undefined || raw.expiry === "" ? "" : typeof raw.expiry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.expiry) && !Number.isNaN(Date.parse(`${raw.expiry}T00:00:00Z`)) ? raw.expiry : null;
  if (expiry === null) return { error: `“${name}”: the expiry must be a date like 2026-11-24.` };
  const strikes = raw.strikes === undefined ? 10 : raw.strikes;
  if (!Number.isInteger(strikes) || strikes < 1 || strikes > 200) return { error: `“${name}”: strikes must be a whole number from 1 to 200.` };
  const density = raw.density === undefined ? "comfortable" : raw.density;
  if (!DENSITIES.includes(density)) return { error: `“${name}”: density must be comfortable or compact.` };
  const autoRefresh = raw.autoRefresh === undefined ? 0 : raw.autoRefresh;
  if (!REFRESH_MS.includes(autoRefresh)) return { error: `“${name}”: auto-refresh must be one of ${REFRESH_MS.join(", ")} (milliseconds).` };
  let page = raw.page === undefined ? "" : raw.page;
  if (typeof page !== "string" || (page !== "" && !/^[a-z0-9-]{1,32}$/.test(page))) return { error: `“${name}”: the page is not a page id.` };
  if (page && pageIds && !pageIds.includes(page)) page = ""; // a page this version does not have: stay where you are
  let collapsed = raw.collapsed === undefined ? [] : raw.collapsed;
  if (!Array.isArray(collapsed) || collapsed.length > 20 || collapsed.some((g) => typeof g !== "string" || g.length > 40)) return { error: `“${name}”: collapsed must be a short list of group names.` };
  collapsed = [...new Set(collapsed.map((g) => cleanName(g)).filter(Boolean))].filter((g) => !groups || groups.includes(g));
  return { layout: { name, underlying, expiry, strikes, density, autoRefresh, page, collapsed } };
}

/** The file written by Export: a small wrapper so a stray JSON file is not mistaken for layouts. Pure. */
export const exportLayouts = (layouts) => JSON.stringify({ format: LAYOUT_FORMAT, version: LAYOUT_VERSION, layouts }, null, 2);

/**
 * Read an exported file's text. Strict: a size cap, valid JSON, the right wrapper and version, at most MAX_LAYOUTS
 * entries; each entry is sanitised on its own (a bad one is reported and skipped, the good ones still import).
 * @returns {{ ok: true, layouts: object[], skipped: string[] } | { ok: false, error: string }}
 */
export function parseLayoutFile(text, opts = {}) {
  if (typeof text !== "string") return { ok: false, error: "That is not a text file." };
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, error: `That file is larger than ${MAX_IMPORT_CHARS / 1024} KB, which no layout export is.` };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file is not valid JSON." };
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.format !== LAYOUT_FORMAT) return { ok: false, error: "That is not a layout export (it should say format: mcb-layouts)." };
  if (data.version !== LAYOUT_VERSION) return { ok: false, error: `Layout export version ${String(data.version).slice(0, 12)} is not supported (this one reads version ${LAYOUT_VERSION}).` };
  if (!Array.isArray(data.layouts)) return { ok: false, error: "The export has no layouts list." };
  if (data.layouts.length > MAX_LAYOUTS) return { ok: false, error: `Too many layouts (the limit is ${MAX_LAYOUTS}).` };
  const layouts = [];
  const skipped = [];
  for (const item of data.layouts) {
    const r = sanitizeLayout(item, opts);
    if (r.layout) layouts.push(r.layout);
    else skipped.push(r.error);
  }
  if (!layouts.length) return { ok: false, error: skipped[0] ?? "The export holds no layouts." };
  return { ok: true, layouts, skipped };
}

/** Saved layouts, per browser. Same-name saves replace (case-insensitively). Never throws; storage may be blocked. */
export function createLayouts(store = safeStore("local"), opts = {}) {
  const read = () => {
    try {
      const data = JSON.parse(store.get(LAYOUT_SLOT) ?? "[]");
      if (!Array.isArray(data)) return [];
      return data.slice(0, MAX_LAYOUTS).map((x) => sanitizeLayout(x, opts).layout).filter(Boolean);
    } catch {
      return [];
    }
  };
  let items = read();
  const persist = () => store.set(LAYOUT_SLOT, items.length ? JSON.stringify(items) : null);
  const upsert = (layout) => {
    const at = items.findIndex((x) => x.name.toLowerCase() === layout.name.toLowerCase());
    if (at >= 0) items[at] = layout;
    else items.push(layout);
  };
  return {
    list: () => items.map((x) => ({ ...x, collapsed: [...x.collapsed] })),
    get: (name) => items.find((x) => x.name.toLowerCase() === String(name).toLowerCase()) ?? null,
    /** Save a layout (validated). Returns { ok, layout } or { ok: false, error }. */
    save(raw) {
      const r = sanitizeLayout(raw, opts);
      if (!r.layout) return { ok: false, error: r.error };
      if (!items.some((x) => x.name.toLowerCase() === r.layout.name.toLowerCase()) && items.length >= MAX_LAYOUTS) return { ok: false, error: `You can keep ${MAX_LAYOUTS} layouts. Delete one first.` };
      upsert(r.layout);
      persist();
      return { ok: true, layout: r.layout };
    },
    remove(name) {
      const before = items.length;
      items = items.filter((x) => x.name.toLowerCase() !== String(name).toLowerCase());
      if (items.length !== before) persist();
      return items.length !== before;
    },
    /** Merge already-sanitised layouts from an import (same name replaces). Returns how many were added or replaced. */
    importAll(layouts) {
      let n = 0;
      for (const l of layouts) {
        if (!items.some((x) => x.name.toLowerCase() === l.name.toLowerCase()) && items.length >= MAX_LAYOUTS) continue;
        upsert(l);
        n += 1;
      }
      persist();
      return n;
    },
    exportText: () => exportLayouts(items),
  };
}
