// The option chain's action sheet: tap a row (touch screens), or press Enter / double-click (desktop), and one
// contract's numbers and actions open in a bottom sheet on phones or a panel on the right from 720 px up. Buy at the
// ask and sell at the bid open the same order ticket as the chain (preview, then place: the Bridge's safety gates
// apply unchanged). It repaints from the chain on every refresh, patching only what changed.
//
// The desk owns the data: `read(strike, side)` returns { x (the chain context), row, q (the leg), position, name,
// canTrade, paused, warnings }. Numbers are formatted by format.js only; the maths is options.js.
import { api as bridgeApi, chartSlot, copyButton, h, icon } from "./app.js";
import { candlesOf, contractSpec } from "./chart-specs.js";
import { excelFormula } from "./flows.js";
import { DASH, MINUS, formatCompact, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, isFigure } from "./format.js";
import * as O from "./options.js";
import { segmented } from "./views.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const g = (v, dp) => (isFigure(v) ? formatFixed(v, dp) : DASH);
const rupees = (v) => (!isFigure(v) ? DASH : Math.abs(v) >= 1e5 ? `${v < 0 ? MINUS : ""}₹${formatCompact(Math.abs(v))}` : formatRupee(v, 0));
const pct = (p) => formatPercent(p === null || p === undefined ? null : p * 100, 0);

/**
 * The metric groups for one leg (docs/design/chain.md §7): Price, Greeks, Odds and size, OI, six figures each, so the
 * grid (2 columns on phones, 3 from 720 px) has no empty cells. Each item is [label, value, class?, bar?, extra?]:
 * `bar` (0..1) draws a mini OI bar (share of the chain's largest OI); `extra` = { sub, title }, a quiet second line
 * and a tooltip. Same formulas as the chain's columns.
 * @returns {Array<{ title: string, items: Array<[string, string, string?, number?, { sub?: string, title?: string }?]> }>}
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
  const oi = num(q?.oi);
  const vol = num(q?.volume);
  const maxOi = num(x?.sm?.maxOi);
  const ext = x ? O.extrinsic(K, right, P, x.F) : null;
  const intr = P !== null && ext !== null ? P - ext : null;
  const theta = num(q?.theta);
  const vega = num(q?.vega);
  const prev = oi !== null && chg !== null ? oi - chg : null;
  const chgPct = prev > 0 ? (chg / prev) * 100 : null;
  return [
    {
      title: "Price",
      items: [
        ["Bid", g(q?.bid, 2), "sell-ink"],
        ["Ask", g(q?.ask, 2), "buy-ink"],
        ["Mid", g(P, 2)],
        ["Spread", formatPercent(sp, 1), sp > 10 ? "down" : sp > 5 ? "warn-ink" : undefined],
        ["Intrinsic", g(intr, 2), undefined, undefined, { title: "Value if exercised now, against the forward" }],
        ["Time value", g(ext, 2), undefined, undefined, { title: "Premium above intrinsic: what decays to expiry" }],
      ],
    },
    {
      title: "Greeks",
      items: [
        ["Delta", g(q?.delta, 2)],
        ["Gamma", g(q?.gamma, 4)],
        ["θ / lot", rupees(theta === null ? null : theta * lot), theta < 0 ? "down" : undefined],
        ["Vega / lot", rupees(vega === null ? null : vega * lot), undefined, undefined, { title: "Rupees per lot for one vol point" }],
        ["IV", g(iv, 1)],
        ["IV − ATM", isFigure(ivx) ? formatSigned(ivx, 1) : DASH, ivx > 0 ? "warn-ink" : undefined, undefined, { title: "Above ATM IV: rich; below: cheap" }],
      ],
    },
    {
      title: "Odds and size",
      items: [
        ["Breakeven", be === null ? DASH : formatInt(be), undefined, undefined, { sub: move === null ? "" : `${formatSigned(move, 1)}% from spot` }],
        ["PoP buy", pct(pop)],
        ["PoP sell", pct(pop === null ? null : 1 - pop), undefined, undefined, { title: "Chance a short of this option keeps a profit at expiry" }],
        ["P(ITM)", pct(pitm)],
        ["Prem / lot", rupees(P === null ? null : P * lot)],
        ["Lot", formatInt(lot)],
      ],
    },
    {
      title: "OI",
      items: [
        ["OI", formatCompact(oi), side === "ce" ? "oi-call" : "oi-put", oi !== null && maxOi ? oi / maxOi : null],
        ["OI chg", formatCompact(chg, { signed: true }), chg > 0 ? "up" : chg < 0 ? "down" : undefined],
        ["OI chg %", chgPct === null ? DASH : `${formatSigned(chgPct, 1)}%`, chgPct > 0 ? "up" : chgPct < 0 ? "down" : undefined],
        ["Volume", formatCompact(vol)],
        ["Vol / OI", vol !== null && oi ? formatFixed(vol / oi, 2) : DASH, undefined, undefined, { title: "Volume over open interest: above 1, today's trading outweighs the open positions" }],
        ["Build-up", bu ?? DASH, bu ? `bu:${bu}` : undefined, undefined, { title: bu ? O.BUILDUP_NAMES[bu] : "No build-up signal" }],
      ],
    },
  ];
}

let current = null;

/**
 * Open the sheet for one strike and side. Returns { update(), close(), strike, side }; opening another closes this.
 * @param {{ strike: number, side: "ce"|"pe", read: Function, onTrade: Function, onLeg: Function, onExit: Function, onClose: Function }} o
 */
export function openChainSheet({ strike, side, read, onTrade, onLeg, onExit, onClose, acct = null }) {
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
  const buyBtn = h("button", { type: "button", class: "btn buy full cs-buy" });
  const sellBtn = h("button", { type: "button", class: "btn sell full cs-sell" });
  const reason = h("p", { class: "cs-reason", hidden: true });
  const legBuy = h("button", { type: "button", class: "small" }, "Add buy leg");
  const legSell = h("button", { type: "button", class: "small" }, "Add sell leg");
  // This contract's live price as one Excel cell (the key sits in a cell named BridgeKey: API › Keys makes one).
  const xlBtn = copyButton(() => excelFormula(location.origin, state().q?.symbol ?? ""), { label: "Excel formula", toastLabel: "Excel formula copied: put your key in a cell named BridgeKey", cls: "small", ariaLabel: "Copy an Excel formula for this contract's live price" });
  // The contract's 5-minute candles (GET /v1/history), reloaded when CE / PE switches the contract; every 60 s while open.
  // With indicators on, daily candles (studies read one candle per session).
  let chartSym = null;
  // The chart's menu (right-click, the + on its price axis) opens this sheet's own order ticket at a price.
  const chartSlotEl = chartSlot("Price chart of this contract", { id: "contract", refreshMs: 60_000, expand: true, symbol: () => chartSym, trade: (side, price) => !closed && onTrade(strike, s, side, price) });
  // The interval the chart's header picked (else 5-minute candles; daily while a daily-only indicator is on).
  const loadContract = (sym, name) => async ({ studies, interval }) => {
    const iv = interval ?? (studies ? "1d" : "5m");
    const daily = iv === "1d";
    return { ...contractSpec({ name, daily, candles: candlesOf((await bridgeApi(`/v1/history?symbol=${encodeURIComponent(sym)}&interval=${iv}&countback=${daily ? 250 : 600}`)).data?.data), interval: iv }), interval: iv };
  };
  const grid = h("div", { class: "cs-groups" });
  const warns = h("ul", { class: "ticket-checks cs-warns", "aria-label": "Before you trade", hidden: true });
  const grab = h("div", { class: "cs-grab", "aria-hidden": "true" });
  // Header: the contract and CE | PE; then the price and, since the chain's line has no account picker, where orders go.
  const head = h("div", { class: "cs-head" }, grab, h("div", { class: "cs-top" }, h("div", { class: "cs-name" }, title, h("div", { class: "cs-sub" }, quote, paused)), sideSeg, closeBtn), acct ? h("div", { class: "cs-acct" }, acct()) : null);
  const dlg = h(
    "dialog",
    { class: "chain-sheet", "aria-labelledby": titleId, tabindex: "-1" },
    head,
    h("div", { class: "cs-body" }, pos, h("div", { class: "trade-pair cs-trade" }, buyBtn, sellBtn), reason, h("div", { class: "cs-more" }, legBuy, legSell, xlBtn), grid, warns, chartSlotEl),
  );

  const state = () => read(strike, s) ?? {};
  function update() {
    if (closed) return;
    const d = state();
    const { q, row, x } = d;
    const right = s === "ce" ? "CE" : "PE";
    if (sideSeg.value !== s) sideSeg.value = s;
    // The insight card (chain-insight.js) reads which contract a tapped figure belongs to.
    dlg.dataset.strike = String(strike);
    dlg.dataset.side = s;
    const name = d.name ?? `${formatInt(strike)} ${right}`;
    if (title.textContent !== name) title.textContent = name;
    const sym = q?.symbol ?? null;
    if (sym && sym !== chartSym && chartSlotEl) {
      chartSym = sym;
      chartSlotEl.chart.load(loadContract(sym, name));
    }
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
    buyBtn.textContent = ask !== null ? `Buy ${formatFixed(ask, 2)}` : "Buy";
    sellBtn.textContent = bid !== null ? `Sell ${formatFixed(bid, 2)}` : "Sell";
    buyBtn.setAttribute("aria-label", `Buy ${formatInt(strike)} ${right}${ask !== null ? ` at ${formatFixed(ask, 2)}` : ""}`);
    sellBtn.setAttribute("aria-label", `Sell ${formatInt(strike)} ${right}${bid !== null ? ` at ${formatFixed(bid, 2)}` : ""}`);
    buyBtn.disabled = Boolean(why);
    sellBtn.disabled = Boolean(why);
    buyBtn.title = why || (ask === null ? "No ask: the ticket starts at the last price" : "");
    sellBtn.title = why || (bid === null ? "No bid: the ticket starts at the last price" : "");
    reason.hidden = !why;
    if (reason.textContent !== why) reason.textContent = why;
    // Metrics in groups, patched cell by cell (built once per shape).
    const groups = q && row ? sheetMetrics(q, row, s, x) : [];
    const shape = groups.map((gr) => `${gr.title}:${gr.items.length}`).join("|");
    if (grid.__shape !== shape) {
      grid.__shape = shape;
      grid.replaceChildren(...groups.map((gr) => h("section", { class: "cs-group" }, h("h3", {}, gr.title), h("dl", { class: "cs-grid" }, gr.items.map(() => h("div", { class: "cs-m" }, h("dt", {}), h("dd", {}), h("span", { class: "cs-sub" })))))));
    }
    groups.forEach((gr, gi) => {
      const dl = grid.children[gi]?.lastChild;
      gr.items.forEach(([label, value, cls, frac, extra], i) => {
        const cell = dl?.children[i];
        if (!cell) return;
        const sig = `${label}|${value}|${cls ?? ""}|${frac ?? ""}|${extra?.sub ?? ""}|${extra?.title ?? ""}`;
        if (cell.__sig === sig) return;
        cell.__sig = sig;
        cell.children[0].textContent = label;
        const dd = cell.children[1];
        dd.className = cls && !cls.startsWith("bu:") ? cls : "";
        if (extra?.title) cell.title = extra.title;
        else cell.removeAttribute("title");
        cell.children[2].textContent = extra?.sub ?? "";
        if (frac !== undefined && frac !== null) {
          const bar = h("span", { class: "cs-bar", "aria-hidden": "true" }, h("span"));
          bar.firstChild.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
          dd.replaceChildren(h("span", {}, value), bar);
        } else if (cls?.startsWith("bu:")) dd.replaceChildren(h("span", { class: `bu bu-${cls.slice(3)}` }, cls.slice(3)));
        else dd.textContent = value;
      });
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
    chartSlotEl?.chart.destroy();
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
