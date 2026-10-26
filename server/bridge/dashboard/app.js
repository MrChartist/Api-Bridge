// Mr. Chartist API Bridge — local dashboard. Talks only to this Bridge (same origin). The API key lives in
// sessionStorage for this tab and is sent as a Bearer header; it is never put in a URL.
// Pure helpers (ticketFields, confirmCodeNotice, friendlyError ...) are exported for tests; DOM code runs only in a browser.

const KEY_SLOT = "mcb.dashboard.key";
const THEME_SLOT = "mcb.dashboard.theme";
export const fmtInt = new Intl.NumberFormat("en-IN");
export const fmtRs = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
export const fmtNum = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

// ── Storage (wrapped: private windows and blocked storage must not break the page) ──

export function store(kind = "local") {
  const get = () => {
    try {
      return kind === "session" ? globalThis.sessionStorage : globalThis.localStorage;
    } catch {
      return null;
    }
  };
  return {
    get(k) {
      try {
        return get()?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        if (v === null || v === undefined) get()?.removeItem(k);
        else get()?.setItem(k, v);
      } catch {
        /* storage blocked: keep going without it */
      }
    },
  };
}
const session = store("session");
const local = store("local");
let memoryKey = session.get(KEY_SLOT);

export function setKey(k) {
  memoryKey = k || null;
  session.set(KEY_SLOT, memoryKey);
}
export const currentKey = () => memoryKey;

// ── Errors in plain words ──

/**
 * A short, helpful message for an API error (problem+json code) or a network failure. Pure.
 * @param {{ status?: number, code?: string, message?: string, network?: boolean }} err
 * @returns {{ title: string, detail: string }}
 */
export function friendlyError(err) {
  const detail = err?.message ?? "";
  if (err?.network) return { title: "Cannot reach the Bridge", detail: "Is it still running? Start it again with npm start (or the start file you double-clicked), then refresh this page." };
  switch (err?.code) {
    case "UNAUTHENTICATED":
      return { title: "That key was not accepted", detail: "It may be mistyped, expired or revoked. Create a new one with: npm run bridge -- keys create --label me --scope admin,paper" };
    case "SCOPE_REQUIRED":
      return { title: "This key is not allowed to do that", detail: `${detail} Sign in with an admin key to manage the Bridge.` };
    case "LOOPBACK_ONLY":
      return { title: "Only from this computer", detail: "This page manages keys and accounts, so it works only at http://127.0.0.1 on the computer running the Bridge." };
    case "SESSION_EXPIRED":
      return { title: "Broker session expired", detail: `${detail} Log in again: npm run bridge -- accounts connect <account id>.` };
    case "BROKER_UNAVAILABLE":
    case "NO_ACCOUNT":
      return { title: "No broker connected for this", detail: `${detail} Connect a broker account (Accounts page), or try everything with sample data: npm start -- --demo.` };
    case "RATE_LIMITED":
    case "UPSTREAM_RATE_LIMITED":
      return { title: "Slow down a little", detail: `${detail} The Bridge is keeping you inside the broker's limits; try again in a moment.` };
    case "KILL_SWITCH_ENGAGED":
      return { title: "The kill switch is on", detail: "No orders are sent until an admin releases it on the Safety page." };
    case "SYMBOL_NOT_FOUND":
      return { title: "Symbol not found", detail: `${detail} Symbols look like NSE:RELIANCE, NSE:NIFTY or NFO:NIFTY-2026-10-27-25000-CE.` };
    case "VALIDATION_FAILED":
      return { title: "Please check the form", detail };
    case "NOT_IMPLEMENTED":
      return { title: "Not available yet", detail };
    default:
      return { title: err?.status ? `The Bridge answered ${err.status}` : "Something went wrong", detail };
  }
}

// ── API ──

export class ApiError extends Error {
  constructor(message, { status, code, network = false, body } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.network = network;
    this.body = body;
  }
}

/** Call the Bridge. Returns { data, headers, status, ms, text }. With raw: true, error answers are returned too. */
export async function api(path, { method = "GET", body, raw = false } = {}) {
  const headers = { Authorization: `Bearer ${memoryKey}`, "X-MCB-Client": "dashboard" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError("The Bridge did not answer.", { network: true });
  }
  const ms = Math.round(performance.now() - t0);
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let data = text;
  if (ct.includes("json") && text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* leave as text */
    }
  }
  if (!res.ok && !raw) throw new ApiError(data?.detail ?? data?.title ?? `HTTP ${res.status}`, { status: res.status, code: data?.code, body: data });
  return { data, headers: res.headers, status: res.status, ms, text };
}
export const optional = (p) => p.then((r) => r, (error) => ({ error }));

// ── DOM helpers ──

/** h("div", { class: "x", onclick }, child, "text") */
export function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

/** Icons: small stroked SVGs (static strings from this file). */
export const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
  accounts: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>',
  console: '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="m6.5 9 3 3-3 3"/><path d="M12 15h5"/>',
  scan: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M8 11h6"/><path d="M11 8v6"/>',
  limits: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/><circle cx="12" cy="14" r="1.5"/>',
  orders: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  keys: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m17 6 3 3"/><path d="m15 8 2 2"/>',
  integrations: '<path d="M9 7H6a3 3 0 0 0 0 6h3"/><path d="M15 7h3a3 3 0 0 1 0 6h-3"/><path d="M8 10h8"/><path d="M12 13v8"/>',
  safety: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
  inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v6H4V5h6"/>',
};
export function icon(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name] ?? "";
  return s;
}

export function toast(text) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

export async function copyText(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", {}, text);
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* the person can still select the text */
    }
    ta.remove();
  }
  toast(label);
}

/** Highlight JSON text (escaped first, so nothing in the data is ever interpreted as HTML). Pure. */
export function highlightJson(text) {
  const esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m, str, colon, lit, num) => {
    if (str) return colon ? `<span class="json-key">${str}</span>${colon}` : `<span class="json-str">${str}</span>`;
    if (lit) return `<span class="json-lit">${lit}</span>`;
    return `<span class="json-num">${num}</span>`;
  });
}

/** A code block with a copy button. `onCopy` runs after copying (the welcome checklist listens). */
export function codeBlock(code, { title, json = false, onCopy } = {}) {
  const pre = h("pre");
  if (json) pre.innerHTML = highlightJson(code);
  else pre.textContent = code;
  const btn = h("button", { class: "small copy", type: "button", onclick: () => copyText(code).then(() => onCopy?.()) }, icon("copy"), "Copy");
  return h("div", {}, title ? h("div", { class: "code-title" }, title) : null, h("div", { class: "code" }, pre, btn));
}

export function pill(text, cls = "") {
  return h("span", { class: `pill ${cls}` }, cls && cls !== "demo" ? h("span", { class: "pdot" }) : null, text);
}

export function emptyState(iconName, title, text, action) {
  return h("div", { class: "empty" }, h("div", { class: "eicon" }, icon(iconName)), h("strong", {}, title), text ? h("p", {}, text) : null, action ?? null);
}

export function alertBox(err, cls = "bad") {
  const f = err instanceof Error || err?.code || err?.network ? friendlyError(err) : { title: String(err?.title ?? err), detail: err?.detail ?? "" };
  return h("div", { class: `alert ${cls}`, role: "alert" }, icon(cls === "info" ? "info" : "warn"), h("div", {}, h("strong", {}, f.title), f.detail ? h("span", { class: "detail" }, f.detail) : null));
}

export function table(columns, rows, empty) {
  if (!rows.length) return empty;
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.num ? "num" : undefined }, c.label)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, columns.map((c) => h("td", { class: [c.num ? "num" : "", c.wrap ? "wrap" : ""].join(" ").trim() || undefined }, c.cell(r)))))),
    ),
  );
}

export function card({ title, sub, actions, body, flush = false, cls = "", id }) {
  return h(
    "section",
    { class: `card ${cls}`, id },
    title || actions ? h("div", { class: "card-head" }, h("div", {}, title ? h("h2", {}, title) : null, sub ? h("p", {}, sub) : null), h("div", { class: "spacer" }), actions ?? null) : null,
    h("div", { class: flush ? "card-body flush" : "card-body" }, body),
  );
}

export function meterRow(name, used, limit, valueText) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const span = h("span");
  span.style.width = `${Math.max(pct, used > 0 ? 3 : 0)}%`;
  const cls = pct >= 90 ? "bad" : pct >= 60 ? "warn" : "ok";
  return h("div", { class: "meter" }, h("span", { class: "name" }, name), h("div", { class: `bar ${cls}` }, span), h("span", { class: "val" }, valueText ?? `${used} / ${limit}`));
}

export const istTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "—");
export const istDateTime = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

// ── Dialog ──

/** Show a modal. buttons: [{ label, cls, value, onClick? }]; onClick returning false keeps it open. Resolves with the value. */
export function modal({ title, body, buttons }) {
  const d = document.getElementById("dialog");
  return new Promise((resolve) => {
    const close = (v) => {
      d.close();
      resolve(v);
    };
    d.replaceChildren(
      h("div", { class: "dialog-body" }, h("h2", {}, title), body),
      h(
        "div",
        { class: "dialog-actions" },
        buttons.map((b) =>
          h(
            "button",
            {
              type: "button",
              class: b.cls ?? "",
              onclick: async () => {
                if (b.onClick) {
                  const v = await b.onClick();
                  if (v === false) return;
                  close(v ?? b.value);
                } else close(b.value);
              },
            },
            b.label,
          ),
        ),
      ),
    );
    d.addEventListener("cancel", () => resolve(undefined), { once: true });
    d.showModal();
  });
}

// ── Ticket helpers (pure; tested) ──

/**
 * Every field of a pending ticket's order, in the order a person should read them before confirming. The
 * confirmation covers exactly this body, so nothing that changes what is sent may be left out. Live mode, MARKET
 * orders and blocking checks are flagged. Pure (no DOM) so it can be tested.
 * @returns {Array<[string, string, string?]>}  [label, value, css class]
 */
export function ticketFields(ticket, accountsById = new Map()) {
  const o = ticket?.order ?? {};
  const show = (v) => (v === undefined || v === null || v === "" ? "—" : String(v));
  const money = (v) => (typeof v === "number" && Number.isFinite(v) ? fmtRs.format(v) : "—");
  const acc = accountsById.get(o.account);
  const mode = String(o.mode ?? "paper");
  const orderType = show(o.orderType);
  const rows = [
    ["Account", acc ? `${o.account} (${acc.broker ?? "?"}${acc.label ? ` · ${acc.label}` : ""})` : show(o.account)],
    ["Mode", mode === "live" ? "LIVE (real money)" : mode, mode === "live" ? "bad" : undefined],
    ["Side", show(o.side), o.side === "SELL" ? "warn" : undefined],
    ["Quantity", o.lots ? `${o.lots} lot(s)` : show(o.quantity)],
    ["Symbol", show(o.symbol)],
    ["Order type", orderType === "MARKET" || orderType === "SL-M" ? `${orderType} (no price limit)` : orderType, orderType === "MARKET" || orderType === "SL-M" ? "warn" : undefined],
    ["Price", o.price === undefined || o.price === null ? "—" : money(o.price)],
    ["Trigger price", o.triggerPrice === undefined || o.triggerPrice === null ? "—" : money(o.triggerPrice)],
    ["Product", show(o.product)],
    ["Validity", show(o.validity ?? "DAY")],
    ["Estimated value", money(ticket?.estimatedValue)],
  ];
  if (o.tag) rows.push(["Tag", String(o.tag)]);
  for (const c of ticket?.checks ?? []) {
    const block = c?.severity === "block";
    rows.push([block ? "Blocked" : "Warning", `${c?.code ?? ""}${c?.message ? `: ${c.message}` : ""}`, block ? "bad" : "warn"]);
  }
  return rows;
}

/** Text shown once after a confirmation: the single-use code and when it stops working. Pure. */
export function confirmCodeNotice(ticketId, result) {
  const token = result?.data?.confirmToken ?? result?.confirmToken ?? null;
  const expiresAt = result?.data?.expiresAt ?? result?.expiresAt ?? null;
  if (!token) return null;
  return {
    token,
    text: `Ticket ${ticketId} confirmed. Give this single-use code to the client that prepared it${expiresAt ? `; it expires at ${istTime(expiresAt)} IST` : ""}. It is shown only once.`,
  };
}

/**
 * Welcome checklist state from what the Bridge reports plus what this browser remembers. Pure.
 * @returns {Array<{ id: string, done: boolean }>}
 */
export function checklistState({ demo = false, accounts = [], keys = [], copied = false, tested = false }) {
  const brokerConnected = accounts.some((a) => a.broker !== "paper" && a.session?.state === "connected");
  const activeKeys = keys.filter((k) => !k.revokedAt && !(k.expiresAt && Date.parse(k.expiresAt) < Date.now()));
  return [
    { id: "broker", done: demo || brokerConnected },
    { id: "key", done: activeKeys.length >= 2 },
    { id: "snippet", done: Boolean(copied) },
    { id: "test", done: Boolean(tested) },
  ];
}

// ── Theme ──

export function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === "light" || choice === "dark") root.setAttribute("data-theme", choice);
  else root.removeAttribute("data-theme");
  for (const b of document.querySelectorAll("[data-theme-choice]")) b.setAttribute("aria-pressed", String(b.dataset.themeChoice === (choice ?? "auto")));
}

// ── App boot (browser only) ──

export const app = { state: { demo: false, health: null, meta: null }, local };

async function signIn() {
  const login = document.getElementById("login");
  const shell = document.getElementById("app");
  // /v1/health needs no key, so the sign-in screen can say "demo" before anyone signs in.
  fetch("/v1/health")
    .then((r) => r.json())
    .then((hl) => {
      const el = document.getElementById("login-demo");
      if (el) el.hidden = !hl?.demo;
    })
    .catch(() => {});
  if (!memoryKey) {
    login.hidden = false;
    shell.hidden = true;
    document.getElementById("key-input")?.focus();
    return;
  }
  try {
    const [health, meta] = await Promise.all([api("/v1/health"), api("/v1/meta")]);
    app.state.health = health.data;
    app.state.meta = meta.data;
    app.state.demo = Boolean(health.data?.demo);
  } catch (err) {
    if (err.status === 401 || err.status === 403) setKey(null);
    login.hidden = false;
    shell.hidden = true;
    document.getElementById("login-error").replaceChildren(alertBox(err));
    return;
  }
  login.hidden = true;
  shell.hidden = false;
  document.getElementById("demo-banner").hidden = !app.state.demo;
  document.getElementById("who").textContent = `Key ${memoryKey.split("_")[1] ?? ""} · v${app.state.health?.version ?? ""}`;
  const { startRouter } = await import("./views.js");
  startRouter();
}

if (typeof document !== "undefined" && document.getElementById("login-form")) {
  applyTheme(local.get(THEME_SLOT) ?? "auto");
  for (const b of document.querySelectorAll("[data-theme-choice]")) {
    b.addEventListener("click", () => {
      const c = b.dataset.themeChoice;
      local.set(THEME_SLOT, c === "auto" ? null : c);
      applyTheme(c);
    });
  }
  document.getElementById("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("key-input");
    setKey(input.value.trim());
    input.value = "";
    document.getElementById("login-error").replaceChildren();
    signIn();
  });
  document.getElementById("logout").addEventListener("click", () => {
    setKey(null);
    location.hash = "";
    location.reload();
  });
  signIn();
}
