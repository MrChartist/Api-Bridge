/**
 * Mr. Chartist API Bridge for Google Sheets (Apps Script). Read-only: nothing here can place or change an order.
 * Copy this whole file into Extensions > Apps Script, save, reload the sheet, then use the new "Bridge" menu.
 *
 * What it does
 *   - Bridge > Set up sheets       makes Watchlist, Positions, Holdings, Funds and Orders with headers.
 *   - Bridge > Refresh now         ONE request per sheet, however many rows (not one request per cell).
 *   - Bridge > Start timed refresh a time-driven trigger (every 1, 5, 10, 15 or 30 minutes).
 *   - =BRIDGE_QUOTES(A5:A30)       the same price table as a custom function (one request for the whole range).
 *
 * Before you start (read this, it is short)
 *   1. Google runs Apps Script on its own servers, so it cannot reach 127.0.0.1 on your computer. The Bridge must be
 *      reachable from the internet through a tunnel you set up yourself: see docs/guides/expose-alerts.md. That puts
 *      your broker data on a public address: your broker's terms may not allow it, and the risk is yours.
 *   2. The key. Script properties are visible to every person who can edit this script: share the sheet as view-only,
 *      or do not share it. Make the key read-only with an expiry (dashboard > Integrations > Excel and Sheets). This
 *      script sends the key in a request header, never in the web address, so a plain read-only key is enough and it
 *      does not show up in the tunnel's address logs. Do NOT use the key-in-the-address form from Sheets (IMPORTDATA and similar):
 *      that puts the key in a web address that Google and the tunnel can log.
 *
 * Set up: Project Settings (the gear) > Script properties > add
 *   BRIDGE_URL   https://your-tunnel.example.com        (no trailing slash)
 *   BRIDGE_KEY   mcb_...                                 (the read-only key)
 *
 * Limits (Google's own numbers: developers.google.com/apps-script/guides/services/quotas): URL Fetch calls a day are
 * 20,000 for a consumer account and 100,000 for Workspace; time-driven triggers may run 90 minutes a day in total on a
 * consumer account; a custom function must finish in 30 seconds. One refresh here is at most 5 requests, so every
 * minute is about 7,200 a day: fine, but every 5 minutes is gentler on your broker too. The Bridge answers HTTP 429
 * with "Too many refreshes: wait N seconds" when asked too often; this script shows that in the Status cell and waits.
 */

var QUOTE_FIELDS = "ltp,chg,pct,volume";
var CACHE_SECONDS = 20;
var MAX_URL_CHARS = 1800; // Apps Script allows about 2,000 characters in a fetch URL
var MAX_PER_REQUEST = 100; // the Bridge's default cap for one /xl/quotes request
var TABLES = {
  Watchlist: { first: 5 },
  Positions: { route: "/xl/positions", cols: ["account", "mode", "symbol", "product", "qty", "avg_price", "ltp", "pnl", "realised_pnl", "unrealised_pnl", "as_of", "age_s", "class", "source", "stale", "error"] },
  Holdings: { route: "/xl/holdings", cols: ["account", "mode", "symbol", "isin", "qty", "avg_price", "ltp", "pnl", "as_of", "age_s", "class", "source", "stale", "error"] },
  Funds: { route: "/xl/funds", cols: ["account", "mode", "available_cash", "used_margin", "total_balance", "collateral", "withdrawable", "realised_pnl", "unrealised_pnl", "as_of", "age_s", "class", "source", "stale", "error"] },
  Orders: { route: "/xl/orders", query: "&limit=100", limit: 100, cols: ["account", "mode", "order_id", "client_order_id", "symbol", "side", "product", "order_type", "qty", "filled_qty", "avg_price", "price", "trigger_price", "status", "status_message", "placed_at", "updated_at", "as_of", "age_s", "class", "source", "stale", "error"] }
};
var WATCH_HEAD = ["Symbol", "Last", "Change", "Change %", "Volume", "As of (IST)", "Age (s)", "Class", "Source", "Stale", "Error"];
var SAMPLE = ["NSE:NIFTY", "BSE:SENSEX", "NSE:RELIANCE", "NSE:TCS", "NSE:INFY", "NSE:HDFCBANK", "NSE:ICICIBANK", "NSE:SBIN", "NSE:ITC", "NSE:M&M"];

// ── talking to the Bridge ──

function bridgeConfig_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty("BRIDGE_URL");
  var key = props.getProperty("BRIDGE_KEY");
  if (!url || !key) throw new Error("Set BRIDGE_URL and BRIDGE_KEY in Project Settings > Script properties.");
  return { url: url.replace(/\/+$/, ""), key: key };
}

/**
 * GET a Bridge path; returns { ok, status, rows (parsed CSV), wait (seconds, for 429), message }. The key goes in a header.
 * "first" is the name of a column the answer must have ("symbol", "account" ...): a 200 answer that is anything else
 * (a tunnel notice page, a login page) is an error, so it can never blank the prices.
 */
function bridgeTable_(path, first) {
  var cfg = bridgeConfig_();
  var res;
  try {
    res = UrlFetchApp.fetch(cfg.url + path, { method: "get", headers: { Authorization: "Bearer " + cfg.key }, muteHttpExceptions: true, followRedirects: false });
  } catch (e) {
    return { ok: false, status: 0, rows: [], message: "Could not reach the Bridge. Is it running, and is the tunnel up? (" + String(e.message).slice(0, 120) + ")" };
  }
  var status = res.getResponseCode();
  var text = res.getContentText();
  var rows = [];
  try {
    rows = Utilities.parseCsv(text);
  } catch (e2) {
    rows = [];
  }
  // Errors come back as a one-row table: status, code, message, retry_after_s (with the real HTTP status).
  var head = rows.length ? rows[0] : [];
  var refused = head[0] === "status" && head[1] === "code";
  if (status === 200 && !refused) {
    if (first && head.indexOf(first) < 0) {
      return { ok: false, status: 200, rows: [], message: "The answer is not a Bridge table (a login page or a tunnel notice?). It starts: " + String(text).replace(/\s+/g, " ").slice(0, 120) };
    }
    return { ok: true, status: 200, rows: rows };
  }
  var err = refused && rows.length > 1 ? rows[1] : [];
  var headers = res.getHeaders();
  var wait = Number(err[3] || headers["Retry-After"] || headers["retry-after"] || 0);
  return { ok: false, status: status, rows: [], wait: wait, message: err[2] || "The Bridge answered HTTP " + status + "." };
}

function num_(v) {
  return v !== "" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
}

function convert_(rows) {
  return rows.map(function (r, i) {
    return i === 0 ? r : r.map(num_);
  });
}

/** Split symbols into groups that fit one request (count and web-address length). */
function groups_(symbols) {
  var out = [];
  var cur = [];
  var len = 0;
  symbols.forEach(function (s) {
    var enc = encodeURIComponent(s).replace(/%3A/g, ":");
    if (cur.length && (cur.length >= MAX_PER_REQUEST || len + enc.length + 1 > MAX_URL_CHARS)) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(enc);
    len += enc.length + 1;
  });
  if (cur.length) out.push(cur);
  return out;
}

/** Prices for a list of symbols: one request per group of up to about 100. Returns { ok, rows (with header), message, wait }. */
function quotes_(symbols, fields) {
  var list = symbols.map(function (s) { return String(s).trim(); }).filter(function (s) { return s; });
  if (!list.length) return { ok: true, rows: [] };
  var all = [];
  var gs = groups_(list);
  for (var i = 0; i < gs.length; i++) {
    var r = bridgeTable_("/xl/quotes?format=csv&fields=" + (fields || QUOTE_FIELDS) + "&symbols=" + gs[i].join(","), "symbol");
    if (!r.ok) return r;
    all = all.concat(i === 0 ? r.rows : r.rows.slice(1));
  }
  return { ok: true, rows: all };
}

// ── custom functions ──

/**
 * Prices for a whole range of symbols with ONE request (a header row, then one row per symbol, in the order given).
 * Each row says how current it is: as_of (IST), age_s, class, source, stale. A symbol that cannot be priced has
 * blank values and a text in the error column.
 * @param {string[][]} symbols a range such as A5:A30
 * @param {string} fields optional, for example "ltp,chg,pct,volume" (the default)
 * @return {Array<Array<*>>}
 * @customfunction
 */
function BRIDGE_QUOTES(symbols, fields) {
  var list = [].concat.apply([], symbols).filter(function (s) { return String(s).trim() !== ""; });
  var key = "q|" + (fields || QUOTE_FIELDS) + "|" + list.join(",");
  var cache = CacheService.getScriptCache();
  var hit = key.length < 200 ? cache.get(key) : null;
  if (hit) return JSON.parse(hit);
  var r = quotes_(list, fields);
  if (!r.ok) throw new Error(r.wait ? "Too many refreshes: wait " + r.wait + " seconds." : r.message);
  var table = convert_(r.rows);
  var json = JSON.stringify(table);
  if (key.length < 200 && json.length < 90000) cache.put(key, json, CACHE_SECONDS);
  return table;
}

/**
 * One quote field of one symbol. This is one request PER CELL: for a list use BRIDGE_QUOTES instead.
 * @param {string} symbol e.g. "NSE:RELIANCE"
 * @param {string} field ltp, open, high, low, close, chg, pct, volume, oi, bid or ask
 * @return {number}
 * @customfunction
 */
function BRIDGE_QUOTE(symbol, field) {
  var f = String(field || "ltp").trim();
  var cache = CacheService.getScriptCache();
  var key = "v|" + symbol + "|" + f;
  var hit = cache.get(key);
  if (hit !== null) return Number(hit);
  var r = quotes_([symbol], f);
  if (!r.ok) throw new Error(r.wait ? "Too many refreshes: wait " + r.wait + " seconds." : r.message);
  var head = r.rows[0];
  var row = r.rows[1];
  var v = row[head.indexOf(f)];
  if (v === "") throw new Error(row[head.indexOf("error")] || "No value.");
  cache.put(key, v, CACHE_SECONDS);
  return Number(v);
}

/**
 * Option chain as a table (one row per strike, with a header row).
 * @param {string} underlying e.g. "NIFTY"
 * @param {string} expiry YYYY-MM-DD
 * @param {number} strikes strikes on each side of ATM (optional, default 10)
 * @return {Array<Array<*>>}
 * @customfunction
 */
function BRIDGE_CHAIN(underlying, expiry, strikes) {
  var d = Object.prototype.toString.call(expiry) === "[object Date]" ? Utilities.formatDate(expiry, "Asia/Kolkata", "yyyy-MM-dd") : String(expiry).trim();
  var r = bridgeTable_("/xl/chain?format=csv&underlying=" + encodeURIComponent(underlying) + "&expiry=" + encodeURIComponent(d) + "&strikes=" + encodeURIComponent(strikes || 10), "underlying");
  if (!r.ok) throw new Error(r.wait ? "Too many refreshes: wait " + r.wait + " seconds." : r.message);
  return convert_(r.rows);
}

/**
 * Candles for a symbol (header row, then oldest to newest; times in IST).
 * @param {string} symbol e.g. "NSE:NIFTY"
 * @param {string} interval 1m, 3m, 5m, 10m, 15m, 30m, 60m, 1d, 1w or 1M
 * @param {number} countback number of bars (optional, default 100)
 * @return {Array<Array<*>>}
 * @customfunction
 */
function BRIDGE_HISTORY(symbol, interval, countback) {
  var r = bridgeTable_("/xl/history?symbol=" + encodeURIComponent(symbol) + "&interval=" + encodeURIComponent(interval) + "&countback=" + encodeURIComponent(countback || 100), "datetime");
  if (!r.ok) throw new Error(r.wait ? "Too many refreshes: wait " + r.wait + " seconds." : r.message);
  return convert_(r.rows);
}

// ── the sheets, the menu and the timer ──

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Bridge")
    .addItem("Set up sheets", "setupBridgeSheets")
    .addItem("Refresh now", "refreshBridge")
    .addSeparator()
    .addItem("Start timed refresh (every 5 minutes)", "startTimedRefresh")
    .addItem("Stop timed refresh", "stopTimedRefresh")
    .addToUi();
}

/** Make the sheets (only the ones that are missing) with headers and a sample watchlist. */
function setupBridgeSheets() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(TABLES).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) return;
    sh = ss.insertSheet(name);
    sh.getRange("A1").setValue(name).setFontWeight("bold").setFontSize(14);
    if (name === "Watchlist") {
      sh.getRange(4, 1, 1, WATCH_HEAD.length).setValues([WATCH_HEAD]).setFontWeight("bold");
      sh.getRange(3, 1).setValue("Type Bridge symbols in column A (one per row). Bridge > Refresh now fills the rest. Times are IST.").setFontStyle("italic");
      sh.getRange(5, 1, SAMPLE.length, 1).setValues(SAMPLE.map(function (s) { return [s]; }));
    } else {
      sh.getRange(4, 1, 1, TABLES[name].cols.length).setValues([TABLES[name].cols]).setFontWeight("bold");
    }
    sh.setFrozenRows(4);
  });
  SpreadsheetApp.getActive().toast("Sheets are ready. Check BRIDGE_URL and BRIDGE_KEY in Script properties, then Bridge > Refresh now.");
}

function status_(sh, text) {
  sh.getRange("A2").setValue(text);
}

function stamp_() {
  return Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd HH:mm:ss") + " IST";
}

/**
 * Fill one table sheet below its header row (row 4) from one request. Each value goes under the column of the same
 * NAME, so a column the Bridge adds (for example demo) can never shift or overflow the sheet.
 */
function fillTable_(sh, rows, cols) {
  var head = rows[0] || [];
  var at = cols.map(function (c) { return head.indexOf(c); });
  var last = Math.max(sh.getLastRow(), 5);
  sh.getRange(5, 1, last - 4, cols.length).clearContent();
  if (rows.length > 1) {
    var out = rows.slice(1).map(function (row) {
      return at.map(function (i) { return i < 0 || row[i] === undefined ? "" : num_(row[i]); });
    });
    sh.getRange(5, 1, out.length, cols.length).setValues(out);
  }
}

/** Refresh one sheet. Throws only for a mistake in this script or the sheet; the caller writes that into the sheet. */
function refreshSheet_(name, sh) {
  var r;
  if (name === "Watchlist") {
    var syms = sh.getRange(5, 1, Math.max(sh.getLastRow() - 4, 1), 1).getValues().map(function (x) { return x[0]; });
    var picked = syms.map(function (s) { return String(s).trim(); });
    r = quotes_(picked.filter(function (s) { return s; }), QUOTE_FIELDS);
    if (r.ok && !r.rows.length) {
      status_(sh, "Type some symbols in column A (one per row), then refresh. (" + stamp_() + ")");
      return;
    }
    if (r.ok) {
      // Put each answer next to the symbol typed on that row (blank rows stay blank), in the sheet's column order.
      var byInput = {};
      r.rows.slice(1).forEach(function (row) { if (!(row[0] in byInput)) byInput[row[0]] = row; });
      var head = r.rows[0];
      var want = ["ltp", "chg", "pct", "volume", "as_of", "age_s", "class", "source", "stale", "error"];
      var out = picked.map(function (s) {
        var row = byInput[s];
        return want.map(function (c) { return row ? num_(row[head.indexOf(c)]) : ""; });
      });
      sh.getRange(5, 2, out.length, want.length).setValues(out);
      var errors = r.rows.slice(1).filter(function (row) { return row[head.indexOf("error")]; }).length;
      var count = r.rows.length - 1;
      var demo = head.indexOf("demo") >= 0 && r.rows.length > 1 && r.rows[1][head.indexOf("demo")] === "DEMO";
      status_(sh, (demo ? "DEMO DATA, not real prices. " : "") + (errors ? "CHECK: " + errors + " of " + count + " symbols could not be priced (see Error). " : "OK. ") + "Refreshed " + stamp_() + ".");
    }
  } else {
    r = bridgeTable_(TABLES[name].route + "?format=csv" + (TABLES[name].query || ""), TABLES[name].cols[0]);
    if (r.ok) {
      fillTable_(sh, r.rows, TABLES[name].cols);
      var head2 = r.rows[0];
      var count2 = r.rows.length - 1;
      var errAt = head2.indexOf("error");
      var bad = errAt < 0 ? 0 : r.rows.slice(1).filter(function (row) { return row[errAt]; }).length;
      var demoAt = head2.indexOf("demo");
      var demo2 = demoAt >= 0 && count2 > 0 && r.rows[1][demoAt] === "DEMO";
      var cap = TABLES[name].limit;
      status_(sh, (demo2 ? "DEMO DATA, not real. " : "") + count2 + " rows. " + (bad ? "CHECK: " + bad + (bad === 1 ? " row has" : " rows have") + " an error (see the Error column). " : "") + (cap && count2 >= cap ? "Showing the latest " + cap + ": older ones are not shown. " : "") + "Refreshed " + stamp_() + ".");
    }
  }
  if (!r.ok) status_(sh, r.wait ? "Too many refreshes: wait " + r.wait + " seconds. (" + stamp_() + ")" : "NO ANSWER: " + r.message + " (" + stamp_() + ")");
}

/** The refresh: one request for the watchlist (plus one for each other sheet that exists). Safe to run by hand or on a timer. */
function refreshBridge() {
  var ss = SpreadsheetApp.getActive();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // a refresh is already running
  try {
    Object.keys(TABLES).forEach(function (name) {
      var sh = ss.getSheetByName(name);
      if (!sh) return;
      try {
        refreshSheet_(name, sh);
      } catch (e) {
        // One sheet failing must not stop the others, and the reason belongs on the sheet, not in a log nobody reads.
        status_(sh, "ERROR: " + String(e && e.message ? e.message : e).slice(0, 200) + " (" + stamp_() + ")");
      }
    });
  } finally {
    lock.releaseLock();
  }
}

/** Run refreshBridge on a timer. Minutes must be 1, 5, 10, 15 or 30 (Google's rule). */
function startTimedRefresh(minutes) {
  var n = [1, 5, 10, 15, 30].indexOf(Number(minutes)) >= 0 ? Number(minutes) : 5;
  stopTimedRefresh();
  ScriptApp.newTrigger("refreshBridge").timeBased().everyMinutes(n).create();
  SpreadsheetApp.getActive().toast("Refreshing every " + n + " minutes.");
}

function stopTimedRefresh() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "refreshBridge") ScriptApp.deleteTrigger(t);
  });
}
