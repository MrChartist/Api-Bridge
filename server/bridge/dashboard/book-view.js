// Positions · All accounts / Family (F2/F11, docs/spec/p1-12-guard-participants.md §6.3). The book across every account
// this key may see, one section per holder (whose account it is), from GET /v1/book (polled every 15 s while this view
// is on screen; no polling anywhere else). The maths is in book-core.js on the server; this file turns the response into
// text through format.js and draws it.
//
// Rules the view keeps: every leg shows its account first; Exit opens the order ticket preset to that leg's account
// (never a multi-account basket); bulk selection stays inside one account; totals say they add separate accounts and
// that margin is not shared. A holder priced without its own market data shows P&L from the broker and "—" Greeks
// with the reason.
import { alertBox, api, emptyState, h, icon, istTime, loadingState, optional, toast } from "./app.js";
import { BOOK_NOTES, selectLeg } from "./book-core.js";
import { DASH, formatCompact, formatFixed, formatInt, formatRupee, formatSigned, isFigure } from "./format.js";

/** How often the book is read while this view is on screen. */
export const BOOK_POLL_MS = 15000;

export const SCOPES = Object.freeze([
  ["account", "This account"],
  ["all", "All accounts"],
  ["family", "Family"],
]);

const REL_LABEL = { self: "Self", spouse: "Spouse", "dependent-child": "Dependent child", "dependent-parent": "Dependent parent", huf: "HUF", other: "Other" };
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_FMT = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const dayText = (e) => (ISO_DAY.test(e ?? "") ? DAY_FMT.format(new Date(`${e}T00:00:00Z`)) : e ?? "");

const num = (v) => (isFigure(v) ? Number(v) : null);
/** Signed whole rupees with a true minus: "+₹1274", "−₹4888", "₹0"; "--" when unknown. */
export const money = (v) => {
  const x = num(v);
  if (x === null) return DASH;
  const r = Math.round(x);
  return r > 0 ? `+${formatRupee(r, 0)}` : r < 0 ? `−${formatRupee(-r, 0)}` : formatRupee(0, 0);
};
/** Signed compact rupees for big figures: "+₹2.61L", "−₹9.88L". */
export const moneyCompact = (v) => {
  const x = num(v);
  if (x === null) return DASH;
  return `${x > 0.5 ? "+" : x < -0.5 ? "−" : ""}₹${formatCompact(Math.abs(x))}`;
};
/** Unsigned compact rupees ("₹1.45L"). */
const rupees = (v) => (num(v) === null ? DASH : `₹${formatCompact(Math.abs(num(v)))}`);
const signedNum = (v, dp) => (num(v) === null ? DASH : formatSigned(num(v), dp).replace(/^-/, "−"));
export const toneOf = (v) => (num(v) === null ? "fg" : Math.round(num(v)) > 0 ? "pos" : Math.round(num(v)) < 0 ? "neg" : "fg");

/** "NIFTY 3 Nov 26150 PE" / "NIFTY 24 Nov FUT". */
export function contractName(l, underlying) {
  const exp = dayText(l.expiry);
  return l.kind === "FUT" ? `${underlying} ${exp} FUT` : `${underlying} ${exp} ${formatInt(l.strike)} ${l.right}`;
}

/** Lots text ("−1 lot", "+2 lots") or units when not a lot multiple. */
export function lotsText(q, lot) {
  const L = num(lot);
  if (!L || q % L !== 0) return `${q > 0 ? "+" : "−"}${formatInt(Math.abs(q))} qty`;
  const n = q / L;
  return `${n > 0 ? "+" : "−"}${formatInt(Math.abs(n))} lot${Math.abs(n) === 1 ? "" : "s"}`;
}

/** The chip a holder carries: relationship and family membership (text, never colour alone). */
export function relationshipChip(h0, scope) {
  const rel = h0.relationship ? REL_LABEL[h0.relationship] ?? h0.relationship : "No relationship";
  if (!h0.inFamily) return { text: `${rel} · Outside family`, tone: "warn" };
  return { text: scope === "family" ? rel : `${rel} · Family`, tone: "ok" };
}

/**
 * The view-model for the All accounts / Family view (pure; tested).
 * @param {object} body  GET /v1/book data
 * @param {"all"|"family"} scope
 */
export function bookViewModel(body, scope) {
  const holders = (body?.holders ?? []).map((x) => {
    const noData = x.priceSource?.kind === "none";
    const accounts = x.accounts.map((a) => ({
      account: a.account,
      label: a.label,
      broker: a.broker,
      mode: a.mode,
      // The demo market-data account reads sample positions in "live" mode: it is never a real live account.
      modeBadge: a.mode !== "live" ? "Paper" : a.broker === "demo" ? "Sample" : "Live",
      positions: a.positions ?? 0,
      pnl: a.pnl,
      pnlText: money(a.pnl),
      pnlTone: toneOf(a.pnl),
      margin: a.margin ? `${rupees(a.margin.used)} used · ${rupees(a.margin.available)} free` : null,
      asOf: a.margin?.asOf ? `as reported ${a.margin.source === "paper" ? "by the paper engine" : `by ${a.broker}`} at ${istTime(a.margin.asOf)}` : null,
      error: a.error ? `${a.error.message}` : null,
    }));
    const underlyings = x.underlyings.map((u) => {
      const g = u.greeks;
      return {
        underlying: u.underlying,
        spotText: num(u.spot) === null ? null : formatFixed(u.spot, 2),
        lot: u.lot,
        greeks: g
          ? [
              { k: "Δ", v: `${signedNum(g.delta, 1)}`, sub: g.deltaLots === null ? null : `${signedNum(g.deltaLots, 2)} lots`, title: "Position delta in units (Σ q·δ); lots = Δ ÷ lot size" },
              { k: "₹Δ", v: moneyCompact(g.rupeeDelta), title: "Δ (units) × spot" },
              { k: "Γ", v: signedNum(g.gamma, 4), title: "Σ q·γ", wide: true },
              { k: "Θ", v: `${money(g.theta)}/d`, tone: toneOf(g.theta), title: "Rupees per day of time decay" },
              { k: "Vega", v: `${money(g.vega)}/pt`, title: "Rupees per IV point" },
            ]
          : null,
        greeksMissing: g ? (g.missing ? `${formatInt(g.missing)} leg${g.missing === 1 ? "" : "s"} not priced` : null) : noData ? x.priceSource.reason : "Greeks need a price for each leg; none came back.",
        legs: u.legs.map((l) => ({
          key: `${l.account}|${l.symbol}`,
          account: l.account,
          accountLabel: accounts.find((a) => a.account === l.account)?.label ?? l.account,
          symbol: l.symbol,
          name: contractName(l, u.underlying),
          kind: l.kind,
          right: l.right,
          strike: l.strike,
          expiry: l.expiry,
          product: l.product ?? null,
          q: l.q,
          lot: u.lot,
          lots: lotsText(l.q, u.lot),
          side: l.q < 0 ? "S" : "B",
          avg: num(l.avg) === null ? DASH : formatFixed(l.avg, 2),
          mark: num(l.mark) === null ? DASH : formatFixed(l.mark, 2),
          markTitle: l.markSource === "mid" ? "Mid of bid and ask" : l.markSource === "ltp" ? "Last traded price (spread too wide for a mid)" : l.markSource === "position" ? "Broker's LTP on the position" : noData ? "Broker-reported" : null,
          rawMark: num(l.mark),
          bid: num(l.bid),
          ask: num(l.ask),
          pnl: money(l.pnl),
          pnlTone: toneOf(l.pnl),
          delta: l.greeks ? signedNum(l.q * l.greeks.delta, 1) : DASH,
          gamma: l.greeks ? signedNum(l.q * l.greeks.gamma, 4) : DASH,
          theta: l.greeks ? money(l.q * l.greeks.theta) : DASH,
          vega: l.greeks ? money(l.q * l.greeks.vega) : DASH,
          iv: num(l.iv) === null ? null : `${formatFixed(l.iv, 1)}%`,
          greeksTitle: l.greeks ? null : noData ? x.priceSource.reason : "Not priced",
          guarded: (l.guarded ?? []).length > 0,
        })),
      };
    });
    const t = x.totals ?? {};
    return {
      holder: x.holder,
      label: x.label,
      relationship: x.relationship ?? "none",
      inFamily: x.inFamily,
      chip: relationshipChip(x, scope),
      priceNote: noData ? x.priceSource.reason : x.priceSource?.kind === "paper" ? "Priced from the paper engine's source" : x.priceSource?.kind === "account" ? `Priced from ${x.priceSource.account}` : null,
      pnl: money(t.pnl),
      pnlTone: toneOf(t.pnl),
      summary: [num(t.theta) === null ? null : `Θ ${money(t.theta)}/d`, num(t.rupeeDelta) === null ? null : `₹Δ ${moneyCompact(t.rupeeDelta)}`, num(t.vega) === null ? null : `Vega ${money(t.vega)}/pt`].filter(Boolean).join(" · "),
      accounts,
      underlyings,
      legCount: underlyings.reduce((s, u) => s + u.legs.length, 0),
    };
  });
  const ft = body?.family?.totals;
  const strip =
    scope === "family" && ft
      ? [
          { k: "pnl", label: "Family P&L", value: money(ft.pnl), tone: toneOf(ft.pnl), sub: `realised ${money(ft.realised)} · open ${money(ft.unrealised)}` },
          { k: "theta", label: "Θ ₹/day", value: money(ft.theta), tone: toneOf(ft.theta), sub: "time decay, all family legs" },
          { k: "vega", label: "Vega ₹/pt", value: money(ft.vega), tone: "fg", sub: "per IV point" },
          { k: "rdelta", label: "₹Δ", value: moneyCompact(ft.rupeeDelta), tone: "fg", sub: "Δ × spot, summed; not a hedge ratio" },
          { k: "margin", label: "Margin used / free", value: `${rupees(ft.marginUsed)} / ${rupees(ft.marginAvailable)}`, tone: "fg", sub: BOOK_NOTES.margin },
        ]
      : null;
  return {
    strip,
    stripNote: scope === "family" && body?.family ? `${formatInt(body.family.totals.accounts)} account${body.family.totals.accounts === 1 ? "" : "s"} · ${body.family.holders.length} holder${body.family.holders.length === 1 ? "" : "s"}${body.family.totals.partial ? " · only the accounts this key may see" : ""}` : null,
    holders,
    outside: (body?.outsideFamily ?? []).map((o) => ({ holder: o.holder, label: o.label, chip: relationshipChip({ ...o, inFamily: false }, scope), accounts: `${formatInt(o.accounts)} account${o.accounts === 1 ? "" : "s"}`, note: o.note })),
    notes: [scope === "family" ? body?.family?.notes?.[0] ?? BOOK_NOTES.family : BOOK_NOTES.margin, body?.method ?? BOOK_NOTES.method, body?.disclaimer ?? BOOK_NOTES.disclaimer].filter(Boolean),
    partial: Boolean(body?.partial),
    empty: holders.every((x) => x.legCount === 0),
  };
}

const media = (q) => (typeof matchMedia === "function" ? matchMedia(q) : { matches: false });
const isPhone = () => media("(max-width: 719px)").matches;

/**
 * The All accounts / Family view.
 * @param {{ openTicket: (o: object) => Promise<unknown> }} o
 */
export function createBookView({ openTicket }) {
  let scope = "all";
  let data = null;
  let error = null;
  let loadedFor = null;
  let lastAt = 0;
  let busy = false;
  let selected = [];
  const collapsed = new Set();
  const root = h("div", { class: "bk-root" });
  const panel = h("section", { class: "desk-panel bk-panel", "aria-label": "Book across accounts" }, root);

  async function load(force = false) {
    if (busy) return;
    if (!force && loadedFor === scope && Date.now() - lastAt < BOOK_POLL_MS) return;
    busy = true;
    const want = scope;
    const r = await optional(api(`/v1/book?view=${want === "family" ? "family" : "holders"}`));
    busy = false;
    if (want !== scope) return load(true);
    lastAt = Date.now();
    loadedFor = want;
    if (r.error) error = r.error;
    else {
      error = null;
      data = r.data?.data ?? null;
    }
    draw();
  }

  function exitLeg(l) {
    const tick = 0.05;
    openTicket({
      row: { strike: l.strike },
      right: l.right ?? "CE",
      kind: l.kind,
      side: l.q > 0 ? "SELL" : "BUY",
      qty: Math.abs(l.q),
      held: Math.abs(l.q),
      symbol: l.symbol,
      expiry: l.expiry,
      product: l.product,
      exit: true,
      account: l.account,
      quote: () => ({ ltp: l.rawMark, bid: l.bid, ask: l.ask }),
      units: Boolean(l.lot) && Math.abs(l.q) % l.lot !== 0,
      lotSize: l.lot,
      tick,
      name: l.name,
    }).then((r) => r === "placed" && load(true));
  }

  async function exitSelected(vm) {
    const legs = vm.holders.flatMap((x) => x.underlyings.flatMap((u) => u.legs)).filter((l) => selected.some((s) => s.account === l.account && s.symbol === l.symbol));
    selected = [];
    draw();
    for (const l of legs) {
      // One ticket at a time, each to the leg's own account.
      // eslint-disable-next-line no-await-in-loop
      const r = await openTicket({ row: { strike: l.strike }, right: l.right ?? "CE", kind: l.kind, side: l.q > 0 ? "SELL" : "BUY", qty: Math.abs(l.q), held: Math.abs(l.q), symbol: l.symbol, expiry: l.expiry, product: l.product, exit: true, account: l.account, quote: () => ({ ltp: l.rawMark, bid: l.bid, ask: l.ask }), lotSize: l.lot, tick: 0.05, name: l.name });
      if (r !== "placed") break;
    }
    load(true);
  }

  function toggleSelect(l) {
    const r = selectLeg(selected, { account: l.account, symbol: l.symbol });
    selected = r.selected;
    if (r.cleared) toast("Exits go to one account at a time");
    draw();
  }

  const isSel = (l) => selected.some((s) => s.account === l.account && s.symbol === l.symbol);

  function legActions(l) {
    return h(
      "div",
      { class: "bk-acts" },
      h("button", { type: "button", class: "small", "aria-label": `Exit ${l.name} on ${l.accountLabel}`, onclick: () => exitLeg(l) }, "Exit"),
    );
  }
  const check = (l) => h("input", { type: "checkbox", class: "bk-check", "data-focus-key": `sel|${l.key}`, checked: isSel(l), "aria-label": `Select ${l.name} on ${l.accountLabel}`, onchange: () => toggleSelect(l) });
  const greekCell = (v, title) => (title ? h("span", { class: "muted", title }, v) : v);

  function legsTable(u) {
    return h(
      "div",
      { class: "bk-table-wrap" },
      h(
        "table",
        { class: "bk-legs" },
        h("caption", { class: "pal-sr-only" }, `${u.underlying} legs across accounts`),
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", { scope: "col", class: "bk-c-sel" }, h("span", { class: "pal-sr-only" }, "Select")),
            h("th", { scope: "col", class: "bk-c-acct" }, "Account"),
            h("th", { scope: "col" }, "Contract"),
            h("th", { scope: "col", class: "num" }, "Lots"),
            h("th", { scope: "col", class: "num" }, "Avg → Mark"),
            h("th", { scope: "col", class: "num" }, "P&L"),
            h("th", { scope: "col", class: "num" }, "Δ"),
            h("th", { scope: "col", class: "num bk-c-gamma" }, "Γ"),
            h("th", { scope: "col", class: "num" }, "Θ ₹/d"),
            h("th", { scope: "col", class: "num" }, "Vega ₹"),
            h("th", { scope: "col", class: "bk-c-act" }, h("span", { class: "pal-sr-only" }, "Actions")),
          ),
        ),
        h(
          "tbody",
          {},
          u.legs.map((l) =>
            h(
              "tr",
              { "data-selected": isSel(l) ? "" : null },
              h("td", { class: "bk-c-sel" }, check(l)),
              h("td", { class: "bk-c-acct" }, h("span", { class: "bk-acct-chip", title: l.account }, l.accountLabel)),
              h("td", { class: "bk-contract-cell" }, h("span", { class: "bk-acct-chip bk-acct-inline", title: l.account }, l.accountLabel), h("span", { class: "bk-contract" }, h("span", { class: `bk-side ${l.side === "S" ? "s" : "b"}`, "aria-label": l.side === "S" ? "Short" : "Long" }, l.side), h("span", {}, l.name), l.guarded ? h("span", { class: "bk-shield", title: "A guard watches this leg" }, icon("safety")) : null, l.iv ? h("small", { class: "muted bk-iv" }, `IV ${l.iv}`) : null)),
              h("td", { class: "num" }, l.lots),
              h("td", { class: "num", title: l.markTitle }, `${l.avg} → ${l.mark}`),
              h("td", { class: "num" }, h("span", { "data-tone": l.pnlTone, class: "bk-tone" }, l.pnl)),
              h("td", { class: "num" }, greekCell(l.delta, l.greeksTitle)),
              h("td", { class: "num bk-c-gamma" }, greekCell(l.gamma, l.greeksTitle)),
              h("td", { class: "num" }, greekCell(l.theta, l.greeksTitle)),
              h("td", { class: "num" }, greekCell(l.vega, l.greeksTitle)),
              h("td", { class: "bk-c-act" }, legActions(l)),
            ),
          ),
        ),
      ),
    );
  }

  function legCards(u) {
    return h(
      "ul",
      { class: "bk-cards", "aria-label": `${u.underlying} legs across accounts` },
      u.legs.map((l) =>
        h(
          "li",
          { class: "bk-card", "data-selected": isSel(l) ? "" : null },
          h("div", { class: "bk-card-top" }, h("label", { class: "bk-card-check" }, check(l)), h("span", { class: "bk-acct-chip", title: l.account }, l.accountLabel), h("span", { class: "bk-tone bk-card-pnl", "data-tone": l.pnlTone }, l.pnl)),
          h("div", { class: "bk-card-name" }, h("span", { class: `bk-side ${l.side === "S" ? "s" : "b"}`, "aria-label": l.side === "S" ? "Short" : "Long" }, l.side), h("strong", {}, l.name), h("span", { class: "muted" }, ` ${l.lots}`), l.guarded ? h("span", { class: "bk-shield", title: "A guard watches this leg" }, icon("safety")) : null),
          h(
            "div",
            { class: "bk-card-foot" },
            h("span", { class: "muted bk-card-g", title: l.greeksTitle ?? undefined }, h("span", {}, `${l.avg} → ${l.mark}`), h("span", {}, `Δ ${l.delta}`), h("span", {}, `Θ ${l.theta}`)),
            legActions(l),
          ),
        ),
      ),
    );
  }

  function holderSection(x, phone) {
    const open = !collapsed.has(x.holder);
    const bodyId = `bk-h-${x.holder.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const head = h(
      "button",
      { type: "button", class: "bk-hhead", "data-focus-key": `holder|${x.holder}`, "aria-expanded": String(open), "aria-controls": bodyId, onclick: () => (open ? collapsed.add(x.holder) : collapsed.delete(x.holder), draw()) },
      h("span", { class: "bk-hname" }, h("strong", {}, x.label), h("span", { class: "bk-rel", "data-tone": x.chip.tone }, x.chip.text)),
      h("span", { class: "bk-hsum" }, h("span", { class: "bk-tone bk-hpnl", "data-tone": x.pnlTone }, x.pnl), x.summary ? h("small", { class: "muted" }, x.summary) : null),
      h("span", { class: "bk-chev", "aria-hidden": "true" }, icon("chevron")),
    );
    const accts = h(
      "div",
      { class: "bk-accts" },
      x.accounts.map((a) =>
        h(
          "div",
          { class: "bk-acct", "data-error": a.error ? "" : null },
          h("div", { class: "bk-acct-top" }, h("strong", {}, a.label), h("span", { class: "acct-badge", "data-mode": a.modeBadge === "Live" ? "live" : "paper" }, a.modeBadge), h("span", { class: "bk-tone", "data-tone": a.pnlTone }, a.pnlText)),
          a.error ? h("div", { class: "bk-acct-err" }, icon("warn"), a.error) : h("div", { class: "muted bk-acct-sub" }, `${formatInt(a.positions)} open leg${a.positions === 1 ? "" : "s"}${a.margin ? ` · ${a.margin}` : ""}`),
          a.asOf ? h("div", { class: "muted bk-acct-asof" }, a.asOf) : null,
        ),
      ),
    );
    const unders = x.underlyings.map((u) =>
      h(
        "div",
        { class: "bk-under" },
        h(
          "div",
          { class: "bk-uhead" },
          h("span", { class: "bk-uname" }, h("strong", {}, u.underlying), u.spotText ? h("span", { class: "muted" }, ` ${u.spotText}`) : null),
          u.greeks
            ? h("span", { class: "bk-greeks" }, u.greeks.map((g) => h("span", { class: `bk-g${g.wide ? " bk-c-gamma" : ""}`, title: g.title }, h("i", {}, g.k), h("b", { class: "bk-tone", "data-tone": g.tone ?? "fg" }, g.v), g.sub ? h("small", { class: "muted" }, ` ${g.sub}`) : null)))
            : null,
          u.greeksMissing ? h("span", { class: "bk-gmiss muted" }, icon("info"), u.greeksMissing) : null,
        ),
        phone ? legCards(u) : legsTable(u),
      ),
    );
    return h(
      "section",
      { class: "desk-panel bk-holder", "data-holder-relationship": x.relationship, "data-in-family": x.inFamily ? "" : null, "aria-label": `${x.label} (${x.chip.text})` },
      head,
      h("div", { class: "bk-hbody", id: bodyId, hidden: !open }, accts, x.priceNote ? h("p", { class: "muted bk-price-note" }, x.priceNote) : null, x.legCount ? unders : h("p", { class: "muted bk-none" }, "No open F&O positions on these accounts.")),
    );
  }

  /** Extra panels after the main one (holder sections). */
  let holderEls = [];
  const after = h("div", { class: "bk-after" });
  // One fixed block on the page (not a movable panel): the summary panel, then one panel per holder.
  const wrap = h("div", { class: "bk-wrap", "data-fixed": "", hidden: true }, panel, after);

  /** Redraw, keeping keyboard focus on the same control (a checkbox, a holder header) across the rebuild. */
  function draw() {
    const fk = document.activeElement?.closest?.(".bk-wrap") ? document.activeElement.getAttribute("data-focus-key") : null;
    paint();
    if (fk) wrap.querySelector(`[data-focus-key="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
  }
  function paint() {
    const phone = isPhone();
    if (!data && !error) {
      root.replaceChildren(loadingState({ rows: 5, cols: 4, label: "Reading every account" }));
      after.replaceChildren();
      return;
    }
    if (error && !data) {
      root.replaceChildren(alertBox(error), h("div", { class: "row" }, h("button", { type: "button", class: "small", onclick: () => load(true) }, "Try again")));
      after.replaceChildren();
      return;
    }
    const vm = bookViewModel(data, scope);
    const head = h(
      "div",
      { class: "panel-head bk-head" },
      h("span", { class: "panel-title" }, h("strong", {}, scope === "family" ? data.family?.name ?? "Family" : "All accounts"), h("span", { class: "muted" }, scope === "family" ? ` · ${vm.stripNote ?? ""}` : ` · ${vm.holders.length} holder${vm.holders.length === 1 ? "" : "s"}`)),
      h("span", { class: "muted bk-asof" }, `as of ${istTime(data.asOf)}`),
    );
    const strip = vm.strip
      ? h(
          "div",
          { class: "bk-strip", role: "list" },
          vm.strip.map((t) => h("div", { class: `bk-tile bk-tile-${t.k}`, role: "listitem" }, h("span", { class: "bk-tile-k" }, t.label), h("strong", { class: "bk-tone bk-tile-v", "data-tone": t.tone }, t.value), h("small", { class: "muted" }, t.sub))),
        )
      : h("p", { class: "muted bk-lead" }, "Every visible account, grouped by holder. Each holder is priced from its own market data. Exits go to the leg's own account.");
    const bulk = selected.length
      ? h(
          "div",
          { class: "bk-bulk", role: "region", "aria-label": "Selected legs" },
          h("span", {}, `${formatInt(selected.length)} leg${selected.length === 1 ? "" : "s"} · ${vm.holders.flatMap((x) => x.accounts).find((a) => a.account === selected[0].account)?.label ?? selected[0].account}`),
          h("button", { type: "button", class: "small", onclick: () => ((selected = []), draw()) }, "Clear"),
          h("button", { type: "button", class: "small primary", onclick: () => exitSelected(vm) }, "Exit selected"),
        )
      : null;
    root.replaceChildren(...[head, strip, error ? alertBox(error, "warn") : null].filter(Boolean));
    holderEls = vm.holders.map((x) => holderSection(x, phone));
    const outside = vm.outside.length
      ? h(
          "section",
          { class: "desk-panel bk-outside", "aria-label": "Outside the family" },
          h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, h("strong", {}, "Not in the family view"))),
          h(
            "ul",
            { class: "bk-out-list" },
            vm.outside.map((o) => h("li", {}, h("strong", {}, o.label), h("span", { class: "bk-rel", "data-tone": "warn" }, o.chip.text), h("span", { class: "muted" }, o.accounts))),
          ),
          h("p", { class: "muted bk-out-note" }, vm.outside[0].note, " ", h("a", { href: "#/accounts" }, "Set the relationship on the Accounts page")),
        )
      : null;
    const notes = h("footer", { class: "bk-notes muted" }, vm.notes.map((n) => h("p", {}, n)));
    const nothing = vm.empty && !vm.holders.length ? emptyState("accounts", "No accounts to show", "This key cannot see any account with positions.") : null;
    // The selection bar floats at the bottom of the view (sticky), next to the legs being chosen.
    after.replaceChildren(...[nothing, ...holderEls, outside, notes, bulk].filter(Boolean));
  }

  return {
    el: wrap,
    /** Show the view for a scope ("all" | "family"); null hides it. */
    show(s) {
      const on = s === "all" || s === "family";
      wrap.hidden = !on;
      if (!on) return;
      if (s !== scope) {
        scope = s;
        selected = [];
        if (loadedFor !== s) data = data && loadedFor ? data : null;
      }
      draw();
      load(loadedFor !== s);
    },
    /** The desk timer's tick: reads again at most every 15 s. */
    tick: () => load(false),
    refresh: () => load(true),
    redraw: () => data && draw(),
  };
}
