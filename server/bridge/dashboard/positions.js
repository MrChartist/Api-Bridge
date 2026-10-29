// Positions and Risk (#/positions, PRD 04): the book on one underlying, every expiry and its futures, run as a risk
// desk. A book strip (P&L, Δ in futures lots and rupees, Γ, Θ, Vega, margin), the legs grouped by expiry with their
// structure and Greeks, the payoff of the whole book (now, a target date, the first expiry), a scenario matrix, a hedge
// helper that shows before and after before anything is sent, and a safe exit plan (limit at mid, shorts first,
// freeze-quantity slices, partial exits).
//
// desk.js owns the toolbar and the 3 s timer; this file owns its data (positions, a chain per expiry held, quotes for
// futures and missing legs, instruments, funds) and its panels. Everything is built once and patched on each tick.
// The maths is in options.js (pure, tested); numbers become text through format.js only. Orders always go through
// POST /v1/orders/preview and /v1/orders, so the Bridge's safety gates apply unchanged.
import { alertBox, api, h, icon, istTime, modal, optional, toast } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, isFigure } from "./format.js";
import * as O from "./options.js";
import { niceTicks } from "./payoff.js";
import { segField, segmented } from "./views.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const CHAIN_STRIKES = 40;
/** Chains per tick; further expiries refresh every 5th tick (15 s at 3 s). Funds every 5th tick too. */
const CHAIN_CAP = 4;
const SLOW_EVERY = 5;
/** A failed chain keeps its last good values this long (marked stale), then its legs fall back to quotes. */
const KEEP_MS = 30000;
/** A quote older than this (its request kept failing) marks its leg stale; older than KEEP_MS it is dropped. */
const QUOTE_STALE_MS = 10000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const EXPIRY_DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const expiryText = (e) => (ISO_DAY.test(e ?? "") ? EXPIRY_DAY.format(new Date(`${e}T00:00:00Z`)) : e ?? "");
const INDEX_SYMBOL = { NIFTY: "NSE:NIFTY", BANKNIFTY: "NSE:BANKNIFTY", FINNIFTY: "NSE:FINNIFTY", MIDCPNIFTY: "NSE:MIDCPNIFTY", SENSEX: "BSE:SENSEX", BANKEX: "BSE:BANKEX" };
const PRODUCT = { INTRADAY: "Intraday", MARGIN: "Carry", CNC: "Delivery" };
const media = (q) => (typeof matchMedia === "function" ? matchMedia(q) : { matches: false, addEventListener() {}, removeEventListener() {} });
const isPhone = () => media("(max-width: 719px)").matches;
const isNarrow = () => media("(max-width: 1099px)").matches;
const SVGNS = "http://www.w3.org/2000/svg";
const r1 = (v) => Math.round(v * 10) / 10;
/** σ distances floor to 0.1, so a tested leg (< 0.5σ) never reads "0.5σ". */
const sig1 = (v) => (isFigure(v) ? formatFixed(Math.floor(v * 10 + 1e-9) / 10, 1) : DASH);
function svg(tag, attrs, ...children) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined) e.setAttribute(k, String(v));
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const setA = (el, attrs) => {
  for (const [k, v] of Object.entries(attrs)) {
    const s = String(v);
    if (el.getAttribute(k) !== s) el.setAttribute(k, s);
  }
};
/** Signed rupees, no decimals: "+₹1958", "-₹310", "₹0". */
const rs = (v, dp = 0) => (!isFigure(v) ? DASH : Number(formatFixed(v, dp)) > 0 ? `+${formatRupee(v, dp)}` : formatRupee(v, dp));
/** Signed compact rupees for big figures: "+₹1.42L". */
const rc = (v) => (!isFigure(v) ? DASH : `${v > 0.5 ? "+" : v < -0.5 ? "-" : ""}₹${formatCompact(Math.abs(v))}`);
const tone = (v) => (!isFigure(v) ? undefined : Math.round(v) > 0 ? "up" : Math.round(v) < 0 ? "down" : undefined);
const money = (v, dp = 0) => h("span", { class: tone(v) }, rs(v, dp));
const plural = (n, w) => `${formatInt(n)} ${w}${n === 1 ? "" : "s"}`;
const legName = (l) => (l.kind === "FUT" ? "FUT" : `${formatInt(l.strike)} ${l.right}`);
const fullName = (l) => `${l.underlying} ${expiryText(l.expiry)} ${l.kind === "FUT" ? "FUT" : `${formatInt(l.strike)} ${l.right}`}`;
const lotsOf = (l) => l.q / (l.lot || 1);
const lotsText = (l) => {
  const v = lotsOf(l);
  return formatSigned(v, Number.isInteger(v) ? 0 : 2);
};
/** "Short 2 lots 26700 CE 3 Nov" */
const legSpeech = (l) => {
  const n = Math.abs(lotsOf(l));
  return `${l.q > 0 ? "Long" : "Short"} ${Number.isInteger(n) ? plural(n, "lot") : `${formatFixed(n, 2)} lots`} ${legName(l)} ${expiryText(l.expiry)}`;
};
/** Sort inside a group: futures first, then strike ascending, CE before PE. */
const legOrder = (a, b) => (a.kind === "FUT") !== (b.kind === "FUT") ? (a.kind === "FUT" ? -1 : 1) : (a.strike ?? 0) - (b.strike ?? 0) || (a.right === b.right ? 0 : a.right === "CE" ? -1 : 1);

/** The page's keys: [keys, short, long]. */
export const POSITION_KEYS = [
  [["J", "K"], "row", "Next / previous leg (↓ ↑ too)"],
  [["Space"], "select", "Select the leg for a bulk exit"],
  [["I"], "include", "Include or exclude the leg in risk"],
  [["X"], "exit", "Exit the focused leg (ticket)"],
  [["⇧X"], "exit all", "Exit plan for every leg"],
  [["A"], "analyse", "Analyse the leg's expiry group in the builder"],
  [["H"], "hedge", "Open the hedge helper"],
  [[",", "."], "spot", "Scenario spot −/+ 0.5%"],
  [[";", "'"], "IV", "Scenario IV −/+ 1 point"],
  [["[", "]"], "days", "Scenario days −/+ 1"],
  [["0"], "reset", "Reset the scenario"],
  [["P"], "pause", "Pause / resume live updates"],
  [["R"], "refresh", "Refresh now"],
  [["?"], "keys", "This list"],
];

/** Instruments (lot size, freeze qty, tick) per symbol for the session: symbol → object | null. */
const instCache = new Map();

/**
 * The positions page.
 * @param {{ st: object, save: () => void, account: () => object|null, openTicket: (o: object) => Promise<unknown>,
 *   onClock: () => void, setUnderlying: (u: string) => void, openInChain: (expiry: string, strike: number, side: string) => void }} o
 */
export function createPositionsPage({ st, save, account, openTicket, onClock, setUnderlying, openInChain: goChain }) {
  const cfg = () => st.pos;
  const setCfg = (patch) => {
    st.pos = O.positionsConfig({ ...st.pos, ...patch });
    save();
  };
  // ── Data ──
  const d = {
    all: [],
    loaded: false,
    error: null,
    lastOk: null,
    chains: new Map(), // expiry → { chain, at, error, stale }
    quotes: new Map(),
    futures: null, // [{ symbol, expiry, lotSize, freezeQty, tickSize }] for st.underlying
    futuresFor: null,
    expiries: null,
    expiriesFor: null,
    funds: null,
    fundsFor: null,
    tick: 0,
  };
  let legs = []; // priced legs (options.js priceBook)
  let book = null; // bookGreeks
  let groups = []; // [{ key, expiry, legs, structure, locked, ... }]
  let spot = null;
  let busy = false;
  let again = false;
  const selected = new Set();
  let anchor = null;
  let focusSym = null;
  const collapsed = new Set();
  const sc = { pct: 0, dIv: 0, days: 0 };
  let riskTab = "payoff";
  const hd = { open: false, target: 0, method: cfg().hedge.method, side: cfg().hedge.side, fut: null, exp: null, show: true, plan: null, checks: null, checkSig: "", hedgeLegs: [] };
  let warnOpen = false;
  let lastWarnIds = new Set();

  const excludedSet = () => new Set(cfg().excluded[st.account] ?? []);
  const setExcluded = (list) => {
    const ex = { ...cfg().excluded };
    if (list.length) ex[st.account] = [...new Set(list)];
    else delete ex[st.account];
    setCfg({ excluded: ex });
  };

  async function loadInstrument(sym) {
    if (instCache.has(sym)) return instCache.get(sym);
    const r = await optional(api(`/v1/instruments/${encodeURIComponent(sym)}`));
    const v = r.data?.data ? { lotSize: num(r.data.data.lotSize), freezeQty: num(r.data.data.freezeQty), tickSize: num(r.data.data.tickSize) } : null;
    // A network failure is retried next tick; a 404 is remembered.
    if (!r.error || r.error.status === 404) instCache.set(sym, v);
    return v;
  }
  async function loadChain(expiry, seq) {
    const t0 = performance.now();
    const r = await optional(api(`/v1/optionchain?underlying=${encodeURIComponent(st.underlying)}&expiry=${encodeURIComponent(expiry)}&strikes=${CHAIN_STRIKES}&greeks=true`));
    if (seq !== st.seq) return;
    const prev = d.chains.get(expiry);
    if (r.error) {
      // Keep the last good chain for 30 s, marked stale; after that its legs are priced from quotes.
      if (prev?.chain && Date.now() - prev.at < KEEP_MS) d.chains.set(expiry, { ...prev, error: r.error, stale: true });
      else d.chains.set(expiry, { chain: null, at: 0, error: r.error, stale: false });
      return;
    }
    d.chains.set(expiry, { chain: r.data.data, at: Date.now(), error: null, stale: Boolean(r.data.data?.freshness?.stale), ms: Math.round(performance.now() - t0), freshness: r.data.data?.freshness ?? r.data.meta?.freshness ?? null });
  }

  /** One refresh: positions, chains (≤ 4 a tick), quotes, instruments, funds every 15 s. */
  async function tick() {
    const seq = st.seq;
    const acc = st.account;
    const u = st.underlying;
    if (!acc) {
      d.loaded = true;
      draw();
      return;
    }
    if (busy) {
      // A tick asked for while one runs (a new underlying, an order placed) runs right after it.
      again = true;
      return;
    }
    busy = true;
    d.tick += 1;
    const t0 = performance.now();
    try {
      const slow = d.tick % SLOW_EVERY === 1;
      const [pr] = await Promise.all([
        optional(api(`/v1/positions?account=${encodeURIComponent(acc)}`)),
        d.futuresFor !== u ? loadFutures(u).then(() => loadExpiries(u)) : d.expiriesFor !== u ? loadExpiries(u) : null,
        slow || d.fundsFor !== acc ? loadFunds(acc) : null,
      ]);
      if (seq !== st.seq || acc !== st.account) return;
      if (pr.error) {
        d.error = pr.error;
        st.error = pr.error;
      } else {
        d.error = null;
        st.error = null;
        d.all = pr.data?.data ?? [];
        d.lastOk = new Date().toISOString();
      }
      // Today's closed legs (q 0) are kept for realised P&L; only open legs need chains, quotes and instruments.
      const all = O.bookLegs(d.all, u, { closed: true });
      const raw = all.filter((l) => l.q);
      // Chains: every option expiry held, the nearest first; the hedge's ATM expiry too.
      const held = [...new Set(raw.filter((l) => l.kind === "OPT").map((l) => l.expiry))].sort();
      const hedgeExp = hedgeExpiry(held);
      const want = [...new Set([...held, ...(raw.length && hedgeExp ? [hedgeExp] : [])])].sort();
      const due = want.filter((e, i) => i < CHAIN_CAP || slow || !d.chains.get(e)?.chain);
      await Promise.all(due.map((e) => loadChain(e, seq)));
      if (seq !== st.seq) return;
      for (const e of [...d.chains.keys()]) if (!want.includes(e)) d.chains.delete(e);
      // Quotes: held futures, the hedge future, the index and any option leg missing from its chain (≤ 50).
      const chainSyms = new Set();
      for (const c of d.chains.values()) for (const r of c.chain?.rows ?? []) for (const s of [r.ce?.symbol, r.pe?.symbol]) if (s) chainSyms.add(s);
      const fut = pickFuture(raw);
      const syms = [...new Set([...raw.filter((l) => l.kind === "FUT" || !chainSyms.has(l.symbol)).map((l) => l.symbol), fut?.symbol, INDEX_SYMBOL[u]].filter(Boolean))].slice(0, 50);
      const [qr] = await Promise.all([syms.length ? optional(api(`/v1/quotes?symbols=${encodeURIComponent(syms.join(","))}`)) : null, ...raw.filter((l) => !instCache.has(l.symbol)).map((l) => loadInstrument(l.symbol))]);
      if (seq !== st.seq) return;
      const now = Date.now();
      if (qr && !qr.error) for (const q of qr.data?.data ?? []) if (q?.symbol) d.quotes.set(q.symbol, { ...q, _at: now });
      // Quotes that kept failing are dropped after 30 s: their legs fall through to "not priced", never a frozen mark.
      for (const [k, q] of d.quotes) if (now - (q._at ?? 0) > KEEP_MS) d.quotes.delete(k);
      d.loaded = true;
      price(all);
      const near = [...d.chains.values()].find((c) => c.chain);
      st.freshness = near?.freshness ?? pr.data?.meta?.freshness ?? null;
      st.ms = Math.round(performance.now() - t0);
    } finally {
      busy = false;
      if (again) {
        again = false;
        queueMicrotask(tick);
      }
    }
    draw();
  }
  async function loadFutures(u) {
    const r = await optional(api(`/v1/instruments/search?q=${encodeURIComponent(u)}&kind=FUT&underlying=${encodeURIComponent(u)}`));
    if (u !== st.underlying) return;
    d.futuresFor = u;
    d.futures = (r.data?.data ?? []).filter((f) => f.kind === "FUT" && f.underlying === u && ISO_DAY.test(f.expiry ?? "")).sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
    for (const f of d.futures) instCache.set(f.symbol, { lotSize: num(f.lotSize), freezeQty: num(f.freezeQty), tickSize: num(f.tickSize) });
  }
  async function loadExpiries(u) {
    const r = await optional(api(`/v1/expiries?underlying=${encodeURIComponent(u)}`));
    if (u !== st.underlying) return;
    d.expiriesFor = u;
    d.expiries = r.data?.data?.expiries ?? [];
    // No futures search on this source: the monthly series are the candidates, validated by the instruments lookup.
    if (d.futuresFor === u && !d.futures?.length && d.expiries.length) {
      const ex = u === "SENSEX" || u === "BANKEX" ? "BFO" : "NFO";
      const cands = await Promise.all(O.monthlyExpiries(d.expiries).map(async (e) => {
        const sym = `${ex}:${u}-${e}-FUT`;
        const i = await loadInstrument(sym);
        return i ? { symbol: sym, expiry: e, lotSize: i.lotSize, freezeQty: i.freezeQty, tickSize: i.tickSize } : null;
      }));
      if (u === st.underlying) d.futures = cands.filter(Boolean);
    }
  }
  async function loadFunds(acc) {
    const r = await optional(api(`/v1/funds?account=${encodeURIComponent(acc)}`));
    if (acc !== st.account) return;
    d.fundsFor = acc;
    d.funds = r.error ? null : r.data?.data ?? null;
  }
  function price(raw) {
    const chains = new Map([...d.chains.entries()].filter(([, c]) => c.chain).map(([e, c]) => [e, c.chain]));
    const nearChain = [...chains.values()][0] ?? null;
    spot = num(nearChain?.underlyingLtp) ?? num(d.quotes.get(INDEX_SYMBOL[st.underlying])?.ltp);
    legs = O.priceBook(raw, { chains, quotes: d.quotes, inst: instCache, spot, excluded: excludedSet() });
    const now = Date.now();
    for (const l of legs) {
      const c = d.chains.get(l.expiry);
      const fromChain = l.kind === "OPT" && c?.chain && l.quote && l.quote._at === undefined;
      l.stale = Boolean((fromChain && c?.stale) || l.quote?.freshness?.stale || (l.quote?._at && now - l.quote._at > QUOTE_STALE_MS));
    }
    // Closed legs (q 0) count in P&L only: never in Greeks, payoff, scenarios or the hedge.
    book = O.bookGreeks(legs.filter((l) => l.q));
    const byKey = new Map();
    for (const l of legs) {
      const key = cfg().group === "none" ? "all" : l.expiry;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(l);
    }
    groups = [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, ls]) => {
      ls.sort(legOrder);
      const open = ls.filter((l) => l.q);
      const st0 = cfg().group === "none" ? { name: `${plural(open.length, "leg")}`, locked: false } : O.detectStructure(open);
      const locked = st0.locked ? O.lockedValue(open) : null;
      return { key, expiry: key === "all" ? null : key, legs: ls, structure: st0.locked && locked === null ? { ...st0, locked: false } : st0, lockedValue: locked };
    });
    // Prune selection and excluded symbols no longer open.
    const open = new Set(legs.filter((l) => l.q).map((l) => l.symbol));
    for (const s of [...selected]) if (!open.has(s)) selected.delete(s);
    const ex = cfg().excluded[st.account] ?? [];
    if (d.error === null && d.loaded && ex.some((s) => !open.has(s) && O.bookLegs([{ symbol: s, netQty: 1 }], st.underlying).length)) {
      setExcluded(ex.filter((s) => open.has(s) || !O.bookLegs([{ symbol: s, netQty: 1 }], st.underlying).length));
    }
  }
  /** Hedge ATM expiry: the chosen one, else the nearest held option expiry, else the first listed. */
  function hedgeExpiry(held) {
    if (hd.exp && (held.includes(hd.exp) || d.expiries?.includes(hd.exp))) return hd.exp;
    return held[0] ?? d.expiries?.[0] ?? null;
  }
  /** Hedge future: the chosen one, else the nearest month that does not expire before the last short option. */
  function pickFuture(raw = legs) {
    const fs = d.futures ?? [];
    if (!fs.length) return null;
    const chosen = fs.find((f) => f.symbol === hd.fut);
    if (chosen) return chosen;
    const lastShort = raw.filter((l) => l.kind === "OPT" && l.q < 0).map((l) => l.expiry).sort().pop();
    return fs.find((f) => !lastShort || f.expiry >= lastShort) ?? fs[fs.length - 1];
  }
  const legQuote = (sym) => () => {
    for (const c of d.chains.values()) for (const r of c.chain?.rows ?? []) for (const s of ["ce", "pe"]) if (r[s]?.symbol === sym) return r[s];
    return d.quotes.get(sym) ?? legs.find((l) => l.symbol === sym)?.quote ?? null;
  };
  const included = () => legs.filter((l) => l.inc && l.q);
  const nearest = () => {
    const inc = included().filter((l) => l.priced);
    const e = inc.map((l) => l.expiry).sort()[0];
    return e ? inc.find((l) => l.expiry === e && l.kind === "OPT") ?? inc.find((l) => l.expiry === e) : null;
  };
  /** σ of the nearest included expiry in % of spot (the scenario chips and the sigma ladder). */
  const sigmaPct = () => {
    const n = nearest();
    if (!n || n.kind !== "OPT" || !spot) return null;
    const m = O.sigmaMove(spot, n.atmIv ?? n.iv, n.T);
    return m ? (m / spot) * 100 : null;
  };
  const daysTo = (e) => Math.max(0, Math.round((O.yearsToExpiry(e) ?? 0) * 365));
  const maxDays = () => Math.max(0, ...included().map((l) => daysTo(l.expiry)));
  const firstDays = () => {
    const n = nearest();
    return n ? Math.max(0, n.T * 365) : 0;
  };

  // ── Panels ──
  const switchEl = h("div", { class: "pos-switch", role: "group", "aria-label": "Other underlyings with open legs", hidden: true });
  const TILES = [["pnl", "Net P&L"], ["delta", "Net Δ"], ["gamma", "Γ · Δ per 1%"], ["theta", "Θ / day"], ["vega", "Vega / pt"], ["margin", "Margin"]];
  const tiles = new Map(
    TILES.map(([k, label]) => {
      const el = h("div", { class: `desk-stat t-${k}`, role: "group", "aria-label": label }, h("span", { class: "label" }, label), h("span", { class: "value" }, DASH), h("span", { class: "sub" }, " "));
      return [k, { el, label: el.children[0], value: el.children[1], sub: el.children[2], sig: "", base: label }];
    }),
  );
  const tilesEl = h("div", { class: "pos-tiles" }, [...tiles.values()].map((t) => t.el));
  const warnLive = h("p", { class: "sr-only", "aria-live": "polite" });
  const warnEl = h("div", { class: "pos-warns" });
  const bookPanel = h("section", { class: "desk-panel pos-book", "data-panel": "book", "aria-label": "Book" }, switchEl, tilesEl, warnEl, warnLive);

  const titleEl = h("span", { class: "chain-title" });
  const gearBtn = h("button", { type: "button", class: "small gear-btn", "aria-haspopup": "dialog", "aria-label": "Customise positions", title: "Columns, grouping, scenario and exit defaults" }, icon("sliders"), h("span", { class: "gear-label" }, "Customise"));
  const exitAllBtn = h("button", { type: "button", class: "small", hidden: true, title: "Exit plan for every leg (Shift+X)" }, "Exit all");
  const bulkEl = h("div", { class: "pos-bulk", hidden: true, role: "region", "aria-label": "Selected legs" });
  const bodyEl = h("div", { class: "pos-body" });
  const keysEl = h("div", { class: "desk-keys" }, POSITION_KEYS.filter((k) => !["R", "P"].includes(k[0][0])).map(([keys, short]) => h("span", { class: "kbd-pair" }, h("span", { class: "kbd-group" }, keys.map((k) => h("kbd", {}, k))), short)));
  const posPanel = h(
    "section",
    { class: "desk-panel pos-panel", "data-panel": "positions", "aria-label": "Positions" },
    h("div", { class: "panel-head pos-head" }, titleEl, h("div", { class: "chain-tools" }, exitAllBtn, gearBtn)),
    bodyEl,
    bulkEl,
    keysEl,
  );
  const riskSeg = segmented("Risk view", [["payoff", "Payoff"], ["scenario", "Scenario"]], riskTab);
  riskSeg.classList.add("pos-risk-seg");
  const payoffBox = h("div", { class: "pos-payoff" });
  const scenBox = h("div", { class: "pos-scen" });
  const riskBody = h("div", { class: "pos-risk tab-payoff" }, payoffBox, scenBox);
  const riskPanel = h("section", { class: "desk-panel pos-riskp", "data-panel": "risk", "aria-label": "Payoff and scenarios", hidden: true }, h("div", { class: "panel-head" }, h("span", { class: "chain-title" }, h("strong", {}, "Risk"), h("span", { class: "muted pos-risk-sub" })), riskSeg), riskBody);
  const hedgeHead = h("button", { type: "button", class: "pos-hedge-head", "aria-expanded": "false" });
  const hedgeBody = h("div", { class: "pos-hedge-body", hidden: true });
  const hedgePanel = h("section", { class: "desk-panel pos-hedge", "data-panel": "hedge", "aria-label": "Hedge helper", hidden: true }, hedgeHead, hedgeBody);
  const slotPanel = h(
    "section",
    { class: "desk-panel pos-slot", "data-panel": "chartslot", "aria-label": "Chart engine slot", hidden: true },
    h("div", { class: "oi-slot pos-slot-box", role: "img", "aria-label": "Chart engine slot: book P&L and spot through the day, with your strikes" }, h("span", { class: "oi-slot-kicker" }, "Chart engine slot"), h("span", {}, "Book P&L and spot through the day, with your strikes")),
  );
  const root = posPanel;

  // ── Book strip ──
  function setTile(key, { value = DASH, sub = "", title = "", cls = "", label = null, chip = null }) {
    const t = tiles.get(key);
    const sig = JSON.stringify([value, sub, title, cls, label, chip]);
    if (t.sig === sig) return;
    t.sig = sig;
    t.label.replaceChildren(label ?? t.base, ...(chip ? [h("span", { class: "pos-chip", title: chip[1] }, chip[0])] : []));
    t.value.textContent = value;
    t.value.className = `value ${cls}`.trim();
    t.sub.textContent = sub || " ";
    t.el.title = title;
  }
  function drawBook() {
    const others = O.bookUnderlyings(d.all, st.underlying);
    const ssig = JSON.stringify(others);
    if (switchEl.__sig !== ssig) {
      switchEl.__sig = ssig;
      switchEl.replaceChildren(h("span", { class: "pos-switch-lbl" }, "Also open"), ...others.map((o) => h("button", { type: "button", class: "pos-uchip", onclick: () => setUnderlying(o.underlying), title: `Switch to ${o.underlying} (broker P&L)` }, h("strong", {}, o.underlying), h("span", { "aria-hidden": "true" }, "·"), plural(o.legs, "leg"), h("span", { "aria-hidden": "true" }, "·"), money(o.pnl))));
    }
    // With nothing to show here the empty state carries the other underlyings instead.
    switchEl.hidden = !others.length || !legs.some((l) => l.q || cfg().closed);
    const open = legs.filter((l) => l.q);
    tilesEl.hidden = d.loaded && !legs.length;
    if (!legs.length) {
      for (const k of tiles.keys()) setTile(k, {});
      return;
    }
    // Net P&L: every leg (P&L is fact, not a scenario), today's closed legs and realised included.
    const { realised: R, unrealised: U, noRealised: noR } = O.bookPnl(legs);
    const optLegs = open.filter((l) => l.kind === "OPT" && num(l.avg) !== null);
    const credit = -optLegs.reduce((t, l) => t + l.avg * l.q, 0);
    const cost = -optLegs.reduce((t, l) => t + (l.mark ?? l.avg) * l.q, 0);
    const kept = credit > 0 ? Math.max(-999, Math.min(100, ((credit - cost) / credit) * 100)) : null;
    setTile("pnl", {
      value: rs(U + R),
      cls: tone(U + R) ?? "",
      sub: kept !== null ? `credit kept ${formatPercent(kept, 0)} of ${rc(credit).replace("+", "")}` : `R ${rs(R)} · U ${rs(U)}`,
      title: `Realised ${rs(R)} · Unrealised ${rs(U)} (from the marks)${noR ? ". Broker sent no realised P&L for some legs" : ""}${kept !== null ? `. Credit received ${formatRupee(credit, 0)}, cost to close ${formatRupee(cost, 0)}` : ""}`,
    });
    const g = book;
    const none = g.priced === 0;
    const partial = g.excluded ? ["partial", `${plural(g.excluded, "leg")} excluded`] : g.missing.length ? ["partial", `${plural(g.missing.length, "leg")} not priced`] : null;
    const noTitle = none ? `No Greeks: ${plural(g.missing.length, "leg")} not priced` : "";
    const fut = pickFuture();
    const Lf = num(fut?.lotSize) ?? legs.find((l) => l.kind === "FUT")?.lot ?? null;
    setTile("delta", {
      value: none ? DASH : formatSigned(g.delta, 0),
      sub: none ? "" : `≈ ${Lf ? `${formatSigned(g.delta / Lf, 1)} lots · ` : ""}${spot ? rc(g.delta * spot) : ""}`,
      title: noTitle || `Rupees gained for a 1-point rise = Δ (the sum of the unrounded legs; the rows are rounded). Futures-lot equivalent${fut ? ` (${expiryText(fut.expiry)} FUT, lot ${formatInt(Lf)})` : ""} and notional exposure`,
      chip: partial,
    });
    setTile("gamma", {
      value: none || !spot ? DASH : formatSigned(g.gamma * spot * 0.01, 0),
      sub: none ? "" : `Γ ${formatSigned(g.gamma, 2)} per pt`,
      title: noTitle || "How much Δ changes for a 1% move in the underlying",
      chip: partial,
    });
    const vOpt = Math.abs(open.filter((l) => l.kind === "OPT" && l.mark !== null).reduce((t, l) => t + l.mark * l.q, 0));
    setTile("theta", {
      value: none ? DASH : rs(g.theta),
      cls: none ? "" : tone(g.theta) ?? "",
      sub: none || !vOpt ? "" : `${formatPercent((g.theta / vOpt) * 100, 1)} of option value`,
      title: noTitle || "Time decay in rupees per calendar day. Weekends and holidays decay more in the next session",
      chip: partial,
    });
    setTile("vega", {
      value: none ? DASH : rs(g.vega),
      sub: none ? "" : `IV −1 pt → ${rs(-g.vega)}`,
      title: noTitle || "P&L for a one vol point rise in every leg's IV",
      chip: partial,
    });
    const f = d.funds;
    const used = num(f?.usedMargin);
    const avail = num(f?.availableCash);
    setTile("margin", {
      value: used === null ? DASH : `₹${formatCompact(used)}`,
      sub: used === null ? "Funds unavailable" : `used · ${avail !== null && used + avail > 0 ? `${formatPercent((used / (used + avail)) * 100, 1)} of funds` : ""}`,
      title: "Account-wide margin from your broker (all underlyings), not this book alone",
    });
  }
  function drawWarnings() {
    const st0 = staleness();
    const w = legs.length ? O.bookWarnings(legs, { spot, stale: st0 }) : [];
    const sig = JSON.stringify([w, warnOpen, isPhone()]);
    if (warnEl.__sig === sig) return;
    warnEl.__sig = sig;
    const chip = (x) =>
      x.id === "excluded"
        ? h("button", { type: "button", class: `pos-warn ${x.level}`, title: x.title, onclick: () => (setExcluded([]), price(O.bookLegs(d.all, st.underlying, { closed: true })), draw()) }, x.text)
        : h("span", { class: `pos-warn ${x.level}`, title: x.title }, h("span", { class: "dot", "aria-hidden": "true" }), x.text);
    const phone = isPhone();
    warnEl.hidden = !w.length;
    warnEl.replaceChildren(
      ...(phone && w.length > 1
        ? [h("button", { type: "button", class: "pos-warn-toggle", "aria-expanded": String(warnOpen), onclick: () => ((warnOpen = !warnOpen), drawWarnings()) }, icon("warn"), `${plural(w.length, "warning")}`), ...(warnOpen ? w.map(chip) : [])]
        : w.map(chip)),
    );
    const ids = new Set(w.map((x) => `${x.id}|${x.text.replace(/\d+:\d+$/, "")}`));
    const fresh = w.filter((x) => !lastWarnIds.has(`${x.id}|${x.text.replace(/\d+:\d+$/, "")}`));
    lastWarnIds = ids;
    if (fresh.length) warnLive.textContent = fresh.map((x) => x.text).join(". ");
  }
  function staleness() {
    const ages = [];
    if (d.error && d.lastOk) ages.push(Date.now() - Date.parse(d.lastOk));
    for (const c of d.chains.values()) if (c.stale && c.at) ages.push(Date.now() - c.at);
    for (const l of legs) if (l.q && l.quote?._at && Date.now() - l.quote._at > QUOTE_STALE_MS) ages.push(Date.now() - l.quote._at);
    if (!ages.length && !legs.some((l) => l.stale)) return null;
    const a = Math.max(0, ...ages);
    return { age: a ? `${formatInt(Math.round(a / 1000))} s` : "stale" };
  }

  // ── Positions (table on desktop / tablet, cards on phone; patched in place) ──
  let layoutSig = "";
  const rowRefs = new Map(); // symbol → { el, cells: Map, inc }
  const groupRefs = new Map(); // key → { el, inc, title, stats, locked }
  const setCell = (el, sig, build, attrs = {}) => {
    if (!el) return;
    if (el.__sig !== sig) {
      el.__sig = sig;
      const kids = [build()].flat().filter((x) => x !== null && x !== undefined && x !== false);
      el.replaceChildren(...kids);
    }
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") {
        if (el.className !== v) el.className = v;
      } else if (v === null) el.removeAttribute(k);
      else if (el.getAttribute(k) !== String(v)) el.setAttribute(k, String(v));
    }
  };
  const colsNow = () => cfg().cols;
  const COL_HEAD = Object.fromEntries(O.POS_COLUMNS.map(([k, l]) => [k, l]));
  /** Below 1100 px IV, Vega and P&L % drop out (the row's ⋯ menu and the cards keep the essentials). */
  const OPT_X = new Set(["iv", "vega", "pnlPct"]);
  function legVm(l) {
    const u = O.legPnl(l);
    const dist = l.priced ? O.legDistance(l) : null;
    const dU = l.kind === "FUT" ? 1 : num(l.greeks?.delta);
    return {
      u,
      pct: u !== null && l.avg > 0 ? ((l.mark - l.avg) / l.avg) * 100 * Math.sign(l.q) : null,
      delta: dU === null ? null : l.q * dU,
      dU,
      theta: l.kind === "FUT" || !l.greeks ? null : l.q * l.greeks.theta,
      vega: l.kind === "FUT" || !l.greeks ? null : l.q * l.greeks.vega,
      gamma: l.kind === "FUT" || !l.greeks ? null : l.q * l.greeks.gamma,
      dist,
    };
  }
  const brokerNote = (l, u) => (num(l.pnl) !== null && u !== null && Math.abs(l.pnl - u) > (l.tick || 0.05) * Math.abs(l.q) ? `Broker P&L ${rs(l.pnl)} (at its LTP ${formatFixed(l.ltp, 2)})` : "");
  function cellFor(k, l, v) {
    const stale = l.stale ? " stale" : "";
    switch (k) {
      case "lots": {
        const odd = l.lot > 1 && Math.abs(l.q) % l.lot !== 0;
        return { sig: `${l.q}|${l.lot}|${l.lotUnknown}`, build: () => [l.q ? lotsText(l) : "0", odd ? h("span", { class: "pos-chip warn", title: "Not a lot multiple" }, "≠ lot") : null], title: `${formatInt(l.q)} qty · lot ${formatInt(l.lot)}${l.lotUnknown ? " (lot size unknown)" : ""}` };
      }
      case "px":
        return {
          sig: `${l.avg}|${l.mark}|${l.stale}`,
          build: () => [h("span", { class: "muted" }, formatFixed(l.avg, 2)), " → ", h("span", { class: `mark${stale}` }, formatFixed(l.mark, 2), l.stale ? h("span", { "aria-label": "stale" }, " ⏱") : null)],
          title: `Bid ${formatFixed(l.quote?.bid, 2)} · Ask ${formatFixed(l.quote?.ask, 2)} · LTP ${formatFixed(l.quote?.ltp ?? l.ltp, 2)} · mark = ${l.markSrc ?? "none"}${l.expired ? " · Expired · settles at close" : ""}`,
        };
      case "pnl":
        return { sig: `${Math.round(v.u ?? 0)}|${v.u === null}`, build: () => (v.u === null ? DASH : money(v.u)), title: brokerNote(l, v.u) || null };
      case "pnlPct":
        return { sig: `${formatFixed(v.pct, 1)}`, build: () => (v.pct === null ? DASH : h("span", { class: tone(v.pct * 10) }, `${formatSigned(v.pct, 1)}%`)), title: l.q < 0 ? "Premium decayed (+ is good for a short)" : "Change on premium paid" };
      case "delta":
        return { sig: `${formatFixed(v.delta, 0)}|${formatFixed(v.dU, 2)}`, build: () => (v.delta === null ? DASH : [formatSigned(v.delta, 0), h("small", {}, formatFixed(v.dU, 2))]), title: "Position Δ in units (per-unit Δ below)" };
      case "theta":
        return { sig: `${formatFixed(v.theta, 0)}`, build: () => (v.theta === null ? DASH : money(v.theta)), title: null };
      case "vega":
        return { sig: `${formatFixed(v.vega, 0)}`, build: () => (v.vega === null ? DASH : rs(v.vega)), title: null };
      case "gamma":
        return { sig: `${formatFixed(v.gamma, 2)}`, build: () => (v.gamma === null ? DASH : formatSigned(v.gamma, 2)), title: null };
      case "iv":
        return { sig: `${formatFixed(l.iv, 1)}|${l.ivSolved}`, build: () => (l.kind === "FUT" ? DASH : [formatFixed(l.iv, 1), l.ivSolved ? h("sup", { class: "muted" }, "calc") : null]), title: l.ivSolved ? "Solved from the mark (no chain IV)" : null };
      case "dist": {
        const x = v.dist;
        if (!x) return { sig: "-", build: () => DASH, title: null };
        return {
          sig: `${sig1(x.sigma)}|${x.dir}|${x.itm}|${x.tested}`,
          build: () => (l.q < 0 && x.itm ? h("span", { class: "down strong" }, "ITM") : h("span", { class: x.tested ? "warn-ink strong" : undefined }, `${sig1(x.sigma)}σ ${x.dir === "up" ? "↑" : "↓"}`)),
          title: `${formatSigned(x.pts, 0)} pts (${formatSigned(x.pct, 2)}%) from the ${expiryText(l.expiry)} forward ${formatInt(l.F)}${x.tested ? (x.itm ? " · short is in the money" : " · tested: within 0.5σ") : ""}`,
        };
      }
      default:
        return { sig: "", build: () => DASH, title: null };
    }
  }
  function groupStats(g) {
    const open = g.legs.filter((l) => l.q);
    let pnlU = 0;
    let delta = 0;
    let theta = 0;
    for (const l of open) {
      pnlU += O.legUnrealised(l);
      if (!l.inc || !l.priced) continue;
      delta += l.q * (l.kind === "FUT" ? 1 : l.greeks?.delta ?? 0);
      theta += l.kind === "FUT" ? 0 : l.q * (l.greeks?.theta ?? 0);
    }
    pnlU += g.legs.reduce((t, l) => t + (l.realised ?? 0), 0);
    const opt = open.filter((l) => l.kind === "OPT" && num(l.avg) !== null);
    const credit = -opt.reduce((t, l) => t + l.avg * l.q, 0);
    const cost = -opt.reduce((t, l) => t + (l.mark ?? l.avg) * l.q, 0);
    return { pnl: pnlU, delta, theta, kept: credit > 0 ? Math.max(-999, Math.min(100, ((credit - cost) / credit) * 100)) : null };
  }
  const groupTitle = (g) => (g.expiry ? `${expiryText(g.expiry)} · ${O.isExpiryDay(g.expiry) ? "Expires today" : O.timeToExpiry(g.expiry).label}` : "All expiries");
  function groupIncState(g) {
    const open = g.legs.filter((l) => l.q);
    const on = open.filter((l) => l.inc).length;
    return on === 0 ? "off" : on === open.length ? "on" : "mixed";
  }

  const shownLeg = (l) => Boolean(l.q) || cfg().closed;
  /** Groups with a row to draw (a group of closed legs only is hidden unless closed legs are shown). */
  const shownGroups = () => groups.filter((g) => g.legs.some(shownLeg));
  /** Row symbols in the order they are drawn: group by group, futures first, then strike, CE before PE. */
  const displayOrder = () => shownGroups().flatMap((g) => g.legs).filter((l) => rowRefs.has(l.symbol)).map((l) => l.symbol);
  function drawPositions() {
    const a = account();
    const phone = isPhone();
    const narrow = isNarrow();
    const visibleLegs = legs.filter((l) => l.q || cfg().closed);
    const titleSig = `${st.underlying}|${visibleLegs.filter((l) => l.q).length}|${a?.label}`;
    if (titleEl.__sig !== titleSig) {
      titleEl.__sig = titleSig;
      const n = visibleLegs.filter((l) => l.q).length;
      titleEl.replaceChildren(h("strong", {}, `${st.underlying} positions`), h("span", { class: "muted" }, n ? ` · ${plural(n, "leg")}` : ""));
    }
    exitAllBtn.hidden = !legs.some((l) => l.q);
    keysEl.hidden = !legs.some((l) => l.q);
    if (!a) return setBody("noacct", () => h("p", { class: "desk-empty" }, "Choose an account that can place orders. ", h("a", { href: "#/accounts" }, "Accounts")));
    if (!d.loaded) return setBody("loading", () => h("div", { class: "pos-skel", "aria-label": "Loading positions" }, h("i"), h("i"), h("i")));
    if (d.error && !d.lastOk) return setBody(`err|${d.error.message}`, () => h("div", { class: "desk-pad" }, alertBox(d.error)));
    if (!visibleLegs.length) {
      const others = O.bookUnderlyings(d.all, st.underlying);
      return setBody(`empty|${st.underlying}|${JSON.stringify(others)}`, () =>
        h(
          "div",
          { class: "desk-empty pos-empty" },
          h("p", {}, `No open ${st.underlying} options or futures on ${a.label}.`),
          others.length ? h("p", {}, "Open elsewhere: ", others.map((o) => h("button", { type: "button", class: "pos-uchip", onclick: () => setUnderlying(o.underlying) }, `${o.underlying} (${formatInt(o.legs)})`))) : null,
          h("p", {}, h("a", { href: "#/chain" }, "Trade from the Option Chain"), " · ", h("a", { href: "#/strategy" }, "Build a strategy")),
        ),
      );
    }
    const cols = colsNow();
    const sig = JSON.stringify([phone, narrow, cols, shownGroups().map((g) => [g.key, g.legs.filter(shownLeg).map((l) => l.symbol)]), [...collapsed], Boolean(d.error)]);
    if (sig !== layoutSig) {
      layoutSig = sig;
      rowRefs.clear();
      groupRefs.clear();
      const had = bodyEl.contains(document.activeElement) ? document.activeElement?.dataset?.key ?? null : null;
      bodyEl.replaceChildren(...[d.error ? h("div", { class: "desk-pad" }, alertBox(d.error), h("p", { class: "muted small" }, `Last updated ${istTime(d.lastOk)}`)) : null, phone ? buildCards() : buildTable(cols, narrow)].filter(Boolean));
      bodyEl.__mode = "list";
      if (had) bodyEl.querySelector(`[data-key="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
    }
    patchRows(cols);
    drawBulk();
  }
  function setBody(mode, build) {
    if (bodyEl.__mode === mode) return;
    bodyEl.__mode = mode;
    layoutSig = "";
    rowRefs.clear();
    groupRefs.clear();
    bodyEl.replaceChildren(build());
    drawBulk();
  }
  /** The include checkbox inside a label that is its touch target; a tap on it never selects the row. */
  function incBox(label, onChange) {
    const i = h("input", { type: "checkbox", "aria-label": label, class: "pos-inc" });
    i.addEventListener("change", () => onChange(i.checked));
    const hit = h("label", { class: "pos-inc-hit" }, i);
    hit.addEventListener("click", (e) => e.stopPropagation());
    return [hit, i];
  }
  function toggleInclude(syms, on) {
    const ex = new Set(cfg().excluded[st.account] ?? []);
    for (const s of syms) (on ? ex.delete(s) : ex.add(s));
    setExcluded([...ex]);
    price(O.bookLegs(d.all, st.underlying, { closed: true }));
    draw();
  }
  function buildTable(cols, narrow) {
    const shown = cols;
    const ncol = shown.length + 3;
    const thead = h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "c-inc" }, h("span", { class: "sr-only" }, "Include in risk"), h("span", { "aria-hidden": "true", title: "Include in risk" }, "☑")), h("th", { scope: "col" }, "Contract"), shown.map((k) => h("th", { scope: "col", class: `num ${OPT_X.has(k) ? "opt-x" : ""}`.trim(), title: O.POS_COLUMNS.find((c) => c[0] === k)?.[2] }, COL_HEAD[k])), h("th", { scope: "col", class: "act" }, h("span", { class: "sr-only" }, "Actions"))));
    const bodies = shownGroups().map((g) => {
      const head = h("tr", { class: "pos-ghead" });
      const [incHit, inc] = incBox(`Include every ${groupTitle(g)} leg in risk`, (on) => toggleInclude(g.legs.filter((l) => l.q).map((l) => l.symbol), on));
      const title = h("span", { class: "pos-gtitle" });
      const stats = h("span", { class: "pos-gstats" });
      const locked = h("span", { class: "pos-locked", hidden: true });
      const acts = h(
        "span",
        { class: "pos-gacts" },
        g.expiry ? h("button", { type: "button", class: "small plain", onclick: () => analyse(g), title: "Open this expiry's option legs in the strategy builder (exact quantities)" }, "Analyse") : null,
        h("button", { type: "button", class: "small plain", onclick: () => openExitPlan(g.legs.filter((l) => l.q), `${groupTitle(g).split(" · ")[0]}`) }, "Exit group"),
      );
      head.append(h("th", { scope: "rowgroup", colspan: String(ncol) }, h("div", { class: "pos-gline" }, incHit, title, stats, acts), locked));
      groupRefs.set(g.key, { inc, title, stats, locked });
      const rows = g.legs.filter(shownLeg).map((l) => {
        const tr = h("tr", { tabindex: "-1", "data-key": l.symbol, class: l.q ? "" : "closed" });
        const cells = new Map();
        const [iHit, iBox] = incBox(`Include ${fullName(l)} in risk`, (on) => toggleInclude([l.symbol], on));
        tr.append(h("td", { class: "c-inc" }, l.q ? iHit : null));
        const contract = h("td", { class: "c-contract" });
        cells.set("contract", contract);
        tr.append(contract);
        for (const k of shown) {
          const td = h("td", { class: `num c-${k} ${OPT_X.has(k) ? "opt-x" : ""}`.trim() });
          cells.set(k, td);
          tr.append(td);
        }
        const more = h("button", { type: "button", class: "icon-btn tiny pos-more", "aria-label": `More for ${fullName(l)}`, "aria-haspopup": "menu", onclick: (e) => (e.stopPropagation(), legMenu(l.symbol, e.currentTarget)) }, icon("more"));
        tr.append(h("td", { class: "act" }, h("span", { class: "pos-acts" }, l.q ? h("button", { type: "button", class: "small plain", "aria-label": `Exit ${fullName(l)}`, onclick: (e) => (e.stopPropagation(), exitLeg(l.symbol)) }, "Exit") : null, l.q ? more : null)));
        tr.addEventListener("click", (e) => {
          if (e.target.closest("button, input, a, label")) return;
          rowClick(l.symbol, e.shiftKey);
        });
        rowRefs.set(l.symbol, { el: tr, cells, inc: iBox });
        return tr;
      });
      return h("tbody", { "data-group": g.key }, head, rows);
    });
    return h("div", { class: "table-wrap pos-wrap" }, h("table", { class: `desk-table pos-table${narrow ? " narrow" : ""}` }, thead, bodies));
  }
  function buildCards() {
    return h(
      "div",
      { class: "pos-cards" },
      shownGroups().map((g) => {
        const isOpen = !collapsed.has(g.key);
        const title = h("span", { class: "pos-gtitle" });
        const stats = h("span", { class: "pos-gstats" });
        const locked = h("span", { class: "pos-locked", hidden: true });
        const head = h(
          "button",
          { type: "button", class: "pos-cghead", "aria-expanded": String(isOpen), onclick: () => (isOpen ? collapsed.add(g.key) : collapsed.delete(g.key), drawPositions()) },
          h("span", { class: "pos-gline" }, title, stats),
          icon("chevron"),
        );
        groupRefs.set(g.key, { inc: null, title, stats, locked });
        const list = isOpen
          ? h(
              "div",
              { role: "list", class: "pos-clist" },
              g.legs.filter(shownLeg).map((l) => {
                const l1 = h("span", { class: "pos-c1" });
                const l2 = h("span", { class: "pos-c2" });
                const card = h("button", { type: "button", class: `pos-card${l.q ? "" : " closed"}`, "data-key": l.symbol, onclick: () => legSheet(l.symbol) }, l1, l2);
                const item = h("div", { role: "listitem" }, card);
                rowRefs.set(l.symbol, { el: card, cells: new Map([["c1", l1], ["c2", l2]]), inc: null });
                return item;
              }),
            )
          : null;
        return h("section", { class: "pos-cgroup", "data-group": g.key }, head, locked, list, isOpen && g.expiry ? h("div", { class: "pos-cacts" }, h("button", { type: "button", class: "small", onclick: () => analyse(g) }, "Analyse"), h("button", { type: "button", class: "small", onclick: () => openExitPlan(g.legs.filter((l) => l.q), groupTitle(g).split(" · ")[0]) }, "Exit group")) : null);
      }),
    );
  }
  function patchRows(cols) {
    const phone = isPhone();
    for (const g of groups) {
      const ref = groupRefs.get(g.key);
      if (!ref) continue;
      const s = groupStats(g);
      setCell(ref.title, `${groupTitle(g)}|${g.structure.name}`, () => [h("strong", {}, groupTitle(g)), ` · ${g.structure.name}`]);
      setCell(ref.stats, JSON.stringify([Math.round(s.pnl), Math.round(s.delta), Math.round(s.theta), s.kept === null ? null : Math.round(s.kept), phone]), () =>
        phone
          ? [money(s.pnl)]
          : [h("span", {}, "P&L ", money(s.pnl)), h("span", {}, `Δ ${formatSigned(s.delta, 0)}`), h("span", {}, "Θ ", money(s.theta)), s.kept !== null ? h("span", {}, `kept ${formatPercent(s.kept, 0)}`) : null],
      );
      if (ref.inc) {
        const stt = groupIncState(g);
        ref.inc.checked = stt !== "off";
        ref.inc.indeterminate = stt === "mixed";
      }
      const lockedText = g.structure.locked && g.lockedValue !== null ? `Locked at expiry: ${rs(g.lockedValue)}` : "";
      setCell(ref.locked, lockedText, () => lockedText, { hidden: lockedText ? null : "" });
    }
    for (const l of legs) {
      const ref = rowRefs.get(l.symbol);
      if (!ref) continue;
      const v = legVm(l);
      if (phone) {
        const c1 = ref.cells.get("c1");
        const c2 = ref.cells.get("c2");
        setCell(c1, JSON.stringify([l.q, l.lot, Math.round(v.u ?? 0), l.inc]), () => [h("span", { class: `side-tag ${l.q > 0 ? "buy" : "sell"}` }, l.q > 0 ? "B" : "S"), h("strong", {}, legName(l)), h("span", { class: "pos-clots" }, lotsText(l)), l.inc ? null : h("span", { class: "pos-chip" }, "excluded"), h("span", { class: "pos-cpnl" }, v.u === null ? DASH : money(v.u))]);
        const parts = [`${formatFixed(l.avg, 2)} → ${formatFixed(l.mark, 2)}`, v.delta !== null ? `Δ ${formatSigned(v.delta, 0)}` : null, v.theta !== null ? `Θ ${rs(v.theta)}` : null, v.dist ? (l.q < 0 && v.dist.itm ? "ITM" : `${sig1(v.dist.sigma)}σ`) : null].filter(Boolean);
        setCell(c2, parts.join(" · "), () => parts.join(" · "));
        ref.el.setAttribute("aria-label", `${legSpeech(l)}, P&L ${v.u === null ? "unknown" : `${v.u < 0 ? "minus" : "plus"} ${formatInt(Math.abs(v.u))} rupees`}`);
        continue;
      }
      if (ref.inc && ref.inc.checked !== l.inc) ref.inc.checked = l.inc;
      ref.el.classList.toggle("excluded", !l.inc);
      ref.el.classList.toggle("sel", selected.has(l.symbol));
      ref.el.classList.toggle("focus", focusSym === l.symbol);
      ref.el.setAttribute("aria-selected", String(selected.has(l.symbol)));
      setCell(ref.cells.get("contract"), `${l.q > 0}|${l.product}|${l.expired}`, () =>
        h("span", { class: "pos-leg" }, h("span", { class: `side-tag ${l.q > 0 ? "buy" : l.q < 0 ? "sell" : ""}` }, l.q > 0 ? "B" : l.q < 0 ? "S" : "·"), h("span", {}, h("strong", {}, legName(l)), h("small", {}, `${expiryText(l.expiry)} · ${l.expired ? "Expired · settles at close" : PRODUCT[l.product] ?? l.product}`))),
      );
      for (const k of cols) {
        const c = cellFor(k, l, v);
        setCell(ref.cells.get(k), c.sig, c.build, { title: c.title });
      }
    }
  }
  function rowClick(sym, shift) {
    focusSym = sym;
    const order = displayOrder();
    if (shift && anchor && order.includes(anchor)) {
      const [i, j] = [order.indexOf(anchor), order.indexOf(sym)].sort((a, b) => a - b);
      for (const s of order.slice(i, j + 1)) selected.add(s);
    } else {
      if (selected.has(sym)) selected.delete(sym);
      else selected.add(sym);
      anchor = sym;
    }
    patchRows(colsNow());
    drawBulk();
  }
  function drawBulk() {
    const n = selected.size;
    const sig = `${n}|${isPhone()}`;
    if (bulkEl.__sig === sig) return;
    bulkEl.__sig = sig;
    bulkEl.hidden = !n || isPhone();
    if (!n) return bulkEl.replaceChildren();
    bulkEl.replaceChildren(
      h("span", {}, `${formatInt(n)} selected`),
      h("button", { type: "button", class: "small", onclick: () => openExitPlan(legs.filter((l) => selected.has(l.symbol) && l.q), "selected") }, "Exit selected"),
      h("button", { type: "button", class: "small plain", onclick: () => (selected.clear(), patchRows(colsNow()), drawBulk()) }, "Clear"),
    );
  }
  /** The row's ⋯ menu (desktop / tablet) and the card's action sheet (phone) share these actions. */
  function legActions(l) {
    const g = groups.find((x) => x.legs.includes(l));
    return [
      ["Exit…", () => exitLeg(l.symbol)],
      ["Exit 25%", () => exitLeg(l.symbol, 25)],
      ["Exit 50%", () => exitLeg(l.symbol, 50)],
      ["Exit 75%", () => exitLeg(l.symbol, 75)],
      [l.inc ? "Exclude from risk" : "Include in risk", () => toggleInclude([l.symbol], !l.inc)],
      ...(g?.expiry && l.kind === "OPT" ? [["Analyse this expiry", () => analyse(g)]] : []),
      ...(l.kind === "OPT" ? [["Open in chain", () => openInChain(l)]] : []),
    ];
  }
  let closeMenu = null;
  function legMenu(sym, btn) {
    const l = legs.find((x) => x.symbol === sym);
    if (!l) return;
    closeMenu?.(false);
    const close = (refocus = true) => {
      if (closeMenu === close) closeMenu = null;
      menu.remove();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", esc, true);
      if (refocus && btn.isConnected) btn.focus();
    };
    closeMenu = close;
    const outside = (e) => !menu.contains(e.target) && close();
    const esc = (e) => e.key === "Escape" && (e.stopPropagation(), close());
    const menu = h("div", { class: "popover pos-menu menu-list", role: "menu" }, legActions(l).map(([label, fn]) => h("button", { type: "button", role: "menuitem", class: "small plain", onclick: () => (close(), fn()) }, label)));
    const r = btn.getBoundingClientRect();
    const host = posPanel.getBoundingClientRect();
    menu.style.top = `${r.bottom - host.top + 4}px`;
    menu.style.right = `${Math.max(8, host.right - r.right)}px`;
    posPanel.append(menu);
    menu.querySelector("button")?.focus();
    setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", esc, true);
    });
  }
  async function legSheet(sym) {
    const l = legs.find((x) => x.symbol === sym);
    if (!l) return;
    const v = legVm(l);
    const act = await modal({
      title: fullName(l),
      body: (close) =>
        h(
          "div",
          { class: "stack" },
          h("p", { class: "muted" }, `${legSpeech(l)} · ${formatFixed(l.avg, 2)} → ${formatFixed(l.mark, 2)} · P&L `, v.u === null ? DASH : money(v.u)),
          h("div", { class: "menu-list pos-sheet" }, legActions(l).map(([label, fn], i) => h("button", { type: "button", class: i === 0 ? "primary" : "", onclick: () => close(fn) }, label))),
        ),
    });
    if (typeof act === "function") act();
  }
  const openInChain = (l) => goChain(l.expiry, l.strike, l.right === "PE" ? "pe" : "ce");

  // ── Single exit (the ticket) ──
  function exitLeg(sym, pct = 100) {
    const l = legs.find((x) => x.symbol === sym);
    if (!l || !l.q) return;
    const abs = Math.abs(l.q);
    const whole = Math.floor(abs / l.lot);
    const qty = pct >= 100 || whole < 1 ? abs : Math.min(whole, Math.max(1, Math.floor((whole * pct) / 100 + 0.5))) * l.lot;
    openTicket({
      row: { strike: l.strike },
      right: l.right ?? "CE",
      kind: l.kind,
      side: l.q > 0 ? "SELL" : "BUY",
      qty,
      held: abs,
      symbol: l.symbol,
      product: l.product,
      expiry: l.expiry,
      exit: true,
      quote: legQuote(l.symbol),
      units: abs % l.lot !== 0,
      lotSize: l.lot,
      tick: l.tick,
      freezeQty: l.freeze,
      name: fullName(l),
    }).then((r) => r === "placed" && tick());
  }

  // ── Analyse in the builder ──
  function analyse(g) {
    const opts = g.legs.filter((l) => l.q && l.kind === "OPT");
    if (!opts.length) return toast("No option legs in this group: futures are not in the builder yet");
    const exp = g.expiry ?? opts[0].expiry;
    const legsOut = opts
      .filter((l) => l.expiry === exp)
      .map((l) => ({ kind: "OPT", right: l.right, strike: l.strike, expiry: l.expiry, side: l.q > 0 ? "BUY" : "SELL", lots: Math.max(1, Math.ceil(Math.abs(l.q) / l.lot)), units: Math.abs(l.q), lotSize: l.lot, entry: l.avg, entryTag: "avg", product: l.product, symbol: l.symbol }))
      .slice(0, O.MAX_LEGS);
    if (g.legs.some((l) => l.q && l.kind === "FUT")) toast("Futures are not in the builder yet");
    else if (opts.some((l) => l.expiry !== exp)) toast("The builder is single-expiry: other expiries are left out");
    st.baskets[`${st.underlying}|${exp}`] = legsOut;
    st.expiry = exp;
    save();
    location.hash = "#/strategy";
  }

  // ── Exit plan (Exit all / group / selected) ──
  async function openExitPlan(scope, label) {
    const a = account();
    if (!a) return toast("Choose an account that can place orders first.");
    const syms = scope.filter((l) => l.q).map((l) => l.symbol);
    if (!syms.length) return;
    const current = () => legs.filter((l) => syms.includes(l.symbol) && l.q);
    let type = cfg().exitType;
    let pct = 100;
    let sending = false;
    let finished = false;
    const lockedGroups = groups.filter((g) => g.structure.locked && g.legs.some((l) => syms.includes(l.symbol)));
    if (lockedGroups.length && type === "market") type = "mid";
    const typeSeg = segmented("Order type", [["mid", "Limit at mid"], ["touch", "At touch"], ["market", "Market"]], type);
    const sizeSeg = segmented("Size", [["100", "100%"], ["50", "50%"], ["25", "25%"]], "100");
    const modeSeg = a.liveAllowedByConfig ? segmented("Mode", [["paper", "Paper"], ["live", "Live"]], "paper") : null;
    const ack = h("input", { type: "checkbox" });
    const ackRow = h("label", { class: "check live-ack", hidden: true }, ack, `I understand these send real orders to ${a.label}.`);
    const mktNote = h("p", { class: "pos-note warn", hidden: true }, "Market orders are sent with protection; illiquid strikes may fill far from mid.");
    const unpricedNote = h("p", { class: "pos-note bad", hidden: true }, "A leg has no bid, ask or LTP, so no limit price can be set. It is never sent at market: exit it from its own ticket, or choose Market.");
    const listEl = h("ol", { class: "pos-plan" });
    const totalsEl = h("div", { class: "ticket-figs pos-plan-tot" });
    const checksEl = h("ul", { class: "ticket-checks", hidden: true });
    const statusEl = h("div", { class: "pos-plan-status", "aria-live": "polite" });
    let plan = null;
    let checks = [];
    const live = () => modeSeg?.value === "live";
    const draw = () => {
      if (sending || finished) return;
      plan = O.exitPlan(current(), { type, pct });
      const sig = JSON.stringify(plan.orders.map((o) => [o.symbol, o.side, o.qty, o.price, o.unpriced, Math.round(o.slip ?? 0)]));
      // The checks shown (and the Send button) must describe the plan that will be sent: preview it again on change.
      const ps = JSON.stringify([live(), plan.orders.map((o) => [o.symbol, o.side, o.qty, o.price, o.market])]);
      if (ps !== pvSig) schedulePreview(ps);
      if (listEl.__sig !== sig) {
        listEl.__sig = sig;
        listEl.replaceChildren(
          ...plan.orders.map((o) =>
            h(
              "li",
              {},
              h("span", { class: `side-tag ${o.side === "BUY" ? "buy" : "sell"}` }, o.side === "BUY" ? "B" : "S"),
              h("span", { class: "pos-plan-name" }, h("strong", {}, `${o.side === "BUY" ? "Buy" : "Sell"} ${formatInt(o.qty)} ${legName(o.leg)}`), h("small", {}, `${expiryText(o.leg.expiry)}${o.slices.length > 1 ? ` · ${formatInt(o.slices.length)} orders (${o.slices.map(formatInt).join(" + ")})` : ""}`)),
              o.unpriced
                ? h("span", { class: "num down", title: "No bid, ask or LTP to set a limit from" }, "No quote", h("small", {}, "exit it from its ticket"))
                : h("span", { class: "num" }, o.market ? "MKT" : formatFixed(o.price, 2), h("small", {}, `slip ${o.slip === null ? DASH : formatRupee(o.slip, 0)}`)),
            ),
          ),
        );
      }
      totalsEl.replaceChildren(
        h("div", {}, h("small", {}, "Orders"), formatInt(plan.count)),
        h("div", {}, h("small", {}, "Est. slippage"), formatRupee(plan.slippage, 0)),
        h("div", {}, h("small", {}, "Est. P&L if filled"), money(plan.pnl)),
      );
      mktNote.hidden = type !== "market";
      unpricedNote.hidden = !plan.unpriced;
      ackRow.hidden = !live();
      drawSend();
    };
    // Preview every order (its first slice): the Bridge's checks, shown as they come back. A block stops the send.
    let pvSeq = 0;
    let pvSig = null;
    let pvPending = true;
    let pvTimer = null;
    const schedulePreview = (sig) => {
      pvSig = sig;
      pvPending = true;
      clearTimeout(pvTimer);
      pvTimer = setTimeout(preview, 250);
      drawSend();
    };
    const preview = async () => {
      const seq = ++pvSeq;
      pvPending = true;
      const p = O.exitPlan(current(), { type, pct });
      const priced = p.orders.filter((o) => !o.unpriced);
      const res = await Promise.all(priced.map((o) => optional(api("/v1/orders/preview", { method: "POST", body: orderBody(o, o.slices[0]) }))));
      if (seq !== pvSeq) return;
      pvPending = false;
      checks = [];
      res.forEach((r, i) => {
        const nm = `${legName(priced[i].leg)} ${expiryText(priced[i].leg.expiry)}`;
        if (r.error) checks.push({ severity: "block", message: `${nm}: ${r.error.message ?? "preview failed"}` });
        for (const c of r.data?.data?.checks ?? []) checks.push({ severity: c.severity, message: `${nm}: ${c.message}` });
      });
      checksEl.hidden = !checks.length;
      checksEl.replaceChildren(...checks.map((x) => h("li", { class: x.severity === "block" ? "bad" : "warn" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", {}, `${x.severity === "block" ? "Blocked: " : ""}${x.message}`))));
      drawSend();
    };
    const orderBody = (o, qty) => {
      // The order type is the one chosen, never inferred from a missing price (an unpriced leg is not sent at all).
      const b = { account: a.id, symbol: o.symbol, side: o.side, quantity: qty, product: o.product ?? "MARGIN", orderType: o.market ? "MARKET" : "LIMIT" };
      if (!o.market) b.price = o.price;
      if (live()) b.mode = "live";
      return b;
    };
    let sendBtn = null;
    const drawSend = () => {
      if (!sendBtn) return;
      if (finished) {
        sendBtn.textContent = "Done";
        sendBtn.disabled = false;
        sendBtn.className = "primary";
        // Nothing left to cancel or change once the orders are out.
        sendBtn.previousElementSibling?.remove();
        for (const b of body.querySelectorAll(".segmented button, input")) b.disabled = true;
        return;
      }
      const blocked = checks.some((x) => x.severity === "block");
      sendBtn.textContent = sending ? "Sending…" : `Send ${plural(plan?.count ?? 0, "order")}${live() ? " · LIVE" : ""}`;
      sendBtn.className = live() ? "danger" : "primary";
      sendBtn.disabled = sending || blocked || pvPending || Boolean(plan?.unpriced) || !plan?.count || (live() && !ack.checked);
      sendBtn.title = plan?.unpriced ? "A leg has no quote to price a limit order: exit it from its own ticket" : pvPending ? "Checking with the Bridge…" : "";
    };
    typeSeg.addEventListener("change", () => ((type = typeSeg.value), draw()));
    sizeSeg.addEventListener("change", () => ((pct = Number(sizeSeg.value)), draw()));
    modeSeg?.addEventListener("change", draw);
    ack.addEventListener("change", drawSend);
    const timer = setInterval(draw, 3000);
    const lockText = lockedGroups.length ? `This group is a locked ${lockedGroups.map((g) => g.structure.name.toLowerCase()).join(", ")}. Exiting leg by leg can break the lock; limit orders at mid are recommended.` : "";
    async function send() {
      sending = true;
      drawSend();
      const p = plan;
      const batch = `exit-${Date.now().toString(36)}`;
      const total = p.orders.length;
      let done = 0;
      let failed = null;
      for (const [i, o] of p.orders.entries()) {
        try {
          for (const [j, q] of o.slices.entries()) {
            statusEl.replaceChildren(h("p", { class: "muted" }, `Sending ${formatInt(i + 1)} of ${formatInt(total)}: ${o.side === "BUY" ? "buy" : "sell"} ${formatInt(q)} ${legName(o.leg)}…`));
            await api("/v1/orders", { method: "POST", body: { ...orderBody(o, q), clientOrderId: `${batch}-${i}-${j}` } });
          }
          done += 1;
        } catch (err) {
          failed = { o, err };
          break;
        }
      }
      sending = false;
      finished = true;
      clearInterval(timer);
      const left = p.orders.slice(done);
      const shortLeft = left.some((o) => o.leg.kind === "OPT" && o.leg.q < 0);
      statusEl.replaceChildren(
        failed
          ? h(
              "div",
              { class: "stack" },
              h("p", { class: shortLeft ? "down strong" : "" }, `Sent ${formatInt(done)} of ${formatInt(total)}. Still open: ${left.map((o) => `${o.leg.q > 0 ? "long" : "short"} ${legName(o.leg)}`).join(", ")}${shortLeft ? " (includes a short: it is uncovered if its hedge was closed)" : " (hedges only; no naked shorts)"}`),
              alertBox(failed.err),
            )
          : h("p", { class: "up strong" }, `Sent ${plural(total, "exit order")}.`),
      );
      drawSend();
      tick();
    }
    const body = h(
      "div",
      { class: "stack ticket pos-exit" },
      lockText ? h("p", { class: "pos-note warn" }, lockText) : null,
      segField("Price", typeSeg),
      mktNote,
      unpricedNote,
      h("div", { class: "ticket-grid" }, segField("Size", sizeSeg), modeSeg ? segField("Mode", modeSeg) : h("div", { class: "field" }, h("span", {}, "Account"), h("span", { class: "ticket-acct" }, h("span", {}, a.label), h("span", { class: "muted nowrap" }, "· paper")))),
      ackRow,
      h("div", { class: "field" }, h("span", {}, "Send order: shorts first (largest Δ), then longs, futures last"), listEl),
      totalsEl,
      checksEl,
      statusEl,
      h("p", { class: "muted small" }, "Margin effect: shown by your broker on the order."),
    );
    const done = modal({
      title: `Exit ${plural(syms.length, "leg")} · ${st.underlying}${label ? ` · ${label}` : ""}`,
      body,
      canClose: () => !sending,
      buttons: [
        { label: "Cancel", value: false },
        {
          label: "Send",
          cls: "primary",
          onClick: async () => {
            if (finished) return true;
            await send();
            return false;
          },
        },
      ],
    });
    sendBtn = document.querySelector("#dialog .dialog-actions button:last-child");
    draw();
    await done;
    clearInterval(timer);
    clearTimeout(pvTimer);
    pvSeq += 1;
  }

  // ── Risk: payoff of the book ──
  const pay = createBookPayoff(payoffBox, () => (isNarrow() ? null : scenBox.offsetHeight - 56));
  let riskSig = "";
  function hedgeLegsPriced() {
    return hd.open && hd.show && hd.plan && !hd.plan.error ? hd.hedgeLegs.filter((l) => l.priced) : [];
  }
  function drawRisk() {
    const inc = included().filter((l) => l.priced);
    riskPanel.hidden = !legs.some((l) => l.q);
    if (riskPanel.hidden) return;
    riskBody.className = `pos-risk tab-${riskTab}`;
    const sub = riskPanel.querySelector(".pos-risk-sub");
    const near = nearest();
    const subText = near ? ` · nearest ${expiryText(near.expiry)}${book?.excluded ? ` · ${plural(book.excluded, "leg")} excluded` : ""}` : "";
    if (sub.textContent !== subText) sub.textContent = subText;
    const S = spot;
    const sig = JSON.stringify([inc.map((l) => [l.symbol, l.q, formatFixed(l.mark, 2), formatFixed(l.iv, 2), formatFixed(l.F, 1)]), sc, formatFixed(S, 1), hedgeLegsPriced().map((l) => [l.symbol, l.q]), cfg().ladder, cfg().axis, cfg().lossLimit, isPhone(), isNarrow()]);
    if (sig === riskSig) return;
    riskSig = sig;
    if (!inc.length || !S) {
      pay.update(null);
      drawScenario(null);
      return;
    }
    const sp = sigmaPct();
    const sigPts = sp ? (S * sp) / 100 : S * 0.01;
    const ks = inc.filter((l) => l.kind === "OPT").map((l) => l.strike);
    const far = ks.length ? Math.max(...ks.map((k) => Math.abs(k - S))) : 0;
    const half = Math.max(2.6 * sigPts, 1.35 * far, 0.015 * S);
    const lo = Math.max(1, S - half);
    const hi = S + half;
    const xs = [];
    for (let i = 0; i <= 140; i++) xs.push(lo + ((hi - lo) * i) / 140);
    for (const k of ks) if (k > lo && k < hi) xs.push(k);
    xs.sort((a, b) => a - b);
    const shift = (x, extra = {}) => ({ dS: x / S - 1, ...extra });
    const fd = firstDays();
    const fNow = (x) => O.scenarioPnl(inc, shift(x));
    const hasTarget = sc.days > 0 || sc.dIv !== 0;
    const fTarget = (x) => O.scenarioPnl(inc, shift(x, { dIv: sc.dIv, days: sc.days }));
    const fExp = (x) => O.scenarioPnl(inc, shift(x, { days: fd }));
    const hl = hedgeLegsPriced();
    const fHedge = hl.length ? (x) => O.scenarioPnl([...inc, ...hl], shift(x)) : null;
    const now = xs.map(fNow);
    const target = hasTarget ? xs.map(fTarget) : null;
    const exp = xs.map(fExp);
    const hedge = fHedge ? xs.map(fHedge) : null;
    const b = (k) => [S * Math.exp((-k * sp) / 100), S * Math.exp((k * sp) / 100)];
    // The scenario first: on desktop the payoff grows to the height of the scenario column beside it.
    drawScenario({ inc, S, sp, fd });
    pay.update({
      xs,
      lo,
      hi,
      spot: S,
      now,
      target,
      exp,
      hedge,
      b1: sp ? b(1) : null,
      b2: sp ? b(2) : null,
      bes: O.curveRoots(fNow, xs),
      besT: hasTarget ? O.curveRoots(fTarget, xs) : [],
      expLabel: near ? `At ${expiryText(near.expiry)} expiry` : "At expiry",
      targetLabel: `Target ${sc.days ? `+${formatInt(sc.days)}d` : ""}${sc.dIv ? ` IV ${formatSigned(sc.dIv, 1)}` : ""}`.trim(),
      fns: { now: fNow, target: hasTarget ? fTarget : null, exp: fExp, hedge: fHedge },
    });
  }

  // ── Risk: scenario ──
  const spotIn = h("input", { type: "range", min: "-10", max: "10", step: "0.25", value: "0", "aria-label": "Spot move" });
  const ivIn = h("input", { type: "range", min: "-10", max: "10", step: "0.5", value: "0", "aria-label": "IV change in vol points" });
  const daysIn = h("input", { type: "range", min: "0", max: "30", step: "1", value: "0", "aria-label": "Days forward" });
  const spotVal = h("output", {});
  const ivVal = h("output", {});
  const daysVal = h("output", {});
  const spotChips = h("div", { class: "pos-chips" });
  const dayChips = h("div", { class: "pos-chips" });
  const outLine = h("p", { class: "pos-scen-out", "aria-live": "polite" });
  const matrixEl = h("div", { class: "pos-matrix-wrap" });
  const matrixFoot = h("div", { class: "pos-matrix-foot" });
  const resetBtn = h("button", { type: "button", class: "small plain", onclick: () => setScenario({ pct: 0, dIv: 0, days: 0 }) }, icon("refresh"), "Reset");
  const axisSeg = segmented("Matrix columns", [["iv", "Spot × IV"], ["days", "Spot × days"]], cfg().axis);
  axisSeg.addEventListener("change", () => (setCfg({ axis: axisSeg.value }), (riskSig = ""), drawRisk()));
  const sliderRow = (label, input, out, chips) => h("div", { class: "pos-slider" }, h("label", {}, h("span", {}, label), out), input, chips ?? null);
  scenBox.append(
    h("div", { class: "pos-sliders" }, sliderRow("Spot", spotIn, spotVal, spotChips), sliderRow("IV", ivIn, ivVal), sliderRow("Days", daysIn, daysVal, dayChips)),
    outLine,
    h("div", { class: "pos-matrix-head" }, h("strong", {}, "Unrealised P&L"), axisSeg, resetBtn),
    matrixEl,
    matrixFoot,
  );
  let rafPending = false;
  const onSlide = () => {
    sc.pct = Number(spotIn.value);
    sc.dIv = Number(ivIn.value);
    sc.days = Number(daysIn.value);
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      drawRisk();
    });
  };
  for (const el of [spotIn, ivIn, daysIn]) el.addEventListener("input", onSlide);
  function setScenario(p) {
    Object.assign(sc, p);
    sc.pct = Math.max(-10, Math.min(10, sc.pct));
    sc.dIv = Math.max(-10, Math.min(10, sc.dIv));
    sc.days = Math.max(0, Math.min(Number(daysIn.max) || 0, sc.days));
    spotIn.value = String(sc.pct);
    ivIn.value = String(sc.dIv);
    daysIn.value = String(sc.days);
    drawRisk();
  }
  let matrixSig = "";
  let cellRefs = [];
  function drawScenario(ctx) {
    const md = maxDays();
    if (daysIn.max !== String(md)) {
      daysIn.max = String(md);
      if (sc.days > md) sc.days = md;
      daysIn.value = String(sc.days);
    }
    const S = ctx?.S ?? spot;
    const sp = ctx?.sp ?? sigmaPct();
    spotVal.textContent = `${formatSigned(sc.pct, 2)}% · ${formatInt(S ? S * (1 + sc.pct / 100) : null)}`;
    spotIn.setAttribute("aria-valuetext", `${sc.pct < 0 ? "minus " : ""}${formatFixed(Math.abs(sc.pct), 2)} percent, ${formatInt(S ? S * (1 + sc.pct / 100) : null)}`);
    ivVal.textContent = `${formatSigned(sc.dIv, 1)} pts`;
    ivIn.setAttribute("aria-valuetext", `${sc.dIv < 0 ? "minus " : ""}${formatFixed(Math.abs(sc.dIv), 1)} vol points`);
    daysVal.textContent = sc.days ? `+${formatInt(sc.days)} d` : "Today";
    const chipsSig = `${formatFixed(sp, 2)}|${sc.pct}`;
    if (spotChips.__sig !== chipsSig) {
      spotChips.__sig = chipsSig;
      spotChips.replaceChildren(...[-2, -1, 0, 1, 2].map((k) => {
        const p = sp ? Math.round((k * sp) / 0.25) * 0.25 : null;
        return h("button", { type: "button", class: "small chip-btn", disabled: p === null, "aria-pressed": String(p !== null && p === sc.pct), onclick: () => setScenario({ pct: Math.max(-10, Math.min(10, p)) }) }, k === 0 ? "0" : `${k > 0 ? "+" : "−"}${Math.abs(k)}σ`);
      }));
    }
    const fd = Math.round(ctx?.fd ?? firstDays());
    const dSig = `${fd}|${sc.days}|${md}`;
    if (dayChips.__sig !== dSig) {
      dayChips.__sig = dSig;
      dayChips.replaceChildren(...[["Today", 0], ["+1", 1], ["+3", 3], ["First expiry", fd]].filter(([, v]) => v <= md).map(([l, v]) => h("button", { type: "button", class: "small chip-btn", "aria-pressed": String(sc.days === v), onclick: () => setScenario({ days: v }) }, l)));
    }
    if (!ctx) {
      outLine.textContent = legs.some((l) => l.q) ? "No priced legs to run scenarios on." : "";
      matrixEl.replaceChildren();
      matrixSig = "";
      matrixFoot.replaceChildren();
      return;
    }
    const { inc } = ctx;
    const shift = { dS: sc.pct / 100, dIv: sc.dIv, days: sc.days };
    const v = O.scenarioPnl(inc, shift);
    const v0 = O.scenarioPnl(inc, {});
    const g = O.scenarioGreeks(inc, shift);
    outLine.replaceChildren(h("span", {}, "P&L at scenario ", money(v)), h("span", { class: "muted" }, ` (vs now ${rs(v - v0)})`), h("span", {}, ` · Δ ${formatSigned(g.delta, 0)} · Θ ${rs(g.theta)} · Vega ${rs(g.vega)}`));
    const grid = O.scenarioGrid(inc, { ladder: cfg().ladder, axis: cfg().axis, days: sc.days, dIv: sc.dIv, sigmaPct: sp, F: S, firstDays: fd });
    const shape = JSON.stringify([cfg().ladder, cfg().axis, grid.cols.map((c) => c.label), grid.rows.length]);
    if (matrixSig !== shape) {
      matrixSig = shape;
      cellRefs = [];
      const table = h(
        "table",
        { class: "pos-matrix" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, cfg().ladder === "sigma" ? "Spot (σ)" : "Spot"), grid.cols.map((c) => h("th", { scope: "col", class: "num" }, c.label)))),
        h(
          "tbody",
          {},
          grid.rows.map((r, ri) => {
            const th = h("th", { scope: "row" });
            const tds = grid.cols.map((c, ci) => {
              const td = h("td", { class: "num", tabindex: "0", onclick: () => setScenario({ pct: Math.max(-10, Math.min(10, Math.round(grid.rows[ri].pct / 0.25) * 0.25)), ...(cfg().axis === "iv" ? { dIv: grid.cols[ci].dIv } : { days: Math.min(maxDays(), grid.cols[ci].days) }) }), onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), e.currentTarget.click()) });
              return td;
            });
            cellRefs.push({ th, tds });
            return h("tr", {}, th, tds);
          }),
        ),
      );
      matrixEl.replaceChildren(table);
    }
    const max = Math.max(1, ...grid.rows.flatMap((r) => r.cells.map((x) => Math.abs(x))));
    const loss = cfg().lossLimit;
    // The cell nearest the sliders gets the outline.
    let best = null;
    grid.rows.forEach((r, ri) => grid.cols.forEach((c, ci) => {
      const dist = Math.abs(r.pct - sc.pct) + (cfg().axis === "iv" ? Math.abs(c.dIv - sc.dIv) / 5 : Math.abs(c.days - sc.days) / 3);
      if (!best || dist < best.dist) best = { ri, ci, dist };
    }));
    grid.rows.forEach((r, ri) => {
      const ref = cellRefs[ri];
      const lbl = `${r.k !== null ? `${formatSigned(r.k, 1)}σ ` : ""}${formatSigned(r.pct, r.k !== null ? 2 : 0)}%`;
      setCell(ref.th, `${lbl}|${formatInt(r.price)}`, () => [h("span", {}, lbl), h("small", {}, formatInt(r.price))]);
      r.cells.forEach((v2, ci) => {
        const td = ref.tds[ci];
        const a = 0.06 + (0.22 * Math.abs(v2)) / max;
        const beyond = loss !== null && v2 < -loss;
        const cur = best && best.ri === ri && best.ci === ci;
        setCell(td, `${Math.round(v2 / 10)}|${beyond}|${cur}`, () => rc(v2), { class: `num${v2 > 0.5 ? " pos" : v2 < -0.5 ? " neg" : ""}${beyond ? " beyond" : ""}${cur ? " cur" : ""}`, "aria-current": cur ? "true" : null, "aria-description": beyond ? "beyond your loss limit" : null });
        td.style.setProperty("--a", String(Math.round(a * 100) / 100));
      });
    });
    const w = grid.worst;
    const nearLegs = inc.filter((l) => l.expiry === inc.map((x) => x.expiry).sort()[0]);
    const single = new Set(inc.map((l) => l.expiry)).size === 1 && inc.every((l) => l.kind === "OPT");
    let st0 = null;
    if (single) {
      const asStrat = nearLegs.map((l) => ({ kind: "OPT", right: l.right, strike: l.strike, side: l.q > 0 ? "BUY" : "SELL", lots: 1, lotSize: Math.abs(l.q), price: l.avg }));
      st0 = O.strategyStats(asStrat, 1, { spot: S });
    }
    const multi = "multi-expiry: see the grid";
    matrixFoot.replaceChildren(
      h("div", {}, h("span", {}, "Max loss in grid"), w ? h("strong", { class: tone(w.v) }, `${rc(w.v)} at ${formatSigned(grid.rows[w.r].pct, 1)}%, ${grid.cols[w.c].label}`) : DASH),
      h("div", {}, h("span", {}, "Max profit at expiry"), st0 ? h("strong", {}, st0.maxProfit === null ? "unlimited" : rc(st0.maxProfit)) : h("strong", { title: multi }, DASH)),
      h("div", {}, h("span", {}, "Max loss at expiry"), st0 ? h("strong", { class: "down" }, st0.maxLoss === null ? "unlimited" : rc(st0.maxLoss)) : h("strong", { title: multi }, DASH)),
    );
  }
  riskSeg.addEventListener("change", () => {
    riskTab = riskSeg.value;
    riskBody.className = `pos-risk tab-${riskTab}`;
    riskSig = "";
    drawRisk();
  });

  // ── Hedge helper ──
  const targetIn = h("input", { type: "number", step: "1", inputmode: "numeric", value: "0", class: "pos-target", "aria-label": "Target delta in units" });
  const methodSeg = segmented("Hedge with", [["fut", "Futures"], ["atm", "ATM option"], ["gamma", "Γ then Δ"]], hd.method);
  const sideSegH = segmented("Option side", [["BUY", "Buy"], ["SELL", "Sell"]], hd.side);
  const futSel = h("select", { "aria-label": "Future" });
  const expSel = h("select", { "aria-label": "Option expiry" });
  const showBox = h("input", { type: "checkbox", checked: true });
  const ticketBtn = h("button", { type: "button", class: "primary" }, "Open ticket");
  const hedgeOut = h("div", { class: "pos-hedge-out" });
  const hedgeChecks = h("ul", { class: "ticket-checks", hidden: true, "aria-live": "polite" });
  hedgeBody.append(
    h(
      "div",
      { class: "pos-hedge-ctl" },
      h("label", { class: "field" }, h("span", {}, "Target Δ"), targetIn),
      segField("Use", methodSeg),
      h("label", { class: "field pos-fut-f" }, h("span", {}, "Future"), futSel),
      h("label", { class: "field pos-exp-f" }, h("span", {}, "Option expiry"), expSel),
      h("div", { class: "pos-side-f" }, segField("Side", sideSegH)),
    ),
    hedgeOut,
    hedgeChecks,
    h("div", { class: "pos-hedge-acts" }, h("label", { class: "check" }, showBox, "Show on payoff"), ticketBtn),
  );
  hedgeHead.addEventListener("click", () => setHedgeOpen(!hd.open));
  function setHedgeOpen(open) {
    hd.open = open;
    hedgeHead.setAttribute("aria-expanded", String(open));
    hedgeBody.hidden = !open;
    hd.checkSig = "";
    drawHedge();
    riskSig = "";
    drawRisk();
  }
  targetIn.addEventListener("input", () => ((hd.target = Number(targetIn.value) || 0), drawHedge(), (riskSig = ""), drawRisk()));
  methodSeg.addEventListener("change", () => {
    hd.method = methodSeg.value;
    setCfg({ hedge: { method: hd.method, side: hd.side } });
    drawHedge();
    riskSig = "";
    drawRisk();
  });
  sideSegH.addEventListener("change", () => {
    hd.side = sideSegH.value;
    setCfg({ hedge: { method: hd.method, side: hd.side } });
    drawHedge();
    riskSig = "";
    drawRisk();
  });
  futSel.addEventListener("change", () => ((hd.fut = futSel.value), drawHedge(), (riskSig = ""), drawRisk()));
  expSel.addEventListener("change", () => ((hd.exp = expSel.value), tick()));
  showBox.addEventListener("change", () => ((hd.show = showBox.checked), (riskSig = ""), drawRisk()));
  ticketBtn.addEventListener("click", () => {
    const leg0 = hd.plan?.legs?.[0];
    if (!leg0) return;
    if (hd.plan.legs.length > 1) toast(`Then: ${hd.plan.legs.slice(1).map((l) => `${l.side === "BUY" ? "buy" : "sell"} ${plural(l.lots, "lot")} ${l.kind === "FUT" ? "FUT" : `${formatInt(l.strike)} ${l.right}`}`).join(", ")}`);
    const L = leg0.lot;
    const o = hedgeOrder(leg0);
    openTicket({
      row: { strike: leg0.strike },
      right: leg0.right ?? "CE",
      kind: leg0.kind,
      side: leg0.side,
      qty: leg0.units,
      symbol: leg0.symbol,
      product: o.product,
      expiry: leg0.expiry,
      quote: legQuote(leg0.symbol),
      lotSize: L,
      tick: o.tick,
      freezeQty: instCache.get(leg0.symbol)?.freezeQty ?? null,
      name: `${st.underlying} ${expiryText(leg0.expiry)} ${leg0.kind === "FUT" ? "FUT" : `${formatInt(leg0.strike)} ${leg0.right}`}`,
      price: o.price,
    }).then((r) => r === "placed" && tick());
  });
  /** The hedge order as the ticket will open it (the book's dominant product, the instrument's tick, mid toward a fill); the preview checks the same order. */
  function hedgeOrder(l) {
    const prods = included().map((x) => x.product);
    const dom = ["MARGIN", "INTRADAY"].sort((a, b) => prods.filter((p) => p === b).length - prods.filter((p) => p === a).length)[0];
    const tick = num(instCache.get(l.symbol)?.tickSize) || 0.05;
    return { product: prods.length ? dom : "MARGIN", tick, price: O.roundToTick(O.mid(legQuote(l.symbol)()) ?? l.mark, tick, l.side === "BUY" ? "buy" : "sell") };
  }
  function atmCtx() {
    const e = hedgeExpiry([...new Set(legs.filter((l) => l.kind === "OPT").map((l) => l.expiry))].sort());
    const c = d.chains.get(e)?.chain;
    const row = c ? O.atmRow(c) : null;
    if (!row) return null;
    const lot = num(c.lotSize) || 1;
    const leg = (q) => (q ? { symbol: q.symbol, mark: O.legMark(q).mark, delta: num(q.delta), gamma: num(q.gamma), theta: num(q.theta), vega: num(q.vega), iv: num(q.iv) } : null);
    return { strike: row.strike, expiry: e, lot, ce: leg(row.ce), pe: leg(row.pe), chain: c };
  }
  function drawHedge() {
    const has = legs.some((l) => l.q);
    hedgePanel.hidden = !has;
    if (!has || !book) return;
    const fut = pickFuture();
    const atm = atmCtx();
    const plan = O.hedgePlan(
      { delta: book.delta, gamma: book.gamma, theta: book.theta, vega: book.vega, S: spot },
      { method: hd.method, target: hd.target, side: hd.side, fut: fut ? { symbol: fut.symbol, lot: num(fut.lotSize) ?? 1, mark: O.legMark(d.quotes.get(fut.symbol)).mark, expiry: fut.expiry } : null, atm },
    );
    hd.plan = plan;
    // The hedge as priced legs at their mark (the change is 0 now), for the payoff overlay and the ±σ P&L.
    hd.hedgeLegs = plan.legs.map((l) => {
      const q = (l.side === "BUY" ? 1 : -1) * l.units;
      if (l.kind === "FUT") return { symbol: l.symbol, kind: "FUT", q, avg: l.mark, mark: l.mark, F: l.mark, T: O.yearsToExpiry(l.expiry) ?? 0, priced: num(l.mark) !== null, inc: true };
      const o = l.right === "CE" ? atm?.ce : atm?.pe;
      const F = (atm?.chain ? O.forwardPrice(atm.chain, O.parityGrowth(O.yearsToExpiry(l.expiry))) : null) ?? spot;
      return { symbol: l.symbol, kind: "OPT", right: l.right, strike: l.strike, q, avg: l.mark, mark: l.mark, iv: num(o?.iv), F, T: O.yearsToExpiry(l.expiry) ?? 0, priced: num(l.mark) !== null && num(o?.iv) !== null, inc: true };
    });
    // Head: the one-line suggestion.
    const lg = plan.legs;
    const line = plan.error
      ? `Hedge: ${plan.error}`
      : lg.length
        ? `Hedge: ${lg.map((l) => `${l.side === "BUY" ? "buy" : "sell"} ${plural(l.lots, "lot")} ${l.kind === "FUT" ? `${expiryText(l.expiry)} FUT` : `${formatInt(l.strike)} ${l.right}`}`).join(" + ")} → Δ ${formatSigned(book.delta, 0)} → ${formatSigned(plan.after.delta, 0)}`
        : `Hedge: Δ ${formatSigned(book.delta, 0)} is within one lot of target`;
    const headSig = `${line}|${hd.open}`;
    if (hedgeHead.__sig !== headSig) {
      hedgeHead.__sig = headSig;
      hedgeHead.replaceChildren(h("strong", {}, "Hedge helper"), h("span", { class: "pos-hedge-line" }, line.replace(/^Hedge: /, "")), icon("chevron"));
    }
    if (!hd.open) return;
    // Controls
    const fs = d.futures ?? [];
    const fsig = JSON.stringify([fs.map((f) => f.symbol), fut?.symbol]);
    if (futSel.__sig !== fsig) {
      futSel.__sig = fsig;
      futSel.replaceChildren(...(fs.length ? fs.map((f) => h("option", { value: f.symbol, selected: f.symbol === fut?.symbol }, `${expiryText(f.expiry)} FUT · lot ${formatInt(f.lotSize)}`)) : [h("option", { value: "" }, "No futures listed")]));
      futSel.disabled = !fs.length;
    }
    const exps = [...new Set([...legs.filter((l) => l.kind === "OPT").map((l) => l.expiry), ...(d.expiries ?? []).slice(0, 4)])].sort();
    const esig = JSON.stringify([exps, atm?.expiry]);
    if (expSel.__sig !== esig) {
      expSel.__sig = esig;
      expSel.replaceChildren(...exps.map((e) => h("option", { value: e, selected: e === atm?.expiry }, `${expiryText(e)} · ATM ${atm && e === atm.expiry ? formatInt(atm.strike) : ""}`.replace(/ · ATM $/, ""))));
    }
    hedgeBody.querySelector(".pos-fut-f").hidden = hd.method === "atm";
    hedgeBody.querySelector(".pos-exp-f").hidden = hd.method === "fut";
    hedgeBody.querySelector(".pos-side-f").hidden = hd.method !== "atm";
    // Before / Change / After
    const S = spot ?? 0;
    const rows = [
      ["Δ (units)", (g) => formatSigned(g.delta, 0)],
      ["Γ (Δ per 1%)", (g) => formatSigned(g.gamma * S * 0.01, 0)],
      ["Θ ₹/day", (g) => rs(g.theta)],
      ["Vega ₹/pt", (g) => rs(g.vega)],
    ];
    const before = { delta: book.delta, gamma: book.gamma, theta: book.theta, vega: book.vega };
    const inc = included().filter((l) => l.priced);
    const sp = sigmaPct();
    const pnlAt = (ls, k) => (sp ? O.scenarioPnl(ls, { dS: (k * sp) / 100 }) : null);
    const withH = [...inc, ...hd.hedgeLegs];
    const sigCut = [-2, -1, 1, 2];
    const outSig = JSON.stringify([plan, sigCut.map((k) => [Math.round(pnlAt(inc, k) ?? 0), Math.round(pnlAt(withH, k) ?? 0)]), Math.round(S)]);
    if (hedgeOut.__sig !== outSig) {
      hedgeOut.__sig = outSig;
      const lastExp = included().map((l) => l.expiry).sort().pop();
      const early = lg.find((l) => l.expiry && lastExp && l.expiry < lastExp);
      hedgeOut.replaceChildren(
        ...(plan.error ? [h("p", { class: "pos-note bad" }, plan.error)] : []),
        h(
          "div",
          { class: "pos-hedge-grid" },
          h(
            "table",
            { class: "pos-bca" },
            h("thead", {}, h("tr", {}, h("th", { scope: "col" }, h("span", { class: "sr-only" }, "Greek")), ["Before", "Change", "After"].map((x) => h("th", { scope: "col", class: "num" }, x)))),
            h("tbody", {}, rows.map(([label, f]) => h("tr", {}, h("th", { scope: "row" }, label), h("td", { class: "num" }, f(before)), h("td", { class: "num" }, f(plan.change)), h("td", { class: "num strong" }, f(plan.after))))),
          ),
          h(
            "dl",
            { class: "pos-hedge-facts" },
            h("div", {}, h("dt", {}, "Orders"), h("dd", {}, lg.length ? lg.map((l) => h("span", { class: "block" }, `${l.side === "BUY" ? "Buy" : "Sell"} ${plural(l.lots, "lot")} ${st.underlying} ${expiryText(l.expiry)} ${l.kind === "FUT" ? "FUT" : `${formatInt(l.strike)} ${l.right}`} (${formatInt(l.units)} qty)`)) : "None")),
            h("div", {}, h("dt", {}, "Residual Δ"), h("dd", {}, formatSigned(plan.residual, 0))),
            h("div", {}, h("dt", {}, "Premium"), h("dd", {}, lg.some((l) => l.kind === "OPT") ? h("span", {}, `${plan.premium < 0 ? "debit" : "credit"} ${formatRupee(Math.abs(plan.premium), 0)}`) : "no premium (futures)")),
            h("div", {}, h("dt", {}, "P&L at −2σ −1σ +1σ +2σ"), h("dd", {}, sp ? sigCut.map((k) => h("span", { class: "block" }, `${k > 0 ? "+" : "−"}${Math.abs(k)}σ ${rc(pnlAt(inc, k))} → `, h("span", { class: tone(pnlAt(withH, k)) }, rc(pnlAt(withH, k))))) : DASH)),
          ),
        ),
        h("p", { class: "muted small" }, [...plan.notes, early ? `Hedge expires ${expiryText(early.expiry)}, before your ${expiryText(lastExp)} exposure` : null, "Margin effect: shown by your broker on the order"].filter(Boolean).join(" · ")),
      );
    }
    previewHedge();
  }
  let hvTimer = null;
  let hvSeq = 0;
  function previewHedge() {
    const a = account();
    const lg = hd.plan?.legs ?? [];
    const sig = JSON.stringify([a?.id, lg.map((l) => [l.symbol, l.side, l.units]), included().map((l) => l.product)]);
    const blocked = (hd.checks ?? []).some((c) => c.severity === "block");
    ticketBtn.disabled = !lg.length || blocked || Boolean(hd.plan?.error);
    if (sig === hd.checkSig || !hd.open || !a) return;
    hd.checkSig = sig;
    clearTimeout(hvTimer);
    if (!lg.length) {
      hd.checks = [];
      hedgeChecks.hidden = true;
      return;
    }
    hvTimer = setTimeout(async () => {
      const seq = ++hvSeq;
      const res = await Promise.all(lg.map((l) => {
        const o = hedgeOrder(l);
        return optional(api("/v1/orders/preview", { method: "POST", body: { account: a.id, symbol: l.symbol, side: l.side, quantity: l.units, product: o.product, orderType: "LIMIT", price: o.price } }));
      }));
      if (seq !== hvSeq) return;
      const checks = [];
      res.forEach((r) => {
        if (r.error) checks.push({ severity: "block", message: r.error.message ?? "Preview failed" });
        for (const c of r.data?.data?.checks ?? []) checks.push(c);
      });
      hd.checks = checks;
      hedgeChecks.hidden = !checks.length;
      hedgeChecks.replaceChildren(...checks.map((x) => h("li", { class: x.severity === "block" ? "bad" : "warn" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", {}, `${x.severity === "block" ? "Blocked: " : ""}${x.message}`))));
      ticketBtn.disabled = !lg.length || checks.some((c) => c.severity === "block");
      ticketBtn.title = ticketBtn.disabled && checks.length ? "The Bridge's checks block this order (see above)" : "";
    }, 400);
  }

  // ── Customise ──
  gearBtn.addEventListener("click", () => openCustomise());
  exitAllBtn.addEventListener("click", () => openExitPlan(legs.filter((l) => l.q), ""));
  function openCustomise() {
    if (posPanel.querySelector(".popover.customise")) return;
    const close = () => {
      pop.remove();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", esc, true);
      gearBtn.setAttribute("aria-expanded", "false");
      gearBtn.focus();
    };
    const outside = (e) => !pop.contains(e.target) && !gearBtn.contains(e.target) && close();
    const esc = (e) => e.key === "Escape" && (e.stopPropagation(), close());
    const apply = (patch) => {
      setCfg(patch);
      layoutSig = "";
      riskSig = "";
      matrixSig = "";
      price(O.bookLegs(d.all, st.underlying, { closed: true }));
      draw();
      drawPop();
    };
    const sw = (label, on, set, hint) => {
      const input = h("input", { type: "checkbox", role: "switch" });
      input.checked = on;
      input.addEventListener("change", () => set(input.checked));
      return h("label", { class: "sw-row" }, h("span", { class: "sw-text" }, label, hint ? h("small", {}, hint) : null), h("span", { class: "switch" }, input, h("i", { "aria-hidden": "true" })));
    };
    const seg = (label, opts, value, set) => {
      const s = segmented(label, opts, value);
      s.addEventListener("change", () => set(s.value));
      return s;
    };
    const body = h("div", { class: "pop-body" });
    const drawPop = () => {
      const c = cfg();
      const enabled = c.cols;
      const others = O.POS_COLUMNS.map(([k]) => k).filter((k) => !enabled.includes(k));
      const name = (k) => O.POS_COLUMNS.find(([x]) => x === k)?.[2] ?? k;
      const move = (k, dir) => {
        const a = [...enabled];
        const i = a.indexOf(k);
        const j = i + dir;
        if (j < 0 || j >= a.length) return;
        [a[i], a[j]] = [a[j], a[i]];
        apply({ cols: a });
      };
      const colRow = (k, on) =>
        h(
          "div",
          { class: `col-row ${on ? "on" : ""}`.trim(), "data-col": k },
          h("span", { class: "grip" }),
          h("label", { class: "col-check" }, (() => {
            const i = h("input", { type: "checkbox" });
            i.checked = on;
            i.addEventListener("change", () => {
              const next = on ? enabled.filter((x) => x !== k) : [...enabled, k];
              if (next.length) apply({ cols: next });
              else drawPop();
            });
            return i;
          })(), h("span", {}, name(k))),
          on ? h("span", { class: "col-move" }, h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Move ${name(k)} left`, disabled: enabled.indexOf(k) === 0, onclick: () => move(k, -1) }, icon("up")), h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Move ${name(k)} right`, disabled: enabled.indexOf(k) === enabled.length - 1, onclick: () => move(k, 1) }, icon("down"))) : null,
        );
      const lossIn = h("input", { type: "number", min: "0", step: "1000", inputmode: "numeric", placeholder: "None", value: c.lossLimit ?? "", "aria-label": "Loss limit in rupees" });
      lossIn.addEventListener("change", () => apply({ lossLimit: lossIn.value === "" ? null : Number(lossIn.value) }));
      body.replaceChildren(
        h("section", {}, h("h3", {}, "Columns ", h("small", {}, "in table order")), h("div", { class: "col-list" }, enabled.map((k) => colRow(k, true)), others.map((k) => colRow(k, false)))),
        h("section", {}, h("h3", {}, "Legs"), segField("Group by", seg("Group by", [["expiry", "Expiry"], ["none", "None"]], c.group, (v) => apply({ group: v }))), sw("Show today's closed legs", c.closed, (v) => apply({ closed: v }), "Muted, for realised P&L")),
        h("section", {}, h("h3", {}, "Scenario"), segField("Spot ladder", seg("Spot ladder", [["tight", "±5%"], ["wide", "±10%"], ["sigma", "±2σ"]], c.ladder, (v) => apply({ ladder: v }))), segField("Columns", seg("Matrix columns", [["iv", "IV"], ["days", "Days"]], c.axis, (v) => ((axisSeg.value = v), apply({ axis: v })))), h("label", { class: "field" }, h("span", {}, "Loss limit ₹ (cells beyond it are outlined)"), lossIn)),
        h("section", {}, h("h3", {}, "Exit"), segField("Default price", seg("Default exit price", [["mid", "Mid"], ["touch", "Touch"], ["market", "Market"]], c.exitType, (v) => apply({ exitType: v })))),
        h("section", {}, h("h3", {}, "Panels"), sw("Chart engine slot", c.chartSlot, (v) => apply({ chartSlot: v }), "A placeholder for your own chart engine")),
      );
    };
    const pop = h(
      "div",
      { class: "popover customise", role: "dialog", "aria-label": "Customise positions" },
      h("div", { class: "pop-head" }, h("strong", {}, "Customise"), h("button", { type: "button", class: "small plain reset", onclick: () => { const ex = cfg().excluded; st.pos = O.positionsConfig({ excluded: ex }); axisSeg.value = st.pos.axis; apply({}); } }, icon("refresh"), "Reset"), h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close", onclick: () => close() }, icon("close"))),
      body,
    );
    drawPop();
    gearBtn.setAttribute("aria-expanded", "true");
    posPanel.querySelector(".pos-head").append(pop);
    // Desktop / tablet: the popover hangs below the gear; cap it to the room left in the viewport so its scroll body
    // ends on screen (phones get the bottom sheet from the stylesheet).
    if (!isPhone()) {
      const room = innerHeight - pop.getBoundingClientRect().top - 16;
      pop.style.maxHeight = `${Math.round(Math.max(320, Math.min(640, room)))}px`;
      if (room < 320) pop.scrollIntoView({ block: "nearest" });
    }
    pop.querySelector("button, input")?.focus({ preventScroll: true });
    setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", esc, true);
    });
  }

  // ── Draw ──
  function draw() {
    const has = legs.some((l) => l.q);
    drawBook();
    drawWarnings();
    drawPositions();
    hedgePanel.hidden = !has;
    if (has) drawHedge();
    drawRisk();
    slotPanel.hidden = !cfg().chartSlot || !has;
    bookPanel.hidden = !d.loaded ? false : !legs.length && switchEl.hidden;
    onClock();
  }

  // ── Keyboard ──
  function showKeys() {
    modal({
      title: "Positions keys",
      body: h("table", { class: "keys-table" }, h("tbody", {}, POSITION_KEYS.map(([keys, , long]) => h("tr", {}, h("th", { scope: "row" }, keys.map((k) => h("kbd", {}, k))), h("td", {}, long))))),
      buttons: [{ label: "Close", value: true }],
    });
  }
  function onKey(e) {
    const k = e.key;
    const order = displayOrder();
    const f = legs.find((l) => l.symbol === focusSym && l.q);
    const moveFocus = (dir) => {
      if (!order.length) return false;
      const i = order.indexOf(focusSym);
      focusSym = order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + dir))];
      patchRows(colsNow());
      rowRefs.get(focusSym)?.el.scrollIntoView?.({ block: "nearest" });
      return true;
    };
    // Space and the arrows belong to the focused control (a button, a link, a matrix cell); only on the page itself
    // or a row do they move the row focus and select.
    const onControl = e.target instanceof Element && Boolean(e.target.closest("button, a, [role=menuitem], [tabindex]:not(tr), summary, svg"));
    if (k === "?") return showKeys(), true;
    if (k === "j") return moveFocus(1), true;
    if (k === "k") return moveFocus(-1), true;
    if ((k === "ArrowDown" || k === "ArrowUp") && !onControl && focusSym) return moveFocus(k === "ArrowDown" ? 1 : -1);
    if (k === " " && f && !onControl) return rowClick(f.symbol, false), true;
    if (k === "i" && f) return toggleInclude([f.symbol], !f.inc), true;
    if (k === "x") return f ? exitLeg(f.symbol) : toast("Focus a leg first (J / K)"), true;
    if (k === "X") return legs.some((l) => l.q) && openExitPlan(legs.filter((l) => l.q), ""), true;
    if (k === "a" && f) {
      const g = groups.find((x) => x.legs.includes(f));
      if (g) analyse(g);
      return true;
    }
    if (k === "h") {
      if (hedgePanel.hidden) return false;
      if (!hd.open) setHedgeOpen(true);
      targetIn.focus();
      return true;
    }
    if (k === "," || k === ".") return setScenario({ pct: sc.pct + (k === "." ? 0.5 : -0.5) }), true;
    if (k === ";" || k === "'") return setScenario({ dIv: sc.dIv + (k === "'" ? 1 : -1) }), true;
    if (k === "[" || k === "]") return setScenario({ days: sc.days + (k === "]" ? 1 : -1) }), true;
    if (k === "0") return setScenario({ pct: 0, dIv: 0, days: 0 }), true;
    if (k === "Escape" && (focusSym || selected.size)) {
      focusSym = null;
      selected.clear();
      patchRows(colsNow());
      drawBulk();
      return true;
    }
    return false;
  }

  // Device class changes (rotation, a phone-width window) re-lay the list and the payoff.
  const mqs = ["(max-width: 719px)", "(max-width: 1099px)"].map(media);
  const onDevice = () => {
    if (!posPanel.isConnected) return;
    layoutSig = "";
    riskSig = "";
    warnEl.__sig = "";
    draw();
  };
  for (const m of mqs) m.addEventListener("change", onDevice);
  const onResize = () => {
    if (!posPanel.isConnected) return;
    pay.resize();
  };
  window.addEventListener("resize", onResize);

  return {
    panels: [bookPanel, posPanel, riskPanel, hedgePanel, slotPanel],
    root,
    tick,
    reset() {
      st.seq += 1;
      d.chains.clear();
      d.quotes = new Map();
      d.all = [];
      d.loaded = false;
      d.error = null;
      st.error = null;
      st.freshness = null;
      legs = [];
      groups = [];
      book = null;
      selected.clear();
      focusSym = null;
      hd.fut = null;
      hd.exp = null;
      hd.checkSig = "";
      layoutSig = "";
      riskSig = "";
      bodyEl.__mode = "";
      draw();
    },
    accountChanged() {
      st.seq += 1;
      d.all = [];
      d.loaded = false;
      d.fundsFor = null;
      legs = [];
      groups = [];
      selected.clear();
      layoutSig = "";
      bodyEl.__mode = "";
      draw();
      tick();
    },
    onKey,
    destroy() {
      closeMenu?.(false);
      for (const m of mqs) m.removeEventListener("change", onDevice);
      window.removeEventListener("resize", onResize);
      clearTimeout(hvTimer);
    },
  };
}

/**
 * The book's payoff (SVG, built once; paths updated): Now (solid), Target (dashed), At-expiry of the nearest expiry
 * (secondary, green / red fill), the after-hedge line (dotted), spot, ±1σ / ±2σ bands, breakevens and a read-out.
 */
function createBookPayoff(host, fill = () => null) {
  let m = null;
  let W = 640;
  let H = 280;
  const L = 52;
  const R = 10;
  const T = 18;
  const B = 34;
  const id = `bp${Math.random().toString(36).slice(2, 7)}`;
  const clipUp = svg("rect", { x: 0, y: 0, width: 0, height: 0 });
  const clipDn = svg("rect", { x: 0, y: 0, width: 0, height: 0 });
  const clipPlot = svg("rect", { x: 0, y: 0, width: 0, height: 0 });
  const band2 = svg("rect", { class: "band2" });
  const band1 = svg("rect", { class: "band" });
  const grid = svg("g", {});
  const xAxis = svg("g", {});
  const areaUp = svg("path", { class: "area-up", "clip-path": `url(#${id}-up)` });
  const areaDn = svg("path", { class: "area-dn", "clip-path": `url(#${id}-dn)` });
  const zero = svg("line", { class: "zero" });
  const lineE = svg("path", { class: "line-exp2" });
  const lineT = svg("path", { class: "line-target" });
  const lineH = svg("path", { class: "line-hedge", "clip-path": `url(#${id}-plot)` });
  const offScale = svg("text", { class: "mark-label off-scale", "text-anchor": "end", visibility: "hidden" });
  const lineN = svg("path", { class: "line-now" });
  const spotLine = svg("line", { class: "mark-spot" });
  const spotLabel = svg("text", { class: "mark-label spot", "text-anchor": "middle" });
  const beG = svg("g", {});
  const cross = svg("line", { class: "cross", visibility: "hidden" });
  const dot = svg("circle", { r: 3.5, class: "dot-today", visibility: "hidden" });
  const el = svg("svg", { class: "payoff-svg pos-payoff-svg", role: "img", tabindex: "0", focusable: "true" }, svg("defs", {}, svg("clipPath", { id: `${id}-up` }, clipUp), svg("clipPath", { id: `${id}-dn` }, clipDn), svg("clipPath", { id: `${id}-plot` }, clipPlot)), band2, band1, grid, xAxis, areaUp, areaDn, zero, lineE, lineT, lineH, lineN, spotLine, spotLabel, beG, offScale, cross, dot);
  const readout = h("div", { class: "payoff-readout pos-readout" });
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  const legend = h(
    "span",
    { class: "legend" },
    h("span", {}, h("i", { class: "now" }), " Now"),
    h("span", { class: "lg-target" }, h("i", { class: "today" }), h("span", { class: "lg-tt" }, " Target")),
    h("span", {}, h("i", { class: "exp2" }), h("span", { class: "lg-exp" }, " At expiry")),
    h("span", { class: "lg-hedge" }, h("i", { class: "hedge" }), " After hedge"),
    h("span", {}, h("i", { class: "band" }), " ±1σ ±2σ"),
  );
  const empty = h("p", { class: "payoff-empty muted pos-pay-empty", hidden: true }, "No priced legs to draw.");
  host.replaceChildren(h("div", { class: "payoff-head" }, legend, readout), el, empty, live);
  /** 280 px on desktop (or the height of the scenario column beside it), 240 on tablet, 200 on phone. */
  const heightFor = () => (media("(max-width: 719px)").matches ? 200 : media("(max-width: 1099px)").matches ? 240 : Math.max(280, Math.min(560, fill() ?? 0)));
  const X = (p) => L + ((p - m.lo) / (m.hi - m.lo)) * (W - L - R);
  const Y = (v) => T + ((m.yMax - v) / (m.yMax - m.yMin)) * (H - T - B);
  const path = (vals) => vals.map((v, i) => `${i ? "L" : "M"}${r1(X(m.xs[i]))},${r1(Y(v))}`).join("");
  let hoverX = null;
  function size() {
    W = Math.max(260, Math.round(host.clientWidth || 640));
    H = heightFor();
    setA(el, { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  }
  function paint() {
    if (!m) {
      el.style.display = "none";
      empty.hidden = false;
      readout.textContent = "";
      return;
    }
    el.style.display = "";
    empty.hidden = true;
    size();
    // The scale is the book's own lines; the after-hedge overlay may widen it by at most half the book's range and
    // is clipped to the plot beyond that (marked "off scale"), so the book never flattens into a line at 0.
    const book = [...m.now, ...m.exp, ...(m.target ?? [])];
    let lo = Math.min(0, ...book);
    let hi = Math.max(0, ...book);
    let off = false;
    if (m.hedge?.length) {
      const span = Math.max(hi - lo, 1);
      const hLo = Math.min(...m.hedge);
      const hHi = Math.max(...m.hedge);
      off = hLo < lo - span * 0.25 || hHi > hi + span * 0.25;
      lo = Math.max(lo - span * 0.25, Math.min(lo, hLo));
      hi = Math.min(hi + span * 0.25, Math.max(hi, hHi));
    }
    const pad = (hi - lo) * 0.08 || 100;
    m.yMin = lo - pad;
    m.yMax = hi + pad;
    const zy = Y(0);
    setA(clipPlot, { x: L, y: T, width: Math.max(0, W - L - R), height: Math.max(0, H - T - B) });
    setA(offScale, { x: W - R - 4, y: T + 11, visibility: off ? "visible" : "hidden" });
    offScale.textContent = off ? "Hedge off scale ↕" : "";
    setA(clipUp, { width: W, height: Math.max(0, zy) });
    setA(clipDn, { y: zy, width: W, height: Math.max(0, H - zy) });
    const band = (r, b) => {
      if (!b) return setA(r, { visibility: "hidden" });
      const a = X(Math.max(m.lo, b[0]));
      const z = X(Math.min(m.hi, b[1]));
      setA(r, { visibility: z > a ? "visible" : "hidden", x: r1(a), y: T, width: r1(Math.max(0, z - a)), height: H - T - B });
    };
    band(band1, m.b1);
    band(band2, m.b2);
    const yt = niceTicks(m.yMin, m.yMax, 5);
    grid.replaceChildren(...yt.flatMap((v) => [svg("line", { x1: L, x2: W - R, y1: r1(Y(v)), y2: r1(Y(v)), class: "grid" }), svg("text", { x: L - 6, y: r1(Y(v) + 3.5), class: "axis", "text-anchor": "end" }, v === 0 ? "0" : formatCompact(v))]));
    const xt = niceTicks(m.lo, m.hi, Math.max(3, Math.min(8, Math.floor((W - L - R) / 90)))).filter((p) => p > m.lo && p < m.hi);
    xAxis.replaceChildren(...xt.map((p) => svg("text", { x: r1(X(p)), y: H - 14, class: "axis", "text-anchor": "middle" }, formatInt(p))));
    const area = `M${r1(X(m.xs[0]))},${r1(zy)}${m.exp.map((v, i) => `L${r1(X(m.xs[i]))},${r1(Y(v))}`).join("")}L${r1(X(m.xs[m.xs.length - 1]))},${r1(zy)}Z`;
    setA(areaUp, { d: area });
    setA(areaDn, { d: area });
    setA(zero, { x1: L, x2: W - R, y1: r1(zy), y2: r1(zy) });
    setA(lineE, { d: path(m.exp) });
    setA(lineN, { d: path(m.now) });
    setA(lineT, { d: m.target ? path(m.target) : "M0,0", visibility: m.target ? "visible" : "hidden" });
    setA(lineH, { d: m.hedge ? path(m.hedge) : "M0,0", visibility: m.hedge ? "visible" : "hidden" });
    host.querySelector(".lg-target").hidden = !m.target;
    host.querySelector(".lg-tt").textContent = ` ${m.targetLabel}`;
    host.querySelector(".lg-exp").textContent = ` ${m.expLabel}`;
    host.querySelector(".lg-hedge").hidden = !m.hedge;
    const sx = X(m.spot);
    setA(spotLine, { x1: r1(sx), x2: r1(sx), y1: T, y2: H - B });
    setA(spotLabel, { x: r1(Math.max(L + 20, Math.min(W - R - 20, sx))), y: T - 5 });
    spotLabel.textContent = formatInt(m.spot);
    const marks = [...m.bes.map((b) => ["now", b]), ...m.besT.map((b) => ["t", b])].filter(([, b]) => b > m.lo && b < m.hi);
    let lastX = -1e9;
    let lane = 0;
    beG.replaceChildren(
      ...marks.sort((a, b) => a[1] - b[1]).flatMap(([k, b]) => {
        const x = X(b);
        lane = x - lastX < 44 ? 1 - lane : 0;
        lastX = x;
        return [svg("line", { x1: r1(x), x2: r1(x), y1: r1(zy - 5), y2: r1(zy + 5), class: k === "now" ? "be-tick" : "be-tick t" }), svg("text", { x: r1(x), y: r1(zy + (lane ? -9 : 16)), class: "mark-label", "text-anchor": "middle" }, formatInt(b))];
      }),
    );
    const lossIn = Math.min(...m.now);
    el.setAttribute("aria-label", `Payoff now: ${m.bes.length ? `breakevens ${m.bes.map((b) => formatInt(b)).join(" and ")}` : "no breakeven in range"}; max loss in range ${rc(lossIn)}`);
    paintHover();
  }
  function paintHover() {
    if (!m || hoverX === null) {
      setA(cross, { visibility: "hidden" });
      setA(dot, { visibility: "hidden" });
      const n = m ? m.fns.now(m.spot) : null;
      readout.textContent = m ? `At ${formatInt(m.spot)}: now ${rs(n)}` : "";
      return;
    }
    const p = hoverX;
    const x = X(p);
    const vn = m.fns.now(p);
    setA(cross, { visibility: "visible", x1: r1(x), x2: r1(x), y1: T, y2: H - B });
    setA(dot, { visibility: "visible", cx: r1(x), cy: r1(Y(vn)) });
    const parts = [`${formatInt(p)} (${formatSigned((p / m.spot - 1) * 100, 1)}%)`, `now ${rs(vn)}`, m.fns.target ? `target ${rs(m.fns.target(p))}` : null, `expiry ${rs(m.fns.exp(p))}`, m.fns.hedge ? `hedged ${rs(m.fns.hedge(p))}` : null].filter(Boolean);
    readout.textContent = parts.join(" · ");
  }
  const toPrice = (clientX) => {
    const r = el.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    return m.lo + ((Math.max(L, Math.min(W - R, px)) - L) / (W - L - R)) * (m.hi - m.lo);
  };
  el.addEventListener("pointermove", (e) => {
    if (!m) return;
    hoverX = toPrice(e.clientX);
    paintHover();
  });
  el.addEventListener("pointerleave", () => {
    hoverX = null;
    paintHover();
  });
  el.addEventListener("keydown", (e) => {
    if (!m || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const step = (m.hi - m.lo) / 70;
    hoverX = Math.max(m.lo, Math.min(m.hi, (hoverX ?? m.spot) + (e.key === "ArrowRight" ? step : -step)));
    paintHover();
    live.textContent = readout.textContent;
  });
  el.addEventListener("blur", () => {
    hoverX = null;
    paintHover();
  });
  return {
    update(model) {
      m = model;
      paint();
    },
    resize() {
      if (m) paint();
    },
  };
}
