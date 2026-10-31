/**
 * Route handlers for stream S17 (docs/spec/p1-01-recorder.md §4; docs/openapi.yaml tag "Options data"). Reads need
 * the "read" scope. The config write needs "admin" from this computer. Nothing here can place an order.
 *
 * Account ids in recorded data (`accountId`, `accounts`, `broker` and the status's account) are returned as null
 * unless the caller is local, the key has accounts "*", or its list includes that account (§4). Recorded data itself
 * is the owner's local store, so a key's account restriction does not hide it.
 *
 * `readSnapshots(...)` is shared with the MCP tool get_option_snapshots, so REST and MCP give the same data.
 */
import { setConfigSection } from "../accounts/configFile.mjs";
import { BridgeError } from "../core/errors.mjs";
import { csv } from "../core/http.mjs";
import { parseTimeInput, toIstIso } from "../market/time.mjs";
import { defaultSessionFor } from "../reference/defaults.mjs";
import { istDateOf, istMidnight } from "./calendar.mjs";
import { RECORDER_CONFIG_SCHEMA } from "./config.mjs";
import { feasibilityTableRows } from "./feasibility.mjs";
import { API_FIELDS, FIELD_KEYS } from "./snapshot.mjs";
import { decodeCursor } from "./store.mjs";

const UNDERLYING_RE = /^[A-Z0-9&-]{1,30}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVERY = Object.freeze([1, 3, 5, 15, 30, 60]);
const MAX_RANGE_MS = 31 * 86_400_000;
const MAX_DAILY_DAYS = 3 * 366;
export const DEFAULT_FIELDS = Object.freeze(["ltp", "oi", "volume", "iv"]);
export const UNITS = Object.freeze({ oi: "units", volume: "units", iv: "percent", price: "INR", age: "ms" });
export const METHOD = Object.freeze({
  forward: "Median over the 5 strikes nearest spot with two-sided quotes of K + e^(rT)(C_mid − P_mid).",
  iv: "Black-76 on the forward from the mid (last price when one side is missing), dashboard/pricing.js, model b76-vt1.",
  t: "Vol-time clock (P1-3; weighted by default). tcal is calendar time, used for discounting.",
  rate: "reference.rate() (P1-2), with its source and age.",
  coverage: "Over recorded strikes only (±40 for indices by default). Gaps are never filled.",
});
const KEY_TO_FIELD = Object.freeze(Object.fromEntries(Object.entries(FIELD_KEYS).map(([f, k]) => [k, f])));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });
const q = (p, k) => {
  const v = typeof p?.get === "function" ? p.get(k) : p?.[k];
  return v === null || v === undefined || v === "" ? undefined : v;
};

/** "3 Nov" for 2026-11-03. */
export const shortDate = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

function underlyingOf(v) {
  if (v === undefined) throw invalid("underlying", "underlying is required, for example NIFTY.");
  const u = String(v).trim().toUpperCase();
  if (!UNDERLYING_RE.test(u)) throw invalid("underlying", "underlying must be 1-30 letters, digits, & or -.");
  return u;
}
function dateOf(v, path, required = false) {
  if (v === undefined) {
    if (required) throw invalid(path, `${path} is required, as YYYY-MM-DD.`);
    return undefined;
  }
  const s = String(v);
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!DATE_RE.test(s) || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) throw invalid(path, `${path} must be a real date, YYYY-MM-DD.`);
  return s;
}
function intOf(v, path, allowed) {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN;
  const ok = Array.isArray(allowed) ? allowed.includes(n) : Number.isInteger(n) && n >= allowed.min && n <= allowed.max;
  if (!ok) throw invalid(path, Array.isArray(allowed) ? `${path} must be one of ${allowed.join(", ")}.` : `${path} must be a whole number from ${allowed.min} to ${allowed.max}.`);
  return n;
}
function boolOf(v, path) {
  if (v === undefined) return false;
  if (v === true || v === "true" || v === "1") return true;
  if (v === false || v === "false" || v === "0") return false;
  throw invalid(path, `${path} must be true or false.`);
}
function fieldsOf(v, dflt = DEFAULT_FIELDS) {
  if (v === undefined) return [...dflt];
  const list = String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.filter((f) => !API_FIELDS.includes(f));
  if (!list.length || bad.length) throw invalid("fields", `Unknown field${bad.length === 1 ? "" : "s"} ${bad.join(", ") || "(none)"}. Use any of ${API_FIELDS.join(", ")}.`);
  return [...new Set(list)];
}
function formatOf(v) {
  if (v === undefined) return "json";
  if (v !== "json" && v !== "csv") throw invalid("format", "format must be json or csv.");
  return v;
}

/** May this caller see an account id? */
export function canSeeAccount(ctx, id) {
  if (!id) return true;
  if (!ctx || ctx.principal?.kind === "local") return true;
  try {
    ctx.requireAccountAccess(id);
    return true;
  } catch {
    return false;
  }
}

/** One stored snapshot in the API shape (§4.1), account ids redacted for restricted keys. */
export function toApiSnapshot(s, ctx) {
  const side = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [KEY_TO_FIELD[k] ?? k, v]));
  const see = canSeeAccount(ctx, s.accountId);
  return {
    slot: toIstIso(s.slot),
    ts: toIstIso(s.ts),
    source: s.source,
    accountId: see ? (s.accountId ?? null) : null,
    broker: see ? (s.broker ?? null) : null,
    accounts: see ? (s.accounts ?? null) : null,
    quality: s.quality,
    partial: Boolean(s.partial),
    missingLegs: s.missingLegs ?? 0,
    oiUnitVerified: Boolean(s.oiUnitVerified),
    lotSize: s.lot ?? null,
    spot: s.spot ?? null,
    forward: s.fwd ?? null,
    atm: s.atm ?? null,
    straddle: s.straddle ?? null,
    rate: s.rate ?? null,
    t: s.t ?? null,
    model: s.model,
    strikes: s.k,
    ce: side(s.ce),
    pe: side(s.pe),
  };
}

/** Minutes after IST midnight of a session open "HH:MM" (the reference default window when missing or bad). */
function openMinutes(open) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(open ?? "")) ?? /^(\d{2}):(\d{2})$/.exec(defaultSessionFor("NFO").open);
  return Number(m[1]) * 60 + Number(m[2]);
}

const isoOrNull = (ms) => (ms === null || ms === undefined ? null : toIstIso(ms));

/**
 * Parse the §4.1 query (URLSearchParams or a plain object) into a service query.
 * @param {any} params
 * @param {{ now: number, defaults?: { fields?: string[], strikes?: number, every?: number }, sessionOpen?: string | null }} env
 *   sessionOpen: today's session open "HH:MM" IST from the reference store (the default `from`); the S5 default
 *   window when absent.
 */
export function parseSnapshotQuery(params, { now, defaults = {}, sessionOpen = null }) {
  const underlying = underlyingOf(q(params, "underlying"));
  const expiry = dateOf(q(params, "expiry"), "expiry", true);
  const fromRaw = q(params, "from");
  const toRaw = q(params, "to");
  const today = istDateOf(now);
  const toMs = toRaw === undefined ? now : parseTimeInput(toRaw, { endOfDay: true, field: "to" });
  // The default `from` is today's session open; before it (an early script, the demo's always-open night) it is the
  // start of today, so a default read never answers "to before from".
  const open = istMidnight(today) + openMinutes(sessionOpen) * 60_000;
  const fromMs = fromRaw === undefined ? (open <= toMs ? open : Math.min(istMidnight(today), toMs)) : parseTimeInput(fromRaw, { field: "from" });
  if (toMs < fromMs) throw invalid("to", "to must not be before from.");
  if (toMs - fromMs > MAX_RANGE_MS) throw invalid("to", "The range is at most 31 days per call; page within it with cursor.");
  const fields = fieldsOf(q(params, "fields"), defaults.fields ?? DEFAULT_FIELDS);
  const strikes = intOf(q(params, "strikes"), "strikes", { min: 1, max: 60 }) ?? defaults.strikes ?? null;
  const every = intOf(q(params, "every"), "every", EVERY) ?? defaults.every ?? 1;
  const includeSuspect = boolOf(q(params, "includeSuspect"), "includeSuspect");
  const limit = intOf(q(params, "limit"), "limit", { min: 1, max: 500 }) ?? 400;
  const cursorRaw = q(params, "cursor");
  let cursor = null;
  if (cursorRaw !== undefined) {
    if (String(cursorRaw).length > 200) throw invalid("cursor", "cursor is not valid; use nextCursor from the previous page.");
    cursor = decodeCursor(cursorRaw);
    if (!cursor || cursor.u !== underlying || cursor.x !== expiry) throw invalid("cursor", "cursor is not valid; use nextCursor from the previous page.");
  }
  return { underlying, expiry, fromMs, toMs, fields, strikes, every, includeSuspect, limit, cursor, format: formatOf(q(params, "format")) };
}

/**
 * Read snapshots and shape the §4.1 page (shared by REST and MCP). Gaps come merged into ranges.
 * @param {object} recorder  the recorder service
 * @param {ReturnType<typeof parseSnapshotQuery>} query
 * @param {any} ctx  request context (account redaction)
 */
export async function readSnapshots(recorder, query, ctx) {
  const r = await recorder.snapshots(query);
  return {
    underlying: r.underlying,
    expiry: r.expiry,
    exchange: r.exchange,
    units: UNITS,
    fields: query.fields,
    snapshots: r.snapshots.map((s) => toApiSnapshot(s, ctx)),
    gaps: r.gaps.map((g) => ({ from: toIstIso(g.from), to: toIstIso(g.to), slots: g.slots, reason: g.reason, detail: g.detail })),
    coverage: { ...r.coverage, firstSlot: isoOrNull(r.coverage.firstSlot), lastSlot: isoOrNull(r.coverage.lastSlot) },
    unavailable: r.unavailable,
    method: METHOD,
    nextCursor: r.nextCursor,
  };
}

/** The §4.1 CSV: one row per (slot, strike, right); gaps as rows with right=GAP and the reason last. */
export function snapshotsCsv(page) {
  const head = ["slot", "ts", "source", "quality", "spot", "forward", "strike", "right", ...page.fields];
  const rows = [head];
  for (const s of page.snapshots) {
    s.strikes.forEach((k, i) => {
      for (const [right, side] of [
        ["CE", s.ce],
        ["PE", s.pe],
      ]) {
        rows.push([s.slot, s.ts, s.source, s.quality, s.spot, s.forward, k, right, ...page.fields.map((f) => side?.[f]?.[i] ?? null)]);
      }
    });
  }
  for (const g of page.gaps) {
    const blanks = page.fields.map(() => null);
    blanks[blanks.length - 1] = g.reason;
    rows.push([g.from, null, null, null, null, null, null, "GAP", ...blanks]);
  }
  return rows;
}

/** One S3 row with full names and IST times (§4.3). */
export function toApiDaily(r) {
  return {
    date: r.date,
    underlying: r.u,
    expiry: r.x,
    asOf: isoOrNull(r.asOfSlot),
    source: r.source,
    quality: r.quality,
    spot: r.spot ?? null,
    forward: r.fwd ?? null,
    atm: r.atm ?? null,
    straddle: r.straddle ?? null,
    pcrOi: r.pcrOi ?? null,
    pcrVolume: r.pcrVol ?? null,
    maxPain: r.maxPain ?? null,
    strikesCovered: r.strikesCovered ?? 0,
    largestCallOi: r.largestCallOi ? { strike: r.largestCallOi.k, oi: r.largestCallOi.oi } : null,
    largestPutOi: r.largestPutOi ? { strike: r.largestPutOi.k, oi: r.largestPutOi.oi } : null,
    ceOi: r.ceOi ?? null,
    peOi: r.peOi ?? null,
    topAdds: (r.topAdds ?? []).map((c) => ({ strike: c.k, right: c.r, dOi: c.dOi })),
    topCuts: (r.topCuts ?? []).map((c) => ({ strike: c.k, right: c.r, dOi: c.dOi })),
    dOiBasis: r.dOiBasis ?? "none",
    future: r.fut ? { expiry: r.fut.x, ltp: r.fut.ltp, oi: r.fut.oi, basis: r.fut.basis, basisAnnPct: r.fut.basisAnnPct, rolloverPct: r.fut.rolloverPct } : null,
    slots: r.slots ?? 0,
    gapSlots: r.gapSlots ?? 0,
    partialSlots: r.partialSlots ?? 0,
    gex: null,
    zeroGamma: null,
  };
}

const DAILY_CSV = ["date", "underlying", "expiry", "asOf", "quality", "spot", "forward", "atm", "straddle", "pcrOi", "pcrVolume", "maxPain", "largestCallOiStrike", "largestCallOi", "largestPutOiStrike", "largestPutOi", "ceOi", "peOi", "futureExpiry", "futureLtp", "basis", "basisAnnPct", "rolloverPct", "slots", "gapSlots", "partialSlots"];

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replace every id (and the broker name) in every string of a JSON value. */
function scrubStrings(value, pairs) {
  if (typeof value === "string") return pairs.reduce((s, [re, to]) => s.replace(re, to), value);
  if (Array.isArray(value)) return value.map((v) => scrubStrings(v, pairs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubStrings(v, pairs)]));
  return value;
}

/**
 * The status with account ids and the broker redacted for restricted keys (§4): a key limited to other accounts sees
 * no id of the recorder's accounts anywhere (account, feed, settings, warnings, gap details) and no broker name.
 */
export function redactStatus(st, ctx) {
  if (!st) return st;
  const ids = [...new Set([st.account?.id, st.account?.feedAccount, st.settings?.account].filter(Boolean))];
  const hidden = ids.filter((id) => !canSeeAccount(ctx, id));
  if (!hidden.length) return st;
  const dataHidden = !st.account?.id || hidden.includes(st.account.id);
  const broker = dataHidden ? (st.account?.broker ?? st.oiUnits?.broker ?? null) : null;
  const pairs = hidden.sort((a, b) => b.length - a.length).map((id) => [new RegExp(escapeRe(id), "g"), "(hidden account)"]);
  if (broker && broker !== "demo") pairs.push([new RegExp(`\\b${escapeRe(broker)}\\b`, "gi"), "the broker"]);
  const out = scrubStrings(st, pairs);
  if (out.account) {
    out.account = { ...out.account, feedAccount: hidden.includes(st.account.feedAccount) ? null : out.account.feedAccount };
    if (dataHidden) out.account = { ...out.account, id: null, broker: null, costNote: "Recording uses your broker's market-data APIs; some brokers charge for them (needs verification)." };
  }
  if (out.oiUnits && dataHidden) out.oiUnits = { ...out.oiUnits, broker: null };
  if (out.settings && hidden.includes(st.settings?.account)) out.settings = { ...out.settings, account: null };
  return out;
}

/** The accounts a dry-run plan names (recorderService.mjs PLAN_ACCOUNTS; Symbol.for keeps this file import-free). */
const PLAN_ACCOUNTS = Symbol.for("mcb.recorder.planAccounts");

/**
 * A dry-run plan with account ids and the broker redacted for restricted keys (§4, §9), like redactStatus: the plan's
 * warnings name the data and feed accounts ("The live feed runs on …").
 */
export function redactPlan(out, ctx) {
  const acc = out?.[PLAN_ACCOUNTS];
  if (!acc) return out;
  const ids = [...new Set([acc.id, acc.feedAccountId, acc.configured].filter(Boolean))];
  const hidden = ids.filter((id) => !canSeeAccount(ctx, id));
  if (!hidden.length) return out;
  const pairs = hidden.sort((a, b) => b.length - a.length).map((id) => [new RegExp(escapeRe(id), "g"), "(hidden account)"]);
  const broker = !acc.id || hidden.includes(acc.id) ? acc.broker : null;
  if (broker && broker !== "demo") pairs.push([new RegExp(`\\b${escapeRe(broker)}\\b`, "gi"), "the broker"]);
  return scrubStrings(out, pairs);
}

/**
 * @param {object} recorder  deps.recorder
 * @param {{ clock: { now(): number }, paths?: { configFile: string | null }, config: object }} deps
 */
/** Today's session open from the reference store (null when it has none: a holiday, no data). */
function sessionOpenOf(reference, t) {
  try {
    const s = reference?.session?.("NFO", t);
    return s?.special?.open ?? s?.open ?? null;
  } catch {
    return null;
  }
}

export function createRecorderRoutes(recorder, deps) {
  const now = () => deps.clock.now();
  const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });
  return {
    async snapshots(ctx) {
      const query = parseSnapshotQuery(ctx.query, { now: now(), sessionOpen: sessionOpenOf(deps.reference, now()) });
      const page = await readSnapshots(recorder, query, ctx);
      if (query.format === "csv") {
        const headers = page.nextCursor ? { "X-MCB-Next-Cursor": page.nextCursor } : {};
        return csv(snapshotsCsv(page), { headers, filename: `${page.underlying}_${page.expiry}_snapshots.csv` });
      }
      return { data: page, meta: meta(ctx, { accountId: null }) };
    },

    async latest(ctx) {
      const underlying = underlyingOf(q(ctx.query, "underlying"));
      const expiry = dateOf(q(ctx.query, "expiry"), "expiry", true);
      const fields = fieldsOf(q(ctx.query, "fields"));
      const strikes = intOf(q(ctx.query, "strikes"), "strikes", { min: 1, max: 60 }) ?? null;
      const s = await recorder.latest({ underlying, expiry, fields, strikes });
      if (!s) throw new BridgeError("NOT_FOUND", `No snapshot has been recorded today for ${underlying} ${shortDate(expiry)}.`);
      return { data: { underlying, expiry, exchange: s.ex ?? null, units: UNITS, fields, snapshot: toApiSnapshot(s, ctx) }, meta: meta(ctx) };
    },

    async daily(ctx) {
      const underlying = underlyingOf(q(ctx.query, "underlying"));
      const expiry = dateOf(q(ctx.query, "expiry"), "expiry");
      const today = istDateOf(now());
      const to = dateOf(q(ctx.query, "to"), "to") ?? today;
      const from = dateOf(q(ctx.query, "from"), "from") ?? istDateOf(Date.parse(`${to}T12:00:00Z`) - 30 * 86_400_000);
      if (from > to) throw invalid("from", "from must not be after to.");
      if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 > MAX_DAILY_DAYS) throw invalid("to", "The range is at most 3 years.");
      const format = formatOf(q(ctx.query, "format"));
      const rows = (await recorder.daily({ underlying, from, to, expiry: expiry ?? null })).map(toApiDaily);
      if (format === "csv") {
        const out = [DAILY_CSV];
        for (const r of rows) out.push([r.date, r.underlying, r.expiry, r.asOf, r.quality, r.spot, r.forward, r.atm, r.straddle, r.pcrOi, r.pcrVolume, r.maxPain, r.largestCallOi?.strike, r.largestCallOi?.oi, r.largestPutOi?.strike, r.largestPutOi?.oi, r.ceOi, r.peOi, r.future?.expiry, r.future?.ltp, r.future?.basis, r.future?.basisAnnPct, r.future?.rolloverPct, r.slots, r.gapSlots, r.partialSlots]);
        return csv(out, { filename: `${underlying}_daily.csv` });
      }
      return { data: { underlying, rows }, meta: meta(ctx) };
    },

    async status(ctx) {
      // ?feasibility=true adds "which brokers can record what" (the Data recorder page asks once, not on every poll).
      const withTable = boolOf(q(ctx.query, "feasibility"), "feasibility");
      const data = redactStatus(recorder.status(), ctx);
      return { data: withTable ? { ...data, feasibility: feasibilityTableRows() } : data, meta: meta(ctx) };
    },

    async plan(ctx) {
      const body = ctx.body ?? {};
      if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("(body)", "Send the recorder settings to check as a JSON object.");
      // A key limited to other accounts cannot dry-run (probe) an account it may not use: 403 ACCOUNT_FORBIDDEN.
      if (typeof body.account === "string" && body.account && ctx?.principal?.kind !== "local") ctx.requireAccountAccess(body.account);
      return { data: redactPlan(await recorder.plan(body), ctx), meta: meta(ctx) };
    },

    async setConfig(ctx) {
      const body = ctx.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("(body)", "Send the recorder settings as a JSON object.");
      const { acknowledgeNseTerms, ...section } = body;
      const file = deps.paths?.configFile ?? null;
      const save = file && !deps.config.demo ? (value) => setConfigSection(file, "recorder", value, { schema: RECORDER_CONFIG_SCHEMA }) : null;
      const out = await recorder.configure(section, { acknowledgeNseTerms: acknowledgeNseTerms === true, save });
      return { data: { persisted: out.persisted, status: redactStatus(out.status, ctx) }, meta: meta(ctx, out.persisted ? {} : { note: deps.config.demo ? "Demo mode: the change applies until the Bridge stops; the config file is not edited." : "No config file to save to: the change applies until the Bridge stops." }) };
    },
  };
}
