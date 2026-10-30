// watchlists.js: Screeners › Watchlists. Your named lists with live quotes, % change, the near future's OI change against
// the previous day for F&O, and the front expiry's ATM IV (the same figure as the Option Chain and Volatility) with
// its rank. One list can feed Live events (it writes the events selection's watchlist and
// turns its WATCHLIST universe on) and one shows on Home. Data: /v1/watchlists (watchlist-core.js does the maths on
// the Bridge). Numbers become text only through format.js. Reads and lists only: nothing here places an order.
import { api, app, emptyState, errorState, h, icon, istTime, modal, optional, toast } from "./app.js";
import { setBar, svgEl } from "./viz.js";
import { DASH, formatCompact, formatDayMonth, formatFixed, formatInt, formatSigned, isFigure } from "./format.js";
import { clearFieldError, fieldError } from "./flows.js";
import { normaliseSymbol, sessionCloses, sortRows } from "./watchlist-core.js";
import { watch } from "./live.js";

const SLOT = "mcb.dashboard.watchlists";
const REFRESH_MS = 5000;
/** Intraday sparklines: 5-minute candles of the latest session, fetched one symbol at a time, again every 5 minutes. */
const SPARK_MS = 5 * 60 * 1000;
const SPARK_MAX_SYMBOLS = 20;

const tone = (v) => (isFigure(v) && v > 0 ? "up" : isFigure(v) && v < 0 ? "down" : "");
const pct = (v) => h("span", { class: `nowrap ${tone(v)}` }, isFigure(v) ? `${formatSigned(v, 2)}%` : DASH);
const CHAINABLE = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]);

const prefs = () => {
  try {
    return JSON.parse(app.local.get(SLOT) ?? "{}") ?? {};
  } catch {
    return {};
  }
};

/** Make a list feed Live events: its symbols become the events watchlist and the WATCHLIST universe is switched on. */
export async function feedEvents(symbols) {
  const cur = await optional(api("/v1/events/selection"));
  const sel = cur.data?.data;
  if (!sel) return cur.error ?? new Error("Live events are not available");
  const universes = sel.universes.includes("WATCHLIST") ? sel.universes : [...sel.universes, "WATCHLIST"];
  const r = await optional(api("/v1/events/selection", { method: "PUT", body: { ...sel, watchlist: symbols, universes } }));
  return r.error ?? null;
}

export async function renderWatchlistsPage() {
  const p = prefs();
  const st = { id: p.id ?? null, sort: p.sort ?? "name", dir: p.dir === -1 ? -1 : 1 };
  const save = () => app.local.set(SLOT, JSON.stringify({ id: st.id, sort: st.sort, dir: st.dir }));
  const res = await optional(api("/v1/watchlists"));
  if (res.error) return [errorState(res.error, { onRetry: () => (location.hash = "#/screeners/watchlists") })];
  let lists = res.data.data.items;
  if (!lists.some((l) => l.id === st.id)) st.id = lists[0]?.id ?? null;
  let quotes = null;
  let timer = 0;
  // symbol -> { at, closes }: the intraday line (the live price is added as its last point on each draw).
  const sparks = new Map();
  let sparkBusy = false;
  async function loadSparks() {
    const l = cur();
    if (sparkBusy || !l) return;
    sparkBusy = true;
    let fetched = 0;
    try {
      for (const s of l.symbols.slice(0, SPARK_MAX_SYMBOLS)) {
        const c = sparks.get(s);
        if (c && Date.now() - c.at < SPARK_MS) continue;
        const r = await optional(api(`/v1/history?symbol=${encodeURIComponent(s)}&interval=5m&countback=80`));
        if (!tableHost.isConnected) return;
        sparks.set(s, { at: Date.now(), closes: r.error ? [] : sessionCloses(r.data?.data?.candles ?? r.data?.candles) });
        fetched += 1;
        sparkSeq += 1;
      }
    } finally {
      sparkBusy = false;
    }
    // This runs after every 5 s poll, nearly always with every line still fresh: redraw only when a line was fetched.
    if (fetched) draw();
  }
  /** The session so far as a line: up in the gain ink, down in the loss ink, the previous close as a dotted level. */
  function sparkFor(r) {
    const closes = [...(sparks.get(r.symbol)?.closes ?? [])];
    if (isFigure(r.ltp) && closes.length) closes.push(r.ltp);
    if (closes.length < 3) return h("span", { class: "wl-spark wl-spark-none", "aria-hidden": "true" });
    const prev = isFigure(r.ltp) && isFigure(r.change) ? r.ltp - r.change : null;
    const all = prev === null ? closes : [...closes, prev];
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const W = 160;
    const H = 32;
    const y = (v) => (hi - lo < 1e-9 ? H / 2 : 2 + (1 - (v - lo) / (hi - lo)) * (H - 4));
    const pts = closes.map((v, i) => `${formatFixed((i / (closes.length - 1)) * W, 1)},${formatFixed(y(v), 1)}`).join(" ");
    const up = closes[closes.length - 1] >= (prev ?? closes[0]);
    const svg = svgEl("svg", { class: `wl-spark ${up ? "up" : "down"}`, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": `${r.name} today: ${formatInt(closes.length)} points, ${up ? "up" : "down"} on the day` });
    if (prev !== null) svg.append(svgEl("line", { class: "wl-spark-prev", x1: 0, x2: W, y1: y(prev), y2: y(prev) }));
    svg.append(svgEl("polyline", { points: pts }));
    return svg;
  }

  const listSel = h("select", { "aria-label": "Watchlist", class: "wl-sel" });
  listSel.addEventListener("change", () => {
    st.id = listSel.value;
    save();
    quotes = null;
    draw();
    load();
  });
  const addIn = h("input", { type: "text", class: "wl-add-in", placeholder: "Add symbols: RELIANCE, NSE:TCS", "aria-label": "Add symbols", autocomplete: "off", spellcheck: "false" });
  const addBtn = h("button", { type: "button", class: "small rect", onclick: () => addSymbols() }, icon("plus"), h("span", {}, "Add"));
  addIn.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), addSymbols()));
  const newBtn = h("button", { type: "button", class: "small", onclick: () => editList(null) }, "New list");
  const editBtn = h("button", { type: "button", class: "small quiet", onclick: () => editList(cur()) }, "Rename or delete");
  const evChk = h("input", { type: "checkbox" });
  const homeChk = h("input", { type: "checkbox" });
  const evLbl = h("label", { class: "check wl-flag", title: "Live events watches this list's symbols (the WATCHLIST universe)" }, evChk, "Feeds Live events");
  const homeLbl = h("label", { class: "check wl-flag", title: "Show this list on Home" }, homeChk, "Show on Home");
  const status = h("span", { class: "muted small wl-status", "aria-live": "polite" });
  const tableHost = h("div", { class: "table-wrap wl-table-wrap" });
  const cur = () => lists.find((l) => l.id === st.id) ?? null;

  /** Save a change. A refusal shows on `field` when one is given (inline, once), else as a toast. */
  async function put(id, body, field = null) {
    const r = await optional(api(`/v1/watchlists/${encodeURIComponent(id)}`, { method: "PUT", body }));
    if (r.error) {
      if (field) fieldError(field, r.error.message);
      else toast(`Not saved: ${r.error.message}`, { tone: "error" });
      return null;
    }
    lists = lists.map((l) => (l.id === id ? r.data.data : body.events ? { ...l, events: false } : body.home ? { ...l, home: false } : l));
    return r.data.data;
  }
  evChk.addEventListener("change", async () => {
    const l = cur();
    if (!l) return;
    const saved = await put(l.id, { events: evChk.checked });
    if (!saved) return draw();
    if (evChk.checked) {
      const err = await feedEvents(saved.symbols);
      toast(err ? `List saved; Live events not updated: ${err.message}` : `Live events now watches ${saved.name} (${formatInt(saved.symbols.length)} symbols)`, { tone: err ? "warn" : "ok" });
    }
    draw();
  });
  homeChk.addEventListener("change", async () => {
    const l = cur();
    if (!l) return;
    if (await put(l.id, { home: homeChk.checked })) toast(homeChk.checked ? `${l.name} shows on Home` : "Removed from Home");
    draw();
  });

  async function addSymbols() {
    const l = cur();
    if (!l) return editList(null);
    const parts = addIn.value.split(/[\s,]+/).filter(Boolean);
    const good = parts.map(normaliseSymbol);
    const bad = parts.filter((_, i) => !good[i]);
    clearFieldError(addIn);
    if (bad.length) return fieldError(addIn, `Not a symbol: ${bad.join(", ")}. Use a name such as RELIANCE or NSE:TCS.`);
    if (!good.length) return;
    // Unknown symbols (not in the instrument master) are refused by the Bridge and said here, under the field.
    const saved = await put(l.id, { symbols: [...l.symbols, ...good.filter((s) => !l.symbols.includes(s))] }, addIn);
    if (!saved) return;
    addIn.value = "";
    if (saved.events) await feedEvents(saved.symbols);
    draw();
    load();
  }
  async function removeSymbol(sym) {
    const l = cur();
    const saved = await put(l.id, { symbols: l.symbols.filter((s) => s !== sym) });
    if (!saved) return;
    if (saved.events) await feedEvents(saved.symbols);
    if (quotes) quotes.rows = quotes.rows.filter((r) => r.symbol !== sym);
    draw();
  }
  async function editList(l) {
    const name = h("input", { id: "wl-name", type: "text", maxlength: "40", value: l?.name ?? "", autocomplete: "off" });
    const body = h("div", { class: "stack" }, h("label", { class: "field", for: "wl-name" }, h("span", {}, "Name"), name));
    const taken = (v) => lists.some((x) => x !== l && x.name.toLowerCase() === v.trim().toLowerCase());
    // The name is checked here first (empty, already used), then by the Bridge; a refusal stays in the sheet.
    const submit = async () => {
      const v = name.value.trim();
      if (!v) return fieldError(name, "Give the list a name.");
      if (taken(v)) return fieldError(name, `A list named ${v} already exists. Choose another name.`);
      if (l) {
        if (v === l.name) return true;
        return Boolean(await put(l.id, { name: v }, name));
      }
      const r = await optional(api("/v1/watchlists", { method: "POST", body: { name: v, symbols: [] } }));
      if (r.error) return fieldError(name, r.error.message);
      lists.push(r.data.data);
      st.id = r.data.data.id;
      return true;
    };
    const buttons = [{ label: "Cancel", value: false }];
    if (l) buttons.push({ label: "Delete list", cls: "quiet", value: "delete" });
    buttons.push({ label: l ? "Save" : "Create", cls: "primary", onClick: submit });
    const v = await modal({ title: l ? `Edit ${l.name}` : "New watchlist", body, buttons });
    if (v === "delete") {
      const ok = await modal({ title: `Delete ${l.name}?`, body: h("p", {}, `${formatInt(l.symbols.length)} symbols. Live events and Home keep working without it.`), buttons: [{ label: "Keep", value: false }, { label: "Delete", cls: "primary", value: true }] });
      if (!ok) return;
      const r = await optional(api(`/v1/watchlists/${encodeURIComponent(l.id)}`, { method: "DELETE" }));
      if (r.error) return toast(`Not deleted: ${r.error.message}`, { tone: "error" });
      lists = lists.filter((x) => x.id !== l.id);
      st.id = lists[0]?.id ?? null;
      save();
      quotes = null;
      draw();
      load();
      return;
    }
    if (!v) return;
    if (l) return draw();
    save();
    quotes = null;
    draw();
    addIn.focus();
  }

  const head = (key, label, num = true, title = null) => {
    const on = st.sort === key;
    const b = h("button", { type: "button", class: "wl-sort", "aria-label": `Sort by ${label}`, onclick: () => ((st.dir = on ? -st.dir : key === "name" ? 1 : -1), (st.sort = key), save(), draw()) }, label, on ? h("span", { "aria-hidden": "true" }, st.dir > 0 ? " ↑" : " ↓") : null);
    return h("th", { scope: "col", class: num ? "num" : undefined, title: title ?? undefined, "aria-sort": on ? (st.dir > 0 ? "ascending" : "descending") : "none" }, b);
  };
  const oiTitle = (r) => {
    if (r.oi === null || r.oi === undefined) return "No future";
    if (!isFigure(r.oiChangePct)) return "No previous-day OI for this future yet (the recorder keeps one from its first full day)";
    const rec = /^recorder (\d{4}-\d{2}-\d{2})$/.exec(r.oiBase ?? "");
    return rec ? `Near future: OI against its OI at the ${formatDayMonth(rec[1])} close (Data recorder)` : "Near future: OI against the previous day's OI";
  };
  // Prices follow the shared live connection (live.js): the list's symbols and their near futures are watched, so the
  // Bridge answers the 5 s poll from ticks (no broker call), and Last and Chg % change on each tick in place.
  let drawnSig = "";
  let sparkSeq = 0;
  const cells = new Map(); // symbol -> { last, chg, row }
  let live = null;
  let liveKey = "";
  function cellsFor(r, last, chg) {
    cells.set(r.symbol, { last, chg, row: { ...r } });
    return [last, chg];
  }
  function follow(l) {
    const futs = (quotes?.rows ?? []).map((r) => r.future).filter((f) => typeof f === "string" && f.includes(":"));
    const want = l && tableHost.isConnected ? [...new Set([...l.symbols, ...futs])].slice(0, 100) : [];
    const k = want.join(",");
    if (k === liveKey) return;
    liveKey = k;
    if (!want.length) {
      live?.stop();
      live = null;
    } else if (live) live.update(want);
    else {
      live = watch(want, "quote", onTicks);
      // Leaving the page stops the watch once the next page has replaced this one (ticks may have stopped coming).
      const later = () =>
        setTimeout(() => {
          if (tableHost.isConnected) return;
          removeEventListener("hashchange", later);
          follow(null);
        }, 1500);
      addEventListener("hashchange", later);
    }
  }
  function onTicks(ticks) {
    if (!tableHost.isConnected) return follow(null);
    for (const [sym, t] of ticks) {
      const c = cells.get(sym);
      const ltp = Number(t?.ltp);
      if (!c || !Number.isFinite(ltp) || ltp === c.row.ltp) continue;
      const close = isFigure(c.row.prevClose) ? c.row.prevClose : isFigure(c.row.ltp) && isFigure(c.row.change) ? c.row.ltp - c.row.change : null;
      c.row.ltp = ltp;
      if (close) {
        c.row.change = ltp - close;
        c.row.changePct = (c.row.change / close) * 100;
      }
      c.last.replaceChildren(formatFixed(ltp, 2), ...(isFigure(c.row.change) ? [h("small", { class: `block ${tone(c.row.change)}` }, formatSigned(c.row.change, 2))] : []));
      c.chg.replaceChildren(pct(c.row.changePct));
    }
  }
  function draw() {
    listSel.replaceChildren(...lists.map((l) => h("option", { value: l.id, selected: l.id === st.id }, `${l.name} · ${formatInt(l.symbols.length)}`)));
    const l = cur();
    listSel.disabled = !lists.length;
    editBtn.hidden = !l;
    evLbl.hidden = homeLbl.hidden = !l;
    evChk.checked = Boolean(l?.events);
    homeChk.checked = Boolean(l?.home);
    addIn.disabled = addBtn.disabled = !l;
    if (!l) {
      tableHost.replaceChildren(emptyState("list", "No watchlists yet", "Make a list of the symbols you follow. It can feed Live events and Home.", h("button", { type: "button", class: "primary", onclick: () => editList(null) }, "New list")));
      return;
    }
    if (!l.symbols.length) {
      tableHost.replaceChildren(emptyState("list", "This list is empty", "Add symbols above, for example RELIANCE, HDFCBANK or NIFTY.", null, { compact: true }));
      return;
    }
    const byS = new Map((quotes?.rows ?? []).map((r) => [r.symbol, r]));
    const rows = sortRows(l.symbols.map((s) => byS.get(s) ?? { symbol: s, name: s.split(":")[1] }), st.sort, st.dir);
    // The 5 s poll often brings what is on screen already (ticks patched the prices): then nothing is rebuilt.
    const sig = JSON.stringify([l.id, st.sort, st.dir, sparkSeq, rows.map((r) => [r.symbol, r.ltp, r.change, r.changePct, r.oi, r.oiChangePct, r.iv, r.ivr, r.hv20])]);
    if (sig === drawnSig && tableHost.querySelector("table")) return paintStatus();
    drawnSig = sig;
    cells.clear();
    // The day's move as a bar from a centre line, on one scale for the list (the widest move reaches the edge).
    const span = Math.max(0.5, ...rows.map((r) => (isFigure(r.changePct) ? Math.abs(r.changePct) : 0)));
    const moveBar = (v) => {
      if (!isFigure(v)) return null;
      const b = h("i", { class: v >= 0 ? "up" : "down" });
      setBar(b, Math.abs(v), span);
      return h("span", { class: "wl-move", title: `${formatSigned(v, 2)}% today, on one scale for the list` }, b);
    };
    const table = h(
        "table",
        { class: "desk-table wl-table", "aria-label": `${l.name}: watchlist prices` },
        h("thead", {}, h("tr", {}, head("name", "Symbol", false), head("ltp", "Last"), head("changePct", "Chg %"), head("oiChangePct", "OI chg (fut)", true, "Near future's OI against its OI at the previous day's close"), head("iv", "ATM IV (front)", true, "The front expiry's ATM IV: the average of the ATM call and put IV, as the Option Chain and Volatility show it. HV20 under it"), head("ivr", "IV rank"), h("th", { scope: "col", class: "wl-move-h", title: "The session in 5-minute steps (the dotted line is the previous close), then the day's % change on one scale for the list" }, "Today"), h("th", { scope: "col" }, h("span", { class: "sr-only" }, "Actions")))),
        h(
          "tbody",
          {},
          rows.map((r) =>
            h(
              "tr",
              {},
              h("th", { scope: "row" }, h("strong", {}, r.name), h("small", { class: "block muted" }, r.symbol.split(":")[0])),
              ...cellsFor(r, h("td", { class: "num" }, isFigure(r.ltp) ? formatFixed(r.ltp, 2) : DASH, isFigure(r.change) ? h("small", { class: `block ${tone(r.change)}` }, formatSigned(r.change, 2)) : null), h("td", { class: "num" }, pct(r.changePct))),
              h("td", { class: "num", title: oiTitle(r) }, r.oi === null || r.oi === undefined ? DASH : h("span", {}, pct(r.oiChangePct), h("small", { class: "block muted" }, `OI ${formatCompact(r.oi)}`))),
              h("td", { class: "num", title: isFigure(r.iv) ? `ATM IV of the ${formatDayMonth(r.ivExpiry)} expiry (front), as on the Option Chain` : r.fno ? "No front-expiry chain to read the ATM IV from yet" : "Not an F&O symbol" }, isFigure(r.iv) ? `${formatFixed(r.iv, 1)}%` : DASH, isFigure(r.hv20) ? h("small", { class: "block muted" }, `HV20 ${formatFixed(r.hv20, 1)}`) : null),
              h("td", { class: "num" }, isFigure(r.ivr) ? formatInt(r.ivr) : DASH),
              h("td", { class: "wl-move-c" }, h("span", { class: "wl-today" }, sparkFor(r), moveBar(r.changePct))),
              h(
                "td",
                { class: "act wl-acts" },
                r.fno || CHAINABLE.has(r.name) ? h("a", { class: "btn small quiet", href: "#/chain", onclick: () => setDeskUnderlying(r.name), "aria-label": `${r.name} option chain` }, "Chain") : null,
                h("button", { type: "button", class: "small quiet icon-only", "aria-label": `Remove ${r.name}`, title: "Remove from the list", onclick: () => removeSymbol(r.symbol) }, icon("close")),
              ),
            ),
          ),
        ),
      );
    table.style.setProperty("--n", String(rows.length));
    tableHost.replaceChildren(table);
    paintStatus();
    follow(l);
  }
  function paintStatus() {
    status.textContent = quotes ? `Updated ${istTime(quotes.at)} · every ${formatInt(REFRESH_MS / 1000)} s${quotes.errors?.length ? ` · ${formatInt(quotes.errors.length)} not priced` : ""}` : "Loading prices";
  }
  function setDeskUnderlying(u) {
    try {
      const d = JSON.parse(app.local.get("mcb.dashboard.desk") ?? "{}") ?? {};
      app.local.set("mcb.dashboard.desk", JSON.stringify({ ...d, underlying: u, expiry: null, stockChain: CHAINABLE.has(u) ? null : u }));
    } catch {
      // The chain opens on its last underlying.
    }
  }
  async function load() {
    clearTimeout(timer);
    const l = cur();
    if (!l || !l.symbols.length || (!tableHost.isConnected && quotes)) return follow(null);
    const r = await optional(api(`/v1/watchlists/${encodeURIComponent(l.id)}/quotes`, { fresh: true }));
    if (st.id !== l.id) return;
    if (!r.error) quotes = r.data.data;
    else status.textContent = `Prices unavailable: ${r.error.message}`;
    draw();
    loadSparks();
    timer = setTimeout(() => tableHost.isConnected && load(), REFRESH_MS);
  }
  draw();
  load();
  return [
    h(
      "section",
      { class: "card wl-card" },
      h("div", { class: "wl-bar" }, h("label", { class: "jr-field" }, h("span", {}, "List"), listSel), newBtn, editBtn, h("span", { class: "jr-grow" }), evLbl, homeLbl),
      // The field and its message (an unknown symbol) stay together; Add stays beside the field.
      h("div", { class: "wl-addrow" }, h("div", { class: "field wl-add-field" }, addIn), addBtn, status),
      tableHost,
    ),
  ];
}
