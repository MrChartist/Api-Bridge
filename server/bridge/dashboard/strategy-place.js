// Safe strategy placement (PRD 02 §11): a confirm sheet that never sends by itself, then a small state machine that
// legs in hedges first. Each hedge (option buys, then futures) is polled until it is filled before the next leg goes;
// option sells go last. A hedge that does not fill in time pauses with three explicit choices, and a stop part-way
// leaves a partial state with Retry / Cancel open / Unwind filled / Keep. An unknown outcome is looked up by its client
// order id, never resent. Orders go through POST /v1/orders like every other client, so the Bridge's gates apply.
import { api, h, modal, optional } from "./app.js";
import { DASH, formatFixed, formatInt, isFigure } from "./format.js";
import { money, moneyEl } from "./payoff.js";
import * as O from "./options.js";
import { segField, segmented } from "./views.js";
import { basketMarginBody, basketProgress, expandSlices, orderLimitsOf, orderRows, sliceNotes } from "./basket-core.js";

const TERMINAL = new Set(["filled", "rejected", "cancelled", "expired"]);
/** Server messages print Indian digit grouping (3 lakh as 3,00,000); the dashboard never shows grouping commas. */
const ungroup = (t) => (t === null || t === undefined ? t : String(t).replace(/(\d),(?=\d)/g, "$1"));
const STATUS_TEXT = { queued: "Queued", sending: "Sending", open: "Open", filled: "Filled", partial: "Part filled", rejected: "Rejected", cancelled: "Cancelled", expired: "Expired", unknown: "Unknown", timeout: "Not filled", skipped: "Not sent" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tickOf = (it) => (Number(it.tickSize) > 0 ? Number(it.tickSize) : 0.05);

/**
 * Open the confirm sheet. Resolves when it closes, with { placed: number } (legs that reached the exchange book).
 * @param {{ title: string, mode?: "entry"|"exit", account: object, items: object[], summary?: object, warnings?: object[],
 *   cfg: { product: string, hedgeWait: number }, onCfg?: (patch: object) => void, live?: () => boolean,
 *   onPositions?: () => void, announce?: (text: string) => void, accountRow?: (reopen: () => void) => Node,
 *   lotGate?: { needed: boolean, text: string, lots: number[] },
 *   lotGateFor?: (checks: object[]) => { needed: boolean, text: string, lots: number[] } }} o
 *   items: [{ leg, side, phase, symbol, label, lots, lotSize, price, product?, quote: () => quote|null, freezeQty? }]
 */
export function openPlacement(o) {
  const { account: a, items, mode = "entry" } = o;
  const exit = mode === "exit";
  const cfg = { ...o.cfg };
  // Rows are the orders that go out: each item split under its freeze quantity and the account's per-order lots and
  // value limits (basket-core.js; the limits come from GET /v1/safety and are only obeyed, never raised), put in send
  // order (buys first for the margin benefit, or as listed). Rebuilt when the order changes or a freeze is learned.
  const limits = new Map();
  let orderLimits = null;
  const buildRows = () =>
    orderRows(expandSlices(items.map((it, k) => ({ ...it, price: limits.get(k) ?? it.price })), orderLimits), cfg.order === "as-listed" ? "as-listed" : "buys-first", { exit }).map((it, i) => ({
      ...it,
      i,
      limit: limits.get(it.item) ?? O.roundToTick(it.price, tickOf(it), it.side === "BUY" ? "sell" : "buy"),
      status: "queued",
      order: null,
      preview: null,
      error: null,
    }));
  let rows = buildRows();
  let stopReq = false;
  const liveSeg = a.liveAllowedByConfig ? segmented("Mode", [["paper", "Paper"], ["live", "Live"]], "paper") : null;
  const ack = h("input", { type: "checkbox" });
  const ackRow = h("label", { class: "check live-ack", hidden: true }, ack, `I understand these are real orders to ${a.label}.`);
  // Lot-size confirmation, once for the basket (docs/spec/p1-02-reference.md §5.4): when the reference lot data is
  // stale or disagrees with the broker's contract, nothing is sent (or previewed) until it is ticked. The text names
  // every distinct lot among the legs, and a leg sends lotSizeConfirmed only for a lot listed there (gate.lots). A
  // LOT_SIZE_STALE in a leg's preview that the bundle did not show (a later expiry) opens the gate via lotGateFor.
  let gate = o.lotGate?.needed ? o.lotGate : null;
  const gateBox = h("input", { type: "checkbox", required: true });
  const gateText = h("span", {}, gate?.text ?? "");
  const gateRow = h("label", { class: "check lot-gate place-lotgate", hidden: !gate }, gateBox, gateText);
  const gateOk = () => !gate || gateBox.checked;
  const isLive = () => liveSeg?.value === "live";
  const prodSeg = segmented("Product", [["INTRADAY", "Intraday"], ["MARGIN", "Carry (NRML)"]], cfg.product === "INTRADAY" ? "INTRADAY" : "MARGIN");
  const waitSeg = segmented("Hedge wait", [["5", "5 s"], ["15", "15 s"], ["30", "30 s"]], String(cfg.hedgeWait ?? 15));
  const orderSeg = exit ? null : segmented("Send order", [["buys-first", "Buys first"], ["as-listed", "As listed"]], cfg.order === "as-listed" ? "as-listed" : "buys-first");
  if (orderSeg) orderSeg.title = "Buys first: each buy fills before any sell goes, so the sells get the hedge benefit on margin.";
  // The whole basket's margin before anything is sent: the paper engine's figure against this account's book.
  const marginLine = h("p", { class: "place-margin muted", role: "status" });
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  const say = (t) => {
    live.textContent = t;
    o.announce?.(t);
  };
  const moved = h("div", { class: "place-moved", hidden: true });
  const status = h("div", { class: "place-status", role: "status" });
  const actions = h("div", { class: "place-actions" });
  const legsHost = h("div", { class: "table-wrap place-legs" });
  const warnHost = h("ul", { class: "ticket-checks strat-warn-list" });
  // Why legs were split: the freeze quantity, or this account's per-order limit (said once per reason).
  const sliceHost = h("ul", { class: "ticket-checks place-slices", hidden: true, role: "note" });
  function drawSliceNotes() {
    const notes = sliceNotes(rows);
    sliceHost.hidden = !notes.length;
    sliceHost.replaceChildren(...notes.map((t) => h("li", { class: "info" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", {}, t))));
  }
  /** The account's per-order limits (maxLotsPerOrder, maxOrderValue), read once when the sheet opens. */
  async function loadOrderLimits() {
    const r = await optional(api("/v1/safety"));
    orderLimits = orderLimitsOf(r.data?.data, a.id);
  }
  let phase = "confirm"; // confirm | running | paused | done
  // While orders are going out (or a hedge waits for a choice) the sheet cannot be closed: no Escape, X or backdrop.
  const canClose = () => phase !== "running" && phase !== "paused";
  const syncClose = () => {
    const x = document.querySelector("#dialog .sheet-close");
    if (x) x.hidden = !canClose();
  };
  let pfGen = 0;
  let closeSheet = null;
  let placedCount = 0;
  const batch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  const body = (r, extra = {}) => {
    const b = { account: a.id, symbol: r.symbol, side: r.side, lots: r.lots, product: r.product ?? prodSeg.value, orderType: "LIMIT", price: r.limit, ...extra };
    if (isLive()) b.mode = "live";
    if (gate && gateBox.checked && Number(r.lotSize) > 0 && (gate.lots ?? []).includes(Number(r.lotSize))) b.lotSizeConfirmed = Number(r.lotSize);
    return b;
  };

  // ── Confirm view ──
  function legTable() {
    const showTouch = !(typeof matchMedia === "function" && matchMedia("(max-width: 719px)").matches);
    legsHost.replaceChildren(
      h(
        "table",
        { class: "desk-table place-table" },
        h("thead", {}, h("tr", {}, ["#", "Leg", "Lots", phase === "confirm" ? "Limit" : "Filled", ""].map((t, i) => h("th", { scope: "col", class: i === 2 || i === 3 ? "num" : undefined }, t)))),
        h(
          "tbody",
          {},
          rows.map((r) => {
            const qty = r.lots * r.lotSize;
            const slices = r.slices ?? 1;
            const input = h("input", { type: "number", min: "0.05", step: String(tickOf(r)), inputmode: "decimal", class: "limit-in", value: isFigure(r.limit) ? String(r.limit) : "", "aria-label": `Limit price for ${r.side === "BUY" ? "buy" : "sell"} ${r.label}` });
            input.addEventListener("input", () => {
              r.limit = isFigure(input.value) ? Number(input.value) : null;
              for (const x of rows) if (x.item === r.item && x !== r) x.limit = r.limit;
              limits.set(r.item, r.limit);
              drawButtons();
            });
            const q = () => r.quote?.() ?? null;
            const set = (v) => {
              if (!isFigure(v)) return;
              r.limit = O.roundToTick(v, tickOf(r), r.side === "BUY" ? "buy" : "sell");
              input.value = String(r.limit);
              for (const x of rows) if (x.item === r.item && x !== r) x.limit = r.limit;
              limits.set(r.item, r.limit);
              legTable();
              drawButtons();
            };
            const touch = showTouch && phase === "confirm" && !r.fut
              ? h("span", { class: "join touch-btns mini", role: "group", "aria-label": `Use a quote for ${r.label}` }, [["Bid", () => q()?.bid], ["Mid", () => O.mid(q())], ["Ask", () => q()?.ask]].map(([l, f]) => h("button", { type: "button", class: "xs", onclick: () => set(f()) }, l)))
              : null;
            const dot = r.preview ? h("span", { class: `pv-dot ${r.preview.block ? "bad" : r.preview.warn ? "warn" : "ok"}`, title: r.preview.text || "Checks passed", "aria-label": r.preview.block ? `Blocked: ${r.preview.text}` : r.preview.text || "Checks passed" }) : !gateOk() ? h("span", { class: "pv-dot held", title: "Tick the lot-size check above", "aria-label": "Tick the lot-size check above" }) : h("span", { class: "pv-dot wait", "aria-label": "Checking" });
            return h(
              "tr",
              { class: `st-${r.status}` },
              h("td", { class: "num" }, formatInt(r.i + 1)),
              h("td", {}, h("span", { class: "pos-leg" }, h("span", { class: `side-tag ${r.side === "BUY" ? "buy" : "sell"}` }, r.side === "BUY" ? "B" : "S"), h("span", {}, h("strong", {}, r.label), h("small", {}, r.closing || exit ? "close" : r.phase === "short" ? "short leg" : r.phase === "listed" ? "as listed" : "buy first")))),
              h("td", { class: "num" }, formatInt(r.lots), h("small", { class: "block muted" }, `${formatInt(qty)} qty${slices > 1 ? ` · slice ${formatInt(r.slice)} of ${formatInt(slices)}` : ""}`)),
              phase === "confirm"
                ? h("td", { class: "num" }, input, touch)
                : h("td", { class: "num" }, r.order ? `${formatInt(r.order.filledQuantity ?? 0)} / ${formatInt(r.order.quantity ?? qty)}` : DASH, r.order?.avgPrice ? h("small", { class: "block muted" }, `@ ${formatFixed(r.order.avgPrice, 2)}`) : null),
              h("td", { class: "act" }, phase === "confirm" ? dot : h("span", { class: `st-chip ${r.status}` }, STATUS_TEXT[r.status] ?? r.status), r.error ? h("small", { class: "block bad-text" }, r.error) : r.preview?.block && phase === "confirm" ? h("small", { class: "block bad-text" }, r.preview.text) : null),
            );
          }),
        ),
      ),
    );
  }

  const summary = o.summary
    ? h(
        "div",
        { class: "ticket-figs place-sum" },
        h("div", {}, h("small", {}, exit ? "Positions" : o.summary.net >= 0 ? "Credit" : "Debit"), exit ? `${formatInt(rows.length)} legs` : money(Math.abs(o.summary.net ?? 0), { signed: false })),
        h("div", {}, h("small", {}, "Max loss"), o.summary.maxLoss === undefined ? DASH : o.summary.maxLoss === null ? h("span", { class: "down" }, "Unlimited") : moneyEl(o.summary.maxLoss)),
        h("div", {}, h("small", {}, "Margin"), isFigure(o.summary.margin) ? `${o.summary.marginEst ? "≈ " : ""}${money(o.summary.margin, { signed: false })}` : DASH),
        h("div", {}, h("small", {}, "Free after"), isFigure(o.summary.free) && isFigure(o.summary.margin) ? moneyEl(o.summary.free - o.summary.margin, { signed: false }) : DASH),
      )
    : null;

  function drawWarnings() {
    // How each leg is split is said once, by the slice notes (freeze or per-order limit): the strategy's own freeze
    // lines are left out here.
    const w = (o.warnings ?? []).filter((x) => x.code !== "FREEZE");
    warnHost.hidden = !w.length;
    // A paper account short of funds is never a dead end: say that hedges are already credited, and where
    // to add paper money (Accounts › Reset with more capital).
    const fix = (x) => (x.code === "SHORTFALL" && a.broker === "paper" ? h("span", { class: "strat-warn-fix" }, " Paper margin already credits the hedges in this basket. ", h("a", { href: `#/accounts?reset=${encodeURIComponent(a.id)}` }, "Add paper funds"), " or trade fewer lots.") : null);
    warnHost.replaceChildren(...w.map((x) => h("li", { class: x.severity === "block" ? "bad" : x.severity === "warn" ? "warn" : "info" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", {}, `${x.severity === "block" ? "Blocked: " : ""}${x.text}`, fix(x)))));
  }

  const blocked = () => (o.warnings ?? []).some((w) => w.severity === "block") || rows.some((r) => r.preview?.block) || rows.some((r) => !isFigure(r.limit) || r.limit <= 0);
  function drawButtons() {
    if (phase !== "confirm") return;
    const n = rows.length;
    const hedged = rows.some((r) => r.phase === "hedge") && rows.some((r) => r.phase === "short");
    const btn = h(
      "button",
      { type: "button", class: "primary", disabled: blocked() || !gateOk() || (isLive() && !ack.checked) || !rows.every((r) => r.preview) },
      exit ? `Close ${formatInt(n)} leg${n === 1 ? "" : "s"} · shorts first${isLive() ? " · LIVE" : ""}` : `Place ${formatInt(n)} leg${n === 1 ? "" : "s"}${hedged ? " · hedges first" : ""}${isLive() ? " · LIVE" : ""}`,
    );
    btn.addEventListener("click", () => run());
    actions.replaceChildren(h("button", { type: "button", class: "plain", onclick: () => closeSheet?.(false) }, "Cancel"), btn);
  }

  async function preflight() {
    // A newer preflight (mode, product or prices changed) supersedes this one: its late answers are dropped.
    const gen = ++pfGen;
    if (!gateOk()) return;
    await Promise.all(
      rows.map(async (r) => {
        if (!r.symbol || !isFigure(r.limit)) {
          r.preview = { block: true, warn: false, text: r.symbol ? "No limit price" : "Contract not found" };
          return;
        }
        const res = await optional(api("/v1/orders/preview", { method: "POST", body: body(r) }));
        if (gen !== pfGen) return;
        if (res.error) r.preview = { block: true, warn: false, text: ungroup(res.error.message) };
        else {
          const checks = res.data?.data?.checks ?? [];
          r.checks = checks;
          const b = checks.find((c) => c.severity === "block");
          const w = checks.find((c) => c.severity !== "block");
          r.preview = { block: Boolean(b), warn: Boolean(w), text: ungroup((b ?? w)?.message ?? "") };
          r.freezeQty = res.data?.data?.resolved?.freezeQty ?? r.freezeQty;
          r.tickSize = res.data?.data?.resolved?.tickSize ?? r.tickSize;
        }
      }),
    );
    if (phase !== "confirm" || gen !== pfGen) return;
    // A freeze quantity learned from the preview that this basket is above: split the item and check the slices.
    let resliced = false;
    for (const r of rows) {
      const it = items[r.item];
      if (it && Number(r.freezeQty) > 0 && it.freezeQty !== r.freezeQty) {
        it.freezeQty = r.freezeQty;
        if (r.lots * r.lotSize > r.freezeQty) resliced = true;
      }
    }
    if (resliced) {
      rows = buildRows();
      drawSliceNotes();
      legTable();
      drawButtons();
      preflight();
      return;
    }
    const stale = rows.flatMap((r) => r.checks ?? []).filter((c) => c?.code === "LOT_SIZE_STALE");
    if (!gate && stale.length && o.lotGateFor) {
      const g = o.lotGateFor(stale);
      if (g?.needed) {
        gate = g;
        gateText.textContent = g.text;
        gateRow.hidden = false;
        gateBox.checked = false;
        for (const r of rows) r.preview = null;
      }
    }
    legTable();
    drawButtons();
  }

  // Re-quote: has the touch moved away from a leg's limit by more than max(2 ticks, 1%)?
  const quoteTimer = setInterval(() => {
    if (phase !== "confirm") {
      moved.hidden = true;
      return;
    }
    const away = rows.filter((r) => {
      const t = O.basisPrice(r.quote?.() ?? null, r.side, "touch").price;
      return isFigure(t) && isFigure(r.limit) && Math.abs(t - r.limit) > Math.max(2 * tickOf(r), 0.01 * r.limit);
    });
    moved.hidden = !away.length;
    if (away.length) {
      moved.replaceChildren(
        h("span", {}, `Prices moved on ${formatInt(away.length)} leg${away.length === 1 ? "" : "s"}`),
        h("button", {
          type: "button",
          class: "small",
          onclick: () => {
            for (const r of away) r.limit = O.basisPrice(r.quote?.() ?? null, r.side, "touch").price;
            for (const r of rows) r.preview = null;
            legTable();
            drawButtons();
            preflight();
          },
        }, "Use new prices"),
      );
    }
  }, 1000);

  // ── The state machine ──
  const setStatus = (r, s, err) => {
    r.status = s;
    if (err !== undefined) r.error = err;
    legTable();
  };
  const fromOrder = (r, ord) => {
    r.order = ord;
    const q = Number(ord.quantity) || r.lots * r.lotSize;
    const f = Number(ord.filledQuantity) || 0;
    r.status = ord.status === "filled" || (f >= q && q > 0) ? "filled" : f > 0 ? "partial" : ord.status === "outcome_unknown" ? "unknown" : TERMINAL.has(ord.status) ? ord.status : "open";
  };
  async function lookup(r) {
    const res = await optional(api(`/v1/orders/by-client-id/${encodeURIComponent(r.cid)}`));
    return res.data?.data ?? null;
  }
  async function send(r) {
    r.cid = r.cid ?? `strat-${batch}-${r.i}`;
    setStatus(r, "sending", null);
    say(`Sending leg ${r.i + 1} of ${rows.length}`);
    try {
      const res = await api("/v1/orders", { method: "POST", body: body(r, { clientOrderId: r.cid, tag: "mcbstrat" }) });
      fromOrder(r, res.data.data);
    } catch (err) {
      if (err.network || err.code === "OUTCOME_UNKNOWN" || err.status >= 500) {
        // Never resend blindly: ask the Bridge whether this client order id reached the book.
        const found = await lookup(r);
        if (found) fromOrder(r, found);
        else {
          setStatus(r, "unknown", "Outcome unknown: check the order book before trying again");
          return false;
        }
      } else {
        setStatus(r, "rejected", ungroup(err.message));
        return false;
      }
    }
    if (r.status === "rejected" || r.status === "cancelled" || r.status === "expired") {
      r.error = ungroup(r.order?.statusMessage ?? "Refused");
      legTable();
      return false;
    }
    placedCount += 1;
    legTable();
    return true;
  }
  async function pollUntil(r, ms, done) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (done(r)) return true;
      await sleep(500);
      const res = await optional(api(`/v1/orders/${encodeURIComponent(r.order.orderId)}`));
      if (res.data?.data) {
        fromOrder(r, res.data.data);
        legTable();
      }
      if (TERMINAL.has(r.status) && r.status !== "filled") return false;
    }
    return done(r);
  }
  const waitMs = () => Number(waitSeg.value) * 1000;

  /** The hedge did not fill in time: wait more, cancel and stop, or send the shorts after a second confirm. */
  function hedgeTimeout(r) {
    phase = "paused";
    syncClose();
    r.status = "timeout";
    legTable();
    say(`Leg ${r.i + 1} is not filled yet`);
    return new Promise((resolve) => {
      const secs = `${formatInt(Number(waitSeg.value))} s`;
      // Exit plans and all-buy baskets have no shorts waiting: say "the remaining legs", not "the shorts".
      const shortsWait = !exit && rows.some((x) => x.phase === "short" && x.status === "queued");
      const verb = exit ? (r.side === "BUY" ? "Buy back" : "Sell") : r.side === "BUY" ? "Buy" : "Sell";
      status.replaceChildren(h("p", { class: "warn-text" }, `${verb} ${r.label} is not filled after ${secs}. ${shortsWait ? "The short legs have not been sent." : "The remaining legs have not been sent."}`));
      let armed = false;
      const anyway = h("button", { type: "button", class: "small" }, exit ? "Close the rest anyway" : shortsWait ? "Send the shorts anyway" : "Send the rest anyway");
      anyway.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          anyway.textContent = exit ? "Confirm: close the rest" : shortsWait ? "Confirm: send unhedged" : "Confirm: send the rest";
          status.append(h("p", { class: "bad-text" }, exit ? "The rest closes while this order is still open." : shortsWait ? "The short legs will be unhedged until this fills." : "The rest goes while this order is still open."));
          return;
        }
        phase = "running";
        resolve("anyway");
      });
      actions.replaceChildren(
        h("button", { type: "button", class: "primary", onclick: () => ((phase = "running"), resolve("wait")) }, `Wait ${secs} more`),
        h("button", { type: "button", onclick: () => ((phase = "running"), resolve("cancel")) }, "Cancel it and stop"),
        anyway,
      );
    });
  }

  async function run(from = 0) {
    if (phase === "confirm") {
      if (blocked() || !gateOk() || (isLive() && !ack.checked)) return;
      o.onCfg?.({ product: prodSeg.value, hedgeWait: Number(waitSeg.value) });
    }
    phase = "running";
    stopReq = false;
    syncClose();
    form.hidden = true;
    moved.hidden = true;
    marginLine.hidden = true;
    const stopBtn = h("button", {
      type: "button",
      class: "small",
      onclick: () => {
        stopReq = true;
        stopBtn.disabled = true;
        stopBtn.textContent = "Stopping";
        say("Stopping: no more legs will be sent");
      },
    }, "Cancel remaining");
    actions.replaceChildren(stopBtn);
    status.replaceChildren(h("p", { class: "muted" }, exit ? "Closing: short legs first, each waited until filled." : "Placing: hedges first, each waited until filled."));
    legTable();
    for (const r of rows.slice(from)) {
      // Only rows with nothing on the book are sent: an open, part-filled, timed-out or unknown order is never resent.
      if (r.status !== "queued") continue;
      if (stopReq) return cancelRemaining();
      const ok = await send(r);
      if (!ok) return stopped(r);
      if (r.phase === "hedge") {
        let filled = await pollUntil(r, waitMs(), (x) => x.status === "filled" || stopReq);
        if (stopReq) return cancelRemaining();
        while (!filled && !TERMINAL.has(r.status)) {
          const choice = await hedgeTimeout(r);
          status.replaceChildren(h("p", { class: "muted" }, "Placing…"));
          actions.replaceChildren();
          if (choice === "wait") filled = await pollUntil(r, waitMs(), (x) => x.status === "filled");
          else if (choice === "cancel") {
            await optional(api(`/v1/orders/${encodeURIComponent(r.order.orderId)}`, { method: "DELETE" }));
            const res = await optional(api(`/v1/orders/${encodeURIComponent(r.order.orderId)}`));
            if (res.data?.data) fromOrder(r, res.data.data);
            legTable();
            return stopped(r);
          } else break;
        }
        if (!filled && TERMINAL.has(r.status) && r.status !== "filled") return stopped(r);
        if (filled) say(`Leg ${r.i + 1} of ${rows.length} filled`);
      }
    }
    // Shorts: sent one by one on acceptance; now give them the hedge wait to report a final state.
    await Promise.all(rows.filter((r) => r.order && r.status !== "filled" && !TERMINAL.has(r.status)).map((r) => pollUntil(r, waitMs(), (x) => x.status === "filled")));
    finish();
  }

  /** Cancel remaining: nothing more is sent, and the orders still working are cancelled. Filled legs stay. */
  async function cancelRemaining() {
    for (const x of rows) if (x.status === "queued") x.status = "skipped";
    const open = rows.filter((r) => r.order && (r.status === "open" || r.status === "partial" || r.status === "timeout"));
    status.replaceChildren(h("p", { class: "muted" }, open.length ? "Cancelling the orders still working" : "Stopped"));
    for (const r of open) {
      await optional(api(`/v1/orders/${encodeURIComponent(r.order.orderId)}`, { method: "DELETE" }));
      const res = await optional(api(`/v1/orders/${encodeURIComponent(r.order.orderId)}`));
      if (res.data?.data) fromOrder(r, res.data.data);
    }
    const p = basketProgress(rows);
    say(`Stopped: ${p.filled} of ${p.total} filled`);
    return stopped();
  }
  function finish() {
    phase = "done";
    syncClose();
    legTable();
    const all = rows.every((r) => r.status === "filled");
    if (all) {
      const net = o.summary?.net;
      status.replaceChildren(h("p", { class: "ok-text" }, exit ? "Legs closed." : `Strategy placed${isFigure(net) ? ` · net ${money(Math.abs(net), { signed: false })} ${net >= 0 ? "credit" : "debit"}` : ""}`));
      say(exit ? "All legs closed" : "Strategy placed: every leg filled");
      actions.replaceChildren(h("button", { type: "button", onclick: () => closeSheet?.(true) }, "Close"), h("button", { type: "button", class: "primary", onclick: () => (closeSheet?.(true), o.onPositions?.()) }, "View positions"));
    } else partial();
  }
  function stopped() {
    phase = "done";
    syncClose();
    for (const x of rows) if (x.status === "queued") x.status = "skipped";
    legTable();
    partial();
  }
  function partial() {
    const filled = rows.filter((r) => r.status === "filled" || r.status === "partial");
    const open = rows.filter((r) => r.order && (r.status === "open" || r.status === "partial" || r.status === "timeout"));
    const n = rows.filter((r) => r.status === "filled").length;
    const shortsOut = rows.some((r) => r.phase === "short" && r.order);
    say(`Placed ${n} of ${rows.length}`);
    status.replaceChildren(h("p", { class: "warn-text" }, `Placed ${formatInt(n)} of ${formatInt(rows.length)}${!shortsOut && !exit && filled.length ? " · buys in, sells not sent" : ""}.`));
    // Retry only a row with no live order (rejected, cancelled, expired, not sent). An open or part-filled order is
    // still working: resending it would double the leg.
    const retryAt = O.retryIndex(rows);
    actions.replaceChildren(
      ...(retryAt >= 0 ? [h("button", { type: "button", class: "primary", onclick: () => retry(retryAt) }, `Retry leg ${formatInt(retryAt + 1)}`)] : []),
      ...(open.length ? [h("button", { type: "button", onclick: () => cancelOpen(open) }, "Cancel open orders")] : []),
      ...(filled.length ? [h("button", { type: "button", class: "small", onclick: () => unwind(filled) }, "Unwind filled legs")] : []),
      h("button", { type: "button", class: "plain", onclick: () => closeSheet?.(true) }, "Keep as is"),
    );
  }
  function retry(i) {
    const r = rows[i];
    if (!O.SENDABLE_STATUS.has(r.status)) return;
    r.status = "queued";
    r.error = null;
    r.order = null;
    r.cid = `strat-${batch}-${r.i}-r${Date.now().toString(36).slice(-3)}`;
    for (const x of rows.slice(i)) if (x.status === "skipped") x.status = "queued";
    run(i);
  }
  async function cancelOpen(open) {
    actions.replaceChildren(h("span", { class: "muted" }, "Cancelling…"));
    for (const r of open) {
      await optional(api(`/v1/orders/${encodeURIComponent(r.order.orderId)}`, { method: "DELETE" }));
      const res = await optional(api(`/v1/orders/${encodeURIComponent(r.order.orderId)}`));
      if (res.data?.data) fromOrder(r, res.data.data);
    }
    legTable();
    partial();
  }
  /** Unwind: exit the filled quantities, shorts first, as MARKET (LIMIT at the touch if MARKET is refused). */
  async function unwind(filled) {
    const plan = [...filled].sort((x, y) => (x.side === "SELL" ? 0 : 1) - (y.side === "SELL" ? 0 : 1));
    const liveAck = h("input", { type: "checkbox" });
    const list = h("ul", { class: "desk-list" }, plan.map((r) => h("li", {}, `${r.side === "SELL" ? "Buy back" : "Sell"} ${formatInt(Number(r.order?.filledQuantity) || 0)} qty · ${r.label}`)));
    status.replaceChildren(h("p", {}, "Unwind these filled legs at market, shorts first?"), list, isLive() ? h("label", { class: "check live-ack" }, liveAck, "I understand these are real orders.") : "");
    actions.replaceChildren(
      h("button", { type: "button", class: "plain", onclick: () => partial() }, "Back"),
      h("button", {
        type: "button",
        class: "primary",
        onclick: async () => {
          if (isLive() && !liveAck.checked) return;
          actions.replaceChildren(h("span", { class: "muted" }, "Unwinding…"));
          const out = [];
          for (const r of plan) {
            // A part-filled order is still working: cancel the rest first, then exit what actually filled.
            if (r.order?.orderId && (r.status === "partial" || r.status === "open" || r.status === "timeout")) {
              await optional(api(`/v1/orders/${encodeURIComponent(r.order.orderId)}`, { method: "DELETE" }));
              const res = await optional(api(`/v1/orders/${encodeURIComponent(r.order.orderId)}`));
              if (res.data?.data) fromOrder(r, res.data.data);
            }
            const qty = Number(r.order?.filledQuantity) || 0;
            if (!qty) continue;
            const side = r.side === "BUY" ? "SELL" : "BUY";
            const base = { account: a.id, symbol: r.symbol, side, quantity: qty, product: r.product ?? prodSeg.value, clientOrderId: `unw-${batch}-${r.i}`, tag: "mcbstrat", ...(isLive() ? { mode: "live" } : {}) };
            let res = await optional(api("/v1/orders", { method: "POST", body: { ...base, orderType: "MARKET" } }));
            if (res.error && !res.error.network && res.error.code !== "OUTCOME_UNKNOWN") {
              const t = O.basisPrice(r.quote?.() ?? null, side, "touch").price;
              if (isFigure(t)) res = await optional(api("/v1/orders", { method: "POST", body: { ...base, clientOrderId: `${base.clientOrderId}l`, orderType: "LIMIT", price: t } }));
            }
            out.push(`${r.label}: ${res.error ? ungroup(res.error.message) : res.data.data.status}`);
          }
          legTable();
          status.replaceChildren(h("p", {}, "Unwind sent."), h("ul", { class: "desk-list" }, out.map((t) => h("li", {}, t))));
          actions.replaceChildren(h("button", { type: "button", class: "primary", onclick: () => closeSheet?.(true) }, "Close"));
        },
      }, "Unwind now"),
    );
  }

  // The mode badge follows the sheet's own Mode switch (that is what the orders are sent as), not the account alone.
  const modeBadge = h("span", { class: "acct-badge place-mode" });
  const drawMode = () => {
    const lv = isLive();
    modeBadge.textContent = lv ? "Live" : "Paper";
    modeBadge.dataset.mode = lv ? "live" : "paper";
  };
  drawMode();
  const form = h(
    "div",
    { class: "place-form" },
    h("div", { class: "ticket-grid" }, segField("Product", prodSeg), segField("Hedge wait", waitSeg), orderSeg ? segField("Send order", orderSeg) : null),
    // Orders go to: the account is chosen here, where it matters (strategy.md §3.1); a change reopens the sheet.
    o.accountRow ? h("div", { class: "place-acct" }, o.accountRow(() => closeSheet?.({ reopen: true })), modeBadge) : h("p", { class: "muted small ticket-acct one-line" }, h("span", { class: "acct-name" }, a.label), " ", modeBadge),
    liveSeg ? segField("Mode", liveSeg) : null,
    gateRow,
    ackRow,
  );
  liveSeg?.addEventListener("change", () => {
    ackRow.hidden = !isLive();
    drawMode();
    for (const r of rows) r.preview = null;
    legTable();
    drawButtons();
    preflight();
  });
  prodSeg.addEventListener("change", () => {
    for (const r of rows) r.preview = null;
    legTable();
    drawButtons();
    preflight();
  });
  orderSeg?.addEventListener("change", () => {
    cfg.order = orderSeg.value;
    o.onCfg?.({ order: orderSeg.value });
    rows = buildRows();
    drawSliceNotes();
    legTable();
    drawButtons();
    preflight();
  });
  ack.addEventListener("change", drawButtons);
  gateBox.addEventListener("change", () => {
    for (const r of rows) r.preview = null;
    legTable();
    drawButtons();
    preflight();
  });

  async function loadBasketMargin() {
    const b = basketMarginBody(items.map((it, k) => ({ ...it, price: limits.get(k) ?? it.price })));
    if (a.broker !== "paper" || !b) {
      marginLine.textContent = a.broker === "paper" ? "" : "Margin for live orders is the broker's own figure; the broker checks it as each order arrives.";
      return;
    }
    marginLine.textContent = "Reading the basket's margin";
    const res = await optional(api(`/v1/paper/accounts/${encodeURIComponent(a.id)}/margin`, { method: "POST", body: b }));
    const m = res.data?.data;
    if (!m) {
      marginLine.textContent = res.error ? `Basket margin unavailable: ${ungroup(res.error.message)}` : "";
      return;
    }
    const short = isFigure(m.available) && m.change > m.available;
    marginLine.className = `place-margin ${short ? "bad-text" : "muted"}`;
    marginLine.textContent = `Whole basket ≈ ${money(m.alone, { signed: false })} on its own · ${m.change < -0.5 ? `frees ${money(-m.change, { signed: false })} on this book` : `adds ${money(Math.max(0, m.change), { signed: false })} to this book`} · free ${money(m.available, { signed: false })}${m.standalone > m.alone + 1 ? ` · hedges save ${money(m.standalone - m.alone, { signed: false })}` : ""}. Paper model, approximate.`;
  }

  legTable();
  drawWarnings();
  drawButtons();
  // The first checks wait for the per-order limits, so they check the slices that will be sent.
  loadOrderLimits().then(() => {
    if (phase !== "confirm") return;
    rows = buildRows();
    drawSliceNotes();
    legTable();
    drawButtons();
    preflight();
  });
  loadBasketMargin();
  const done = modal({
    title: o.title,
    canClose,
    body: (close) => {
      closeSheet = (v) => {
        if (!canClose()) return;
        close(v, true);
      };
      return h("div", { class: "stack place-sheet" }, summary, marginLine, legsHost, sliceHost, moved, warnHost, form, status, live, actions);
    },
    buttons: [],
  });
  return done.then((v) => {
    clearInterval(quoteTimer);
    return { placed: placedCount, result: v, reopen: Boolean(v?.reopen) };
  });
}

