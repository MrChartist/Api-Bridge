// Orders › Statement: realised P&L by financial year and segment, F&O turnover (ICAI method), itemised charges from
// the ticket's model and, for paper accounts, a ledger by day. An estimate for the trader's records, not tax advice.
// Loaded on first visit (views.js PAGE_MODULES); the charges model (options.js) comes with it.
import { alertBox, api, card, emptyState, h, optional, table, toast } from "./app.js";
import { contractName } from "./flows.js";
import { DASH, formatDayMonth, formatFixed, formatInt, formatRupee, formatRupeeGrouped, formatSignedRupee } from "./format.js";
import * as O from "./options.js";
import { loadReference, refCharges } from "./reference.js";
import { CHARGE_LABELS, SEGMENTS, byFinancialYear, fillChargesWith, financialYear, istDayOf, statement, statementSheets } from "./statement-core.js";
import { exportName } from "./export.js";
import { buildXlsx } from "./xlsx-core.js";

/** The ticket's charges model for fills: options.js charges with the reference table's rates (NIFTY's bundle). */
export async function chargesModel() {
  let rates;
  try {
    rates = refCharges(await loadReference("NIFTY"));
  } catch {
    rates = refCharges(null);
  }
  return { chargesOf: fillChargesWith(O.charges, rates), asOf: rates.asOf, source: rates.source };
}

/** Every fill on an account, newest pages first, up to 2500. */
async function allTrades(account) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 5; i += 1) {
    const r = await optional(api(`/v1/trades?account=${encodeURIComponent(account)}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
    if (r.error) return { items: out, error: r.error };
    out.push(...(r.data?.data ?? []));
    cursor = r.data?.meta?.nextCursor ?? null;
    if (!cursor) break;
  }
  return { items: out, error: null };
}

/** Short column heads for the by-year table (the by-segment table says each in full). */
const SHORT_SEGMENT = { fno: "F&O", intraday: "Intraday", stcg: "STCG", ltcg: "LTCG" };

const KEY = "mcb.statement";
const remember = (v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private window */
  }
};
const recall = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
};

export async function renderStatementPage() {
  const accs = (await optional(api("/v1/accounts"))).data?.data ?? [];
  const usable = accs.filter((a) => a.broker !== "demo");
  if (!usable.length) return [card({ title: "Statement", body: emptyState("orders", "No account", "Add an account on the Accounts page.") })];
  const saved = recall();
  let accountId = usable.some((a) => a.id === saved.account) ? saved.account : usable[0].id;
  const today = istDayOf(Date.now());
  const fy = financialYear(today);
  const lastFy = financialYear(`${Number(fy.from.slice(0, 4)) - 1}-06-01`);
  const PERIODS = [
    ["fy", fy.label, fy.from, fy.to],
    ["lastfy", lastFy.label, lastFy.from, lastFy.to],
    ["month", "This month", `${today.slice(0, 7)}-01`, today],
    ["all", "All", "0000-01-01", "9999-12-31"],
  ];
  let period = PERIODS.some((p) => p[0] === saved.period) ? saved.period : "fy";
  const model = await chargesModel();
  const root = h("div", { class: "stack bk-st" });
  const acctSel = h("select", { "aria-label": "Account", class: "bk-st-acct" }, usable.map((a) => h("option", { value: a.id, selected: a.id === accountId }, a.label)));
  const periodBar = h("div", { class: "bk-chips", role: "group", "aria-label": "Period" });
  const xlsxBtn = h("button", { type: "button", class: "small" }, "Excel (.xlsx)");
  let last = null;

  async function draw() {
    remember({ account: accountId, period });
    periodBar.replaceChildren(...PERIODS.map(([id, label]) => h("button", { type: "button", class: "chip-btn bk-chip", "aria-pressed": String(id === period), onclick: () => ((period = id), draw()) }, label)));
    const acc = usable.find((a) => a.id === accountId);
    const paper = acc?.broker === "paper";
    const [tr, pa] = await Promise.all([allTrades(accountId), paper ? optional(api(`/v1/paper/accounts/${encodeURIComponent(accountId)}`)) : Promise.resolve(null)]);
    const [, , from, to] = PERIODS.find((p) => p[0] === period);
    const opening = paper ? (pa?.data?.data?.startingCapital ?? null) : null;
    const s = statement(tr.items, { from, to, chargesOf: model.chargesOf, opening: period === "all" || period === "fy" ? opening : null });
    const years = byFinancialYear(tr.items);
    last = { s, years, acc, from, to };
    const fig = (label, value, cls) => h("div", {}, h("small", {}, label), cls ? h("span", { class: cls }, value) : value);
    const tone = (v) => (v > 0 ? "up" : v < 0 ? "down" : undefined);
    const cards = [
      card({
        glyph: "list",
        tint: "teal",
        title: "Statement",
        sub: "Realised P&L, F&O turnover and charges from this Bridge's fills. An estimate for your records, not tax advice: confirm with your CA. Tax payable is not worked out here.",
        actions: h("div", { class: "row" }, acctSel, xlsxBtn),
        flush: true,
        body: h(
          "div",
          {},
          h("div", { class: "bk-ob-bar" }, periodBar),
          tr.error ? h("div", { class: "card-body" }, alertBox(tr.error)) : null,
          h(
            "div",
            { class: "ticket-figs bk-tb-figs" },
            fig("Realised P&L", formatSignedRupee(s.realised, 0), tone(s.realised)),
            fig("F&O turnover", formatRupee(s.turnover, 0)),
            fig("Charges", formatRupee(s.charges.total, 0)),
            fig("Net after charges", formatSignedRupee(s.net, 0), tone(s.net)),
            fig("Trades closed", formatInt(s.closed.length)),
          ),
          h(
            "p",
            { class: "muted small bk-st-note" },
            "F&O turnover is the sum of each settled trade's absolute profit or loss (for options, the premium is part of that difference), the method in the ICAI Guidance Note on Tax Audit. Charges use the ticket's model and the reference table's rates (",
            model.asOf,
            "). ",
            s.charges && s.fills.unpriced ? `${formatInt(s.fills.unpriced)} equity fills are not priced by the model. ` : "",
            "Open positions are not in the P&L until they close.",
          ),
        ),
      }),
      card({
        glyph: "chart",
        tint: "purple",
        title: "By segment",
        sub: "How each kind of trade is usually reported. A CA confirms how it is filed.",
        flush: true,
        body: table(
          [
            { label: "Segment", wrap: true, cell: (r) => h("div", {}, h("strong", {}, r[1]), h("div", { class: "muted small" }, r[2])) },
            { label: "Trades", num: true, cell: (r) => formatInt(s.segments[r[0]].trades) },
            { label: "Won", num: true, cell: (r) => formatInt(s.segments[r[0]].wins) },
            { label: "Turnover", num: true, cell: (r) => (r[0] === "fno" ? formatRupee(s.segments.fno.turnover, 0) : DASH) },
            { label: "Realised", num: true, cell: (r) => h("span", { class: tone(s.segments[r[0]].realised) }, formatSignedRupee(s.segments[r[0]].realised, 0)) },
          ],
          SEGMENTS.filter(([k]) => k === "fno" || s.segments[k].trades),
          emptyState("chart", "Nothing closed in this period", null, null, { compact: true }),
        ),
      }),
      card({
        glyph: "wallet",
        tint: "orange",
        title: "Charges",
        sub: "Itemised from the same model as the ticket, so they add up to the Trades tab's charges for the same days.",
        flush: true,
        body: table(
          [
            { label: "Charge", cell: (k) => (k === "total" ? h("strong", {}, "Total") : CHARGE_LABELS[k]) },
            { label: "Amount", num: true, cell: (k) => formatRupee(s.charges[k], 2) },
          ],
          [...Object.keys(CHARGE_LABELS), "total"].map((k) => k),
          null,
        ),
      }),
      card({
        glyph: "calendar",
        tint: "blue",
        title: "By financial year",
        sub: "Realised P&L for every year this Bridge has fills for (April to March).",
        flush: true,
        body: table(
          [
            { label: "Year", cell: (r) => r.label },
            ...SEGMENTS.map(([k]) => ({ label: SHORT_SEGMENT[k], num: true, cell: (r) => (r.segments[k] ? h("span", { class: tone(r.segments[k]) }, formatSignedRupee(r.segments[k], 0)) : DASH) })),
          ],
          years,
          emptyState("calendar", "No closed trades yet", null, null, { compact: true }),
        ),
      }),
      paper
        ? card({
            glyph: "inbox",
            tint: "teal",
            title: "Ledger",
            sub: period === "all" || period === "fy" ? "Paper cash by day: opening, realised P&L, charges, closing." : "Paper cash by day. The running balance shows for All and this financial year.",
            flush: true,
            body: table(
              [
                { label: "Day", cell: (r) => formatDayMonth(r.day) },
                { label: "Opening", num: true, cell: (r) => formatRupeeGrouped(r.opening, 0) },
                { label: "Realised", num: true, cell: (r) => h("span", { class: tone(r.realised) }, formatSignedRupee(r.realised, 0)) },
                { label: "Charges", num: true, cell: (r) => formatRupee(r.charges, 0) },
                { label: "Closing", num: true, cell: (r) => formatRupeeGrouped(r.closing, 0) },
              ],
              [...s.ledger].reverse(),
              emptyState("inbox", "No movements in this period", null, null, { compact: true }),
            ),
          })
        : card({ glyph: "inbox", tint: "teal", title: "Ledger", body: h("p", { class: "card-body muted" }, `For ${acc?.label ?? accountId}, your broker's ledger is the source of truth: funds added and withdrawn, pledges and charges are with the broker.`) }),
      card({
        glyph: "orders",
        tint: "gray",
        title: "Closed trades",
        sub: "First in, first out, per contract and product.",
        flush: true,
        body: table(
          [
            { label: "Closed", cell: (c) => formatDayMonth(c.day) },
            { label: "Contract", wrap: true, cell: (c) => h("div", { class: "order-contract" }, h("strong", {}, contractName(c.symbol)), h("div", { class: "muted small" }, `${c.side === "long" ? "Long" : "Short"} · ${c.product ?? ""}`)) },
            { label: "Qty", num: true, cell: (c) => formatInt(c.qty) },
            { label: "Entry", num: true, cell: (c) => formatFixed(c.entry, 2) },
            { label: "Exit", num: true, cell: (c) => formatFixed(c.exit, 2) },
            { label: "P&L", num: true, cell: (c) => h("span", { class: tone(c.pnl) }, formatSignedRupee(c.pnl, 0)) },
          ],
          [...s.closed].reverse(),
          emptyState("orders", "No closed trades in this period", null, null, { compact: true }),
        ),
      }),
    ];
    // Wide screens: By segment, By financial year and the Ledger stacked beside Charges, so neither column leaves a
    // gap (one column below 1024 px).
    const pair = (x, y) => h("div", { class: "bk-st-pair" }, x, y);
    root.replaceChildren(cards[0], pair(h("div", { class: "bk-st-col" }, cards[1], cards[3], cards[4]), cards[2]), cards[5]);
  }
  acctSel.addEventListener("change", () => ((accountId = acctSel.value), draw()));
  xlsxBtn.addEventListener("click", () => {
    if (!last) return;
    const { s, years, acc, from, to } = last;
    const bytes = buildXlsx({ sheets: statementSheets({ s, years, acc, from, to }) });
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = exportName(`statement ${acc?.label ?? ""}`, "xlsx");
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast("Statement downloaded as .xlsx");
  });
  await draw();
  return [root];
}
