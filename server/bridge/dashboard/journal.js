// journal.js: Orders › Journal. Every paper fill (and live fill, when a broker reports them) grouped into trades by
// strategy group, with tags, notes and a setup per trade; a P&L calendar from the paper engine's daily snapshots;
// stats per strategy, tag, setup or underlying (win rate with its sample size, average win and loss, expectancy, max
// drawdown); CSV export. Data: GET /v1/journal, PUT /v1/journal/trades/{id}, POST /v1/paper/accounts/{id}/daily.
// The maths is journal-core.js (pure, tested). Numbers become text only through format.js.
import { api, app, card, emptyState, errorState, h, icon, istDateTime, modal, optional, pill, table, toast } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatPercent, formatSignedRupee, isFigure } from "./format.js";
import { journalCsv, monthGrid, shiftMonth, tradeStats, statsOf, cleanTags } from "./journal-core.js";
import { contractName } from "./flows.js";
import { segmented } from "./views.js";
import { heatCell } from "./viz.js";

const SLOT = "mcb.dashboard.journal";
const rs = (v, dp = 0) => formatSignedRupee(v, dp);
const tone = (v) => (isFigure(v) && Math.round(v) > 0 ? "up" : isFigure(v) && Math.round(v) < 0 ? "down" : "");
const money = (v) => h("span", { class: `nowrap ${tone(v)}` }, isFigure(v) ? rs(v) : DASH);
const DAY_FMT = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const MONTH_FMT = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });
const dayText = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso ?? "") ? DAY_FMT.format(new Date(`${iso}T00:00:00Z`)) : "");
const istToday = () => new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
/** "₹4.2K" style for a calendar cell, with its sign. */
const compactRs = (v) => (isFigure(v) ? `${v > 0.5 ? "+" : v < -0.5 ? "−" : ""}₹${Math.abs(v) >= 10_000 ? `${formatInt(Math.round(Math.abs(v) / 1000))}K` : formatCompact(Math.abs(v))}` : "");

/** Save text as a file (CSV, workbook): a Blob link clicked once. */
export function saveFile(name, text, type = "text/csv;charset=utf-8") {
  try {
    const blob = new Blob([text], { type });
    const a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return true;
  } catch {
    toast("This browser could not save the file", { tone: "error" });
    return false;
  }
}

const readPrefs = () => {
  try {
    return JSON.parse(app.local.get(SLOT) ?? "{}") ?? {};
  } catch {
    return {};
  }
};

export async function renderJournalPage() {
  const prefs = readPrefs();
  const st = { account: prefs.account ?? "", by: ["structure", "tag", "setup", "underlying"].includes(prefs.by) ? prefs.by : "structure", month: /^\d{4}-\d{2}$/.test(prefs.month ?? "") ? prefs.month : istToday().slice(0, 7), filter: prefs.filter ?? "all", tag: "" };
  const save = () => app.local.set(SLOT, JSON.stringify({ account: st.account, by: st.by, month: st.month, filter: st.filter }));
  const [accRes, jRes] = await Promise.all([optional(api("/v1/accounts")), optional(api(`/v1/journal${st.account ? `?account=${encodeURIComponent(st.account)}` : ""}`))]);
  if (jRes.error) return [errorState(jRes.error, { onRetry: () => (location.hash = "#/orders/journal") })];
  let J = jRes.data.data;
  const accounts = (accRes.data?.data ?? []).filter((a) => J.accounts.includes(a.id) || a.id === st.account);
  const labelOf = (id) => accounts.find((a) => a.id === id)?.label ?? id;

  // ── Toolbar: account, snapshot, export ──
  const accSel = h("select", { "aria-label": "Account", class: "jr-acct" }, h("option", { value: "" }, "All accounts"), ...accounts.map((a) => h("option", { value: a.id, selected: a.id === st.account }, a.label)));
  accSel.addEventListener("change", () => {
    st.account = accSel.value;
    save();
    reload();
  });
  const paperAccs = () => accounts.filter((a) => a.broker === "paper" && (!st.account || a.id === st.account));
  const snapBtn = h("button", { type: "button", class: "small", title: "Store today's P&L for each paper account now (the Bridge also stores it after the close)", onclick: () => snapshot() }, icon("clock"), h("span", {}, "Snapshot today"));
  const csvBtn = h("button", { type: "button", class: "small", onclick: () => exportCsv() }, icon("download"), h("span", {}, "Export CSV"));
  const bar = h("div", { class: "jr-bar" }, h("label", { class: "jr-field" }, h("span", {}, "Account"), accSel), h("span", { class: "jr-grow" }), snapBtn, csvBtn);

  // ── Summary tiles ──
  const tiles = h("div", { class: "jr-tiles", role: "group", "aria-label": "Journal summary" });
  // ── Calendar ──
  const calHost = h("div", { class: "jr-cal" });
  const prevBtn = h("button", { type: "button", class: "icon-btn jr-prev", "aria-label": "Previous month", onclick: () => moveMonth(-1) }, icon("chevron"));
  const nextBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Next month", onclick: () => moveMonth(1) }, icon("chevron"));
  const monthLbl = h("strong", { class: "jr-month" });
  const calSum = h("p", { class: "muted small jr-cal-sum" });
  // ── Stats ──
  const bySeg = segmented("Stats by", [["structure", "Strategy"], ["tag", "Tag"], ["setup", "Setup"], ["underlying", "Underlying"]], st.by);
  bySeg.addEventListener("change", () => {
    st.by = bySeg.value;
    save();
    drawStats();
  });
  const statsHost = h("div", { class: "jr-stats" });
  // ── Trades ──
  const fSeg = segmented("Trades", [["all", "All"], ["open", "Open"], ["closed", "Closed"]], st.filter);
  fSeg.addEventListener("change", () => {
    st.filter = fSeg.value;
    save();
    drawTrades();
  });
  const tagSel = h("select", { "aria-label": "Tag", class: "jr-tagsel" });
  tagSel.addEventListener("change", () => {
    st.tag = tagSel.value;
    drawTrades();
  });
  const tradesHost = h("div", { class: "jr-trades" });

  function drawTiles() {
    const s = statsOf(J.trades);
    const open = J.trades.filter((t) => t.status === "open");
    const openPnl = open.reduce((a, t) => a + (t.pnl ?? 0), 0);
    const tile = (k, v, sub) => h("div", { class: "jr-tile" }, h("span", { class: "jr-k" }, k), h("span", { class: "jr-v" }, v), sub ? h("span", { class: "jr-s" }, sub) : null);
    tiles.replaceChildren(
      tile("Closed trades", formatInt(s.n), `${formatInt(open.length)} open · ${rs(openPnl)}`),
      tile("Win rate", s.winRate === null ? DASH : formatPercent(s.winRate, 0), s.n ? `${formatInt(s.wins)} of ${formatInt(s.n)} trades${s.n < 20 ? " · small sample" : ""}` : "no closed trades"),
      tile("Net P&L", money(s.total), "closed, after charges"),
      tile("Expectancy", money(s.expectancy), "per closed trade"),
      tile("Avg win / loss", h("span", {}, money(s.avgWin), h("span", { class: "muted" }, " / "), money(s.avgLoss)), s.avgWin && s.avgLoss ? `ratio ${formatFixed(Math.abs(s.avgWin / s.avgLoss), 2)}` : ""),
      tile("Max drawdown", isFigure(s.maxDrawdown) && s.maxDrawdown > 0 ? h("span", { class: "down" }, rs(-s.maxDrawdown)) : rs(0), "running total from its high"),
    );
  }

  function moveMonth(by) {
    st.month = shiftMonth(st.month, by);
    save();
    drawCalendar();
  }
  function drawCalendar() {
    const g = monthGrid(J.daily, st.month);
    monthLbl.textContent = MONTH_FMT.format(new Date(`${st.month}-01T00:00:00Z`));
    nextBtn.disabled = st.month >= istToday().slice(0, 7);
    const today = istToday();
    const head = h("div", { class: "jr-cal-row jr-cal-dow", "aria-hidden": "true" }, ...["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => h("span", {}, d)));
    const weeks = g.weeks.map((w) =>
      h(
        "div",
        { class: "jr-cal-row", role: "row" },
        ...w.map((c) => {
          const has = c.pnl !== null;
          const cell = h(
            "div",
            { class: `jr-day${c.inMonth ? "" : " out"}${c.day === today ? " today" : ""}`, role: "gridcell", "aria-label": c.inMonth ? `${dayText(c.day)}${has ? `, ${rs(c.pnl)}` : ", no snapshot"}` : "" },
            h("span", { class: "jr-dn" }, c.inMonth ? formatInt(Number(c.day.slice(8))) : ""),
            has ? h("span", { class: "jr-dv" }, compactRs(c.pnl)) : null,
          );
          if (has && g.scale > 0) heatCell(cell, Math.sign(c.pnl) * Math.min(3, Math.ceil((Math.abs(c.pnl) / g.scale) * 3)), "div");
          if (has) cell.title = `${dayText(c.day)}: ${rs(c.pnl)}`;
          return cell;
        }),
      ),
    );
    calHost.replaceChildren(h("div", { class: "jr-cal-grid", role: "grid", "aria-label": `Daily P&L, ${monthLbl.textContent}` }, head, ...weeks));
    calSum.replaceChildren(
      g.days
        ? h("span", {}, "Month ", money(g.total), ` · ${formatInt(g.green)} up, ${formatInt(g.red)} down of ${formatInt(g.days)} days · largest gain `, money(g.best), " · largest loss ", money(g.worst))
        : h("span", {}, "No daily snapshot this month. The Bridge stores one after each close for paper accounts; Snapshot today stores one now."),
    );
  }

  function drawStats() {
    const rows = tradeStats(J.trades, st.by);
    statsHost.replaceChildren(
      table(
        [
          { label: st.by === "tag" ? "Tag" : st.by === "setup" ? "Setup" : st.by === "underlying" ? "Underlying" : "Strategy", cell: (r) => h("strong", {}, r.key) },
          { label: "Trades", num: true, cell: (r) => formatInt(r.n) },
          { label: "Win rate", num: true, cell: (r) => h("span", { title: `${formatInt(r.wins)} won, ${formatInt(r.losses)} lost` }, `${formatPercent(r.winRate, 0)} `, h("small", { class: "muted" }, `n ${formatInt(r.n)}`)) },
          { label: "Avg win", num: true, cell: (r) => money(r.avgWin) },
          { label: "Avg loss", num: true, cell: (r) => money(r.avgLoss) },
          { label: "Expectancy", num: true, cell: (r) => money(r.expectancy) },
          { label: "Total", num: true, cell: (r) => money(r.total) },
          { label: "Max DD", num: true, cell: (r) => (r.maxDrawdown > 0 ? money(-r.maxDrawdown) : rs(0)) },
        ],
        rows,
        emptyState("chart", "No closed trades yet", "Stats appear once a trade is closed: every leg of a strategy group back to flat.", null, { compact: true }),
      ),
    );
  }

  function drawTagSel() {
    const tags = [...new Set(J.trades.flatMap((t) => t.tags ?? []))].sort((a, b) => a.localeCompare(b));
    if (st.tag && !tags.includes(st.tag)) st.tag = "";
    tagSel.replaceChildren(h("option", { value: "" }, "Every tag"), ...tags.map((t) => h("option", { value: t, selected: t === st.tag }, t)));
    tagSel.hidden = !tags.length;
  }
  function drawTrades() {
    const list = J.trades.filter((t) => (st.filter === "all" || t.status === st.filter) && (!st.tag || (t.tags ?? []).includes(st.tag)));
    tradesHost.replaceChildren(
      table(
        [
          { label: "Opened", cell: (t) => h("span", { class: "nowrap" }, istDateTime(new Date(t.openedAt).toISOString())) },
          { label: "Trade", wrap: true, cell: (t) => h("div", { class: "jr-trade" }, h("strong", {}, `${t.underlying}${t.expiry ? ` ${dayText(t.expiry)}` : ""} · ${t.structure}`), h("div", { class: "muted small" }, `${formatInt(t.fills)} fills · ${accounts.length > 1 ? `${labelOf(t.account)} · ` : ""}${t.status === "closed" ? `closed ${istDateTime(new Date(t.closedAt).toISOString())}` : "open"}`)) },
          { label: "Status", cell: (t) => h("span", { class: "jr-pills" }, t.status === "open" ? pill("Open", "warn") : pill("Closed"), t.sample ? pill("Sample") : t.mode === "live" ? pill("Live", "bad") : null) },
          { label: "P&L", num: true, cell: (t) => money(t.pnl) },
          { label: "Tags", wrap: true, cell: (t) => h("span", { class: "jr-tags" }, ...(t.tags ?? []).map((g) => h("span", { class: "chip" }, g)), t.setup ? h("small", { class: "block muted" }, t.setup) : null) },
          { label: "", cell: (t) => h("button", { type: "button", class: "small", "aria-label": `Notes for ${t.underlying} ${t.structure}`, onclick: () => openTrade(t) }, t.notes || t.tags?.length || t.setup ? "Edit" : "Add notes") },
        ],
        list,
        emptyState("orders", J.trades.length ? "No trades match" : "No trades yet", J.trades.length ? "Change the filter above." : "Paper fills from the chain, the Strategy Builder, rolls and baskets become journal entries here, grouped by strategy.", J.trades.length ? null : h("button", { type: "button", class: "primary", onclick: () => (location.hash = "#/chain") }, "Trade from the chain")),
      ),
    );
  }

  async function openTrade(t) {
    const tagsIn = h("input", { id: "jr-tags", type: "text", maxlength: "200", value: (t.tags ?? []).join(", "), placeholder: "weekly, event, adjusted", autocomplete: "off" });
    const setupIn = h("input", { id: "jr-setup", type: "text", maxlength: "80", value: t.setup ?? "", placeholder: "What made you take it", autocomplete: "off" });
    const notesIn = h("textarea", { id: "jr-notes", rows: "5", maxlength: "2000", placeholder: "What happened, what you would repeat or change" }, t.notes ?? "");
    const legs = h("ul", { class: "desk-list jr-legs" }, ...(t.legs ?? []).map((l) => h("li", {}, h("span", { class: `side-tag ${l.q > 0 ? "buy" : "sell"}` }, l.q > 0 ? "B" : "S"), ` ${formatInt(Math.abs(l.q))} × ${contractName(l.symbol)}`)));
    const field = (label, input, hint) => h("label", { class: "field", for: input.id }, h("span", {}, label), input, hint ? h("span", { class: "hint" }, hint) : null);
    const body = h(
      "div",
      { class: "stack jr-sheet" },
      h("p", { class: "muted small" }, `${t.status === "open" ? "Open" : "Closed"} · ${formatInt(t.fills)} fills · charges ${rs(-t.charges)} · P&L `, money(t.pnl)),
      t.legs?.length ? legs : null,
      field("Tags", tagsIn, "Comma separated. Stats group by them."),
      field("Setup", setupIn),
      field("Notes", notesIn),
    );
    const ok = await modal({ title: `${t.underlying}${t.expiry ? ` ${dayText(t.expiry)}` : ""} · ${t.structure}`, body, buttons: [{ label: "Cancel", value: false }, { label: "Save", cls: "primary", value: true }] });
    if (!ok) return;
    const res = await optional(api(`/v1/journal/trades/${encodeURIComponent(t.id)}`, { method: "PUT", body: { tags: cleanTags(tagsIn.value), setup: setupIn.value, notes: notesIn.value } }));
    if (res.error) return toast(`Not saved: ${res.error.message}`, { tone: "error" });
    Object.assign(t, { tags: res.data.data.tags, setup: res.data.data.setup, notes: res.data.data.notes });
    toast("Saved to the journal");
    drawTagSel();
    drawTrades();
    drawStats();
  }

  async function snapshot() {
    const accs = paperAccs();
    if (!accs.length) return toast("Daily snapshots are kept for paper accounts", { tone: "info" });
    snapBtn.disabled = true;
    const out = await Promise.all(accs.map((a) => optional(api(`/v1/paper/accounts/${encodeURIComponent(a.id)}/daily`, { method: "POST" }))));
    snapBtn.disabled = false;
    const bad = out.find((r) => r.error);
    if (bad) toast(`Snapshot failed: ${bad.error.message}`, { tone: "error" });
    else toast(`Today's P&L stored for ${formatInt(accs.length)} paper account${accs.length === 1 ? "" : "s"}`);
    await reload();
  }
  function exportCsv() {
    if (!J.trades.length) return toast("Nothing to export yet", { tone: "info" });
    if (saveFile(`journal-${st.account || "all"}-${istToday()}.csv`, journalCsv(J.trades))) toast(`${formatInt(J.trades.length)} trades saved as CSV`);
  }
  async function reload() {
    const r = await optional(api(`/v1/journal${st.account ? `?account=${encodeURIComponent(st.account)}` : ""}`, { fresh: true }));
    if (r.error) return toast(`Couldn't load the journal: ${r.error.message}`, { tone: "error" });
    J = r.data.data;
    drawAll();
  }
  function drawAll() {
    drawTiles();
    drawCalendar();
    drawStats();
    drawTagSel();
    drawTrades();
  }
  drawAll();

  const notes = [];
  if (J.demo) notes.push(h("p", { class: "muted small jr-note" }, "Demo: trades marked Sample are generated history so the calendar and stats have something to show. Your own paper trades join them as you place them."));
  if (J.problems?.length) notes.push(h("p", { class: "warn-text small jr-note" }, `Not read: ${J.problems.map((p) => `${labelOf(p.account)} (${p.message})`).join("; ")}`));
  return [
    h("div", { class: "jr-top" }, bar, ...notes, tiles),
    h(
      "div",
      { class: "jr-grid" },
      card({ glyph: "calendar", tint: "teal", title: "P&L calendar", sub: "Daily P&L from the paper engine's end-of-day snapshots", actions: h("div", { class: "jr-monthnav" }, prevBtn, monthLbl, nextBtn), body: h("div", {}, calHost, calSum), cls: "jr-cal-card" }),
      card({ glyph: "chart", tint: "purple", title: "Stats", sub: "Closed trades only. Win rate shows its sample size.", actions: bySeg, body: statsHost, flush: true, cls: "jr-stats-card" }),
    ),
    card({ glyph: "orders", tint: "orange", title: "Trades", sub: "Fills grouped by strategy group: one account, underlying and expiry, open until every leg is flat", actions: h("div", { class: "jr-filters" }, tagSel, fSeg), body: tradesHost, flush: true, cls: "jr-trades-card" }),
  ];
}
