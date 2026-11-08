// Trading readiness on the dashboard: the client side of /v1/readiness. One badge in the toolbar of every page, its
// popover (a bottom sheet on phones), the readiness checklist, timeline and demo tools of the Safety page, and the
// kill-switch sheets (stop all orders, release).
//
// The view-model (badgeModel, rowsModel, scheduleLine, egressModel ...) is pure and exported for
// readiness.test.mjs; DOM code runs only in a browser. Numbers become text through format.js only. Copy is descriptive:
// what was checked and where the fact came from, never advice. Every reading is local: the badge polls
// GET /v1/readiness, which answers from the monitor's cache and never calls a broker.
import { api, app, codeBlock, h, icon, modal, alertBox, pill, sheetPopover, toast } from "./app.js";
import { DASH, formatInt, formatRupeeGrouped, isFigure } from "./format.js";

/** How often the badge reads /v1/readiness while the tab is visible. */
export const POLL_MS = 30_000;
/** Where the guides live (the dashboard does not serve docs). */
export const GUIDE_URL = "https://github.com/MrChartist/api-bridge-v2/blob/main/docs/guides/";

const IST_OFFSET_MS = 330 * 60_000;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const parse = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};
const pad2 = (n) => String(n).padStart(2, "0");

/** "10:12" (IST, 24 h) from an ISO time; "--" when missing. Pure. */
export function istHm(iso) {
  const t = parse(iso);
  if (t === null) return DASH;
  const d = new Date(t + IST_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
/** The IST calendar day ("2026-10-29") of a time in ms. */
const istDay = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** "10:12", "06:00 tomorrow" or "06:00 on 31 Oct", relative to `now` (IST days). Pure. */
export function istWhen(iso, now = Date.now()) {
  const t = parse(iso);
  if (t === null) return DASH;
  const day = istDay(t);
  if (day === istDay(now)) return istHm(iso);
  if (day === istDay(now + 86_400_000)) return `${istHm(iso)} tomorrow`;
  if (day === istDay(now - 86_400_000)) return `${istHm(iso)} yesterday`;
  const [, m, d] = day.split("-").map(Number);
  return `${istHm(iso)} on ${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]}`;
}

// ── Words ──

/** The state in words, and the pill tone it takes (never colour only: the word is always there). */
export const STATE_TEXT = Object.freeze({ ready: "Ready", warn: "Check", cannot_trade: "Cannot trade", paper_only: "Paper only", unknown: "Not checked" });
export const STATE_TONE = Object.freeze({ ready: "ok", warn: "warn", cannot_trade: "bad", paper_only: "", unknown: "" });
/** A check's status as a pill: pass, warn, fail, unknown, n/a. */
export const CHECK_TEXT = Object.freeze({ pass: "OK", warn: "Check", fail: "Failing", unknown: "Not checked", "n/a": "Off" });
export const CHECK_TONE = Object.freeze({ pass: "ok", warn: "warn", fail: "bad", unknown: "", "n/a": "" });

/** Short words per reason code, for the badge ("Check: session ends soon") and the history lines. */
export const REASON_SHORT = Object.freeze({
  LIVE_OFF: "live trading off",
  SESSION_EXPIRED: "session expired",
  SESSION_MISSING: "not logged in",
  SESSION_ERROR: "session error",
  SESSION_REJECTED: "session refused",
  SESSION_EXPIRES_SOON: "session ends soon",
  PROBE_FAILED: "read call failed",
  NO_STATED_EXPIRY: "no stated expiry",
  IP_MISMATCH: "IP mismatch",
  IP_NOT_REGISTERED: "IP not registered",
  IP_INVALID_CONFIG: "IP setting invalid",
  IP_FAMILY_DIFFERS: "IP family differs",
  IP_UNCHECKED: "IP not checked",
  IP_LOOKUP_FAILED: "IP lookup failed",
  CLOCK_SKEW: "clock is off",
  RATE_CAP_REACHED: "order rate cap in use",
  BROKER_ORDER_BACKOFF: "broker slowed orders",
  DAILY_ORDERS_LOW: "few orders left",
  DAILY_ORDERS_EXHAUSTED: "order limit used up",
  DAILY_LOSS_NEAR: "daily loss near",
  DAILY_LOSS_REACHED: "daily loss reached",
  KILL_SWITCH: "kill switch on",
  STALE: "not checked recently",
});
export const reasonShort = (code) => REASON_SHORT[code] ?? String(code ?? "").toLowerCase().replace(/_/g, " ");

const plural = (n, one, many = `${one}s`) => `${formatInt(n)} ${n === 1 ? one : many}`;
const accountName = (a) => a?.label || a?.accountId || "this account";
const visibleLive = (snap) => (snap?.accounts ?? []).filter((a) => a?.live?.allowedByConfig);

// ── Badge ──

/**
 * The toolbar badge. Pure.
 * @param {object | null} snapshot GET /v1/readiness data (or null before the first answer)
 * @param {{ demo?: boolean, now?: number, failedAt?: number | null }} opts failedAt: the last read failed; the badge
 *   keeps the last state and says when it was checked.
 * @returns {{ cls: "ok"|"warn"|"bad"|"", dot: "ok"|"warn"|"bad"|"none", text: string, short: string, aria: string, title: string, state: string }}
 */
export function badgeModel(snapshot, { demo = false, now = Date.now(), failedAt = null } = {}) {
  const out = (state, cls, text, short) => {
    const dot = cls || "none";
    let full = text;
    if (failedAt && snapshot) full = `${text} (last checked ${istHm(snapshot.checkedAt)})`;
    const sim = demo || (snapshot?.accounts ?? []).some((a) => a.simulated) ? " (simulated)" : "";
    const aria = `Trading readiness: ${full}${sim}`;
    return { state, cls, dot, text: failedAt && snapshot ? full : text, short, aria, title: aria };
  };
  if (!snapshot) return out("unknown", "", "Checking…", "Checking…");
  if (snapshot.disabled) return out("unknown", "", "Readiness off", "Off");
  const overall = snapshot.overall ?? "unknown";
  const live = visibleLive(snapshot);
  if (overall === "ready") return out("ready", "ok", "Ready", "Ready");
  if (overall === "paper_only" || snapshot.paperOnly) return out("paper_only", "", "Paper only", "Paper only");
  if (overall === "cannot_trade") {
    const bad = live.filter((a) => a.state === "cannot_trade");
    const who = bad.length >= 2 ? plural(bad.length, "account") : bad[0]?.brokerName || accountName(bad[0]);
    // One account: name what blocks it in a few words ("Cannot trade: Demo · order limit used up"); the sheet has the rest.
    const why = bad.length === 1 ? ((bad[0].reasons ?? []).find((r) => r.severity === "fail") ?? (bad[0].reasons ?? [])[0]) : null;
    return out("cannot_trade", "bad", `Cannot trade: ${who}${why ? ` · ${reasonShort(why.code)}` : ""}`, "Cannot trade");
  }
  if (overall === "warn") {
    const first = live.flatMap((a) => (a.state === "warn" ? a.reasons ?? [] : []))[0] ?? live.flatMap((a) => a.reasons ?? [])[0];
    return out("warn", "warn", first ? `Check: ${reasonShort(first.code)}` : "Check", "Check");
  }
  // unknown: still checking, or every reading is stale.
  const stale = live.length > 0 && live.every((a) => a.stale);
  const last = live.map((a) => parse(a.checkedAt)).filter(finite).sort((x, y) => y - x)[0];
  if (stale && last) return out("unknown", "", `Not checked since ${istHm(new Date(last).toISOString())}`, "Not checked");
  return out("unknown", "", stale ? "Not checked" : "Checking…", stale ? "Not checked" : "Checking…");
}

// ── Account rows ──

/** "Until 06:00 tomorrow (broker's stated time) · read call OK at 10:12". Pure. */
export function sessionFact(s, now = Date.now()) {
  if (!s) return DASH;
  const probe = { ok: "read call OK", rejected: "read call refused", error: "read call failed" }[s.probe];
  const probeText = probe ? `${probe} at ${istHm(s.probedAt)}` : s.probe === "off" ? "read calls off" : "no read call yet";
  if (s.status === "fail") return s.message ?? "Session not usable";
  if (s.state && s.state !== "connected") return s.message ?? "Still checking";
  if (s.expiresAt) {
    const src = s.expirySource === "simulated" ? "simulated" : "broker's stated time";
    return `Until ${istWhen(s.expiresAt, now)} (${src}) · ${probeText}`;
  }
  return `No stated expiry · ${probeText}`;
}

/** The IP fact and, for callers that may see addresses, the "198.51.100.23 vs 203.0.113.10" line. Pure. */
export function egressFact(e, { canSeeIp = false } = {}) {
  if (!e) return { text: DASH, detail: null };
  let text;
  if (e.mode === "off") text = "Not checked: lookup is off";
  else if (e.registered === "not-set" && e.backup === "not-set") text = "Registered IP not set";
  else if (e.registered === "invalid" || e.backup === "invalid") text = "Registered IP setting is not a valid address";
  else if (e.matches === true) text = e.mode === "manual" ? "Matches registered IP (as entered)" : "Matches registered IP";
  else if (e.matches === false) text = e.mode === "manual" ? "Does not match registered IP (as entered)" : `Does not match registered IP${e.mode === "lookup" && e.seenBy ? ` (as seen by ${e.seenBy})` : ""}`;
  else text = e.message ?? "Not checked yet";
  const vs = canSeeIp && e.detectedIp && (e.registeredIp || e.backupIp) ? `${e.detectedIp} vs ${[e.registeredIp, e.backupIp].filter(Boolean).join(" or ")}` : null;
  // A mismatch already names the service in its text; a match names it here, with the time of the lookup.
  const seen = e.mode === "lookup" && e.seenBy && e.matches === true ? `as seen by ${e.seenBy}${e.detectedAt ? ` at ${istHm(e.detectedAt)}` : ""}` : null;
  return { text, detail: [vs, seen].filter(Boolean).join(" · ") || null };
}

/** "5/s cap, 0 used · 63 of 100 orders left". Pure. */
export function ordersFact(rate, daily) {
  const parts = [];
  if (rate && isFigure(rate.perSecond)) parts.push(`${formatInt(rate.perSecond)}/s cap, ${formatInt(rate.usedLastSecond ?? 0)} used`);
  if (daily && isFigure(daily.limit)) parts.push(`${formatInt(daily.left)} of ${formatInt(daily.limit)} orders left`);
  return parts.join(" · ") || DASH;
}

/** "₹1750 of ₹10000 daily loss left", printed with Indian grouping (formatRupeeGrouped) like the Bridge's own reason and notification text beside it. Pure. */
export const lossFact = (loss) => (loss && isFigure(loss.limit) ? `${formatRupeeGrouped(loss.left)} of ${formatRupeeGrouped(loss.limit)} daily loss left` : DASH);

/** "Off" or "On since 10:02 (reason)". Pure. */
export const killFact = (k) => (!k ? DASH : k.engaged ? `On since ${istHm(k.at)}${k.reason ? ` (${k.reason})` : ""}` : "Off");

/** "1 live automation cannot trade: ChartInk breakout" (names joined with "; ": labels can hold commas), "2 live automations, all ready", "None". Pure. */
export function automationsFact(list) {
  const live = (list ?? []).filter((x) => x.mode === "live");
  if (!(list ?? []).length) return "None";
  if (!live.length) return `${plural(list.length, "paper automation")}`;
  const blocked = live.filter((x) => x.state === "cannot_trade");
  if (blocked.length) return `${plural(blocked.length, "live automation")} cannot trade: ${blocked.map((x) => x.label).join("; ")}`;
  const phrase = { ready: "ready", warn: "to check", unknown: "not checked" };
  if (live.length === 1) return `1 live automation, ${phrase[live[0].state] ?? "not checked"}`;
  const same = live.every((x) => x.state === live[0].state);
  return `${plural(live.length, "live automation")}, ${same ? `all ${phrase[live[0].state] ?? "not checked"}` : `${formatInt(live.filter((x) => x.state === "ready").length)} ready`}`;
}

/** The table's short form: { text: "2 live · cannot trade", detail: "Sample guard …, Sample webhook …" }. Pure. */
export function automationsShort(list) {
  const all = list ?? [];
  const live = all.filter((x) => x.mode === "live");
  if (!all.length) return { text: "None", detail: null };
  if (!live.length) return { text: `${formatInt(all.length)} paper`, detail: null };
  const blocked = live.filter((x) => x.state === "cannot_trade");
  return { text: `${formatInt(live.length)} live · ${blocked.length ? (blocked.length === live.length ? "cannot trade" : `${formatInt(blocked.length)} cannot trade`) : live.every((x) => x.state === "ready") ? "ready" : "to check"}`, detail: (blocked.length ? blocked : live).map((x) => x.label).join("; ") || null };
}

/**
 * One row per account for the popover, the phone and tablet cards and the desktop table. Pure.
 * @returns {Array<{ id, title, sub, simulated, state: { key, text, tone }, reasons: string[], more: number,
 *   facts: Array<{ key, label, status, statusText, tone, text, detail, source }> , automations: object[] }>}
 */
export function rowsModel(snapshot, { canSeeIp = false, now = Date.now() } = {}) {
  return (snapshot?.accounts ?? []).map((a) => {
    const c = a.checks ?? {};
    const eg = egressFact(c.egress, { canSeeIp });
    const st = a.state ?? "unknown";
    const fact = (key, label, check, text, detail = null) => {
      const status = check?.status ?? "unknown";
      return { key, label, status, statusText: CHECK_TEXT[status] ?? "Unknown", tone: CHECK_TONE[status] ?? "", text, detail, source: check?.source ?? null };
    };
    const orderStatus = worst([c.orderRate?.status, c.dailyOrders?.status]);
    const reasons = (a.reasons ?? []).map((r) => r.message).filter(Boolean);
    return {
      id: a.accountId,
      title: accountName(a),
      sub: [a.brokerName || a.broker, a.accountId].filter(Boolean).join(" · "),
      simulated: Boolean(a.simulated),
      state: { key: st, text: a.stale && st === "unknown" ? `Not checked since ${istHm(a.checkedAt)}` : STATE_TEXT[st] ?? "Not checked", tone: STATE_TONE[st] ?? "" },
      reasons: reasons.slice(0, 3),
      codes: (a.reasons ?? []).map((r) => r.code).filter(Boolean),
      more: Math.max(0, reasons.length - 3),
      facts: [
        fact("session", "Session", c.session, sessionFact(c.session, now)),
        fact("egress", "Static IP", c.egress, eg.text, eg.detail),
        { ...fact("orders", "Order headroom", { status: orderStatus, source: c.dailyOrders?.source ?? c.orderRate?.source }, ordersFact(c.orderRate, c.dailyOrders)) },
        fact("loss", "Daily loss", c.dailyLoss, lossFact(c.dailyLoss)),
        fact("kill", "Kill switch", c.killSwitch, killFact(c.killSwitch)),
        automationFact(a.automations),
      ],
      automations: a.automations ?? [],
    };
  });
}
/** The Automations row: fails when a live automation cannot trade; "Off" when there are none. */
function automationFact(list) {
  const all = list ?? [];
  const status = !all.length ? "n/a" : all.some((x) => x.mode === "live" && x.state === "cannot_trade") ? "fail" : all.some((x) => x.mode === "live" && x.state !== "ready") ? "warn" : "pass";
  return { key: "automations", label: "Automations", status, statusText: CHECK_TEXT[status], tone: CHECK_TONE[status], text: automationsFact(all), detail: null, source: null };
}
const RANK = { fail: 4, unknown: 3, warn: 2, pass: 1, "n/a": 0 };
function worst(list) {
  return list.filter(Boolean).sort((x, y) => (RANK[y] ?? 0) - (RANK[x] ?? 0))[0] ?? "unknown";
}

/** "Checked 10:12 · next 10:16 · pre-open 09:00 (ran today)". Pure. */
export function scheduleLine(snapshot, now = Date.now()) {
  if (!snapshot) return "";
  const s = snapshot.schedule ?? {};
  const parts = [`Checked ${istHm(snapshot.checkedAt)}`];
  if (s.nextCheckAt) parts.push(`next ${istHm(s.nextCheckAt)}`);
  if (s.demo) parts.push(`every ${plural(s.intervalMinutes ?? 1, "minute")} (demo: any hour)`);
  else {
    const pre = s.preOpen ?? {};
    if (pre.at) parts.push(`pre-open ${pre.at}${pre.lastRunDate && pre.lastRunDate === istDay(now) ? " (ran today)" : pre.nextRunAt ? ` (next ${istWhen(pre.nextRunAt, now)})` : ""}`);
    if (s.tradingDay === false) parts.push("not a trading day");
    else if (s.inWindow === false && s.window) parts.push(`checks run ${s.window.from}–${s.window.to} IST`);
  }
  return parts.join(" · ");
}

/** { time: "10:12", text: "Main: ready → cannot trade (IP mismatch)" }. Pure. */
export function historyParts(item, labels = {}) {
  const st = (s) => (STATE_TEXT[s] ?? String(s ?? "")).toLowerCase();
  const why = (item.codes ?? []).map(reasonShort).join(", ");
  return { time: istHm(item.at), text: `${labels[item.accountId] ?? item.accountId}: ${st(item.from)} → ${st(item.to)}${why ? ` (${why})` : ""}` };
}

/** The egress settings note and copyable config snippet. Pure. */
export function egressModel(snapshot) {
  const mode = snapshot?.egress?.mode ?? "off";
  const sim = Boolean(snapshot?.egress?.simulated);
  const note =
    mode === "off"
      ? "Lookup is off, so a changed internet address is found only when the broker refuses an order. Turning it on sends a request to a service you choose every 4 minutes during market hours; that service sees your IP address."
      : mode === "manual"
        ? "Manual: the Bridge compares the address you entered with the registered one. It cannot notice when your address changes."
        : `Lookup is on${sim ? " (simulated in the demo)" : ""}: every check asks the service you chose for this computer's address. That service sees your IP address, and its answer can differ from what your broker sees.`;
  const snippet = JSON.stringify({ readiness: { egressIp: { mode: "lookup", lookupUrl: "https://api.ipify.org", timeoutMs: 5000 } } }, null, 2);
  return { mode, modeText: { off: "Off", lookup: "Lookup", manual: "Manual (as entered)" }[mode] ?? mode, note, snippet };
}

/** The demo simulation buttons. */
export const DEMO_ACTIONS = Object.freeze([
  ["session-expired", "Expire session"],
  ["session-expiring", "Session ends soon"],
  ["ip-changed", "Change IP"],
  ["ip-unchecked", "Turn lookup off"],
  ["daily-loss-near", "Daily loss near"],
  ["daily-orders-exhausted", "Use up orders"],
  ["restore", "Restore"],
]);


// ── The Safety page's words and numbers (pure) ──

/** "just now", "42 seconds ago", "5 min ago", "3 h ago"; older than a day, the IST day and time. Pure. */
export function relAgo(iso, now = Date.now()) {
  const t = parse(iso);
  if (t === null) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.floor(m / 60);
  return hr < 24 ? `${hr} h ago` : istWhen(iso, now);
}

/** "Last checked 42 seconds ago · next check at 16:50". Pure. */
export function checkedLine(snapshot, now = Date.now()) {
  if (!snapshot) return "Not checked yet";
  const next = snapshot.schedule?.nextCheckAt;
  return [`Last checked ${relAgo(snapshot.checkedAt, now)}`, next ? `next check at ${istHm(next)}` : null].filter(Boolean).join(" · ");
}

/**
 * The Safety page's status hero. The kill switch decides first (paused), then the readiness of the live accounts
 * (blocked), then caution (allowed, with a note); everything else is allowed. Pure.
 * @returns {{ state: "allowed"|"paused"|"blocked", tone: "ok"|"warn"|"bad", icon: string, title: string, sub: string, reasons: string[] }}
 */
export function heroModel(safety, snapshot, { demo = false } = {}) {
  if (safety?.killSwitch?.engaged) {
    return { state: "paused", tone: "bad", icon: "stop", title: "Trading is paused", sub: "The kill switch is on. No new order is sent from any tool. Cancels still work.", reasons: [] };
  }
  const live = visibleLive(snapshot);
  const bad = live.filter((a) => a.state === "cannot_trade");
  if (snapshot?.overall === "cannot_trade" && bad.length) {
    const many = bad.length > 1;
    const reasons = bad.flatMap((a) => (a.reasons ?? []).filter((r) => r.severity === "fail" || bad.length === 1).map((r) => (many ? `${accountName(a)}: ${r.message}` : r.message))).filter(Boolean);
    return { state: "blocked", tone: "bad", icon: "warn", title: "Trading is blocked", sub: many ? `${plural(bad.length, "live account")} cannot send orders right now.` : `${accountName(bad[0])} cannot send live orders right now.`, reasons: reasons.slice(0, 3) };
  }
  const paperOnly = !safety?.liveTrading || demo;
  if (snapshot?.overall === "warn") {
    const first = live.flatMap((a) => (a.state === "warn" ? a.reasons ?? [] : []))[0];
    return { state: "allowed", tone: "warn", icon: "warn", title: "Trading is allowed", sub: first?.message ? `One check needs a look: ${first.message}` : "One check needs a look. See the checklist below.", reasons: [] };
  }
  return { state: "allowed", tone: "ok", icon: "check", title: "Trading is allowed", sub: demo ? "Demo mode: every order is a paper order." : paperOnly ? "New orders are accepted. Live trading is off, so every order is paper." : "New orders are accepted, paper and live.", reasons: [] };
}

/** How full a limit is: the percentage and the tone ("ok" under 70 %, "warn" from 70 %, "bad" from 90 %) with words for it. Pure. */
export function usageTone(used, limit) {
  if (!(limit > 0)) return { pct: 0, tone: "ok", word: "" };
  const f = Math.max(0, used) / limit;
  const pct = Math.min(100, Math.round(f * 100));
  if (f >= 1) return { pct, tone: "bad", word: "Limit reached" };
  if (f >= 0.9) return { pct, tone: "bad", word: "Almost at the limit" };
  if (f >= 0.7) return { pct, tone: "warn", word: "Getting close" };
  return { pct, tone: "ok", word: "" };
}

/**
 * One account's daily limits from GET /v1/safety: orders and loss with usage, and the per-order limits as facts. Paper
 * and live counts are added together (the Bridge keeps both). Rupee limits are whole rupees. Pure.
 */
export function limitsModel(a) {
  const l = a?.limits ?? {};
  const orders = (a?.ordersToday ?? 0) + (a?.paperOrdersToday ?? 0);
  const pnl = isFigure(a?.realisedPnlToday) || isFigure(a?.paperRealisedPnlToday) ? (a.realisedPnlToday ?? 0) + (a.paperRealisedPnlToday ?? 0) : null;
  const lost = Math.max(0, -(pnl ?? 0));
  return {
    orders: { used: orders, limit: l.dailyMaxOrders, text: `${formatInt(orders)} of ${formatInt(l.dailyMaxOrders)}`, ...usageTone(orders, l.dailyMaxOrders) },
    loss: { lost, limit: l.dailyMaxLoss, pnl, text: `${formatRupeeGrouped(lost, 0)} of ${formatRupeeGrouped(l.dailyMaxLoss, 0)}`, ...usageTone(lost, l.dailyMaxLoss) },
    facts: [
      ["Largest order", formatRupeeGrouped(l.maxOrderValue, 0)],
      ["Most lots in an order", formatInt(l.maxLotsPerOrder)],
      ["Orders per second", formatInt(l.orderRatePerSecond)],
      ["Market orders", l.marketOrders ? `${String(l.marketOrders)[0].toUpperCase()}${String(l.marketOrders).slice(1)}` : "Protect"],
    ],
  };
}

/** The five conditions of a live order, each "yes", "no" or "per order". Pure. */
export function liveConditions(safety) {
  const accounts = safety?.accounts ?? [];
  return [
    { text: "Live trading is on in bridge.config.json", detail: "safety.liveTrading is true", value: safety?.liveTrading ? "yes" : "no" },
    { text: "The account allows live orders from this source", detail: "live.enabled, and the request's source, per account", value: accounts.some((a) => a.liveAllowedByConfig) ? "yes" : "no" },
    { text: "The key has the live scope and the request says mode: live", detail: null, value: "per order" },
    { text: "A person confirmed it", detail: "For AI-prepared orders and confirmation webhooks", value: "per order" },
    { text: "Every safety check passes", detail: "Rate cap, daily limits and price band", value: "per order" },
  ];
}

/** One line of the Recent changes timeline: { time, title, note, tone }. Pure. */
export function timelineParts(item, labels = {}, now = Date.now()) {
  const st = (s) => STATE_TEXT[s] ?? String(s ?? "");
  const why = (item.codes ?? []).map(reasonShort).join(", ");
  return { time: istWhen(item.at, now), title: `${labels[item.accountId] ?? item.accountId} is now ${st(item.to).toLowerCase()}`, note: [`Was ${st(item.from).toLowerCase()}`, why].filter(Boolean).join(" · "), tone: STATE_TONE[item.to] ?? "" };
}

/** What each checklist row looks at, in plain words (shown when a row is opened). */
export const CHECK_COPY = Object.freeze({
  session: "A live order needs an open broker session. The Bridge reads the broker's stated expiry and, on trading days, makes a read call every few minutes to confirm the session still works.",
  egress: "Brokers accept live orders only from the static IP address you registered. The Bridge compares this computer's public address with it. A lookup service you choose sees that address.",
  orders: "How many orders can still go out: the per-second cap and the orders left today. These are the Bridge's own limits; the broker's and the exchange's counters are not visible.",
  loss: "When the day's realised loss reaches the limit, new orders are refused until the next trading day.",
  kill: "While the kill switch is on, no new order is sent from any tool. Cancels still work.",
  automations: "Live guards and webhooks that can place orders. They cannot trade while their account is not ready.",
});

/** The check-state icon names (the glyph is never the only carrier: the word sits beside it). */
export const CHECK_GLYPH = Object.freeze({ pass: "check", warn: "warn", fail: "close", unknown: "clock", "n/a": "more" });

/** The "How this is checked" text split into { name, text } pairs ("Session: …. Egress IP: …."). Pure. */
export function methodParts(method) {
  return String(method ?? "")
    .split(/(?<=\.)\s+(?=[A-Z][A-Za-z ]{2,24}:)/)
    .map((s) => {
      const i = s.indexOf(": ");
      return i > 0 && i < 26 ? { name: s.slice(0, i), text: s.slice(i + 2) } : { name: "", text: s };
    })
    .filter((p) => p.text);
}

// ── DOM (browser only) ──

const state = { snap: null, failedAt: null, timer: 0, mounted: false, stopped: false, tick: null, listeners: new Set(), open: new Set() };
/** Called with every new snapshot (the Safety page redraws from it). Returns an unsubscribe. */
export function onReadiness(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}
const canSeeIp = () => /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
const guide = (name, text) => h("a", { href: `${GUIDE_URL}${name}.md`, target: "_blank", rel: "noopener" }, text, h("span", { class: "sr-only" }, " (opens in a new tab)"));
const busyOn = (b, on) => {
  if (!b) return;
  b.disabled = on;
  if (on) b.setAttribute("aria-busy", "true");
  else b.removeAttribute("aria-busy");
};

function publish(snap, { failed = false } = {}) {
  if (failed) state.failedAt = Date.now();
  else {
    state.snap = snap;
    state.failedAt = null;
  }
  drawBadge();
  for (const fn of state.listeners) {
    try {
      fn(state.snap);
    } catch {
      /* one listener cannot stop the others */
    }
  }
}

/** Read /v1/readiness now (the badge's poll, after a kill-switch action, after Check now). */
export async function refreshReadiness() {
  try {
    const r = await api("/v1/readiness");
    const restart = state.stopped && state.mounted;
    state.stopped = false;
    publish(r.data?.data ?? null);
    if (restart) {
      clearTimeout(state.timer);
      state.timer = setTimeout(() => state.tick?.(), POLL_MS);
    }
  } catch (err) {
    if (err?.status === 401 || err?.status === 403 || err?.status === 404) {
      // Signed out, a key that may not read it, or an older Bridge: no badge, and the 30 s poll stops (a revoked key
      // would otherwise ask every 30 s for as long as the tab stays open). The next page render or sign-in reads again
      // through this function and, on success, restarts the poll.
      const slot = document.getElementById("toolbar-ready");
      if (slot) slot.hidden = true;
      state.stopped = true;
      clearTimeout(state.timer);
      return null;
    }
    publish(null, { failed: true });
  }
  return state.snap;
}

/** Run a fresh check (POST /v1/readiness/check). `quiet`: no toast (the page shows the new time itself). */
export async function checkNow(btn, { quiet = false } = {}) {
  busyOn(btn, true);
  try {
    const r = await api("/v1/readiness/check", { method: "POST", body: {} });
    publish(r.data?.data ?? null);
    if (!quiet) toast(`Checked ${istHm(r.data?.data?.checkedAt)}`);
    return true;
  } catch (err) {
    toast(err?.message ?? "Could not check", { tone: "warn" });
    return false;
  } finally {
    busyOn(btn, false);
  }
}

// ── Kill switch sheets ──

const list = (cls, items) => h("ul", { class: `ks-list ${cls}` }, items.map((t) => h("li", {}, t)));

/**
 * "Stop all orders?": the one confirmation for engaging the kill switch (the Safety page and the badge's popover both
 * call it). It says exactly what stops and what keeps working. Resolves true once the switch is on.
 */
export async function engageKillSwitch() {
  const reason = h("input", { id: "ks-reason", value: "Stopped from the dashboard", maxlength: "200", autocomplete: "off" });
  const cancel = h("input", { type: "checkbox", id: "ks-cancel" });
  const go = await modal({
    title: "Stop all orders?",
    body: h(
      "div",
      { class: "stack ks-sheet" },
      h("p", { class: "ks-lead" }, "Every new order is refused at once, from every tool."),
      h(
        "div",
        { class: "ks-cols" },
        h("section", {}, h("h3", {}, "Stops"), list("stop", ["New orders and changes to open orders", "From the API, webhooks, AI assistants, the CLI and this dashboard", "Orders already queued but not yet sent"])),
        h("section", {}, h("h3", {}, "Keeps working"), list("keep", ["Cancelling orders", "Prices, positions and every read-only call"])),
      ),
      h("label", { class: "field" }, h("span", {}, "Reason"), reason),
      h("label", { class: "check" }, cancel, "Also cancel open orders the Bridge placed"),
      h("p", { class: "muted small" }, "Turn it off again from this computer, on the Safety page, with an admin key."),
    ),
    buttons: [{ label: "Keep trading", value: false }, { label: "Stop all orders", cls: "primary destructive", id: "ks-confirm", value: true }],
  });
  if (!go) return false;
  try {
    await api("/v1/safety/kill-switch", { method: "POST", body: { reason: reason.value.trim() || "manual", cancelOpenOrders: cancel.checked } });
    toast("All orders stopped", { tone: "warn" });
    return true;
  } catch (err) {
    await modal({ title: "Could not stop orders", body: alertBox(err), buttons: [{ label: "Close", value: true }] });
    return false;
  }
}

/** "Allow orders again?": releasing is for this computer only (admin key) and needs RELEASE typed. Resolves true once released. */
export async function releaseKillSwitch() {
  const typed = h("input", { id: "ks-release", placeholder: "RELEASE", autocomplete: "off", spellcheck: "false", autocapitalize: "characters" });
  const go = await modal({
    title: "Allow orders again?",
    body: h(
      "div",
      { class: "stack ks-sheet" },
      h("p", { class: "ks-lead" }, "New orders are accepted again, from every tool."),
      h("p", { class: "muted" }, "Releasing works from this computer only and needs an admin key. From another device, use mc-bridge kill release on this computer."),
      h("label", { class: "field" }, h("span", {}, "Type RELEASE to confirm"), typed),
    ),
    buttons: [{ label: "Keep stopped", value: false }, { label: "Release", cls: "primary", onClick: () => (typed.value === "RELEASE" ? true : (toast("Type RELEASE exactly, in capitals", { tone: "warn" }), false)) }],
  });
  if (!go) return false;
  try {
    await api("/v1/safety/kill-switch", { method: "DELETE", body: { confirm: "RELEASE" } });
    toast("Orders are allowed again");
    return true;
  } catch (err) {
    await modal({ title: "Could not release", body: alertBox(err), buttons: [{ label: "Close", value: true }] });
    return false;
  }
}

/**
 * Close a popover or sheet, then run `next` once it has fully closed. On phones the popover is the shared #dialog
 * bottom sheet: its "close" event (queued by dialog.close()) runs the sheet's clean-up, which unlocks page scroll,
 * drops aria-modal and moves focus back to the opener. Opening a modal or another sheet before that event would let
 * that clean-up undo the new one, so wait for it (our listener runs after the sheet's own, added earlier).
 */
function afterClose(close, next) {
  const d = document.getElementById("dialog");
  const wasOpen = Boolean(d?.open);
  close?.();
  if (wasOpen && !d.open) d.addEventListener("close", () => setTimeout(next, 0), { once: true });
  else setTimeout(next, 0);
}

/** Stop all orders from the badge: the same sheet as the Safety page, then a fresh reading. */
async function stopAll() {
  if (await engageKillSwitch()) {
    await refreshReadiness();
    if (location.hash.startsWith("#/safety") || location.hash === "" || location.hash === "#/" || location.hash.startsWith("#/home")) dispatchEvent(new HashChangeEvent("hashchange"));
  }
}

// ── Checklist ──

/** The state glyph: a round mark whose icon and colour both say pass, check, fail, not checked or off. */
const glyph = (status) => h("span", { class: `sf-glyph ${CHECK_TONE[status] || "idle"}`, "aria-hidden": "true" }, icon(CHECK_GLYPH[status] ?? "clock"));
const stateWord = (f) => h("span", { class: `sf-word ${f.tone || "idle"}` }, f.statusText || CHECK_TEXT[f.status] || "");

let uid = 0;
/**
 * One checklist row: state glyph, name, the reading in one line, the state in words. `expandable` rows open to say
 * what the check looks at and where the reading came from (a button with aria-expanded); the popover's rows are plain.
 */
function checkItem(f, accountId, { expandable = false } = {}) {
  const names = h("span", { class: "names" }, h("span", { class: "nm" }, f.label), h("span", { class: "sub" }, f.text));
  if (!expandable) return h("div", { class: "sf-item" }, h("div", { class: "list-row static sf-check" }, glyph(f.status), names, stateWord(f)));
  const key = `${accountId}:${f.key}`;
  const id = `sf-why-${++uid}`;
  const facts = [["Reading", f.text], f.detail ? ["Detail", f.detail] : null, f.source ? ["Source", f.source] : null].filter(Boolean);
  const why = h(
    "div",
    { class: "sf-why", id, hidden: !state.open.has(key) },
    h("p", {}, CHECK_COPY[f.key] ?? ""),
    h("dl", { class: "sf-facts" }, facts.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
  );
  const chev = icon("chevron");
  chev.classList.add("chev");
  const btn = h("button", { type: "button", class: "list-row sf-check", "aria-expanded": String(state.open.has(key)), "aria-controls": id }, glyph(f.status), names, stateWord(f), chev);
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open));
    why.hidden = !open;
    if (open) state.open.add(key);
    else state.open.delete(key);
  });
  return h("div", { class: "sf-item" }, btn, why);
}

/** One account's block: name, its state in words, why when it is not ready, and its six checks. */
export function accountBlock(row, { expandable = false, compact = false } = {}) {
  const trouble = row.reasons.length && row.state.key !== "ready";
  return h(
    "article",
    { class: `sf-acct${compact ? " compact" : ""}`, "data-state": row.state.key },
    h(
      "header",
      { class: "sf-acct-head" },
      h("div", { class: "names" }, h("h3", {}, row.title), h("p", {}, row.sub)),
      row.simulated ? h("span", { class: "sf-sim" }, "Simulated") : null,
      pill(row.state.text, row.state.tone),
    ),
    trouble ? h("ul", { class: `sf-reasons ${row.state.tone}` }, row.reasons.map((r) => h("li", {}, r)), row.more ? h("li", { class: "muted" }, `and ${formatInt(row.more)} more`) : null) : null,
    h("div", { class: "list sf-list" }, row.facts.map((f) => checkItem(f, row.id, { expandable }))),
  );
}

// ── Popover and badge ──

function popoverBody(snap) {
  const rows = rowsModel(snap, { canSeeIp: canSeeIp() });
  const check = h("button", { type: "button", class: "small tinted", onclick: () => checkNow(check).then(() => pop?.close()) }, icon("refresh"), "Check now");
  const stop = h("button", { type: "button", class: "small tinted destructive", onclick: () => afterClose(() => pop?.close(), stopAll) }, icon("stop"), "Stop all orders");
  const open = location.hash.startsWith("#/safety") ? null : h("a", { class: "btn small plain", href: "#/safety", onclick: () => pop?.close() }, "Open Safety", icon("chevron"));
  const warning = snap?.notifications?.warning;
  return h(
    "div",
    { class: "rd-pop" },
    snap ? h("p", { class: "rd-pop-sum" }, h("span", {}, snap.summary ?? ""), h("small", {}, scheduleLine(snap))) : h("p", { class: "rd-pop-sum" }, "Checking…"),
    state.failedAt ? h("p", { class: "rd-pop-note" }, `The Bridge did not answer; this is the reading from ${istHm(snap?.checkedAt)}.`) : null,
    rows.length ? rows.map((r) => accountBlock(r, { compact: true })) : h("p", { class: "rd-pop-note" }, "No live account. Paper orders do not need a broker session or a static IP."),
    warning && !snap?.notifications?.demoOff ? h("p", { class: "rd-pop-note" }, `${warning} `, guide("notifications", "Notifications guide")) : null,
    h("div", { class: "rd-pop-acts" }, check, stop, open),
  );
}

let pop = null;
function openPopover(trigger) {
  pop = sheetPopover({ trigger, title: "Trading readiness", cls: "rd-popover", body: popoverBody(state.snap), onClose: () => (pop = null) });
}

function drawBadge() {
  const slot = document.getElementById("toolbar-ready");
  if (!slot) return;
  const m = badgeModel(state.snap, { demo: app.state.demo, failedAt: state.failedAt });
  let btn = slot.querySelector("button");
  if (!btn) {
    btn = h("button", { type: "button", class: "toolbar-ready-btn glass", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: () => openPopover(btn) });
    slot.replaceChildren(btn);
  }
  btn.replaceChildren(h("span", { class: "rd-glyph", "aria-hidden": "true" }, icon("safety"), h("span", { class: "pdot" })), h("span", { class: "rd-long" }, m.text), h("span", { class: "rd-short" }, m.short));
  btn.setAttribute("aria-label", m.aria);
  btn.title = m.title;
  slot.dataset.ready = m.dot;
  slot.dataset.state = m.state;
  slot.hidden = false;
  // The toolbar folds on tablets and phones; the ⋯ button there shows the state dot instead (app.css).
  document.documentElement.dataset.ready = m.dot;
}

/** Mount the toolbar badge once after sign-in and keep it fresh: every 30 s while visible, and on return to the tab. */
export function mountReadinessBadge() {
  if (state.mounted || typeof document === "undefined") return;
  const slot = document.getElementById("toolbar-ready");
  if (!slot) return;
  state.mounted = true;
  const tick = () => {
    clearTimeout(state.timer);
    if (document.visibilityState !== "visible") return;
    refreshReadiness().finally(() => {
      clearTimeout(state.timer);
      if (!state.stopped) state.timer = setTimeout(tick, POLL_MS);
    });
  };
  state.tick = tick;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !state.stopped) tick();
    else clearTimeout(state.timer);
  });
  drawBadge();
  slot.hidden = false;
  tick();
}

// ── The Safety page: checklist, timeline, how it is checked, demo tools ──

const chevron = () => {
  const c = icon("chevron");
  c.classList.add("chev");
  return c;
};

/** A collapsible row group: <details> with a list-row summary (title, one-line hint, chevron) and a padded body. */
function disclosure(title, hint, ...body) {
  return h("details", { class: "sf-disc" }, h("summary", {}, h("span", { class: "names" }, h("span", { class: "nm" }, title), hint ? h("span", { class: "sub" }, hint) : null), chevron()), h("div", { class: "sf-disc-body" }, body));
}

/** Read the snapshot and its history for the Safety page (and tell the badge). */
export async function loadReadiness() {
  const [snap, history] = await Promise.all([api("/v1/readiness").then((r) => r.data?.data ?? null, () => null), api("/v1/readiness/history?limit=10").then((r) => r.data?.data ?? [], () => [])]);
  if (snap) publish(snap);
  return { snap, history };
}

/**
 * The readiness part of the Safety page. Returns { main, demo }: `main` is the "Trading readiness" section (the
 * checklist per account on the left, Recent changes and How this is checked beside it); `demo` is the demo-only
 * simulation tools (null outside the demo). Both redraw on every new reading while they are on screen, and "Last
 * checked" counts up on its own.
 */
export function readinessSection({ demo = false, initial = { snap: null, history: [] } } = {}) {
  let history = initial.history ?? [];
  const checks = h("div", { class: "sf-checks" });
  const aside = h("div", { class: "sf-aside" });
  const pillSlot = h("span", { class: "sf-head-pill" });
  const sub = h("p");
  const announce = h("span", { class: "sr-only", role: "status" });
  const checkBtn = h("button", { type: "button", class: "tinted" }, icon("refresh"), "Check now");
  const working = h("span", { class: "sf-working", hidden: true }, "Checking…");
  const main = h(
    "section",
    { class: "sec sf-ready", "aria-labelledby": "sf-ready-h" },
    h("header", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", { id: "sf-ready-h" }, "Trading readiness"), sub), h("div", { class: "sec-acts" }, working, pillSlot, checkBtn)),
    h("div", { class: "sf-ready-grid" }, checks, aside),
    announce,
  );
  const demoSlot = demo ? h("div", { class: "sf-demo-slot" }) : null;

  const reloadHistory = async () => {
    history = await api("/v1/readiness/history?limit=10").then((r) => r.data?.data ?? [], () => history);
    draw(state.snap);
  };
  checkBtn.addEventListener("click", async () => {
    working.hidden = false;
    const ok = await checkNow(checkBtn, { quiet: true });
    working.hidden = true;
    if (ok) {
      announce.textContent = "";
      setTimeout(() => (announce.textContent = "Checked just now"), 30);
      await reloadHistory();
    }
  });
  const tickLine = () => {
    if (!main.isConnected) return;
    sub.textContent = checkedLine(state.snap ?? initial.snap);
  };
  const ticker = setInterval(() => (main.isConnected || !main.dataset.drawn ? tickLine() : stop()), 5000);

  function draw(snap) {
    if (!main.isConnected && main.dataset.drawn) return stop();
    main.dataset.drawn = "1";
    const m = badgeModel(snap, { demo });
    pillSlot.replaceChildren(pill(m.short, m.cls));
    pillSlot.title = m.text;
    sub.textContent = checkedLine(snap);
    if (!snap) {
      const retry = h("button", { type: "button", class: "small", onclick: () => reload() }, icon("refresh"), "Try again");
      checks.replaceChildren(h("div", { class: "sf-card sf-fail" }, alertBox({ title: "Readiness is not available", detail: "The Bridge did not answer /v1/readiness." }, "info"), h("div", {}, retry)));
      aside.replaceChildren();
      demoSlot?.replaceChildren();
      return;
    }
    const rows = rowsModel(snap, { canSeeIp: canSeeIp() });
    const labels = Object.fromEntries((snap.accounts ?? []).map((a) => [a.accountId, accountName(a)]));
    checks.replaceChildren(...(rows.length ? rows.map((r) => accountBlock(r, { expandable: true })) : [h("p", { class: "sf-card sf-note" }, "No live account is set up, so there is nothing to check. Paper orders do not need a broker session or a static IP.")]));
    aside.replaceChildren(timeline(history, labels), howChecked(snap));
    if (demoSlot) demoSlot.replaceChildren(demoTools(snap));
  }
  async function reload() {
    const r = await loadReadiness();
    history = r.history;
    draw(state.snap ?? r.snap);
  }
  function timeline(items, labels) {
    const body = items.length
      ? h(
          "ol",
          { class: "sf-timeline" },
          items.slice(0, 6).map((x) => {
            const p = timelineParts(x, labels);
            return h("li", { "data-tone": p.tone || "idle" }, h("span", { class: "sf-dot", "aria-hidden": "true" }), h("div", {}, h("strong", {}, p.title), p.note ? h("span", {}, p.note) : null), h("time", { datetime: x.at }, p.time));
          }),
        )
      : h("p", { class: "sf-note" }, "Nothing yet. A change is recorded when an account moves between Ready, Check and Cannot trade.");
    return h("section", { class: "group", "aria-labelledby": "sf-hist-h" }, h("h3", { class: "group-title", id: "sf-hist-h" }, "Recent changes"), h("div", { class: "sf-card" }, body));
  }
  function howChecked(snap) {
    const eg = egressModel(snap);
    const parts = methodParts(snap.method);
    return h(
      "section",
      { class: "group" },
      h(
        "div",
        { class: "sf-card sf-disc-card" },
        disclosure(
          "How this is checked",
          "Where each reading comes from",
          parts.length ? h("dl", { class: "sf-method" }, parts.map((p) => h("div", {}, p.name ? h("dt", {}, p.name) : null, h("dd", {}, p.text)))) : null,
          h("p", { class: "sf-method-line" }, scheduleLine(snap)),
          h("div", { class: "sf-egress" }, h("div", { class: "sf-kv" }, h("span", {}, "Static IP lookup"), h("strong", {}, eg.modeText)), h("p", {}, eg.note), eg.mode === "off" ? codeBlock(eg.snippet, { title: "bridge.config.json", json: true }) : null),
          h("p", { class: "sf-links" }, guide("deployment", "Deployment guide (static IP)"), guide("safety", "Safety guide")),
        ),
      ),
    );
  }
  function stop() {
    clearInterval(ticker);
    off();
  }
  const off = onReadiness((snap) => draw(snap));
  draw(state.snap ?? initial.snap);
  return { main, demo: demoSlot };

  function demoTools(snap) {
    const active = snap.schedule?.demo?.scenario ?? null;
    const restores = snap.schedule?.demo?.restoresAt;
    const sent = snap.notifications?.wouldHaveSent ?? [];
    const run = async (scenario, b) => {
      busyOn(b, true);
      try {
        const r = await api("/v1/demo/readiness", { method: "POST", body: { scenario } });
        publish(r.data?.data ?? null);
        await reloadHistory();
        toast(scenario === "restore" ? "Simulation restored" : `Simulating: ${DEMO_ACTIONS.find(([v]) => v === scenario)?.[1] ?? scenario}`);
      } catch (err) {
        await modal({ title: "Could not simulate", body: alertBox(err), buttons: [{ label: "Close", value: true }] });
      } finally {
        busyOn(b, false);
      }
    };
    const open = state.open.has("demo-tools");
    const d = disclosure(
      "Demo tools: simulate a problem",
      active ? "A simulation is running" : "Only in the demo. Nothing real is changed",
      h(
        "div",
        { class: "sf-demo-btns", role: "group", "aria-label": "Simulate a readiness problem" },
        DEMO_ACTIONS.map(([v, t]) => {
          const b = h("button", { type: "button", class: v === "restore" ? "small" : "small tinted", "aria-pressed": String(v === "restore" ? false : active === v) }, t);
          b.addEventListener("click", () => run(v, b));
          return b;
        }),
      ),
      h("p", { class: "sf-note" }, `Simulations are shared by everyone viewing this demo and reset after 10 minutes.${active && restores ? ` This one resets at ${istHm(restores)}.` : ""}`),
      sent.length
        ? h(
            "div",
            { class: "sf-sent" },
            h("h4", {}, "Notifications that would have been sent"),
            h("ol", { class: "sf-msgs" }, sent.slice(0, 5).map((x) => h("li", {}, h("time", { datetime: x.at }, istHm(x.at)), h("strong", {}, x.title), h("span", {}, x.text)))),
          )
        : null,
    );
    d.open = open;
    d.addEventListener("toggle", () => (d.open ? state.open.add("demo-tools") : state.open.delete("demo-tools")));
    return h("section", { class: "group sf-demo" }, h("div", { class: "sf-card sf-disc-card" }, d));
  }
}
