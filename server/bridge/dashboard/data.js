// Data: one place to collect price history from every connected source. The page lists the accounts that can give
// data, takes a list of symbols, an interval and a date range, and backfills each symbol through GET /v1/history
// (which already splits a long range into the chunks a broker allows, inside its rate limits). When the chosen source
// cannot answer for a symbol, the next source is tried, so one run can be filled from several brokers. The result is
// a table with where each symbol came from, and downloads as CSV or JSON. The same call is shown for other projects.
//
// Pure helpers (parseSymbols, defaultRange, sourcePlan, dataSources, candlesCsv, historyPath, summarise) are exported
// for tests; the DOM code runs only in a browser. Numbers become text through format.js. No style attributes (CSP).
import { api, card, codeBlock, h, icon, iconTile, optional, pill, plainBrokerMessage, toast } from "./app.js";
import { downloadText } from "./export.js";
import { sessionText } from "./flows.js";
import { DASH, formatInt } from "./format.js";

/** Most symbols one run collects (each is at least one broker call; a long range is several). */
export const MAX_SYMBOLS = 50;
// The names GET /v1/history takes (market/history.mjs INTERVALS); data.test.mjs keeps the two lists in step.
export const INTERVALS = Object.freeze([["1m", "1 min"], ["3m", "3 min"], ["5m", "5 min"], ["10m", "10 min"], ["15m", "15 min"], ["30m", "30 min"], ["60m", "1 hour"], ["1d", "1 day"], ["1w", "1 week"], ["1M", "1 month"]]);
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** Symbols from free text (commas, spaces, new lines), in the order typed, once each, MAX_SYMBOLS at most (pure). */
export function parseSymbols(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? "").split(/[\s,;]+/)) {
    const s = raw.trim();
    if (!s || s.length > 64) continue;
    const key = s.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_SYMBOLS) break;
  }
  return out;
}

/** The IST calendar day of an epoch-ms time, "YYYY-MM-DD". */
const istDay = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The range a new run starts with: the last `days` days up to today, in IST (pure). */
export function defaultRange(now = Date.now(), days = 30) {
  return { from: istDay(now - days * DAY_MS), to: istDay(now) };
}

/**
 * The accounts that can give price history, connected ones first (pure). Each is { id, label, broker, connected,
 * gives: string[] } where `gives` names what it can supply, in plain words.
 */
export function dataSources(accounts = []) {
  const WORDS = [["historical", "History"], ["quotes", "Quotes"], ["feed", "Live prices"], ["optionChain", "Option chain"], ["depth", "Depth"]];
  return accounts
    .filter((a) => a.broker !== "paper" && (a.capabilities ?? []).some((c) => WORDS.some(([k]) => k === c)))
    .map((a) => ({ id: a.id, label: a.label || a.id, broker: a.broker, connected: a.session?.state === "connected", state: a.session?.state ?? null, history: (a.capabilities ?? []).includes("historical"), gives: WORDS.filter(([k]) => (a.capabilities ?? []).includes(k)).map(([, w]) => w) }))
    .sort((a, b) => Number(b.connected) - Number(a.connected));
}

/**
 * The sources to try for one symbol, in order (pure). "" is the Bridge's own choice (the best connected account).
 * `choice` is "" or an account id; with `fallback`, the other connected accounts that have history follow.
 * @returns {string[]}
 */
export function sourcePlan(choice, sources = [], fallback = true) {
  const usable = sources.filter((s) => s.connected && s.history).map((s) => s.id);
  const first = choice && usable.includes(choice) ? choice : "";
  if (!fallback) return [first];
  return [first, ...usable.filter((id) => id !== first)];
}

/** The API path of one history read (pure). */
export function historyPath({ symbol, interval, from, to, account = "", format = "" }) {
  const q = new URLSearchParams({ symbol, interval, from, to });
  if (account) q.set("account", account);
  if (format) q.set("format", format);
  return `/v1/history?${q.toString()}`;
}

/** Epoch seconds as an IST timestamp, "2026-11-12T09:15:00+05:30". */
const istStamp = (sec) => `${new Date(sec * 1000 + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30`;

/**
 * Every collected symbol as one CSV in long form: symbol,time,open,high,low,close,volume,oi,source (pure). Long form
 * loads straight into pandas, Excel or a database, whatever the mix of symbols.
 * @param {{ symbol: string, source: string | null, candles: object[] }[]} results
 */
export function candlesCsv(results = []) {
  const lines = ["symbol,time,open,high,low,close,volume,oi,source"];
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");
  for (const r of results) {
    for (const c of r.candles ?? []) lines.push([r.symbol, istStamp(c.time), n(c.open), n(c.high), n(c.low), n(c.close), n(c.volume), n(c.oi), r.source ?? ""].join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** What a finished run amounts to (pure): { done, failed, candles, sources: string[] }. */
export function summarise(results = []) {
  const ok = results.filter((r) => !r.error);
  return { done: ok.length, failed: results.length - ok.length, candles: ok.reduce((a, r) => a + (r.candles?.length ?? 0), 0), sources: [...new Set(ok.map((r) => r.source).filter(Boolean))] };
}

// ── DOM ──

const dayText = (sec) => (Number.isFinite(sec) ? istStamp(sec).slice(0, 16).replace("T", " ") : DASH);

function sourcesCard(sources) {
  const rows = sources.map((s) => {
    const st = sessionText(s.state);
    return h(
      "div",
      { class: "dt-src" },
      iconTile(s.history ? "chart" : "activity", s.connected ? "teal" : "gray"),
      h("span", { class: "names" }, h("span", { class: "nm" }, s.label), h("span", { class: "sub" }, s.gives.join(" · "))),
      pill(st.text, st.tone),
    );
  });
  return card({
    glyph: "plug",
    tint: "teal",
    title: "Data sources",
    sub: "Every connected account that can give prices. A run is filled from the first that answers, then the others.",
    actions: h("button", { type: "button", class: "small", onclick: () => (location.hash = "#/accounts?add=1") }, icon("plus"), "Add a source"),
    cls: "dt-sources",
    flush: true,
    body: rows.length
      ? h("div", { class: "dt-srcs" }, rows)
      : h("p", { class: "hm-empty muted small" }, "No source yet. Add a broker on the Accounts page and log in; it shows up here with what it can supply."),
  });
}

/** Render Data (views.js PAGES). */
export async function renderData() {
  const accounts = (await api("/v1/accounts")).data.data ?? [];
  const sources = dataSources(accounts);
  const range = defaultRange();

  const symbols = h("textarea", { rows: "3", spellcheck: "false", "aria-label": "Symbols", placeholder: "NSE:RELIANCE, NSE:INFY, NSE:NIFTY" }, "NSE:RELIANCE, NSE:NIFTY");
  const from = h("input", { type: "date", value: range.from, max: range.to });
  const to = h("input", { type: "date", value: range.to, max: range.to });
  const interval = h("select", {}, INTERVALS.map(([v, t]) => h("option", { value: v }, t)));
  interval.value = "1d";
  const usable = sources.filter((s) => s.connected && s.history);
  const source = h("select", {}, h("option", { value: "" }, "Automatic"), usable.map((s) => h("option", { value: s.id }, s.label)));
  const fallback = h("input", { type: "checkbox", checked: true });
  const run = h("button", { type: "button", class: "primary" }, icon("download"), "Collect data");
  const stop = h("button", { type: "button", class: "small", hidden: true }, "Stop");
  const progress = h("p", { class: "dt-progress muted small", role: "status" });
  const tableSlot = h("div", { class: "dt-results" });
  const actions = h("div", { class: "dt-actions", hidden: true });
  const snippetSlot = h("div", { class: "dt-snippet" });

  let results = [];
  let stopped = false;

  const params = (symbol, account = "") => ({ symbol, interval: interval.value, from: from.value, to: to.value, account });
  const drawSnippet = () => {
    const first = parseSymbols(symbols.value)[0] ?? "NSE:RELIANCE";
    const path = historyPath({ ...params(first, source.value), format: "csv" });
    snippetSlot.replaceChildren(
      codeBlock(`curl "${location.origin}${path}" -o ${first.replace(/[^A-Za-z0-9]+/g, "_")}.csv`, { title: "The same data from a terminal (no key needed on this computer)" }),
      codeBlock(`import pandas as pd\ndf = pd.read_csv("${location.origin}${path}")\nprint(df.tail())`, { title: "From Python" }),
    );
  };
  for (const el of [symbols, from, to, interval, source]) el.addEventListener("change", drawSnippet);
  drawSnippet();

  const drawTable = () => {
    if (!results.length) return tableSlot.replaceChildren();
    const head = h("tr", {}, ["Symbol", "Candles", "First", "Last", "Source", ""].map((t) => h("th", {}, t)));
    const body = results.map((r) =>
      h(
        "tr",
        {},
        h("td", {}, h("strong", {}, r.symbol)),
        h("td", { class: "num" }, r.error ? DASH : formatInt(r.candles.length)),
        h("td", {}, r.error ? DASH : dayText(r.candles[0]?.time)),
        h("td", {}, r.error ? DASH : dayText(r.candles.at(-1)?.time)),
        h("td", {}, r.error ? pill("Not collected", "bad") : pill(r.sourceLabel ?? "Bridge", "ok")),
        h(
          "td",
          { class: "dt-cell-end" },
          r.error
            ? h("span", { class: "muted small" }, r.error)
            : h("button", { type: "button", class: "small plain", "aria-label": `Download ${r.symbol} as CSV`, onclick: () => downloadText(candlesCsv([r]), `${r.symbol.replace(/[^A-Za-z0-9]+/g, "_")}-${interval.value}.csv`) }, "CSV"),
        ),
      ),
    );
    tableSlot.replaceChildren(h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, head), h("tbody", {}, body))));
  };

  const collect = async () => {
    const list = parseSymbols(symbols.value);
    if (!list.length) return toast("Type at least one symbol, for example NSE:RELIANCE.", { tone: "warn" });
    if (!from.value || !to.value || from.value > to.value) return toast("Choose a start date that is not after the end date.", { tone: "warn" });
    const labelOf = new Map(sources.map((s) => [s.id, s.label]));
    const plan = sourcePlan(source.value, sources, fallback.checked);
    results = [];
    stopped = false;
    run.disabled = true;
    stop.hidden = false;
    actions.hidden = true;
    for (const [i, symbol] of list.entries()) {
      if (stopped) break;
      progress.textContent = `Collecting ${symbol} (${formatInt(i + 1)} of ${formatInt(list.length)}) …`;
      let got = null;
      let lastError = "";
      for (const account of plan) {
        const r = await optional(api(historyPath(params(symbol, account)), { fresh: true }));
        if (!r.error) {
          const d = r.data?.data ?? {};
          const src = d.freshness?.accountId ?? r.data?.meta?.freshness?.accountId ?? account ?? null;
          got = { symbol: d.symbol ?? symbol, candles: d.candles ?? [], source: src, sourceLabel: labelOf.get(src) ?? src, partial: d.partial === true };
          break;
        }
        lastError = r.error.code === "SYMBOL_NOT_FOUND" ? "No connected broker knows this symbol. Check the spelling, for example NSE:RELIANCE." : plainBrokerMessage(r.error.message ?? "The Bridge could not read this symbol.");
        // A symbol nobody knows will not be found on another account either.
        if (r.error.code === "SYMBOL_NOT_FOUND" || r.error.code === "VALIDATION_FAILED") break;
      }
      results.push(got ?? { symbol, candles: [], source: null, error: lastError });
      drawTable();
    }
    const sum = summarise(results);
    progress.textContent = `${stopped ? "Stopped. " : ""}${formatInt(sum.candles)} candles for ${formatInt(sum.done)} of ${formatInt(results.length)} symbols${sum.sources.length ? `, from ${sum.sources.map((s) => labelOf.get(s) ?? s).join(" and ")}` : ""}.${sum.failed ? ` ${formatInt(sum.failed)} could not be collected; the reason is in the table.` : ""}`;
    run.disabled = false;
    stop.hidden = true;
    actions.hidden = sum.done === 0;
  };
  run.addEventListener("click", () => collect().catch((err) => toast(err.message, { tone: "error" })));
  stop.addEventListener("click", () => (stopped = true));
  const stamp = () => `${interval.value}-${from.value}-to-${to.value}`;
  actions.append(
    h("button", { type: "button", class: "small primary", onclick: () => downloadText(candlesCsv(results.filter((r) => !r.error)), `bridge-history-${stamp()}.csv`) }, icon("download"), "Download all as one CSV"),
    h("button", { type: "button", class: "small", onclick: () => downloadText(JSON.stringify(results.filter((r) => !r.error).map(({ symbol, source, candles }) => ({ symbol, source, interval: interval.value, candles })), null, 2), `bridge-history-${stamp()}.json`, "application/json") }, "Download JSON"),
  );

  const lab = (text, control, wide = false) => h("label", { class: wide ? "field wide" : "field" }, text, control);
  const backfill = card({
    glyph: "download",
    tint: "blue",
    title: "Collect and backfill",
    sub: `Price history for up to ${formatInt(MAX_SYMBOLS)} symbols at once. Long ranges are fetched in pieces, inside each broker's limits.`,
    cls: "dt-backfill",
    body: h(
      "div",
      { class: "stack" },
      h("div", { class: "form-grid dt-form" }, lab("Symbols", symbols, true), lab("Interval", interval), lab("From", from), lab("To", to), lab("Source", source)),
      h("label", { class: "check" }, fallback, h("span", {}, "If a source cannot answer for a symbol, try my other sources")),
      h("div", { class: "row" }, run, stop, progress),
      tableSlot,
      actions,
    ),
  });
  const reuse = card({ glyph: "console", tint: "indigo", title: "Use it from your other projects", sub: "The form above is one API call per symbol. These lines follow what you choose.", cls: "dt-reuse", body: snippetSlot });
  return [sourcesCard(sources), backfill, reuse];
}
