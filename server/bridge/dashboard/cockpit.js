// Home as a trader's cockpit. Top down: four hero cards (P&L today, the market clock, the next expiry, safety), each
// with one figure and a small picture; the indices strip with each index's day range; then the cards: Key levels for
// one underlying (expected move, the walls, max pain, PCR, ATM IV, gamma flip on one price ruler), open positions,
// market movers, headlines, live events, the Home watchlist, and accounts with their health. Every figure becomes
// text through format.js; the maths is today-core.js and alert-core.js (pure, tested). Reads only: nothing here
// places an order.
import { api, app, card, emptyState, h, iconTile, loadingState, optional, pill, store } from "./app.js";
import { headlinesCard, moversCard } from "./pulse.js";
import { DASH, formatCompact, formatFixed, formatGrouped, formatInt, formatPercent, formatSigned, formatSignedRupee, formatRupee, isFigure } from "./format.js";
import { bookGroups } from "./alert-core.js";
import { contractName, orderStatusText, sessionText, startupText } from "./flows.js";
import { watch } from "./live.js";
import { badgeModel, lastReadiness } from "./readiness.js";
import { badgeLanes } from "./vol-suite-core.js";
import { dataLine, dayText, eventSplit, homeSummary, keyLevels, levelAxis, marketClock, pnlBars, readinessChecks, upcomingExpiries } from "./today-core.js";
import { segmented } from "./views.js";
import { briefStrip } from "./brief.js";

const INDICES = ["NSE:NIFTY", "NSE:BANKNIFTY", "NSE:FINNIFTY", "NSE:MIDCPNIFTY", "BSE:SENSEX", "NSE:INDIAVIX"];
const NAMES = { NIFTY: "NIFTY 50", BANKNIFTY: "BANK NIFTY", FINNIFTY: "FIN NIFTY", MIDCPNIFTY: "MIDCAP SELECT", SENSEX: "SENSEX", INDIAVIX: "INDIA VIX" };
/** The underlyings Key levels can follow (the three with a reference bundle on Home). */
const LEVEL_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "SENSEX"];
const LEVELS_U_KEY = "mcb.home.levelsUnderlying";
const TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "short" });
const num = (v) => (isFigure(v) ? Number(v) : null);
const tone = (v) => (num(v) === null || v === 0 ? "" : v > 0 ? "up" : "down");
const signed = (v, cls = "") => h("span", { class: `${tone(v)} ${cls}`.trim() }, num(v) === null ? DASH : formatSignedRupee(v, 0));
const istToday = (ms) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);
const local = store("local");
const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  el.append(...kids.filter(Boolean));
  return el;
};
/** Points from spot in words: "+510 above", "190 below", "At spot". */
const distText = (d) => (num(d) === null ? "" : Math.abs(d) < 0.5 ? "At spot" : d > 0 ? `${formatInt(d)} above` : `${formatInt(-d)} below`);

// ── Hero cards: one figure, one line, one small picture ──

/** A hero card (IPO Decode's Today cards): tinted glyph and label, the figure, a sub line, a picture on the right. */
function heroCard({ cls, glyph, tint, label, href, title }) {
  const value = h("span", { class: "ck-stat-v" }, DASH);
  const sub = h("span", { class: "ck-stat-s" }, "");
  const pic = h("span", { class: "ck-stat-pic", "aria-hidden": "true" });
  const el = h("a", { class: `card ck-stat ${cls}`, href, title }, h("span", { class: "ck-stat-h" }, iconTile(glyph, tint, "sm"), h("span", {}, label)), value, sub, pic);
  return {
    el,
    set({ v, vCls = "", s = "", p = null, aria = null }) {
      if (value.textContent !== v) value.textContent = v;
      value.className = `ck-stat-v ${vCls}`.trim();
      if (sub.textContent !== s) sub.textContent = s;
      if (p) pic.replaceChildren(p);
      if (aria) el.setAttribute("aria-label", aria);
    },
  };
}

/** A progress ring with a word or figure in it: `frac` 0–1, `cls` the arc's tone (ok, warn, bad, or none). */
function ring(frac, text, cls = "") {
  const r = 22;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, num(frac) ?? 0));
  return svg(
    "svg",
    { class: `ck-ring ${cls}`.trim(), viewBox: "0 0 56 56", width: 56, height: 56 },
    svg("circle", { class: "ck-ring-track", cx: 28, cy: 28, r }),
    svg("circle", { class: "ck-ring-arc", cx: 28, cy: 28, r, "stroke-dasharray": `${c * f} ${c}`, transform: "rotate(-90 28 28)" }),
    svg("text", { x: 28, y: 32, "text-anchor": "middle" }, text),
  );
}

/** A calendar leaf: the month on a red band, the day under it. */
const calLeaf = (iso) => h("span", { class: "ck-leaf" }, h("span", { class: "ck-leaf-m" }, MONTH.format(new Date(`${iso}T00:00:00Z`)).toUpperCase()), h("span", { class: "ck-leaf-d" }, formatInt(Number(iso.slice(8, 10)))));

/** P&L by book as small bars about a zero line, gains up in green, losses down in red. */
function pnlPic(bars) {
  if (!bars.length) return null;
  const w = 8;
  const gap = 4;
  const W = bars.length * (w + gap) - gap;
  const H = 40;
  const mid = H / 2;
  return svg(
    "svg",
    { class: "ck-bars", viewBox: `0 0 ${W} ${H}`, width: W, height: H },
    svg("line", { class: "ck-bars-zero", x1: 0, x2: W, y1: mid, y2: mid }),
    ...bars.map((b, i) => {
      const bh = Math.max(2, b.h * (mid - 2));
      return svg("rect", { class: b.v >= 0 ? "up" : "down", x: i * (w + gap), y: b.v >= 0 ? mid - bh : mid, width: w, height: bh, rx: 2 }, svg("title", {}, `${b.label} ${formatSignedRupee(b.v, 0)}`));
    }),
  );
}

// ── The indices strip ──

/** One tile per index: last price, change, and where it sits in the day's range. Refreshed in place. */
function indicesStrip() {
  const tiles = new Map();
  const el = h("section", { class: "ck-strip", "aria-label": "Indices" });
  for (const s of INDICES) {
    const name = s.split(":")[1];
    const px = h("span", { class: "ck-px" }, DASH);
    const ch = h("span", { class: "ck-ch" }, "");
    const dot = h("i");
    const rng = h("span", { class: "ck-rng", "aria-hidden": "true" }, dot);
    const t = h("a", { class: "ck-idx", href: name === "INDIAVIX" ? "#/vol" : "#/chain", title: name === "INDIAVIX" ? "Volatility" : `${NAMES[name]}: open the option chain` }, h("span", { class: "ck-name" }, NAMES[name] ?? name), px, ch, rng);
    tiles.set(s, { t, px, ch, rng, dot });
    el.append(t);
  }
  const fill = async () => {
    const r = await optional(api(`/v1/quotes?symbols=${INDICES.join(",")}`));
    const rows = r.data?.data ?? [];
    for (const q of rows) {
      const x = tiles.get(q.symbol);
      if (!x) continue;
      x.px.textContent = formatGrouped(q.ltp, 2);
      x.ch.textContent = isFigure(q.changePct) ? `${formatSigned(q.change, 2)} (${formatSigned(q.changePct, 2)}%)` : "";
      x.ch.className = `ck-ch ${tone(q.change)}`;
      const lo = num(q.low);
      const hi = num(q.high);
      const at = lo !== null && hi !== null && hi > lo && num(q.ltp) !== null ? Math.max(0, Math.min(1, (q.ltp - lo) / (hi - lo))) : null;
      x.rng.hidden = at === null;
      if (at !== null) {
        x.dot.style.left = `${Math.round(at * 1000) / 10}%`;
        x.dot.className = tone(q.change);
        x.t.title = `${NAMES[q.symbol.split(":")[1]] ?? q.symbol} · day range ${formatGrouped(lo, 2)} to ${formatGrouped(hi, 2)}`;
      }
    }
    for (const [s, x] of tiles) x.t.hidden = !rows.some((q) => q.symbol === s);
    el.hidden = !rows.length;
    return rows;
  };
  return { el, fill };
}

// ── Key levels for one underlying ──

/**
 * The option levels of one underlying's nearest expiry: the expected move as the hero, the levels on one price ruler,
 * then a tile per figure. Its own NIFTY / BANKNIFTY / SENSEX switch (remembered in this browser). `bundles` are the
 * reference bundles by underlying; `clock()` the market clock now.
 */
function levelsCard({ bundles, clock, today }) {
  const saved = local.get(LEVELS_U_KEY);
  let u = LEVEL_UNDERLYINGS.includes(saved) ? saved : "NIFTY";
  const seg = segmented("Underlying", LEVEL_UNDERLYINGS.map((x) => [x, x]), u);
  const body = h("div", { class: "ck-lv" }, loadingState({ rows: 4, cols: 4, label: "Reading the chain" }));
  const sub = h("p", {}, "Nearest expiry");
  const el = card({ glyph: "scale", tint: "indigo", title: "Key levels", sub: "", cls: "ck-card ck-a-lv", actions: h("div", { class: "row ck-lv-acts" }, seg, h("a", { class: "lk small", href: "#/chain" }, "Chain")), body });
  el.querySelector(".card-titles p")?.replaceWith(sub);
  let last = 0;
  let flipAt = 0;
  let flip = null;
  let seq = 0;
  let asOf = null;
  const dl = h("span", { class: "ck-dl" });
  const paintDl = () => {
    const d = dataLine({ phase: clock().phase, asOfMs: asOf, nowMs: Date.now() });
    dl.className = `ck-dl ${d.state}`;
    dl.textContent = d.text;
  };
  const expiryOf = (x) => upcomingExpiries([bundles.get(x)].filter(Boolean), today, 60)[0] ?? null;

  async function load(force = false) {
    const open = clock().phase === "open";
    if (!force && Date.now() - last < (open ? 15_000 : 120_000)) return paintDl();
    last = Date.now();
    const my = ++seq;
    const e = expiryOf(u);
    if (!e) return body.replaceChildren(emptyState("scale", "No expiry to read", `The reference data has no ${u} expiry ahead.`, null, { compact: true }));
    const q = new URLSearchParams({ underlying: u, expiry: e.date, strikes: "40" });
    const needFlip = force || Date.now() - flipAt > (open ? 60_000 : 600_000);
    const [c, x] = await Promise.all([optional(api(`/v1/optionchain?${q}`)), needFlip ? optional(api(`/v1/analytics/exposure?${q}`)) : null]);
    if (my !== seq) return;
    if (x) {
      flipAt = Date.now();
      flip = num(x.data?.data?.profile?.flip);
    }
    const chain = c.data?.data;
    if (!chain?.rows?.length) return body.replaceChildren(emptyState("scale", "Chain unavailable", c.error?.message ?? "The chain came back empty.", null, { compact: true }));
    asOf = Date.parse(chain.freshness?.asOf ?? "");
    if (!Number.isFinite(asOf)) asOf = null;
    sub.textContent = `${u} · expiry ${dayText(e.date)}${e.days === 0 ? " · today" : ""}`;
    draw(keyLevels(chain, { flip }), e);
  }

  function ruler(lv) {
    const ax = levelAxis(lv);
    if (!ax) return null;
    const pct = (x) => `${Math.round(x * 1000) / 10}%`;
    // Labels under the track on lanes so none covers another (label widths estimated at 6.6 px a character).
    const W = body.clientWidth || 600;
    // A label near either end is aligned to its tick's edge (CSS .start / .end), so its centre moves with it.
    const items = badgeLanes(
      ax.marks.map((m, i) => {
        const w = Math.max(m.tags.join(" · ").length, 6) * 6.6;
        const x = m.x * W;
        return { id: i, x: m.x < 0.2 ? x + w / 2 - 6 : m.x > 0.8 ? x - w / 2 + 6 : x, w, m };
      }),
      10,
    );
    const lanes = Math.min(3, items.reduce((n, i) => Math.max(n, i.lane + 1), 1));
    const track = h("div", { class: "ck-ruler-track" });
    if (ax.band) {
      const b = h("span", { class: "ck-ruler-band", title: "Expected move: spot ± 0.85 × ATM straddle" });
      b.style.left = pct(ax.band.x0);
      b.style.width = pct(ax.band.x1 - ax.band.x0);
      track.append(b);
    }
    for (const { m } of items) {
      const k = m.kinds.includes("ce") ? "ce" : m.kinds.includes("pe") ? "pe" : m.kinds.includes("gx") ? "gx" : m.kinds.includes("mp") ? "mp" : "rng";
      const t = h("span", { class: `ck-ruler-tick ${k}`, title: `${m.tags.join(" · ")} ${formatGrouped(m.price, 2)}` });
      t.style.left = pct(m.x);
      track.append(t);
    }
    const spot = h("span", { class: "ck-ruler-spot", title: `Spot ${formatGrouped(ax.spot.price, 2)}` }, h("b", {}, formatGrouped(ax.spot.price, 2)));
    spot.style.left = pct(ax.spot.x);
    track.append(spot);
    const labels = h("div", { class: "ck-ruler-labels" });
    labels.style.height = `${lanes * 30}px`;
    for (const it of items) {
      if (it.lane >= 3) continue;
      const m = it.m;
      const k = m.kinds.includes("ce") ? "ce" : m.kinds.includes("pe") ? "pe" : m.kinds.includes("gx") ? "gx" : m.kinds.includes("mp") ? "mp" : "rng";
      const l = h("span", { class: `ck-ruler-l ${k}${m.x > 0.8 ? " end" : m.x < 0.2 ? " start" : ""}` }, h("small", {}, m.tags.join(" · ")), h("b", {}, formatInt(m.price)));
      l.style.left = pct(m.x);
      l.style.top = `${it.lane * 30}px`;
      labels.append(l);
    }
    return h("div", { class: "ck-ruler", role: "img", "aria-label": `Levels around spot ${formatGrouped(ax.spot.price, 2)}: ${ax.marks.map((m) => `${m.tags.join(" and ")} ${formatInt(m.price)}`).join(", ")}` }, track, labels, ax.off.length ? h("p", { class: "ck-note" }, `${ax.off.join(" and ")} ${ax.off.length === 1 ? "is" : "are"} more than three expected moves away: in the tiles, not on the ruler.`) : null);
  }

  // The ruler is laid out for the card's width: drawn again when the card changes size.
  const rulerSlot = h("div", { class: "ck-ruler-slot" });
  let lastLv = null;
  let lastW = 0;
  const paintRuler = () => {
    if (!lastLv) return;
    lastW = body.clientWidth;
    rulerSlot.replaceChildren(...[ruler(lastLv)].filter(Boolean));
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(() => body.clientWidth && Math.abs(body.clientWidth - lastW) > 8 && paintRuler()).observe(body);

  function draw(lv, e) {
    lastLv = lv;
    paintRuler();
    const tile = (label, value, note, cls = "", tip = "") => h("div", { class: `ck-tile ${cls}`.trim(), title: tip || undefined }, h("span", { class: "ck-tile-k" }, label), h("span", { class: "ck-tile-v" }, value), h("span", { class: "ck-tile-s" }, note));
    const moveNote = num(lv.rangeLo) !== null ? `${formatGrouped(lv.rangeLo, 0)} to ${formatGrouped(lv.rangeHi, 0)}${num(lv.movePct) !== null ? ` · ${formatPercent(lv.movePct, 2)} of spot` : ""}` : "Needs both ATM prices";
    paintDl();
    body.replaceChildren(
      h(
        "div",
        { class: "ck-lv-top" },
        h("div", { class: "ck-lv-hero", title: "0.85 × the ATM straddle around spot: a pricing convention, not a forecast" }, h("span", { class: "ck-lv-k" }, "Expected move to expiry"), h("span", { class: "ck-big" }, num(lv.move) === null ? DASH : `±${formatGrouped(lv.move, 0)}`), h("small", {}, moveNote)),
        dl,
      ),
      rulerSlot,
      h(
        "div",
        { class: "ck-tiles" },
        tile("Call wall", lv.callWall ? formatInt(lv.callWall.strike) : DASH, lv.callWall ? distText(lv.callWall.dist) : "Not reported", "ce", "Most Call open interest at or above spot, within the ATM strike and 7 strikes either side"),
        tile("Put wall", lv.putWall ? formatInt(lv.putWall.strike) : DASH, lv.putWall ? distText(lv.putWall.dist) : "Not reported", "pe", "Most Put open interest at or below spot, within the ATM strike and 7 strikes either side"),
        tile("Max pain", lv.maxPain ? formatInt(lv.maxPain.strike) : DASH, lv.maxPain ? distText(lv.maxPain.dist) : "Not reported", "mp", "The expiry price at which option buyers together would collect the least, over the strikes read"),
        tile("Gamma flip", lv.flip ? formatInt(lv.flip.price) : DASH, lv.flip ? `Spot ${lv.flip.dist <= 0 ? "above" : "below"} by ${formatInt(Math.abs(lv.flip.dist))}` : "Not reported", "gx", "Where the exposure model's net gamma changes sign: a model level"),
        tile("PCR", num(lv.pcr) === null ? DASH : formatFixed(lv.pcr, 2), lv.pcrStrikes ? `OI · ${formatInt(lv.pcrStrikes)} strikes` : "", "", "Put open interest ÷ Call open interest over the strikes read"),
        tile("ATM IV", num(lv.atmIv) === null ? DASH : formatPercent(lv.atmIv, 1), num(lv.atm) === null ? "" : `At ${formatInt(lv.atm)}`),
        tile("ATM straddle", num(lv.straddle) === null ? DASH : formatFixed(lv.straddle, 2), num(lv.ceLtp) === null ? "" : `C ${formatFixed(lv.ceLtp, 2)} + P ${formatFixed(lv.peLtp, 2)}`),
        tile("To expiry", e.days === 0 ? "Today" : `${formatInt(e.days)} d`, `${e.kind === "monthly" ? "Monthly" : "Weekly"}${num(lv.lot) !== null ? ` · lot ${formatInt(lv.lot)}` : ""}`),
      ),
    );
  }

  seg.addEventListener("change", () => {
    u = seg.value;
    local.set(LEVELS_U_KEY, u);
    flipAt = 0;
    body.replaceChildren(loadingState({ rows: 4, cols: 4, label: "Reading the chain" }));
    load(true).catch(() => {});
  });
  load(true).catch(() => {});
  return { el, refresh: () => load(false) };
}

/**
 * The cockpit. `accs` from /v1/accounts, `orders` from /v1/orders, `streams` /v1/stream/stats, `usage` /v1/usage,
 * `safety` /v1/safety, `keys` /v1/keys, `readyPill` the readiness pill (or null). `starting`: GET /v1/health's
 * `startup` while the Bridge is still seeding the demo book (or null): the book cards then show a skeleton with the
 * seed's progress and fill in when it is done; a partly seeded book is never shown as if complete. `onSummary(text)`
 * receives the page's one-line summary whenever it changes.
 * @returns {Promise<{ nodes: Node[], refresh: () => Promise<void> }>}
 */
export async function cockpit({ accs, orders, streams, usage, safety, keys, readyPill, starting = null, onSummary = null }) {
  const now = Date.now();
  const today = istToday(now);
  const strip = indicesStrip();
  // Accounts we can read without a broker call storm: paper ones, and live ones that are logged in (max 6).
  const readable = accs.filter((a) => a.broker === "paper" || a.session?.state === "connected").slice(0, 6);
  const readBook = () =>
    Promise.all([
      Promise.all(readable.map((a) => optional(api(`/v1/positions?account=${encodeURIComponent(a.id)}`)))),
      Promise.all(readable.map((a) => optional(api(`/v1/funds?account=${encodeURIComponent(a.id)}`)))),
    ]);
  let waiting = startupText(starting);
  const [quotes, book, events, refs, inbox] = await Promise.all([
    strip.fill().catch(() => []),
    waiting ? null : readBook(),
    optional(api("/v1/events?limit=80")),
    Promise.all(LEVEL_UNDERLYINGS.map((u) => optional(api(`/v1/reference/bundle?underlying=${u}`)))),
    optional(api("/v1/alerts/inbox")),
  ]);
  let spots = Object.fromEntries((quotes ?? []).map((q) => [q.symbol.split(":")[1], q.ltp]));
  const bundleList = refs.map((r) => r.data?.data).filter(Boolean);
  const bundles = new Map(bundleList.map((b) => [b.underlying, b]));
  const ref0 = bundleList[0] ?? null;
  const clock = () => marketClock({ nowMs: Date.now(), session: ref0?.session, holidays: ref0?.holidays });
  const label = (id) => accs.find((a) => a.id === id)?.label ?? id;
  const expiries = upcomingExpiries(bundleList, today);
  const summary = { books: null, pnl: null };
  let lastSummary = "";
  const saySummary = () => {
    const t = homeSummary({ clock: clock(), books: summary.books, pnl: summary.pnl, expiry: expiries[0] ?? null });
    if (t && t !== lastSummary) {
      lastSummary = t;
      onSummary?.(t);
    }
  };

  // ── Hero cards ──
  const hPnl = heroCard({ cls: "ck-h-pnl", glyph: "wallet", tint: "green", label: "P&L today", href: "#/positions", title: "Positions" });
  const hMkt = heroCard({ cls: "ck-h-mkt", glyph: "clock", tint: "blue", label: "Market", href: "#/calendar", title: "Market calendar" });
  const hExp = heroCard({ cls: "ck-h-exp", glyph: "calendar", tint: "orange", label: "Next expiry", href: "#/calendar", title: "Market calendar" });
  const hSafe = heroCard({ cls: "ck-h-safe", glyph: "power", tint: "purple", label: "Safety", href: "#/safety", title: "Safety" });
  const paintClock = () => {
    const c = clock();
    hMkt.set({ v: c.hero, vCls: c.phase === "open" ? "up" : "", s: c.sub, p: ring(c.elapsed, c.phase === "open" ? `${formatInt(Math.round(c.elapsed * 100))}%` : c.phase === "pre" ? "Today" : c.next ? dayText(c.next).slice(0, 3) : DASH, c.phase === "open" ? "ok" : "") });
  };
  paintClock();
  const nx = expiries[0] ?? null;
  const hol = (ref0?.holidays ?? []).find((x) => x.date >= today && x.date <= expiries.at(-1)?.date) ?? null;
  hExp.set(
    nx
      ? { v: nx.days === 0 ? "Today" : nx.days === 1 ? "Tomorrow" : `${formatInt(nx.days)} days`, vCls: nx.days === 0 ? "warn" : "", s: `${nx.u} ${nx.kind === "monthly" ? "monthly" : "weekly"} · ${dayText(nx.date)}${nx.shifted ? " · moved for a holiday" : ""}${expiries[1] ? ` · then ${expiries[1].u} ${dayText(expiries[1].date)}` : ""}`, p: calLeaf(nx.date) }
      : { v: DASH, s: "No index expiry in the next 14 days" },
  );
  if (hol) hExp.el.title = `Holiday ${dayText(hol.date)}: ${hol.label}`;
  const alertsToday = (inbox.data?.data?.items ?? []).filter((f) => istToday(Date.parse(f.at ?? "")) === today).length;
  const paintSafety = () => {
    const snap = lastReadiness();
    const m = badgeModel(snap, { demo: app.state.demo });
    const ks = safety.data?.data?.killSwitch;
    const chk = readinessChecks(snap);
    hSafe.set({
      v: ks?.engaged ? "Kill switch on" : m.short === "Checking…" ? "Checking" : m.short,
      vCls: ks?.engaged || m.cls === "bad" ? "down" : m.cls === "warn" ? "warn" : m.cls === "ok" ? "up" : "",
      s: `${ks?.engaged ? "Orders stopped" : "Kill switch off"} · ${alertsToday ? `${formatInt(alertsToday)} alert${alertsToday === 1 ? "" : "s"} today` : "No alerts today"}${safety.data?.data?.liveTrading ? "" : " · paper only"}`,
      p: chk.total ? ring(chk.pass / chk.total, `${formatInt(chk.pass)}/${formatInt(chk.total)}`, chk.pass === chk.total ? "ok" : "warn") : null,
      aria: `Safety: ${m.aria}`,
    });
  };
  paintSafety();
  const heroes = h("section", { class: "ck-heroes", "aria-label": "Today at a glance" }, hPnl.el, hMkt.el, hExp.el, hSafe.el);

  // ── While the demo book is being seeded: a skeleton and the progress in the book cards ──
  const seedLines = [];
  const seedBody = (rows, live) => {
    const line = h("p", { class: "ck-note ck-seed-line", ...(live ? { role: "status" } : {}) }, waiting);
    seedLines.push(line);
    return h("div", { class: "ck-seed" }, line, loadingState({ rows, cols: 3, label: waiting }));
  };

  const groupsOf = (posRes) => {
    // Each read is for one account; a broker that leaves accountId off its rows (the demo feed) still groups by it.
    const allPos = posRes.flatMap((r, i) => (r.data?.data ?? []).map((p) => (p.accountId ? p : { ...p, accountId: readable[i].id })));
    return bookGroups(allPos, { spots, nowMs: Date.now() });
  };
  const paintPnl = (posRes) => {
    if (!posRes) return hPnl.set({ v: DASH, s: waiting ?? "Waiting for the book" });
    if (!readable.length) return hPnl.set({ v: DASH, s: "No account to read · log in or use paper" });
    const perAcct = readable.map((a, i) => {
      const ps = posRes[i].data?.data ?? [];
      const known = ps.filter((p) => num(p.pnl) !== null);
      return { pnl: known.length ? known.reduce((s, p) => s + Number(p.pnl), 0) : ps.length ? null : 0, open: ps.filter((p) => num(p.netQty)).length };
    });
    const total = perAcct.reduce((s, x) => s + (num(x.pnl) ?? 0), 0);
    const legs = perAcct.reduce((s, x) => s + x.open, 0);
    const groups = groupsOf(posRes);
    summary.books = groups.length;
    summary.pnl = total;
    hPnl.set({
      v: formatSignedRupee(total, 0),
      vCls: tone(total),
      s: `${formatInt(legs)} open leg${legs === 1 ? "" : "s"} · ${formatInt(readable.length)} account${readable.length === 1 ? "" : "s"} · realised and open`,
      p: pnlPic(pnlBars(groups.map((g) => ({ label: `${g.underlying} · ${label(g.account)}`, pnl: g.pnl })))),
    });
  };

  // ── Open positions with risk ──
  const posCardOf = (posRes) => {
    const groups = groupsOf(posRes);
    return card({
      glyph: "strategy",
      tint: "indigo",
      title: "Open positions",
      sub: groups.length ? `${formatInt(groups.length)} book${groups.length === 1 ? "" : "s"} by account and underlying` : "Nothing open",
      cls: "ck-card ck-a-pos",
      actions: h("a", { class: "lk small", href: "#/positions" }, "Open"),
      flush: true,
      body: groups.length
        ? h(
            "table",
            { class: "ck-table" },
            h("thead", {}, h("tr", {}, [["Book"], ["Legs"], ["P&L"], ["Delta", "c-delta"], ["Expiry", "c-exp"], ["Watch", "c-watch"]].map(([t, c]) => h("th", { scope: "col", class: c }, t)))),
            h(
              "tbody",
              {},
              groups.slice(0, 8).map((g) => {
                const mins = g.minutesToExpiry;
                const exp = mins === null ? DASH : mins < 0 ? "Expired" : mins < 24 * 60 ? `${formatFixed(mins / 60, 1)} h` : `${formatInt(Math.floor(mins / 1440))} d`;
                const watchList = [];
                if (num(g.premiumMultiple) !== null && g.premiumMultiple >= 1.8) watchList.push(pill(`A leg at ${formatFixed(g.premiumMultiple, 1)}×`, "warn"));
                if (mins !== null && mins >= 0 && mins < 24 * 60 && g.shorts) watchList.push(pill("Shorts expire today", "warn"));
                return h(
                  "tr",
                  {},
                  // Phones drop the Delta, Expiry and Watch columns; the expiry and what to watch then show under the book's name.
                  h("th", { scope: "row" }, h("strong", {}, g.underlying), h("small", {}, label(g.account), h("span", { class: "ck-exp-in" }, ` · ${exp}`)), watchList.length ? h("span", { class: "ck-watch-in" }, watchList.map((p) => p.cloneNode(true))) : null),
                  h("td", { class: "num" }, `${formatInt(g.legs)}${g.shorts ? ` · ${formatInt(g.shorts)} short` : ""}`),
                  h("td", { class: "num" }, signed(g.pnl)),
                  h("td", { class: "num c-delta", title: "Net delta in units of the underlying (Black-76 at each leg's implied vol)" }, num(g.delta) === null ? DASH : formatSigned(g.delta, 0)),
                  h("td", { class: "num c-exp" }, exp),
                  h("td", { class: "c-watch" }, watchList.length ? watchList : h("span", { class: "muted" }, "Calm")),
                );
              }),
            ),
          )
        : emptyState("strategy", "No open positions", "Trade from the option chain or the Strategy Builder; paper orders are the default.", h("a", { class: "lk", href: "#/chain" }, "Open the chain"), { compact: true }),
    });
  };
  paintPnl(book?.[0] ?? null);
  let posCard = waiting
    ? card({ glyph: "strategy", tint: "indigo", title: "Open positions", sub: "Waiting for the book", cls: "ck-card ck-a-pos", actions: h("a", { class: "lk small", href: "#/positions" }, "Open"), body: seedBody(4, true) })
    : posCardOf(book[0]);

  // ── Key levels ──
  const lvl = levelsCard({ bundles, clock, today });

  // ── Latest live events: today's count and the up / down split, then the feed ──
  const evs = events.data?.data ?? [];
  const split = eventSplit(evs, today);
  const splitBar = () => {
    const b = h("i", { class: "up" });
    const s = h("i", { class: "down" });
    const two = split.bull + split.bear;
    b.style.flexGrow = String(two ? split.bull : 1);
    s.style.flexGrow = String(two ? split.bear : 1);
    return h("span", { class: `ck-split${two ? "" : " none"}`, "aria-hidden": "true" }, b, s);
  };
  const evCard = card({
    glyph: "radar",
    tint: "orange",
    title: "Latest live events",
    sub: evs.length ? "Highs, gaps, OI build-up, IV and more, as they happen" : "No events yet",
    cls: "ck-card ck-a-ev",
    actions: h("a", { class: "lk small", href: "#/screeners/events" }, "All events"),
    body: evs.length
      ? h(
          "div",
          { class: "ck-ev" },
          h("div", { class: "ck-hero" }, h("span", { class: "ck-big" }, `${formatInt(split.total)}${evs.length >= 80 && split.total >= evs.length ? "+" : ""}`), h("small", {}, `today · ${formatInt(split.bull)} bullish · ${formatInt(split.bear)} bearish`), splitBar()),
          h(
            "ul",
            { class: "ck-events" },
            evs.slice(0, 80).map((e) =>
              h(
                "li",
                { class: `side-${e.side ?? "neutral"}` },
                h("time", { datetime: e.time }, TIME.format(new Date(e.ts ?? Date.parse(e.time)))),
                h("span", { class: "ck-ev-t" }, h("strong", {}, String(e.symbol ?? "").split(":")[1] ?? e.symbol), h("span", {}, e.label ?? e.kind)),
                h("small", {}, e.context ?? ""),
              ),
            ),
          ),
        )
      : emptyState("radar", "Nothing yet today", "Events start once prices stream in.", null, { compact: true }),
  });

  // ── Your watchlist (the list marked Show on Home) ──
  const wlRes = await optional(api("/v1/watchlists"));
  const homeList = (wlRes.data?.data?.items ?? []).find((l) => l.home) ?? null;
  // Its quotes (with each row's front-expiry IV) can take a few seconds at start: the card draws with a skeleton and fills in.
  const wlBody = h("div", { class: "ck-wl" }, loadingState({ rows: 4, cols: 3, label: "Loading quotes" }));
  // The list's symbols and near futures are watched on the live connection while Home shows them, so the Bridge answers
  // this 5 s poll from ticks instead of a broker quote call each time.
  let wlLive = null;
  let wlSig = "";
  const fillWl = async () => {
    if (!homeList?.symbols.length) return;
    const r = await optional(api(`/v1/watchlists/${encodeURIComponent(homeList.id)}/quotes`, { fresh: true }));
    const rows = r.data?.data?.rows ?? [];
    if (!wlLive && rows.length && (wlBody.isConnected || !wlSig)) {
      const futs = rows.map((x) => x.future).filter((f) => typeof f === "string" && f.includes(":"));
      const stop = () => {
        if (wlBody.isConnected) return;
        wlLive?.stop();
        wlLive = null;
        removeEventListener("hashchange", later);
      };
      // Leaving Home: stopped once the next page has replaced it (or on the next tick, whichever is first).
      const later = () => setTimeout(stop, 1500);
      addEventListener("hashchange", later);
      wlLive = watch([...new Set([...homeList.symbols, ...futs])].slice(0, 60), "quote", stop);
    } else if (wlLive && !wlBody.isConnected && wlSig) {
      wlLive.stop();
      wlLive = null;
    }
    // Unchanged figures: nothing is rebuilt.
    const sig = JSON.stringify(rows.slice(0, 10).map((x) => [x.name, x.ltp, x.changePct, x.iv, x.oiChangePct]));
    if (sig === wlSig) return;
    wlSig = sig;
    wlBody.replaceChildren(
      h(
        "ul",
        { class: "ck-wl-list" },
        rows.slice(0, 10).map((x) =>
          h(
            "li",
            {},
            h("strong", {}, x.name),
            h("span", { class: "ck-wl-px" }, formatGrouped(x.ltp, 2)),
            h("span", { class: `ck-wl-ch ${tone(x.changePct)}` }, isFigure(x.changePct) ? `${formatSigned(x.changePct, 2)}%` : DASH),
            h("small", { class: "ck-wl-iv", title: isFigure(x.iv) ? "ATM IV of the front expiry, as on the Option Chain" : undefined }, isFigure(x.iv) ? `IV ${formatFixed(x.iv, 1)}` : isFigure(x.oiChangePct) ? `OI ${formatSigned(x.oiChangePct, 1)}%` : ""),
          ),
        ),
      ),
    );
  };
  fillWl().catch(() => {});
  const wlCard = card({
    glyph: "list",
    tint: "blue",
    title: homeList ? homeList.name : "Watchlist",
    sub: homeList ? "Your list on Home: last price, % change and IV" : "Pick a list to show here",
    cls: "ck-card ck-a-wl",
    actions: h("a", { class: "lk small", href: "#/screeners/watchlists" }, homeList ? "Edit" : "Watchlists"),
    body: homeList?.symbols.length ? wlBody : emptyState("list", "No list on Home", "Mark a watchlist Show on Home and its quotes appear here.", h("a", { class: "lk", href: "#/screeners/watchlists" }, "Open watchlists"), { compact: true }),
  });

  // ── Accounts and health: each account's session and margin, the stream, calls saved, orders, keys ──
  const sd = streams.data?.data;
  const up = sd?.upstreams ?? [];
  const sv = usage.data?.data?.savings;
  const saved = sv ? (sv.servedFromStream ?? 0) + (sv.servedFromCache ?? 0) + (sv.coalesced ?? 0) + (sv.batched ?? 0) : null;
  const ks = safety.data?.data?.killSwitch;
  const ordersText = (ord) => (ord ? `${formatInt(ord.filter((o) => o.mode === "paper").length)} paper · ${formatInt(ord.filter((o) => o.mode === "live").length)} live` : DASH);
  const ordersDd = h("dd", {}, ordersText(orders.data?.data ?? null));
  // Latest orders, newest first: the health card's elastic part on wide screens (the account rows keep their height).
  const recentList = h("ul", { class: "ck-recent-list" });
  const fillRecent = (ord) =>
    recentList.replaceChildren(
      ...(ord ?? [])
        .slice()
        .sort((a, b) => String(b.placedAt ?? "").localeCompare(String(a.placedAt ?? "")))
        .slice(0, 12)
        .map((o) => {
          const st = orderStatusText(o.status);
          const t = Date.parse(o.placedAt ?? "");
          return h(
            "li",
            { title: o.symbol },
            h("time", { datetime: o.placedAt ?? "" }, Number.isFinite(t) ? TIME.format(new Date(t)) : DASH),
            h("span", { class: "ck-l" }, h("strong", {}, contractName(o.symbol)), h("small", {}, `${o.side === "SELL" ? "Sell" : "Buy"} ${formatInt(o.quantity)}${isFigure(o.avgPrice) ? ` @ ${formatFixed(o.avgPrice, 2)}` : ""} · ${o.mode === "live" ? "Live" : "Paper"}`)),
            h("span", { class: `ck-st ${st.tone}`.trim() }, st.text),
          );
        }),
    );
  fillRecent(orders.data?.data ?? null);
  const recentBlock = h("div", { class: "ck-recent" }, h("h3", { class: "ck-sub" }, "Latest orders"), recentList);
  const keyRows = keys.data?.data ?? [];
  const acctList = h("ul", { class: "ck-list ck-accts" });
  const readyCount = accs.filter((a) => a.broker === "paper" || a.session?.state === "connected").length;
  const fillAccts = (fundRes) =>
    acctList.replaceChildren(
      ...accs.slice(0, 6).map((a) => {
        const s = a.broker === "paper" ? { text: "Ready", tone: "ok" } : sessionText(a.session?.state);
        const i = readable.indexOf(a);
        const f = i >= 0 ? fundRes?.[i]?.data?.data ?? null : null;
        const used = num(f?.usedMargin);
        const free = num(f?.availableCash);
        const all = (used ?? 0) + (free ?? 0);
        const pct = used !== null && all > 0 ? used / all : null;
        const bar = h("i", { class: `ck-bar-fill${pct !== null && pct >= 0.9 ? " bad" : pct !== null && pct >= 0.7 ? " warn" : ""}` });
        bar.style.width = `${Math.round(Math.min(1, pct ?? 0) * 100)}%`;
        const kind = a.broker === "paper" ? "Paper" : a.liveAllowedByConfig ? "Live enabled" : "Paper only";
        return h(
          "li",
          {},
          h("span", { class: "ck-l" }, h("strong", {}, a.label), h("small", {}, pct === null ? kind : `Margin ${formatPercent(pct * 100, 0)} · free ${isFigure(free) && free >= 0 ? `₹${formatCompact(free)}` : formatRupee(free, 0)}`)),
          h("span", { class: "ck-bar", "aria-hidden": "true", hidden: pct === null }, bar),
          pill(s.text, s.tone),
        );
      }),
    );
  fillAccts(book?.[1] ?? null);
  const healthCard = card({
    glyph: "activity",
    tint: "purple",
    title: "Accounts and health",
    sub: `Bridge ${app.state.health?.version ?? ""} · up ${formatInt((app.state.health?.uptimeSeconds ?? 0) / 60)} min`,
    cls: "ck-card ck-a-hl",
    actions: h("a", { class: "lk small", href: "#/accounts" }, "Accounts"),
    body: h(
      "div",
      { class: "ck-health" },
      h("div", { class: "ck-hero" }, h("span", { class: "ck-big" }, `${formatInt(readyCount)}/${formatInt(accs.length)}`), h("small", {}, "accounts ready to read")),
      acctList,
      h(
        "dl",
        { class: "ck-kv" },
        h("dt", {}, "Stream"),
        h("dd", {}, up.length ? `${up.filter((x) => x.connected).length === up.length ? "Up" : "Partly up"} · ${formatInt(sd?.symbols)} symbols` : "Off"),
        h("dt", {}, "Calls saved today"),
        h("dd", {}, saved === null ? DASH : formatInt(saved)),
        h("dt", {}, "Orders today"),
        ordersDd,
        h("dt", {}, "API keys"),
        h("dd", {}, formatInt(keyRows.filter((k) => !k.revokedAt).length)),
      ),
      recentList.childElementCount ? recentBlock : null,
      h("div", { class: "row ck-pills" }, ks?.engaged ? pill("Kill switch on", "bad") : pill("Kill switch off", "ok"), readyPill, safety.data?.data?.liveTrading ? pill("Live trading on", "bad") : pill("Paper only")),
    ),
  });

  // Market movers (NIFTY 50) and headlines: each reads on its own and refreshes on its own clock (30 s, 5 min).
  const mv = moversCard();
  const nw = headlinesCard();
  // The Market brief in one line (trend, breadth, PCR, RSI, MACD, VWAP) for Key levels' underlying; the levels stay in
  // that card, the full brief opens from here or with Shift+Y.
  const brief = briefStrip();
  const grid = h("div", { class: "cockpit" }, lvl.el, posCard, evCard, healthCard, wlCard, mv.el, nw.el);
  saySummary();

  const putBook = (b) => {
    paintPnl(b[0]);
    fillAccts(b[1]);
    const next = posCardOf(b[0]);
    posCard.replaceWith(next);
    posCard = next;
    saySummary();
  };

  // Follow the seed: the progress line every half second; once the Bridge answers book reads, read the whole book and
  // put it in place (and today's orders), all at once.
  if (waiting) {
    (async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (!grid.isConnected) return;
        const hz = await optional(api("/v1/health", { fresh: true }));
        const t = hz.data ? startupText(hz.data.startup) : waiting;
        if (t) {
          for (const l of seedLines) if (l.textContent !== t) l.textContent = t;
          hPnl.set({ v: DASH, s: t });
          continue;
        }
        const [b, ord] = await Promise.all([readBook(), optional(api("/v1/orders?limit=100", { fresh: true }))]);
        if (!grid.isConnected) return;
        waiting = null;
        putBook(b);
        ordersDd.textContent = ordersText(ord.data?.data ?? null);
        fillRecent(ord.data?.data ?? null);
        return;
      }
    })().catch(() => {});
  }

  // The book again every 30 s (P&L moves with prices); the clock and safety on every tick (cheap, text only).
  let bookAt = Date.now();
  return {
    nodes: [heroes, strip.el, brief.el, grid],
    refresh: async () => {
      paintClock();
      paintSafety();
      saySummary();
      const rows = await strip.fill().catch(() => null);
      if (rows?.length) spots = { ...spots, ...Object.fromEntries(rows.map((q) => [q.symbol.split(":")[1], q.ltp])) };
      if (!waiting && Date.now() - bookAt >= 30_000) {
        bookAt = Date.now();
        const b = await readBook().catch(() => null);
        if (b && grid.isConnected) putBook(b);
      }
      await Promise.all([fillWl(), lvl.refresh(), mv.refresh(), nw.refresh(), brief.refresh()]).catch(() => {});
    },
  };
}

export const COCKPIT_INDICES = INDICES;
