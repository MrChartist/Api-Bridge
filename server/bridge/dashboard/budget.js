// The API budget indicator in the top bar: the broker budget used this second and this minute (the fullest window
// over every account), the live stream's state, and how many broker calls caching, the stream and shared calls saved
// today. Fed by `budget` messages on the shared live connection (live.js), so it costs no polling. Clicking it opens
// a short popover per account with a link to API › Rate limits.
// Pure helpers (budgetView, savedParts) are exported for tests; the DOM code runs only in a browser.

import { h, sheetPopover } from "./app.js";
import { DASH, formatInt } from "./format.js";

/** Tone of a window by how full it is: "ok" below 70 %, "warn" to 90 %, "bad" above. */
export function shareTone(used, limit) {
  if (!(limit > 0)) return "ok";
  const s = used / limit;
  return s >= 0.9 ? "bad" : s >= 0.7 ? "warn" : "ok";
}

/** "3/10" for a window, DASH when unknown (pure). */
export const windowText = (w) => (w && w.limit > 0 ? `${formatInt(w.used)}/${formatInt(w.limit)}` : DASH);

/**
 * What the indicator shows for one budget message (pure): the fullest second and minute window across accounts, the
 * overall tone, and the stream state ("live" when a broker feed is up, "off" when none is open, "down" otherwise).
 * @param {{ accounts?: object[], savedToday?: number, callsToday?: number, stream?: { feeds: number, up: number } } | null} msg
 * @param {string} [conn]  the dashboard's own live connection state (live.js liveState)
 */
export function budgetView(msg, conn = "off") {
  const accounts = msg?.accounts ?? [];
  const pick = (k) => {
    let best = null;
    for (const a of accounts) {
      const w = a[k];
      if (!w || !(w.limit > 0)) continue;
      if (!best || w.used / w.limit > best.used / best.limit) best = { ...w, accountId: a.accountId };
    }
    return best;
  };
  const second = pick("second");
  const minute = pick("minute");
  const backoff = accounts.some((a) => a.backoffMs > 0);
  const tones = [second && shareTone(second.used, second.limit), minute && shareTone(minute.used, minute.limit), backoff ? "bad" : null].filter(Boolean);
  const tone = tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : "ok";
  const feeds = msg?.stream?.feeds ?? 0;
  const up = msg?.stream?.up ?? 0;
  const stream = conn !== "live" ? (conn === "connecting" ? "connecting" : "down") : feeds === 0 ? "off" : up === feeds ? "live" : "down";
  return {
    hasBrokers: accounts.length > 0,
    second,
    minute,
    tone,
    backoff,
    stream,
    savedToday: msg?.savedToday ?? 0,
    callsToday: msg?.callsToday ?? 0,
  };
}

/** The saved-today breakdown as [label, count] pairs, largest first (pure). */
export function savedParts(savings = {}) {
  return [
    ["Live stream", savings.servedFromStream ?? 0],
    ["Cache", savings.servedFromCache ?? 0],
    ["Shared calls", savings.coalesced ?? 0],
    ["Batched", savings.batched ?? 0],
  ].sort((a, b) => b[1] - a[1]);
}

const STREAM_TEXT = { live: "Stream live", off: "No stream open", down: "Stream down", connecting: "Connecting" };

/**
 * Mount the indicator into `host` (the toolbar slot). Returns a function that stops it.
 * @param {HTMLElement} host
 * @param {{ onBudget: (fn: Function) => Function, liveState: () => string, onLiveState: (fn: Function) => Function }} live
 */
export function mountBudget(host, live) {
  let msg = null;
  const dot = h("span", { class: "bud-dot", "aria-hidden": "true" });
  const sec = h("span", { class: "bud-num" }, DASH);
  const min = h("span", { class: "bud-num bud-min" }, DASH);
  const btn = h(
    "button",
    { type: "button", class: "toolbar-budget-btn glass", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Broker API budget: calls this second and this minute" },
    dot,
    h("span", { class: "bud-lbl" }, "API"),
    sec,
    h("span", { class: "bud-sep", "aria-hidden": "true" }, "·"),
    min,
  );
  host.replaceChildren(btn);
  let popBody = null;
  const draw = () => {
    const v = budgetView(msg, live.liveState());
    host.hidden = !v.hasBrokers;
    host.dataset.tone = v.tone;
    host.dataset.stream = v.stream;
    sec.textContent = v.second ? `${windowText(v.second)} s` : DASH;
    min.textContent = v.minute ? `${windowText(v.minute)} min` : DASH;
    btn.setAttribute("aria-label", `Broker API budget: ${v.second ? `${windowText(v.second)} this second` : "no per-second limit"}, ${v.minute ? `${windowText(v.minute)} this minute` : "no per-minute limit"}. ${STREAM_TEXT[v.stream]}. ${formatInt(v.savedToday)} calls saved today.`);
    if (popBody?.isConnected) popBody.replaceChildren(...popContent(msg, v));
  };
  btn.addEventListener("click", () => {
    popBody = h("div", { class: "bud-pop" });
    popBody.replaceChildren(...popContent(msg, budgetView(msg, live.liveState())));
    btn.setAttribute("aria-expanded", "true");
    sheetPopover({ trigger: btn, title: "API budget", body: popBody, cls: "bud-popover", onClose: () => (popBody = null) });
  });
  const offBudget = live.onBudget((m) => {
    msg = m;
    draw();
  });
  const offState = live.onLiveState(() => draw());
  host.hidden = true;
  return () => {
    offBudget();
    offState();
  };
}

function popContent(msg, v) {
  const rows = (msg?.accounts ?? []).map((a) =>
    h(
      "div",
      { class: "bud-acct" },
      h("div", { class: "bud-acct-head" }, h("strong", {}, a.accountId), h("span", { class: "muted" }, a.broker), a.backoffMs > 0 ? h("span", { class: "pill bad tiny" }, "Backing off") : null),
      h(
        "div",
        { class: "bud-wins" },
        winRow("This second", a.second),
        winRow("This minute", a.minute),
        h("div", { class: "bud-win" }, h("span", { class: "muted" }, "Today"), h("span", { class: "bud-num" }, `${formatInt(a.callsToday)} calls`)),
      ),
    ),
  );
  const parts = savedParts(msg?.savings);
  return [
    h("div", { class: `bud-stream bud-${v.stream}` }, h("span", { class: "bud-dot", "aria-hidden": "true" }), STREAM_TEXT[v.stream], msg?.stream?.subscriptions ? h("span", { class: "muted" }, `${formatInt(msg.stream.subscriptions)} symbols`) : null),
    ...rows,
    h(
      "div",
      { class: "bud-saved" },
      h("div", { class: "bud-saved-head" }, h("span", {}, "Saved today"), h("strong", { class: "bud-num" }, `${formatInt(v.savedToday)} calls`)),
      h("div", { class: "bud-saved-parts" }, parts.filter(([, n]) => n > 0).map(([label, n]) => h("span", { class: "bud-part" }, h("span", { class: "muted" }, label), h("span", { class: "bud-num" }, formatInt(n))))),
    ),
    h("a", { href: "#/api/limits", class: "bud-more" }, "Rate limits and top consumers"),
  ];
}

// ── API › Rate limits: calls per second against the limit, and who used the budget ──

/**
 * The class to chart for an account (pure): the one with the most calls in its two-minute history, else the one with
 * the most calls today, else "quote".
 */
export function busiestClass(account) {
  const series = account?.series?.classes ?? {};
  let best = null;
  for (const [cls, xs] of Object.entries(series)) {
    const n = xs.reduce((a, b) => a + b, 0);
    if (!best || n > best[1]) best = [cls, n];
  }
  if (best) return best[0];
  let today = null;
  for (const [cls, c] of Object.entries(account?.classes ?? {})) if (!today || (c.callsToday ?? 0) > today[1]) today = [cls, c.callsToday ?? 0];
  return today && today[1] > 0 ? today[0] : "quote";
}

/** The per-second limit of a class from its windows ("1s"), else null (pure). */
export function perSecondLimit(cls) {
  const w = (cls?.windows ?? []).filter((x) => x.window === "1s" && x.limit > 0);
  return w.length ? Math.min(...w.map((x) => x.limit)) : null;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k) e.append(k);
  return e;
}

/**
 * A bar chart of calls per second over the last two minutes for one class, with the per-second limit as a dashed
 * line; bars at 90 % of the limit or more are drawn in the warning colour. The SVG stretches to its box and carries no
 * text (labels sit in HTML around it, so they keep their size on every screen).
 * @param {number[]} counts  one per second, oldest first
 * @param {number|null} limit
 * @param {string} label  accessible name
 */
export function usageChart(counts, limit, label) {
  const W = 600;
  const H = 120;
  const max = Math.max(1, limit ?? 0, ...counts) * 1.15;
  const n = Math.max(1, counts.length);
  const bw = W / n;
  const y = (v) => H * (1 - v / max);
  const root = svg("svg", { class: "rl-chart", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": label });
  for (const f of [0.25, 0.5, 0.75]) root.append(svg("line", { class: "rl-grid", x1: 0, x2: W, y1: H * f, y2: H * f, "vector-effect": "non-scaling-stroke" }));
  counts.forEach((v, i) => {
    if (!v) return;
    const near = limit && v >= 0.9 * limit;
    root.append(svg("rect", { class: `rl-bar${near ? " near" : ""}`, x: i * bw + 0.5, y: y(v), width: Math.max(1, bw - 1), height: Math.max(1, H - y(v)) }));
  });
  if (limit) root.append(svg("line", { class: "rl-limit", x1: 0, x2: W, y1: y(limit), y2: y(limit), "vector-effect": "non-scaling-stroke" }));
  return root;
}

function winRow(label, w) {
  const tone = w ? shareTone(w.used, w.limit) : "ok";
  const pct = w && w.limit > 0 ? Math.min(100, Math.round((w.used / w.limit) * 100)) : 0;
  const bar = h("span", { class: `bud-bar ${tone}`, "aria-hidden": "true" }, h("i"));
  bar.firstChild.style.setProperty("--w", `${pct}%`);
  return h("div", { class: "bud-win" }, h("span", { class: "muted" }, label), bar, h("span", { class: "bud-num" }, w ? windowText(w) : DASH));
}
