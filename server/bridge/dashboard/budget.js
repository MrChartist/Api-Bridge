// The API budget indicator in the top bar: the broker budget used this second and this minute (the fullest window
// over every account), the live stream's state, and how many broker calls caching, the stream and shared calls saved
// today. Fed by `budget` messages on the shared live connection (live.js), so it costs no polling. Clicking it opens
// a short popover per account with a link to Sources.
// Pure helpers (budgetView, savedParts) are exported for tests; the DOM code runs only in a browser.

import { h, sheetPopover } from "./app.js";
import { DASH, formatInt, plural } from "./format.js";
import { countTo, patchList, setAttr, setClass, setText } from "./motion.js";
import { LIMIT_TONES } from "./sources-core.js";

/** Tone of a window by how full it is, on the same scale as the Sources page: "ok" below 80 %, "warn" to 95 %, "bad" above. */
export function shareTone(used, limit) {
  if (!(limit > 0)) return "ok";
  const s = used / limit;
  return s >= LIMIT_TONES.limit ? "bad" : s >= LIMIT_TONES.headsUp ? "warn" : "ok";
}

/** "3/10" for a window, DASH when unknown (pure). */
export const windowText = (w) => (w && w.limit > 0 ? `${formatInt(w.used)}/${formatInt(w.limit)}` : DASH);

/**
 * A live "3/10 s" cell. Built once into `host`; each message only changes the used count (a counter, tabular figures, in a
 * box as wide as the limit's digits so the chip and rows never change width as the count goes from 9 to 10 to 100), the
 * "/10 s" text node and the dash, never the nodes. Returns `set(window)`.
 * @param {HTMLElement} host
 * @param {string} [unit]
 */
function liveWindow(host, unit = "") {
  const used = h("span", { class: "bud-used" });
  const tail = document.createTextNode("");
  const text = h("span", { class: "bud-win-text" }, used, tail);
  const dash = document.createTextNode(DASH);
  host.replaceChildren(dash);
  return (w) => {
    if (!(w && w.limit > 0)) {
      if (host.firstChild !== dash) host.replaceChildren(dash);
      return;
    }
    if (host.firstChild !== text) host.replaceChildren(text);
    const digits = String(formatInt(w.limit).length);
    if (used.style.getPropertyValue("--d") !== digits) used.style.setProperty("--d", digits);
    const t = `/${formatInt(w.limit)}${unit ? ` ${unit}` : ""}`;
    if (tail.data !== t) tail.data = t;
    countTo(used, w.used, { format: formatInt });
  };
}

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
 * Mount the indicator into `host` (the toolbar slot). Returns a function that stops it. Everything is built once: a budget
 * message (every second or so) patches text nodes, attributes and bar widths in place, so nothing is rebuilt, a transition
 * is never cut short, and focus and scroll stay where they are.
 * @param {HTMLElement} host
 * @param {{ onBudget: (fn: Function) => Function, liveState: () => string, onLiveState: (fn: Function) => Function }} live
 */
export function mountBudget(host, live) {
  let msg = null;
  const dot = h("span", { class: "bud-dot", "aria-hidden": "true" });
  const sec = h("span", { class: "bud-num" });
  const min = h("span", { class: "bud-num bud-min" });
  const setSec = liveWindow(sec, "s");
  const setMin = liveWindow(min, "min");
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
  let pop = null;
  const draw = () => {
    const v = budgetView(msg, live.liveState());
    host.hidden = !v.hasBrokers;
    setAttr(host, "data-tone", v.tone);
    setAttr(host, "data-stream", v.stream);
    setSec(v.second);
    setMin(v.minute);
    const job = (msg?.jobs ?? [])[0];
    setAttr(host, "data-job", job ? "1" : "");
    const fill = v.tone === "bad" ? " Near the limit." : v.tone === "warn" ? " Getting full." : "";
    setAttr(btn, "aria-label", `Broker API budget: ${v.second ? `${windowText(v.second)} calls this second` : "no per-second limit"}, ${v.minute ? `${windowText(v.minute)} calls this minute` : "no per-minute limit"}.${fill} ${STREAM_TEXT[v.stream]}. ${plural(v.savedToday, "call")} saved today.${job ? ` ${job.label} ${jobText(job)}.` : ""}`);
    if (pop?.el.isConnected) pop.update(msg, v);
  };
  btn.addEventListener("click", () => {
    pop = buildPop();
    pop.update(msg, budgetView(msg, live.liveState()));
    btn.setAttribute("aria-expanded", "true");
    sheetPopover({ trigger: btn, title: "API budget", body: pop.el, cls: "bud-popover", onClose: () => (pop = null) });
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

/** One "label, bar, 3/10" row whose pieces are patched in place (`set(window)`). */
function liveRow(label) {
  const fill = h("i");
  const bar = h("span", { class: "bud-bar ok", "aria-hidden": "true" }, fill);
  const num = h("span", { class: "bud-num" });
  const setWin = liveWindow(num);
  const el = h("div", { class: "bud-win" }, h("span", { class: "muted" }, label), bar, num);
  let pct = -1;
  return {
    el,
    set(w) {
      const tone = w ? shareTone(w.used, w.limit) : "ok";
      for (const t of ["ok", "warn", "bad"]) setClass(bar, t, t === tone);
      const next = w && w.limit > 0 ? Math.min(100, Math.round((w.used / w.limit) * 100)) : 0;
      if (next !== pct) {
        pct = next;
        fill.style.setProperty("--w", `${next}%`);
      }
      setWin(w);
    },
  };
}

/** One account's block, drawn once per account id and patched afterwards. */
function acctBlock(a, el) {
  if (!el) {
    const r = { name: h("strong"), broker: h("span", { class: "muted" }), back: h("span", { class: "pill bad tiny", hidden: true }, "Backing off"), sec: liveRow("This second"), min: liveRow("This minute"), today: h("span", { class: "bud-num" }) };
    el = h("div", { class: "bud-acct" }, h("div", { class: "bud-acct-head" }, r.name, r.broker, r.back), h("div", { class: "bud-wins" }, r.sec.el, r.min.el, h("div", { class: "bud-win bud-today" }, h("span", { class: "muted" }, "Today"), r.today)));
    el.__r = r;
  }
  const r = el.__r;
  setText(r.name, a.accountId);
  setText(r.broker, a.broker ?? "");
  r.back.hidden = !(a.backoffMs > 0);
  r.sec.set(a.second);
  r.min.set(a.minute);
  countTo(r.today, a.callsToday ?? 0, { format: (n) => plural(n, "call") });
  return el;
}

/** A background job's row (a bar and "34/200"). */
function jobBlock(j, el) {
  if (!el) {
    const fill = h("i");
    el = h("div", { class: "bud-win" }, h("span", { class: "muted" }), h("span", { class: "bud-bar ok", "aria-hidden": "true" }, fill), h("span", { class: "bud-num" }));
    el.__r = { label: el.children[0], fill, text: el.children[2] };
  }
  const r = el.__r;
  setText(r.label, j.label);
  r.fill.style.setProperty("--w", `${j.total > 0 ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0}%`);
  setText(r.text, jobText(j));
  return el;
}

/** One "Cache  123" part of the saved-today breakdown. */
function partBlock([label, n], el) {
  if (!el) {
    el = h("span", { class: "bud-part" }, h("span", { class: "muted" }), h("span", { class: "bud-num" }));
    el.__r = { label: el.children[0], n: el.children[1] };
  }
  setText(el.__r.label, label);
  countTo(el.__r.n, n, { format: formatInt });
  return el;
}

/**
 * The popover's body, built once. `update(msg, view)` patches the stream line, the per-account blocks (keyed by account id),
 * the job rows and the saved-today numbers in place; accounts and jobs that come and go fade in and out.
 */
function buildPop() {
  const dot = h("span", { class: "bud-dot", "aria-hidden": "true" });
  const streamText = document.createTextNode("");
  const symbols = h("span", { class: "muted", hidden: true });
  const stream = h("div", { class: "bud-stream" }, dot, streamText, symbols);
  const accounts = h("div", { class: "bud-accts" });
  const jobs = h("div", { class: "bud-jobs", hidden: true });
  const savedNum = h("strong", { class: "bud-num" });
  const parts = h("div", { class: "bud-saved-parts" });
  const saved = h("div", { class: "bud-saved" }, h("div", { class: "bud-saved-head" }, h("span", {}, "Saved today"), savedNum), parts);
  const more = h("a", { href: "#/sources/overview", class: "bud-more" }, "Sources, limits and top consumers");
  const el = h("div", { class: "bud-pop" }, stream, accounts, jobs, saved, more);
  let first = true;
  return {
    el,
    update(msg, v) {
      setAttr(stream, "class", `bud-stream bud-${v.stream}`);
      if (streamText.data !== STREAM_TEXT[v.stream]) streamText.data = STREAM_TEXT[v.stream];
      const n = msg?.stream?.subscriptions;
      symbols.hidden = !n;
      if (n) setText(symbols, plural(n, "symbol"));
      patchList(accounts, msg?.accounts ?? [], (a) => a.accountId, acctBlock, { animate: !first });
      const js = msg?.jobs ?? [];
      jobs.hidden = js.length === 0;
      patchList(jobs, js, (j) => j.label, jobBlock, { animate: !first });
      countTo(savedNum, v.savedToday, { format: (x) => plural(x, "call") });
      patchList(parts, savedParts(msg?.savings).filter(([, c]) => c > 0), ([label]) => label, partBlock, { animate: !first });
      first = false;
    },
  };
}

/** "34/200", or "34/200 · paused" while a person is using the broker (pure). */
export const jobText = (j) => `${formatInt(j?.done ?? 0)}/${formatInt(j?.total ?? 0)}${j?.paused ? " · paused" : ""}`;
