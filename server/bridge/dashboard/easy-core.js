// The rules behind "make it easy": the Simple and Advanced view, the Connect a tool wizard's choices, what to say and
// what to offer when a request fails, the help topics, and the practice-order form. Pure (no DOM at import time), so
// easy-core.test.mjs runs it under Node. The key rules are NOT written again here: scopes, names and expiry come from
// flows.js (KEY_USES) and snippets.js (KEY_PRESETS), the same code the Keys page uses.
import { defaultKeyName, keyUse } from "./flows.js";
import { KEY_PRESETS, snippets } from "./snippets.js";

// ── Simple and Advanced view ──

export const MODE_SLOT = "mcb.dashboard.mode";
export const MODES = Object.freeze(["simple", "advanced"]);
/** Any stored value becomes a mode; a new browser (nothing stored) is Simple. */
export const parseMode = (v) => (v === "advanced" ? "advanced" : "simple");

const storage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
let current = null;
const listeners = new Set();
/** The view in use: remembered in this browser, Simple until the person chooses otherwise. */
export function getMode() {
  if (current) return current;
  let v = null;
  try {
    v = storage()?.getItem(MODE_SLOT) ?? null;
  } catch {
    /* storage blocked: Simple */
  }
  current = parseMode(v);
  return current;
}
/** Choose a view: remember it, mark the page (`data-mode`, for CSS) and tell whoever listens. */
export function setMode(mode) {
  const next = parseMode(mode);
  const changed = next !== getMode();
  current = next;
  try {
    storage()?.setItem(MODE_SLOT, next);
  } catch {
    /* storage blocked: it lasts until the tab closes */
  }
  markMode();
  if (changed) for (const fn of listeners) fn(next);
  return next;
}
/** `data-mode` on <html>, so the stylesheet can hide what only Advanced shows. */
export function markMode() {
  if (typeof document !== "undefined") document.documentElement.dataset.mode = getMode();
}
export const onMode = (fn) => (listeners.add(fn), () => listeners.delete(fn));
/** Tests start from a clean slate. */
export const resetModeForTests = () => {
  current = null;
  listeners.clear();
};

/**
 * Whether a page shows in the menu. Simple hides the pages flagged `advanced` (API: keys, console, activity); the page
 * you are on always shows, so a deep link to an advanced page never leaves you on a page the menu does not list.
 */
export const pageShown = (page, mode, activeId = null) => mode === "advanced" || !page.advanced || page.id === activeId;
/** The tabs a page shows: Simple lists only the tabs not flagged `advanced`, plus the one you are on. */
export const tabsShown = (page, mode, activeTabId = null) => (page.tabs ?? []).filter((t) => mode === "advanced" || !t.advanced || t.id === activeTabId);

// ── Connect a tool ──

/**
 * The tools the wizard offers, in the order a person looks for them. `use` is the Keys page's tool (KEY_USES);
 * `preset` the Excel-style key preset (KEY_PRESETS) that adds "may sit in a URL"; `orders`: "never" (the key is read only
 * by rule), or "optional" (a switch that adds paper orders, off by default: least privilege); `tabs` are the snippet
 * groups (snippets.js) shown once the key exists, `test` how "Test it" asks.
 */
export const CONNECT_TOOLS = Object.freeze([
  { id: "excel", name: "Excel or Google Sheets", blurb: "Live prices in your cells", use: "excel", preset: "excel", orders: "never", tabs: ["excel"], test: "sheet", paste: "The easiest way is the ready workbook: it already has your key and a watchlist.", steps: ["Press Download a ready workbook below and open it in Excel for Windows. The key is stored inside the file (Formulas, Name Manager), not in a cell, so do not share or email the file.", "Or use your own file: click a cell, type BridgeKey in the Name Box (the small box left of the formula bar) and press Enter. Then type the key into that cell.", "Excel for Windows: paste the formula next to a symbol such as NSE:RELIANCE.", "Excel for Mac and Excel on the web have no WEBSERVICE. Use Power Query with quotes.pq from the Bridge folder (integrations/excel): it sends the key in a header. The link under Mac Excel below is the fallback (Data, then From Web); it has your key in it, so keep it to yourself.", "Google Sheets runs on Google's servers, which cannot reach this computer, so it needs a tunnel you set up yourself and the Apps Script from Integrations (the key goes in a script property, never in an IMPORTDATA link). The Excel and Sheets guide has the steps."] },
  { id: "ai", name: "An AI assistant", blurb: "Claude, ChatGPT and others", use: "claude", orders: "optional", tabs: ["claude", "chatgpt"], test: "api", paste: "Paste this into your assistant's settings, then restart the assistant." },
  { id: "python", name: "A Python script", blurb: "Scripts and notebooks", use: "python", orders: "optional", tabs: ["python", "rest"], test: "api", paste: "Run the first block once, then paste the second block into your script." },
  { id: "node", name: "A Node script", blurb: "Scripts and services", use: "node", orders: "optional", tabs: ["node", "rest"], test: "api", paste: "Run the first block once, then paste the second block into your script." },
  { id: "app", name: "My own app", blurb: "Your own tool or bot", use: "app", orders: "optional", tabs: ["rest", "node"], test: "api", paste: "Send the key in an Authorization header, as the code below does." },
  { id: "amibroker", name: "AmiBroker", blurb: "Live values in your charts", use: "amibroker", preset: "amibroker", orders: "never", tabs: ["amibroker"], test: "sheet", paste: "Set the key once, then restart AmiBroker." },
]);
export const connectTool = (id) => CONNECT_TOOLS.find((t) => t.id === id) ?? null;
/** "Connect Excel or Google Sheets", "Connect a Python script": a proper name keeps its capitals, an article does not. */
export const connectHeading = (tool) => `Connect ${/^(A|An|My) /.test(tool?.name ?? "") ? tool.name.charAt(0).toLowerCase() + tool.name.slice(1) : (tool?.name ?? "a tool")}`;

/**
 * The key to create for a tool, as the POST /v1/keys body, plus what it may do. Least privilege: read only, unless the
 * tool can place orders and the person switched that on (then paper orders, never live). Spreadsheet tools get the
 * Keys page's rule (read only, may sit in a URL, expires in 90 days).
 * @param {string} toolId
 * @param {{ orders?: boolean, now?: Date, taken?: string[], accounts?: string[] | "*" }} [o]
 */
export function connectKey(toolId, { orders = false, now = new Date(), taken = [], accounts = "*" } = {}) {
  const tool = connectTool(toolId);
  if (!tool) throw new Error(`Unknown tool: ${toolId}`);
  const use = keyUse(tool.use);
  const preset = tool.preset ? KEY_PRESETS[tool.preset] : null;
  const wantsOrders = tool.orders === "optional" && orders === true;
  const scopes = wantsOrders ? ["paper"] : ["read"];
  const body = { label: defaultKeyName(use.id, now, taken), scopes, accounts, clientKind: use.clientKind };
  const days = preset?.expiresDays ?? use.expiresDays;
  if (days) body.expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString();
  if (preset?.allowQuery && !wantsOrders) body.allowQuery = true;
  return body;
}

/**
 * The order tools of an AI assistant are off until the Bridge's own settings turn them on; the key alone does not
 * (docs/guides/mcp.md, "Letting an assistant prepare orders"). Shown with the choice, so nobody is promised a tool that is absent.
 */
export const MCP_ORDERS_NEEDS = "A paper key is not enough on its own. The assistant sees the order tools only after you add this to bridge.config.json (use your own paper account id) and restart the Bridge. The MCP guide has the steps.";
export const MCP_ORDERS_CONFIG = '"mcp": { "toolsets": ["market", "analytics", "account", "orders"], "orderAccounts": ["demo-paper"] }';

/** One line each: what the tool can do and what it cannot, in the words a person uses. */
export function connectCapabilities(toolId, { orders = false } = {}) {
  const tool = connectTool(toolId);
  const withOrders = tool?.orders === "optional" && orders;
  if (tool?.id === "ai") {
    return withOrders
      ? { can: "Read prices and positions, and prepare a practice order for you to approve.", cannot: "It cannot send an order on its own, place a real-money order or change your keys.", needs: MCP_ORDERS_NEEDS, needsCode: MCP_ORDERS_CONFIG }
      : { can: "Read prices, charts and your positions.", cannot: "It cannot place any order or change anything." };
  }
  if (withOrders) return { can: "Read prices, and place and cancel practice (paper) orders.", cannot: "It cannot place real-money orders or change your keys." };
  return { can: "Read prices, charts and option chains.", cannot: "It cannot place any order or change anything." };
}

/** The question under a tool that can place orders: its two answers (the first is the safe default). */
export function ordersChoice(toolId) {
  const tool = connectTool(toolId);
  if (tool?.orders !== "optional") return null;
  return tool.id === "ai"
    ? { label: "What should it be able to do?", options: [["no", "Look only"], ["yes", "Look and prepare orders for me to approve"]] }
    : { label: "Should it be able to place practice orders?", options: [["no", "No, look only"], ["yes", "Yes, practice orders"]] };
}

/** The ready-to-paste setups for a tool, with the real address and the new key filled in (snippets.js). */
export function connectSetup(toolId, { base, key, account = "demo-paper", folder, orders = false } = {}) {
  const tool = connectTool(toolId);
  // A read-only key gets examples it can run: no order lines.
  const all = snippets({ base, key, account, symbol: "NSE:NIFTY", folder, orders });
  return (tool?.tabs ?? []).map((id) => ({ id, blocks: all[id] ?? [] })).filter((g) => g.blocks.length);
}

/** The group names on the setup tabs. */
export const SETUP_NAME = Object.freeze({ excel: "Excel and Sheets", claude: "Claude", chatgpt: "ChatGPT / OpenAI", python: "Python", node: "Node", rest: "curl", amibroker: "AmiBroker" });

/** How "Test it" asks: what URL and headers a tool really uses, so a pass means the tool will work too. */
export function testRequest(toolId, key, symbol = "NSE:RELIANCE") {
  const tool = connectTool(toolId);
  if (tool?.test === "sheet") return { url: `/xl/ltp?symbol=${encodeURIComponent(symbol)}&key=${encodeURIComponent(key)}`, headers: {}, kind: "sheet" };
  return { url: `/v1/ltp?symbols=${encodeURIComponent(symbol)}`, headers: { authorization: `Bearer ${key}` }, kind: "api" };
}

/**
 * What a "Test it" answer means, in plain words. `res` is `{ status, text, json }` (or `{ network: true }`).
 * @returns {{ ok: boolean, title: string, detail: string, fix: Fix | null }}
 */
export function testOutcome(res, symbol = "NSE:RELIANCE") {
  if (res?.network) return { ok: false, title: "Could not reach the Bridge", detail: "Is it still running on this computer? Start it again, then press Test it.", fix: { id: "retry", label: "Test it again" } };
  if (res?.status >= 200 && res.status < 300) {
    const j = res.json?.data?.[0];
    const price = j?.ltp ?? (Number.isFinite(Number(res.text)) && String(res.text).trim() !== "" ? Number(res.text) : null);
    if (price === null || price === undefined) return { ok: true, title: "It works", detail: "The key was accepted and the Bridge answered.", fix: null };
    const f = j?.freshness;
    const how = f && f.class && f.class !== "realtime" ? ` This price is ${f.class === "delayed" ? `${Math.round((f.delaySec ?? 0) / 60)} minutes late` : "from the end of the day"}.` : "";
    const demo = res.json?.meta?.demo ? " These are sample prices, not the live market." : "";
    // A late price still "works"; say so, and offer the page that explains why.
    const late = Boolean(how);
    return { ok: true, title: late ? "It works, but the price is late" : "It works", detail: `${symbol.replace(/^[A-Z]+:/, "")} is ${price}.${demo}${how}`, fix: late ? { id: "delayed", label: "Why is it late?", route: "sources/providers" } : null };
  }
  const code = res?.json?.code ?? res?.json?.error?.code ?? null;
  return failure({ status: res?.status, code, message: res?.json?.detail ?? res?.json?.message });
}

// ── When something fails: the likely cause in plain words and the one fix ──

/** @typedef {{ id: "login" | "keys" | "limits" | "broker" | "safety" | "retry" | "delayed", label: string, route?: string }} Fix */

/**
 * The single fix to offer for a failed request, or null when there is none to offer. By the Bridge's error code first,
 * then by HTTP status. The route is a dashboard address (no leading `#/`).
 * @param {{ status?: number, code?: string, network?: boolean } | null | undefined} err
 * @returns {Fix | null}
 */
export function fixFor(err) {
  if (!err) return null;
  if (err.network) return { id: "retry", label: "Try again" };
  switch (err.code) {
    case "UNAUTHENTICATED":
      return { id: "login", label: "Log in again" };
    case "SCOPE_REQUIRED":
    case "ACCOUNT_FORBIDDEN":
    case "LOOPBACK_ONLY":
      return { id: "keys", label: "Open Keys", route: "api/keys" };
    case "RATE_LIMITED":
    case "UPSTREAM_RATE_LIMITED":
      return { id: "limits", label: "Why is this slow?", route: "sources/overview" };
    case "SESSION_EXPIRED":
    case "BROKER_UNAVAILABLE":
    case "NO_ACCOUNT":
      return { id: "broker", label: "Log in to your broker", route: "accounts" };
    case "KILL_SWITCH_ENGAGED":
      return { id: "safety", label: "Open Safety", route: "safety" };
    case "UPSTREAM_TIMEOUT":
      return { id: "retry", label: "Try again" };
    default:
  }
  if (err.status === 401) return { id: "login", label: "Log in again" };
  if (err.status === 403) return { id: "keys", label: "Open Keys", route: "api/keys" };
  if (err.status === 429) return { id: "limits", label: "Why is this slow?", route: "sources/overview" };
  return null;
}

/** A failed call as title, plain cause and the fix (for the "Test it" result and anywhere a short answer is needed). */
export function failure({ status, code, message }) {
  const fix = fixFor({ status, code });
  const known = {
    UNAUTHENTICATED: ["The key was not accepted", "It may be mistyped, expired or revoked. Make a new one."],
    SCOPE_REQUIRED: ["This key is not allowed to do that", "It was made with less access than this needs."],
    ACCOUNT_FORBIDDEN: ["This key is not allowed to do that", "It was made with less access than this needs."],
    RATE_LIMITED: ["It asked too often", "The Bridge held this tool back to stay inside the broker's limits."],
    SESSION_EXPIRED: ["Your broker login ended", "Log in to your broker again to get prices."],
    BROKER_UNAVAILABLE: ["No broker is connected", "Log in to your broker, or use the demo."],
    NO_ACCOUNT: ["No broker is connected", "Log in to your broker, or use the demo."],
    KILL_SWITCH_ENGAGED: ["Orders are stopped", "The emergency stop is on. Prices still work; orders wait until it is released."],
  };
  const [title, detail] = known[code] ?? (status === 401 ? known.UNAUTHENTICATED : status === 403 ? known.SCOPE_REQUIRED : status === 429 ? known.RATE_LIMITED : [status ? `The Bridge answered ${status}` : "Something went wrong", message ?? "Try again in a moment."]);
  return { ok: false, title, detail, fix };
}

// ── "Something wrong?" ──

/**
 * The questions a person has when things go wrong, each with the one place that answers it. `to` is a dashboard
 * address, or `stop` (the emergency stop, which asks first).
 */
export const HELP_TOPICS = Object.freeze([
  { id: "rate", icon: "limits", title: "My tool says it is rate limited", sub: "See which tool is being held back, and give it more room", to: "sources/quotas" },
  { id: "old", icon: "clock", title: "A price looks old", sub: "See which source answered and how late it is", to: "sources/providers" },
  { id: "stop", icon: "stop", title: "Stop everything now", sub: "Stops every new order, from every tool", to: "stop", danger: true },
  { id: "login", icon: "accounts", title: "My broker needs a login", sub: "Log in again on Accounts", to: "accounts" },
  { id: "key", icon: "keys", title: "A key does not work", sub: "Check what each key may do, or make a new one", to: "api/keys" },
  { id: "connect", icon: "plug", title: "Connect Excel, an AI assistant or a script", sub: "A few clicks, with the setup ready to copy", to: "connect" },
]);

// ── Sources, in one sentence (the Simple view) ──

/**
 * One calm sentence about where prices come from, from the list GET /v1/sources returns (pure).
 * @param {Array<{ name: string, enabled: boolean, configured?: boolean, health?: { state?: string } }>} sources
 */
export function sourcesSentence(sources) {
  const on = (sources ?? []).filter((s) => s.enabled);
  if (!on.length) return "No source is turned on, so there are no prices yet. Add your broker on Accounts.";
  const bad = on.filter((s) => s.health && s.health.state && s.health.state !== "ok");
  const names = on.map((s) => s.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  if (!bad.length) return `Your prices come from ${list}, and ${on.length === 1 ? "it is" : "all are"} working.`;
  return `Your prices come from ${list}. ${bad.map((s) => s.name).join(" and ")} ${bad.length === 1 ? "has" : "have"} a problem right now; the Bridge uses the others.`;
}

// ── Practice order (the Orders page's "Send a paper order") ──

/** "reliance", "RELIANCE" and "NSE:RELIANCE" all mean the same stock; anything with a colon is kept as typed. */
export function normaliseSymbol(text) {
  const t = String(text ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!t) return "";
  return t.includes(":") ? t : `NSE:${t}`;
}

/**
 * The practice-order form's answer: the POST /v1/orders body, or the field to fix. Always a paper account and a market
 * order, for a person who wants to try the product, not to design an order.
 * @param {{ account?: string, symbol?: string, side?: string, quantity?: string | number }} f
 */
export function practiceOrder(f) {
  const symbol = normaliseSymbol(f.symbol);
  if (!symbol) return { error: { field: "symbol", message: "Type the stock, for example RELIANCE." } };
  const n = Number(String(f.quantity ?? "").trim());
  if (!Number.isInteger(n) || n < 1) return { error: { field: "quantity", message: "Quantity must be a whole number, 1 or more." } };
  if (!f.account) return { error: { field: "account", message: "Pick a paper account." } };
  const side = f.side === "SELL" ? "SELL" : "BUY";
  return { body: { account: f.account, symbol, side, quantity: n, product: "CNC", orderType: "MARKET", mode: "paper" } };
}

