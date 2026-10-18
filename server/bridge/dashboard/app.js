// Mr. Chartist API Bridge — local dashboard. Talks only to this Bridge (same origin). The API key lives in
// sessionStorage for this tab and is sent as a Bearer header; it is never put in a URL.
const KEY_SLOT = "mcb.dashboard.key";
const $ = (id) => document.getElementById(id);
const fmtInt = new Intl.NumberFormat("en-IN");
const fmtRs = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

function getKey() {
  try {
    return sessionStorage.getItem(KEY_SLOT);
  } catch {
    return null;
  }
}
function setKey(k) {
  try {
    if (k) sessionStorage.setItem(KEY_SLOT, k);
    else sessionStorage.removeItem(KEY_SLOT);
  } catch {
    /* private mode: the key lives only in memory for this page */
  }
  memoryKey = k;
}
let memoryKey = getKey();

async function api(path, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${memoryKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.detail ?? data?.title ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}
const optional = (p) => p.catch((err) => ({ error: err }));

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined && text !== null) e.textContent = String(text);
  if (cls) e.className = cls;
  return e;
}
function fillKv(ul, pairs) {
  ul.replaceChildren(
    ...pairs.map(([k, v, cls]) => {
      const li = el("li");
      li.append(el("span", k), el("strong", v, cls));
      return li;
    }),
  );
}
function fillRows(tbody, rows, emptyText, cols) {
  if (!rows.length) {
    const tr = el("tr");
    const td = el("td", emptyText, "muted");
    td.colSpan = cols;
    tr.append(td);
    tbody.replaceChildren(tr);
    return;
  }
  tbody.replaceChildren(
    ...rows.map((cells) => {
      const tr = el("tr");
      for (const c of cells) {
        if (c instanceof Node) {
          const td = el("td");
          td.append(c);
          tr.append(td);
        } else tr.append(el("td", c ?? "—"));
      }
      return tr;
    }),
  );
}
const sessionClass = (s) => (s === "connected" ? "ok" : s === "expired" || s === "error" ? "bad" : "warn");

/**
 * Every field of a pending ticket's order, in the order a person should read them before confirming. The
 * confirmation covers exactly this body, so nothing that changes what is sent may be left out. Live mode, MARKET
 * orders and blocking checks are flagged. Pure (no DOM) so it can be tested.
 * @param {{ order?: object, estimatedValue?: number|null, checks?: Array<{ code?: string, message?: string, severity?: string }> }} ticket
 * @param {Map<string, { broker?: string, label?: string }>} [accountsById]
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
const istTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "—");

/** The latest account list, for showing broker names on tickets. */
let accountsById = new Map();

async function refresh() {
  $("error").textContent = "";
  const [health, accounts, usage, safety, streams, tickets, orders] = await Promise.all([
    api("/v1/health"),
    optional(api("/v1/accounts")),
    optional(api("/v1/usage")),
    optional(api("/v1/safety")),
    optional(api("/v1/stream/stats")),
    optional(api("/v1/tickets")),
    optional(api("/v1/orders?limit=50")),
  ]);
  $("version").textContent = `Version ${health.version} · API ${health.apiVersion} · this computer only`;
  fillKv($("services"), Object.entries(health.services ?? {}).map(([k, v]) => [k, v === "ready" ? "ready" : "not built", v === "ready" ? "ok" : "warn"]));

  if (accounts.error) throw accounts.error;
  const accs = accounts.data ?? [];
  accountsById = new Map(accs.map((a) => [a.id, a]));
  fillRows($("accounts"), accs.map((a) => [a.label ?? a.id, a.broker, el("span", a.session?.state ?? "—", sessionClass(a.session?.state)), a.liveAllowedByConfig ? "live enabled" : "paper"]), "No accounts in bridge.config.json yet.", 4);

  const sv = usage.data?.savings ?? {};
  fillKv($("savings"), [
    ["Served from live stream", fmtInt.format(sv.servedFromStream ?? 0)],
    ["Served from cache", fmtInt.format(sv.servedFromCache ?? 0)],
    ["Coalesced duplicates", fmtInt.format(sv.coalesced ?? 0)],
    ["Batched symbols", fmtInt.format(sv.batched ?? 0)],
  ]);

  const st = safety.data;
  if (st) {
    const k = st.killSwitch ?? {};
    $("kill-state").textContent = k.engaged ? `ENGAGED since ${istTime(k.at)}: ${k.reason ?? ""}` : "Off. Orders are allowed within your safety limits.";
    $("kill-state").className = k.engaged ? "bad" : "muted";
    const live = Boolean(st.liveTrading);
    $("mode-pill").textContent = live ? "Live trading ON" : "Paper";
    $("mode-pill").className = live ? "pill live" : "pill";
  }

  const sd = streams.data;
  fillKv($("streams"), sd ? [
    ["Broker feeds", (sd.upstreams ?? []).length],
    ["Symbols", sd.symbols ?? 0],
    ["Client connections", sd.downstream?.connections ?? 0],
    ["Ticks conflated for slow clients", fmtInt.format(sd.downstream?.conflatedTicks ?? 0)],
  ] : [["Streams", "unavailable"]]);

  if (tickets.error) fillRows($("tickets"), [], tickets.error.status === 403 ? "Needs an admin key." : tickets.error.message, 5);
  else {
    fillRows(
      $("tickets"),
      (tickets.data ?? []).map((t) => {
        const fields = ticketFields(t, accountsById);
        const blocked = (t.checks ?? []).some((c) => c?.severity === "block");
        const btn = el("button", blocked ? "Blocked" : "Confirm", t.order?.mode === "live" ? "danger" : undefined);
        btn.disabled = blocked;
        btn.addEventListener("click", () => confirmTicket(t, fields).catch(showError));
        const details = el("ul", undefined, "kv");
        fillKv(details, fields);
        return [t.ticketId, `${t.source} · ${t.client}${t.expiresAt ? ` · until ${istTime(t.expiresAt)}` : ""}`, details, t.estimatedValue === null || t.estimatedValue === undefined ? "—" : fmtRs.format(t.estimatedValue), btn];
      }),
      "Nothing waiting.",
      5,
    );
  }

  const ords = orders.data ?? [];
  fillRows($("orders"), ords.map((o) => [istTime(o.placedAt ?? o.createdAt), o.accountId, o.symbol, o.side, o.quantity, o.status, o.mode]), orders.error ? orders.error.message : "No orders today.", 7);
}

async function confirmTicket(ticket, fields) {
  const summary = fields.map(([k, v]) => `${k}: ${v}`).join("\n");
  if (!window.confirm(`Confirm ticket ${ticket.ticketId}? The client that prepared it can then send exactly this order once.\n\n${summary}`)) return;
  const r = await api(`/v1/tickets/${encodeURIComponent(ticket.ticketId)}/confirm`, { method: "POST" });
  showConfirmCode(confirmCodeNotice(ticket.ticketId, r));
  await refresh();
}

/** Show the single-use code once with a copy button; it is removed from the page after copying or after 2 minutes. */
function showConfirmCode(notice) {
  const box = $("confirm-code");
  if (!box || !notice) return;
  const code = el("code", notice.token);
  const copy = el("button", "Copy code");
  const clear = () => box.replaceChildren();
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(notice.token);
    } catch {
      /* clipboard blocked: the person can still select the code */
    }
    clear();
  });
  box.replaceChildren(el("p", notice.text, "small"), code, document.createTextNode(" "), copy);
  setTimeout(clear, 120_000);
}

function showError(err) {
  $("error").textContent = err?.message ?? String(err);
}

async function start() {
  if (!memoryKey) {
    $("login").hidden = false;
    $("main").hidden = true;
    return;
  }
  try {
    await api("/v1/meta");
  } catch (err) {
    setKey(null);
    $("login").hidden = false;
    $("main").hidden = true;
    $("login-error").textContent = err.status === 401 ? "That key was not accepted. Check it and try again." : err.message;
    return;
  }
  $("login").hidden = true;
  $("main").hidden = false;
  $("key-label").textContent = `Key ${memoryKey.split("_")[1] ?? ""}`;
  await refresh().catch(showError);
}

// DOM wiring runs only in the browser (the helpers above are imported by tests under Node).
if (typeof document !== "undefined") {
  $("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    setKey($("key-input").value.trim());
    $("key-input").value = "";
    $("login-error").textContent = "";
    start();
  });
  $("logout").addEventListener("click", () => {
    setKey(null);
    start();
  });
  $("refresh").addEventListener("click", () => refresh().catch(showError));
  $("kill-engage").addEventListener("click", async () => {
    const reason = window.prompt("Why are you stopping all orders?", "Stopped from the dashboard");
    if (!reason) return;
    const cancelOpenOrders = window.confirm("Also cancel all open orders? (OK = cancel them, Cancel = leave them)");
    await api("/v1/safety/kill-switch", { method: "POST", body: { reason, cancelOpenOrders } }).catch(showError);
    await refresh().catch(showError);
  });
  $("kill-release").addEventListener("click", async () => {
    if (window.prompt('Type RELEASE to allow orders again.') !== "RELEASE") return;
    await api("/v1/safety/kill-switch", { method: "DELETE", body: { confirm: "RELEASE" } }).catch(showError);
    await refresh().catch(showError);
  });
  setInterval(() => {
    if (memoryKey && !document.hidden) refresh().catch(showError);
  }, 10_000);
  start();
}
