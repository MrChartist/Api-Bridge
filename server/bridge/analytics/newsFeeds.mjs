/**
 * News, announcements and calendars — stream S15, read scope, no broker account, personal / local use only (exchange
 * and regulator content is not for redistribution). Free official sources only.
 *
 *   GET /v1/analytics/news/regulatory?source=sebi|rbi|all&days=7&q=      SEBI + RBI RSS wire, deduped, tagged
 *   GET /v1/analytics/news/announcements?symbol=&days=3&q=               NSE corporate announcements, deduped by attachment
 *   GET /v1/analytics/calendar/central-banks[?bank=RBI|FOMC|ECB&days=365] curated decision dates with a countdown
 *   GET /v1/analytics/calendar/fno-ban                                    NSE F&O securities in ban, entries / exits
 *   GET /v1/analytics/calendar/timeline?days=14[&underlyings=NIFTY,...]   events + central banks + expiries, sorted
 *
 * EVERY URL IN `ENDPOINTS` IS ASSUMED FROM KNOWLEDGE OF THE SITES AND HAS NOT BEEN PROBED; each is marked
 * verified:false and each response says so in meta.note. A payload that does not match raises UPSTREAM_ERROR.
 *
 * Same machinery as flows.mjs / marketEvents.mjs: cookie-primed createHttpClient for NSE, injected fetcher for tests,
 * per-query TTL cache with in-flight dedupe, stale-serve when a refresh fails, and (when deps.paths.dataDir is set)
 * lazy load / atomic 0600 save to <dataDir>/analytics/news-feeds.json (cached rows plus the F&O ban list state; a
 * corrupt file is moved aside, disk errors are logged only).
 *
 * Feeds are parsed by a small tolerant RSS / Atom reader below: no dependency, no entity expansion (a DOCTYPE or ENTITY
 * declaration rejects the document, only the five predefined and numeric entities are decoded), size and item caps.
 *
 * Timeline events reuse mapEvents from marketEvents.mjs (exported there); the NSE event-calendar request is made here
 * (its default fetcher is private), or through deps.marketEventsFetcher("events", {from, to, symbol}) when injected.
 *
 * deps (all optional): newsFeedsFetcher: async (kind, params) => text | json (tests inject this; kind is one of
 * sebi, rbiPress, rbiNotifications, rbiSpeeches (XML text), announcements, events (json), ban (CSV text)),
 * marketEventsFetcher, marketData (expiries), centralBankDates, fetchImpl, clock, config.backup.timeoutMs,
 * paths.dataDir, logger.
 *
 * Also exports newsAlertCheck(deps, rule) for a future alert type; alertRules.mjs is not changed.
 */
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createHttpClient } from "../backup/httpClient.mjs";
import { NSE_BASE, nseDateToIso } from "../backup/providers/nse.mjs";
import { mapEvents } from "./marketEvents.mjs";
import { CENTRAL_BANK_DATES, CENTRAL_BANK_NOTE } from "./centralBankDates.mjs";

/** All upstream locations in one place. UNVERIFIED: none of these has been probed from a live session. */
export const ENDPOINTS = Object.freeze({
  sebi: Object.freeze({ url: "https://www.sebi.gov.in/sebirss.xml", source: "sebi", feed: "combined", verified: false }),
  rbiPress: Object.freeze({ url: "https://www.rbi.org.in/pressreleases_rss.xml", source: "rbi", feed: "press-releases", verified: false }),
  rbiNotifications: Object.freeze({ url: "https://www.rbi.org.in/notifications_rss.xml", source: "rbi", feed: "notifications", verified: false }),
  rbiSpeeches: Object.freeze({ url: "https://www.rbi.org.in/speeches_rss.xml", source: "rbi", feed: "speeches", verified: false }),
  nseAnnouncements: Object.freeze({ url: `${NSE_BASE}/api/corporate-announcements`, verified: false }),
  nseEventCalendar: Object.freeze({ url: `${NSE_BASE}/api/event-calendar`, verified: false }),
  nseFoBan: Object.freeze({ url: "https://nsearchives.nseindia.com/content/fo/fo_secban.csv", verified: false }),
});
const UNVERIFIED_NOTE = "Upstream endpoints are assumed, not verified against a live session; see ENDPOINTS in newsFeeds.mjs. Personal, local use only.";

export const RSS_TTL_MS = 10 * 60_000;
export const ANNOUNCEMENTS_TTL_MS = 5 * 60_000;
export const BAN_TTL_MS = 15 * 60_000;
export const MAX_XML_BYTES = 2_000_000;
export const MAX_FEED_ITEMS = 200;
const MAX_ENTRIES = 50;
const MAX_ROWS = 300;
const MAX_SEEN = 500;
const IST_OFFSET_MS = 5.5 * 3600_000;
const DAY = 86_400_000;
const LIMITS = Object.freeze({ regulatory: { def: 7, max: 90 }, announcements: { def: 3, max: 30 }, banks: { def: 365, max: 400 }, timeline: { def: 14, max: 60 } });
const RBI_KINDS = ["rbiPress", "rbiNotifications", "rbiSpeeches"];
const SOURCE_KINDS = { sebi: ["sebi"], rbi: RBI_KINDS, all: ["sebi", ...RBI_KINDS] };

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const upstream = (detail) => new BridgeError("UPSTREAM_ERROR", detail);
const str = (v) => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s === "" || s === "-" ? null : s;
};
const pick = (row, ...keys) => {
  for (const k of keys) if (row?.[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
  return null;
};

/** Safe lookup: scoped deps throw on undeclared keys. */
function extra(deps, k) {
  try {
    return deps?.[k];
  } catch {
    return undefined;
  }
}

const istDate = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const ddmmyyyy = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

// ---------------------------------------------------------------------------------------------------------------
// RSS / Atom
// ---------------------------------------------------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** Decode the five predefined and numeric entities only; anything else is left as written (never expanded). */
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e];
  });
}
/** Element text: CDATA is taken literally, otherwise entities are decoded. */
function textOf(raw) {
  if (raw === null || raw === undefined) return null;
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  const s = m ? m[1] : decodeEntities(raw);
  return str(s);
}
const plain = (s, max) => {
  if (s === null) return null;
  const t = s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Inner text of the first <name ...>...</name> (not a self-closing tag). */
function tag(block, name) {
  const m = new RegExp(`<${escRe(name)}(?:\\s[^>]*[^>/])?>([\\s\\S]*?)</${escRe(name)}>`, "i").exec(block);
  return m ? m[1] : null;
}
function atomLink(block) {
  let first = null;
  for (const m of block.matchAll(/<link\b([^>]*?)\/?>/gi)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1];
    if (!href) continue;
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1];
    if (!rel || rel === "alternate") return decodeEntities(href);
    first ??= decodeEntities(href);
  }
  return first;
}
function feedDate(v) {
  const s = str(v);
  if (!s) return null;
  let t = Date.parse(s);
  if (!Number.isFinite(t)) {
    const iso = nseDateToIso(s.split(/\s+/)[0]);
    t = iso ? Date.parse(`${iso}T00:00:00+05:30`) : NaN;
  }
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Tolerant RSS 2.0 / RSS 1.0 / Atom reader -> [{ guid, title, link, summary, publishedAt }] (newest cap MAX_FEED_ITEMS in
 * document order). Rejects DOCTYPE / ENTITY, oversize input, and text that is not a feed (UPSTREAM_ERROR).
 */
export function parseFeed(xml, { maxItems = MAX_FEED_ITEMS, maxBytes = MAX_XML_BYTES } = {}) {
  if (typeof xml !== "string") throw upstream("The feed answered with something that is not text.");
  if (xml.length > maxBytes) throw upstream(`The feed is larger than ${maxBytes} bytes; refusing to parse it.`);
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw upstream("The feed declares a DOCTYPE or ENTITY; refusing to parse it.");
  if (!/<(rss|feed|rdf:RDF)\b/i.test(xml)) throw upstream("The response is not an RSS or Atom feed.");
  const out = [];
  for (const m of xml.matchAll(/<(item|entry)(?:\s[^>]*[^>/])?>([\s\S]*?)<\/\1>/gi)) {
    if (out.length >= maxItems) break;
    const b = m[2];
    const title = plain(textOf(tag(b, "title")), 300);
    const link = textOf(tag(b, "link")) ?? atomLink(b);
    const guid = textOf(tag(b, "guid")) ?? textOf(tag(b, "id"));
    if (!title && !link) continue;
    const summary = plain(textOf(tag(b, "description") ?? tag(b, "summary") ?? tag(b, "content")), 500);
    const publishedAt = feedDate(textOf(tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date")));
    out.push({ guid: guid ? guid.slice(0, 300) : null, title: title ?? link, link: link ? link.slice(0, 500) : null, summary, publishedAt });
  }
  return out;
}

const TAG_RULES = [
  ["fno", /\bF\s?&\s?O\b|\bF&amp;O\b|futures\s+(?:and|&)\s+options|\bderivatives?\b/i],
  ["margin", /\bmargins?\b/i],
  ["lot-size", /\blot\s+sizes?\b|\bmarket\s+lots?\b/i],
  ["circular", /\bcirculars?\b/i],
  ["expiry", /\bexpir(?:y|ies|ation)\b/i],
];
/** Tags (fno, margin, lot-size, circular, expiry) for the text of a headline. */
export function tagText(text) {
  const s = String(text ?? "");
  return TAG_RULES.filter(([, re]) => re.test(s)).map(([t]) => t);
}

/** Feed items from one RSS kind -> regulatory rows. */
export function mapFeed(xml, kind) {
  const meta = ENDPOINTS[kind];
  return parseFeed(xml).map((i) => ({
    id: `${meta.source}:${i.guid ?? i.link ?? `${i.title}|${i.publishedAt ?? ""}`}`.slice(0, 400),
    source: meta.source,
    feed: meta.feed,
    title: i.title,
    link: i.link,
    summary: i.summary,
    publishedAt: i.publishedAt,
    tags: tagText(`${i.title} ${i.summary ?? ""}`),
  }));
}

/** Dedupe by id, then by link; keeps the first seen. */
function dedupe(rows) {
  const ids = new Set();
  const links = new Set();
  const out = [];
  for (const r of rows) {
    if (ids.has(r.id) || (r.link && links.has(r.link))) continue;
    ids.add(r.id);
    if (r.link) links.add(r.link);
    out.push(r);
  }
  return out;
}

const matchesQuery = (q, ...parts) => {
  if (!q) return true;
  const hay = parts.filter(Boolean).join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((tok) => hay.includes(tok));
};
const byDateDesc = (a, b) => (a.publishedAt === b.publishedAt ? (a.id < b.id ? -1 : 1) : (a.publishedAt ?? "") < (b.publishedAt ?? "") ? 1 : -1);

// ---------------------------------------------------------------------------------------------------------------
// NSE announcements, F&O ban list
// ---------------------------------------------------------------------------------------------------------------

/** "30-Oct-2026 14:05:00" / "2026-10-30 14:05:00" -> ISO instant (IST), or null. */
function nseDateTime(v) {
  const s = str(v);
  if (!s) return null;
  const [d, t = "00:00:00"] = s.split(/\s+/);
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : nseDateToIso(d);
  if (!iso) return null;
  const ms = Date.parse(`${iso}T${/^\d{2}:\d{2}(:\d{2})?$/.test(t) ? t : "00:00:00"}+05:30`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Raw /api/corporate-announcements payload -> rows deduped by attachment id (else sequence id, else a content key). */
export function mapAnnouncements(json) {
  const input = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : null;
  if (!input) throw upstream("NSE answered the announcements request with an unexpected shape.");
  const seen = new Set();
  const out = [];
  for (const r of input) {
    const symbol = str(r?.symbol)?.toUpperCase() ?? null;
    const subject = str(pick(r, "desc", "subject"));
    if (!symbol || !subject) continue;
    const file = str(pick(r, "attchmntFile", "attachment"));
    const publishedAt = nseDateTime(pick(r, "an_dt", "sort_date", "date"));
    const attachmentId = file ? (file.split(/[?#]/)[0].split("/").pop() || file) : null;
    const id = attachmentId ?? str(pick(r, "seq_id")) ?? `${symbol}|${publishedAt ?? ""}|${subject}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const detail = plain(str(pick(r, "attchmntText", "detail")), 500);
    out.push({ id, symbol, company: str(pick(r, "sm_name", "company")), subject, detail, publishedAt, attachmentUrl: file, tags: tagText(`${subject} ${detail ?? ""}`) });
  }
  if (input.length && !out.length) throw upstream("NSE returned announcement rows with no recognisable fields.");
  return out;
}

/** fo_secban.csv text -> { tradeDate: ISO|null, symbols: sorted unique }. Header "Securities in Ban For Trade Date 30-OCT-2026:". */
export function parseBanList(text) {
  if (typeof text !== "string") throw upstream("NSE answered the F&O ban request with something that is not text.");
  if (/<\s*(html|!doctype|body)\b/i.test(text)) throw upstream("NSE answered the F&O ban request with a web page, not the CSV.");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let tradeDate = null;
  const symbols = new Set();
  let header = false;
  for (const line of lines) {
    if (/securities\s+in\s+ban|trade\s+date|no\s+securities/i.test(line)) {
      header = true;
      const m = /(\d{1,2}-[A-Za-z]{3}-\d{4})/.exec(line);
      if (m) tradeDate ??= nseDateToIso(m[1]);
      continue;
    }
    const fields = line.split(",").map((f) => f.trim().replace(/^"|"$/g, ""));
    const sym = fields.filter((f) => /^[A-Za-z0-9&-]{1,20}$/.test(f) && !/^\d+$/.test(f)).pop();
    if (sym) symbols.add(sym.toUpperCase());
  }
  if (!header && !symbols.size && lines.length) throw upstream("NSE returned an F&O ban file with no recognisable rows.");
  return { tradeDate, symbols: [...symbols].sort() };
}

/** { entries, exits } of the next ban list against the previous one (both arrays of symbols). */
export function banChanges(prevSymbols, nextSymbols) {
  const p = new Set(prevSymbols);
  const n = new Set(nextSymbols);
  return { entries: [...n].filter((s) => !p.has(s)).sort(), exits: [...p].filter((s) => !n.has(s)).sort() };
}

// ---------------------------------------------------------------------------------------------------------------
// Default fetcher
// ---------------------------------------------------------------------------------------------------------------

/**
 * The shared http client only reads JSON, so text responses are carried inside a JSON envelope: the wrapped fetch
 * reads the body and hands back { __text }. Cookies, headers, timeouts and error mapping stay the client's.
 */
function textWrapped(real, when) {
  return async (url, init) => {
    const res = await real(url, init);
    if (!when(String(url))) return res;
    const body = await res.text();
    return { status: res.status, headers: res.headers, text: async () => JSON.stringify({ __text: body }) };
  };
}

function defaultFetcher(deps) {
  const real = extra(deps, "fetchImpl") ?? globalThis.fetch;
  const timeoutMs = extra(deps, "config")?.backup?.timeoutMs ?? 8000;
  const nse = createHttpClient({ fetchImpl: typeof real === "function" ? textWrapped(real, (u) => u.endsWith(".csv")) : real, timeoutMs, provider: "NSE India" });
  const reg = createHttpClient({ fetchImpl: typeof real === "function" ? textWrapped(real, () => true) : real, timeoutMs, provider: "Regulator RSS" });
  const nseGet = async (url, referer, headers) => {
    if (!nse.hasCookies()) await nse.get(`${NSE_BASE}/`, { raw: true, headers: { Accept: "text/html" } });
    return (await nse.get(url, { headers: { Referer: `${NSE_BASE}${referer}`, ...headers } })).json;
  };
  return async (kind, params = {}) => {
    try {
      if (SOURCE_KINDS.all.includes(kind)) {
        const { json } = await reg.get(ENDPOINTS[kind].url, { headers: { Accept: "application/rss+xml, application/xml, text/xml, */*" } });
        return json?.__text ?? null;
      }
      if (kind === "announcements" || kind === "events") {
        const q = new URLSearchParams({ index: "equities", from_date: ddmmyyyy(params.from), to_date: ddmmyyyy(params.to) });
        if (params.symbol) q.set("symbol", params.symbol);
        const ep = kind === "announcements" ? ENDPOINTS.nseAnnouncements : ENDPOINTS.nseEventCalendar;
        return await nseGet(`${ep.url}?${q}`, kind === "announcements" ? "/companies-listing/corporate-filings-announcements" : "/companies-listing/corporate-filings-event-calendar");
      }
      if (kind === "ban") return (await nseGet(ENDPOINTS.nseFoBan.url, "/products-services/equity-derivatives-list-of-securities-in-ban-period", { Accept: "text/csv, text/plain, */*" }))?.__text ?? null;
    } catch (err) {
      if (err instanceof BridgeError && err.code === "SYMBOL_NOT_FOUND") throw upstream(`The ${kind} endpoint answered 404; its URL is unverified and may have moved.`);
      throw err;
    }
    throw invalid("kind", `Unknown feed kind ${kind}.`);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------------------------

export function createNewsFeeds(deps) {
  const fetcher = extra(deps, "newsFeedsFetcher") ?? defaultFetcher(deps);
  const now = () => (extra(deps, "clock")?.now ? deps.clock.now() : Date.now());
  const dataDir = extra(deps, "paths")?.dataDir;
  const filePath = dataDir ? join(dataDir, "analytics", "news-feeds.json") : null;
  const baseLog = extra(deps, "logger");
  const log = baseLog?.child ? baseLog.child({ module: "news-feeds" }) : baseLog;
  const warn = (msg, err) => {
    try {
      log?.warn?.({ err: err?.message ?? String(err) }, msg);
    } catch {
      /* logging must never fail a request */
    }
  };

  /** cache key -> { fetchedAt, rows } */
  const cache = new Map();
  const inflight = new Map();
  /** { current: {tradeDate, symbols, fetchedAt}|null, previous: {tradeDate, symbols}|null } */
  const ban = { current: null, previous: null };
  let loaded = false;

  const isSyms = (a) => Array.isArray(a) && a.every((s) => typeof s === "string");
  function load() {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") warn("news-feeds cache unreadable; starting empty", err);
      return;
    }
    try {
      const doc = JSON.parse(text);
      if (!doc || typeof doc.entries !== "object" || doc.entries === null || Array.isArray(doc.entries)) throw new Error("unexpected shape");
      for (const [k, e] of Object.entries(doc.entries)) if (e && Number.isFinite(e.fetchedAt) && Array.isArray(e.rows)) cache.set(k, { fetchedAt: e.fetchedAt, rows: e.rows });
      const c = doc.ban?.current;
      if (c && isSyms(c.symbols) && Number.isFinite(c.fetchedAt)) ban.current = { tradeDate: c.tradeDate ?? null, symbols: c.symbols, fetchedAt: c.fetchedAt };
      const p = doc.ban?.previous;
      if (p && isSyms(p.symbols)) ban.previous = { tradeDate: p.tradeDate ?? null, symbols: p.symbols };
      trim();
    } catch (err) {
      cache.clear();
      ban.current = ban.previous = null;
      warn("news-feeds cache file is corrupt; moving it aside", err);
      try {
        renameSync(filePath, `${filePath}.corrupt-${now()}`);
      } catch (e2) {
        warn("could not move the corrupt news-feeds file aside", e2);
      }
    }
  }
  function trim() {
    const keep = [...cache].sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, MAX_ENTRIES);
    cache.clear();
    for (const [k, v] of keep) cache.set(k, v);
  }
  function save() {
    if (!filePath) return;
    try {
      writeFileAtomic(filePath, `${JSON.stringify({ version: 1, entries: Object.fromEntries(cache), ban }, null, 2)}\n`);
    } catch (err) {
      warn("could not persist news-feeds cache", err);
    }
  }

  async function call(kind, params) {
    try {
      return await fetcher(kind, params);
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError("UPSTREAM_ERROR", `The ${kind} fetch failed unexpectedly.`, { cause: err });
    }
  }

  /** Shared TTL cache + in-flight dedupe + stale-serve. produce() -> rows. @returns {{rows, fetchedAt, stale}} */
  async function cached(key, ttl, produce) {
    load();
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < ttl) return { ...hit, stale: false };
    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        const rows = await produce();
        cache.set(key, { fetchedAt: now(), rows });
        trim();
        save();
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    try {
      await p;
    } catch (err) {
      if (!cache.has(key)) throw err; // nothing cached: surface the error; otherwise serve stale data below
    }
    const e = cache.get(key);
    return { ...e, stale: now() - e.fetchedAt >= ttl };
  }

  /** Regulatory rows (not yet q-filtered): { items, fetchedAt, stale, failed: [kind] }. */
  async function regulatory({ source = "all", days = LIMITS.regulatory.def } = {}) {
    const kinds = SOURCE_KINDS[source];
    if (!kinds) throw invalid("source", "source must be sebi, rbi or all.");
    const settled = await Promise.allSettled(kinds.map((k) => cached(`rss|${k}`, RSS_TTL_MS, async () => mapFeed(await call(k, {}), k))));
    const ok = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
    if (!ok.length) throw settled[0].reason;
    const failed = kinds.filter((_, i) => settled[i].status === "rejected");
    const cutoff = now() - days * DAY;
    const items = dedupe(ok.flatMap((r) => r.rows).filter((r) => r.publishedAt === null || Date.parse(r.publishedAt) >= cutoff)).sort(byDateDesc);
    return { items, fetchedAt: Math.min(...ok.map((r) => r.fetchedAt)), stale: ok.some((r) => r.stale), failed };
  }

  async function announcements({ symbol = null, days = LIMITS.announcements.def } = {}) {
    const to = istDate(now());
    const from = addDays(to, -days);
    const r = await cached(`ann|${symbol ?? ""}|${from}|${to}`, ANNOUNCEMENTS_TTL_MS, async () => mapAnnouncements(await call("announcements", { from, to, symbol })));
    const items = r.rows.filter((a) => !symbol || a.symbol === symbol).sort(byDateDesc);
    return { items, fetchedAt: r.fetchedAt, stale: r.stale };
  }

  /** The ban list with entries / exits against the previously persisted list. */
  async function fnoBan() {
    load();
    const fresh = () => ban.current && now() - ban.current.fetchedAt < BAN_TTL_MS;
    if (!fresh()) {
      let p = inflight.get("ban");
      if (!p) {
        p = (async () => {
          const next = parseBanList(await call("ban", {}));
          const cur = ban.current;
          const changed = !cur || (next.tradeDate && cur.tradeDate && next.tradeDate !== cur.tradeDate) || banChanges(cur.symbols, next.symbols).entries.length || banChanges(cur.symbols, next.symbols).exits.length;
          if (changed && cur) ban.previous = { tradeDate: cur.tradeDate, symbols: cur.symbols };
          ban.current = changed || !cur ? { tradeDate: next.tradeDate, symbols: next.symbols, fetchedAt: now() } : { ...cur, fetchedAt: now() };
          save();
        })().finally(() => inflight.delete("ban"));
        inflight.set("ban", p);
      }
      try {
        await p;
      } catch (err) {
        if (!ban.current) throw err;
      }
    }
    const cur = ban.current;
    const prev = ban.previous;
    const { entries, exits } = prev ? banChanges(prev.symbols, cur.symbols) : { entries: [], exits: [] };
    return { tradeDate: cur.tradeDate, symbols: cur.symbols, previousTradeDate: prev?.tradeDate ?? null, baseline: !prev, entries, exits, fetchedAt: cur.fetchedAt, stale: now() - cur.fetchedAt >= BAN_TTL_MS };
  }

  /** NSE event-calendar rows (mapEvents from marketEvents.mjs) for today .. today + days. */
  async function eventRows(days) {
    const from = istDate(now());
    const to = addDays(from, days);
    const inj = extra(deps, "marketEventsFetcher");
    const r = await cached(`events|${from}|${to}`, ANNOUNCEMENTS_TTL_MS, async () => mapEvents(inj ? await inj("events", { from, to, symbol: null }) : await call("events", { from, to, symbol: null })));
    return r;
  }

  return { regulatory, announcements, fnoBan, eventRows, now };
}

const services = new WeakMap();
/** The one service for these deps, so routes and alert checks share one cache. */
export function newsFeedsFor(deps) {
  const key = deps !== null && typeof deps === "object" ? deps : null;
  let s = key ? services.get(key) : null;
  if (!s) {
    s = createNewsFeeds(deps);
    if (key) services.set(key, s);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Alert helper (for a future alert type; alertRules.mjs is NOT edited)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Edge-triggered check for two future rule kinds. `rule.state` is what the previous check returned; it is not mutated.
 *   { kind: "news_keywords", keywords: ["margin", "lot size"], source?: "sebi"|"rbi"|"all"|"nse" (default all), symbol? (nse), days? }
 *     fires on items that match a keyword and were not in state.seen; the first check only records a baseline.
 *   { kind: "fno_ban_change", symbols?: [watch list], state: { symbols, tradeDate } }
 *     fires when securities enter or leave the ban list versus the list the previous check saw (filtered to `symbols`
 *     when given); the first check only records a baseline.
 * Throws when the upstream fails with nothing cached, so a failed check leaves state alone.
 * @returns {Promise<{ fired: boolean, status: "ok"|"baseline", hits?: object[], entries?: string[], exits?: string[], message: string|null, state: object }>}
 */
export async function newsAlertCheck(deps, rule) {
  const svc = newsFeedsFor(deps);
  const prev = rule?.state && typeof rule.state === "object" ? rule.state : {};
  if (rule?.kind === "news_keywords") {
    const kws = Array.isArray(rule.keywords) ? rule.keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean).slice(0, 10) : [];
    if (!kws.length) throw invalid("keywords", "keywords must list 1 to 10 words.");
    const source = rule.source ?? "all";
    const days = Number.isInteger(rule.days) && rule.days > 0 ? Math.min(rule.days, 30) : 7;
    let items;
    if (source === "nse") items = (await svc.announcements({ symbol: rule.symbol ? String(rule.symbol).toUpperCase() : null, days })).items.map((a) => ({ id: `nse:${a.id}`, source: "nse", title: `${a.symbol}: ${a.subject}`, link: a.attachmentUrl, text: `${a.subject} ${a.detail ?? ""}` }));
    else items = (await svc.regulatory({ source, days })).items.map((i) => ({ id: i.id, source: i.source, title: i.title, link: i.link, text: `${i.title} ${i.summary ?? ""}` }));
    const matched = items.filter((i) => kws.some((k) => i.text.toLowerCase().includes(k)));
    const seen = Array.isArray(prev.seen) ? prev.seen : null;
    const nextSeen = [...new Set([...matched.map((m) => m.id), ...(seen ?? [])])].slice(0, MAX_SEEN);
    if (!seen) return { fired: false, status: "baseline", hits: [], message: null, state: { seen: nextSeen } };
    const known = new Set(seen);
    const hits = matched.filter((m) => !known.has(m.id)).map(({ id, source: s, title, link }) => ({ id, source: s, title, link }));
    return { fired: hits.length > 0, status: "ok", hits, message: hits.length ? `${hits.length} new item${hits.length > 1 ? "s" : ""} matching ${kws.join(", ")}: ${hits[0].title}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ""}` : null, state: { seen: nextSeen } };
  }
  if (rule?.kind === "fno_ban_change") {
    const watch = Array.isArray(rule.symbols) && rule.symbols.length ? new Set(rule.symbols.map((s) => String(s).toUpperCase())) : null;
    const cur = await svc.fnoBan();
    const state = { symbols: cur.symbols, tradeDate: cur.tradeDate };
    if (!Array.isArray(prev.symbols)) return { fired: false, status: "baseline", entries: [], exits: [], message: null, state };
    let { entries, exits } = banChanges(prev.symbols, cur.symbols);
    if (watch) {
      entries = entries.filter((s) => watch.has(s));
      exits = exits.filter((s) => watch.has(s));
    }
    const parts = [];
    if (entries.length) parts.push(`entered F&O ban: ${entries.join(", ")}`);
    if (exits.length) parts.push(`left F&O ban: ${exits.join(", ")}`);
    return { fired: parts.length > 0, status: "ok", entries, exits, message: parts.length ? parts.join("; ") : null, state };
  }
  throw invalid("kind", "kind must be news_keywords or fno_ban_change.");
}

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

/** Countdown rows from a curated list: upcoming only (today or later), nearest first. */
export function upcomingBankDates(list, todayIso, days, bank = null) {
  const end = addDays(todayIso, days);
  return list
    .filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.date >= todayIso && d.date <= end && (!bank || d.bank === bank))
    .map((d) => ({ bank: d.bank, name: d.name, startDate: d.startDate ?? null, date: d.date, daysUntil: Math.round((Date.parse(`${d.date}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / DAY) }))
    .sort((a, b) => (a.date === b.date ? (a.bank < b.bank ? -1 : 1) : a.date < b.date ? -1 : 1));
}

const TYPE_ORDER = { "central-bank": 0, expiry: 1, event: 2 };

/** @returns {Array<[string, string, {scope: "read"}, (ctx: any) => Promise<object>]>} */
export function newsFeedsRoutes(deps) {
  const svc = newsFeedsFor(deps);
  const now = svc.now;

  function intParam(ctx, name, lim) {
    const raw = ctx.query.get(name);
    if (raw === null || raw === "") return lim.def;
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > lim.max) throw invalid(name, `${name} must be a whole number from 1 to ${lim.max}.`);
    return Number(raw);
  }
  function qParam(ctx) {
    const raw = ctx.query.get("q");
    if (raw === null || raw.trim() === "") return null;
    if (raw.length > 100) throw invalid("q", "q must be at most 100 characters.");
    return raw.trim();
  }
  function symbolParam(ctx) {
    const raw = ctx.query.get("symbol");
    if (raw === null || raw === "") return null;
    const s = raw.trim().toUpperCase();
    if (!/^[A-Z0-9&-]{1,20}$/.test(s)) throw invalid("symbol", "symbol must be an NSE ticker such as RELIANCE or M&M.");
    return s;
  }
  const meta = (ctx, source, r, more) => ({
    requestId: ctx.requestId,
    source,
    fetchedAt: new Date(r.fetchedAt).toISOString(),
    stale: r.stale,
    note: UNVERIFIED_NOTE,
    ...more,
  });

  async function regulatoryRoute(ctx) {
    const source = ctx.query.get("source") ?? "all";
    if (!SOURCE_KINDS[source]) throw invalid("source", "source must be sebi, rbi or all.");
    const days = intParam(ctx, "days", LIMITS.regulatory);
    const q = qParam(ctx);
    const r = await svc.regulatory({ source, days });
    const rows = r.items.filter((i) => matchesQuery(q, i.title, i.summary));
    return {
      data: { items: rows.slice(0, MAX_ROWS) },
      meta: meta(ctx, source === "all" ? "sebi+rbi" : source, r, { requestedSource: source, days, total: rows.length, failedFeeds: r.failed }),
    };
  }

  async function announcementsRoute(ctx) {
    const symbol = symbolParam(ctx);
    const days = intParam(ctx, "days", LIMITS.announcements);
    const q = qParam(ctx);
    const r = await svc.announcements({ symbol, days });
    const rows = r.items.filter((a) => matchesQuery(q, a.subject, a.detail, a.company));
    return { data: { items: rows.slice(0, MAX_ROWS) }, meta: meta(ctx, "nse", r, { days, total: rows.length }) };
  }

  async function centralBanksRoute(ctx) {
    const days = intParam(ctx, "days", LIMITS.banks);
    const bank = ctx.query.get("bank");
    if (bank !== null && bank !== "" && !["RBI", "FOMC", "ECB"].includes(bank.toUpperCase())) throw invalid("bank", "bank must be RBI, FOMC or ECB.");
    const t = now();
    const today = istDate(t);
    const list = extra(deps, "centralBankDates") ?? CENTRAL_BANK_DATES;
    const rows = upcomingBankDates(list, today, days, bank ? bank.toUpperCase() : null);
    return {
      data: { asOf: today, dates: rows, note: CENTRAL_BANK_NOTE },
      meta: { requestId: ctx.requestId, source: "curated", fetchedAt: new Date(t).toISOString(), stale: false, days, total: rows.length, note: `${UNVERIFIED_NOTE} Dates are curated by hand: verify against the official calendar.` },
    };
  }

  async function fnoBanRoute(ctx) {
    const r = await svc.fnoBan();
    return {
      data: { tradeDate: r.tradeDate, count: r.symbols.length, symbols: r.symbols, previousTradeDate: r.previousTradeDate, baseline: r.baseline, entries: r.entries, exits: r.exits },
      meta: meta(ctx, "nse", r, {}),
    };
  }

  async function timelineRoute(ctx) {
    const days = intParam(ctx, "days", LIMITS.timeline);
    const rawU = ctx.query.get("underlyings");
    const underlyings = rawU ? [...new Set(rawU.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))] : ["NIFTY"];
    if (underlyings.length > 5 || underlyings.some((u) => !/^[A-Z0-9&_-]{1,30}$/.test(u))) throw invalid("underlyings", "underlyings must be up to 5 comma-separated tickers such as NIFTY,BANKNIFTY.");
    const t = now();
    const today = istDate(t);
    const end = addDays(today, days);
    const items = [];
    const sources = {};
    let fetchedAt = t;
    let stale = false;

    for (const d of upcomingBankDates(extra(deps, "centralBankDates") ?? CENTRAL_BANK_DATES, today, days)) items.push({ date: d.date, type: "central-bank", title: d.name, symbol: d.bank, daysUntil: d.daysUntil });
    sources.centralBanks = { ok: true };

    try {
      const r = await svc.eventRows(days);
      fetchedAt = Math.min(fetchedAt, r.fetchedAt);
      stale ||= r.stale;
      for (const e of r.rows) if (e.date >= today && e.date <= end) items.push({ date: e.date, type: "event", title: `${e.symbol}: ${e.purpose ?? "event"}`, symbol: e.symbol, detail: e.description ?? null });
      sources.events = { ok: true, derived: "mapEvents from marketEvents.mjs" };
    } catch (err) {
      sources.events = { ok: false, error: err?.code ?? "INTERNAL" };
    }

    const md = extra(deps, "marketData");
    if (md?.expiries) {
      const results = await Promise.allSettled(underlyings.map((u) => md.expiries(u)));
      sources.expiries = { ok: results.some((x) => x.status === "fulfilled"), failed: underlyings.filter((_, i) => results[i].status === "rejected") };
      results.forEach((x, i) => {
        if (x.status !== "fulfilled") return;
        for (const e of x.value?.expiries ?? []) if (typeof e === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e) && e >= today && e <= end) items.push({ date: e, type: "expiry", title: `${underlyings[i]} expiry`, symbol: underlyings[i] });
      });
    } else sources.expiries = { ok: false, error: "marketData.expiries is not available" };

    items.sort((a, b) => (a.date === b.date ? TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) : a.date < b.date ? -1 : 1));
    const body = items.slice(0, MAX_ROWS * 2);
    return {
      data: { from: today, to: end, items: body },
      meta: meta(ctx, "composite", { fetchedAt, stale }, { days, total: items.length, sources }),
    };
  }

  return [
    ["GET", "/v1/analytics/news/regulatory", { scope: "read" }, regulatoryRoute],
    ["GET", "/v1/analytics/news/announcements", { scope: "read" }, announcementsRoute],
    ["GET", "/v1/analytics/calendar/central-banks", { scope: "read" }, centralBanksRoute],
    ["GET", "/v1/analytics/calendar/fno-ban", { scope: "read" }, fnoBanRoute],
    ["GET", "/v1/analytics/calendar/timeline", { scope: "read" }, timelineRoute],
  ];
}
