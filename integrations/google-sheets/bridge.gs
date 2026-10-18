/**
 * Mr. Chartist API Bridge — Google Sheets custom functions (Apps Script). Read-only.
 *
 * Google runs Apps Script on its own servers, which cannot reach 127.0.0.1 on your computer. This script works only
 * if you expose the Bridge through your own tunnel (see README.md for the risks and the settings it needs).
 *
 * Setup: Extensions → Apps Script, paste this file, then Project Settings → Script properties:
 *   BRIDGE_URL  https://your-tunnel.example.com     (no trailing slash)
 *   BRIDGE_KEY  mcb_...                               (a read-only key; sent as a header, never in the URL)
 * Script properties are visible to anyone who can edit the script, so share the sheet as view-only.
 *
 * Rate limits: results are cached for CACHE_SECONDS in CacheService, and Google itself recalculates custom functions
 * sparingly, so a sheet full of formulas does not turn into a burst of broker calls.
 */

var CACHE_SECONDS = 60;

function bridgeConfig_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty("BRIDGE_URL");
  var key = props.getProperty("BRIDGE_KEY");
  if (!url || !key) throw new Error("Set BRIDGE_URL and BRIDGE_KEY in Project Settings → Script properties.");
  return { url: url.replace(/\/+$/, ""), key: key };
}

/** GET a Bridge path with the key in a header; returns the body text, or throws with the Bridge's error code. */
function bridgeGet_(path) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(path);
  if (hit !== null) return hit;
  var cfg = bridgeConfig_();
  var res = UrlFetchApp.fetch(cfg.url + path, {
    method: "get",
    headers: { Authorization: "Bearer " + cfg.key },
    muteHttpExceptions: true,
    followRedirects: false,
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) {
    var errCode = res.getHeaders()["X-Error-Code"] || res.getHeaders()["x-error-code"] || "";
    throw new Error("Bridge " + code + (errCode ? " " + errCode : ""));
  }
  if (body.length < 90000) cache.put(path, body, CACHE_SECONDS);
  return body;
}

function q_(s) {
  return encodeURIComponent(String(s).trim());
}

/**
 * Last traded price of a Bridge symbol.
 * @param {string} symbol e.g. "NSE:NIFTY", "NSE:M&M", "NFO:NIFTY-2026-10-27-25000-CE"
 * @return {number}
 * @customfunction
 */
function BRIDGE_LTP(symbol) {
  return Number(bridgeGet_("/xl/ltp?symbol=" + q_(symbol)));
}

/**
 * One quote field of a Bridge symbol.
 * @param {string} symbol e.g. "NSE:RELIANCE"
 * @param {string} field ltp, open, high, low, close, change, changePct, volume, oi, bid or ask
 * @return {number}
 * @customfunction
 */
function BRIDGE_QUOTE(symbol, field) {
  return Number(bridgeGet_("/xl/quote?symbol=" + q_(symbol) + "&field=" + q_(field)));
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
  var path = "/xl/chain?format=csv&underlying=" + q_(underlying) + "&expiry=" + q_(expiryText_(expiry)) + "&strikes=" + q_(strikes || 10);
  return Utilities.parseCsv(bridgeGet_(path));
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
  var path = "/xl/history?symbol=" + q_(symbol) + "&interval=" + q_(interval) + "&countback=" + q_(countback || 100);
  return Utilities.parseCsv(bridgeGet_(path));
}

/** A date cell or "YYYY-MM-DD" text -> "YYYY-MM-DD". */
function expiryText_(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") return Utilities.formatDate(v, "Asia/Kolkata", "yyyy-MM-dd");
  return String(v).trim();
}
