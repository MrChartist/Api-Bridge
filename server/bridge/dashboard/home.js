// Home: the Bridge at a glance. One status line, then the map the product is named for: what sends to the Bridge on
// the left (alert services through webhooks, tools through API keys), the Bridge and its gates in the middle (rate
// limits, safety, paper or live), the broker accounts on the right. Under it: the broker API budget (live, from the
// shared connection in live.js), the steps left to finish a setup, what became of the latest alerts, and the latest calls from other tools.
//
// Pure helpers (sourceRows, brokerRows, bridgeStatus, setupSteps, alertRows, uptimeText, externalRequests) are exported
// for tests; the DOM code runs only in a browser. Numbers become text through format.js. No style attributes (CSP):
// geometry goes into SVG attributes, sizes into CSS custom properties set from script.
import { api, app, card, currentKey, h, icon, iconTile, istTime, modal, optional, pill } from "./app.js";
import { budgetView, shareTone, windowText } from "./budget.js";
import { sessionText } from "./flows.js";
import { DASH, formatInt } from "./format.js";
import * as live from "./live.js";

/** Alert services that post to a hook URL (hooks/receivers/*.mjs), in the order of the map. */
export const HOOK_SOURCES = Object.freeze([
  { id: "tradingview", name: "TradingView", short: "TradingView", icon: "chart", tint: "blue", hint: "Strategy and indicator alerts" },
  { id: "chartink", name: "ChartInk", short: "ChartInk", icon: "scan", tint: "orange", hint: "Scan alerts" },
  { id: "gocharting", name: "GoCharting", short: "GoCharting", icon: "wave", tint: "teal", hint: "Chart alerts" },
  { id: "generic", name: "Signed webhooks", short: "Webhooks", icon: "bolt", tint: "purple", hint: "Your own servers and scripts" },
]);

/** Tools that call the API with a key, by the key's client kind (auth/keyStore.mjs CLIENT_KINDS). */
export const KEY_SOURCES = Object.freeze([
  { id: "script", name: "Python and Node", short: "Scripts", icon: "console", tint: "indigo", tool: "python", hint: "SDKs, REST and WebSocket" },
  { id: "excel", name: "Excel and Sheets", short: "Excel", icon: "columns", tint: "green", tool: "excel", hint: "Live prices in a workbook" },
  { id: "mcp", name: "AI assistants", short: "AI assistants", icon: "radar", tint: "pink", tool: "claude", hint: "Claude and ChatGPT tools" },
  { id: "other", name: "AmiBroker and more", short: "AmiBroker", icon: "bars", tint: "gray", tool: "amibroker", hint: "Anything that speaks HTTP" },
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
    { id: "key", done: key, title: "Connect a tool", text: "Python, Excel, AmiBroker or an AI assistant. No key is needed on this computer; a key holds a tool to less.", to: "#/api/integrations?tool=python", cta: "Connect a tool" },
    { id: "source", done: hooks.length > 0, title: "Connect an alert source", text: "TradingView, ChartInk, GoCharting or your own signed webhook.", to: "#/api/integrations?tool=webhooks&source=tradingview", cta: "Connect TradingView" },
    { id: "order", done: placed, title: "Send a paper order", text: "Try the whole path with practice money before anything is live.", to: "#/orders?new=1", cta: "New order" },
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
      return { at: r.at, status: text, tone, side: d.side === "BUY" || d.side === "SELL" ? d.side : null, symbol: d.symbol ?? null, title: [d.side, d.symbol].filter(Boolean).join(" ") || "Alert", hook: label.get(d.hookId) ?? d.hookId ?? "Deleted hook", note: d.reason || SIGNAL_NOTE[d.status] || "" };
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
  // Connected sources are rows, each with its own link to the Bridge. The rest are a grid of icons to pick from,
  // as on a home screen: nothing that is not set up yet takes a row or draws a line.
  const on = sources.filter((s) => s.active);
  const off = sources.filter((s) => !s.active);
  const inCol = h(
    "div",
    { class: "hm-col in" },
    colHead("Sources", activeSources ? `${formatInt(activeSources)} connected` : "Nothing connected yet"),
    h(
      "div",
      { class: "hm-rows" },
      on.length
        ? on.map((s) => mapRow({ tile: iconTile(s.icon, s.tint), name: s.name, sub: s.lastAt ? `${s.status} · last ${istTime(s.lastAt)}` : s.status, to: s.to, on: true, label: `${s.name}: ${s.status}` }))
        : h("div", { class: "hm-row hm-slot", "data-on": "0" }, iconTile("plus", "gray"), h("span", { class: "names" }, h("span", { class: "nm" }, "No source yet"), h("span", { class: "sub" }, "Pick one below and it appears here"))),
    ),
    off.length
      ? h(
          "div",
          { class: "hm-pick" },
          h("span", { class: "hm-pick-label" }, on.length ? "Add another" : "Add a source"),
          h("div", { class: "hm-tiles" }, off.map((s) => h("a", { class: "hm-tile", href: s.to, title: s.hint, "aria-label": `Set up ${s.name}: ${s.hint}` }, iconTile(s.icon, s.tint, "lg"), h("span", {}, s.short ?? s.name)))),
        )
      : null,
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
  // The connected links draw themselves in once, when Home first opens (home.css); a resize or a refresh after new
  // activity shows them at rest.
  if (mapShown) map.classList.add("drawn");
  else setTimeout(() => map.classList.add("drawn"), 900);
  mapShown = true;
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
      figure("Sources", formatInt(active), active ? "connected" : "none yet"),
      figure("Accounts", `${formatInt(ready)}/${formatInt(brokers.length)}`, "ready"),
      figure("Calls today", DASH, "counting", "hm-calls"),
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
    if (sub) sub.textContent = `${formatInt(msg?.savedToday ?? 0)} more saved`;
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
    actions: go("Welcome guide", "#/home?welcome=1", "small quiet"),
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
    title: "Latest API calls",
    sub: "What your tools sent to the Bridge.",
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
          rows.map((r) => h("li", {}, h("span", { class: `hm-code wide ${r.tone || "quiet"}` }, r.status), h("span", { class: "names" }, h("span", { class: "nm" }, r.side ? [h("span", { class: "order-side", "data-side": r.side }, r.side), " ", r.symbol ?? ""] : r.title), h("span", { class: "sub" }, [r.hook, r.note].filter(Boolean).join(" · "))), h("span", { class: "muted small" }, istTime(r.at)))),
        )
      : h("p", { class: "hm-empty muted small" }, "No alert has arrived yet. Send one from your charting tool and it shows up here within a second, placed or refused, with the reason."),
  });
}

// ── The welcome guide: shown once, the first time the dashboard opens after an install ──

/** localStorage slot: "1" once the guide was seen (or closed). */
export const WELCOMED_SLOT = "mcb.dashboard.welcomed";

/**
 * The pages of the welcome guide (pure): a hello, then the two things that make the Bridge useful (a broker, a source
 * of alerts), then where to look. Each page is { id, title, text, primary: [label, hash | null], later: label | null }:
 * a primary with a hash closes the guide and opens that page; null moves on to the next page.
 */
export function welcomePages({ demo = false, brokerConnected = false, hasSource = false } = {}) {
  return [
    {
      id: "hello",
      title: "Welcome to API Bridge",
      text: "One place for your broker accounts and the tools that trade through them. It runs on this computer, and every order is a practice order until you decide otherwise.",
      primary: ["Get started", null],
      later: null,
    },
    {
      id: "broker",
      title: "Connect your broker",
      text: demo
        ? "You are in demo mode: sample prices stand in for a broker, so you can look around first. Add your own broker whenever you like."
        : brokerConnected
          ? "Your broker is connected. You can add more brokers, or more accounts with the same broker, at any time."
          : "Pick your broker and log in. It takes about a minute, and your login stays on this computer.",
      primary: demo || brokerConnected ? ["Next", null] : ["Add my broker", "#/accounts?add=1"],
      later: demo || brokerConnected ? null : "Later",
    },
    {
      id: "source",
      title: "Send it your alerts",
      text: hasSource
        ? "An alert source is already connected. Each alert shows up on Home with what the Bridge did with it."
        : "Alerts from TradingView, ChartInk and GoCharting become orders. Create a webhook and the Bridge writes the alert message for you to paste.",
      primary: hasSource ? ["Next", null] : ["Connect TradingView", "#/api/integrations?tool=webhooks&source=tradingview"],
      later: hasSource ? null : "Later",
    },
    {
      id: "ready",
      title: "You are ready",
      text: "Home shows what is connected and what happened to every alert. Nothing on this computer needs a key, and real orders stay off until you switch them on.",
      primary: ["Open my Bridge", null],
      later: null,
    },
  ];
}

/** Show the welcome guide. Resolves when it is closed. */
export function showWelcome(state = {}) {
  const pages = welcomePages(state);
  try {
    app.local?.set?.(WELCOMED_SLOT, "1");
  } catch {
    /* storage off: the guide shows again next time */
  }
  return modal({
    title: "Welcome",
    body: (close) => {
      let at = 0;
      const mark = h("span", { class: "hm-mark wl-mark", "aria-hidden": "true" });
      const sym = svgEl("svg", { viewBox: "0 0 1024 1024", focusable: "false" });
      sym.append(svgEl("use", { href: "#mc-symbol" }));
      mark.append(sym);
      const title = h("h3", { class: "wl-title" });
      const text = h("p", { class: "wl-text" });
      const dots = h("div", { class: "wl-dots", "aria-hidden": "true" });
      const count = h("span", { class: "wl-count", role: "status" });
      const primary = h("button", { type: "button", class: "primary wide" });
      const later = h("button", { type: "button", class: "wide quiet" });
      const next = () => {
        if (at >= pages.length - 1) return close(undefined, true);
        at += 1;
        draw();
      };
      const draw = () => {
        const p = pages[at];
        title.textContent = p.title;
        text.textContent = p.text;
        primary.textContent = p.primary[0];
        later.textContent = p.later ?? "";
        later.hidden = !p.later;
        count.textContent = `Step ${at + 1} of ${pages.length}`;
        dots.replaceChildren(...pages.map((_, i) => h("i", { class: i === at ? "on" : "" })));
      };
      primary.addEventListener("click", () => {
        const to = pages[at].primary[1];
        if (!to) return next();
        close(undefined, true);
        location.hash = to;
      });
      later.addEventListener("click", next);
      draw();
      return h("div", { class: "wl" }, mark, title, text, dots, count, h("div", { class: "wl-actions" }, primary, later));
    },
  });
}

let stopBudget = null;
/** True once the map has been drawn in this tab (its links animate in only the first time). */
let mapShown = false;
/** How often Home looks for new alerts, hooks and calls while it is open. */
export const HOME_REFRESH_MS = 4000;

/** What Home would look different for (pure): the newest alert, the hooks, the newest outside call, the kill switch. */
export function activityMark({ audit = [], hooks = [], requests = [], safety = null } = {}) {
  return [audit[0]?.seq ?? audit[0]?.at ?? "", hooks.map((x) => `${x.id}:${x.lastSignalAt ?? ""}`).join(","), requests[0]?.requestId ?? requests[0]?.at ?? "", safety?.killSwitch?.engaged ? 1 : 0].join("|");
}

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
  // First open after an install (or #/home?welcome=1 from the setup card): the welcome guide, once the page is drawn.
  const asked = /[?&]welcome=1/.test(location.hash);
  let welcomed = true;
  try {
    welcomed = app.local?.get?.(WELCOMED_SLOT) === "1";
  } catch {
    welcomed = true;
  }
  if (asked || !welcomed) {
    if (asked && typeof history !== "undefined") history.replaceState(history.state, "", "#/home");
    const brokerConnected = accounts.some((a) => a.broker !== "paper" && a.broker !== "demo" && a.session?.state === "connected");
    setTimeout(() => showWelcome({ demo, brokerConnected, hasSource: hooks.length > 0 }), 350);
  }
  // Home stays current by itself: every few seconds it reads the few things that change (alerts, hooks, calls from
  // tools, the kill switch) and redraws only when one of them did, so an alert shows up without a reload.
  const ownKey = keyIdOf(currentKey());
  const mark = activityMark({ audit: auditR.data?.data ?? [], hooks, requests: externalRequests(requestsR.data?.data ?? [], ownKey, 1), safety });
  import("./views.js").then(({ every }) =>
    every(HOME_REFRESH_MS, async () => {
      const [a, hk, rq, sf] = await Promise.all([optional(api("/v1/audit?limit=1&type=hook.signal")), optional(api("/v1/hooks", { fresh: true })), optional(api("/v1/requests?limit=100")), optional(api("/v1/safety"))]);
      const now = activityMark({ audit: a.data?.data ?? [], hooks: hk.data?.data ?? [], requests: externalRequests(rq.data?.data ?? [], ownKey, 1), safety: sf.data?.data ?? null });
      if (now !== mark && location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] in { "": 1, home: 1 }) dispatchEvent(new HashChangeEvent("hashchange"));
    }),
  );
  return nodes;
}
