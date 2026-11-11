// Home: the Bridge at a glance. One status line, then the map the product is named for: what sends to the Bridge on
// the left (alert services through webhooks, tools through API keys), the Bridge and its gates in the middle (rate
// limits, safety, paper or live), the broker accounts on the right. Under it: the broker API budget (live, from the
// shared connection in live.js), the steps left to finish a setup, what became of the latest alerts, and the latest calls from other tools.
//
// Pure helpers (sourceRows, brokerRows, bridgeStatus, setupSteps, alertRows, uptimeText, externalRequests) are exported
// for tests; the DOM code runs only in a browser. Numbers become text through format.js. No style attributes (CSP):
// geometry goes into SVG attributes, sizes into CSS custom properties set from script.
import { api, app, card, currentKey, h, icon, iconTile, istTime, optional, pill } from "./app.js";
import { budgetView, shareTone, windowText } from "./budget.js";
import { sessionText } from "./flows.js";
import { DASH, formatInt } from "./format.js";
import * as live from "./live.js";

/** Alert services that post to a hook URL (hooks/receivers/*.mjs), in the order of the map. */
export const HOOK_SOURCES = Object.freeze([
  { id: "tradingview", name: "TradingView", icon: "chart", tint: "blue", hint: "Strategy and indicator alerts" },
  { id: "chartink", name: "ChartInk", icon: "scan", tint: "orange", hint: "Scan alerts" },
  { id: "gocharting", name: "GoCharting", icon: "wave", tint: "teal", hint: "Chart alerts" },
  { id: "generic", name: "Signed webhooks", icon: "bolt", tint: "purple", hint: "Your own servers and scripts" },
]);

/** Tools that call the API with a key, by the key's client kind (auth/keyStore.mjs CLIENT_KINDS). */
export const KEY_SOURCES = Object.freeze([
  { id: "script", name: "Python and Node", icon: "console", tint: "indigo", tool: "python", hint: "SDKs, REST and WebSocket" },
  { id: "excel", name: "Excel and Sheets", icon: "columns", tint: "green", tool: "excel", hint: "Live prices in a workbook" },
  { id: "mcp", name: "AI assistants", icon: "radar", tint: "pink", tool: "claude", hint: "Claude and ChatGPT tools" },
  { id: "other", name: "AmiBroker and more", icon: "bars", tint: "gray", tool: "amibroker", hint: "Anything that speaks HTTP" },
]);

const plural = (n, one, many = `${one}s`) => `${formatInt(n)} ${n === 1 ? one : many}`;
const latest = (list, key) => list.reduce((best, x) => (x[key] && (!best || Date.parse(x[key]) > Date.parse(best)) ? x[key] : best), null);
/** A key a tool can use now: not revoked, not expired, and not the dashboard's own (client kind "ui"). */
const usableKey = (k, now) => !k.revokedAt && !(k.expiresAt && Date.parse(k.expiresAt) < now) && k.clientKind !== "ui";

/**
 * The left column of the map (pure): one row per source, set-up ones first in their fixed order.
 * @returns {{ id: string, kind: "hook"|"key", name: string, icon: string, tint: string, hint: string, count: number,
 *   active: boolean, lastAt: string | null, status: string, to: string }[]}
 */
export function sourceRows({ hooks = [], keys = [], now = Date.now() } = {}) {
  const rows = [];
  for (const s of HOOK_SOURCES) {
    const mine = hooks.filter((x) => x.source === s.id);
    rows.push({ ...s, kind: "hook", count: mine.length, active: mine.length > 0, lastAt: latest(mine, "lastSignalAt"), status: mine.length ? plural(mine.length, "hook") : s.hint, to: `#/api/integrations?tool=webhooks&source=${s.id}` });
  }
  const tools = keys.filter((k) => usableKey(k, now) && !(k.scopes ?? []).includes("admin"));
  for (const s of KEY_SOURCES) {
    const mine = tools.filter((k) => (k.clientKind ?? "other") === s.id);
    rows.push({ ...s, kind: "key", count: mine.length, active: mine.length > 0, lastAt: latest(mine, "lastUsedAt"), status: mine.length ? plural(mine.length, "key") : s.hint, to: mine.length ? "#/api/keys" : `#/api/integrations?tool=${s.tool}` });
  }
  return [...rows.filter((r) => r.active), ...rows.filter((r) => !r.active)];
}

/**
 * The right column of the map (pure): one row per broker account, then the paper accounts as one row.
 * @param {object[]} accounts  GET /v1/accounts
 * @param {Map<string, string>} [brokerNames]  broker id → display name
 */
export function brokerRows(accounts = [], brokerNames = new Map()) {
  const rows = [];
  for (const a of accounts.filter((x) => x.broker !== "paper")) {
    const s = sessionText(a.session?.state);
    rows.push({ id: a.id, broker: a.broker, name: a.label || a.id, sub: brokerNames.get(a.broker) ?? a.broker, active: a.session?.state === "connected", status: s.text, tone: s.tone, to: "#/accounts" });
  }
  const paper = accounts.filter((x) => x.broker === "paper");
  if (paper.length) rows.push({ id: "paper", broker: "paper", name: paper.length === 1 ? paper[0].label || "Paper account" : "Paper accounts", sub: paper.length === 1 ? "Practice money, no broker" : `${formatInt(paper.length)} practice accounts`, active: true, status: "Ready", tone: "ok", to: "#/accounts" });
  return rows;
}

/** "3 h 12 min", "42 min", "under a minute" (pure). */
export function uptimeText(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return DASH;
  if (s < 60) return "under a minute";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs} h ${m % 60} min`;
  return `${Math.floor(hrs / 24)} days`;
}

/**
 * The one status line of the page (pure): { tone: "ok"|"warn"|"bad", title, detail, action: [label, hash] | null }.
 * Worst first: orders stopped, the Bridge not answering, no broker logged in, then running.
 */
export function bridgeStatus({ health = null, safety = null, accounts = [], demo = false } = {}) {
  const kill = safety?.killSwitch;
  if (kill?.engaged) return { tone: "bad", title: "All orders are stopped", detail: `The kill switch is on${kill.reason ? `: ${kill.reason}` : ""}. Market data and reads still work.`, action: ["Open Safety", "#/safety"] };
  if (health && health.status !== "ok") return { tone: "warn", title: "The Bridge needs attention", detail: "One of its services is not ready. The request log has the detail.", action: ["Open Activity", "#/api/activity"] };
  const real = accounts.filter((a) => a.broker !== "paper" && a.broker !== "demo");
  const loggedIn = real.filter((a) => a.session?.state === "connected");
  if (demo) return { tone: "ok", title: "The Bridge is running", detail: "Demo mode: sample prices and paper orders, so every tool can be tried before a broker is connected.", action: null };
  if (!real.length) return { tone: "warn", title: "Connect your first broker", detail: "The Bridge is running. Add a broker account and every tool you connect shares it.", action: ["Add a broker", "#/accounts?add=1"] };
  if (!loggedIn.length) return { tone: "warn", title: "No broker is logged in", detail: "Broker sessions end every day. Log in again on Accounts and everything connected picks up from there.", action: ["Open Accounts", "#/accounts"] };
  const live = safety?.liveTrading === true;
  return { tone: "ok", title: "The Bridge is running", detail: `${plural(loggedIn.length, "broker account")} logged in${loggedIn.length < real.length ? ` of ${formatInt(real.length)}` : ""}. ${live ? "Live trading is on for the accounts that allow it." : "Orders are paper only."}`, action: null };
}

/**
 * What is left to set up (pure): four steps, each { id, done, title, text, to, cta }.
 * A broker (or demo mode), a key for a tool, a source that sends alerts, a first order through the Bridge.
 */
export function setupSteps({ demo = false, accounts = [], keys = [], hooks = [], orders = [], now = Date.now() } = {}) {
  const broker = demo || accounts.some((a) => a.broker !== "paper" && a.session?.state === "connected");
  const key = keys.some((k) => usableKey(k, now) && !(k.scopes ?? []).includes("admin"));
  const placed = orders.some((o) => o?.tag !== "DEMOSEED");
  return [
    { id: "broker", done: broker, title: "Connect a broker", text: demo ? "Demo data stands in for a broker. Add your own when you are ready." : "Dhan, Zerodha, Upstox and 38 more, several accounts each.", to: "#/accounts?add=1", cta: "Add a broker" },
    { id: "key", done: key, title: "Create a key for a tool", text: "One key per tool, with only the access that tool needs.", to: "#/api/keys", cta: "Create a key" },
    { id: "source", done: hooks.length > 0, title: "Connect an alert source", text: "TradingView, ChartInk, GoCharting or your own signed webhook.", to: "#/api/integrations?tool=webhooks&source=tradingview", cta: "Connect TradingView" },
    { id: "order", done: placed, title: "Send a paper order", text: "Try the whole path with practice money before anything is live.", to: "#/api/console?endpoint=order", cta: "Open the console" },
  ];
}

/** The path of a request without its query (a key in ?key= never reaches the page). */
export const linkPath = (p) => String(p ?? "").split("?")[0];

/** Requests made by other tools (pure): not this dashboard's own key or pages, not health pings; newest first, `max` at most. */
export function externalRequests(list = [], ownKeyId = null, max = 6) {
  const own = (r) => r.keyId === ownKeyId || r.client === "dashboard" || linkPath(r.path).startsWith("/dashboard") || linkPath(r.path) === "/v1/health";
  return list.filter((r) => r && !own(r)).slice(0, max);
}

const SIGNAL_TEXT = Object.freeze({ placed: ["Placed", "ok"], duplicate: ["Repeat", ""], awaiting_confirmation: ["Waiting", "warn"], queued: ["Queued", ""], processing: ["Working", ""], rejected: ["Refused", "bad"], failed: ["Failed", "bad"], dropped: ["Dropped", "bad"] });
const SIGNAL_NOTE = Object.freeze({ placed: "Order placed", duplicate: "Already placed: nothing sent twice", awaiting_confirmation: "Waiting for you on Orders", queued: "In the queue", processing: "Being placed", dropped: "Dropped: the queue was full" });

/**
 * What became of each alert (pure): the audit log's hook.signal records as rows, newest first, `max` at most. A
 * refused alert says why, in the Bridge's own words, so nobody has to guess why no order showed up.
 * @param {object[]} audit  GET /v1/audit records
 * @param {object[]} hooks  GET /v1/hooks (for the hook's name)
 */
export function alertRows(audit = [], hooks = [], max = 6) {
  const label = new Map(hooks.map((x) => [x.id, x.label]));
  return audit
    .filter((r) => r?.type === "hook.signal" && r.data)
    .slice(0, max)
    .map((r) => {
      const d = r.data;
      const [text, tone] = SIGNAL_TEXT[d.status] ?? [String(d.status ?? "Unknown"), ""];
      return { at: r.at, status: text, tone, title: [d.side, d.symbol].filter(Boolean).join(" ") || "Alert", hook: label.get(d.hookId) ?? d.hookId ?? "Deleted hook", note: d.reason || SIGNAL_NOTE[d.status] || "" };
    });
}

/** The id inside an API key ("mcb_<id>_<secret>"), or null. */
export const keyIdOf = (key) => /^mcb_([a-z0-9]+)_/.exec(String(key ?? ""))?.[1] ?? null;

// ── DOM ──

const SVG_NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
/** A button that opens a page of the dashboard. */
const go = (label, to, cls = "small") => h("button", { type: "button", class: cls, onclick: () => (location.hash = to) }, label);
const chev = () => {
  const s = icon("chevron");
  s.classList.add("chev");
  return s;
};

function brokerTile(row) {
  if (row.broker === "paper") return iconTile("wallet", "gray");
  const tile = h("span", { class: "avatar logo", "aria-hidden": "true" });
  const initials = () => {
    tile.classList.remove("logo");
    tile.replaceChildren(String(row.sub || row.name).trim().slice(0, 2).toUpperCase());
  };
  if (!/^[a-z0-9]{2,32}$/.test(String(row.broker)) || row.broker === "demo") initials();
  else tile.append(h("img", { src: `/dashboard/broker-${row.broker}.png`, alt: "", loading: "lazy", decoding: "async", width: 64, height: 64, onerror: initials }));
  return tile;
}

/** One row of the map: a link with a tile, a name, a status line and a chevron. `data-on` marks a connected row. */
function mapRow({ tile, name, sub, to, on, trailing = null, label }) {
  return h("a", { class: "hm-row", href: to, "data-on": on ? "1" : "0", "aria-label": label }, tile, h("span", { class: "names" }, h("span", { class: "nm" }, name), h("span", { class: "sub" }, sub)), trailing, chev());
}

/** The middle of the map: the Bridge, then its gates as three short lines that link to their pages. */
function hubNode({ safety, version }) {
  const kill = safety?.killSwitch?.engaged === true;
  const liveOn = safety?.liveTrading === true;
  const mark = h("span", { class: "hm-mark", "aria-hidden": "true" });
  const sym = svgEl("svg", { viewBox: "0 0 1024 1024", focusable: "false" });
  sym.append(svgEl("use", { href: "#mc-symbol" }));
  mark.append(sym);
  const gate = (to, glyph, text, tone, id) => h("a", { class: `hm-gate ${tone}`.trim(), href: to, id }, icon(glyph), h("span", {}, text));
  return h(
    "div",
    { class: "hm-hub", "data-kill": kill ? "1" : "0" },
    mark,
    h("strong", {}, "API Bridge"),
    h("span", { class: "hm-ver" }, version ? `Version ${version}` : "This computer"),
    h("div", { class: "hm-gates" }, gate("#/api/limits", "limits", "Rate limits", "", "hm-gate-rate"), gate("#/safety", "safety", kill ? "Orders stopped" : "Safety checks on", kill ? "bad" : "ok"), gate("#/safety", liveOn ? "bolt" : "wallet", liveOn ? "Live enabled" : "Paper only", liveOn ? "warn" : "")),
  );
}

/**
 * Draw the links between the columns: a curve from every row to the hub, coloured when the row is connected. Run on
 * every resize of the map; on a phone the columns stack and the curves are not drawn (CSS draws a short stem).
 */
function drawLinks(map) {
  const svg = map.querySelector("svg.hm-links");
  const hub = map.querySelector(".hm-hub");
  if (!svg || !hub) return;
  const box = map.getBoundingClientRect();
  const hb = hub.getBoundingClientRect();
  svg.replaceChildren();
  if (map.dataset.stacked === "1" || !box.width) return;
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  const hy = hb.top + hb.height / 2 - box.top;
  const paths = [];
  const link = (row, side) => {
    const r = row.getBoundingClientRect();
    const y = r.top + r.height / 2 - box.top;
    const x1 = side === "in" ? r.right - box.left : hb.right - box.left;
    const x2 = side === "in" ? hb.left - box.left : r.left - box.left;
    const ya = side === "in" ? y : hy;
    const yb = side === "in" ? hy : y;
    const mid = (x1 + x2) / 2;
    const p = svgEl("path", { d: `M${x1.toFixed(1)} ${ya.toFixed(1)} C${mid.toFixed(1)} ${ya.toFixed(1)} ${mid.toFixed(1)} ${yb.toFixed(1)} ${x2.toFixed(1)} ${yb.toFixed(1)}`, class: row.dataset.on === "1" ? "on" : "", pathLength: "1" });
    paths.push(p);
  };
  for (const row of map.querySelectorAll(".hm-col.in .hm-row")) link(row, "in");
  for (const row of map.querySelectorAll(".hm-col.out .hm-row")) link(row, "out");
  // Connected links on top of the quiet ones.
  svg.append(...paths.filter((p) => !p.classList.contains("on")), ...paths.filter((p) => p.classList.contains("on")));
}

function bridgeMap({ sources, brokers, safety, version }) {
  const colHead = (title, sub) => h("div", { class: "hm-col-head" }, h("h3", {}, title), h("span", {}, sub));
  const activeSources = sources.filter((s) => s.active).length;
  const inCol = h(
    "div",
    { class: "hm-col in" },
    colHead("Sources", activeSources ? `${formatInt(activeSources)} connected` : "Nothing connected yet"),
    h(
      "div",
      { class: "hm-rows" },
      sources.map((s) => mapRow({ tile: iconTile(s.icon, s.tint), name: s.name, sub: s.active && s.lastAt ? `${s.status} · last ${istTime(s.lastAt)}` : s.status, to: s.to, on: s.active, label: `${s.name}: ${s.active ? s.status : "not set up"}`, trailing: s.active ? null : h("span", { class: "hm-add" }, "Set up") })),
    ),
  );
  const outCol = h(
    "div",
    { class: "hm-col out" },
    colHead("Brokers", brokers.length ? `${formatInt(brokers.filter((b) => b.active).length)} of ${formatInt(brokers.length)} ready` : "None yet"),
    h(
      "div",
      { class: "hm-rows" },
      brokers.map((b) => mapRow({ tile: brokerTile(b), name: b.name, sub: b.sub, to: b.to, on: b.active, label: `${b.name}: ${b.status}`, trailing: pill(b.status, b.tone) })),
      h("a", { class: "hm-row hm-new", href: "#/accounts?add=1", "data-on": "0" }, iconTile("plus", "gray"), h("span", { class: "names" }, h("span", { class: "nm" }, "Add a broker"), h("span", { class: "sub" }, "41 supported, several accounts each")), chev()),
    ),
  );
  const links = svgEl("svg", { class: "hm-links", "aria-hidden": "true", focusable: "false" });
  const map = h("div", { class: "hm-map" }, links, inCol, h("div", { class: "hm-mid" }, hubNode({ safety, version })), outCol);
  const redraw = () => {
    map.dataset.stacked = getComputedStyle(map).getPropertyValue("--hm-stacked").trim() === "1" ? "1" : "0";
    drawLinks(map);
  };
  // The connected links draw themselves in once (home.css); later redraws (a resize) show them at rest.
  setTimeout(() => map.classList.add("drawn"), 900);
  if (typeof ResizeObserver === "function") new ResizeObserver(redraw).observe(map);
  else setTimeout(redraw, 0);
  return map;
}

/** One figure of the status card. */
const figure = (label, value, sub, id) => h("div", { class: "hm-fig" }, h("span", { class: "label" }, label), h("span", { class: "value", id }, value), h("span", { class: "sub", id: id ? `${id}-sub` : undefined }, sub));

function statusCard({ status, health, sources, brokers, demo }) {
  const dot = h("span", { class: `hm-dot ${status.tone}${status.tone === "ok" ? " dv-breathe" : ""}`, "aria-hidden": "true" });
  const active = sources.filter((s) => s.active).length;
  const ready = brokers.filter((b) => b.active).length;
  return h(
    "section",
    { class: `card hm-status ${status.tone}`, "aria-label": "Bridge status" },
    h(
      "div",
      { class: "hm-status-main" },
      h("div", { class: "hm-state" }, dot, h("h2", {}, status.title)),
      h("p", {}, status.detail),
      h(
        "div",
        { class: "hm-status-meta" },
        demo ? pill("Demo data", "demo") : null,
        h("span", {}, `Up ${uptimeText(health?.uptimeSeconds)}`),
        status.action ? go(status.action[0], status.action[1], "small primary") : null,
      ),
    ),
    h(
      "div",
      { class: "hm-figs" },
      figure("Sources", formatInt(active), active ? "sending to the Bridge" : "none connected yet"),
      figure("Brokers", `${formatInt(ready)}/${formatInt(brokers.length)}`, "accounts ready"),
      figure("Broker calls today", DASH, "waiting for the live count", "hm-calls"),
    ),
  );
}

/** The broker API budget, one line per account: this second, this minute, calls today. Redrawn on every budget message. */
function budgetCard(find) {
  const body = h("div", { class: "hm-budget" }, h("p", { class: "muted small" }, "Waiting for the first reading…"));
  const meter = (label, w) => {
    const share = w && w.limit > 0 ? Math.min(1, w.used / w.limit) : 0;
    const fill = h("span", { class: `fill ${w ? shareTone(w.used, w.limit) : "ok"}` });
    fill.style.setProperty("--share", String(Math.max(share, w && w.used > 0 ? 0.03 : 0)));
    return h("div", { class: "hm-meter" }, h("span", { class: "lbl" }, label), h("span", { class: "track" }, fill), h("span", { class: "val" }, windowText(w)));
  };
  const draw = (msg) => {
    const accounts = msg?.accounts ?? [];
    const view = budgetView(msg, live.liveState());
    const calls = find("hm-calls");
    if (calls) calls.textContent = formatInt(msg?.callsToday ?? 0);
    const sub = find("hm-calls-sub");
    if (sub) sub.textContent = `${formatInt(msg?.savedToday ?? 0)} more saved by sharing`;
    const gate = find("hm-gate-rate");
    if (gate) {
      gate.className = `hm-gate ${view.tone === "ok" ? "ok" : view.tone}`;
      gate.lastElementChild.textContent = view.second ? `${windowText(view.second)} this second` : "Rate limits";
    }
    if (!accounts.length) {
      body.replaceChildren(h("p", { class: "muted small" }, "No broker account is making calls yet. Each account gets its own budget here once it does."));
      return;
    }
    body.replaceChildren(
      ...accounts.map((a) =>
        h(
          "div",
          { class: "hm-acct" },
          h("div", { class: "hm-acct-head" }, h("strong", {}, a.accountId), a.backoffMs > 0 ? pill("Backing off", "bad") : a.queued > 0 ? pill(`${formatInt(a.queued)} queued`, "warn") : pill("Within limits", "ok"), h("span", { class: "muted small" }, `${plural(a.callsToday ?? 0, "call")} today`)),
          meter("This second", a.second),
          meter("This minute", a.minute),
        ),
      ),
    );
  };
  const stop = live.onBudget(draw);
  const el = card({
    glyph: "limits",
    tint: "purple",
    title: "Broker API budget",
    sub: "One shared budget per broker account, however many tools are calling.",
    actions: go("Rate limits", "#/api/limits", "small"),
    body,
    cls: "hm-budget-card",
  });
  return { el, stop };
}

function setupCard(steps) {
  const left = steps.filter((s) => !s.done).length;
  const next = steps.find((s) => !s.done);
  return card({
    glyph: "check",
    tint: left ? "blue" : "green",
    title: left ? "Finish setting up" : "Setup complete",
    sub: left ? `${formatInt(steps.length - left)} of ${formatInt(steps.length)} done` : "A broker, a key, an alert source and a first order are all in place.",
    cls: "hm-setup",
    flush: true,
    body: h(
      "ol",
      { class: "hm-steps" },
      steps.map((s) =>
        h(
          "li",
          { class: s.done ? "done" : s === next ? "next" : "" },
          h("span", { class: "tick", "aria-hidden": "true" }, s.done ? icon("check") : null),
          h("span", { class: "names" }, h("span", { class: "nm" }, s.title), h("span", { class: "sub" }, s.text)),
          s.done ? h("span", { class: "muted small" }, "Done") : go(s.cta, s.to, s === next ? "small primary" : "small"),
        ),
      ),
    ),
  });
}

function trafficCard(requests, error) {
  const rows = requests.map((r) =>
    h(
      "li",
      {},
      h("span", { class: `hm-code ${r.status >= 500 ? "bad" : r.status >= 400 ? "warn" : "ok"}` }, String(r.status)),
      h("span", { class: "names" }, h("span", { class: "nm" }, `${r.method} ${linkPath(r.path)}`), h("span", { class: "sub" }, `${r.client || (r.keyId ? `key ${r.keyId}` : linkPath(r.path).startsWith("/hooks/") ? "alert webhook" : "no key")} · ${formatInt(r.ms)} ms`)),
      h("span", { class: "muted small" }, istTime(r.at)),
    ),
  );
  return card({
    glyph: "activity",
    tint: "gray",
    title: "Latest calls from your tools",
    sub: "What reached the Bridge from outside this dashboard.",
    actions: go("Activity", "#/api/activity", "small"),
    cls: "hm-traffic",
    flush: true,
    body: error
      ? h("p", { class: "hm-empty muted small" }, "The request log is only shown on this computer.")
      : rows.length
        ? h("ul", { class: "hm-reqs" }, rows)
        : h("p", { class: "hm-empty muted small" }, "Nothing has called the Bridge yet. Create a key, paste a snippet into your tool, and its first call shows up here."),
  });
}

function alertsCard(rows) {
  return card({
    glyph: "bolt",
    tint: "orange",
    title: "Latest alerts",
    sub: "Every alert that reached a webhook, and what the Bridge did with it.",
    actions: go("Orders", "#/orders", "small"),
    cls: "hm-alerts",
    flush: true,
    body: rows.length
      ? h(
          "ul",
          { class: "hm-reqs" },
          rows.map((r) => h("li", {}, h("span", { class: `hm-code wide ${r.tone || "quiet"}` }, r.status), h("span", { class: "names" }, h("span", { class: "nm" }, r.title), h("span", { class: "sub" }, [r.hook, r.note].filter(Boolean).join(" · "))), h("span", { class: "muted small" }, istTime(r.at)))),
        )
      : h("p", { class: "hm-empty muted small" }, "No alert has arrived yet. Send one from your charting tool and it shows up here within a second, placed or refused, with the reason."),
  });
}

let stopBudget = null;

/** Render Home (views.js PAGES). */
export async function renderHome() {
  stopBudget?.();
  stopBudget = null;
  const [accountsR, hooksR, keysR, safetyR, healthR, ordersR, requestsR, brokersR, auditR] = await Promise.all([
    api("/v1/accounts"),
    optional(api("/v1/hooks")),
    optional(api("/v1/keys")),
    optional(api("/v1/safety")),
    optional(api("/v1/health")),
    optional(api("/v1/orders?limit=50")),
    optional(api("/v1/requests?limit=100")),
    optional(api("/v1/brokers")),
    optional(api("/v1/audit?limit=100&type=hook.signal")),
  ]);
  const accounts = accountsR.data.data ?? [];
  const hooks = hooksR.data?.data ?? [];
  const keys = keysR.data?.data ?? [];
  const safety = safetyR.data?.data ?? null;
  const health = healthR.data ?? null;
  const demo = app.state.demo === true;
  const names = new Map((brokersR.data?.data ?? []).map((b) => [b.id, b.name ?? b.id]));
  const sources = sourceRows({ hooks, keys });
  const brokers = brokerRows(accounts, names);
  const status = bridgeStatus({ health, safety, accounts, demo });
  const steps = setupSteps({ demo, accounts, keys, hooks, orders: ordersR.data?.data ?? [] });
  const mapCard = card({
    glyph: "integrations",
    tint: "indigo",
    title: "How your Bridge is wired",
    sub: "Alerts and tools on the left reach your brokers on the right through one API, one set of limits and one set of safety checks.",
    actions: go("Add a source", "#/api/integrations", "small"),
    body: bridgeMap({ sources, brokers, safety, version: health?.version ?? app.state.meta?.bridgeVersion }),
    cls: "hm-map-card",
  });
  const nodes = [statusCard({ status, health, sources, brokers, demo }), mapCard];
  // The budget's first reading can arrive before these nodes are in the page, so it looks its targets up in them.
  const budget = budgetCard((id) => nodes.map((n) => n.querySelector(`#${id}`)).find(Boolean) ?? null);
  stopBudget = budget.stop;
  const lower = [budget.el];
  if (steps.some((s) => !s.done)) lower.push(setupCard(steps));
  if (hooks.length) lower.push(alertsCard(alertRows(auditR.data?.data ?? [], hooks)));
  lower.push(trafficCard(externalRequests(requestsR.data?.data ?? [], keyIdOf(currentKey())), requestsR.error));
  nodes.push(h("div", { class: "hm-grid" }, lower));
  return nodes;
}
