// The option chain's action sheet: tap a row (touch screens), or press Enter / double-click (desktop), and one
// contract's numbers and actions open in a bottom sheet on phones or a panel on the right from 720 px up. Buy at the
// ask and sell at the bid open the same order ticket as the chain (preview, then place: the Bridge's safety gates
// apply unchanged). It repaints from the chain on every refresh, patching only what changed.
//
// The desk owns the data: `read(strike, side)` returns { x (the chain context), row, q (the leg), position, name,
// canTrade, paused, warnings }. Numbers are formatted by format.js only; the maths is options.js.
import { h, icon } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, isFigure } from "./format.js";
import * as O from "./options.js";
import { segmented } from "./views.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const g = (v, dp) => (isFigure(v) ? formatFixed(v, dp) : DASH);
const rupees = (v) => (!isFigure(v) ? DASH : Math.abs(v) >= 1e5 ? `${v < 0 ? "-" : ""}₹${formatCompact(Math.abs(v))}` : formatRupee(v, 0));
const pct = (p) => formatPercent(p === null || p === undefined ? null : p * 100, 0);

/**
 * The metric grid for one leg: [label, value, class?]. Same formulas as the chain's columns.
 * @returns {Array<[string, string, string?]>}
 */
export function sheetMetrics(q, row, side, x) {
  const right = side === "ce" ? "CE" : "PE";
  const K = row?.strike;
  const P = O.mid(q);
  const lot = x?.lot ?? 1;
  const atmIv = x?.sm?.atmIv ?? null;
  const iv = num(q?.iv);
  const be = O.breakeven(K, right, P);
  const move = be !== null && x?.spot ? ((be - x.spot) / x.spot) * 100 : null;
  const pop = x ? O.chanceOfProfit(x.F, K, x.years, iv ?? atmIv, right, P) : null;
  const pitm = x ? O.probItm(x.F, K, x.years, iv, right) : null;
  const sp = O.spreadPct(q);
  const ivx = iv !== null && atmIv !== null ? iv - atmIv : null;
  const bu = O.buildup(q);
  const chg = num(q?.oiChange);
  return [
    ["Bid", g(q?.bid, 2)],
    ["Ask", g(q?.ask, 2)],
    ["Spread", formatPercent(sp, 1), sp > 10 ? "down" : sp > 5 ? "warn-ink" : undefined],
    ["IV", g(iv, 1)],
    ["IV − ATM", isFigure(ivx) ? formatSigned(ivx, 1) : DASH],
    ["Delta", g(q?.delta, 2)],
    ["Gamma", g(q?.gamma, 4)],
    ["θ / lot", rupees(num(q?.theta) === null ? null : q.theta * lot)],
    ["Vega", g(q?.vega, 1)],
    ["OI", formatCompact(q?.oi)],
    ["OI chg", formatCompact(chg, { signed: true }), chg > 0 ? "up" : chg < 0 ? "down" : undefined],
    ["Volume", formatCompact(q?.volume)],
    ["Breakeven", be === null ? DASH : `${formatInt(be)}${move === null ? "" : ` (${formatSigned(move, 1)}%)`}`],
    ["PoP buy", pct(pop)],
    ["P(ITM)", pct(pitm)],
    ["Prem / lot", rupees(P === null ? null : P * lot)],
    ["Lot", formatInt(lot)],
    ["Build-up", bu ? O.BUILDUP_NAMES[bu] : DASH],
  ];
}

let current = null;

/**
 * Open the sheet for one strike and side. Returns { update(), close(), strike, side }; opening another closes this.
 * @param {{ strike: number, side: "ce"|"pe", read: Function, onTrade: Function, onLeg: Function, onExit: Function, onClose: Function }} o
 */
export function openChainSheet({ strike, side, read, onTrade, onLeg, onExit, onClose }) {
  current?.close();
  let s = side === "pe" ? "pe" : "ce";
  let closed = false;
  const titleId = `sheet-t-${Math.random().toString(36).slice(2, 8)}`;
  const title = h("h2", { class: "cs-title", id: titleId });
  const quote = h("span", { class: "cs-quote" });
  const paused = h("span", { class: "cs-paused", hidden: true }, "Paused");
  const sideSeg = segmented("Call or put", [["ce", "CE"], ["pe", "PE"]], s);
  sideSeg.classList.add("cs-side");
  sideSeg.addEventListener("change", () => {
    s = sideSeg.value;
    update();
  });
  const closeBtn = h("button", { type: "button", class: "icon-btn cs-close", "aria-label": "Close" }, icon("close"));
  const posText = h("span", { class: "cs-pos-text" });
  const exitBtn = h("button", { type: "button", class: "small cs-exit" }, "Exit");
  const pos = h("div", { class: "cs-pos", hidden: true }, posText, exitBtn);
  const buyBtn = h("button", { type: "button", class: "primary cs-buy" });
  const sellBtn = h("button", { type: "button", class: "primary sell cs-sell" });
  const reason = h("p", { class: "cs-reason", hidden: true });
  const legBuy = h("button", { type: "button", class: "small" }, "Add buy leg");
  const legSell = h("button", { type: "button", class: "small" }, "Add sell leg");
  const chartBtn = h("button", { type: "button", class: "small cs-chart", disabled: true, title: "Chart engine slot: coming soon" }, "Chart");
  const grid = h("dl", { class: "cs-grid" });
  const warns = h("ul", { class: "ticket-checks cs-warns", "aria-label": "Before you trade", hidden: true });
  const grab = h("div", { class: "cs-grab", "aria-hidden": "true" });
  const head = h("div", { class: "cs-head" }, grab, h("div", { class: "cs-top" }, h("div", { class: "cs-name" }, title, h("div", { class: "cs-sub" }, quote, paused)), sideSeg, closeBtn));
  const dlg = h(
    "dialog",
    { class: "chain-sheet", "aria-labelledby": titleId, tabindex: "-1" },
    head,
    h("div", { class: "cs-body" }, pos, h("div", { class: "cs-trade" }, buyBtn, sellBtn), reason, h("div", { class: "cs-more" }, legBuy, legSell, chartBtn), grid, warns),
  );

  const state = () => read(strike, s) ?? {};
  function update() {
    if (closed) return;
    const d = state();
    const { q, row, x } = d;
    const right = s === "ce" ? "CE" : "PE";
    if (sideSeg.value !== s) sideSeg.value = s;
    const name = d.name ?? `${formatInt(strike)} ${right}`;
    if (title.textContent !== name) title.textContent = name;
    const chp = O.changePct(q);
    const qSig = `${q?.ltp}|${chp}`;
    if (quote.__sig !== qSig) {
      quote.__sig = qSig;
      quote.replaceChildren(h("strong", {}, g(q?.ltp, 2)), chp === null ? "" : h("span", { class: chp > 0 ? "up" : chp < 0 ? "down" : undefined }, ` ${formatSigned(chp, 2)}%`));
    }
    paused.hidden = !d.paused;
    // Position held in this contract.
    const p = d.position;
    pos.hidden = !p;
    if (p) {
      const n = Number(p.netQty);
      const lots = n / (x?.lot || 1);
      const pnl = num(p.pnl);
      const sig = `${n}|${p.avgPrice}|${pnl}`;
      if (posText.__sig !== sig) {
        posText.__sig = sig;
        posText.replaceChildren(
          `${n > 0 ? "Long" : "Short"} ${Number.isInteger(lots) ? formatInt(Math.abs(lots)) : formatFixed(Math.abs(lots), 2)} lot${Math.abs(lots) === 1 ? "" : "s"} @ ${g(p.avgPrice, 2)} · P&L `,
          h("span", { class: pnl > 0 ? "up" : pnl < 0 ? "down" : undefined }, formatRupee(pnl, 0)),
        );
      }
      exitBtn.onclick = () => {
        close();
        onExit(p);
      };
      exitBtn.setAttribute("aria-label", `Exit ${name}`);
    }
    // Trade at the touch.
    const ask = num(q?.ask);
    const bid = num(q?.bid);
    const why = !d.canTrade ? "Choose an account that can place orders" : !q ? "No quote for this contract" : "";
    buyBtn.textContent = ask !== null ? `Buy at ${formatFixed(ask, 2)}` : "Buy";
    sellBtn.textContent = bid !== null ? `Sell at ${formatFixed(bid, 2)}` : "Sell";
    buyBtn.setAttribute("aria-label", `Buy ${formatInt(strike)} ${right}${ask !== null ? ` at ${formatFixed(ask, 2)}` : ""}`);
    sellBtn.setAttribute("aria-label", `Sell ${formatInt(strike)} ${right}${bid !== null ? ` at ${formatFixed(bid, 2)}` : ""}`);
    buyBtn.disabled = Boolean(why);
    sellBtn.disabled = Boolean(why);
    buyBtn.title = why || (ask === null ? "No ask: the ticket starts at the last price" : "");
    sellBtn.title = why || (bid === null ? "No bid: the ticket starts at the last price" : "");
    reason.hidden = !why;
    if (reason.textContent !== why) reason.textContent = why;
    // Metrics, patched cell by cell.
    const m = q && row ? sheetMetrics(q, row, s, x) : [];
    if (grid.children.length !== m.length * 1) {
      grid.replaceChildren(...m.map(() => h("div", { class: "cs-m" }, h("dt", {}), h("dd", {}))));
    }
    m.forEach(([label, value, cls], i) => {
      const cell = grid.children[i];
      const sig = `${label}|${value}|${cls ?? ""}`;
      if (cell.__sig === sig) return;
      cell.__sig = sig;
      cell.children[0].textContent = label;
      cell.children[1].textContent = value;
      cell.children[1].className = cls ?? "";
    });
    // Warnings (advisory).
    const w = d.warnings ?? [];
    const wSig = JSON.stringify(w);
    if (warns.__sig !== wSig) {
      warns.__sig = wSig;
      warns.replaceChildren(...w.map((x2) => h("li", { class: x2.level }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", {}, x2.text))));
      warns.hidden = !w.length;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener("hashchange", close);
    if (dlg.open) dlg.close();
    dlg.remove();
    document.documentElement.classList.remove("sheet-open");
    if (current === api) current = null;
    onClose?.(strike, s);
  }
  buyBtn.addEventListener("click", () => {
    close();
    onTrade(strike, s, "BUY");
  });
  sellBtn.addEventListener("click", () => {
    close();
    onTrade(strike, s, "SELL");
  });
  legBuy.addEventListener("click", () => onLeg(strike, s, "BUY"));
  legSell.addEventListener("click", () => onLeg(strike, s, "SELL"));
  closeBtn.addEventListener("click", () => close());
  dlg.addEventListener("close", () => close());
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  // A tap on the dimmed backdrop (outside the panel) closes it.
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  });
  // Phones: drag the head down 80 px or more to close.
  let y0 = null;
  let dy = 0;
  head.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || e.target.closest("button")) return;
    y0 = e.touches[0].clientY;
    dy = 0;
  }, { passive: true });
  head.addEventListener("touchmove", (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    dlg.style.transform = dy ? `translateY(${Math.round(dy)}px)` : "";
  }, { passive: true });
  head.addEventListener("touchend", () => {
    if (y0 === null) return;
    y0 = null;
    if (dy >= 80) close();
    else dlg.style.transform = "";
  }, { passive: true });

  // Leaving the page (back button, a link) takes the sheet with it.
  window.addEventListener("hashchange", close);
  const api = { update, close, get strike() { return strike; }, get side() { return s; } };
  current = api;
  update();
  document.body.append(dlg);
  dlg.showModal();
  document.documentElement.classList.add("sheet-open");
  dlg.focus({ preventScroll: true });
  return api;
}
