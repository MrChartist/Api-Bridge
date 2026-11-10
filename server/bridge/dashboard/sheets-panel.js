// sheets-panel.js: Integrations › Excel and Sheets. One page, in the order a person does things:
//   1 choose what the sheet shows, 2 make a read-only key, 3 download the Excel workbook or copy the Google Sheets script,
//   4 press "Test it" to see the same single request a sheet makes, with each price's freshness label.
// The key is made with the same request the other key flows use (POST /v1/keys, the Excel preset in snippets.js).
// Nothing here can place an order: the sheets only read.
import { alertBox, api, copyButton, emptyState, h, icon, pill, table, toast } from "./app.js";
import { defaultKeyName } from "./flows.js";
import { DASH, formatFixed, formatInt, guideUrl, plural } from "./format.js";
import { APPS_SCRIPT } from "./sheets-script.js";
import { KEY_PRESETS } from "./snippets.js";
import { CAPACITY, SAMPLE_SYMBOLS, SHEET_CHOICES } from "./workbook-core.js";

const GUIDE = (name) => guideUrl(name);

/** Symbols typed one per line or comma-separated -> a clean list (blanks and repeats dropped, capped to the sheet's room). */
export function parseSymbols(text) {
  const out = [];
  for (const s of String(text ?? "").split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)) if (!out.includes(s)) out.push(s);
  return out.slice(0, CAPACITY.quotes);
}

/** The request the sheet makes: the symbols in the address, JSON back so the browser can show it. */
export const quotesPath = (symbols) => `/xl/quotes?format=json&symbols=${symbols.map((s) => encodeURIComponent(s).replace(/%3A/g, ":")).join(",")}`;

/** One word per row that says how far to trust a price. */
export function freshnessWord(row) {
  if (row.error) return "Error";
  if (row.stale === true) return "Stale";
  if (row.class && row.class !== "realtime") return row.class === "eod" ? "End of day" : "Delayed";
  return "Live";
}

/** The sentence above the test table: what happened, in plain words. */
export function testSummary(rows) {
  const priced = rows.filter((r) => !r.error && r.ltp !== null && r.ltp !== undefined);
  const errors = rows.filter((r) => r.error).length;
  const newest = rows.map((r) => r.as_of).filter(Boolean).sort().at(-1);
  const stale = rows.filter((r) => r.stale === true).length;
  const slow = rows.filter((r) => r.class && r.class !== "realtime").length;
  const parts = [`${plural(rows.length, "symbol")} in one request`, `${formatInt(priced.length)} priced`];
  if (errors) parts.push(`${formatInt(errors)} could not be priced`);
  if (newest) parts.push(`newest price ${newest} IST`);
  if (stale) parts.push(`${formatInt(stale)} stale`);
  if (slow) parts.push(`${formatInt(slow)} not real-time`);
  return `${parts.join(", ")}.`;
}

const numCell = (v, dp = 2) => (v === null || v === undefined || v === "" ? DASH : formatFixed(v, dp));

/** The columns of the test table. */
export const TEST_COLUMNS = [
  { label: "Symbol", cell: (r) => r.symbol },
  { label: "Last", num: true, cell: (r) => numCell(r.ltp) },
  { label: "Change %", num: true, cell: (r) => numCell(r.pct, 2) },
  { label: "As of (IST)", cell: (r) => r.as_of ?? DASH },
  { label: "Age (s)", num: true, cell: (r) => numCell(r.age_s, 1) },
  { label: "Class", cell: (r) => r.class ?? DASH },
  { label: "Source", cell: (r) => r.source ?? DASH },
  { label: "Label", cell: (r) => pill(freshnessWord(r), r.error ? "bad" : freshnessWord(r) === "Live" ? "ok" : "warn") },
  { label: "Error", wrap: true, cell: (r) => r.error ?? DASH },
];

// What the person chose survives a redraw of the page (switching tools redraws it).
const state = { include: Object.fromEntries(SHEET_CHOICES.map((c) => [c.id, true])), symbols: SAMPLE_SYMBOLS.join("\n"), key: null, keyFor: "excel", storeKey: false, tested: null };

/**
 * @param {{ accounts: object[], download: (opts: object) => boolean, base?: string }} p
 * @returns {HTMLElement}
 */
export function sheetsPanel({ accounts, download, base = location.origin }) {
  const root = h("div", { class: "xs" });

  // ── 1 · What to show ──
  const checks = SHEET_CHOICES.map((c) => {
    const box = h("input", { type: "checkbox", checked: state.include[c.id] ? "" : undefined, "data-sheet": c.id });
    box.checked = state.include[c.id];
    box.addEventListener("change", () => {
      state.include[c.id] = box.checked;
      symbolsField.hidden = !state.include.watchlist;
      draw();
    });
    return h("label", { class: "check" }, box, c.label);
  });
  const symbols = h("textarea", { id: "xs-symbols", rows: "6", spellcheck: "false", autocomplete: "off", "aria-describedby": "xs-symbols-hint" });
  symbols.value = state.symbols;
  symbols.addEventListener("input", () => (state.symbols = symbols.value));
  const symbolsField = h("label", { class: "field", for: "xs-symbols" }, h("span", {}, "Watchlist symbols, one per line"), symbols, h("span", { class: "hint", id: "xs-symbols-hint" }, `Bridge symbols such as NSE:RELIANCE or NFO:NIFTY-2026-11-24-FUT. Up to ${CAPACITY.quotes}. You can change them in the sheet later.`));
  symbolsField.hidden = !state.include.watchlist;

  // ── 2 · The key ──
  const keySlot = h("div", { class: "xs-key", "aria-live": "polite" });
  const forExcel = h("input", { type: "radio", name: "xs-for", value: "excel" });
  const forSheets = h("input", { type: "radio", name: "xs-for", value: "sheets" });
  (state.keyFor === "excel" ? forExcel : forSheets).checked = true;
  for (const r of [forExcel, forSheets]) r.addEventListener("change", () => (state.keyFor = r.value));
  const acct = h("select", { id: "xs-acct", "aria-label": "Accounts the key may read" }, h("option", { value: "*" }, "All accounts"), (accounts ?? []).map((a) => h("option", { value: a.id }, `${a.label} (${a.id})`)));
  const days = h("select", { id: "xs-days", "aria-label": "Key expires" }, [["7", "7 days"], ["30", "30 days"], ["90", "90 days"]].map(([v, t]) => h("option", { value: v, selected: v === String(KEY_PRESETS.excel.expiresDays) ? "" : undefined }, `Expires in ${t}`)));
  const make = h("button", { type: "button", class: "small tinted" }, icon("keys"), "Make a read-only key");
  make.addEventListener("click", async () => {
    make.disabled = true;
    try {
      const existing = await api("/v1/keys").then((r) => (r.data.data ?? []).map((k) => k.label), () => []);
      const preset = KEY_PRESETS.excel;
      const urlKey = state.keyFor === "excel";
      const body = { label: defaultKeyName("excel", new Date(), existing), scopes: preset.scopes, accounts: acct.value === "*" ? "*" : [acct.value], clientKind: preset.clientKind, expiresAt: new Date(Date.now() + Number(days.value) * 86_400_000).toISOString() };
      if (urlKey) body.allowQuery = true;
      const r = await api("/v1/keys", { method: "POST", body });
      state.key = { value: r.data.data.key, urlKey };
      toast("Key made. Copy it now: it is shown only on this page.");
      draw();
    } catch (err) {
      make.disabled = false;
      keySlot.replaceChildren(alertBox(err));
    }
  });
  const storeBox = h("input", { type: "checkbox" });
  storeBox.checked = state.storeKey;
  storeBox.addEventListener("change", () => (state.storeKey = storeBox.checked));

  // ── 3 · Excel and Sheets ──
  const dl = h("button", { type: "button", class: "primary" }, icon("download"), "Download the Excel workbook");
  dl.addEventListener("click", () => {
    const picked = SHEET_CHOICES.filter((c) => state.include[c.id]);
    if (!picked.length) return toast("Choose at least one sheet", { tone: "error" });
    download({ include: { ...state.include }, symbols: parseSymbols(state.symbols), ...(state.storeKey && state.key ? { key: state.key.value } : {}) });
  });
  const copyScript = copyButton(() => APPS_SCRIPT, { label: "Copy the Apps Script", done: "Copied", toastLabel: "Apps Script copied", cls: "small tinted", ariaLabel: "Copy the Google Sheets Apps Script" });

  // ── 4 · Test it ──
  const result = h("div", { class: "xs-test", "aria-live": "polite" });
  const test = h("button", { type: "button", class: "small" }, icon("refresh"), "Test it");
  test.addEventListener("click", async () => {
    const list = parseSymbols(state.symbols).slice(0, 12);
    if (!list.length) return result.replaceChildren(alertBox({ title: "Add a few symbols first", detail: "The test asks for the symbols in the list above." }, "warn"));
    test.disabled = true;
    result.replaceChildren(h("p", { class: "xs-note" }, "Asking the Bridge…"));
    try {
      const path = quotesPath(list);
      let rows;
      let via;
      if (state.key) {
        // With the new key: the same way the tool will use it (in the address for Excel, in a header for Sheets).
        const res = await fetch(state.key.urlKey ? `${path}&key=${encodeURIComponent(state.key.value)}` : path, state.key.urlKey ? {} : { headers: { Authorization: `Bearer ${state.key.value}` } });
        if (!res.ok) throw Object.assign(new Error("not ok"), { reason: await res.text().then((t) => t.split("\n")[1]?.split(",")[2] ?? `The Bridge answered ${res.status}.`) });
        rows = await res.json();
        via = state.key.urlKey ? "with your new key, in the address, the way Excel sends it" : "with your new key, in a header, the way Sheets sends it";
      } else {
        rows = (await api(path)).data;
        via = "with this dashboard's own sign-in (make a key above to test it, too)";
      }
      const demo = rows.some((r) => r.demo === "DEMO");
      result.replaceChildren(
        h("p", { class: "xs-summary" }, demo ? pill("Demo data", "warn") : pill("Live", "ok"), " ", testSummary(rows)),
        h("p", { class: "xs-note" }, `One request, ${via}.`),
        table(TEST_COLUMNS, rows, emptyState("chart", "No rows", "The Bridge answered with nothing."), { mobile: "stack", caption: "Prices from one request, with how current each is" }),
      );
    } catch (err) {
      result.replaceChildren(alertBox(err.reason ? { title: "The Bridge refused the test", detail: err.reason } : err));
    } finally {
      test.disabled = false;
    }
  });

  function draw() {
    const k = state.key;
    make.disabled = Boolean(k);
    keySlot.replaceChildren(
      ...(k
        ? [
            h("div", { class: "ai-addr" }, h("span", { class: "ai-addr-label" }, "Your new key (shown once)"), h("code", {}, k.value), copyButton(k.value, { ariaLabel: "Copy the new key", toastLabel: "Key copied", cls: "small copy" })),
            h("label", { class: "check" }, storeBox, "Put this key inside the workbook (the file then holds your key: do not share the file)"),
            h("p", { class: "xs-note" }, k.urlKey ? "This key may travel in a web address, which Excel needs, so it can only read. It expires. Revoke it in API › Keys when you are done." : "This key is sent in a header and cannot be used in a web address. It can only read and it expires."),
          ]
        : []),
    );
  }

  root.append(
    h(
      "section",
      { class: "xs-step", "aria-labelledby": "xs-h1" },
      h("h3", { id: "xs-h1" }, "1. What should the sheet show?"),
      h("div", { class: "xs-checks", role: "group", "aria-label": "Sheets to include" }, checks),
      symbolsField,
      h("p", { class: "xs-note" }, "Each sheet is one request, however many rows it has. Prices are never read one cell at a time."),
    ),
    h(
      "section",
      { class: "xs-step", "aria-labelledby": "xs-h2" },
      h("h3", { id: "xs-h2" }, "2. A key that can only read"),
      h("div", { class: "xs-checks", role: "radiogroup", "aria-label": "What the key is for" }, h("label", { class: "check" }, forExcel, "For Excel (the key goes in the web address)"), h("label", { class: "check" }, forSheets, "For Google Sheets (the key goes in a header: safer)")),
      h("div", { class: "xs-row" }, acct, days, make),
      keySlot,
    ),
    h(
      "section",
      { class: "xs-step", "aria-labelledby": "xs-h3" },
      h("h3", { id: "xs-h3" }, "3. Excel or Google Sheets"),
      h("div", { class: "xs-two" },
        h("div", { class: "stack" }, h("h4", {}, "Excel for Windows"), h("p", { class: "xs-note" }, "Paste the key in Setup, cell B6, then press F9. Mac and Excel for the web have no WEBSERVICE: use Power Query (integrations/excel/quotes.pq) there."), h("div", { class: "xs-actions" }, dl)),
        h("div", { class: "stack" }, h("h4", {}, "Google Sheets"), h("p", { class: "xs-note" }, "Google cannot reach this computer: the Bridge needs a public address through a tunnel you set up. Anyone who can edit the script can read its key."), h("div", { class: "xs-actions" }, copyScript, h("a", { class: "btn small quiet", href: GUIDE("expose-alerts"), target: "_blank", rel: "noopener", "aria-label": "Making the Bridge reachable (opens in a new tab)" }, "Tunnel guide", icon("external")))),
      ),
      h("p", { class: "xs-note" }, "How often to refresh: prices no more than every 5 seconds, positions and orders about once a minute. Excel refreshes when you press F9 (a timer needs a macro or Power Query); the Sheets script has a timer built in."),
    ),
    h("section", { class: "xs-step", "aria-labelledby": "xs-h4" }, h("h3", { id: "xs-h4" }, "4. Test it"), h("div", { class: "xs-actions" }, test), result),
  );
  draw();
  return root;
}
