// Order defaults and 1-Tap: the pure rules (no DOM, tested in one-tap-core.test.mjs). one-tap.js keeps the state,
// the toolbar capsule and the sheets; desk.js sends through POST /v1/orders/preview and /v1/orders, as the ticket does.
//
// 1-Tap is a convenience for paper first: it is OFF on every page load, it turns itself off after 30 minutes without
// a key press or a click, it sends only to the account it was switched on for, and it sends `mode: "live"` only when
// that account allows live orders AND the person chose Live (and ticked the acknowledgement) when switching it on.
// The Bridge still decides: the kill switch, limits, readiness and the live opt-ins refuse an order exactly as they
// refuse one from the ticket, because it is the same request.

/** options.js roundToTick, kept here so this module imports nothing (buy rounds up, sell down, to the tick). */
function roundToTick(price, tick, direction) {
  const steps = price / tick;
  const n = direction === "buy" ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
  return Math.round(n * tick * 100) / 100;
}

/** localStorage key for the order defaults (this browser only). */
export const DEFAULTS_SLOT = "mcb.dashboard.orderDefaults";
/** 1-Tap turns itself off after this long without a key press or a click. */
export const ONE_TAP_IDLE_MS = 30 * 60_000;
/** Bounds the defaults sheet accepts. */
export const MAX_DEFAULT_LOTS = 50;
export const MAX_OFFSET_TICKS = 20;
export const PRODUCTS = Object.freeze([
  ["INTRADAY", "Intraday"],
  ["MARGIN", "Normal"],
]);
export const ORDER_TYPES = Object.freeze([
  ["LIMIT", "Limit"],
  ["MARKET", "Market"],
]);
export const VALIDITIES = Object.freeze([
  ["DAY", "Day"],
  ["IOC", "IOC"],
]);
/** What a fresh browser starts with: one lot, intraday, a limit at the touch, Day, the page's own account. */
export const BASE_DEFAULTS = Object.freeze({ product: "INTRADAY", lots: Object.freeze({}), anyLots: 1, orderType: "LIMIT", offsetTicks: 0, validity: "DAY", account: "" });
/** Order statuses that can still be cancelled (the toast's Cancel). */
const WORKING = new Set(["pending", "open", "trigger_pending", "partially_filled"]);

const intIn = (v, lo, hi) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};
const pick = (v, list) => (list.some(([k]) => k === v) ? v : null);
const UNDERLYING = /^[A-Z0-9&-]{1,20}$/;

/**
 * Validate stored or typed defaults. Every field falls back to BASE_DEFAULTS on its own, so one bad field never
 * loses the rest. Returns { defaults, problems: [{ field, message }] } (problems list what was replaced).
 */
export function normalizeDefaults(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const problems = [];
  const note = (field, message) => problems.push({ field, message });
  const product = pick(src.product, PRODUCTS);
  if (src.product !== undefined && !product) note("product", "Product must be Intraday or Normal");
  const orderType = pick(src.orderType, ORDER_TYPES);
  if (src.orderType !== undefined && !orderType) note("orderType", "Order type must be Limit or Market");
  const validity = pick(src.validity, VALIDITIES);
  if (src.validity !== undefined && !validity) note("validity", "Validity must be Day or IOC");
  const offsetTicks = intIn(src.offsetTicks, -MAX_OFFSET_TICKS, MAX_OFFSET_TICKS);
  if (src.offsetTicks !== undefined && offsetTicks === null) note("offsetTicks", `Limit offset must be a whole number of ticks from −${MAX_OFFSET_TICKS} to ${MAX_OFFSET_TICKS}`);
  const anyLots = intIn(src.anyLots, 1, MAX_DEFAULT_LOTS);
  if (src.anyLots !== undefined && anyLots === null) note("anyLots", `Lots must be a whole number from 1 to ${MAX_DEFAULT_LOTS}`);
  const lots = {};
  if (src.lots && typeof src.lots === "object" && !Array.isArray(src.lots)) {
    for (const [u, v] of Object.entries(src.lots)) {
      const n = intIn(v, 1, MAX_DEFAULT_LOTS);
      if (UNDERLYING.test(u) && n !== null) lots[u] = n;
      else note(`lots.${u}`, `Lots for ${u} must be a whole number from 1 to ${MAX_DEFAULT_LOTS}`);
    }
  }
  const account = typeof src.account === "string" && /^[\w.:-]{0,64}$/.test(src.account) ? src.account : "";
  if (src.account !== undefined && account !== src.account) note("account", "Unknown account");
  return {
    defaults: {
      product: product ?? BASE_DEFAULTS.product,
      lots,
      anyLots: anyLots ?? BASE_DEFAULTS.anyLots,
      orderType: orderType ?? BASE_DEFAULTS.orderType,
      offsetTicks: offsetTicks ?? BASE_DEFAULTS.offsetTicks,
      validity: validity ?? BASE_DEFAULTS.validity,
      account,
    },
    problems,
  };
}

/** Parse the stored JSON (or anything else) into valid defaults; never throws. */
export function readDefaults(text) {
  try {
    return normalizeDefaults(JSON.parse(text ?? "null")).defaults;
  } catch {
    return normalizeDefaults(null).defaults;
  }
}

/** Default lots for an underlying ("NIFTY"), else the any-underlying default. */
export function lotsFor(defaults, underlying) {
  const u = String(underlying ?? "").toUpperCase();
  return defaults?.lots?.[u] ?? defaults?.anyLots ?? 1;
}

/**
 * The default limit price: the touch (ask to buy, bid to sell) moved `offsetTicks` toward a fill (positive pays up
 * to buy and gives down to sell; negative waits inside the spread), on the tick grid. Null without a touch: a
 * missing quote is never filled in from the last trade here.
 */
export function offsetLimit({ side, bid, ask, tick = 0.05, offsetTicks = 0 }) {
  const t = Number(tick) > 0 ? Number(tick) : 0.05;
  const buy = side === "BUY";
  const touch = Number(buy ? ask : bid);
  if (!Number.isFinite(touch) || touch <= 0) return null;
  const n = Number.isInteger(offsetTicks) ? offsetTicks : 0;
  const px = roundToTick(touch + (buy ? n : -n) * t, t, buy ? "buy" : "sell");
  return px !== null && px >= t ? px : t;
}

/** A plain-words line for the defaults ("Intraday · Limit at the touch +2 ticks · Day"). */
export function defaultsSummary(d) {
  const off = d.offsetTicks === 0 ? "at the touch" : `${d.offsetTicks > 0 ? "+" : "−"}${Math.abs(d.offsetTicks)} tick${Math.abs(d.offsetTicks) === 1 ? "" : "s"} from the touch`;
  const type = d.orderType === "MARKET" ? "Market" : `Limit ${off}`;
  return `${d.product === "MARGIN" ? "Normal" : "Intraday"} · ${type} · ${d.validity === "IOC" ? "IOC" : "Day"}`;
}

// ── 1-Tap state ──

/** Whether an account may be switched on for live 1-Tap orders (the same opt-in the ticket's Live switch needs). */
export const liveCapable = (a) => Boolean(a && a.broker !== "paper" && a.liveAllowedByConfig);

/**
 * Switch 1-Tap on. `mode` "live" is accepted only for a live-capable account with `ack` true (the person ticked
 * "each tap sends a real order"); anything else is refused, never quietly turned into paper.
 * @returns {{ ok: true, state: object } | { ok: false, reason: string }}
 */
export function armOneTap({ account, mode = "paper", ack = false, nowMs }) {
  if (!account?.id) return { ok: false, reason: "Choose an account that can place orders." };
  if (account.enabled === false || !(account.broker === "paper" || (account.capabilities ?? []).includes("placeOrder"))) return { ok: false, reason: `${account.label ?? account.id} cannot place orders from this dashboard.` };
  if (mode === "live") {
    if (!liveCapable(account)) return { ok: false, reason: `${account.label ?? account.id} does not allow live orders (live trading is off for it in the config file).` };
    if (!ack) return { ok: false, reason: "Tick the box to confirm that each tap sends a real order." };
  } else if (mode !== "paper") return { ok: false, reason: "Mode must be paper or live." };
  return { ok: true, state: { on: true, accountId: account.id, accountLabel: account.label ?? account.id, mode, armedAt: nowMs, lastActive: nowMs } };
}

/** The state after a key press or a click (keeps it alive). */
export const touchOneTap = (state, nowMs) => (state?.on ? { ...state, lastActive: Math.max(state.lastActive ?? 0, nowMs) } : state);

/** True once 1-Tap has gone ONE_TAP_IDLE_MS without activity (it must then be switched off). */
export function oneTapExpired(state, nowMs, idleMs = ONE_TAP_IDLE_MS) {
  if (!state?.on) return false;
  return !(Number.isFinite(state.lastActive) && nowMs - state.lastActive < idleMs);
}

/** Minutes left before the idle switch-off (rounded up; 0 when expired or off). */
export function oneTapMinutesLeft(state, nowMs, idleMs = ONE_TAP_IDLE_MS) {
  if (!state?.on || oneTapExpired(state, nowMs, idleMs)) return 0;
  return Math.ceil((idleMs - (nowMs - state.lastActive)) / 60_000);
}

/**
 * May this action be sent at once, without the ticket? Checked before every send; the Bridge's own checks (the
 * preview) come after this. `accounts` is GET /v1/accounts' list now (so a disabled or removed account stops it).
 * Returns { ok: true } or { ok: false, code, reason, ticket } (ticket: true when the person should see the ticket
 * instead, e.g. the lot size needs a check).
 */
export function oneTapEligibility({ state, nowMs, accounts = [], exit = false, orderable = true, lotCheckNeeded = false, quote = null, defaults, side }) {
  if (!state?.on) return { ok: false, code: "OFF", reason: "1-Tap is off.", ticket: true };
  if (oneTapExpired(state, nowMs)) return { ok: false, code: "EXPIRED", reason: "1-Tap turned itself off after 30 minutes idle.", ticket: true };
  const a = accounts.find((x) => x.id === state.accountId);
  if (!a || a.enabled === false) return { ok: false, code: "ACCOUNT", reason: `${state.accountLabel} is no longer available for orders. Switch 1-Tap on again.`, ticket: false };
  if (state.mode === "live" && !liveCapable(a)) return { ok: false, code: "LIVE_OFF", reason: `${state.accountLabel} no longer allows live orders. 1-Tap sent nothing.`, ticket: false };
  if (exit) return { ok: false, code: "EXIT", reason: "Exits always open the ticket.", ticket: true };
  if (!orderable) return { ok: false, code: "CONTRACT", reason: "This contract cannot be traded from here.", ticket: false };
  if (side !== "BUY" && side !== "SELL") return { ok: false, code: "SIDE", reason: "Buy or sell?", ticket: true };
  if (lotCheckNeeded) return { ok: false, code: "LOT_CHECK", reason: "The lot size needs a check first: opening the ticket.", ticket: true };
  if (defaults?.orderType !== "MARKET") {
    const touch = Number(side === "BUY" ? quote?.ask : quote?.bid);
    if (!Number.isFinite(touch) || touch <= 0) return { ok: false, code: "NO_TOUCH", reason: `No ${side === "BUY" ? "ask" : "bid"} to price a limit from: opening the ticket.`, ticket: true };
  }
  return { ok: true };
}

/**
 * The order body 1-Tap sends: the saved defaults, the armed account and mode. The same fields the ticket sends
 * (POST /v1/orders), so the Bridge applies the same checks.
 */
export function oneTapBody({ state, defaults, symbol, side, underlying, quote, tick }) {
  const b = { account: state.accountId, symbol, side, product: defaults.product, orderType: defaults.orderType, lots: lotsFor(defaults, underlying) };
  if (defaults.orderType === "LIMIT") b.price = offsetLimit({ side, bid: quote?.bid, ask: quote?.ask, tick, offsetTicks: defaults.offsetTicks });
  if (defaults.validity === "IOC") b.validity = "IOC";
  if (state.mode === "live") b.mode = "live";
  return b;
}

/** Warning codes that, on a live 1-Tap, mean a person should read the ticket first (nobody else is looking). */
const LIVE_STOPS = new Set(["READINESS", "SAFETY_WARNING", "FNO_BAN_UNCONFIRMED", "BAN_DATA_UNAVAILABLE", "PHYSICAL_SETTLEMENT"]);
/**
 * The preview's checks read for 1-Tap: any block refuses (as on the ticket, whose Place is then disabled); on a live
 * 1-Tap a readiness or safety warning also stops it and opens the ticket instead. Other warnings travel in the toast.
 * @returns {{ ok: boolean, ticket: boolean, reason: string|null, warns: string[] }}
 */
export function oneTapVerdict(checks, mode = "paper") {
  const list = Array.isArray(checks) ? checks : [];
  const block = list.find((c) => c?.severity === "block");
  if (block) return { ok: false, ticket: false, reason: block.message ?? "Refused by the Bridge's checks", warns: [] };
  const stop = mode === "live" ? list.find((c) => c?.severity === "warn" && LIVE_STOPS.has(c.code)) : null;
  if (stop) return { ok: false, ticket: true, reason: `${stop.message} Opening the ticket instead.`, warns: [] };
  return { ok: true, ticket: false, reason: null, warns: list.filter((c) => c?.severity === "warn").map((c) => c.message) };
}

/** Whether an order can still be cancelled from the toast. */
export const cancellable = (order) => Boolean(order?.orderId) && WORKING.has(order.status);

/** Ctrl+Alt+1 (⌃⌥1 on a Mac): the 1-Tap switch. Matches the physical key, whatever the layout prints. */
export const isOneTapKey = (e) => Boolean(e) && e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && (e.code === "Digit1" || e.key === "1");

/** The capsule's words: "1-Tap" off; on, the flag "1-Tap ON · Paper" (LIVE in capitals) and the account beside it. */
export function capsuleText(state) {
  if (!state?.on) return { main: "1-Tap", sub: "" };
  return { main: `1-Tap ON · ${state.mode === "live" ? "LIVE" : "Paper"}`, sub: state.accountLabel };
}
