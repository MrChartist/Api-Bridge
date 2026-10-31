// Trading readiness on the dashboard (docs/spec/p1-05-readiness.md §6): the client side of /v1/readiness. One badge
// in the toolbar of every page, its popover (a bottom sheet on phones), the "Trading readiness" card on the Safety
// page, the pill on the Home page's Safety card and the demo simulation controls.
//
// The view-model (badgeModel, rowsModel, scheduleLine, historyLine, egressModel ...) is pure and exported for
// readiness.test.mjs; DOM code runs only in a browser. Numbers become text through format.js only. Copy is descriptive
// (copyRules.mjs): what was checked and where the fact came from, never advice. Every reading is local: the badge polls
// GET /v1/readiness, which answers from the monitor's cache and never calls a broker.
import { api, app, codeBlock, confirmEngageKillSwitch, h, icon, modal, alertBox, pill, sheetPopover, toast } from "./app.js";
import { DASH, formatInt, formatRupeeGrouped, isFigure } from "./format.js";

/** How often the badge reads /v1/readiness while the tab is visible (spec §6.3). */
export const POLL_MS = 30_000;
/** Where the guides live (the dashboard does not serve docs). */
export const GUIDE_URL = "https://github.com/MrChartist/api-bridge/blob/main/docs/guides/";

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
export const CHECK_TEXT = Object.freeze({ pass: "OK", warn: "Check", fail: "Fails", unknown: "Unknown", "n/a": "Off" });
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

// ── Badge (spec §6.2) ──

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
  if (overall === "paper_only" || snapshot.paperOnly) {
    const m = out("paper_only", "info", "Paper trading", "Paper");
    // The tooltip says what it means: practice orders, nothing reaches a broker.
    return { ...m, title: "Paper trading: live trading is off, so orders go to the practice account and nothing reaches your broker. Click for details." };
  }
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
  // unknown: still checking, or every reading is stale (spec §7.9: "Not checked since 15:44", neutral).
  const stale = live.length > 0 && live.every((a) => a.stale);
  const last = live.map((a) => parse(a.checkedAt)).filter(finite).sort((x, y) => y - x)[0];
  if (stale && last) return out("unknown", "", `Not checked since ${istHm(new Date(last).toISOString())}`, "Not checked");
  return out("unknown", "", stale ? "Not checked" : "Checking…", stale ? "Not checked" : "Checking…");
}

// ── Account rows (spec §6.2) ──

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
        { ...fact("orders", "Orders", { status: orderStatus, source: c.dailyOrders?.source ?? c.orderRate?.source }, ordersFact(c.orderRate, c.dailyOrders)) },
        fact("loss", "Daily loss", c.dailyLoss, lossFact(c.dailyLoss)),
        fact("kill", "Kill switch", c.killSwitch, killFact(c.killSwitch)),
        { key: "automations", label: "Automations", status: (a.automations ?? []).some((x) => x.mode === "live" && x.state === "cannot_trade") ? "fail" : "pass", statusText: "", tone: "", text: automationsFact(a.automations), detail: null, source: null },
      ],
      automations: a.automations ?? [],
    };
  });
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
/** "10:12 Main: ready → cannot trade (IP mismatch)". Pure. */
export function historyLine(item, labels = {}) {
  const p = historyParts(item, labels);
  return `${p.time} ${p.text}`;
}

/** The egress settings note and copyable config snippet (spec §6.4). Pure. */
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

/** The demo simulation buttons (spec §4.4 scenarios; "restore" last). */
export const DEMO_ACTIONS = Object.freeze([
  ["session-expired", "Expire session"],
  ["session-expiring", "Session ends soon"],
  ["ip-changed", "Change IP"],
  ["ip-unchecked", "Turn lookup off"],
  ["daily-loss-near", "Daily loss near"],
  ["daily-orders-exhausted", "Use up orders"],
  ["restore", "Restore"],
]);

// ── DOM (browser only) ──

const state = { snap: null, failedAt: null, timer: 0, mounted: false, stopped: false, tick: null, listeners: new Set() };
/** The last snapshot the badge read (null before the first answer). */
export const lastReadiness = () => state.snap;
/** Called with every new snapshot (the Safety card and the Home pill redraw from it). Returns an unsubscribe. */
export function onReadiness(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}
const canSeeIp = () => /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
const guide = (name, text) => h("a", { href: `${GUIDE_URL}${name}.md`, target: "_blank", rel: "noopener" }, text, h("span", { class: "sr-only" }, " (opens in a new tab)"));

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

/** Run a fresh check (POST /v1/readiness/check), then show "Checked 10:14". */
export async function checkNow(btn) {
  if (btn) {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
  }
  try {
    const r = await api("/v1/readiness/check", { method: "POST", body: {} });
    publish(r.data?.data ?? null);
    toast(`Checked ${istHm(r.data?.data?.checkedAt)}`);
  } catch (err) {
    toast(err?.message ?? "Could not check", { tone: "info" });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    }
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

/** Stop all orders from the badge: the same confirmation as the Safety page, then a fresh reading. */
async function stopAll() {
  if (await confirmEngageKillSwitch()) {
    await refreshReadiness();
    if (location.hash.startsWith("#/safety") || location.hash === "" || location.hash === "#/" || location.hash.startsWith("#/home")) dispatchEvent(new HashChangeEvent("hashchange"));
  }
}

/**
 * One account as a stacked block: head, reasons, facts (the popover, phone and tablet cards). `plain` drops the inner
 * surface: the Safety card with one live account shows the facts straight in its body as a key / value list.
 */
export function accountBlock(row, { compact = false, plain = false } = {}) {
  return h(
    "article",
    { class: `rd-acct${compact ? " compact" : ""}${plain ? " plain" : ""}`, "data-state": row.state.key },
    h(
      "header",
      { class: "rd-acct-head" },
      h("div", { class: "rd-acct-name" }, h("strong", {}, row.title), h("small", {}, row.sub)),
      row.simulated ? h("span", { class: "rd-sim" }, "Simulated") : null,
      pill(row.state.text, row.state.tone),
    ),
    row.reasons.length ? h("ul", { class: "rd-reasons" }, row.reasons.map((r) => h("li", {}, r)), row.more ? h("li", { class: "muted" }, `and ${formatInt(row.more)} more`) : null) : null,
    h(
      "dl",
      { class: "rd-facts" },
      row.facts.map((f) =>
        h(
          "div",
          { class: "rd-fact", "data-status": f.status },
          h("dt", {}, f.label),
          h("dd", {}, h("span", { class: "rd-fact-v" }, f.statusText ? h("i", { class: `rd-tick ${f.tone}`.trim(), "aria-hidden": "true" }) : null, h("span", {}, f.text)), f.statusText && f.tone !== "ok" ? h("span", { class: "sr-only" }, ` (${f.statusText})`) : null, f.detail || f.source ? h("small", {}, [f.detail, f.source].filter(Boolean).join(" · ")) : null),
        ),
      ),
    ),
  );
}

/**
 * What the overall state means for the person, in plain words (pure): { tone, glyph, title, text }. The server's own
 * summary stays as the detail line under it.
 */
export function heroModel(snap) {
  const overall = !snap ? "unknown" : snap.disabled ? "off" : snap.overall === "paper_only" || snap.paperOnly ? "paper_only" : snap.overall ?? "unknown";
  const first = (snap?.accounts ?? []).flatMap((a) => a.reasons ?? []).find((r) => r.severity === "fail") ?? (snap?.accounts ?? []).flatMap((a) => a.reasons ?? [])[0];
  switch (overall) {
    case "ready":
      return { tone: "ok", glyph: "check", title: "Ready to trade live", text: "Every check passed for your live accounts: session, static IP, limits and the kill switch." };
    case "paper_only":
      return { tone: "info", glyph: "orders", title: "Paper trading only", text: "Live trading is off, so every order goes to your practice account. Nothing is sent to a broker and no real money moves. Turn live trading on from Safety when you are ready." };
    case "warn":
      return { tone: "warn", glyph: "warn", title: "Check before trading live", text: first?.message ?? "One of the checks needs a look. Orders still go through." };
    case "cannot_trade":
      return { tone: "bad", glyph: "stop", title: "Live trading is blocked", text: first?.message ?? "A check fails, so live orders are refused until it is fixed." };
    case "off":
      return { tone: "", glyph: "info", title: "Readiness checks are off", text: "The Bridge is not checking live accounts. Turn readiness on in the config to see them here." };
    default:
      return { tone: "", glyph: "clock", title: "Checking your accounts", text: "The first reading arrives in a moment." };
  }
}

function popoverBody(snap) {
  const rows = rowsModel(snap, { canSeeIp: canSeeIp() });
  const check = h("button", { type: "button", class: "small", onclick: () => checkNow(check).then(() => pop?.close()) }, icon("refresh"), "Check now");
  const stop = h("button", { type: "button", class: "small", onclick: () => afterClose(() => pop?.close(), stopAll) }, icon("stop"), "Stop all orders");
  const open = h("a", { class: "btn small plain", href: "#/safety", onclick: () => pop?.close() }, "Open Safety", icon("chevron"));
  const warning = snap?.notifications?.warning;
  const hero = heroModel(snap);
  return h(
    "div",
    { class: "rd-pop" },
    h(
      "section",
      { class: `rd-hero ${hero.tone}`.trim() },
      h("span", { class: "rd-hero-ico", "aria-hidden": "true" }, icon(hero.glyph)),
      h("div", { class: "rd-hero-t" }, h("strong", {}, hero.title), h("p", {}, hero.text), snap ? h("small", {}, scheduleLine(snap)) : null),
    ),
    state.failedAt ? h("p", { class: "rd-pop-note" }, `The Bridge did not answer; this is the reading from ${istHm(snap?.checkedAt)}.`) : null,
    rows.length ? h("div", { class: "rd-pop-accts" }, h("h3", { class: "rd-pop-h" }, rows.length === 1 ? "Account checks" : `Account checks · ${formatInt(rows.length)} accounts`), rows.map((r) => accountBlock(hero.tone === "info" ? { ...r, reasons: [], more: 0 } : r, { compact: true }))) : h("p", { class: "rd-pop-note" }, "No live account. Paper orders do not need a broker session or a static IP."),
    h("div", { class: "rd-pop-acts" }, check, stop, open),
    warning && !snap?.notifications?.demoOff ? h("p", { class: "rd-pop-foot" }, icon("bell"), h("span", {}, "Readiness alerts are not sent anywhere yet. ", guide("notifications", "Set up notifications"))) : null,
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
  btn.replaceChildren(h("span", { class: "rd-glyph", "aria-hidden": "true" }, icon("power"), h("span", { class: "pdot" })), h("span", { class: "rd-long" }, m.text), h("span", { class: "rd-short" }, m.short));
  btn.setAttribute("aria-label", m.aria);
  btn.title = m.title;
  slot.dataset.ready = m.dot;
  slot.dataset.state = m.state;
  slot.hidden = false;
  // The Options pages fold the toolbar on tablets and phones; their ⋯ button shows the state dot instead (app.css).
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

/**
 * The Home Safety card's sentence when readiness has something to say: "1 of 1 live account cannot trade. Paper orders
 * are unaffected." (null when ready, paper only or not read yet, so the card keeps its usual line). Pure.
 */
export function homeSafetyLine(snap) {
  if (!snap || (snap.overall !== "cannot_trade" && snap.overall !== "warn") || !snap.summary) return null;
  return `${String(snap.summary).replace(/\.$/, "")}. Paper orders are unaffected.`;
}

/** The readiness pill for the Home page's Safety card (next to the kill-switch pill). */
export function readinessPill(snap = state.snap) {
  const m = badgeModel(snap, { demo: app.state.demo });
  const el = pill(`Readiness: ${m.short === "Checking…" ? "checking" : m.short.toLowerCase()}`, m.cls);
  el.title = m.title;
  return el;
}

/**
 * A row for the Options pages' ⋯ sheet on tablets and phones, where the toolbar badge does not fit. `opener` is the
 * ⋯ button: the readiness popover is placed under it and hands focus back to it, since the folded badge is not
 * rendered there (display: none has no position and cannot take focus).
 */
export function readinessSheetRow(closeSheet, opener = null) {
  const m = badgeModel(state.snap, { demo: app.state.demo, failedAt: state.failedAt });
  const btn = h("button", { type: "button", class: "rd-sheet-row full", "aria-label": m.aria }, h("span", {}, "Trading readiness"), pill(m.short, m.cls), icon("chevron"));
  btn.addEventListener("click", () => {
    const badge = document.querySelector("#toolbar-ready button");
    const trigger = badge && badge.offsetParent !== null ? badge : opener?.isConnected ? opener : badge;
    afterClose(closeSheet, () => openPopover(trigger ?? null));
  });
  return btn;
}

/** The desktop table (≥ 1024 px): one row per live account. */
function accountsTable(rows) {
  const cell = (f) => h("td", { "data-status": f.status }, h("span", { class: "rd-cell" }, f.statusText ? pill(f.statusText, f.tone) : null, h("span", { class: "rd-cell-t" }, f.text), f.detail || f.source ? h("small", {}, [f.detail, f.source].filter(Boolean).join(" · ")) : null));
  const heads = ["Account", "State", "Session", "Static IP", "Orders", "Daily loss", "Kill switch", "Automations"];
  return h(
    "div",
    { class: "rd-table-wrap" },
    h(
      "table",
      { class: "rd-table" },
      h("caption", { class: "sr-only" }, "Trading readiness per live account"),
      h("thead", {}, h("tr", {}, heads.map((t) => h("th", { scope: "col" }, t)))),
      h(
        "tbody",
        {},
        rows.map((r) =>
          h(
            "tr",
            {},
            h("th", { scope: "row" }, h("span", { class: "rd-acct-name" }, h("strong", {}, r.title), h("small", {}, r.sub), r.simulated ? h("span", { class: "rd-sim" }, "Simulated") : null)),
            h("td", {}, h("span", { class: "rd-cell" }, pill(r.state.text, r.state.tone), r.codes.length ? h("small", {}, r.codes.map(reasonShort).join(", ")) : null)),
            r.facts.map((f) => {
              if (f.key !== "automations") return cell(f);
              const a = automationsShort(r.automations);
              return h("td", {}, h("span", { class: "rd-cell" }, h("span", { class: "rd-cell-t" }, a.text), a.detail ? h("small", {}, a.detail) : null));
            }),
          ),
        ),
      ),
    ),
  );
}

/**
 * The Safety page card "Trading readiness" (spec §6.4). Reads /v1/readiness and its history; redraws on every new
 * reading while it is on screen.
 */
export async function readinessCard({ cardFn, demo = false } = {}) {
  const [snapRes, histRes] = await Promise.all([api("/v1/readiness").then((r) => r.data?.data ?? null, () => null), api("/v1/readiness/history?limit=10").then((r) => r.data?.data ?? [], () => [])]);
  if (snapRes) publish(snapRes);
  let history = histRes;
  const body = h("div", { class: "rd-card" });
  const headPill = h("span", { class: "rd-head-pill" });
  const checkBtn = h("button", { type: "button", class: "small", onclick: () => checkNow(checkBtn).then(reloadHistory) }, icon("refresh"), "Check now");
  const sub = h("span", { class: "rd-sched" });
  const reloadHistory = async () => {
    history = await api("/v1/readiness/history?limit=10").then((r) => r.data?.data ?? [], () => history);
    draw(state.snap);
  };
  function draw(snap) {
    if (!body.isConnected && body.dataset.drawn) return off();
    body.dataset.drawn = "1";
    const m = badgeModel(snap, { demo });
    headPill.replaceChildren(pill(m.text, m.cls));
    sub.textContent = scheduleLine(snap);
    if (!snap) {
      body.replaceChildren(alertBox({ title: "Readiness is not available", detail: "This Bridge did not answer /v1/readiness." }, "info"));
      return;
    }
    const rows = rowsModel(snap, { canSeeIp: canSeeIp() });
    const labels = Object.fromEntries((snap.accounts ?? []).map((a) => [a.accountId, accountName(a)]));
    const eg = egressModel(snap);
    const sent = snap.notifications?.wouldHaveSent ?? [];
    body.replaceChildren(
      ...[
        rows.length === 1
          ? accountBlock(rows[0], { plain: true })
          : rows.length
          ? h("div", { class: "rd-accts" }, accountsTable(rows), h("div", { class: "rd-stack" }, rows.map((r) => accountBlock(r))))
          : h("p", { class: "muted" }, "No live account is set up, so there is nothing to check. Paper orders do not need a broker session or a static IP."),
        demo ? demoControls(snap) : null,
        h(
          "div",
          { class: "rd-cols" },
          h(
            "section",
            { class: "rd-sec" },
            h("h3", {}, "Recent changes"),
            history.length ? h("ol", { class: "rd-history" }, history.slice(0, 10).map((x) => h("li", { "data-to": x.to }, h("time", { datetime: x.at }, historyParts(x, labels).time), h("span", {}, historyParts(x, labels).text)))) : h("p", { class: "muted small" }, "No changes recorded yet."),
          ),
          h(
            "section",
            { class: "rd-sec" },
            h("h3", {}, "How this is checked"),
            h("p", { class: "small muted" }, snap.method ?? ""),
            h("p", { class: "small rd-links" }, guide("deployment", "Deployment guide (static IP)"), guide("safety", "Safety guide")),
          ),
          h(
            "section",
            { class: "rd-sec" },
            h("h3", {}, "Egress IP check"),
            h("div", { class: "rd-kv" }, h("span", {}, "Mode"), h("strong", {}, eg.modeText)),
            h("p", { class: "small muted" }, eg.note),
            eg.mode === "off" ? codeBlock(eg.snippet, { title: "bridge.config.json", json: true }) : null,
          ),
        ),
        demo && sent.length
          ? h(
              "section",
              { class: "rd-sec rd-sent" },
              h("h3", {}, "Would have been sent"),
              h("p", { class: "small muted" }, "Notifications are off in the demo. These are the messages your notify targets would have received."),
              h("ol", { class: "rd-msgs" }, sent.slice(0, 10).map((x) => h("li", {}, h("time", { datetime: x.at }, istHm(x.at)), h("strong", {}, x.title), h("span", {}, x.text)))),
            )
          : null,
      ].filter(Boolean),
    );
  }
  function demoControls(snap) {
    const active = snap.schedule?.demo?.scenario ?? null;
    const restores = snap.schedule?.demo?.restoresAt;
    const run = async (scenario, b) => {
      b.disabled = true;
      b.setAttribute("aria-busy", "true");
      try {
        const r = await api("/v1/demo/readiness", { method: "POST", body: { scenario } });
        publish(r.data?.data ?? null);
        await reloadHistory();
        toast(scenario === "restore" ? "Simulation restored" : `Simulating: ${DEMO_ACTIONS.find(([v]) => v === scenario)?.[1] ?? scenario}`);
      } catch (err) {
        await modal({ title: "Could not simulate", body: alertBox(err), buttons: [{ label: "Close", value: true }] });
      } finally {
        b.disabled = false;
        b.removeAttribute("aria-busy");
      }
    };
    return h(
      "section",
      { class: "rd-sec rd-demo" },
      h("h3", {}, "Demo tools: simulate a problem"),
      h(
        "div",
        { class: "rd-demo-btns", role: "group", "aria-label": "Simulate a readiness problem" },
        DEMO_ACTIONS.map(([v, t]) => {
          const b = h("button", { type: "button", class: "chip-btn", "aria-pressed": String(v === "restore" ? false : active === v) }, t);
          b.addEventListener("click", () => run(v, b));
          return b;
        }),
      ),
      h("p", { class: "small muted" }, `Simulations are shared by everyone viewing this demo and reset after 10 minutes.${active && restores ? ` This one resets at ${istHm(restores)}.` : ""}`),
    );
  }
  const off = onReadiness((snap) => draw(snap));
  draw(state.snap ?? snapRes);
  return cardFn({
    glyph: "power",
    tint: "green",
    title: "Trading readiness",
    sub,
    actions: h("div", { class: "rd-head-acts" }, headPill, checkBtn),
    cls: "rd-card-wrap",
    body,
  });
}
