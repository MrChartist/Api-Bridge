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
import { alertBox, api, chartSlot, emptyState, errorState, h, icon, istTime, loadingState, modal, optional, table, toast, touchWord, keyHint } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, formatSignedRupee, isFigure } from "./format.js";
import { barsEnter, countUp, flashValue, reducedMotion, stopCount } from "./motion.js";
import * as O from "./options.js";
import { drawPayoff } from "./payoff.js";
import { SCOPES, createBookView } from "./book-view.js";
import { segField, segmented } from "./views.js";
import { heatCell, setBar, svgEl } from "./viz.js";
import { eventChip, refCharges, refRate, refSession, upcomingEvents } from "./reference.js";
import { SPAN_METHOD, marginImpact, portfolioMargin } from "./span-margin.js";
import { legWords, openAlertSheet, rulesFor } from "./alerts.js";
import { createWhatIf } from "./whatif.js";
import { ROLL_MODES, rollBreakevens, rollItems, rollMargin, rollMoney, rollPlan } from "./roll-core.js";
import { openPlacement } from "./strategy-place.js";
import { orderLimitsOf, sliceNotes } from "./basket-core.js";
import { closeMs, countdownText, decayLeft, deskExpiry, gammaByStrike, pinRisk, settlementRisk } from "./expiry-core.js";
import { normWhatIf, whatIfFigures } from "./whatif-core.js";
import { cachedTriggers, exitChipText, openPositionExits, openTriggers } from "./triggers.js";
import { dayRows } from "./orders-core.js";
import { contractName } from "./flows.js";
import { OPEN_TRIGGER } from "./trigger-core.js";
import { candlesOf, lastSession, positionsSpec, spotSymbol } from "./chart-specs.js";
import { accountOverview, attentionItems, moneyShort, riskGrid, riskParts, riskRead } from "./positions-core.js";


/**
 * The exit sheet's margin line. Paper: the margin the exit releases (or adds, when closing a hedge leaves a short
 * uncovered), from the paper engine's model. Live or a broker account: the broker's figure decides.
 */
export function exitMarginText(effect, paper, underlying = "") {
  if (!paper) return "Margin effect: shown by your broker on the order.";
  if (!effect) return "Margin effect: not worked out (no price for the forward yet).";
  const ch = effect.change;
  const amt = marginText;
  const on = `${underlying ? `${underlying} ` : ""}margin ${amt(effect.before)} now, ${amt(effect.after)} after; paper margin model`;
  if (Math.abs(ch) < 1) return `Margin unchanged by this exit (${on}).`;
  return ch < 0 ? `Margin released ≈ ${amt(-ch)} (${on}).` : `Margin goes up ≈ ${amt(ch)}: this exit removes a hedge (${on}).`;
}

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
const isNarrow = () => media("(max-width: 1023px)").matches;
const r1 = (v) => Math.round(v * 10) / 10;
/** σ distances floor to 0.1, so a tested leg (< 0.5σ) never reads "0.5σ". */
const sig1 = (v) => (isFigure(v) ? formatFixed(Math.floor(v * 10 + 1e-9) / 10, 1) : DASH);
/** Signed rupees, no decimals: "+₹1958", "−₹310" (a true minus, as the heatmap and chips print it), "₹0". */
const rs = (v, dp = 0) => formatSignedRupee(v, dp);
/** Signed compact rupees for big figures: "+₹1.42L". */
const rc = (v) => (!isFigure(v) ? DASH : `${v > 0.5 ? "+" : v < -0.5 ? "\u2212" : ""}₹${formatCompact(Math.abs(v))}`);
/** Heat cells and stress chips: whole thousands from ₹10K ("−₹71K"), else compact ("−₹9.0K", "+₹456"). */
const rk = (v) => {
  if (!isFigure(v)) return DASH;
  const a = Math.abs(v);
  const sign = v > 0.5 ? "+" : v < -0.5 ? "\u2212" : "";
  if (a >= 1e4 && a < 1e5) return `${sign}₹${formatInt(Math.round(a / 1000))}K`;
  return `${sign}₹${formatCompact(a)}`;
};
/** Unsigned compact rupees: "₹9.22L". */
const ru = (v) => (!isFigure(v) ? DASH : `₹${formatCompact(Math.abs(v))}`);
/** A margin amount, unsigned: "₹1.70L" from a lakh, whole rupees below, as Positions and Strategy show margin. */
const marginText = (v) => (!isFigure(v) ? DASH : Math.abs(v) >= 1e5 ? ru(v) : formatRupee(Math.abs(Math.round(v)), 0));
const toneOf = (v) => (!isFigure(v) ? "fg" : Math.round(v) > 0 ? "pos" : Math.round(v) < 0 ? "neg" : "fg");

/**
 * A diverging bar centred at 0 (positions.md §4.2, §4.4): two halves, each a .dv-bar scaled by --v, so a refresh
 * resizes from the old value and a first draw grows (barsEnter). Tone by data-tone: pos | neg | fg | warn | iv.
 */
function divBar(cls = "") {
  const l = h("span", { class: "dv-bar rtl" });
  const r = h("span", { class: "dv-bar" });
  const el = h("span", { class: `pos-div ${cls}`.trim(), "aria-hidden": "true" }, h("span", { class: "pos-div-h l" }, l), h("span", { class: "pos-div-h r" }, r));
  return { el, l, r };
}
function setDiv(b, v, M, tone) {
  const x = isFigure(v) ? Number(v) : 0;
  setBar(b.l, x < 0 ? x : 0, M);
  setBar(b.r, x > 0 ? x : 0, M);
  const t = tone ?? toneOf(x);
  if (b.el.dataset.tone !== t) b.el.dataset.tone = t;
  return b;
}
/** σ distance gauge (§4.6): a 0–3σ track, ticks at 1σ and 2σ, a marker that slides (transform) to min(d, 3) / 3. */
function sigmaGauge() {
  const m = h("i", { class: "pos-sg-m" });
  const el = h("span", { class: "pos-sg", "aria-hidden": "true" }, h("i", { class: "pos-sg-t t1" }), h("i", { class: "pos-sg-t t2" }), m);
  return el;
}
function setSigma(el, d, state) {
  const x = isFigure(d) ? String(Math.round((Math.min(3, Math.max(0, d)) / 3) * 1000) / 1000) : "0";
  if (el.style.getPropertyValue("--x") !== x) el.style.setProperty("--x", x);
  if (el.dataset.state !== state) el.dataset.state = state;
}
/** A 40 × 16 payoff glyph (§4.10): the expiry curve split by sign around a zero line, no axes. */
function glyphPath(vals, w = 40, hgt = 16) {
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const Y = (v) => r1(1 + ((hi - v) / span) * (hgt - 2));
  const X = (i) => r1((i / (vals.length - 1)) * w);
  const path = (f) => vals.map((v, i) => `${i ? "L" : "M"}${X(i)},${Y(f(v))}`).join("");
  return { up: path((v) => Math.max(0, v)), dn: path((v) => Math.min(0, v)), zero: Y(0) };
}
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
  [["⇧B", "⇧S"], "buy / sell", "Buy / sell more of the focused leg's contract: the ticket, or at once when 1-Tap is on"],
  [["I"], "include", "Include or exclude the leg in risk"],
  [["X"], "exit", "Exit the focused leg (ticket)"],
  [["⇧X"], "exit all", "Exit plan for every leg"],
  [["A"], "analyse", "Analyse the leg's expiry group in the builder"],
  [["H"], "hedge", "Open the hedge helper"],
  [[",", "."], "spot", "Scenario spot −/+ 0.5%"],
  [[";", "'"], "IV", "Scenario IV −/+ 1 point"],
  [["[", "]"], "days", "Scenario days −/+ 1"],
  [["0"], "reset", "Reset the scenario"],
  [["G"], "risk tab", "Cycle the risk view: Payoff, Scenario, Greeks"],
  [["C"], "curves", "Cycle the payoff curves: Now, + Expiry, + Target"],
  [["B"], "Δ band", "Focus the Δ gauge and read Δ against your band"],
  [["P"], "pause", "Pause / resume live updates"],
  [["R"], "refresh", "Refresh now"],
  [["?"], "keys", "This list"],
];

/** Instruments (lot size, freeze qty, tick) per symbol for the session: symbol → object | null. */
const instCache = new Map();
/** "UNDERLYING|expiry" chains the source refused (400 / 404) this session: not asked for again. */
const noChain = new Set();

/**
 * The positions page.
 * @param {{ st: object, save: () => void, account: () => object|null, openTicket: (o: object) => Promise<unknown>,
 *   onClock: () => void, setUnderlying: (u: string) => void, openInChain: (expiry: string, strike: number, side: string) => void }} o
 */
export function createPositionsPage({ st, save, account, openTicket, quickTrade = null, onClock, setUnderlying, openInChain: goChain }) {
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
  // The what-if scenario is the desk's st.whatIf, shared with the Strategy Builder (whatif.js).
  st.whatIf = normWhatIf(st.whatIf, Date.now());
  const sc = st.whatIf;
  let wiScope = "book";
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
    const u = st.underlying;
    const r = await optional(api(`/v1/optionchain?underlying=${encodeURIComponent(u)}&expiry=${encodeURIComponent(expiry)}&strikes=${CHAIN_STRIKES}&greeks=true&ivModel=b76-forward`));
    if (seq !== st.seq) return;
    const prev = d.chains.get(expiry);
    // A 404, or a 400 for an expiry the source does not list, will not change on a retry: remember it for the session and
    // price those legs from their quotes (IV solved from the mark) instead of asking again every tick.
    if (r.error && (r.error.status === 404 || (r.error.status === 400 && d.expiriesFor === u && d.expiries?.length && !d.expiries.includes(expiry)))) noChain.add(`${u}|${expiry}`);
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
    // All accounts / Family: only the book is read (every 15 s); this account's chains and quotes wait.
    if (scopeNow() !== "account") return bookView.tick();
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
        // Each leg's stop and target chip (cached 3 s; a failed read keeps the last list).
        openTriggers(acc),
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
      // An expiry the source does not list has no chain to ask for: its legs are priced from their quotes.
      const listed = d.expiriesFor === u && d.expiries?.length ? new Set(d.expiries) : null;
      const want = [...new Set([...held, ...(raw.length && hedgeExp ? [hedgeExp] : [])])].filter((e) => !noChain.has(`${u}|${e}`) && (!listed || listed.has(e))).sort();
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
    legs = O.priceBook(raw, { chains, quotes: d.quotes, inst: instCache, spot, excluded: excludedSet(), rate: refRate(st.ref).value, close: refSession(st.ref).close });
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
  // Calendar days for display; pricing T comes from the vol-time clock (options.js yearsToExpiry).
  // Whole days for the day slider: rounded up, so its last step reaches the expiry close (1e-6 absorbs float noise).
  const daysTo = (e) => Math.max(0, Math.ceil((O.timeToExpiry(e, Date.now(), refSession(st.ref).close).days ?? 0) - 1e-6));
  const maxDays = () => Math.max(0, ...included().map((l) => daysTo(l.expiry)));
  /** Calendar days from the nearest leg's pricing instant to its expiry close (never the vol-time T × 365). */
  const firstDays = () => {
    const n = nearest();
    return n ? O.legDaysToExpiry(n, Date.now(), refSession(st.ref).close) : 0;
  };

  // ── Panels ──
  // Account overview (positions-core.js accountOverview): the hero over the page. Total P&L over every position the
  // account holds today, today's P&L, margin used, and a rail of the underlyings with open legs (the one on screen
  // selected). The book strip under it is the underlying on screen.
  const ovTotal = h("strong", { class: "pos-ov-v" }, DASH);
  const ovTotalSub = h("span", { class: "pos-ov-s" });
  const ovDay = h("strong", { class: "pos-ov-v2" }, DASH);
  const ovMargin = h("strong", { class: "pos-ov-v2" }, DASH);
  const ovMarginOf = h("span", { class: "pos-ov-of" });
  const ovMeterFill = h("i", { class: "pos-ov-mf" });
  const ovMarginSub = h("span", { class: "pos-ov-s" });
  const ovMarginEl = h("div", { class: "pos-ov-f margin" }, h("span", { class: "pos-lbl" }, "Margin used"), h("span", { class: "pos-ov-line" }, ovMargin, ovMarginOf), h("span", { class: "pos-ov-meter", "aria-hidden": "true" }, ovMeterFill), ovMarginSub);
  const switchEl = h("div", { class: "pos-ov-rail", role: "group", "aria-label": "Underlyings with open legs", hidden: true });
  const ovEl = h(
    "div",
    { class: "pos-ov", role: "group", "aria-label": "Account today" },
    h("div", { class: "pos-ov-f main" }, h("span", { class: "pos-lbl" }, "Total P&L"), ovTotal, ovTotalSub),
    h("div", { class: "pos-ov-f" }, h("span", { class: "pos-lbl" }, "Day P&L"), ovDay, h("span", { class: "pos-ov-s" }, "Today, every underlying")),
    ovMarginEl,
    switchEl,
  );
  // Needs attention (positions-core.js attentionItems): ITM and tested shorts, a near expiry, the biggest loser. A tap
  // lights the legs it is about and moves the row focus to the first.
  const attnEl = h("div", { class: "pos-attn", role: "group", "aria-label": "Needs attention", hidden: true });
  const errBar = h("p", { class: "err-bar pos-err", hidden: true, role: "status" });
  // Hero: Net P&L, where it came from (won / lost / realised), credit kept, net if closed now.
  const heroLabel = h("span", { class: "pos-lbl" }, "Net P&L");
  const heroValue = h("strong", { class: "pos-hero-v" }, DASH);
  // The bar's segments are a picture (mouse hover / click light the rows); the caption's three figures are the
  // buttons (named with their amounts, 44 px tall on touch screens).
  const comp = {
    won: h("span", { class: "pos-comp-s", "data-k": "won" }),
    lost: h("span", { class: "pos-comp-s", "data-k": "lost" }),
    realised: h("span", { class: "pos-comp-s", "data-k": "realised" }),
  };
  const compBar = h("span", { class: "pos-comp dv-bar", "aria-hidden": "true" }, comp.won, comp.lost, comp.realised);
  const COMP_WORD = { won: "won", lost: "lost", realised: "realised" };
  const COMP_NAME = { won: "Open legs in profit", lost: "Open legs in loss", realised: "Realised today" };
  const compBtn = Object.fromEntries(Object.keys(comp).map((k) => [k, h("button", { type: "button", class: "pos-comp-b", "data-k": k }, h("span", { class: "w" }, COMP_WORD[k]), " ", h("span", { class: "f" }))]));
  const compCap = h("span", { class: "pos-comp-cap", role: "group", "aria-label": "Where the P&L came from" }, compBtn.won, h("span", { class: "sep", "aria-hidden": "true" }, "·"), compBtn.lost, h("span", { class: "sep", "aria-hidden": "true" }, "·"), compBtn.realised);
  const keptFill = h("i", { class: "pos-kept-f" });
  const keptEl = h("span", { class: "pos-kept", hidden: true }, h("span", { class: "pos-kept-t" }), h("span", { class: "pos-kept-track", "aria-hidden": "true" }, keptFill, h("i", { class: "pos-kept-tick k50" }), h("i", { class: "pos-kept-tick k80" })));
  const closedEl = h("span", { class: "pos-closed" });
  const heroEl = h("div", { class: "pos-hero", role: "group", "aria-label": "Net P&L" }, h("div", { class: "pos-hero-top" }, h("span", { class: "pos-hero-main" }, heroLabel, heroValue), keptEl), compBar, compCap, closedEl);
  // Composition segments light the legs they come from (1.2 s; while hovered on a mouse).
  let compTimer = null;
  const lightRows = (k, on) => {
    clearTimeout(compTimer);
    for (const r of rowRefs.values()) r.el.classList.remove("hl");
    if (!on) return;
    hoverRows(compKeys[k] ?? [], true);
    compTimer = setTimeout(() => hoverRows(compKeys[k] ?? [], false), 1200);
  };
  for (const k of Object.keys(comp)) {
    for (const el of [comp[k], compBtn[k]]) {
      el.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && lightRows(k, true));
      el.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && lightRows(k, false));
      el.addEventListener("click", () => {
        lightRows(k, true);
        const first = rowRefs.get((compKeys[k] ?? [])[0]);
        first?.el.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
      });
    }
  }
  // Greeks: four diverging gauges (Δ with its band, Γ per 1 %, Θ and ν on one shared scale) and a footer.
  const GAUGES = [["delta", "Δ", "Net delta (units)"], ["gamma", "Γ", "Gamma: Δ change for a 1% move"], ["theta", "Θ", "Theta: ₹ per trading day"], ["vega", "ν", "Vega: ₹ per vol point"]];
  const gauges = new Map(
    GAUGES.map(([k, sym, name]) => {
      const bar = divBar("pos-gbar");
      const band = h("i", { class: "pos-gband", hidden: true });
      bar.el.prepend(band);
      const value = h("span", { class: "pos-gv" }, DASH);
      const sub = h("span", { class: "pos-gs" });
      const el = h("button", { type: "button", class: `pos-gauge g-${k}`, "aria-label": name }, h("span", { class: "pos-gk" }, sym), value, sub, bar.el);
      el.addEventListener("click", () => openGreeksTab());
      return [k, { el, value, sub, bar, band, sig: "" }];
    }),
  );
  const greeksFoot = h("span", { class: "pos-gfoot" });
  const greeksChip = h("span", { class: "pos-gchip" });
  const greeksEl = h("div", { class: "pos-greeks", role: "group", "aria-label": "Greeks" }, h("div", { class: "pos-gauges" }, [...gauges.values()].map((g) => g.el)), h("span", { class: "pos-gfoot-row" }, greeksChip, greeksFoot));
  // Capital: the margin / funds bar with this book's estimated share, and the ±σ stress chips.
  const capTop = h("span", { class: "pos-cap-top" });
  const capPct = h("strong", { class: "pos-cap-pct" });
  const segBook = h("i", { class: "pos-mseg book" });
  const segOther = h("i", { class: "pos-mseg other" });
  const marginBar = h("span", { class: "pos-mbar", "aria-hidden": "true" }, segBook, segOther);
  const capSub = h("span", { class: "pos-cap-sub" });
  const stressBook = h("div", { class: "pos-stress", role: "group", "aria-label": "P&L now at ±1σ and ±2σ" });
  const capWarn = h("span", { class: "pos-cap-warn", hidden: true });
  const capEl = h("div", { class: "pos-cap", role: "group", "aria-label": "Margin and funds" }, h("div", { class: "pos-cap-line" }, h("span", { class: "pos-lbl" }, "Margin"), capTop, capPct), marginBar, capSub, capWarn, stressBook);
  const bookGrid = h("div", { class: "pos-bgrid" }, heroEl, greeksEl, capEl);
  const warnLive = h("p", { class: "sr-only", "aria-live": "polite" });
  const warnEl = h("div", { class: "pos-warns" });
  const bookPanel = h("section", { class: "desk-panel pos-book", "data-panel": "book", "aria-label": "Book" }, ovEl, attnEl, errBar, bookGrid, warnEl, warnLive);

  const titleEl = h("span", { class: "panel-title" });
  const gearBtn = h("button", { type: "button", class: "small gear-btn", "aria-haspopup": "dialog", "aria-label": "Customise positions", title: "Columns, grouping, scenario and exit defaults" }, icon("sliders"), h("span", { class: "gear-label" }, "Customise"));
  const exitAllBtn = h("button", { type: "button", class: "small", hidden: true, title: "Exit plan for every leg (Shift+X)" }, "Exit all");
  // Alerts on this book: P&L, spot, delta, time to expiry or a leg's premium (checked on the Bridge; notify only).
  const alertBtn = h("button", { type: "button", class: "small", hidden: true, title: "Alert on this book: P&L, spot, delta, time to expiry or a leg's premium" }, icon("bell"), h("span", { class: "al-btn-t" }, "Alert"));
  alertBtn.addEventListener("click", () => alertOn(null, "every leg"));
  const bulkEl = h("div", { class: "pos-bulk", hidden: true, role: "region", "aria-label": "Selected legs" });
  const bodyEl = h("div", { class: "pos-body" });
  // Net (the book, the default) or Day: today's buys and sells, what was carried in and today's P&L, for every
  // underlying in the account, as brokers show it. A per-viewer choice.
  let dayMode = false;
  try {
    dayMode = localStorage.getItem("mcb.positions.view") === "day";
  } catch {
    /* private window */
  }
  const viewSeg = segmented("Positions view", [["net", "Net"], ["day", "Day"]], dayMode ? "day" : "net");
  viewSeg.classList.add("bk-view-seg");
  const dayEl = h("div", { class: "bk-day", hidden: !dayMode });
  viewSeg.addEventListener("change", () => {
    dayMode = viewSeg.value === "day";
    try {
      localStorage.setItem("mcb.positions.view", dayMode ? "day" : "net");
    } catch {
      /* private window */
    }
    draw();
  });
  function drawDay() {
    const { rows, total, missing } = dayRows(d.all ?? []);
    // The head names what the Day table holds: every underlying's contracts traded or carried today.
    const daySig = `day|${rows.length}`;
    if (titleEl.__sig !== daySig) {
      titleEl.__sig = daySig;
      titleEl.replaceChildren(h("strong", {}, "Today's trades"), h("span", { class: "muted" }, rows.length ? ` · ${plural(rows.length, "contract")}` : ""));
    }
    const qtyAt = (q, avg) => (q ? h("span", { class: "bk-nw" }, `${formatInt(q)} @ ${formatFixed(avg, 2)}`) : DASH);
    dayEl.replaceChildren(
      h(
        "div",
        { class: "bk-day-head" },
        h("span", {}, "Today's P&L"),
        h("strong", {}, total === null ? DASH : money(total)),
        h("span", { class: "muted small" }, `${missing ? `${plural(missing, "row")} without day figures from the source · ` : ""}carried legs from the previous close, every underlying in this account`),
      ),
      table(
        [
          { label: "Contract", wrap: true, cell: (r) => h("div", { class: "order-contract", title: r.symbol }, h("strong", {}, contractName(r.symbol)), h("div", { class: "muted small" }, PRODUCT[r.product] ?? r.product ?? "")) },
          { label: "Carried in", num: true, cell: (r) => (r.carried ? h("span", { class: "bk-nw" }, `${formatSigned(r.carried, 0)} @ ${formatFixed(r.prevClose, 2)}`) : DASH) },
          { label: "Bought", num: true, cell: (r) => qtyAt(r.buy, r.buyAvg) },
          { label: "Sold", num: true, cell: (r) => qtyAt(r.sell, r.sellAvg) },
          { label: "Net", num: true, cell: (r) => formatSigned(r.netQty, 0) },
          { label: "LTP", num: true, cell: (r) => formatFixed(r.ltp, 2) },
          { label: "Day P&L", num: true, cell: (r) => (r.dayPnl === null ? DASH : money(r.dayPnl)) },
        ],
        rows,
        emptyState("wallet", "Nothing traded or carried today", "Positions you trade today or carry in show here with the day's P&L.", null, { compact: true }),
      ),
    );
  }
  // The hedge helper is the Positions panel's collapsible footer (a head-height row under the table), not a panel.
  const hedgeHead = h("button", { type: "button", class: "pos-hedge-head", "aria-expanded": "false" });
  const hedgeBody = h("div", { class: "pos-hedge-body", hidden: true });
  const hedgePanel = h("div", { class: "pos-hedge", role: "region", "aria-label": "Hedge helper", hidden: true }, hedgeHead, hedgeBody);
  const posPanel = h(
    "section",
    { class: "desk-panel pos-panel", "data-panel": "positions", "aria-label": "Positions" },
    h("div", { class: "panel-head pos-head" }, titleEl, h("div", { class: "chain-tools" }, viewSeg, alertBtn, exitAllBtn, gearBtn)),
    bodyEl,
    dayEl,
    bulkEl,
    hedgePanel,
  );
  const riskSeg = segmented("Risk view", [["payoff", "Payoff"], ["scenario", "Scenario"], ["greeks", "Greeks"]], riskTab);
  riskSeg.classList.add("pos-risk-seg");
  const payoffBox = h("div", { class: "pos-payoff strat-payoff" });
  const scenBox = h("div", { class: "pos-scen" });
  const riskBody = h("div", { class: "pos-risk tab-payoff" }, payoffBox, scenBox);
  // ── Scope (P1-13): This account · All accounts · Family. The last two read GET /v1/book (book-view.js). ──
  const bookView = createBookView({ openTicket });
  const scopeSeg = segmented("Positions scope", SCOPES, cfg().scope);
  const scopeHint = h("span", { class: "muted pos-scope-hint" });
  const scopeBar = h("div", { class: "pos-scope", "data-fixed": "" }, scopeSeg, scopeHint);
  const scopeNow = () => cfg().scope;
  function applyScope() {
    const s0 = scopeNow();
    document.documentElement.dataset.posScope = s0;
    scopeHint.textContent = s0 === "account" ? "One account, every expiry" : s0 === "family" ? "Family holders only · exits stay per account" : "Every account you can see · exits stay per account";
    bookView.show(s0);
  }
  scopeSeg.addEventListener("change", () => {
    if (scopeSeg.value === scopeNow()) return;
    setCfg({ scope: scopeSeg.value });
    applyScope();
    if (scopeNow() === "account") {
      layoutSig = "";
      riskSig = "";
      tick();
    }
    onClock();
  });
  const riskPanel = h("section", { class: "desk-panel pos-riskp", "data-panel": "risk", "aria-label": "Payoff and scenarios", hidden: true }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, h("strong", {}, "Risk"), h("span", { class: "muted pos-risk-sub" })), riskSeg), riskBody);
  // ── Expiry-day desk (expiry-core.js): shown when a held expiry is today or the next session ──
  const xpBody = h("div", { class: "xp-body" });
  const xpTitle = h("span", { class: "muted xp-sub" });
  const xpClock = h("span", { class: "xp-clock", "aria-live": "off" });
  const xpSquare = h("button", { type: "button", class: "small", onclick: () => squareOffExpiring() }, "Square off expiring legs");
  let xpOpen = false;
  const xpToggle = h("button", { type: "button", class: "small quiet", "aria-expanded": "false", onclick: () => ((xpOpen = !xpOpen), drawExpiryDesk()) });
  const xpPanel = h("section", { class: "desk-panel xp-panel", "data-panel": "expiry", "aria-label": "Expiry-day desk", hidden: true }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, h("strong", {}, "Expiry desk"), xpTitle), h("span", { class: "xp-head-r" }, xpClock, xpToggle, xpSquare)), xpBody);
  let xpState = null;
  // ── Day chart (chart-lite.js): spot through the day with the strikes and any exits set on the index itself, and the
  // book's P&L from each open leg's 5-minute closes (chart-specs.js positionsSpec). Reloads when the book changes and
  // every 5 minutes while open; it reads nothing until it scrolls into view.
  const dayChart = chartSlot("Book P&L and spot through the day, with your strikes", { id: "positions", refreshMs: 300_000 });
  const slotPanel = h(
    "section",
    { class: "desk-panel pos-slot", "data-panel": "chartslot", "aria-label": "Day chart", hidden: true },
    h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, h("strong", {}, "Day chart"), " ", h("span", { class: "muted pos-risk-sub" }, "Spot, your strikes and the book's P&L"))),
    dayChart,
  );
  let dayChartSig = "";
  /** At most this many open legs are read for the P&L line (one history read each). */
  const DAY_CHART_LEGS = 12;
  function drawDayChart() {
    if (slotPanel.hidden || !dayChart) return;
    const u = st.underlying;
    const open = legs.filter((l) => l.q && l.symbol && isFigure(l.avg));
    const sig = `${u}|${open.map((l) => `${l.symbol}:${l.q}:${l.avg}`).join(",")}`;
    if (sig === dayChartSig) return;
    dayChartSig = sig;
    dayChart.chart.load(async () => {
      const day = async (sym) => lastSession(candlesOf((await api(`/v1/history?symbol=${encodeURIComponent(sym)}&interval=5m&countback=80`)).data?.data));
      const few = open.length <= DAY_CHART_LEGS;
      const [spotC, ...legC] = await Promise.all([day(spotSymbol(u)), ...(few ? open.map((l) => optional(day(l.symbol)).then((r) => (r.error ? [] : r))) : [])]);
      const exits = cachedTriggers(st.account)
        .filter((t) => t.symbol === spotSymbol(u) && OPEN_TRIGGER.has(t.status))
        .flatMap((t) => (t.legs ?? []).map((l) => ({ role: l.role === "target" ? "target" : "stop", trigger: l.trigger })));
      return positionsSpec({
        underlying: u,
        spot: spotC,
        legs: few ? open.map((l, k) => ({ qty: l.q, avg: l.avg, candles: legC[k] })) : [],
        strikes: open.filter((l) => l.kind === "OPT").map((l) => l.strike),
        exits,
        pnlNote: few ? "Book P&L needs today's 5-minute prices for every open leg; one has none yet." : `Book P&L is drawn for up to ${formatInt(DAY_CHART_LEGS)} open legs.`,
      });
    });
  }
  const root = posPanel;

  // ── Book strip: Hero · Greeks · Capital (positions.md §4.1–4.3) ──
  /** A figure: counts up on its first paint, then flashes (gain / loss) when its text changes. */
  function setFigure(el, value, text, fmt, dirOf = (a, b) => b - a) {
    if (el.textContent === text && el.__v !== undefined) return;
    const prev = el.__v;
    el.__v = value;
    if (prev === undefined || !isFigure(prev)) {
      if (isFigure(value) && !reducedMotion() && el.__counted !== true) {
        el.__counted = true;
        countUp(el, 0, value, fmt, text);
      } else {
        stopCount(el);
        el.textContent = text;
      }
      return;
    }
    stopCount(el);
    el.textContent = text;
    if (isFigure(value) && value !== prev) flashValue(el, dirOf(prev, value) >= 0 ? "up" : "down");
  }
  let bookEntered = false;
  let compKeys = { won: [], lost: [], realised: [] };
  /** The account overview: total and day P&L, margin used, the underlyings rail. */
  function drawOverview() {
    const ov = accountOverview(d.all, { funds: d.fundsFor === st.account ? d.funds : null, dayTotal: d.all.length ? dayRows(d.all).total : null, current: st.underlying });
    ovEl.classList.toggle("loading", !d.loaded);
    setFigure(ovTotal, ov.total, ov.total === null ? DASH : rs(ov.total), (v) => rs(v));
    ovTotal.className = `pos-ov-v ${tone(ov.total) ?? ""}`.trim();
    const withLegs = ov.underlyings.filter((u) => u.legs).length;
    const tSub = ov.open ? `${plural(ov.open, "open position")} · ${plural(withLegs, "underlying")}` : "No open positions";
    if (ovTotalSub.textContent !== tSub) ovTotalSub.textContent = tSub;
    ovTotal.parentElement.title = `Realised and open P&L over every position in this account today, from the account's own figures${ov.missing ? `. ${plural(ov.missing, "position")} sent no P&L and ${ov.missing === 1 ? "is" : "are"} left out` : ""}`;
    setFigure(ovDay, ov.day, ov.day === null ? DASH : rs(ov.day), (v) => rs(v));
    ovDay.className = `pos-ov-v2 ${tone(ov.day) ?? ""}`.trim();
    const m = ov.margin;
    const mt = m.used === null ? DASH : ru(m.used);
    if (ovMargin.textContent !== mt) ovMargin.textContent = mt;
    const of = m.total === null ? "" : `of ${ru(m.total)}`;
    if (ovMarginOf.textContent !== of) ovMarginOf.textContent = of;
    const mv = String(m.util === null ? 0 : Math.round(Math.min(1, m.util) * 1000) / 1000);
    if (ovMeterFill.style.getPropertyValue("--v") !== mv) ovMeterFill.style.setProperty("--v", mv);
    ovMarginEl.dataset.level = m.level;
    const ms = m.util === null ? "Funds unavailable" : `${formatPercent(m.util * 100, 0)} used · free ${ru(m.free)}`;
    if (ovMarginSub.textContent !== ms) ovMarginSub.textContent = ms;
    // The rail: one capsule per underlying with open legs, the one on screen selected (shared selection rule).
    const rail = ov.underlyings.filter((u) => u.legs || u.underlying === st.underlying);
    // Rebuilt when the underlyings or their leg counts change; each tick only patches the P&L text in place.
    const ssig = JSON.stringify([rail.map((o) => [o.underlying, o.legs]), st.underlying]);
    if (switchEl.__sig !== ssig) {
      switchEl.__sig = ssig;
      switchEl.replaceChildren(
        ...rail.map((o) => {
          const cur = o.underlying === st.underlying;
          return h(
            "button",
            { type: "button", class: "chip-btn pos-uchip", "data-u": o.underlying, "aria-pressed": String(cur), onclick: () => !cur && setUnderlying(o.underlying) },
            h("strong", {}, o.underlying),
            o.legs ? h("span", { class: "pos-uchip-n" }, formatInt(o.legs)) : null,
            h("span", { class: "pos-uchip-p" }),
          );
        }),
      );
    }
    rail.forEach((o, k) => {
      const b = switchEl.children[k];
      const p = b?.lastChild;
      if (!p) return;
      const t = o.pnl === null ? "" : moneyShort(o.pnl);
      if (p.textContent !== t) p.textContent = t;
      const c = `pos-uchip-p ${tone(o.pnl) ?? ""}`.trim();
      if (p.className !== c) p.className = c;
      p.hidden = o.pnl === null;
      b.title = o.underlying === st.underlying ? `${o.underlying}: on screen` : `Show ${o.underlying} (broker P&L ${rs(o.pnl)})`;
    });
    // A rail of one (the underlying on screen) says nothing the page does not.
    switchEl.hidden = rail.length < 2;
  }
  /** Needs attention: the most urgent things in this underlying's book, as capsules that light their legs. */
  let attnSym = [];
  let attnTimer = null;
  function drawAttention() {
    const r = scopeNow() === "account" && !dayMode && legs.some((l) => l.q) ? attentionItems(legs, { now: Date.now(), close: refSession(st.ref).close }) : { items: [], more: 0 };
    attnEl.hidden = !r.items.length;
    // Rebuilt only when the items themselves change; a tick that moves a figure (the loser's P&L) patches the text,
    // so a capsule under the pointer is never swapped out mid-click.
    const sig = JSON.stringify([r.items.map((i) => [i.id, i.level, i.label]), r.more]);
    if (attnEl.__sig !== sig) {
      attnEl.__sig = sig;
      attnEl.__items = r.items.map(() => ({ i: null }));
      attnEl.replaceChildren(
        h("span", { class: "pos-attn-lbl" }, "Needs attention"),
        ...r.items.map((i, k) => {
          const t = h("span", { class: "t" });
          const b = h("button", { type: "button", class: `pos-attn-i ${i.level}`, "data-kind": i.kind, onclick: () => attend(attnEl.__items[k].i) }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { class: "k" }, i.label), t);
          attnEl.__items[k].t = t;
          attnEl.__items[k].b = b;
          return b;
        }),
        ...(r.more ? [h("span", { class: "pos-attn-more" }, `+${formatInt(r.more)} more`)] : []),
      );
    }
    r.items.forEach((i, k) => {
      const ref = attnEl.__items[k];
      ref.i = i;
      const tsig = `${i.text}|${tone(i.value)}`;
      if (ref.t.__sig !== tsig) {
        ref.t.__sig = tsig;
        ref.t.replaceChildren(...(i.kind === "loser" ? [`${i.name} `, h("span", { class: tone(i.value) }, moneyShort(i.value))] : [i.text]));
        ref.b.title = `${i.label}: ${i.text}. Shows the leg${i.symbols.length === 1 ? "" : "s"} in the table`;
      }
    });
  }
  function attend(i) {
    if (i.kind === "expiry" && xpState?.expiry === i.id.slice(7) && !xpOpen) {
      xpOpen = true;
      drawExpiryDesk();
    }
    const first = i.symbols.find((s) => rowRefs.has(s));
    if (first) {
      focusSym = first;
      patchRows(colsNow());
      rowRefs.get(first).el.scrollIntoView?.({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    }
    clearTimeout(attnTimer);
    hoverRows(attnSym, false);
    attnSym = i.symbols;
    hoverRows(attnSym, true);
    attnTimer = setTimeout(() => hoverRows(attnSym, false), 1800);
  }
  function drawBook() {
    drawOverview();
    drawAttention();
    if (heroLabel.textContent !== `${st.underlying} P&L`) heroLabel.textContent = `${st.underlying} P&L`;
    const errText = d.error && d.lastOk ? `Couldn't refresh positions. Showing ${istTime(d.lastOk)}.` : "";
    if (errBar.textContent !== errText) errBar.textContent = errText;
    errBar.hidden = !errText;
    bookPanel.classList.toggle("kept", Boolean(errText));
    const loading = !d.loaded;
    bookPanel.classList.toggle("loading", loading);
    bookPanel.setAttribute("aria-busy", String(loading));
    bookGrid.hidden = d.loaded && !legs.length;
    if (!legs.length) return;
    const open = legs.filter((l) => l.q);
    // Hero: Net P&L over every leg (P&L is fact, not a scenario), today's closed legs and realised included.
    const { realised: R, unrealised: U, noRealised: noR } = O.bookPnl(legs);
    const c = O.pnlComposition(legs);
    setFigure(heroValue, U + R, rs(U + R), (v) => rs(v));
    heroValue.className = `pos-hero-v ${tone(U + R) ?? ""}`.trim();
    heroEl.title = `Realised ${rs(R)} · Unrealised ${rs(U)} (from the marks)${noR ? ". Broker sent no realised P&L for some legs" : ""}`;
    const parts = [["won", c.won], ["lost", c.lost], ["realised", c.realised]];
    const sum = parts.reduce((t, [, v]) => t + Math.abs(v), 0) || 1;
    for (const [k, v] of parts) {
      const f = Math.abs(v) / sum;
      const el = comp[k];
      // A segment under 2 % is dropped from the bar (kept in the caption).
      const grow = f < 0.02 ? "0" : String(Math.round(f * 1000) / 1000);
      if (el.style.getPropertyValue("--f") !== grow) el.style.setProperty("--f", grow);
      el.hidden = grow === "0";
      el.dataset.tone = k === "won" ? "pos" : k === "lost" ? "neg" : v >= 0 ? "pos" : "neg";
      el.title = `${COMP_NAME[k]}: ${rs(v)}`;
      const b = compBtn[k];
      const label = `${COMP_NAME[k]}: ${rs(v)}`;
      if (b.getAttribute("aria-label") !== label) b.setAttribute("aria-label", label);
      b.title = `${label}. Lights the legs it comes from`;
    }
    compKeys = {
      won: legs.filter((l) => l.q && O.legUnrealised(l) > 0).map((l) => l.symbol),
      lost: legs.filter((l) => l.q && O.legUnrealised(l) < 0).map((l) => l.symbol),
      realised: legs.filter((l) => num(l.realised)).map((l) => l.symbol),
    };
    // Compact figures ("+₹9.7K") so the caption fits the hero at every width; each figure never splits at its sign.
    const phone = isPhone();
    for (const [k, v] of parts) {
      const f = compBtn[k].lastChild;
      const t = rc(v);
      if (f.textContent !== t) f.textContent = t;
      f.className = `f ${tone(v) ?? ""}`.trim();
      const w = k === "realised" && phone ? "R" : COMP_WORD[k];
      if (compBtn[k].firstChild.textContent !== w) compBtn[k].firstChild.textContent = w;
    }
    // Credit kept (PRD 04 §5.1): the share of the option credit still kept; 50 / 80 % are the usual targets.
    const optLegs = open.filter((l) => l.kind === "OPT" && num(l.avg) !== null);
    const credit = -optLegs.reduce((t, l) => t + l.avg * l.q, 0);
    const cost = -optLegs.reduce((t, l) => t + (l.mark ?? l.avg) * l.q, 0);
    const kept = credit > 0 ? ((credit - cost) / credit) * 100 : null;
    keptEl.hidden = kept === null;
    if (kept !== null) {
      const t = `Credit kept ${formatPercent(Math.max(-999, Math.min(100, kept)), 0)}${isPhone() ? "" : ` of ${ru(credit)}`}`;
      const tt = keptEl.firstChild;
      if (tt.textContent !== t) tt.textContent = t;
      const v = String(Math.round((Math.min(100, Math.abs(Math.max(-100, kept))) / 100) * 1000) / 1000);
      if (keptFill.style.getPropertyValue("--v") !== v) keptFill.style.setProperty("--v", v);
      keptEl.dataset.tone = kept >= 0 ? "pos" : "neg";
      keptEl.classList.toggle("capped", kept < -100);
      keptEl.title = `Credit received ${formatRupee(credit, 0)}, cost to close ${formatRupee(cost, 0)}. Ticks at 50% and 80%: the usual book-profit targets`;
    }
    // Net if closed now: U + R − exit charges at the marks (an estimate; the contract note is final).
    const ch = O.closeCharges(open);
    const closed = U + R - ch.total;
    const cTitle = `If every open leg were closed now at its mark: ${rs(U + R)} − charges ${formatRupee(ch.total, 0)} (brokerage ${formatRupee(ch.brokerage, 0)}, STT ${formatRupee(ch.stt, 0)}, exchange ${formatRupee(ch.txn, 0)}, SEBI ${formatRupee(ch.sebi, 0)}, stamp ${formatRupee(ch.stamp, 0)}, GST ${formatRupee(ch.gst, 0)}). Charges are estimates; check your broker's contract note.`;
    const cSig = `${Math.round(closed)}`;
    if (closedEl.__sig !== cSig) {
      closedEl.__sig = cSig;
      closedEl.replaceChildren("Net if closed ", h("strong", { class: tone(closed) }, rs(closed)), h("span", { class: "pos-info", "aria-hidden": "true" }, "ⓘ"));
    }
    closedEl.title = cTitle;
    drawGauges(open);
    drawCapital();
    drawStress();
    if (!bookEntered && d.loaded) {
      bookEntered = true;
      barsEnter(bookPanel);
    }
  }
  /** The futures lot (the Δ band's default and the "lots" reading). */
  const futLot = () => num(pickFuture()?.lotSize) ?? legs.find((l) => l.kind === "FUT")?.lot ?? legs.find((l) => l.kind === "OPT")?.lot ?? null;
  const deltaBand = () => cfg().deltaBand ?? futLot();
  function drawGauges(open) {
    const g = book;
    const none = !g || g.priced === 0;
    const partial = g?.excluded ? ["partial", `${plural(g.excluded, "leg")} excluded`] : g?.missing.length ? ["partial", `${plural(g.missing.length, "leg")} not priced`] : null;
    const allOff = open.length > 0 && open.every((l) => !l.inc);
    const chipText = allOff ? "all legs excluded" : partial ? partial[0] : "";
    if (greeksChip.textContent !== chipText) greeksChip.textContent = chipText;
    greeksChip.title = partial?.[1] ?? "";
    greeksChip.hidden = !chipText;
    const S = spot;
    const Lf = futLot();
    const B = deltaBand();
    const g1 = none || !S ? 0 : g.gamma * S * 0.01;
    const sc0 = O.greekScales({ delta: none ? 0 : g.delta, gamma1: g1, theta: none ? 0 : g.theta, vega: none ? 0 : g.vega, band: B, lot: Lf });
    // Gross option value (long and short premium both count), so a calendar or a near-balanced spread never reads
    // "Θ is 4000% of option value". Below ₹500 of premium the share is not shown.
    const vOpt = open.filter((l) => l.kind === "OPT" && l.mark !== null).reduce((t, l) => t + Math.abs(l.mark * l.q), 0);
    const set = (k, { value, text, sub, bar, M, tone: tn, title, warn = false, fmt }) => {
      const r = gauges.get(k);
      setFigure(r.value, none ? null : value, none ? DASH : text, fmt);
      if (r.sub.textContent !== (none ? "" : sub)) r.sub.textContent = none ? "" : sub;
      setDiv(r.bar, none ? 0 : bar, M, warn ? "warn" : tn);
      r.el.classList.toggle("warn", Boolean(warn) && !none);
      r.el.title = none ? `No Greeks: ${plural(g?.missing.length ?? 0, "leg")} not priced` : title;
      r.el.setAttribute("aria-label", `${GAUGES.find((x) => x[0] === k)[2]}: ${none ? "not available" : `${text}${sub ? `, ${sub}` : ""}`}`);
    };
    const bandFrac = B && sc0.M ? Math.min(1, B / sc0.M) : 0;
    for (const k of ["delta", "gamma"]) {
      const band = gauges.get(k).band;
      band.hidden = !B || none;
      const w = String(Math.round(bandFrac * 1000) / 1000);
      if (band.style.getPropertyValue("--b") !== w) band.style.setProperty("--b", w);
    }
    const out = !none && sc0.outside;
    set("delta", {
      value: none ? 0 : g.delta,
      text: none ? DASH : formatSigned(g.delta, 0),
      sub: out ? `outside ±${formatInt(B)} band` : `${Lf ? `≈ ${formatSigned(g.delta / Lf, 1)} lots` : ""}${S && !isPhone() ? ` · ${ru(g.delta * S)}` : ""}`,
      bar: none ? 0 : g.delta,
      M: sc0.M,
      tone: "fg",
      warn: out,
      title: `Rupees gained for a 1-point rise = Δ. Band ±${formatInt(B)}${cfg().deltaBand ? " (yours)" : " (one futures lot)"}; set it in Customise. Futures-lot equivalent and notional exposure.`,
      fmt: (v) => formatSigned(v, 0),
    });
    set("gamma", {
      value: g1,
      text: none || !S ? DASH : formatSigned(g1, 0),
      sub: isPhone() ? "Δ/1%" : `Δ per 1% · Γ ${formatSigned(g?.gamma, 2)}/pt`,
      bar: g1,
      M: sc0.M,
      tone: "fg",
      warn: !none && g1 < 0 && B && Math.abs(g1) > B / 2,
      title: "How much Δ changes for a 1% move in the underlying, on the Δ gauge's scale: you can see whether a 1% move pushes you out of the band",
      fmt: (v) => formatSigned(v, 0),
    });
    set("theta", {
      value: none ? 0 : g.theta,
      text: none ? DASH : `${rs(g.theta)}${isPhone() ? "" : "/d"}`,
      sub: none || vOpt < 500 || isPhone() ? (isPhone() ? "/day" : "") : `${formatPercent((g.theta / vOpt) * 100, 1)} of option value`,
      bar: none ? 0 : g.theta,
      M: sc0.Mtv,
      tone: toneOf(g?.theta),
      title: "₹ per trading day: time decay over one unit of the vol-time clock. Weekends and holidays count at their weight in the next session. Θ and ν share one scale",
      fmt: (v) => `${rs(v)}${isPhone() ? "" : "/d"}`,
    });
    set("vega", {
      value: none ? 0 : g.vega,
      text: none ? DASH : `${rs(g.vega)}${isPhone() ? "" : "/pt"}`,
      sub: none ? "" : isPhone() ? "/vol pt" : `IV −1 → ${rs(-g.vega)}`,
      bar: none ? 0 : g.vega,
      M: sc0.Mtv,
      tone: "iv",
      title: "P&L for a one vol point rise in every leg's IV. Vega is not good or bad: its bar is violet, not green / red",
      fmt: (v) => `${rs(v)}${isPhone() ? "" : "/pt"}`,
    });
  }
  /** The Greeks cell's footer: POP at the first expiry (from the risk pass) and Θ/ν (days of decay per vol point). */
  function drawGreeksFoot() {
    const g = book;
    const none = !g || g.priced === 0;
    const n = nearest();
    const pop = riskStats.pop;
    const tv = !none && g.vega ? Math.abs(g.theta) / Math.abs(g.vega) : null;
    const foot = `POP ≈ ${pop === null || pop === undefined ? DASH : formatPercent(pop * 100, 0)}${n ? ` at ${expiryText(n.expiry)}` : ""}${tv !== null ? ` · Θ/ν ${formatFixed(tv, 2)}` : ""}`;
    if (greeksFoot.textContent !== foot) greeksFoot.textContent = foot;
    greeksFoot.title = "Model probability · uncalibrated: the chance the book is in profit at the first expiry, lognormal at the ATM IV. Later-expiry legs are valued by the model. Θ/ν: trading days of decay one vol point is worth";
  }
  /** A book leg as a span-margin.js leg (the paper engine's model): the quantity signed, priced at cost or mark. */
  const marginLeg = (l, qty = l.q) => ({ underlying: st.underlying, kind: l.kind, right: l.right, strike: l.strike, expiry: l.expiry, qty, cost: num(l.avg) ?? num(l.mark), mark: num(l.mark) ?? num(l.avg), iv: num(l.iv) });
  /**
   * Paper margin change from some orders on this book, with the same model as the paper engine (span-margin.js):
   * { before, after, change } in rupees, or null without a price for the forward. `orders`: [{ leg, side, qty }].
   */
  function paperMarginEffect(orders) {
    const held = legs.filter((l) => l.q && l.priced);
    const F = num(held.find((l) => num(l.F) !== null)?.F) ?? spot;
    if (!held.length || !F) return null;
    const added = (orders ?? []).filter((o) => o.leg && o.qty > 0).map((o) => marginLeg(o.leg, (o.side === "BUY" ? 1 : -1) * o.qty));
    return marginImpact(held.map((l) => marginLeg(l)), added, { nowMs: Date.now(), forwards: { [st.underlying]: F } });
  }
  function drawCapital() {
    const f = d.funds;
    const used = num(f?.usedMargin);
    const avail = num(f?.availableCash);
    const total = used !== null && avail !== null && used + avail > 0 ? used + avail : num(f?.totalBalance);
    // The same portfolio model as the paper engine, the ticket and Strategy (span-margin.js): hedges across strikes,
    // expiries and futures of this underlying are credited.
    const held = legs.filter((l) => l.q && l.priced);
    const F = num(held.find((l) => num(l.F) !== null)?.F) ?? spot;
    const est = held.length && F ? portfolioMargin(held.map((l) => marginLeg(l)), { nowMs: Date.now(), forwards: { [st.underlying]: F } }) : null;
    const has = used !== null && total > 0;
    const util = has ? used / total : null;
    const mb = has && est ? Math.min(est.required, used) : null;
    // The colour follows the number the user reads: 89.9 % shows "90%" and is painted as 90 % (neg).
    const shown = util === null ? null : Math.round(util * 100);
    const lvl = shown === null ? "none" : shown >= 90 ? "neg" : shown >= 70 ? "warn" : "ok";
    capEl.dataset.level = lvl;
    // The overview carries the account's margin; this cell is the share of it this underlying's book needs.
    const top = has ? (mb ? `≈ ${ru(mb)}${est.required > used ? "+" : ""} for ${st.underlying}` : `${ru(used)} in use`) : "Funds unavailable";
    if (capTop.textContent !== top) capTop.textContent = top;
    const pct = has && mb ? formatPercent((mb / total) * 100, 0) : "";
    if (capPct.textContent !== pct) capPct.textContent = pct;
    const a = has ? (mb ?? 0) / total : 0;
    const b = has ? Math.max(0, used - (mb ?? 0)) / total : 0;
    const setSeg = (el, x, v) => {
      const xs = String(Math.round(x * 1000) / 1000);
      const vs = String(Math.round(Math.min(1, v) * 1000) / 1000);
      if (el.style.getPropertyValue("--x") !== xs) el.style.setProperty("--x", xs);
      if (el.style.getPropertyValue("--v") !== vs) el.style.setProperty("--v", vs);
    };
    setSeg(segBook, 0, a);
    setSeg(segOther, a, b);
    segBook.hidden = !mb;
    const sub = has ? `${mb && used - mb > 1 ? `other books ${ru(used - mb)} · ` : ""}free ${ru(avail ?? total - used)}` : "";
    if (capSub.textContent !== sub) capSub.textContent = sub;
    const saved = est && est.benefit > 1 ? ` Hedges save about ${ru(est.benefit)} against each leg on its own (${ru(est.standalone)}).` : "";
    capEl.title = `Account-wide margin from your broker or the paper engine. 'This book' is the portfolio estimate${est && est.required > (used ?? Infinity) ? ` (≥ ${ru(est.required)})` : ""}.${saved} ${SPAN_METHOD}${util !== null && util >= 0.7 ? ` ${formatPercent(util * 100, 1)} of funds used.` : ""}`;
  }
  /** ±1σ / ±2σ P&L now (§4.3): the book chips (desktop / tablet) and the Scenario tab's (phone), on the heatmap scale. */
  let stressRows = [];
  function drawStress() {
    const inc = included().filter((l) => l.priced);
    const sp = sigmaPct();
    stressRows = sp && spot ? O.stressPnl(inc, sp / 100, [-2, -1, 1, 2], { spot }) : [];
    const m = heatScale();
    // Visibility is set on every pass (not behind the signature): the book's chips on desktop / tablet, the
    // Scenario tab's on phones only, from its first open.
    stressBook.hidden = !stressRows.length;
    stressScen.hidden = !isPhone() || !stressRows.length;
    for (const host of [stressBook, stressScen]) {
      const sig = JSON.stringify([stressRows.map((x) => [x.k, Math.round(x.v)]), Math.round(m)]);
      if (host.__sig === sig) continue;
      const fresh = !host.childElementCount;
      host.__sig = sig;
      if (host.childElementCount !== stressRows.length) {
        host.replaceChildren(...stressRows.map((x) => h("button", { type: "button", class: "pos-schip", onclick: () => setScenario({ pct: Math.max(-10, Math.min(10, Math.round(x.pct / 0.25) * 0.25)), dIv: 0, days: 0 }) }, h("span", { class: "k" }), h("span", { class: "v" }))));
        if (!fresh) host.classList.add("in");
      }
      stressRows.forEach((x, i) => {
        const b = host.children[i];
        b.firstChild.textContent = `${x.k > 0 ? "+" : "−"}${Math.abs(x.k)}σ`;
        b.lastChild.textContent = rk(x.v);
        heatCell(b, O.divStep(x.v, m), "div");
        b.title = `${st.underlying} at ${formatInt(x.price)} (${formatSigned(x.pct, 1)}%) now: ${rs(x.v)} unrealised`;
        b.setAttribute("aria-label", `${x.k > 0 ? "plus" : "minus"} ${Math.abs(x.k)} sigma, ${formatInt(x.price)}: ${rs(x.v)}`);
      });
    }
  }
  function drawWarnings() {
    const st0 = staleness();
    // Tested and in-the-money shorts are in Needs attention (with the legs they point at), not repeated here.
    const w = legs.length ? O.bookWarnings(legs, { spot, stale: st0, band: book && book.priced ? { delta: book.delta, band: deltaBand() } : null, rates: refCharges(st.ref) }).filter((x) => x.id !== "tested") : [];
    const sig = JSON.stringify([w, warnOpen, isPhone()]);
    if (warnEl.__sig === sig) return;
    warnEl.__sig = sig;
    const wkey = (x) => `${x.id}|${x.text.replace(/\d+:\d+$/, "")}`;
    const chip = (x) =>
      x.id === "excluded"
        ? h("button", { type: "button", class: `pos-warn ${x.level}${lastWarnIds.has(wkey(x)) ? "" : " fresh"}`, title: x.title, onclick: () => (setExcluded([]), price(O.bookLegs(d.all, st.underlying, { closed: true })), draw()) }, x.text)
        : h("span", { class: `pos-warn ${x.level}${lastWarnIds.has(wkey(x)) ? "" : " fresh"}`, title: x.title }, h("span", { class: "dot", "aria-hidden": "true" }), x.text);
    const phone = isPhone();
    // Phones: one "⚠ N warnings ›" toggle beside the margin bar (the book stays short); the list opens below.
    const toggle = phone && w.length > 1;
    capWarn.replaceChildren(...(toggle ? [h("button", { type: "button", class: "pos-warn-toggle", "aria-expanded": String(warnOpen), onclick: () => ((warnOpen = !warnOpen), drawWarnings()) }, icon("warn"), `${formatInt(w.length)} warnings`, h("span", { class: "chev", "aria-hidden": "true" }, warnOpen ? "‹" : "›"))] : []));
    capWarn.hidden = !toggle;
    warnEl.hidden = !w.length || (toggle && !warnOpen);
    warnEl.replaceChildren(...(toggle ? (warnOpen ? w.map(chip) : []) : w.map(chip)));
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
  /** Below 1024 px IV, Vega and P&L % drop out (the row's ⋯ menu and the cards keep the essentials). */
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
  const groupTitle = (g) => (g.expiry ? `${expiryText(g.expiry)} · ${O.isExpiryDay(g.expiry) ? "Expires today" : O.timeToExpiry(g.expiry, Date.now(), refSession(st.ref).close).label}` : "All expiries");
  // A lot revision, corporate action or expiry shift on this underlying within 7 days: a chip on every row
  // (docs/spec/p1-02-reference.md §5.3). Positions keep the lot they opened with.
  const refEvent = () => upcomingEvents(st.ref?.events).find((e) => e.underlying === st.underlying) ?? null;
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
    if (!dayMode && titleEl.__sig !== titleSig) {
      titleEl.__sig = titleSig;
      const n = visibleLegs.filter((l) => l.q).length;
      titleEl.replaceChildren(h("strong", {}, `${st.underlying} positions`), h("span", { class: "muted" }, n ? ` · ${plural(n, "leg")}` : ""));
    }
    exitAllBtn.hidden = !legs.some((l) => l.q);
    alertBtn.hidden = scopeNow() !== "account" || !legs.some((l) => l.q);
    const nAlerts = alertBtn.hidden ? 0 : rulesFor(st.account, st.underlying).filter((r) => r.enabled).length;
    const at = nAlerts ? `Alert · ${formatInt(nAlerts)} on` : "Alert";
    if (alertBtn.lastChild.textContent !== at) alertBtn.lastChild.textContent = at;
    // Exit all: say how many legs have a spread wider than 5 % of mid (a market or touch exit costs more there).
    const wide = O.wideSpreadCount(legs.filter((l) => l.q && l.quote).map((l) => l.quote));
    const allText = wide ? `Exit all · ${plural(wide, "wide spread")}` : "Exit all";
    if (exitAllBtn.textContent !== allText) {
      exitAllBtn.textContent = allText;
      exitAllBtn.classList.toggle("warn", wide > 0);
      exitAllBtn.title = wide ? `${plural(wide, "leg")} with a spread over 5% of mid: the exit plan prices them at mid by default${keyHint(" (Shift+X)")}` : `Exit plan for every leg${keyHint(" (Shift+X)")}`;
    }
    if (!a) return setBody("noacct", () => emptyState("plug", "Connect an account to trade", "Positions come from an account that can place orders. Add one, or log in, on the Accounts page.", h("a", { href: "#/accounts", class: "small-link" }, "Open Accounts"), { compact: true }));
    if (!d.loaded) return setBody("loading", () => loadingState({ rows: 5, cols: 5, label: `Loading ${st.underlying} positions`, height: 52 }));
    if (d.error && !d.lastOk) return setBody(`err|${d.error.message}`, () => errorState(d.error, { onRetry: () => tick() }));
    if (!visibleLegs.length) {
      const others = O.bookUnderlyings(d.all, st.underlying);
      return setBody(`empty|${st.underlying}|${JSON.stringify(others)}`, () =>
        h(
          "div",
          { class: "pos-empty" },
          emptyState(
            "wallet",
            others.length ? `Nothing open on ${st.underlying}` : "No open positions",
            others.length
              ? `Your open positions are on ${others.map((o) => o.underlying).join(", ")}: pick one above, or start a ${st.underlying} trade from the Option Chain.`
              : `${touchWord()} a bid or ask in the Option Chain to trade, or build a strategy and send it as one basket.${account()?.broker === "paper" ? " This is a paper account: practise first, nothing reaches the exchange." : ""}${keyHint(" Keys: B / S on a strike.")}`,
            [h("button", { type: "button", class: "primary small", onclick: () => (location.hash = "#/chain") }, "Open Option Chain"), h("a", { href: "#/strategy", class: "small-link" }, "Strategy Builder")],
            { compact: true },
          ),
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
      bodyEl.replaceChildren(...[d.error ? errorState(d.error, { onRetry: () => tick(), lastGood: d.lastOk }) : null, phone ? buildCards() : buildTable(cols, narrow)].filter(Boolean));
      bodyEl.__mode = "list";
      if (had) bodyEl.querySelector(`[data-key="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
      patchRows(cols);
      barsEnter(bodyEl);
    } else patchRows(cols);
    fitTable();
    drawBulk();
  }
  /**
   * Desktop widths 1100–1366 (and a tablet with many columns): drop the least needed columns until the table fits its panel (no inner sideways
   * scroll): P&L %, then Vega, IV, the Δ bar, Γ, the σ gauge (its text stays) and last the P&L bars. Tablets
   * already hide IV, Vega and P&L % (CSS).
   */
  const FIT_DROP = ["pnlPct", "vega", "iv", "dbar", "gamma", "sg", "pbars"];
  // The table also widens after a draw (marks, the σ gauge and the bars fill in): refit whenever it changes size, so
  // no column is left cut at the panel edge (1024 px: Distance and the group's Exit were cut).
  const fitRo = typeof ResizeObserver === "function" ? new ResizeObserver(() => fitTable()) : null;
  let fitWatched = null;
  function fitTable() {
    const wrap = bodyEl.querySelector(".pos-wrap");
    const table = wrap?.querySelector("table.pos-table");
    if (!table) return;
    if (fitRo && fitWatched !== table) {
      if (fitWatched) fitRo.unobserve(fitWatched);
      fitWatched = table;
      fitRo.observe(table);
    }
    for (const k of FIT_DROP) table.classList.remove(`fit-${k}`);
    if (!wrap.clientWidth) return;
    for (const k of FIT_DROP) {
      if (table.offsetWidth <= wrap.clientWidth) break;
      table.classList.add(`fit-${k}`);
    }
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
    const thead = h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "c-inc" }, h("span", { class: "sr-only" }, "Include in risk"), h("span", { "aria-hidden": "true", title: "Include in risk" }, "Risk")), h("th", { scope: "col" }, "Contract"), shown.map((k) => h("th", { scope: "col", class: `num c-${k} ${OPT_X.has(k) ? "opt-x" : ""}`.trim(), title: O.POS_COLUMNS.find((c) => c[0] === k)?.[2] }, COL_HEAD[k])), h("th", { scope: "col", class: "act" }, h("span", { class: "sr-only" }, "Actions"))));
    const bodies = shownGroups().map((g) => {
      const head = h("tr", { class: "pos-ghead" });
      const [incHit, inc] = incBox(`Include every ${groupTitle(g)} leg in risk`, (on) => toggleInclude(g.legs.filter((l) => l.q).map((l) => l.symbol), on));
      const title = h("span", { class: "pos-gtitle" });
      const glyph = groupGlyph();
      const stats = h("span", { class: "pos-gstats" });
      const gpnl = h("span", { class: "pos-gpnl" });
      const gbar = divBar("pos-gpbar");
      const locked = h("span", { class: "pos-locked", hidden: true });
      const riskEl = h("span", { class: "pos-grisk" });
      const acts = h(
        "span",
        { class: "pos-gacts" },
        g.expiry ? h("button", { type: "button", class: "small plain", onclick: () => analyse(g), title: "Open this expiry's option legs in the strategy builder (exact quantities)" }, "Analyse") : null,
        g.expiry && g.legs.some((l) => l.q && l.kind === "OPT") ? h("button", { type: "button", class: "small plain", title: "Roll this group's option legs to a later expiry in one basket", onclick: () => openRoll(g.legs.filter((l) => l.q), groupTitle(g).split(" · ")[0]) }, "Roll") : null,
        g.legs.some((l) => l.q) ? h("button", { type: "button", class: "small plain", title: "Add a hedge: the hedge helper sizes a future or option to bring the book's Δ to your target, before and after shown; nothing is sent until you confirm", onclick: () => openHedge() }, "Add hedge") : null,
        h("button", { type: "button", class: "small", onclick: () => openExitPlan(g.legs.filter((l) => l.q), `${groupTitle(g).split(" · ")[0]}`) }, "Exit group"),
        g.legs.some((l) => l.q) ? h("button", { type: "button", class: "small plain", "aria-label": `Alert on ${groupTitle(g).split(" · ")[0]}`, title: "Alert on this group: P&L, spot, delta, time to expiry or a leg's premium", onclick: () => alertOn(g.legs.filter((l) => l.q), groupTitle(g).split(" · ")[0]) }, icon("bell")) : null,
      );
      head.append(h("th", { scope: "rowgroup", colspan: String(ncol) }, h("div", { class: "pos-gline" }, incHit, title, glyph.el, h("span", { class: "pos-gp" }, gpnl, gbar.el), stats, acts), riskEl, locked));
      groupRefs.set(g.key, { inc, title, stats, locked, glyph, gpnl, gbar, riskEl });
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
        tr.append(h("td", { class: "act" }, h("span", { class: "pos-acts" }, l.q ? h("button", { type: "button", class: "small", "aria-label": `Exit ${fullName(l)}`, onclick: (e) => (e.stopPropagation(), exitLeg(l.symbol)) }, "Exit") : null, l.q ? more : null)));
        tr.addEventListener("click", (e) => {
          if (e.target.closest("button, input, a, label")) return;
          rowClick(l.symbol, e.shiftKey);
        });
        linkHover(tr, l.symbol);
        rowRefs.set(l.symbol, { el: tr, cells, inc: iBox });
        return tr;
      });
      return h("tbody", { "data-group": g.key }, head, rows);
    });
    return h("div", { class: "table-wrap pos-wrap" }, h("table", { class: `desk-table pos-table${narrow ? " narrow" : ""}` }, thead, bodies));
  }
  /** Hovering a leg rings its strike marker on the payoff (§8); the marker's hover lights the row back. */
  function linkHover(el, sym) {
    el.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && pay.highlightMarker(sym));
    el.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && pay.highlightMarker(null));
  }
  /** The group's risk at its expiry: max loss / profit and breakevens from a wide sampled curve, cached per group. */
  const riskCache = new Map();
  function groupRisk(g) {
    const inc = g.legs.filter((l) => l.q && l.inc && l.priced);
    const ref = inc.find((l) => l.kind === "OPT") ?? inc[0];
    if (!ref || num(ref.F) === null) return null;
    const sig = `${inc.map((l) => `${l.symbol}:${l.q}:${formatFixed(l.mark, 1)}:${formatFixed(l.iv, 1)}`).join()}|${Math.round(ref.F)}`;
    const c = riskCache.get(g.key);
    if (c?.sig === sig) return c.read;
    const days = O.legDaysToExpiry(ref, Date.now(), refSession(st.ref).close);
    const m = O.sigmaMove(ref.F, ref.atmIv ?? ref.iv, ref.T);
    const xs = riskGrid(ref.F, m ? m / ref.F : 0.02, inc.filter((l) => l.kind === "OPT").map((l) => l.strike));
    const read = riskRead(O.bookCurveStats((x) => O.scenarioPnl(inc, { dS: x / ref.F - 1, days }), xs));
    riskCache.set(g.key, { sig, read });
    return read;
  }
  /** The risk line's nodes: max loss in red, max profit in green, the breakevens in label ink. */
  const riskNodes = (r) =>
    !r
      ? []
      : [
          h("span", {}, "Max loss ", h("strong", { class: r.lossUnlimited ? "down" : tone(r.maxLoss) }, r.lossUnlimited ? "Unlimited" : moneyShort(r.maxLoss))),
          h("span", {}, "Max profit ", h("strong", { class: r.profitUnlimited ? "up" : tone(r.maxProfit) }, r.profitUnlimited ? "Unlimited" : moneyShort(r.maxProfit))),
          r.breakevens.length ? h("span", {}, `${r.breakevens.length === 1 ? "Breakeven" : "Breakevens"} `, h("strong", {}, r.breakevens.slice(0, 3).map((b) => formatInt(b)).join(" · "))) : h("span", {}, "No breakeven"),
        ];
  function groupGlyph() {
    const up = svgEl("path", { class: "up" });
    const dn = svgEl("path", { class: "dn" });
    const zero = svgEl("line", { class: "z", x1: 0, x2: 40 });
    const t = svgEl("title", {});
    const el = svgEl("svg", { class: "pos-glyph", viewBox: "0 0 40 16", width: 40, height: 16, role: "img" }, t, zero, dn, up);
    return { el, up, dn, zero, t };
  }
  /** The group's expiry curve over F ± 2.6σ, 41 points, for its glyph (§4.10). */
  function groupCurve(g) {
    const inc = g.legs.filter((l) => l.q && l.inc && l.priced);
    const ref = inc.find((l) => l.kind === "OPT") ?? inc[0];
    if (!ref || num(ref.F) === null) return null;
    const F = ref.F;
    const m = O.sigmaMove(F, ref.atmIv ?? ref.iv, ref.T) ?? F * 0.02;
    // At the reference leg's expiry close, in calendar days from its pricing instant.
    const days = O.legDaysToExpiry(ref, Date.now(), refSession(st.ref).close);
    const vals = [];
    for (let i = 0; i <= 40; i++) {
      const x = F - 2.6 * m + (5.2 * m * i) / 40;
      vals.push(O.scenarioPnl(inc, { dS: x / F - 1, days }));
    }
    return vals;
  }
  function buildCards() {
    return h(
      "div",
      { class: "pos-cards" },
      shownGroups().map((g) => {
        const isOpen = !collapsed.has(g.key);
        const title = h("span", { class: "pos-gtitle" });
        const glyph = groupGlyph();
        const stats = h("span", { class: "pos-gstats" });
        const gpnl = h("span", { class: "pos-gpnl" });
        const gbar = divBar("pos-gpbar");
        const locked = h("span", { class: "pos-locked", hidden: true });
        const riskEl = h("span", { class: "pos-grisk" });
        const head = h(
          "button",
          { type: "button", class: "pos-cghead", "aria-expanded": String(isOpen), onclick: () => (isOpen ? collapsed.add(g.key) : collapsed.delete(g.key), drawPositions()) },
          h("span", { class: "pos-gline" }, title, glyph.el, h("span", { class: "pos-gp" }, gpnl, gbar.el)),
          icon("chevron"),
        );
        groupRefs.set(g.key, { inc: null, title, stats, locked, glyph, gpnl, gbar, riskEl });
        const list = isOpen
          ? h(
              "div",
              { role: "list", class: "pos-clist" },
              g.legs.filter(shownLeg).map((l) => {
                const tag = h("span", { class: "side-tag" });
                const name = h("strong", { class: "pos-cname" });
                const lots = h("span", { class: "pos-clots" });
                const ex = h("span", { class: "pos-chip", hidden: true }, "excluded");
                const pv = h("span", { class: "pos-cpv" });
                const pbar = divBar("pos-cbar");
                const l1 = h("span", { class: "pos-c1" }, tag, name, lots, ex, h("span", { class: "pos-cpnl" }, pv, pbar.el));
                const txt = h("span", { class: "pos-c2t" });
                const sg = sigmaGauge();
                const sgt = h("span", { class: "pos-sgt" });
                const l2 = h("span", { class: "pos-c2" }, txt, h("span", { class: "pos-c2g" }, sg, sgt));
                const card = h("button", { type: "button", class: `pos-card${l.q ? "" : " closed"}`, "data-key": l.symbol, onclick: () => legSheet(l.symbol) }, l1, l2);
                linkHover(card, l.symbol);
                const item = h("div", { role: "listitem" }, card);
                rowRefs.set(l.symbol, { el: card, cells: new Map(), inc: null, card: { tag, name, lots, ex, pv, pbar, txt, sg, sgt } });
                return item;
              }),
            )
          : null;
        return h("section", { class: "pos-cgroup", "data-group": g.key }, head, riskEl, locked, list, isOpen && g.expiry ? h("div", { class: "pos-cacts" }, h("button", { type: "button", class: "small", onclick: () => analyse(g) }, "Analyse"), g.legs.some((l) => l.q && l.kind === "OPT") ? h("button", { type: "button", class: "small", onclick: () => openRoll(g.legs.filter((l) => l.q), groupTitle(g).split(" · ")[0]) }, "Roll") : null, h("button", { type: "button", class: "small", onclick: () => openExitPlan(g.legs.filter((l) => l.q), groupTitle(g).split(" · ")[0]) }, "Exit group")) : null);
      }),
    );
  }
  /** The name cell: "26600 CE" with the side in its call / put ink (FUT in label ink). */
  const nameNodes = (l) => (l.kind === "FUT" ? [h("span", { class: "pos-k" }, "FUT")] : [h("span", { class: "pos-k" }, formatInt(l.strike)), " ", h("span", { class: l.right === "PE" ? "ink-put pos-r" : "ink-call pos-r" }, l.right)]);
  const sideTag = (el, l) => {
    const c = `side-tag ${l.q > 0 ? "buy" : l.q < 0 ? "sell" : ""}`.trim();
    if (el.className !== c) el.className = c;
    const t = l.q > 0 ? "B" : l.q < 0 ? "S" : "·";
    if (el.textContent !== t) el.textContent = t;
  };
  /** σ gauge state (§4.6): neg for a short in the money, warn for a short under 0.5σ, else quiet. */
  const sigmaState = (l, x) => (!x ? "none" : l.q < 0 && x.itm ? "neg" : l.q < 0 && x.sigma !== null && x.sigma < 0.5 ? "warn" : "ok");
  const sigmaText = (l, x) => (!x ? DASH : l.q < 0 && x.itm ? "ITM" : `${sig1(x.sigma)}σ ${x.dir === "up" ? "↑" : "↓"}`);
  function patchRows(cols) {
    const phone = isPhone();
    const showBars = cfg().bars;
    const showSg = cfg().gauges;
    // One book-wide scale for the P&L bars (bars compare across groups) and one for Δ.
    const vms = new Map(legs.map((l) => [l.symbol, legVm(l)]));
    const Mp = Math.max(1, ...legs.filter((l) => l.q).map((l) => Math.abs(vms.get(l.symbol).u ?? 0)), ...legs.map((l) => Math.abs(num(l.realised) ?? 0)));
    const Md = Math.max(1, ...legs.filter((l) => l.q).map((l) => Math.abs(vms.get(l.symbol).delta ?? 0)));
    const gstats = new Map(groups.map((g) => [g.key, groupStats(g)]));
    const Mg = Math.max(1, ...[...gstats.values()].map((s) => Math.abs(s.pnl)));
    // The biggest |P&L| leg of each group reads in 650 weight (no reordering).
    const top = new Set(groups.map((g) => g.legs.filter((l) => l.q).sort((a, b) => Math.abs(vms.get(b.symbol).u ?? 0) - Math.abs(vms.get(a.symbol).u ?? 0))[0]?.symbol).filter(Boolean));
    bodyEl.classList.toggle("no-bars", !showBars);
    bodyEl.classList.toggle("no-sg", !showSg);
    for (const g of groups) {
      const ref = groupRefs.get(g.key);
      if (!ref) continue;
      const s = gstats.get(g.key);
      const today = g.expiry && O.isExpiryDay(g.expiry);
      setCell(ref.title, `${groupTitle(g)}|${g.structure.name}|${today}`, () => [h("strong", {}, g.expiry ? expiryText(g.expiry) : "All expiries"), g.expiry ? (today ? h("span", { class: "pos-today" }, "Expires today") : h("span", { class: "pos-dte" }, ` · ${O.timeToExpiry(g.expiry).label}`)) : null, ` · ${g.structure.name}`]);
      const pText = rs(s.pnl);
      if (ref.gpnl.textContent !== pText) ref.gpnl.textContent = pText;
      ref.gpnl.className = `pos-gpnl ${tone(s.pnl) ?? ""}`.trim();
      setDiv(ref.gbar, s.pnl, Mg);
      setCell(ref.stats, JSON.stringify([Math.round(s.delta), Math.round(s.theta), s.kept === null ? null : Math.round(s.kept), phone]), () =>
        phone ? [] : [h("span", {}, `Δ ${formatSigned(s.delta, 0)}`), h("span", {}, "Θ ", money(s.theta)), s.kept !== null ? h("span", {}, `kept ${formatPercent(s.kept, 0)}`) : null],
      );
      const rr = g.structure.locked ? null : groupRisk(g);
      const rk0 = rr ? JSON.stringify([Math.round(rr.maxLoss ?? -1e15), Math.round(rr.maxProfit ?? 1e15), rr.breakevens]) : "";
      setCell(ref.riskEl, rk0, () => riskNodes(rr), { hidden: rr ? null : "", title: rr ? `${riskParts(rr).join(" · ")} at ${g.expiry ? expiryText(g.expiry) : "the first expiry"}: included legs, from the model curve` : null });
      const vals = groupCurve(g);
      const gk = vals ? vals.map((v) => Math.round(v)).join() : "";
      if (ref.glyph.el.__sig !== gk) {
        ref.glyph.el.__sig = gk;
        ref.glyph.el.style.visibility = vals ? "" : "hidden";
        if (vals) {
          const p = glyphPath(vals);
          ref.glyph.up.setAttribute("d", p.up);
          ref.glyph.dn.setAttribute("d", p.dn);
          ref.glyph.zero.setAttribute("y1", String(p.zero));
          ref.glyph.zero.setAttribute("y2", String(p.zero));
          const t = `${g.structure.name} · max ${rc(Math.max(...vals))} · min ${rc(Math.min(...vals))} (at expiry, ±2.6σ)`;
          ref.glyph.t.textContent = t;
          ref.glyph.el.setAttribute("aria-label", t);
        }
      }
      if (ref.inc) {
        const stt = groupIncState(g);
        ref.inc.checked = stt !== "off";
        ref.inc.indeterminate = stt === "mixed";
        ref.inc.setAttribute("aria-checked", stt === "mixed" ? "mixed" : String(stt === "on"));
      }
      const lockedText = g.structure.locked && g.lockedValue !== null ? `Locked at expiry: ${rs(g.lockedValue)}` : "";
      setCell(ref.locked, lockedText, () => lockedText, { hidden: lockedText ? null : "" });
    }
    for (const l of legs) {
      const ref = rowRefs.get(l.symbol);
      if (!ref) continue;
      const v = vms.get(l.symbol);
      const ev = refEvent();
      const evKey = ev ? `${ev.kind}|${ev.effectiveOn}` : "";
      if (phone && ref.card) {
        const c = ref.card;
        sideTag(c.tag, l);
        setCell(c.name, `${l.kind}|${l.strike}|${l.right}|${l.priced}|${evKey}`, () => [...nameNodes(l), l.q && !l.priced ? h("span", { class: "pos-wdot", title: "Not priced" }) : null, ev ? eventChip(ev) : null]);
        const lt = l.q ? lotsText(l) : "0";
        if (c.lots.textContent !== lt) c.lots.textContent = lt;
        c.ex.hidden = l.inc || !l.q;
        const pt = v.u === null ? DASH : rs(v.u);
        if (c.pv.textContent !== pt) c.pv.textContent = pt;
        c.pv.className = `pos-cpv ${tone(v.u) ?? ""}${top.has(l.symbol) ? " top" : ""}`.trim();
        setDiv(c.pbar, v.u ?? 0, Mp);
        c.pbar.el.hidden = v.u === null || !l.q;
        const parts = [`${formatFixed(l.avg, 2)} → ${formatFixed(l.mark, 2)}`, v.delta !== null ? `Δ ${formatSigned(v.delta, 0)}` : null, v.theta !== null ? `Θ ${rs(v.theta)}` : null].filter(Boolean).join(" · ");
        if (c.txt.textContent !== parts) c.txt.textContent = parts;
        setSigma(c.sg, v.dist?.sigma ?? null, sigmaState(l, v.dist));
        c.sg.hidden = !v.dist;
        const stext = v.dist ? sigmaText(l, v.dist) : "";
        if (c.sgt.textContent !== stext) c.sgt.textContent = stext;
        c.sgt.dataset.state = sigmaState(l, v.dist);
        ref.el.setAttribute("aria-label", `${legSpeech(l)}, P&L ${v.u === null ? "unknown" : `${v.u < 0 ? "minus" : "plus"} ${formatInt(Math.abs(v.u))} rupees`}${v.dist ? `, ${sigmaText(l, v.dist)} from the forward` : ""}`);
        continue;
      }
      if (ref.inc && ref.inc.checked !== l.inc) ref.inc.checked = l.inc;
      ref.el.classList.toggle("excluded", !l.inc);
      ref.el.classList.toggle("sel", selected.has(l.symbol));
      ref.el.classList.toggle("focus", focusSym === l.symbol);
      ref.el.setAttribute("aria-selected", String(selected.has(l.symbol)));
      const chip = l.q && scopeNow() === "account" ? exitChipText(cachedTriggers(st.account), l.symbol) : null;
      setCell(ref.cells.get("contract"), `${l.q > 0}|${l.q < 0}|${l.product}|${l.expired}|${l.priced}|${evKey}|${chip}`, () => {
        const tag = h("span", {});
        sideTag(tag, l);
        // The leg's open stop and target (Bridge triggers): a tap opens them.
        const chipEl = chip ? h("button", { type: "button", class: "bk-px-chip", title: "Stop and target on the Bridge: exits at market when LTP touches them", onclick: (e) => (e.stopPropagation(), stopsOn(l)) }, chip) : null;
        return h("span", { class: "pos-leg" }, tag, h("span", {}, h("strong", {}, ...nameNodes(l), l.q && !l.priced ? h("span", { class: "pos-wdot", title: `Not priced: ${l.why ?? "no quote"}` }) : null), ev ? eventChip(ev) : null, chipEl, h("small", {}, `${expiryText(l.expiry)} · ${l.expired ? "Expired · settles at close" : PRODUCT[l.product] ?? l.product}`)));
      });
      for (const k of cols) {
        const td = ref.cells.get(k);
        if (k === "pnl") patchPnl(td, l, v, Mp, top.has(l.symbol));
        else if (k === "delta") patchDelta(td, v, Md);
        else if (k === "dist") patchDist(td, l, v);
        else {
          const c = cellFor(k, l, v);
          setCell(td, c.sig, c.build, { title: c.title });
        }
      }
    }
  }
  function patchPnl(td, l, v, M, top) {
    if (!td.__pnl) {
      const val = h("span", { class: "pos-pv" });
      const bar = divBar("pos-pbar");
      const rb = divBar("pos-rbar");
      td.replaceChildren(h("span", { class: "pos-pcell" }, val, h("span", { class: "pos-pbars" }, bar.el, rb.el)));
      td.__pnl = { val, bar, rb };
    }
    const r = td.__pnl;
    const text = v.u === null ? DASH : rs(v.u);
    if (r.val.textContent !== text) r.val.textContent = text;
    const cls = `pos-pv ${tone(v.u) ?? ""}${top ? " top" : ""}`.trim();
    if (r.val.className !== cls) r.val.className = cls;
    setDiv(r.bar, v.u ?? 0, M);
    r.bar.el.hidden = v.u === null;
    const R = num(l.realised) ?? 0;
    setDiv(r.rb, R, M);
    r.rb.el.hidden = !Math.round(R);
    r.rb.el.title = R ? `Realised ${rs(R)} today` : "";
    const t = [brokerNote(l, v.u), R ? `Realised ${rs(R)} today (hatched bar)` : ""].filter(Boolean).join(" · ");
    if (td.title !== t) td.title = t;
  }
  function patchDelta(td, v, M) {
    if (!td.__d) {
      const val = h("span", { class: "pos-dv" });
      const unit = h("small", {});
      const bar = divBar("pos-dbar");
      td.replaceChildren(h("span", { class: "pos-dcell" }, h("span", { class: "pos-dtext" }, val, unit), bar.el));
      td.__d = { val, unit, bar };
      td.title = "Position Δ in units (per-unit Δ below); the bar is on one book-wide scale";
    }
    const r = td.__d;
    const t = v.delta === null ? DASH : formatSigned(v.delta, 0);
    if (r.val.textContent !== t) r.val.textContent = t;
    const u = v.dU === null ? "" : formatFixed(v.dU, 2);
    if (r.unit.textContent !== u) r.unit.textContent = u;
    setDiv(r.bar, v.delta ?? 0, M, "fg");
    r.bar.el.hidden = v.delta === null;
  }
  function patchDist(td, l, v) {
    if (!td.__s) {
      const g = sigmaGauge();
      const t = h("span", { class: "pos-sgt" });
      td.replaceChildren(h("span", { class: "pos-scell" }, g, t));
      td.__s = { g, t };
    }
    const x = v.dist;
    const r = td.__s;
    const state = sigmaState(l, x);
    setSigma(r.g, x?.sigma ?? null, state);
    r.g.hidden = !x;
    const t = sigmaText(l, x);
    if (r.t.textContent !== t) r.t.textContent = t;
    r.t.dataset.state = state;
    const title = x ? `${formatSigned(x.pts, 0)} pts (${formatSigned(x.pct, 2)}%) from the ${expiryText(l.expiry)} forward ${formatInt(l.F)} · ${sig1(x.sigma)}σ on a 0–3σ track${state === "neg" ? " · short is in the money" : state === "warn" ? " · tested: within 0.5σ" : ""}` : "";
    if (td.title !== title) td.title = title;
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
  /** The alert sheet for the whole book (ls null), a group or one leg, with the figures it starts from. */
  function alertOn(ls, scopeText) {
    if (scopeNow() !== "account" || !st.account) return toast("Choose one account to set an alert.", { tone: "info" });
    const held = (ls ?? legs).filter((l) => l.q);
    const known = held.filter((l) => num(l.pnl) !== null);
    openAlertSheet({
      account: st.account,
      accountLabel: account()?.label ?? st.account,
      underlying: st.underlying,
      symbols: ls ? held.map((l) => l.symbol) : null,
      scopeText,
      lot: held.find((l) => l.lot)?.lot ?? null,
      spot,
      pnl: known.length ? known.reduce((a, l) => a + Number(l.pnl), 0) : null,
      delta: ls ? null : (book?.delta ?? null),
    });
  }

  /**
   * Convert a leg between Intraday (MIS) and carry (NRML): POST /v1/positions/convert. Paper moves the quantity at its
   * average price; a live account is told to convert in the broker's app (no adapter maps it yet).
   */
  async function convertLeg(l) {
    const a = account();
    if (a && a.broker !== "paper") return toast("Convert live positions in your broker's app or terminal: the Bridge does not send conversions yet.", { tone: "info" });
    const to = l.product === "INTRADAY" ? "MARGIN" : "INTRADAY";
    const lot = l.lot || 1;
    const whole = Math.floor(Math.abs(l.q) / lot);
    const inLots = lot > 1 && Math.abs(l.q) % lot === 0;
    const qty = h("input", { id: "bk-cv-qty", type: "number", inputmode: "numeric", min: "1", step: "1", max: String(inLots ? whole : Math.abs(l.q)), value: String(inLots ? whole : Math.abs(l.q)) });
    const err = h("p", { class: "bad-text", role: "alert", hidden: true });
    const name = `${st.underlying} ${legName(l)} ${expiryText(l.expiry)}`;
    // The margin effect: the paper engine's model (the one Positions shows) charges Intraday and Carry the same, so the
    // account's blocked margin does not move; brokers that give Intraday leverage charge more for Carry.
    const used = num(d.funds?.usedMargin);
    const marginLine = used !== null ? h("p", { class: "bk-cv-margin" }, "Margin ≈ ", h("strong", { class: "bk-nw" }, formatRupee(used, 0)), " → ", h("strong", { class: "bk-nw" }, formatRupee(used, 0)), h("span", { class: "muted" }, " (this account, paper model: Intraday and Carry are margined alike. A broker that gives Intraday leverage asks more for Carry.)")) : null;
    const ok = await modal({
      title: `Convert ${name} to ${PRODUCT[to]}`,
      body: h(
        "div",
        { class: "stack" },
        h("p", { class: "muted" }, `${l.q > 0 ? "Long" : "Short"} ${inLots ? plural(whole, "lot") : `${formatInt(Math.abs(l.q))} qty`} in ${PRODUCT[l.product]} · avg ${formatFixed(l.avg, 2)}`),
        h("label", { class: "field", for: "bk-cv-qty" }, h("span", {}, inLots ? "Lots to convert" : "Quantity to convert"), qty),
        marginLine,
        h(
          "p",
          { class: "muted small" },
          to === "MARGIN"
            ? "Carry (NRML) is not squared off at 15:20 and needs full margin overnight. No order is sent; the average price stays."
            : "Intraday is squared off at 15:20 today. No order is sent; the average price stays.",
        ),
        err,
      ),
      buttons: [
        { label: "Keep as is", value: false },
        {
          label: "Convert",
          cls: "primary",
          onClick: async () => {
            err.hidden = true;
            const n = Math.max(1, Math.floor(Number(qty.value) || 0));
            try {
              await api("/v1/positions/convert", { method: "POST", body: { account: st.account, symbol: l.symbol, from: l.product, to, ...(inLots ? { lots: n } : { quantity: n }) } });
              return true;
            } catch (e) {
              err.textContent = `Not converted: ${e?.message ?? "refused"}`;
              err.hidden = false;
              return false;
            }
          },
        },
      ],
    });
    if (ok) {
      toast(`Converted ${name} to ${PRODUCT[to]}`);
      tick();
    }
  }

  /** Stop and target on one leg: exits at market on the Bridge (triggers.js). Live accounts send live, if allowed. */
  async function stopsOn(l) {
    if (scopeNow() !== "account" || !st.account) return toast("Choose one account to set a stop and target.", { tone: "info" });
    const a = account();
    const done = await openPositionExits({ account: st.account, accountLabel: a?.label ?? st.account, live: Boolean(a && a.broker !== "paper"), leg: { symbol: l.symbol, q: l.q, lot: l.lot, avg: l.avg, mark: l.mark, product: l.product, tick: instCache.get?.(l.symbol)?.tickSize }, name: `${st.underlying} ${legName(l)} ${expiryText(l.expiry)}` });
    if (done) {
      await openTriggers(st.account, { fresh: true });
      draw();
    }
  }

  function legActions(l) {
    const g = groups.find((x) => x.legs.includes(l));
    // Part exits only when they split into at least one whole lot (a 1-lot leg has "Exit…" alone): never a full
    // exit behind a "25%" label. Each names the lots it sends.
    const whole = Math.floor(Math.abs(l.q) / (l.lot || 1));
    const part = [25, 50, 75].filter((p) => O.canPartExit(l, p)).map((p) => {
      const n = Math.floor((whole * p) / 100 + 1e-9);
      return [`Exit ${p}% · ${plural(n, "lot")}`, () => exitLeg(l.symbol, p), "exit"];
    });
    return [
      ["Exit…", () => exitLeg(l.symbol), "exit"],
      ...part,
      ...(l.q && scopeNow() === "account" && (l.product === "INTRADAY" || l.product === "MARGIN") ? [[l.product === "INTRADAY" ? "Convert to Carry (NRML)…" : "Convert to Intraday…", () => convertLeg(l)]] : []),
      ...(l.q && scopeNow() === "account" ? [[exitChipText(cachedTriggers(st.account), l.symbol) ? "Stop and target (set)…" : "Stop and target…", () => stopsOn(l)]] : []),
      ...(l.q ? [["Alert on this leg…", () => alertOn([l], legWords(l.symbol))]] : []),
      [l.inc ? "Exclude from risk" : "Include in risk", () => toggleInclude([l.symbol], !l.inc)],
      ...(g?.expiry && l.kind === "OPT" ? [["Analyse this expiry", () => analyse(g)]] : []),
      ...(l.kind === "OPT" ? [["Open in chain", () => openInChain(l)]] : []),
      ...(l.kind === "OPT" && l.q
        ? [
            ["Roll to a later expiry…", () => openRoll([l], legName(l))],
            [`Roll strike ${l.q < 0 ? "out" : "in"} 1 step…`, () => openAdjust(l.symbol, l.q < 0 ? "out" : "in")],
            ...(l.q < 0 ? [["Add a wing (cap the risk)…", () => openAdjust(l.symbol, "wing")]] : []),
          ]
        : []),
    ];
  }

  // ── Roll / adjust (positions.md §7.12): a before → after preview, then a pre-filled builder basket. Nothing is sent. ──
  /** Δ, Θ and the sampled first-expiry max loss of a set of priced legs. */
  function bookRead(ls) {
    const inc = ls.filter((x) => x.priced && x.inc !== false && x.q);
    if (!inc.length || !spot) return null;
    const g = O.bookGreeks(inc);
    const first = inc.map((x) => x.expiry).sort()[0];
    const ref = inc.find((x) => x.expiry === first && x.kind === "OPT") ?? inc[0];
    const F = ref.F ?? spot;
    const sd = ((ref.atmIv ?? ref.iv ?? 12) / 100) * Math.sqrt(Math.max(ref.T ?? 0, O.tradingDayYears()));
    const xs = [];
    for (let i = 0; i <= 200; i++) xs.push(F * Math.exp(-4 * sd + (8 * sd * i) / 200));
    for (const x of inc) if (x.kind === "OPT" && x.strike > xs[0] && x.strike < xs[200]) xs.push(x.strike);
    xs.sort((a, c) => a - c);
    const days = O.legDaysToExpiry(ref, Date.now(), refSession(st.ref).close);
    const stt = O.bookCurveStats((x) => O.scenarioPnl(inc, { dS: x / F - 1, days }), xs);
    return { delta: g.delta, theta: g.theta, min: stt?.min ?? null, unlimited: Boolean(stt?.unlimitedDown), first };
  }
  // ── Roll a leg or a group to a later expiry in one sheet (roll-core.js), then send it as one basket ──
  const rollChains = new Map();
  async function rollChain(e) {
    const have = d.chains.get(e)?.chain ?? rollChains.get(e);
    if (have) return have;
    const r = await optional(api(`/v1/optionchain?underlying=${encodeURIComponent(st.underlying)}&expiry=${encodeURIComponent(e)}&strikes=${CHAIN_STRIKES}&greeks=true&ivModel=b76-forward`));
    const c = r.data?.data ?? null;
    if (c) rollChains.set(e, c);
    return c;
  }
  async function openRoll(held, label) {
    const opts = held.filter((l) => l.q && l.kind === "OPT" && l.priced !== false);
    if (!opts.length) return toast("Only option legs can be rolled here", { tone: "info" });
    const from = opts.map((l) => l.expiry).sort().at(-1);
    const later = [...new Set(d.expiries ?? [])].sort().filter((e) => e > from).slice(0, 6);
    if (!later.length) return toast("No later expiry is listed for this underlying", { tone: "info" });
    let mode = "same";
    let toExp = later[0];
    let plan = null;
    let chain = null;
    let rollMarginNow = null;
    const expSel = h("select", { "aria-label": "Roll to expiry" }, ...later.map((e) => h("option", { value: e }, expiryText(e))));
    const modeSeg = segmented("New strikes", ROLL_MODES, mode);
    const table = h("div", { class: "table-wrap roll-legs" });
    const figs = h("div", { class: "ticket-figs roll-figs" });
    const notes = h("p", { class: "muted small roll-note" });
    const okBtn = { label: "Review and send", cls: "primary", value: true };
    const dd = (k, v, sub) => h("div", {}, h("small", {}, k), v, sub ? h("small", { class: "block muted" }, sub) : null);
    async function draw() {
      table.replaceChildren(h("p", { class: "muted" }, `Reading the ${expiryText(toExp)} chain`));
      chain = await rollChain(toExp);
      if (!chain?.rows?.length) {
        table.replaceChildren(h("p", { class: "bad-text" }, `Couldn't load the ${expiryText(toExp)} chain`));
        plan = null;
        return;
      }
      const Fnow = opts.find((l) => isFigure(l.F))?.F ?? spot;
      const Fnext = O.forwardPrice(chain) ?? num(chain.underlyingLtp) ?? Fnow;
      const years = O.yearsToExpiry(toExp, Date.now(), refSession(st.ref).close) ?? null;
      const prefix = String(opts[0].symbol).split(":")[0] || "NFO";
      plan = rollPlan(opts, { mode, toExpiry: toExp, rows: chain.rows, Fnow, Fnext, years, underlying: st.underlying, prefix });
      const money0 = rollMoney(plan, refCharges(st.ref));
      const bes = rollBreakevens(plan, { spot: spot ?? Fnow, charges: money0.charges });
      const priced = included().filter((l) => l.priced);
      const mine = new Set(opts.map((l) => l.symbol));
      const mg = (rollMarginNow = rollMargin(priced.some((l) => mine.has(l.symbol)) ? priced : [...priced, ...opts], plan, { underlying: st.underlying, nowMs: Date.now(), Fnow, Fnext, atmIv: opts.find((l) => isFigure(l.atmIv))?.atmIv ?? null }));
      const px = (v) => (isFigure(v) ? formatFixed(v, 2) : DASH);
      table.replaceChildren(
        h(
          "table",
          { class: "desk-table roll-table" },
          h("thead", {}, h("tr", {}, ["Leg", "Close at", "", "New leg", "Open at"].map((t, i) => h("th", { scope: "col", class: i === 1 || i === 4 ? "num" : undefined }, t)))),
          h(
            "tbody",
            {},
            plan.rolls.map((r) =>
              h(
                "tr",
                {},
                h("td", {}, h("span", { class: `side-tag ${r.leg.q > 0 ? "buy" : "sell"}` }, r.leg.q > 0 ? "B" : "S"), ` ${formatInt(r.lots)} × ${legName(r.leg)} ${expiryText(r.leg.expiry)}`),
                h("td", { class: "num" }, px(r.close.price)),
                h("td", { "aria-hidden": "true" }, "→"),
                h("td", {}, `${formatInt(r.open.strike)} ${r.open.right} ${expiryText(r.open.expiry)}`, r.open.strike !== r.leg.strike ? h("small", { class: "block muted" }, `${r.open.strike > r.leg.strike ? "+" : "−"}${formatInt(Math.abs(r.open.strike - r.leg.strike))} pts`) : null),
                h("td", { class: "num" }, px(r.open.price)),
              ),
            ),
          ),
        ),
      );
      figs.replaceChildren(
        dd(money0.net >= 0 ? "Net credit" : "Net debit", h("strong", { class: money0.net >= 0 ? "up" : "down" }, formatRupee(Math.abs(money0.net), 0)), `${formatInt(plan.rolls.length * 2)} orders at the touch`),
        dd("Charges ≈", h("strong", {}, formatRupee(money0.charges, 0)), `after charges ${rs(money0.netAfter)}`),
        dd("Margin ≈", h("strong", {}, mg ? formatRupee(mg.after, 0) : DASH), mg ? `${rs(mg.change)} vs now` : "no forward"),
        dd("Breakevens", h("strong", {}, bes.length ? bes.map((b) => formatInt(b)).join(" · ") : DASH), `at ${expiryText(toExp)}, counting what the old legs locked in`),
      );
      notes.textContent = [money0.missing ? `${formatInt(money0.missing)} leg${money0.missing === 1 ? " has" : "s have"} no quote on one side.` : "", plan.skipped.length ? `Not rolled: ${plan.skipped.map((x) => `${legName(x.leg)} (${x.why})`).join(", ")}.` : "", "Buys go first (buy back the shorts, buy any new longs), then the sells, so margin stays covered at each step. Paper by default; the order sheet runs the normal checks."].filter(Boolean).join(" ");
    }
    expSel.addEventListener("change", () => ((toExp = expSel.value), draw()));
    modeSeg.addEventListener("change", () => ((mode = modeSeg.value), draw()));
    const body = h("div", { class: "stack roll-sheet" }, h("label", { class: "field" }, h("span", {}, "Roll to"), expSel), segField("New strikes", modeSeg, { wide: true }), table, figs, notes);
    draw();
    const go = await modal({ title: `Roll ${label}`, body, buttons: [{ label: "Cancel", value: false }, okBtn] });
    if (!go || !plan?.rolls.length) return;
    const a = account();
    if (!a) return toast("Pick an account first", { tone: "warn" });
    const items = rollItems(plan, { product: "MARGIN", label: (x) => `${x.close ? "Close " : ""}${formatInt(x.strike)} ${x.right} ${expiryText(x.expiry)}` });
    const m = rollMoney(plan, refCharges(st.ref));
    await openPlacement({
      title: `Roll ${label} to ${expiryText(toExp)} · ${st.underlying}`,
      mode: "entry",
      account: a,
      items,
      summary: { net: m.net, maxLoss: undefined, margin: rollMarginNow?.after ?? null, marginEst: true, free: isFigure(d.funds?.availableCash) && rollMarginNow ? d.funds.availableCash + rollMarginNow.before : null },
      warnings: [],
      cfg: { product: "MARGIN", hedgeWait: 15, order: "buys-first" },
      onPositions: () => tick(),
    });
    tick();
  }
  async function openAdjust(sym, kind) {
    const l = legs.find((x) => x.symbol === sym);
    if (!l || l.kind !== "OPT" || !l.q) return;
    const toExp = kind === "next" ? O.nextExpiry(d.expiries ?? [], l.expiry) : l.expiry;
    if (!toExp) return toast("No later expiry is listed for this underlying", { tone: "info" });
    let chain = d.chains.get(toExp)?.chain ?? null;
    if (!chain) {
      const r = await optional(api(`/v1/optionchain?underlying=${encodeURIComponent(st.underlying)}&expiry=${encodeURIComponent(toExp)}&strikes=${CHAIN_STRIKES}&greeks=true&ivModel=b76-forward`));
      chain = r.data?.data ?? null;
    }
    if (!chain?.rows?.length) return toast(`Couldn't load the ${expiryText(toExp)} chain`, { tone: "error" });
    const side = l.right === "PE" ? "pe" : "ce";
    const strikes = chain.rows.map((r) => r.strike);
    const quoteAt = (k) => chain.rows.find((r) => r.strike === k)?.[side] ?? null;
    let toStrike = l.strike;
    if (kind === "out" || kind === "in") toStrike = O.rollStrike(strikes, l, spot, kind);
    if (kind === "wing") toStrike = O.wingStrike(strikes, { kind: "OPT", strike: l.strike, right: l.right, side: "SELL", price: l.mark }, (k) => O.mid(quoteAt(k)) ?? num(quoteAt(k)?.ltp));
    if (toStrike === null || toStrike === undefined) return toast("No listed strike in that direction", { tone: "info" });
    const q = quoteAt(toStrike);
    const prefix = String(l.symbol).split(":")[0] || "NFO";
    const newSym = q?.symbol ?? `${prefix}:${st.underlying}-${toExp}-${toStrike}-${l.right}`;
    const mk = O.legMark(q).mark;
    const newQty = kind === "wing" ? Math.abs(l.q) : l.q;
    const [nl] = O.priceBook(O.bookLegs([{ symbol: newSym, netQty: newQty, avgPrice: mk ?? 0, product: l.product }], st.underlying), { chains: new Map([[toExp, chain]]), inst: instCache, spot });
    const before = included().filter((x) => x.priced);
    const after = kind === "wing" ? [...before, nl] : [...before.filter((x) => x.symbol !== l.symbol), nl];
    const b0 = bookRead(before);
    const a0 = nl?.priced ? bookRead(after) : null;
    const units = Math.abs(l.q);
    const lotsN = Math.max(1, Math.round(units / (l.lot || 1)));
    const closeLeg = { kind: "OPT", right: l.right, strike: l.strike, expiry: l.expiry, side: l.q > 0 ? "SELL" : "BUY", lots: lotsN, units, lotSize: l.lot, entry: l.mark, entryTag: "manual", product: l.product, symbol: l.symbol };
    const openLeg = { kind: "OPT", right: l.right, strike: toStrike, expiry: toExp, side: kind === "wing" ? "BUY" : l.q > 0 ? "BUY" : "SELL", lots: lotsN, units, lotSize: l.lot, product: l.product, symbol: newSym };
    const basket = kind === "wing" ? [openLeg] : [closeLeg, openLeg];
    const legLine = (x, note) => h("li", {}, h("span", { class: `side-tag ${x.side === "BUY" ? "buy" : "sell"}` }, x.side === "BUY" ? "B" : "S"), h("span", {}, `${x.side === "BUY" ? "Buy" : "Sell"} ${formatInt(x.units)} ${formatInt(x.strike)} `, h("span", { class: x.right === "PE" ? "ink-put" : "ink-call" }, x.right), ` ${expiryText(x.expiry)}`, h("small", { class: "muted" }, ` · ${note}`)));
    const cmp = (label, f, fmt) => [h("span", {}, label), h("strong", {}, b0 ? fmt(f(b0)) : DASH), h("span", { class: "arrow", "aria-hidden": "true" }, "→"), h("strong", {}, a0 ? fmt(f(a0)) : DASH)];
    const lossFmt = (x) => x;
    const lossOf = (r) => (r.unlimited ? "unlimited" : rc(r.min));
    const title = kind === "next" ? `Roll ${legName(l)} to ${expiryText(toExp)}` : kind === "wing" ? `Add a ${formatInt(toStrike)} ${l.right} wing` : `Roll ${legName(l)} to ${formatInt(toStrike)}`;
    const ok = await modal({
      title,
      body: h(
        "div",
        { class: "pos-roll" },
        h("ul", { class: "pos-roll-legs" }, kind === "wing" ? legLine(openLeg, `at ${formatFixed(mk, 2)} · caps the short`) : [legLine(closeLeg, `close at ${formatFixed(l.mark, 2)}`), legLine(openLeg, `open at ${formatFixed(mk, 2)}`)]),
        h("div", { class: "pos-roll-cmp", role: "table", "aria-label": "Before and after" }, ...cmp("Δ", (r) => r.delta, (v) => formatSigned(v, 0)), ...cmp("Θ ₹/trading day", (r) => r.theta, (v) => rs(v)), ...cmp(`Max loss at ${expiryText(b0?.first ?? l.expiry)}`, (r) => lossOf(r), lossFmt)),
        h("p", { class: "muted small" }, "Opens these legs in the Strategy Builder (it replaces the builder's legs). Nothing is sent from Positions; review and place from the builder. Max loss is sampled at the first expiry (≈)."),
      ),
      buttons: [
        { label: "Cancel", value: false },
        { label: "Open in Strategy Builder", cls: "primary", value: true },
      ],
    });
    if (!ok) return;
    st.baskets[st.underlying] = O.migrateLegs(basket, toExp, { lotSize: l.lot });
    st.expiry = basket[0].expiry;
    save();
    location.hash = "#/strategy";
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
    const menu = h("div", { class: "popover pos-menu menu-list", role: "menu" }, legActions(l).map(([label, fn, kind]) => h("button", { type: "button", role: "menuitem", class: `small pos-mi${kind === "exit" ? " exit" : ""}`, onclick: () => (close(), fn()) }, label)));
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
          h("div", { class: "menu-list pos-sheet" }, legActions(l).map(([label, fn, kind]) => h("button", { type: "button", class: `pos-mi${kind === "exit" ? " exit" : ""}`, onclick: () => close(fn) }, label))),
        ),
    });
    if (typeof act === "function") act();
  }
  const openInChain = (l) => goChain(l.expiry, l.strike, l.right === "PE" ? "pe" : "ce");

  /**
   * The account's per-order limits (GET /v1/safety), kept for a minute per account: the exit sheets slice under them
   * exactly as the basket does (basket-core.js). Null when they cannot be read (the freeze alone then applies).
   */
  let limitsMemo = { id: null, at: 0, v: null };
  async function orderLimitsFor(a) {
    if (limitsMemo.id === a.id && Date.now() - limitsMemo.at < 60_000) return limitsMemo.v;
    const r = await optional(api("/v1/safety"));
    const v = orderLimitsOf(r.data?.data, a.id);
    if (r.data) limitsMemo = { id: a.id, at: Date.now(), v };
    return v;
  }

  // ── Single exit (the ticket) ──
  async function exitLeg(sym, pct = 100) {
    const l = legs.find((x) => x.symbol === sym);
    if (!l || !l.q) return;
    const abs = Math.abs(l.q);
    const whole = Math.floor(abs / l.lot);
    const n = Math.floor((whole * pct) / 100 + 1e-9);
    // A part exit that cannot split into a whole lot is not offered (legActions); never widen it to a full exit here.
    if (pct < 100 && n < 1) return toast("This leg cannot be split: exit it in full", { tone: "info" });
    const qty = pct >= 100 ? abs : n * l.lot;
    // Larger than one order may be (freeze, or this account's per-order lots or value limit at the exit price): the
    // ticket sends one order, which the Bridge would refuse, so the exit plan sheet slices it like a basket.
    const a = account();
    if (a) {
      const limits = await orderLimitsFor(a);
      const one = O.exitPlan([{ ...l, quote: legQuote(l.symbol)() ?? l.quote }], { type: cfg().exitType, pct, limits }).orders[0];
      if (one && one.slices.length > 1) return openExitPlan([l], "", { pct });
    }
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

  /** Shift+B / Shift+S on a focused leg: more of its contract with the order defaults (desk.js quickTrade: the ticket,
   *  or sent at once when 1-Tap is on). */
  function tradeLeg(l, side) {
    const o = { row: { strike: l.strike }, right: l.right ?? "CE", kind: l.kind, side, symbol: l.symbol, expiry: l.expiry, quote: legQuote(l.symbol), lotSize: l.lot, tick: l.tick, freezeQty: l.freeze, name: fullName(l) };
    Promise.resolve((quickTrade ?? openTicket)(o)).then((r) => r === "placed" && tick());
  }

  // ── Analyse in the builder ──
  function analyse(g) {
    const opts = g.legs.filter((l) => l.q && l.kind === "OPT");
    if (!opts.length) return toast("No option legs in this group: futures are not in the builder yet", { tone: "info" });
    const exp = g.expiry ?? opts[0].expiry;
    const legsOut = opts
      .filter((l) => l.expiry === exp)
      .map((l) => ({ kind: "OPT", right: l.right, strike: l.strike, expiry: l.expiry, side: l.q > 0 ? "BUY" : "SELL", lots: Math.max(1, Math.ceil(Math.abs(l.q) / l.lot)), units: Math.abs(l.q), lotSize: l.lot, entry: l.avg, entryTag: "avg", product: l.product, symbol: l.symbol }))
      .slice(0, O.MAX_LEGS);
    if (g.legs.some((l) => l.q && l.kind === "FUT")) toast("Futures are not in the builder yet", { tone: "info" });
    else if (opts.some((l) => l.expiry !== exp)) toast("The builder is single-expiry: other expiries are left out", { tone: "warn" });
    st.baskets[`${st.underlying}|${exp}`] = legsOut;
    st.expiry = exp;
    save();
    location.hash = "#/strategy";
  }

  // ── Exit plan (Exit all / group / selected) ──
  /**
   * The legs the desk is about: a held expiry today or the next session opens the desk by itself; otherwise the
   * nearest held expiry is offered folded ("Open the expiry desk"), so it can be read ahead of the day.
   */
  function expiryScope() {
    const open = legs.filter((l) => l.q && l.priced !== false);
    let x = deskExpiry(open, Date.now(), refSession(st.ref).close);
    if (!x && open.length) x = { expiry: [...new Set(open.map((l) => l.expiry))].sort()[0], when: "later" };
    if (!x) return null;
    return { ...x, legs: open.filter((l) => l.expiry === x.expiry) };
  }
  function drawExpiryDesk() {
    const xs = expiryScope();
    xpState = xs;
    // Days away the desk stays out of the way (Needs attention names a near expiry and opens it); on the day and the
    // session before it opens by itself.
    xpPanel.hidden = !xs || (xs.when === "later" && !xpOpen);
    if (xpPanel.hidden) return;
    const shown = xs.when !== "later" || xpOpen;
    xpBody.hidden = !shown;
    xpSquare.hidden = !shown;
    xpToggle.hidden = xs.when !== "later";
    xpToggle.textContent = xpOpen ? "Fold" : "Open the expiry desk";
    xpToggle.setAttribute("aria-expanded", String(xpOpen));
    const chain = d.chains.get(xs.expiry)?.chain ?? null;
    const rows = chain?.rows ?? [];
    const S = spot;
    const mp = rows.length ? O.maxPain(rows) : null;
    const cw = rows.length ? O.oiWall(rows, "ce")?.strike ?? null : null;
    const pw = rows.length ? O.oiWall(rows, "pe")?.strike ?? null : null;
    xpTitle.textContent = ` · ${expiryText(xs.expiry)} ${xs.when === "today" ? "expires today" : xs.when === "next" ? "expires next session" : "is the nearest expiry held"} · ${plural(xs.legs.length, "leg")}`;
    drawXpClock();
    const opts = xs.legs.filter((l) => l.kind === "OPT");
    const gamma = gammaByStrike(opts, S);
    const pins = pinRisk(opts, { spot: S, maxPain: mp, walls: [cw, pw].filter(isFigure) });
    const decay = decayLeft(opts, S);
    const settle = settlementRisk(opts, { spot: S, underlying: st.underlying });
    const gMax = Math.max(1, ...gamma.map((g) => Math.abs(g.pnlPer1pct)));
    const kv = (k, v, sub) => h("div", { class: "xp-fig" }, h("span", { class: "xp-k" }, k), h("span", { class: "xp-v" }, v), sub ? h("span", { class: "xp-s" }, sub) : null);
    const figs = h(
      "div",
      { class: "xp-figs" },
      kv("Time value left", money(decay.total), decay.total >= 0 ? "held short: decays toward you by the close if spot stays" : "held long: decays against you by the close if spot stays"),
      kv("Max pain", mp === null ? DASH : formatInt(mp), isFigure(mp) && S ? `${formatSigned(((mp - S) / S) * 100, 2)}% from spot` : "from this expiry's OI"),
      kv("Call wall / put wall", `${cw === null ? DASH : formatInt(cw)} / ${pw === null ? DASH : formatInt(pw)}`, "largest call and put OI"),
      kv("Spot", formatFixed(S, 2), `close ${refSession(st.ref).close} IST`),
    );
    const gList = gamma.length
      ? h(
          "ul",
          { class: "xp-gamma", "aria-label": "Gamma by strike" },
          ...gamma.map((g) => {
            const bar = h("span", { class: `xp-bar ${g.pnlPer1pct < 0 ? "neg" : "pos"}` });
            bar.style.setProperty("--w", `${Math.round((Math.abs(g.pnlPer1pct) / gMax) * 100)}%`);
            return h("li", {}, h("span", { class: "xp-k" }, formatInt(g.strike), S && Math.abs(g.strike - S) <= S * 0.005 ? h("small", { class: "muted" }, " near spot") : null), h("span", { class: "xp-track" }, bar), h("span", { class: "xp-n", title: "Δ change for a 1 % move, and the P&L from gamma alone over that move" }, `Δ ${formatSigned(g.deltaPer1pct, 0)} · ${rs(g.pnlPer1pct)}`));
          }),
        )
      : h("p", { class: "muted small" }, "No option Greeks for the expiring legs yet.");
    const pinList = pins.length
      ? h(
          "ul",
          { class: "desk-list xp-pins" },
          ...pins.map((p) =>
            h(
              "li",
              {},
              h("strong", {}, `${formatInt(p.strike)} ${p.right}`),
              ` short ${formatInt(Math.abs(p.q))} · ${formatSigned(p.dist, 0)} pts (${formatSigned(p.distPct, 2)}%) from spot`,
              [p.atSpot ? "within 0.5 % of spot" : null, p.atMaxPain ? "at max pain" : null, p.atWall ? "at an OI wall" : null].filter(Boolean).length ? h("span", { class: "warn-text" }, ` · ${[p.atSpot ? "within 0.5 % of spot" : null, p.atMaxPain ? "at max pain" : null, p.atWall ? "at an OI wall" : null].filter(Boolean).join(", ")}`) : null,
            ),
          ),
        )
      : h("p", { class: "muted small" }, "No short option legs in this expiry.");
    const KIND = { physical: "settles by delivery of shares (stock option)", exercise: "in the money: left open, it is exercised and pays STT on the intrinsic value", assigned: "in the money: left open, it is assigned at the settlement price" };
    const setList = settle.length
      ? h("ul", { class: "desk-list xp-settle" }, ...settle.map((r) => h("li", {}, h("strong", {}, `${formatInt(r.strike)} ${r.right}`), ` ${r.q > 0 ? "long" : "short"} ${formatInt(Math.abs(r.q))} · ${KIND[r.kind]}${r.itm ? ` · intrinsic ${rs(r.intrinsic)}` : " · within 1 % of the strike"}`)))
      : h("p", { class: "muted small" }, "No leg is in the money at spot.");
    xpBody.replaceChildren(
      figs,
      h("div", { class: "xp-cols" }, h("section", { class: "xp-col" }, h("h3", {}, "Gamma by strike"), gList), h("section", { class: "xp-col" }, h("h3", {}, "Pin risk"), pinList), h("section", { class: "xp-col" }, h("h3", {}, "Settlement"), setList)),
    );
  }
  function drawXpClock() {
    if (!xpState) return;
    const left = closeMs(xpState.expiry, refSession(st.ref).close) - Date.now();
    xpClock.textContent = xpState.when === "today" ? `${countdownText(left)} to the close` : `${countdownText(left)} to its close`;
  }
  const xpTimer = setInterval(() => xpPanel.isConnected && !xpPanel.hidden && drawXpClock(), 1000);
  function squareOffExpiring() {
    const xs = expiryScope();
    if (!xs?.legs.length) return toast("No expiring legs", { tone: "info" });
    openExitPlan(xs.legs, `${expiryText(xs.expiry)} expiry`);
  }
  async function openExitPlan(scope, label, { pct: pct0 = 100 } = {}) {
    const a = account();
    if (!a) return toast("Choose an account that can place orders first.", { tone: "warn" });
    const syms = scope.filter((l) => l.q).map((l) => l.symbol);
    if (!syms.length) return;
    const current = () => legs.filter((l) => syms.includes(l.symbol) && l.q);
    let type = cfg().exitType;
    let pct = pct0;
    let sending = false;
    // The account's per-order limits: every order is sliced under them and the freeze (basket-core.js perOrderCap,
    // the basket's slicer). Nothing is previewed until they are read, so the first checks describe the real slices.
    let limits = null;
    let limitsReady = false;
    let finished = false;
    const lockedGroups = groups.filter((g) => g.structure.locked && g.legs.some((l) => syms.includes(l.symbol)));
    if (lockedGroups.length && type === "market") type = "mid";
    const typeSeg = segmented("Order type", [["mid", "Limit at mid"], ["touch", "At touch"], ["market", "Market"]], type);
    const sizeSeg = segmented("Size", [100, 75, 50, 25].filter((p) => p !== 75 || pct0 === 75).map((p) => [String(p), `${p}%`]), String(pct0));
    const modeSeg = a.liveAllowedByConfig ? segmented("Mode", [["paper", "Paper"], ["live", "Live"]], "paper") : null;
    const ack = h("input", { type: "checkbox" });
    const ackRow = h("label", { class: "check live-ack", hidden: true }, ack, `I understand these send real orders to ${a.label}.`);
    const mktNote = h("p", { class: "pos-note warn", hidden: true }, "Market orders are sent with protection; illiquid strikes may fill far from mid.");
    const unpricedNote = h("p", { class: "pos-note bad", hidden: true }, "A leg has no bid, ask or LTP, so no limit price can be set. It is never sent at market: exit it from its own ticket, or choose Market.");
    const skipNote = h("p", { class: "pos-note warn", hidden: true, role: "status" });
    const listEl = h("ol", { class: "pos-plan" });
    // Why orders were split: the freeze quantity or this account's per-order limit, once per reason (the basket's text).
    const sliceEl = h("ul", { class: "ticket-checks place-slices", hidden: true, role: "note" });
    const totalsEl = h("div", { class: "ticket-figs pos-plan-tot" });
    // Margin effect: a paper account's own model works it out here; a broker account's figure is the broker's.
    const paperAcct = a.broker === "paper";
    const marginEl = h("p", { class: "muted small pos-plan-margin", title: paperAcct ? SPAN_METHOD : undefined });
    const checksEl = h("ul", { class: "ticket-checks", hidden: true });
    const statusEl = h("div", { class: "pos-plan-status", "aria-live": "polite" });
    let plan = null;
    let checks = [];
    const live = () => modeSeg?.value === "live";
    const draw = () => {
      if (sending || finished) return;
      // 50 % / 25 % only when at least one leg splits into a whole lot; a part exit never sends a full one.
      for (const b of sizeSeg.querySelectorAll("button")) {
        const p = Number(b.dataset.value);
        const can = p >= 100 || current().some((l) => O.canPartExit(l, p));
        b.disabled = !can;
        b.title = can ? "" : "No leg can be split: every leg here is a single lot";
      }
      if (pct < 100 && !current().some((l) => O.canPartExit(l, pct))) {
        pct = 100;
        sizeSeg.value = "100";
      }
      plan = O.exitPlan(current(), { type, pct, limits });
      const nSkip = plan.skipped.length;
      const skipText = nSkip ? `${plural(nSkip, "leg")} skipped: ${nSkip === 1 ? "it cannot" : "they cannot"} be split into whole lots at ${formatInt(pct)}% (${plan.skipped.map((l) => legName(l)).join(", ")})` : "";
      if (skipNote.textContent !== skipText) skipNote.textContent = skipText;
      skipNote.hidden = !nSkip;
      const sig = JSON.stringify(plan.orders.map((o) => [o.symbol, o.side, o.qty, o.slices, o.price, o.unpriced, Math.round(o.slip ?? 0)]));
      // The checks shown (and the Send button) must describe the plan that will be sent: preview it again on change.
      const ps = JSON.stringify([live(), plan.orders.map((o) => [o.symbol, o.side, o.qty, o.slices[0], o.price, o.market])]);
      if (limitsReady && ps !== pvSig) schedulePreview(ps);
      const notes = sliceNotes(plan.orders.filter((o) => o.slicedBy).map((o) => ({ slicedBy: o.slicedBy, slice: 1, lots: o.perLots, label: legName(o.leg) })));
      const nSig = notes.join("|");
      if (sliceEl.__sig !== nSig) {
        sliceEl.__sig = nSig;
        sliceEl.hidden = !notes.length;
        sliceEl.replaceChildren(...notes.map((t) => h("li", { class: "info" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", {}, t))));
      }
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
      const mText = exitMarginText(paperAcct && !live() ? paperMarginEffect(plan.orders) : null, paperAcct && !live(), st.underlying);
      if (marginEl.textContent !== mText) marginEl.textContent = mText;
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
      const p = O.exitPlan(current(), { type, pct, limits });
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
        sendBtn.removeAttribute("aria-busy");
        sendBtn.className = "primary";
        // Nothing left to cancel or change once the orders are out.
        sendBtn.previousElementSibling?.remove();
        for (const b of body.querySelectorAll(".segmented button, input")) b.disabled = true;
        return;
      }
      const blocked = checks.some((x) => x.severity === "block");
      // Sending: the label stays (so the width does) and gives way to a turning ring (BUTTON-SYSTEM.md §9).
      sendBtn.textContent = `Send ${plural(plan?.count ?? 0, "order")}${live() ? " · LIVE" : ""}`;
      sendBtn.className = "primary";
      if (sending) sendBtn.setAttribute("aria-busy", "true");
      else sendBtn.removeAttribute("aria-busy");
      sendBtn.disabled = sending || blocked || pvPending || Boolean(plan?.unpriced) || !plan?.count || (live() && !ack.checked);
      sendBtn.title = plan?.unpriced ? "A leg has no quote to price a limit order: exit it from its own ticket" : pvPending ? (limitsReady ? "Checking with the Bridge…" : "Reading your per-order limits…") : "";
    };
    typeSeg.addEventListener("change", () => ((type = typeSeg.value), draw()));
    sizeSeg.addEventListener("change", () => ((pct = Number(sizeSeg.value)), draw()));
    modeSeg?.addEventListener("change", draw);
    ack.addEventListener("change", drawSend);
    const timer = setInterval(draw, 3000);
    const lockText = lockedGroups.length ? `This group is a locked ${lockedGroups.map((g) => g.structure.name.toLowerCase()).join(", ")}. Exiting leg by leg can break the lock; limit orders at mid are recommended.` : "";
    // Slices go one at a time under the account's order-rate cap (5 a second by default): at least 220 ms apart, and a
    // rate refusal (429, nothing was placed) waits the time the Bridge names and tries the same client order id again.
    let lastSent = 0;
    async function sendPaced(b) {
      for (let tries = 0; ; tries += 1) {
        const gap = 220 - (Date.now() - lastSent);
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
        lastSent = Date.now();
        try {
          return await api("/v1/orders", { method: "POST", body: b });
        } catch (err) {
          if (err.status !== 429 || err.code !== "ORDER_RATE_LIMITED" || tries >= 4) throw err;
          const wait = Number(err.body?.retryAfterMs);
          await new Promise((r) => setTimeout(r, (Number.isFinite(wait) && wait > 0 ? Math.min(wait, 2000) : 1000) + 50));
        }
      }
    }
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
            await sendPaced({ ...orderBody(o, q), clientOrderId: `${batch}-${i}-${j}` });
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
      h("div", { class: "ticket-grid" }, segField("Size", sizeSeg), modeSeg ? segField("Mode", modeSeg) : h("div", { class: "field" }, h("span", {}, "Account"), h("span", { class: "ticket-acct one-line" }, h("span", { class: "acct-name" }, a.label), /paper/i.test(a.label ?? "") ? null : h("span", { class: "acct-badge", "data-mode": "paper" }, "Paper")))),
      ackRow,
      skipNote,
      h("div", { class: "field" }, h("span", {}, "Send order: shorts first (largest Δ), then longs, futures last"), listEl),
      sliceEl,
      totalsEl,
      checksEl,
      statusEl,
      marginEl,
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
          ref: (el) => (sendBtn = el),
          onClick: async () => {
            if (finished) return true;
            await send();
            return false;
          },
        },
      ],
    });
    draw();
    orderLimitsFor(a).then((v) => {
      limits = v;
      limitsReady = true;
      draw();
    });
    await done;
    clearInterval(timer);
    clearTimeout(pvTimer);
    pvSeq += 1;
  }

  // ── Risk: payoff of the book (payoff.js, the Strategy Builder's chart: positions.md §4.8) ──
  const hoverRows = (ids, on) => {
    for (const s of ids) rowRefs.get(s)?.el.classList.toggle("hl", on);
  };
  let markerHover = null;
  // Desktop: the payoff grows until the risk panel reaches the window's foot (a short book left ~130 px of empty page
  // under it at 2560 x 1440); the scenario grid's rows stretch with it. Never below 360 px, never above 820 px.
  const fillHeight = () => {
    const base = typeof innerHeight === "number" ? Math.max(360, Math.min(520, Math.round(innerHeight * 0.36))) : 360;
    const plot = payoffBox.querySelector(".payoff-plot");
    if (!plot?.isConnected || typeof innerHeight !== "number") return base;
    const r = plot.getBoundingClientRect();
    if (!r.height) return base;
    const top = r.top + (window.scrollY || 0);
    const below = Math.max(0, payoffBox.getBoundingClientRect().bottom - r.bottom) + 28;
    return Math.max(base, Math.min(820, Math.floor(innerHeight - top - below)));
  };
  const pay = drawPayoff(payoffBox, {
    heights: [fillHeight, 300, 240],
    onMarker: (id) => {
      if (markerHover) hoverRows([markerHover], false);
      markerHover = id;
      if (id) hoverRows([id], true);
    },
  });
  // The head: an idle read-out (unrealised now at spot, so the hero's net P&L is not mistaken for it) and the curves.
  const idleEl = h("span", { class: "pos-idle" });
  const curvesSeg = segmented("Payoff curves", [["now", "Now"], ["exp", "+Exp"], ["target", "+Target"]], cfg().curves);
  curvesSeg.classList.add("curves-seg");
  curvesSeg.addEventListener("change", () => {
    if (cfg().curves === curvesSeg.value) return;
    setCfg({ curves: curvesSeg.value });
    riskSig = "";
    morphNext = true;
    drawRisk();
  });
  pay.tools.append(idleEl, curvesSeg);
  // Δ across spot (desktop): where the book leaves its delta band as spot moves (§4.9).
  const dsLine = svgEl("path", { class: "ds-line" });
  const dsBand = svgEl("rect", { class: "ds-band" });
  const dsZero = svgEl("line", { class: "ds-zero" });
  const dsDot = svgEl("circle", { class: "ds-dot", r: 3.5 });
  const dsSpot = svgEl("line", { class: "ds-spot" });
  const dsLbl = svgEl("text", { class: "ds-lbl", x: 0, y: 11 });
  const dsSvg = svgEl("svg", { class: "pos-dstrip", role: "img", height: 64 }, dsBand, dsZero, dsSpot, dsLine, dsDot, dsLbl);
  const dsHead = h("div", { class: "pos-dstrip-head" }, h("span", {}, "Δ across spot · now"), h("span", { class: "pos-dstrip-sub" }));
  const dsBox = h("div", { class: "pos-dstrip-box", hidden: true }, dsHead, dsSvg);
  payoffBox.append(dsBox);
  let riskSig = "";
  let morphNext = false;
  let legsSigPrev = null;
  /** Read-outs the book and the scenario share: sampled first-expiry stats, POP. */
  const riskStats = { pop: null, stats: null, wide: null };
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
    const curves = cfg().curves;
    const sig = JSON.stringify([inc.map((l) => [l.symbol, l.q, formatFixed(l.mark, 2), formatFixed(l.iv, 2), formatFixed(l.F, 1)]), sc, formatFixed(S, 1), hedgeLegsPriced().map((l) => [l.symbol, l.q]), cfg().ladder, cfg().axis, cfg().lossLimit, cfg().heatCols, curves, cfg().deltaBand, matMode, isPhone(), isNarrow()]);
    if (sig === riskSig) return;
    riskSig = sig;
    // Morph the payoff when the legs, the included set or the hedge overlay change; ticks and slider drags patch.
    const legsSig = JSON.stringify([inc.map((l) => [l.symbol, l.q]), hedgeLegsPriced().map((l) => l.symbol)]);
    const animate = morphNext || (legsSigPrev !== null && legsSig !== legsSigPrev);
    legsSigPrev = legsSig;
    morphNext = false;
    if (!inc.length || !S) {
      const open = legs.filter((l) => l.q);
      const allOff = open.length && open.every((l) => !l.inc);
      if (allOff) pay.empty({ text: "Include a leg to see its payoff", action: h("button", { type: "button", class: "small", onclick: () => toggleInclude(open.map((l) => l.symbol), true) }, "Include all") });
      else pay.empty({ text: "No priced legs to draw", sub: "The payoff appears when a leg has a price." });
      idleEl.textContent = "";
      dsBox.hidden = true;
      riskStats.pop = null;
      riskStats.stats = null;
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
    // Target: the slider date / IV; with "+Target" and the sliders at zero, half-way to the first expiry.
    const scen = sc.days > 0 || sc.dIv !== 0;
    const tDays = scen ? sc.days : Math.round(fd / 2);
    const hasTarget = curves !== "now" && (scen || (curves === "target" && tDays > 0));
    const fTarget = (x) => O.scenarioPnl(inc, shift(x, { dIv: sc.dIv, days: tDays }));
    const fExp = (x) => O.scenarioPnl(inc, shift(x, { days: fd }));
    const hl = hedgeLegsPriced();
    const fHedge = hl.length ? (x) => O.scenarioPnl([...inc, ...hl], shift(x)) : null;
    const now = xs.map(fNow);
    const target = hasTarget ? xs.map(fTarget) : null;
    const exp = xs.map(fExp);
    const hedge = fHedge ? xs.map(fHedge) : null;
    const showExp = curves !== "now";
    // Stats of the first-expiry curve over F₁·e^(±4σ√T₁): one object drives the payoff's Max / Unlimited pills, the
    // scenario footer and POP, so the chart and the footer never disagree.
    const F1 = near?.F ?? S;
    const iv1 = near?.atmIv ?? near?.iv ?? null;
    const T1 = near?.T ?? 0;
    const s4 = sp ? (4 * sp) / 100 : 0.08;
    const wxs = [];
    for (let i = 0; i <= 240; i++) wxs.push(F1 * Math.exp(-s4 + (2 * s4 * i) / 240));
    for (const k of ks) if (k > wxs[0] && k < wxs[240]) wxs.push(k);
    wxs.sort((a, b) => a - b);
    const wide = O.bookCurveStats((x) => O.scenarioPnl(inc, { dS: x / F1 - 1, days: fd }), wxs);
    riskStats.wide = wide;
    riskStats.pop = wide && T1 > 0 && iv1 ? O.bookPop(wide.profitIntervals, { forward: F1, years: T1, ivPct: iv1 }) : null;
    const yr = O.payoffYRange([now, ...(showExp ? [exp] : []), ...(target ? [target] : [])], { main: showExp ? exp : now, xs });
    const b = (k) => [S * Math.exp((-k * sp) / 100), S * Math.exp((k * sp) / 100)];
    const bes = O.curveRoots(fNow, xs);
    const multi = new Set(inc.map((l) => l.expiry)).size > 1 || inc.some((l) => l.kind === "FUT");
    const markers = inc.map((l) => ({ id: l.symbol, kind: l.kind, right: l.right, strike: l.strike, price: l.kind === "FUT" ? l.avg : null, side: l.q > 0 ? "BUY" : "SELL", title: `${l.q > 0 ? "Long" : "Short"} ${formatInt(Math.abs(lotsOf(l)))} × ${legName(l)} ${expiryText(l.expiry)} @ ${formatFixed(l.avg, 2)}` }));
    const chainKs = [...new Set((d.chains.get(near?.expiry)?.chain?.rows ?? []).map((r) => r.strike))].sort((a, c) => a - c);
    const nowAtS = fNow(S);
    const popText = riskStats.pop === null ? "" : `, POP ${formatPercent(riskStats.pop * 100, 0)} at ${expiryText(near?.expiry)}`;
    const bs = bookStats(inc, wide, S);
    // Drawn first: on desktop the Δ strip under the payoff fills the scenario column's spare height.
    drawScenario({ inc, S, sp, fd, wide, multi, bs });
    pay.update(
      {
        xs,
        lo,
        hi,
        spot: S,
        forward: F1,
        ivPct: iv1,
        horizon: T1,
        now,
        target,
        expiry: exp,
        hedge,
        hideExpiry: !showExp,
        band1: sp ? b(1) : null,
        band2: sp ? b(2) : null,
        breakevens: bes,
        stats: showExp && bs ? { maxProfit: bs.maxProfit, maxLoss: bs.maxLoss, upSide: bs.upSide, downSide: bs.downSide, breakevens: bes, locked: null } : null,
        approx: multi,
        clip: yr.clip,
        yMin: yr.yMin,
        yMax: yr.yMax,
        strikes: ks,
        chainStrikes: chainKs,
        markers,
        here: { x: S, y: nowAtS },
        prob: "below",
        labels: { now: "Now", target: `Target ${tDays ? `+${formatInt(tDays)}d` : ""}${sc.dIv ? ` IV ${formatSigned(sc.dIv, 1)}` : ""}`.trim(), expiry: near ? `At ${expiryText(near.expiry)} expiry` : "At expiry", expiryShort: near ? `At ${expiryText(near.expiry)}` : "At expiry", hedge: "Hedged" },
        ariaLabel: `Book payoff: unrealised now ${rs(nowAtS)} at ${formatInt(S)}; ${bes.length ? `breakevens now ${bes.map((x) => formatInt(x)).join(" and ")}` : "no breakeven in range"}; max loss in range ${rc(Math.min(...now, ...(showExp ? exp : [])))}${popText}`,
      },
      { animate: animate && !reducedMotion() },
    );
    const idle = `Unrealised now ${rs(nowAtS)} at ${formatInt(S)}`;
    if (idleEl.textContent !== idle) idleEl.textContent = idle;
    idleEl.className = `pos-idle ${tone(nowAtS) ?? ""}`.trim();
    drawDeltaStrip(inc, xs, lo, hi, S);
  }
  function drawDeltaStrip(inc, xs, lo, hi, S) {
    const show = !isNarrow() && cfg().gauges !== false;
    dsBox.hidden = !show;
    if (!show) return;
    const W = Math.max(280, Math.round(payoffBox.clientWidth - 24 || 600));
    const H = 64;
    const L = W < 480 ? 46 : 56;
    const R = 12;
    const Lf = futLot();
    const ds = xs.filter((_, i) => i % 2 === 0).map((x) => [x, O.scenarioGreeks(inc, { dS: x / S - 1 }).delta]);
    const B = deltaBand();
    const M = Math.max(B ? 1.4 * B : 1, ...ds.map(([, v]) => Math.abs(v))) * 1.08;
    const X = (p) => L + ((p - lo) / (hi - lo)) * (W - L - R);
    const Y = (v) => 6 + ((M - v) / (2 * M)) * (H - 12);
    dsSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    dsSvg.setAttribute("width", String(W));
    dsLine.setAttribute("d", ds.map(([x, v], i) => `${i ? "L" : "M"}${r1(X(x))},${r1(Y(v))}`).join(""));
    const z = r1(Y(0));
    for (const [k, v] of Object.entries({ x1: L, x2: W - R, y1: z, y2: z })) dsZero.setAttribute(k, String(v));
    if (B) {
      for (const [k, v] of Object.entries({ x: L, width: W - L - R, y: r1(Y(B)), height: r1(Y(-B) - Y(B)) })) dsBand.setAttribute(k, String(v));
      dsBand.removeAttribute("visibility");
    } else dsBand.setAttribute("visibility", "hidden");
    const d0 = O.scenarioGreeks(inc, {}).delta;
    const sx = r1(X(S));
    for (const [k, v] of Object.entries({ x1: sx, x2: sx, y1: 2, y2: H - 2 })) dsSpot.setAttribute(k, String(v));
    dsDot.setAttribute("cx", String(sx));
    dsDot.setAttribute("cy", String(r1(Y(d0))));
    dsLbl.textContent = "";
    const outs = ds.filter(([, v]) => B && Math.abs(v) > B);
    const subt = `${B ? `band ±${formatInt(B)}` : ""}${Lf ? ` · Δ ${formatSigned(d0 / Lf, 1)} lots now` : ""}${outs.length && B ? ` · outside the band ${outs[0][0] < S ? `below ${formatInt(Math.max(...outs.filter(([x]) => x < S).map(([x]) => x), lo))}` : ""}${outs.some(([x]) => x > S) ? ` above ${formatInt(Math.min(...outs.filter(([x]) => x > S).map(([x]) => x)))}` : ""}` : ""}`;
    const subEl = dsHead.lastChild;
    if (subEl.textContent !== subt) subEl.textContent = subt;
    dsSvg.setAttribute("aria-label", `Delta across spot now: ${formatSigned(d0, 0)} at ${formatInt(S)}${subt ? `; ${subt}` : ""}`);
  }

  // ── Risk: scenario (sliders, stress chips, the heatmap on the diverging scale, Greeks across spot) ──
  const wiPanel = createWhatIf({ state: sc, title: "What if", onInput: () => posPanel.isConnected && drawRisk(), onCommit: () => save() });
  const { spotIn, ivIn, daysIn } = wiPanel.parts;
  const stressScen = h("div", { class: "pos-stress scen", role: "group", "aria-label": "P&L now at ±1σ and ±2σ" });
  const matrixEl = h("div", { class: "pos-matrix-wrap" });
  const ring = h("i", { class: "pos-ring", "aria-hidden": "true", hidden: true });
  const legendEl = h("div", { class: "pos-heat-legend" });
  const matrixFoot = h("div", { class: "pos-matrix-foot" });
  let matMode = cfg().axis;
  const axisSeg = segmented("Scenario table", [["iv", "Spot × IV"], ["days", "Spot × days"], ["greeks", "Greeks"]], matMode);
  axisSeg.addEventListener("change", () => setMatMode(axisSeg.value));
  function setMatMode(m) {
    matMode = m;
    if (axisSeg.value !== m) axisSeg.value = m;
    if (m !== "greeks" && cfg().axis !== m) setCfg({ axis: m });
    riskSig = "";
    drawRisk();
  }
  scenBox.append(
    wiPanel.el,
    stressScen,
    h("div", { class: "pos-matrix-head" }, axisSeg),
    matrixEl,
    legendEl,
    matrixFoot,
  );
  function setScenario(p) {
    wiPanel.set(p, true);
  }
  /** The what-if scope: the whole book or one expiry group (only when the book has more than one). */
  const wiGroupOf = (l) => (cfg().group === "none" ? "all" : l.expiry);
  function drawWiScope() {
    const gs = groups.filter((g) => g.legs.some((l) => l.q));
    if (wiScope !== "book" && !gs.some((g) => g.key === wiScope)) wiScope = "book";
    const opts = gs.length > 1 ? [["book", "Whole book"], ...gs.map((g) => [g.key, `${g.expiry ? expiryText(g.expiry) : "All"} · ${g.structure?.name ?? ""}`.trim()])] : null;
    const sig = JSON.stringify([opts, wiScope]);
    if (sig === drawWiScope.sig) return;
    drawWiScope.sig = sig;
    wiPanel.setScopes(opts, wiScope, (v) => {
      wiScope = v;
      riskSig = "";
      drawRisk();
    });
  }
  /** The heatmap's colour scale m: the 95th percentile of |cell| over the visible grid and the stress chips. */
  let heatM = 1;
  const heatScale = () => heatM;
  const heatCols = () => {
    const c = cfg().heatCols;
    if (c === 3 || c === 5) return c;
    if (isNarrow()) return 3;
    // Auto on desktop: 5 columns while each cell keeps ≥ 72 px beside a ≤ 96 px row head, else 3 (1100–1366 px).
    const w = scenBox.clientWidth - 24;
    return w > 0 && (w - 96) / 5 < 72 ? 3 : 5;
  };
  let matrixSig = "";
  let cellRefs = [];
  let gridNow = null;
  function drawScenario(ctx) {
    const S = ctx?.S ?? spot;
    const sp = ctx?.sp ?? sigmaPct();
    const fd = Math.ceil((ctx?.fd ?? firstDays()) - 1e-6);
    wiPanel.setRange({ S, sigma: sp, first: fd, max: maxDays() });
    drawWiScope();
    stressScen.hidden = !isPhone() || !stressRows.length;
    if (!ctx) {
      wiPanel.drawFigures(null, { note: legs.some((l) => l.q) ? "No priced legs to run scenarios on." : "" });
      matrixEl.replaceChildren();
      matrixSig = "";
      legendEl.replaceChildren();
      matrixFoot.replaceChildren();
      return;
    }
    const { inc } = ctx;
    scenBox.classList.toggle("mode-greeks", matMode === "greeks");
    const shift = { dS: sc.pct / 100, dIv: sc.dIv, days: sc.days };
    const scoped = wiScope === "book" ? inc : inc.filter((l) => wiGroupOf(l) === wiScope);
    wiPanel.drawFigures(whatIfFigures(scoped, sc, { underlying: st.underlying, spot: S, nowMs: Date.now(), atmIv: scoped.find((l) => isFigure(l.atmIv))?.atmIv ?? null }), { note: wiScope === "book" ? "Whole book. Margin is approximate (the paper model), not your broker's figure." : "One group. The heatmap below is the whole book." });
    const five = heatCols() === 5;
    const axis = matMode === "greeks" ? cfg().axis : matMode;
    const ivCols = five ? [-10, -5, 0, 5, 10] : [-5, 0, 5];
    const dayCols = five ? [0, 1, 2, 3, fd] : isPhone() ? [0, 3, fd] : [0, 1, 3, fd];
    const grid = O.scenarioGrid(inc, { ladder: cfg().ladder, axis, days: sc.days, dIv: sc.dIv, sigmaPct: sp, F: S, firstDays: fd, ivCols, dayCols });
    gridNow = grid;
    // One colour scale for the grid and the stress chips (so they agree).
    heatM = Math.max(1, O.percentileOf([...grid.rows.flatMap((r) => r.cells.map(Math.abs)), ...stressRows.map((x) => Math.abs(x.v))], 0.95) ?? 1);
    if (matMode === "greeks") drawGreeksTable(inc, grid, S);
    else drawHeatmap(grid, axis);
    drawLegend();
    drawFooter(inc, grid, ctx);
    drawStress();
  }
  const rowLabel = (r) => `${r.k !== null ? `${formatSigned(r.k, 1)}σ ` : ""}${r.pct === 0 ? "0" : formatSigned(r.pct, r.k !== null ? 2 : 0)}%`;
  function drawHeatmap(grid, axis) {
    const shape = JSON.stringify(["heat", cfg().ladder, axis, grid.cols.map((c) => c.label), grid.rows.length, isPhone()]);
    if (matrixSig !== shape) {
      const rebuilt = Boolean(matrixSig);
      matrixSig = shape;
      cellRefs = [];
      const short = isPhone();
      const table = h(
        "table",
        { class: "pos-matrix" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, cfg().ladder === "sigma" ? "Spot (σ)" : "Spot"), grid.cols.map((c) => h("th", { scope: "col", class: "num" }, short || grid.cols.length > 4 ? (axis === "iv" ? (c.dIv === 0 ? "IV now" : c.short) : c.short) : c.label)))),
        h(
          "tbody",
          {},
          grid.rows.map((r, ri) => {
            const th = h("th", { scope: "row" });
            const tds = grid.cols.map((c, ci) => {
              const td = h("td", { class: "num dv-heat", tabindex: "0", onclick: () => pickCell(ri, ci), onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pickCell(ri, ci)) });
              return td;
            });
            cellRefs.push({ th, tds, tr: null });
            const tr = h("tr", { class: r.pct === 0 ? "spot" : "" }, th, tds);
            cellRefs[cellRefs.length - 1].tr = tr;
            return tr;
          }),
        ),
      );
      matrixEl.replaceChildren(table, ring);
      ring.hidden = true;
      ring.classList.add("jump");
      if (rebuilt && !reducedMotion()) [...table.tBodies[0].rows].forEach((tr, i) => tr.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: Math.min(160, i * 15), easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "backwards" }));
    }
    const loss = cfg().lossLimit;
    let best = null;
    grid.rows.forEach((r, ri) => grid.cols.forEach((c, ci) => {
      const dist = Math.abs(r.pct - sc.pct) + (axis === "iv" ? Math.abs(c.dIv - sc.dIv) / 5 : Math.abs(c.days - sc.days) / 3);
      if (!best || dist < best.dist) best = { ri, ci, dist };
    }));
    grid.rows.forEach((r, ri) => {
      const ref = cellRefs[ri];
      const lbl = rowLabel(r);
      setCell(ref.th, `${lbl}|${formatInt(r.price)}`, () => [h("span", {}, lbl), h("small", {}, formatInt(r.price))]);
      r.cells.forEach((v2, ci) => {
        const td = ref.tds[ci];
        const beyond = loss !== null && v2 < -loss;
        const cur = best && best.ri === ri && best.ci === ci;
        heatCell(td, O.divStep(v2, heatM), "div");
        setCell(td, `${Math.round(v2 / 10)}|${beyond}|${cur}`, () => rk(v2), { class: `num dv-heat${beyond ? " beyond" : ""}${cur ? " cur" : ""}`, "aria-current": cur ? "true" : null, "aria-description": beyond ? "beyond your loss limit" : null });
        td.setAttribute("aria-label", `${lbl} ${formatInt(r.price)}, ${grid.cols[ci].label}: ${rs(v2)}`);
      });
    });
    // The current cell's ring: one overlay that slides between cells (transform), never a per-cell outline.
    const cell = best ? cellRefs[best.ri]?.tds[best.ci] : null;
    if (cell) {
      requestAnimationFrame(() => {
        if (!cell.isConnected) return;
        ring.hidden = false;
        ring.style.width = `${cell.offsetWidth}px`;
        ring.style.height = `${cell.offsetHeight}px`;
        ring.style.transform = `translate(${cell.offsetLeft}px, ${cell.offsetTop}px)`;
        if (ring.classList.contains("jump")) requestAnimationFrame(() => ring.classList.remove("jump"));
      });
    } else ring.hidden = true;
  }
  function pickCell(ri, ci) {
    const g = gridNow;
    if (!g) return;
    const r = g.rows[ri];
    const c = g.cols[ci];
    setScenario({ pct: Math.max(-10, Math.min(10, Math.round(r.pct / 0.25) * 0.25)), ...(matMode === "iv" || (matMode === "greeks" && cfg().axis === "iv") ? { dIv: c.dIv } : { days: Math.min(maxDays(), c.days) }) });
    if (r.price) pay.pin(r.price);
  }
  /** Greeks across spot (§4.9): Δ in lots, Γ per 1 %, Θ, ν per spot row at the slider days and IV, with micro-bars. */
  function drawGreeksTable(inc, grid, S) {
    const Lf = futLot() || 1;
    const rows = grid.rows.map((r) => {
      const g = O.scenarioGreeks(inc, { dS: r.pct / 100, dIv: sc.dIv, days: sc.days });
      const px = S * (1 + r.pct / 100);
      return { r, vals: [g.delta / Lf, g.gamma * px * 0.01, g.theta, g.vega] };
    });
    const COLS = [["Δ lots", "fg", (v) => formatSigned(v, 1)], ["Γ /1%", "fg", (v) => formatSigned(v, 0)], ["Θ ₹/td", null, (v) => rc(v)], ["ν ₹/pt", "iv", (v) => rc(v)]];
    const Ms = COLS.map((_, i) => Math.max(1e-9, ...rows.map((x) => Math.abs(x.vals[i]))));
    const shape = JSON.stringify(["greeks", cfg().ladder, grid.rows.length]);
    if (matrixSig !== shape) {
      matrixSig = shape;
      cellRefs = [];
      const table = h(
        "table",
        { class: "pos-matrix pos-gtable" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Spot"), COLS.map(([l]) => h("th", { scope: "col", class: "num" }, l)))),
        h(
          "tbody",
          {},
          rows.map(({ r }) => {
            const th = h("th", { scope: "row" });
            const tds = COLS.map(() => {
              const t = h("span", { class: "gv" });
              const bar = divBar("pos-mbar-s");
              const td = h("td", { class: "num" }, h("span", { class: "pos-gcell" }, t, bar.el));
              td.__g = { t, bar };
              return td;
            });
            const tr = h("tr", { class: r.pct === 0 ? "spot" : "" }, th, tds);
            cellRefs.push({ th, tds, tr });
            return tr;
          }),
        ),
      );
      matrixEl.replaceChildren(table);
      barsEnter(table);
    }
    rows.forEach(({ r, vals }, ri) => {
      const ref = cellRefs[ri];
      const lbl = rowLabel(r);
      setCell(ref.th, `${lbl}|${formatInt(r.price)}`, () => [h("span", {}, lbl), h("small", {}, formatInt(r.price))]);
      vals.forEach((v, ci) => {
        const { t, bar } = ref.tds[ci].__g;
        const text = COLS[ci][2](v);
        if (t.textContent !== text) t.textContent = text;
        t.className = `gv ${ci === 2 ? tone(v) ?? "" : ""}`.trim();
        setDiv(bar, v, Ms[ci], COLS[ci][1] ?? toneOf(v));
      });
    });
  }
  function drawLegend() {
    const m = heatM;
    const loss = cfg().lossLimit;
    const sig = matMode === "greeks" ? "greeks" : `${Math.round(m)}|${loss}`;
    if (legendEl.__sig === sig) return;
    legendEl.__sig = sig;
    if (matMode === "greeks") {
      legendEl.replaceChildren(h("span", { class: "pos-legend-t" }, `At ${sc.days ? `+${formatInt(sc.days)}d` : "today"}${sc.dIv ? `, IV ${formatSigned(sc.dIv, 1)}` : ""} · bars per column, spot row marked`));
      return;
    }
    const sw = [-3, -2, -1, 0, 1, 2, 3].map((k) => {
      const i = h("i", { class: "sw" });
      heatCell(i, k, "div");
      return i;
    });
    legendEl.replaceChildren(
      h("span", { class: "pos-legend-t" }, "Unrealised P&L"),
      h("span", { class: "pos-legend-scale" }, h("span", { class: "end" }, rk(-m)), h("span", { class: "sws", "aria-hidden": "true" }, sw), h("span", { class: "end" }, rk(m))),
      ...(loss ? [h("span", { class: "pos-legend-loss" }, h("i", { class: "hatch", "aria-hidden": "true" }), `beyond \u2212${ru(loss)} limit`)] : []),
    );
    legendEl.setAttribute("aria-label", `Colour scale from ${rc(-m)} to ${rc(m)}`);
  }
  /**
   * Max profit / loss at the first expiry, and which edge an unlimited one runs off: exact (strategyStats) for a
   * single-expiry options book, else sampled over ±4σ (bookCurveStats). Null maxProfit / maxLoss = unlimited.
   */
  function bookStats(inc, wide, S) {
    const single = new Set(inc.map((l) => l.expiry)).size === 1 && inc.every((l) => l.kind === "OPT");
    if (single) {
      const asStrat = inc.map((l) => ({ kind: "OPT", right: l.right, strike: l.strike, side: l.q > 0 ? "BUY" : "SELL", lots: 1, lotSize: Math.abs(l.q), price: l.avg }));
      const st0 = O.strategyStats(asStrat, 1, { spot: S });
      // One expiry of options: only net calls are open-ended, and they run off the right edge.
      return { exact: true, maxProfit: st0.maxProfit, maxLoss: st0.maxLoss, upSide: st0.maxProfit === null ? "right" : null, downSide: st0.maxLoss === null ? "right" : null };
    }
    if (!wide) return null;
    return {
      exact: false,
      maxProfit: wide.unlimitedUp ? null : wide.max,
      maxProfitAt: wide.maxAt,
      maxLoss: wide.unlimitedDown ? null : wide.min,
      maxLossAt: wide.minAt,
      lowEdge: wide.minAt <= wide.xs[0] + 1e-9,
      upSide: wide.upSide,
      downSide: wide.downSide,
    };
  }
  const unlimitedText = (side, up) => (up ? (side === "left" ? "↖ Unlimited" : "Unlimited ↗") : side === "left" ? "↙ Unlimited" : "Unlimited ↘");
  function drawFooter(inc, grid, ctx) {
    const w = grid.worst;
    const near = nearest();
    const at = near ? expiryText(near.expiry) : "expiry";
    const s = ctx.bs;
    const sideWord = (side) => (side === "left" ? " (below the range)" : side === "right" ? " (above the range)" : "");
    const mp = !s ? h("strong", {}, DASH) : s.maxProfit === null ? h("strong", { class: "up", title: `Profit keeps growing${sideWord(s.upSide)}` }, unlimitedText(s.upSide, true)) : s.exact ? h("strong", { class: tone(s.maxProfit) }, rc(s.maxProfit)) : h("strong", { class: tone(s.maxProfit), title: "Sampled over ±4σ of the first expiry" }, `≈ ${rc(s.maxProfit)} at ${formatInt(s.maxProfitAt)}`);
    const ml = !s ? h("strong", {}, DASH) : s.maxLoss === null ? h("strong", { class: "down", title: `Loss keeps growing${sideWord(s.downSide)}` }, unlimitedText(s.downSide, false)) : s.exact ? h("strong", { class: tone(s.maxLoss) }, rc(s.maxLoss)) : h("strong", { class: tone(s.maxLoss), title: "Sampled over ±4σ of the first expiry; later-expiry legs valued by the model" }, `≈ ${rc(s.maxLoss)} ${s.lowEdge ? "below" : "at"} ${formatInt(s.maxLossAt)} (sampled)`);
    matrixFoot.replaceChildren(
      // The grid's worst cell only under the P&L grid (the Greeks view does not show it).
      ...(matMode === "greeks" ? [] : [h("div", {}, h("span", {}, "Max loss in grid"), w ? h("strong", { class: tone(w.v) }, `${rc(w.v)} at ${formatSigned(grid.rows[w.r].pct, 1)}%, ${grid.cols[w.c].label}`) : DASH)]),
      h("div", {}, h("span", {}, `Max profit at ${at}`), mp),
      h("div", {}, h("span", {}, `Max loss at ${at}`), ml),
    );
  }
  function openGreeksTab() {
    riskTab = isNarrow() ? "scenario" : riskTab;
    if (isNarrow()) riskSeg.value = "greeks";
    setMatMode("greeks");
    riskPanel.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }
  riskSeg.addEventListener("change", () => {
    const v = riskSeg.value;
    riskTab = v === "payoff" ? "payoff" : "scenario";
    riskBody.className = `pos-risk tab-${riskTab}`;
    if (v === "greeks" && matMode !== "greeks") return setMatMode("greeks");
    if (v === "scenario" && matMode === "greeks") return setMatMode(cfg().axis);
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
  /** "Add hedge" on a group: open the hedge helper (nothing is sent from it without a confirmed ticket). */
  function openHedge() {
    if (hedgePanel.hidden) return;
    if (!hd.open) setHedgeOpen(true);
    hedgePanel.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    targetIn.focus({ preventScroll: true });
  }
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
      if (l.kind === "FUT") return { symbol: l.symbol, kind: "FUT", expiry: l.expiry, t0: Date.now(), q, avg: l.mark, mark: l.mark, F: l.mark, T: O.yearsToExpiry(l.expiry, Date.now(), refSession(st.ref).close) ?? 0, priced: num(l.mark) !== null, inc: true };
      const o = l.right === "CE" ? atm?.ce : atm?.pe;
      const F = (atm?.chain ? O.forwardPrice(atm.chain, O.parityGrowth(O.calendarYearsToExpiry(l.expiry, Date.now(), refSession(st.ref).close), refRate(st.ref).value)) : null) ?? spot;
      return { symbol: l.symbol, kind: "OPT", expiry: l.expiry, t0: Date.now(), right: l.right, strike: l.strike, q, avg: l.mark, mark: l.mark, iv: num(o?.iv), F, T: O.yearsToExpiry(l.expiry, Date.now(), refSession(st.ref).close) ?? 0, priced: num(l.mark) !== null && num(o?.iv) !== null, inc: true };
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
      ["Θ ₹/trading day", (g) => rs(g.theta)],
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
        h("p", { class: "muted small" }, [...plan.notes, early ? `Hedge expires ${expiryText(early.expiry)}, before your ${expiryText(lastExp)} exposure` : null, hedgeMarginText(lg)].filter(Boolean).join(" · ")),
      );
    }
    previewHedge();
  }
  /** The hedge's margin effect: a paper account's model works it out; a broker account's figure is the broker's. */
  function hedgeMarginText(lg) {
    if (account()?.broker !== "paper" || !lg.length) return "Margin effect: shown by your broker on the order";
    const e = paperMarginEffect(lg.map((l) => ({ leg: { kind: l.kind, right: l.right ?? null, strike: l.strike ?? null, expiry: l.expiry, avg: l.mark, mark: l.mark }, side: l.side, qty: l.units })));
    if (!e) return "Margin effect: not worked out (no price for the forward yet)";
    return Math.abs(e.change) < 1 ? "Margin unchanged (paper margin model)" : `Margin ${e.change < 0 ? "released" : "added"} ≈ ${marginText(e.change)} (paper margin model)`;
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
      warnEl.__sig = "";
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
      const bandIn = h("input", { type: "number", min: "0", step: "1", inputmode: "numeric", placeholder: `${formatInt(futLot() ?? 0)} (1 lot)`, value: c.deltaBand ?? "", "aria-label": "Delta band in units" });
      bandIn.addEventListener("change", () => apply({ deltaBand: bandIn.value === "" ? null : Number(bandIn.value) }));
      body.replaceChildren(
        h("section", {}, h("h3", {}, "Columns ", h("small", {}, "in table order")), h("div", { class: "col-list" }, enabled.map((k) => colRow(k, true)), others.map((k) => colRow(k, false)))),
        h("section", {}, h("h3", {}, "Legs"), segField("Group by", seg("Group by", [["expiry", "Expiry"], ["none", "None"]], c.group, (v) => apply({ group: v }))), sw("Show today's closed legs", c.closed, (v) => apply({ closed: v }), "Muted, for realised P&L")),
        h("section", {}, h("h3", {}, "Risk"), h("label", { class: "field" }, h("span", {}, "Delta band ± (units; blank = one futures lot)"), bandIn), segField("Payoff curves", seg("Payoff curves", [["now", "Now"], ["exp", "+Exp"], ["target", "+Target"]], c.curves, (v) => ((curvesSeg.value = v), apply({ curves: v })))), sw("Show P&L bars", c.bars, (v) => apply({ bars: v }), "Diverging bars by leg, group and book"), sw("Show σ gauges", c.gauges, (v) => apply({ gauges: v }), "Distance to strike on a 0–3σ track; Δ across spot")),
        h("section", {}, h("h3", {}, "Scenario"), segField("Spot ladder", seg("Spot ladder", [["tight", "±5%"], ["wide", "±10%"], ["sigma", "±2σ"]], c.ladder, (v) => apply({ ladder: v }))), segField("Columns", seg("Matrix columns", [["iv", "IV"], ["days", "Days"]], c.axis, (v) => (matMode !== "greeks" && (matMode = v), (axisSeg.value = matMode), apply({ axis: v })))), segField("Heatmap columns", seg("Heatmap columns", [["auto", "Auto"], ["3", "3"], ["5", "5"]], String(c.heatCols), (v) => apply({ heatCols: v === "auto" ? "auto" : Number(v) }))), h("label", { class: "field" }, h("span", {}, "Loss limit ₹ (cells beyond it are hatched)"), lossIn)),
        h("section", {}, h("h3", {}, "Exit"), segField("Default price", seg("Default exit price", [["mid", "Mid"], ["touch", "Touch"], ["market", "Market"]], c.exitType, (v) => apply({ exitType: v })))),
        h("section", {}, h("h3", {}, "Panels"), sw("Day chart", c.chartSlot, (v) => apply({ chartSlot: v }), "Spot through the day with your strikes, and the book's P&L")),
      );
    };
    const pop = h(
      "div",
      { class: "popover customise", role: "dialog", "aria-label": "Customise positions" },
      h("div", { class: "pop-head" }, h("strong", {}, "Customise"), h("button", { type: "button", class: "small plain reset", onclick: () => { const ex = cfg().excluded; st.pos = O.positionsConfig({ excluded: ex }); matMode = st.pos.axis; axisSeg.value = matMode; curvesSeg.value = st.pos.curves; apply({}); } }, icon("refresh"), "Reset"), h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close", onclick: () => close() }, icon("close"))),
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
    // Day view: the same panel shows today's figures instead of the book's legs.
    bodyEl.hidden = dayMode;
    bulkEl.hidden = dayMode || bulkEl.hidden;
    dayEl.hidden = !dayMode;
    if (dayMode) drawDay();
    hedgePanel.hidden = !has || dayMode;
    if (has) drawHedge();
    if (dayMode) hedgePanel.hidden = true;
    drawRisk();
    drawExpiryDesk();
    // POP comes from the risk pass: only the Greeks footer depends on it (the book is not drawn twice).
    if (legs.length) drawGreeksFoot();
    slotPanel.hidden = !cfg().chartSlot || !has;
    drawDayChart();
    bookPanel.hidden = !account();
    onClock();
  }

  // ── Keyboard ──
  /** "?": the app's shortcuts sheet, opened on Positions (shortcuts-core.js lists POSITION_KEYS). */
  function showKeys() {
    import("./palette.js").then((m) => m.showShortcuts({ group: "Positions" }));
  }
  function onKey(e) {
    const k = e.key;
    if (scopeNow() !== "account") return k === "r" ? (bookView.refresh(), true) : false;
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
    if (k === "x") return f ? exitLeg(f.symbol) : toast("Focus a leg first (J / K)", { tone: "info" }), true;
    if (e.shiftKey && /^[bs]$/i.test(k)) return f ? tradeLeg(f, k.toLowerCase() === "b" ? "BUY" : "SELL") : toast("Focus a leg first (J / K)", { tone: "info" }), true;
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
    if (k === "g") {
      if (riskPanel.hidden) return false;
      const order = ["payoff", "scenario", "greeks"];
      let next;
      if (isNarrow()) {
        next = order[(order.indexOf(riskSeg.value) + 1) % 3];
        riskSeg.value = next;
      } else {
        // Desktop shows the payoff and the scenario side by side: G flips the scenario table to Greeks and back.
        next = matMode === "greeks" ? "scenario" : "greeks";
        setMatMode(next === "greeks" ? "greeks" : cfg().axis);
      }
      toast(`Risk view: ${next === "payoff" ? "Payoff" : next === "scenario" ? "Scenario" : "Greeks across spot"}`);
      return true;
    }
    if (k === "c") {
      if (riskPanel.hidden) return false;
      const order = ["now", "exp", "target"];
      curvesSeg.value = order[(order.indexOf(cfg().curves) + 1) % 3];
      toast(`Payoff curves: ${curvesSeg.value === "now" ? "Now" : curvesSeg.value === "exp" ? "Now + expiry" : "Now + expiry + target"}`);
      return true;
    }
    if (k === "b") {
      const g = gauges.get("delta");
      if (!g || bookGrid.hidden) return false;
      g.el.focus();
      warnLive.textContent = g.el.getAttribute("aria-label") + (deltaBand() ? `. Band ±${formatInt(deltaBand())}` : "");
      return true;
    }
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
  const mqs = ["(max-width: 719px)", "(max-width: 1023px)"].map(media);
  const onDevice = () => {
    if (!posPanel.isConnected) return;
    bookView.redraw();
    layoutSig = "";
    riskSig = "";
    warnEl.__sig = "";
    draw();
  };
  for (const m of mqs) m.addEventListener("change", onDevice);
  const onResize = () => {
    if (!posPanel.isConnected) return;
    fitTable();
    riskSig = "";
    drawRisk();
  };
  window.addEventListener("resize", onResize);
  applyScope();

  return {
    panels: [scopeBar, bookView.el, bookPanel, xpPanel, posPanel, riskPanel, slotPanel],
    root,
    tick,
    /** Spot and the index quote, for the top bar. */
    spot: () => ({ spot, quote: d.quotes.get(INDEX_SYMBOL[st.underlying]) ?? null }),
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
    /** A new reference bundle (rate, session close, charges, events): reprice and redraw. */
    refChanged() {
      layoutSig = "";
      riskSig = "";
      draw();
    },
    destroy() {
      delete document.documentElement.dataset.posScope;
      closeMenu?.(false);
      for (const m of mqs) m.removeEventListener("change", onDevice);
      window.removeEventListener("resize", onResize);
      clearTimeout(hvTimer);
      clearInterval(xpTimer);
      clearTimeout(compTimer);
      clearTimeout(attnTimer);
      // The payoff's document listener, ResizeObserver and any morph frame must not outlive the page.
      pay.destroy();
    },
    /** The futures lot (the top bar's ⋯ sheet shows it: there is no chain expiry on this page). */
    lot: () => futLot(),
  };
}
