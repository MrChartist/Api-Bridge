// Orders page: Pending confirmations, Today's orders (filters, search, row menu, Cancel all), Funds and Orders › Trades
// (summary, the book by day, CSV). Filters are a per-viewer convenience (localStorage); the books come from GET
// /v1/orders, /v1/trades, /v1/tickets and /v1/funds. views.js owns the sheets that change an order (modify, cancel,
// confirm) and hands them in; this file draws.
import { alertBox, api, card, codeBlock, copyText, emptyState, h, icon, iconTile, istTime, modal, optional, pill, sheetPopover, skeletonCard, store, toast, writeCount } from "./app.js";
import { contractName } from "./flows.js";
import { DASH, formatFixed, formatInt, formatPercent, formatRupee, formatRupeeGrouped, isFigure } from "./format.js";
import {
  DRY_RUN_REUSE_MS,
  ORDER_FILTERS,
  ago,
  cancelAllBody,
  cancelAllBridgeLine,
  cancelAllButton,
  cancelAllGroups,
  cancelAllTitle,
  cancelAllReport,
  dayHeading,
  filterOrders,
  filterTrades,
  fundsView,
  groupByDay,
  openByMode,
  orderCounts,
  orderStatusLook,
  orderTypeText,
  productText,
  qtyText,
  shortMemo,
  ticketLife,
  ticketSource,
  tradesCsv,
} from "./orders-core.js";
import { fillCharges, fillTotals, istDayOf } from "./charges.js";
import { whatToDo } from "./reasons-core.js";

const KEY = "mcb.orders.filters";
const DECLINED = "mcb.orders.declined";
const session = store("session");

/** Shell helpers this page borrows from views.js (set once at start-up: views.js imports this file, not the reverse). */
let shell = { segmented: null };
export function configureOrdersBook(helpers) {
  shell = { ...shell, ...helpers };
}

/**
 * Cancel all's dry run for the button: one per page render or action. The redraw that follows a render painted from
 * remembered answers reuses it (DRY_RUN_REUSE_MS), any write asks again, and the Cancel all question always asks afresh.
 */
const buttonDryRun = shortMemo(DRY_RUN_REUSE_MS);

function loadFilters() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { status: ORDER_FILTERS.some(([id]) => id === v.status) ? v.status : "all", side: ["all", "BUY", "SELL"].includes(v.side) ? v.side : "all", q: "" };
  } catch {
    return { status: "all", side: "all", q: "" };
  }
}
function saveFilters(f) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ status: f.status, side: f.side }));
  } catch {
    /* private window: the filter lasts this visit only */
  }
}

// ── Small parts ──

/** Buy and sell as a pill: the words carry the meaning, the colour is the token's gain or loss. */
export function sidePill(side) {
  const buy = side === "BUY";
  return h("span", { class: `ob-side ${buy ? "buy" : "sell"}` }, buy ? "Buy" : side === "SELL" ? "Sell" : DASH);
}

/** A status pill: dot for ok, bad and warn (app.js pill); working orders get the accent dot here. */
function statusPill(status) {
  const s = orderStatusLook(status);
  const p = pill(s.text, s.tone);
  if (s.tone === "info") p.prepend(h("span", { class: "pdot", "aria-hidden": "true" }));
  return p;
}

/** Keep keyboard focus on the same control across a redraw (rows are rebuilt when a poll brings new data). */
function keepFocusIn(container, fn) {
  const id = container.contains(document.activeElement) ? document.activeElement?.dataset?.fid : null;
  fn();
  if (id) container.querySelector(`[data-fid="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

/** A segmented control (the shell's) whose buttons can show a count that changes. */
function filterControl(label, options, value, onPick) {
  const seg = shell.segmented(label, options.map(([v, text]) => [v, text]), value);
  const counts = new Map();
  for (const b of seg.querySelectorAll("button")) {
    const n = h("span", { class: "ob-n" });
    b.append(n);
    counts.set(b.dataset.value, n);
  }
  seg.addEventListener("change", () => onPick(seg.value));
  return {
    el: seg,
    set(v) {
      if (seg.value !== v) seg.value = v;
    },
    counts(c) {
      for (const [v, el] of counts) el.textContent = c && c[v] !== undefined && c[v] > 0 ? formatInt(c[v]) : "";
    },
  };
}

/** A search box with the clear button the design system draws. */
function searchBox({ label, placeholder, onInput }) {
  const input = h("input", { type: "search", class: "ob-search", placeholder, "aria-label": label, autocomplete: "off", spellcheck: "false" });
  const clear = h("button", { type: "button", class: "icon-btn clear", "aria-label": "Clear search", onclick: () => ((input.value = ""), onInput(""), input.focus()) }, icon("close"));
  input.addEventListener("input", () => onInput(input.value));
  return {
    input,
    el: h("div", { class: "search-field ob-search-field" }, icon("search"), input, clear),
    reset() {
      input.value = "";
    },
  };
}

const sub = (...parts) => parts.filter(Boolean).join(" · ");

/** The row's own time: the clock in IST, and how long ago under it. */
function timeCell(iso) {
  return h("div", { class: "ob-time", title: iso ?? undefined }, h("span", { class: "ob-main" }, istTime(iso)), h("span", { class: "ob-sub ob-ago" }, ago(iso) ?? ""));
}

// ── Pending confirmations ──

const declined = () => {
  try {
    return new Set(JSON.parse(session.get(DECLINED) ?? "[]"));
  } catch {
    return new Set();
  }
};
const decline = (id) => session.set(DECLINED, JSON.stringify([...declined(), id].slice(-50)));

const lotsText = (o) => (o.lots ? `${formatInt(o.lots)} lot${Number(o.lots) === 1 ? "" : "s"}` : `${formatInt(o.quantity)} qty`);

/** One ticket: every field of the order, who prepared it, how long it has left and the Decline / Review pair. */
function ticketCard(t, byId, { review, onDecline }) {
  const o = t.order ?? {};
  const live = o.mode === "live";
  const blocked = (t.checks ?? []).some((c) => c?.severity === "block");
  const src = ticketSource(t);
  const acc = byId.get(o.account);
  const life = ticketLife(t);
  const money = (v) => (isFigure(v) ? formatRupee(v, 2) : DASH);
  const marketish = o.orderType === "MARKET" || o.orderType === "SL-M";
  const fields = [
    ["Account", acc ? acc.label : (o.account ?? DASH), acc ? `${o.account} · ${acc.broker ?? ""}` : null],
    ["Quantity", o.lots ? `${formatInt(o.lots)} lot${Number(o.lots) === 1 ? "" : "s"}` : formatInt(o.quantity), null],
    ["Order type", orderTypeText(o.orderType) || DASH, null],
    ["Price", marketish && !isFigure(o.price) ? "At market" : money(o.price), null],
    isFigure(o.triggerPrice) ? ["Trigger price", money(o.triggerPrice), null] : null,
    ["Product", productText(o.product) || DASH, null],
    ["Validity", o.validity ?? "DAY", null],
    ["Symbol", o.symbol ?? DASH, null, "mono"],
    o.tag ? ["Tag", String(o.tag), null] : null,
  ].filter(Boolean);
  const lifeText = h("span", { class: "ob-life-text", "aria-hidden": "true" }, life.text);
  const lifeBar = h("span");
  lifeBar.style.width = `${Math.round(life.share * 100)}%`;
  const reviewBtn = h("button", { type: "button", class: "primary ob-review", disabled: blocked || life.over, "aria-label": `${blocked ? "Blocked" : "Review and confirm"} ${o.side === "BUY" ? "buy" : "sell"} ${contractName(o.symbol)}`, onclick: () => review(t) }, blocked ? "Blocked" : life.over ? "Expired" : "Review and confirm");
  const el = h(
    "article",
    { class: `card ob-ticket${live ? " live" : ""}${life.over ? " over" : ""}`, "data-ticket": t.ticketId, "data-expires": t.expiresAt ?? "", "data-created": t.createdAt ?? "", "aria-label": `Pending ${o.side === "BUY" ? "buy" : "sell"} ${contractName(o.symbol)}` },
    h(
      "header",
      { class: "ob-ticket-head" },
      h(
        "div",
        { class: "ob-ticket-title" },
        sidePill(o.side),
        h("h3", { title: o.symbol }, contractName(o.symbol)),
        live ? pill("Live, real money", "bad") : pill("Paper"),
      ),
      h("p", { class: "ob-ticket-from" }, `${lotsText(o)} · ${orderTypeText(o.orderType)}${isFigure(o.price) ? ` at ${money(o.price)}` : ""}`),
      h("p", { class: "ob-ticket-from muted" }, sub(`Prepared by ${src.kind}`, src.label ? `"${src.label}"` : null, ago(t.createdAt))),
      h("div", { class: `ob-life ${life.level}` }, lifeText, h("div", { class: `bar ${life.level === "ok" ? "" : life.level}`.trim(), "aria-hidden": "true" }, lifeBar)),
    ),
    h(
      "dl",
      { class: "ob-fields" },
      ...fields.flatMap(([k, v, note, cls]) => [h("div", { class: k === "Account" || k === "Symbol" ? "ob-field wide" : "ob-field" }, h("dt", {}, k), h("dd", { class: cls }, v, note ? h("span", { class: "ob-sub" }, note) : null))]),
      h("div", { class: "ob-field ob-value" }, h("dt", {}, "Estimated value"), h("dd", {}, isFigure(t.estimatedValue) ? formatRupeeGrouped(t.estimatedValue, 2) : DASH)),
    ),
    (t.checks ?? []).length
      ? h(
          "div",
          { class: "ob-checks stack" },
          ...(t.checks ?? []).map((c) => {
            const block = c?.severity === "block";
            return h("div", { class: `alert ${block ? "bad" : "warn"}`, role: "note" }, icon("warn"), h("div", {}, h("strong", {}, block ? "Blocked" : "Check"), h("span", { class: "detail" }, c?.message ?? c?.code ?? "")));
          }),
        )
      : null,
    h(
      "footer",
      { class: "ob-ticket-acts" },
      h("button", { type: "button", class: "quiet ob-decline", "aria-label": `Decline ${o.side === "BUY" ? "buy" : "sell"} ${contractName(o.symbol)}`, onclick: () => onDecline(t) }, "Decline"),
      reviewBtn,
    ),
  );
  return el;
}

/**
 * The Pending confirmations block: a card per ticket (or one calm line when nothing waits), with a countdown that ticks
 * once a second and disables a ticket that ran out. `update(tickets)` redraws only when the list changed.
 * @returns {{ el: HTMLElement, update: (tickets: object[]|null, error?: object|null) => void }}
 */
export function pendingSection({ tickets, error, byId, review, setup, retry }) {
  const el = h("section", { class: "sec ob-pending", "aria-label": "Pending confirmations", "data-fixed": "" });
  const live = h("p", { class: "sr-only", role: "status", "aria-live": "polite" });
  let signature = null;
  let shown = [];
  const onDecline = (t) => {
    decline(t.ticketId);
    draw(shown);
    toast("Declined. Nothing was sent; the request expires on its own.", { tone: "info" });
  };
  const quiet = (err) =>
    h(
      "div",
      { class: "card ob-quiet" },
      iconTile(err ? "warn" : "inbox", err ? "gray" : "orange", "md"),
      h("div", { class: "ob-quiet-text" }, h("strong", {}, err ? "Could not read pending confirmations" : "Nothing is waiting for you"), h("p", {}, err ? (err.message ?? "The Bridge did not answer.") : "When an AI assistant or a webhook that needs a person prepares an order, it waits here until you check it and confirm. Nothing is sent before that.")),
      err ? h("button", { type: "button", class: "small", onclick: retry }, "Try again") : setup,
    );
  function draw(list) {
    const gone = declined();
    shown = list.filter((t) => !gone.has(t.ticketId));
    keepFocusIn(el, () => {
      if (!shown.length) {
        el.replaceChildren(quiet(null), live);
        live.textContent = "";
        return;
      }
      const n = shown.length;
      el.replaceChildren(
        h("header", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", {}, "Waiting for your confirmation"), h("p", {}, "Check every field. Nothing is sent until you confirm, and a request that is not confirmed in time expires on its own.")), h("div", { class: "sec-acts" }, h("span", { class: "pill info" }, `${formatInt(n)} waiting`))),
        h("div", { class: "ob-tickets" }, ...shown.map((t) => ticketCard(t, byId, { review, onDecline }))),
        live,
      );
      live.textContent = `${n} order${n === 1 ? "" : "s"} waiting for your confirmation`;
    });
  }
  function tick() {
    for (const c of el.querySelectorAll(".ob-ticket")) {
      const life = ticketLife({ createdAt: c.dataset.created, expiresAt: c.dataset.expires });
      const text = c.querySelector(".ob-life-text");
      if (text && text.textContent !== life.text) text.textContent = life.text;
      const box = c.querySelector(".ob-life");
      if (box) box.className = `ob-life ${life.level}`;
      const bar = c.querySelector(".ob-life .bar");
      if (bar) {
        bar.className = `bar ${life.level === "ok" ? "" : life.level}`.trim();
        bar.firstElementChild.style.width = `${Math.round(life.share * 100)}%`;
      }
      if (life.over && !c.classList.contains("over")) {
        c.classList.add("over");
        const b = c.querySelector(".ob-review");
        if (b) {
          b.disabled = true;
          b.textContent = "Expired";
        }
      }
    }
  }
  const timer = setInterval(() => (el.isConnected ? tick() : clearInterval(timer)), 1000);
  const sign = (list) => JSON.stringify(list.map((t) => [t.ticketId, t.expiresAt, (t.checks ?? []).length])) + [...declined()].join();
  if (error) el.replaceChildren(quiet(error));
  else {
    signature = sign(tickets ?? []);
    draw(tickets ?? []);
  }
  return {
    el,
    update(next, err = null) {
      if (err || next === null) return;
      const s = sign(next);
      if (s === signature) return;
      signature = s;
      draw(next);
    },
  };
}

// ── Today's orders ──

const curlExample = (account) =>
  [`curl -X POST ${location.origin}/v1/orders \\`, `  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\`, `  -d '{"account":"${account}","symbol":"NSE:RELIANCE","side":"BUY",`, `       "quantity":1,"product":"CNC","orderType":"MARKET","mode":"paper"}'`].join("\n");

/** The menu behind a row's three dots: Modify and Cancel while it works, Copy order id always. */
function rowMenu(o, { modify, cancel }) {
  const name = contractName(o.symbol);
  const working = ["pending", "open", "trigger_pending", "partially_filled"].includes(o.status);
  const btn = h("button", { type: "button", class: "icon-btn ob-more", "data-fid": `menu:${o.orderId}`, "aria-haspopup": "dialog", "aria-expanded": "false", "aria-label": `Actions for ${o.side === "BUY" ? "buy" : "sell"} ${name}, ${o.quantity != null ? `${o.quantity} qty, ` : ""}${istTime(o.placedAt)}` }, icon("more"));
  btn.addEventListener("click", () => {
    btn.setAttribute("aria-expanded", "true");
    let handle = null;
    const item = (label, note, fn, cls = "") => h("button", { type: "button", class: `menu-item${cls}`, onclick: () => (handle?.close(), setTimeout(fn, 0)) }, label, note ? h("small", {}, note) : null);
    const items = [
      working ? item("Modify", "Change the quantity or price", modify) : null,
      working ? item("Cancel order", "Withdraw the unfilled part", cancel, " destructive") : null,
      item("Copy order id", o.orderId, () => copyText(o.orderId, "Order id copied")),
    ].filter(Boolean);
    handle = sheetPopover({ trigger: btn, title: `${o.side === "BUY" ? "Buy" : "Sell"} ${name}`, body: h("div", { class: "menu-list" }, items), cls: "menu-pop" });
  });
  return btn;
}

/** The price a person looks for: what it filled at, else the limit, else "Market"; the order type under it. */
function priceCell(o) {
  const filled = Number(o.filledQuantity) > 0 && isFigure(o.avgPrice) && Number(o.avgPrice) > 0;
  const limit = isFigure(o.price) && Number(o.price) > 0;
  const main = filled ? formatFixed(o.avgPrice, 2) : limit ? formatFixed(o.price, 2) : o.orderType === "MARKET" || o.orderType === "SL-M" ? "Market" : DASH;
  const trig = isFigure(o.triggerPrice) && Number(o.triggerPrice) > 0 ? `trigger ${formatFixed(o.triggerPrice, 2)}` : null;
  return h("div", { class: "ob-num" }, h("span", { class: "ob-main" }, main), h("span", { class: "ob-sub" }, sub(main === "Market" ? null : orderTypeText(o.orderType), filled ? "avg" : null, trig)));
}

function orderRow(o, { labelOf, actions }) {
  const rejected = ["rejected", "expired", "outcome_unknown"].includes(o.status);
  const msg = o.statusMessage && (rejected || (o.status === "cancelled" && !/by request/i.test(o.statusMessage))) ? o.statusMessage : null;
  const fix = msg || o.status === "outcome_unknown" ? whatToDo({ code: o.status === "outcome_unknown" ? "OUTCOME_UNKNOWN" : null, message: msg ?? "", mode: o.mode }) : null;
  return h(
    "div",
    { class: `ob-row ob-order ${rejected ? "refused" : ""}`.trim(), role: "row", "data-status": o.status },
    h("div", { class: "ob-cell c-time", role: "cell" }, timeCell(o.placedAt)),
    h(
      "div",
      { class: "ob-cell c-contract", role: "cell" },
      h("div", { class: "ob-name", title: o.symbol }, h("strong", {}, contractName(o.symbol)), o.mode === "live" ? pill("Live", "bad") : null),
      h("span", { class: "ob-sub" }, sub(labelOf(o.accountId), productText(o.product), o.tag ? `tag ${o.tag}` : null)),
    ),
    h("div", { class: "ob-cell c-side", role: "cell" }, sidePill(o.side)),
    h("div", { class: "ob-cell c-qty num", role: "cell" }, h("span", { class: "ob-main" }, qtyText(o)), h("span", { class: "ob-sub ob-unit" }, "qty")),
    h("div", { class: "ob-cell c-price num", role: "cell" }, priceCell(o)),
    h("div", { class: "ob-cell c-status", role: "cell" }, statusPill(o.status)),
    h("div", { class: "ob-cell c-act", role: "cell" }, rowMenu(o, actions(o))),
    msg || fix
      ? h("div", { class: "ob-why", role: "cell" }, icon("info"), h("div", {}, msg ? h("p", {}, msg) : null, fix ? h("p", { class: "ob-fix" }, fix) : null))
      : null,
  );
}

const ordersHead = () =>
  h(
    "div",
    { class: "ob-row ob-headrow", role: "row" },
    ...[["Time", "c-time"], ["Contract", "c-contract"], ["Side", "c-side"], ["Qty", "c-qty num"], ["Price", "c-price num"], ["Status", "c-status"], ["Actions", "c-act sr-only"]].map(([t, c]) => h("div", { class: `ob-cell ${c}`, role: "columnheader" }, t)),
  );

/**
 * Today's orders: status and side filters, a search, a row menu and Cancel all (when something is working).
 * `actions(o)` gives { modify, cancel } for the row menu. `update(list)` redraws with fresh orders, keeping the filters.
 * @param {{ ord: object[], error: object|null, byId: Map<string, { label: string, id: string, broker?: string }>, actions: (o: object) => { modify: () => void, cancel: () => void }, refresh: () => void, send: () => void }} o
 */
export function ordersBook({ ord, error, byId, actions, refresh, send, canSend = true }) {
  const f = loadFilters();
  const labelOf = (id) => byId.get(id)?.label ?? id;
  let list = ord;
  let counts = orderCounts(list);
  const status = filterControl("Status", ORDER_FILTERS, f.status, (v) => ((f.status = v), saveFilters(f), draw()));
  const side = filterControl("Side", [["all", "Both"], ["BUY", "Buy"], ["SELL", "Sell"]], f.side, (v) => ((f.side = v), saveFilters(f), draw()));
  const search = searchBox({ label: "Search orders by contract, order id, tag or account", placeholder: "Search orders", onInput: (v) => ((f.q = v), draw()) });
  const body = h("div", { class: "ob-body" });
  const bar = h("div", { class: "ob-bar" }, status.el, side.el, search.el);

  // Cancel all: shown from the page's own open orders at once, then from a dry run's count of both groups, so orders
  // placed outside the Bridge (in the broker's app) show it too.
  const cancelAll = h("span", { class: "ob-cancel-slot" });
  let groups = null;
  const drawCancelAll = () => {
    const b = cancelAllButton(openByMode(list).total, groups);
    cancelAll.replaceChildren(b.show ? h("button", { type: "button", class: "small tinted destructive", onclick: () => cancelAllFlow(labelOf).then((report) => report && showReport(report, refresh)) }, icon("close"), b.label) : "");
  };
  const askDryRun = () =>
    buttonDryRun(() => optional(api("/v1/orders/cancel-all", { method: "POST", body: { dryRun: true } })), { epoch: writeCount() }).then((r) => {
      if (!r.error) {
        groups = cancelAllGroups(r.data?.data);
        drawCancelAll();
      }
    });
  drawCancelAll();
  askDryRun();

  const firstPaper = [...byId.values()].find((a) => a.broker === "paper")?.id ?? [...byId.keys()][0] ?? "demo-paper";
  const empty = () =>
    h(
      "div",
      { class: "empty ob-empty" },
      iconTile("orders", "gray", "lg"),
      h("strong", {}, "No orders today"),
      canSend
        ? h("p", {}, "Orders placed through the API, a webhook or an AI assistant show up here as they happen. To try one without risk, send a paper order.")
        : h("p", {}, "Orders show up here as they happen. A paper order needs prices to check it against, and no broker or demo is connected yet."),
      canSend
        ? h("div", { class: "empty-acts" }, h("button", { type: "button", class: "primary small", onclick: send }, "Send a paper order"))
        : h("div", { class: "empty-acts" }, h("a", { class: "btn primary small", href: "#/accounts" }, "Add a broker or run demo")),
      canSend ? h("div", { class: "ob-empty-code" }, codeBlock(curlExample(firstPaper), { title: "Or place one with the API (paper)" })) : null,
    );
  const quiet = (err) => h("div", { class: "card-body" }, alertBox(err), h("div", { class: "alert-actions ob-retry" }, h("button", { type: "button", class: "small", onclick: refresh }, "Try again")));

  function draw() {
    status.set(f.status);
    side.set(f.side);
    status.counts(counts);
    const rows = filterOrders(list, { ...f, labelOf });
    keepFocusIn(body, () => {
      if (error) body.replaceChildren(quiet(error));
      else if (!list.length) body.replaceChildren(empty());
      else if (!rows.length) body.replaceChildren(emptyState("orders", "No orders match", "Change the filters above, or clear the search.", h("button", { type: "button", class: "small", onclick: () => ((f.status = "all"), (f.side = "all"), (f.q = ""), search.reset(), saveFilters(f), draw()) }, "Show all"), { compact: true }));
      else body.replaceChildren(h("div", { class: "ob-table", role: "table", "aria-label": "Today's orders" }, ordersHead(), h("div", { class: "ob-rows", role: "rowgroup" }, ...rows.map((o) => orderRow(o, { labelOf, actions })))));
    });
    bar.hidden = Boolean(error) || !list.length;
    sendBtn.hidden = !list.length || !canSend;
  }
  const sendBtn = h("button", { type: "button", class: "small primary", onclick: send }, icon("plus"), "Send a paper order");
  draw();

  const el = card({
    glyph: "orders",
    tint: "orange",
    title: "Today's orders",
    sub: "Placed through the Bridge, newest first.",
    cls: "ob-orders",
    actions: h("div", { class: "row ob-card-acts" }, cancelAll, sendBtn),
    flush: true,
    body: h("div", {}, bar, body),
  });
  el.dataset.fixed = "";
  let sig = "";
  const signature = (l) => `${Math.floor(Date.now() / 60_000)}|${l.map((o) => `${o.orderId}:${o.status}:${o.filledQuantity ?? ""}:${o.price ?? ""}:${o.quantity ?? ""}`).join(",")}`;
  sig = signature(list);
  return {
    el,
    update(next) {
      if (!next) return;
      const s = signature(next);
      if (s === sig) return;
      // Leave a sheet or a menu alone while it is open: the next poll catches up.
      if (document.getElementById("dialog")?.open || document.querySelector(".popover")) return;
      const before = openByMode(list).total;
      sig = s;
      list = next;
      counts = orderCounts(list);
      draw();
      if (openByMode(list).total !== before) askDryRun();
      else drawCancelAll();
    },
  };
}

/** Redraw the page, then say what Cancel all did: the redraw hides any toast, so the report goes up after it starts. */
function showReport(report, refresh) {
  refresh();
  if (report.text) toast(report.text, { tone: report.tone });
}

/** One open order in Cancel all's lists: side, contract, account and mode, quantity at the end. */
function cancelRow(o, labelOf) {
  return h(
    "li",
    { class: "ca-row" },
    sidePill(o.side),
    h("div", { class: "ca-what" }, h("strong", {}, o.symbol ? contractName(o.symbol) : o.orderId), h("span", { class: "ob-sub" }, `${labelOf(o.accountId)} · ${o.mode === "live" ? "live" : "paper"}`)),
    h("span", { class: "ca-qty" }, o.quantity ? `${formatInt(o.quantity)} qty` : ""),
  );
}
function cancelList(rows, labelOf) {
  const shown = rows.slice(0, 6);
  return h("ul", { class: "ca-list" }, ...shown.map((o) => cancelRow(o, labelOf)), rows.length > shown.length ? h("li", { class: "ca-more" }, `and ${formatInt(rows.length - shown.length)} more`) : null);
}

/**
 * Cancel the working orders on the accounts this key may use, after one question that counts and lists both groups:
 * orders the Bridge placed (cancelled), and live orders placed outside the Bridge, in the broker's app (left open
 * unless the trader ticks the box). The request body matches the choice. Resolves the report ({ text, tone }: what
 * each group got) or null when nothing was sent.
 */
async function cancelAllFlow(labelOf = (id) => id) {
  const dry = await optional(api("/v1/orders/cancel-all", { method: "POST", body: { dryRun: true } }));
  if (dry.error) {
    toast(`Could not read the open orders: ${dry.error.message ?? "refused"}`, { tone: "error" });
    return null;
  }
  const g = cancelAllGroups(dry.data?.data);
  if (!g.total) return { text: "No open orders to cancel", tone: "info" };
  const ours = g.bridge.length;
  const theirs = g.external.length;
  const also = theirs ? h("input", { type: "checkbox" }) : null;
  const ok = await modal({
    title: cancelAllTitle(g),
    body: h(
      "div",
      { class: "stack ca-body" },
      h("p", { class: "ca-lead" }, "The unfilled part of each order is withdrawn. What already filled stays in Positions. Cancelled orders cannot be brought back from here."),
      ours
        ? h("section", { class: "ca-group" }, h("h3", { class: "ca-head" }, `Placed through the Bridge · ${formatInt(ours)}`), h("p", { class: "ob-sub" }, cancelAllBridgeLine(g)), cancelList(g.bridge, labelOf))
        : null,
      theirs
        ? h(
            "section",
            { class: "ca-group" },
            h("h3", { class: "ca-head" }, `Placed outside the Bridge · ${formatInt(theirs)}`),
            h("p", { class: "ob-sub" }, "In your broker's app or terminal, such as a stop-loss you set there. Left open unless you tick the box."),
            cancelList(g.external, labelOf),
            h("label", { class: "check ca-also" }, also, `Also cancel ${formatInt(theirs)} order${theirs === 1 ? "" : "s"} placed outside the Bridge`),
          )
        : null,
    ),
    buttons: [
      { label: "Keep them", value: false },
      { label: ours + (also ? theirs : 0) === 1 ? "Cancel 1 order" : "Cancel orders", cls: "destructive", value: true },
    ],
  });
  if (!ok) return null;
  const r = await optional(api("/v1/orders/cancel-all", { method: "POST", body: cancelAllBody(also?.checked === true) }));
  if (r.error) {
    toast(`Not cancelled: ${r.error.message ?? "refused"}`, { tone: "error" });
    return null;
  }
  return cancelAllReport(r.data?.data);
}

// ── Funds ──

/** Rupees in whole numbers with an explicit sign and the gain or loss colour. */
function signedRupee(v) {
  if (!isFigure(v)) return DASH;
  const text = formatRupeeGrouped(v, 0);
  const n = Number(v);
  const zero = text === "₹0";
  return h("span", { class: zero ? undefined : n > 0 ? "up" : "down" }, n > 0 && !zero ? `+${text}` : text);
}

function fundCard({ a, f, v, error, open }) {
  const level = v.level === "neg" ? "bad" : v.level === "none" ? "" : v.level;
  const bar = h("span");
  bar.style.width = `${Math.round((v.util ?? 0) * 100)}%`;
  const stat = (label, value) => h("div", { class: "ob-fstat" }, h("dt", {}, label), h("dd", {}, value));
  return h(
    "article",
    { class: "card ob-fund", "aria-label": `Funds for ${a.label}` },
    h("header", { class: "ob-fund-head" }, iconTile("wallet", "teal", "md"), h("div", { class: "ob-fund-names" }, h("h3", {}, a.label), h("span", { class: "ob-sub" }, a.broker === "paper" ? "Paper account" : `${a.broker} · as the broker reports it`))),
    error
      ? h("div", { class: "ob-fund-error" }, h("p", {}, "Funds are not available right now."), h("p", { class: "ob-sub" }, error.message ?? ""), h("button", { type: "button", class: "small", onclick: () => (location.hash = "#/accounts") }, "Check the account"))
      : h(
          "div",
          { class: "ob-fund-body" },
          h("div", { class: "ob-avail" }, h("span", { class: "ob-sub" }, "Available to trade"), h("strong", {}, formatRupeeGrouped(v.available, 0))),
          v.util === null
            ? null
            : h(
                "div",
                { class: "ob-margin", title: `${formatPercent(v.util * 100, 1)} of ${formatRupeeGrouped(v.total, 0)} is blocked as margin` },
                h("div", { class: "ob-margin-line" }, h("span", {}, "Margin used"), h("span", { class: "ob-main" }, `${formatRupeeGrouped(v.used, 0)} · ${formatPercent(v.util * 100, 0)}`)),
                h("div", { class: `bar ${level}`.trim(), role: "img", "aria-label": `${formatPercent(v.util * 100, 0)} of margin used` }, bar),
              ),
          h("dl", { class: "ob-fstats" }, stat("Realised", signedRupee(f?.realisedPnl)), stat("Unrealised", signedRupee(f?.unrealisedPnl)), stat("Open positions", formatInt(open)), v.collateral === null ? null : stat("Collateral", formatRupeeGrouped(v.collateral, 0))),
        ),
    error ? null : h("footer", { class: "ob-fund-foot" }, h("button", { type: "button", class: "plain small", "aria-label": `Positions of ${a.label}`, onclick: () => (location.hash = "#/positions") }, "Positions", icon("chevron"))),
  );
}

/**
 * Funds for every account: a card each with what is free to trade, the margin in use (a bar), realised and unrealised P&L
 * and open positions. Paper accounts read the paper engine; a broker account reads the broker (one funds and one
 * positions call each), and says why when it cannot. Returns at once with placeholders; the cards fill in as they answer.
 * @param {Array<{ id: string, label: string, broker: string }>} accs
 * @returns {HTMLElement|null}
 */
export function fundsSection(accs) {
  const list = accs.filter((a) => a.broker !== "demo");
  if (!list.length) return null;
  const grid = h("div", { class: "ob-funds" }, ...list.map(() => skeletonCard(3)));
  const el = h("section", { class: "sec ob-funds-sec", "aria-label": "Funds", "data-fixed": "" }, h("header", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", {}, "Funds"), h("p", {}, "What is free to trade, the margin in use and today's P&L, per account. Paper from the paper engine; a broker account as the broker reports it."))), grid);
  Promise.all(
    list.map(async (a) => {
      const [funds, pos] = await Promise.all([optional(api(`/v1/funds?account=${encodeURIComponent(a.id)}`)), optional(api(`/v1/positions?account=${encodeURIComponent(a.id)}`))]);
      const f = funds.data?.data?.funds ?? funds.data?.data ?? null;
      const items = pos.data?.data ?? null;
      return { a, f, v: fundsView(f), error: funds.error ?? null, open: items ? items.filter((p) => Number(p.netQty) !== 0).length : null };
    }),
  ).then((rows) => grid.replaceChildren(...rows.map(fundCard)));
  return el;
}

// ── Orders › Trades ──

/** Download text as a file (a Blob and a link; nothing leaves the browser). */
function download(name, text, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const tradeValue = (t) => (Number(t.qty ?? t.quantity) || 0) * (Number(t.price) || 0);

function tradeRow(t, labelOf) {
  const c = fillCharges(t);
  return h(
    "div",
    { class: "ob-row ob-trade", role: "row" },
    h("div", { class: "ob-cell c-time", role: "cell" }, h("div", { class: "ob-time", title: t.tradedAt }, h("span", { class: "ob-main" }, istTime(t.tradedAt)))),
    h("div", { class: "ob-cell c-contract", role: "cell" }, h("div", { class: "ob-name", title: t.symbol }, h("strong", {}, contractName(t.symbol))), h("span", { class: "ob-sub" }, sub(labelOf(t.accountId), productText(t.product)))),
    h("div", { class: "ob-cell c-side", role: "cell" }, sidePill(t.side)),
    h("div", { class: "ob-cell c-qty num", role: "cell" }, h("span", { class: "ob-main" }, formatInt(t.qty ?? t.quantity)), h("span", { class: "ob-sub ob-unit" }, "qty")),
    h("div", { class: "ob-cell c-price num", role: "cell" }, h("span", { class: "ob-main" }, formatFixed(t.price, 2))),
    h("div", { class: "ob-cell c-value num", role: "cell" }, h("span", { class: "ob-main" }, formatRupee(tradeValue(t), 2))),
    h("div", { class: "ob-cell c-charges num", role: "cell" }, c ? h("span", { class: "ob-main", title: "Estimated charges for this fill" }, `≈ ${formatRupee(c.total, 2)}`) : h("span", { class: "empty-dash", title: "Charges are estimated for futures and options only" }, DASH)),
    h("div", { class: "ob-cell c-order", role: "cell" }, h("span", { class: "ob-id", title: t.orderId }, t.orderId)),
  );
}

const tradesHead = () =>
  h(
    "div",
    { class: "ob-row ob-headrow", role: "row" },
    ...[["Time", "c-time"], ["Contract", "c-contract"], ["Side", "c-side"], ["Qty", "c-qty num"], ["Price", "c-price num"], ["Value", "c-value num"], ["Charges (est.)", "c-charges num"], ["Order", "c-order"]].map(([t, c]) => h("div", { class: `ob-cell ${c}`, role: "columnheader" }, t)),
  );

/** Orders › Trades: every fill on the accounts this key may use, newest first, by day, with totals and a CSV. */
export async function renderTradesPage() {
  const [trades, accounts] = await Promise.all([optional(api("/v1/trades?limit=500")), optional(api("/v1/accounts"))]);
  const byId = new Map((accounts.data?.data ?? []).map((a) => [a.id, a]));
  const labelOf = (id) => byId.get(id)?.label ?? id;
  const list = [...(trades.data?.data ?? [])].sort((a, b) => Date.parse(b.tradedAt) - Date.parse(a.tradedAt));
  const f = { side: "all", q: "" };
  const stats = h("div", { class: "ob-stats" });
  const body = h("div", { class: "ob-body" });
  const side = filterControl("Side", [["all", "Both"], ["BUY", "Buy"], ["SELL", "Sell"]], f.side, (v) => ((f.side = v), draw()));
  const search = searchBox({ label: "Search trades by contract, order id or account", placeholder: "Search trades", onInput: (v) => ((f.q = v), draw()) });
  let shown = list;
  const exportBtn = h(
    "button",
    {
      type: "button",
      class: "small",
      disabled: !list.length,
      onclick: () => {
        const day = istDayOf(Date.now());
        download(`trades-${day}.csv`, tradesCsv(shown, { labelOf, chargesOf: fillCharges, timeOf: (iso) => `${istDayOf(iso)} ${istTime(iso)}` }));
        toast(`Exported ${formatInt(shown.length)} trade${shown.length === 1 ? "" : "s"}`);
      },
    },
    icon("download"),
    "Export CSV",
  );
  const stat = (label, value, subText, tip) => h("div", { class: "card stat ob-stat" }, h("div", { class: "stat-head" }, h("span", { class: "label", title: tip }, label)), h("div", { class: "value" }, value), h("div", { class: "sub" }, subText));
  const today = () => istDayOf(Date.now());

  function draw() {
    side.set(f.side);
    shown = filterTrades(list, { ...f, labelOf });
    exportBtn.disabled = !shown.length;
    const t = fillTotals(shown);
    const buys = shown.filter((x) => x.side === "BUY").length;
    const priced = t.count - t.unpriced;
    stats.replaceChildren(
      stat("Fills", formatInt(t.count), `${formatInt(buys)} buy · ${formatInt(t.count - buys)} sell`),
      stat("Turnover", formatRupeeGrouped(t.turnoverValue, 0), `Bought ${formatRupeeGrouped(t.buyValue, 0)} · Sold ${formatRupeeGrouped(t.sellValue, 0)}`),
      stat("Charges (estimate)", priced ? `≈ ${formatRupeeGrouped(t.charges.total, 2)}` : DASH, priced ? `For ${formatInt(priced)} futures and options fill${priced === 1 ? "" : "s"}. Your broker's contract note is final.` : "Estimated for futures and options only.", "Brokerage, STT, exchange, SEBI, stamp duty and GST"),
    );
    if (!list.length) {
      body.replaceChildren(
        h("div", { class: "empty ob-empty" }, iconTile("list", "gray", "lg"), h("strong", {}, "No trades yet"), h("p", {}, "Every fill shows up here, grouped by day, with an estimate of the charges. Place a paper order and it fills here when it trades."), h("div", { class: "empty-acts" }, h("button", { type: "button", class: "primary small", onclick: () => (location.hash = "#/api/console?endpoint=order") }, "Send a paper order"))),
      );
      return;
    }
    if (!shown.length) {
      body.replaceChildren(emptyState("orders", "No trades match", "Change the side, or clear the search.", h("button", { type: "button", class: "small", onclick: () => ((f.side = "all"), (f.q = ""), search.reset(), draw()) }, "Show all"), { compact: true }));
      return;
    }
    const groups = groupByDay(shown, istDayOf);
    body.replaceChildren(
      h(
        "div",
        { class: "ob-table ob-trades", role: "table", "aria-label": "Trade book" },
        tradesHead(),
        ...groups.map((g) => {
          const gt = fillTotals(g.rows);
          return h(
            "div",
            { class: "ob-day", role: "rowgroup" },
            h("div", { class: "ob-dayhead", role: "row" }, h("h3", { role: "cell" }, dayHeading(g.day, today())), h("span", { class: "ob-sub", role: "cell" }, `${formatInt(gt.count)} fill${gt.count === 1 ? "" : "s"} · ${formatRupeeGrouped(gt.turnoverValue, 0)} traded`)),
            ...g.rows.map((r) => tradeRow(r, labelOf)),
          );
        }),
      ),
    );
  }
  draw();
  const head = h("div", { class: "ob-bar" }, side.el, search.el, h("span", { class: "ob-bar-end" }, exportBtn));
  head.hidden = Boolean(trades.error) || !list.length;
  if (trades.error)
    return [
      card({
        glyph: "list",
        tint: "orange",
        title: "Trade book",
        flush: true,
        cls: "ob-trades-card",
        body: h("div", { class: "card-body" }, alertBox(trades.error), h("div", { class: "alert-actions ob-retry" }, h("button", { type: "button", class: "small", onclick: () => location.reload() }, "Reload"))),
      }),
    ];
  const out = [
    h("div", { class: "ob-trades-top", "data-fixed": "" }, stats),
    card({ glyph: "list", tint: "orange", title: "Trade book", sub: "Every fill, newest first. Charges are estimates for futures and options.", cls: "ob-trades-card ob-orders", flush: true, body: h("div", {}, head, body) }),
  ];
  out[1].dataset.fixed = "";
  return out;
}
