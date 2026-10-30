// Helpers for the dashboard's flows: inline field errors (one look for every form), and the pure rules behind the
// "Create a key" and "Add a broker" flows (what each tool needs, a default key name, what connecting a broker takes).
// The pure parts take no DOM, so flows.test.mjs runs them under Node.
import { formatDayMonth, formatInt } from "./format.js";

// ── Inline field errors ──

/**
 * Mark a field as wrong where the person is looking: a red field state, the message under it (linked with
 * aria-describedby), `aria-invalid`, and focus. Typing in the field clears it. Returns false, so a submit handler can
 * `return fieldError(...)`.
 * @param {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} input
 * @param {string} message
 */
export function fieldError(input, message, { focus = true } = {}) {
  if (!input) return false;
  clearFieldError(input);
  const id = `${input.id || `f${formatInt(++fieldError.n)}`}-error`;
  if (!input.id) input.id = id.replace(/-error$/, "");
  const msg = document.createElement("span");
  msg.className = "field-msg";
  msg.id = id;
  msg.setAttribute("role", "alert");
  msg.textContent = message;
  input.setAttribute("aria-invalid", "true");
  const described = (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  input.setAttribute("aria-describedby", [...described, id].join(" "));
  // Under the field: inside its <label class="field"> when it has one, else right after the input.
  const host = input.closest(".field");
  if (host) host.append(msg);
  else input.after(msg);
  const clear = () => clearFieldError(input);
  input.addEventListener("input", clear, { once: true });
  input.addEventListener("change", clear, { once: true });
  if (focus) input.focus();
  return false;
}
fieldError.n = 0;

/** Undo fieldError() on one input. */
export function clearFieldError(input) {
  if (!input) return;
  const ids = (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  const keep = [];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el?.classList.contains("field-msg")) el.remove();
    else keep.push(id);
  }
  if (keep.length) input.setAttribute("aria-describedby", keep.join(" "));
  else input.removeAttribute("aria-describedby");
  input.removeAttribute("aria-invalid");
}

// ── Keys: what each tool needs (pure) ──

/**
 * The "Used by" choices on the Create a key form, in the order people pick them. Each sets the least access that
 * tool needs, whether the key may sit in a URL (spreadsheets can only send it that way), the name, and which
 * ready-to-paste setups follow the new key (ids from snippets.js).
 */
export const KEY_USES = Object.freeze([
  { id: "excel", label: "Excel or Google Sheets", word: "Excel", clientKind: "excel", scopes: ["read"], allowQuery: true, expiresDays: 90, snippets: ["excel"] },
  { id: "claude", label: "Claude or another AI assistant", word: "AI", clientKind: "mcp", scopes: ["read"], allowQuery: false, expiresDays: null, snippets: ["claude", "chatgpt"] },
  { id: "python", label: "Python script", word: "Python", clientKind: "script", scopes: ["paper"], allowQuery: false, expiresDays: null, snippets: ["python", "rest"] },
  { id: "node", label: "Node script", word: "Node", clientKind: "script", scopes: ["paper"], allowQuery: false, expiresDays: null, snippets: ["node", "rest"] },
  { id: "amibroker", label: "AmiBroker", word: "AmiBroker", clientKind: "other", scopes: ["read"], allowQuery: true, expiresDays: 90, snippets: ["amibroker"] },
  { id: "app", label: "My own app", word: "App", clientKind: "ui", scopes: ["read"], allowQuery: false, expiresDays: null, snippets: ["rest", "node"] },
  { id: "other", label: "Something else", word: "API", clientKind: "other", scopes: ["read"], allowQuery: false, expiresDays: null, snippets: ["rest", "python"] },
]);

export const keyUse = (id) => KEY_USES.find((u) => u.id === id) ?? KEY_USES[KEY_USES.length - 1];

/** The IST calendar day of a moment, as "2026-10-30". */
export function istDay(when = new Date()) {
  const t = when instanceof Date ? when.getTime() : Number(when);
  return new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/**
 * A key name that tells keys apart at a glance: "Excel key · 30 Oct". `taken` (existing labels) adds " 2", " 3" ...
 * so two keys made the same day for the same tool still differ.
 */
export function defaultKeyName(useId, when = new Date(), taken = []) {
  const base = `${keyUse(useId).word} key · ${formatDayMonth(istDay(when))}`;
  const used = new Set(taken.map((t) => String(t).trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n++) {
    const name = `${base} ${formatInt(n)}`;
    if (!used.has(name.toLowerCase())) return name;
  }
  return base;
}

/**
 * What is wrong with a Create a key form, or null. Field ids: "label", "access". Pure.
 * @param {{ label: string, scopes: string[], allowQuery: boolean }} f
 */
export function keyFormProblem({ label, scopes, allowQuery }) {
  const name = String(label ?? "").trim();
  if (!name) return { field: "label", message: "Give the key a name, so you can tell it apart later (for example: Excel key)." };
  if (name.length > 60) return { field: "label", message: `Keep the name to 60 characters (it has ${formatInt(name.length)}).` };
  if (allowQuery && scopes.some((s) => s !== "read")) return { field: "access", message: "A key that sits in a URL can only read. Choose Read only, or untick Allow in URLs." };
  return null;
}

// ── Brokers: what connecting one takes (pure) ──

/**
 * The steps to connect a broker for real, from its directory entry (GET /v1/brokers) and its login form spec
 * (app.js loginFormSpec). `demo`: the person is in demo mode, so the steps start with a normal start.
 * @returns {Array<{ title: string, text: string, fields?: string[] }>}
 */
export function brokerSetupSteps(broker, spec, { demo = false } = {}) {
  const name = broker?.name ?? "your broker";
  const saved = (spec?.fields ?? []).filter((f) => f.group === "values").map((f) => f.label);
  const once = (spec?.fields ?? []).filter((f) => f.group === "secrets").map((f) => f.label);
  const kind = broker?.authKind;
  const daily = kind === "oauthRedirect" || kind === "requestTokenExchange" || kind === "sessionLogin";
  const steps = [
    {
      title: `Get your API details from ${name}`,
      text: kind === "oauthRedirect" || kind === "requestTokenExchange" ? `Create an app on ${name}'s developer site (free for most brokers) and note what it shows you.` : `Open the API or developer page in your ${name} account and create an API key.`,
      fields: saved,
    },
  ];
  if (demo) steps.push({ title: "Start the Bridge normally", text: "Close the Bridge window, then open Mr Chartist Bridge again from the Start menu or the Desktop." });
  steps.push({
    title: `Log in on Accounts`,
    text: `Press Log in next to ${name} and type the details above. They are saved, encrypted, on this computer only.${once.length ? ` Each login also asks for: ${once.join(", ")} (used once, never saved).` : ""}`,
    ...(once.length ? { fields: once } : {}),
  });
  steps.push({ title: "Trade on paper first", text: daily ? `${name} ends its session every day, so you log in again each morning. New accounts stay on paper until you switch live trading on in the config file.` : "New accounts stay on paper until you switch live trading on in the config file." });
  return steps;
}

/**
 * What to do after a broker was saved from demo mode, from the POST /v1/accounts answer. Pure.
 * @returns {string[]}
 */
export function afterDemoSaveSteps(r, brokerName = "your broker") {
  const steps = ["Close this Bridge window (or press Ctrl+C in it)."];
  if (r?.demoTurnedOff) steps.push("Open Mr Chartist Bridge again from the Start menu or the Desktop. It starts normally now.");
  else if (r?.demoWasInFile) steps.push(`Demo mode is still on in ${r.configFile ?? "your config file"}. Delete the line "demo": true there, then start the Bridge again.`);
  else steps.push("Start the Bridge again without demo mode: open Mr Chartist Bridge from the Start menu, or run it without --demo.");
  steps.push(`Open Accounts and press Log in next to ${brokerName}.`);
  return steps;
}

// ── Trade ticket: what one option order risks (pure) ──

/**
 * Max loss, max profit and breakeven at expiry of one option order, before charges. `null` for max loss / profit means
 * unlimited (a short call loses without limit; a long call gains without limit). Null for futures or missing figures.
 * @param {{ side: "BUY"|"SELL", right: "CE"|"PE", strike: number, price: number, qty: number, kind?: string }} o
 */
export function ticketRisk({ side, right, strike, price, qty, kind = "OPT" }) {
  const k = Number(strike);
  const p = Number(price);
  const q = Number(qty);
  if (kind === "FUT" || !(k > 0) || !(p > 0) || !(q > 0) || (right !== "CE" && right !== "PE")) return null;
  const premium = p * q;
  const breakeven = right === "CE" ? k + p : k - p;
  // A put's other side is capped at the strike (the underlying cannot fall below zero); a call's is not.
  const capped = right === "PE" ? Math.max(0, (k - p) * q) : null;
  return side === "SELL" ? { maxLoss: capped, maxProfit: premium, breakeven, premium } : { maxLoss: premium, maxProfit: capped, breakeven, premium };
}

// ── Accounts: plain words for what the API reports (pure) ──

/** What an account can do, in words people use (GET /v1/accounts capabilities are API names). */
export const CAPABILITY_LABEL = Object.freeze({
  testConnection: "Connection test",
  instruments: "Instrument list",
  expiries: "Expiries",
  optionChain: "Option chain",
  ltp: "Last price",
  quotes: "Quotes",
  depth: "Market depth",
  historical: "Price history",
  feed: "Live feed",
  positions: "Positions",
  holdings: "Holdings",
  funds: "Funds",
  orderBook: "Order book",
  tradeBook: "Trade book",
  placeOrder: "Place orders",
  modifyOrder: "Modify orders",
  cancelOrder: "Cancel orders",
});
export const capabilityLabel = (c) => CAPABILITY_LABEL[c] ?? String(c);

const DATA_CAPS = new Set(["ltp", "quotes", "depth", "historical", "feed", "optionChain"]);
/** One short line for an account's capabilities: "Data and orders", "Orders only", "Data only" or "Account only". */
export function capabilitySummary(caps = []) {
  const data = caps.some((c) => DATA_CAPS.has(c));
  const orders = caps.includes("placeOrder");
  return data && orders ? "Data and orders" : orders ? "Orders only" : data ? "Data only" : "Account only";
}

/** A broker session's state in plain words, with its tone (GET /v1/accounts session.state). */
export function sessionText(state) {
  switch (state) {
    case "connected":
      return { text: "Logged in", tone: "ok" };
    case "expired":
      return { text: "Expired: log in again", tone: "bad" };
    case "error":
      return { text: "Login failed", tone: "bad" };
    case "connecting":
      return { text: "Logging in", tone: "warn" };
    case "missing":
    case undefined:
    case null:
    case "":
      return { text: "Not logged in", tone: "warn" };
    default:
      return { text: `${String(state)[0].toUpperCase()}${String(state).slice(1)}`, tone: "warn" };
  }
}
