// watchlists.js: Screeners › Watchlists. Your named lists with live quotes, % change, the near future's OI change today
// for F&O, and ATM IV with its rank. One list can feed Live events (it writes the events selection's watchlist and
// turns its WATCHLIST universe on) and one shows on Home. Data: /v1/watchlists (watchlist-core.js does the maths on
// the Bridge). Numbers become text only through format.js. Reads and lists only: nothing here places an order.
import { api, app, emptyState, errorState, h, icon, istTime, modal, optional, toast } from "./app.js";
import { DASH, formatCompact, formatFixed, formatGrouped, formatInt, formatSigned, isFigure } from "./format.js";
import { normaliseSymbol, sortRows } from "./watchlist-core.js";

const SLOT = "mcb.dashboard.watchlists";
const REFRESH_MS = 5000;
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

  async function put(id, body) {
    const r = await optional(api(`/v1/watchlists/${encodeURIComponent(id)}`, { method: "PUT", body }));
    if (r.error) {
      toast(`Not saved: ${r.error.message}`, { tone: "error" });
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
    if (bad.length) return toast(`Not a symbol: ${bad.join(", ")}`, { tone: "warn" });
    if (!good.length) return;
    const saved = await put(l.id, { symbols: [...l.symbols, ...good.filter((s) => !l.symbols.includes(s))] });
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
    const buttons = [{ label: "Cancel", value: false }];
    if (l) buttons.push({ label: "Delete list", cls: "quiet", value: "delete" });
    buttons.push({ label: l ? "Save" : "Create", cls: "primary", value: true });
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
    if (l) {
      if (await put(l.id, { name: name.value })) draw();
      return;
    }
    const r = await optional(api("/v1/watchlists", { method: "POST", body: { name: name.value, symbols: [] } }));
    if (r.error) return toast(`Not created: ${r.error.message}`, { tone: "error" });
    lists.push(r.data.data);
    st.id = r.data.data.id;
    save();
    quotes = null;
    draw();
    addIn.focus();
  }

  const head = (key, label, num = true) => {
    const on = st.sort === key;
    const b = h("button", { type: "button", class: "wl-sort", "aria-label": `Sort by ${label}`, onclick: () => ((st.dir = on ? -st.dir : key === "name" ? 1 : -1), (st.sort = key), save(), draw()) }, label, on ? h("span", { "aria-hidden": "true" }, st.dir > 0 ? " ↑" : " ↓") : null);
    return h("th", { scope: "col", class: num ? "num" : undefined, "aria-sort": on ? (st.dir > 0 ? "ascending" : "descending") : "none" }, b);
  };
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
    tableHost.replaceChildren(
      h(
        "table",
        { class: "desk-table wl-table" },
        h("thead", {}, h("tr", {}, head("name", "Symbol", false), head("ltp", "Last"), head("changePct", "Chg %"), head("oiChangePct", "OI chg (fut)"), head("iv", "IV"), head("ivr", "IV rank"), h("th", { scope: "col" }, h("span", { class: "sr-only" }, "Actions")))),
        h(
          "tbody",
          {},
          rows.map((r) =>
            h(
              "tr",
              {},
              h("th", { scope: "row" }, h("strong", {}, r.name), h("small", { class: "block muted" }, r.symbol.split(":")[0])),
              h("td", { class: "num" }, formatGrouped(r.ltp, 2), isFigure(r.change) ? h("small", { class: `block ${tone(r.change)}` }, formatSigned(r.change, 2)) : null),
              h("td", { class: "num" }, pct(r.changePct)),
              h("td", { class: "num", title: r.future ? `${r.future}: OI against the first reading today` : "No future" }, r.oi === null || r.oi === undefined ? DASH : h("span", {}, pct(r.oiChangePct), h("small", { class: "block muted" }, `OI ${formatCompact(r.oi)}`))),
              h("td", { class: "num" }, isFigure(r.iv) ? `${formatFixed(r.iv, 1)}%` : DASH, isFigure(r.hv20) ? h("small", { class: "block muted" }, `HV20 ${formatFixed(r.hv20, 1)}`) : null),
              h("td", { class: "num" }, isFigure(r.ivr) ? formatInt(r.ivr) : DASH),
              h(
                "td",
                { class: "act wl-acts" },
                CHAINABLE.has(r.name) ? h("a", { class: "btn small quiet", href: "#/chain", onclick: () => setDeskUnderlying(r.name), "aria-label": `${r.name} option chain` }, "Chain") : null,
                h("button", { type: "button", class: "small quiet icon-only", "aria-label": `Remove ${r.name}`, title: "Remove from the list", onclick: () => removeSymbol(r.symbol) }, icon("close")),
              ),
            ),
          ),
        ),
      ),
    );
    status.textContent = quotes ? `Updated ${istTime(quotes.at)} · every ${formatInt(REFRESH_MS / 1000)} s${quotes.errors?.length ? ` · ${formatInt(quotes.errors.length)} not priced` : ""}` : "Loading prices";
  }
  function setDeskUnderlying(u) {
    try {
      const d = JSON.parse(app.local.get("mcb.dashboard.desk") ?? "{}") ?? {};
      app.local.set("mcb.dashboard.desk", JSON.stringify({ ...d, underlying: u, expiry: null }));
    } catch {
      // The chain opens on its last underlying.
    }
  }
  async function load() {
    clearTimeout(timer);
    const l = cur();
    if (!l || !l.symbols.length || (!tableHost.isConnected && quotes)) return;
    const r = await optional(api(`/v1/watchlists/${encodeURIComponent(l.id)}/quotes`, { fresh: true }));
    if (st.id !== l.id) return;
    if (!r.error) quotes = r.data.data;
    else status.textContent = `Prices unavailable: ${r.error.message}`;
    draw();
    timer = setTimeout(() => tableHost.isConnected && load(), REFRESH_MS);
  }
  draw();
  load();
  return [
    h(
      "section",
      { class: "card wl-card" },
      h("div", { class: "wl-bar" }, h("label", { class: "jr-field" }, h("span", {}, "List"), listSel), newBtn, editBtn, h("span", { class: "jr-grow" }), evLbl, homeLbl),
      h("div", { class: "wl-addrow" }, addIn, addBtn, status),
      tableHost,
    ),
  ];
}
