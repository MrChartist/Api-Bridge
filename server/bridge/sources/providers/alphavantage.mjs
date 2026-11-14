/**
 * Alpha Vantage as a bring-your-own-key, official, end-of-day source (quotes and daily history).
 *
 * Documented facts used (vendor pages checked 2026-11-08): the key goes in the `apikey` query parameter; the free key
 * allows 25 requests per day (support page); GLOBAL_QUOTE is "updated at the end of each trading day" unless a premium
 * entitlement is used; TIME_SERIES_DAILY returns 100 points with `outputsize=compact` (free) and the full history only
 * with `outputsize=full` (premium). Intraday series and `entitlement=delayed|realtime` are premium and are not used.
 * A limit or quota message arrives as HTTP 200 with an `Information` or `Note` field, so the body is always checked.
 *
 * Coverage: the documentation lists BSE tickers (`RELIANCE.BSE`). NSE tickers were reported dropped by community
 * sources and are not confirmed, so NSE and every index are refused with a plain message instead of guessed.
 *
 * The 5 requests per minute figure is the older documented free limit; the current support page states only the daily
 * number. Both are enforced, the stricter one wins at any moment.
 */
import { BridgeError } from "../../core/errors.mjs";
import { istMidnight } from "../../market/time.mjs";
import { parseSymbol } from "../../core/symbolFormat.mjs";
import { FUTURE_SKEW_MS, checkRange, createHttp, createLimiter, msToNextUtcDay, num, price, readNow, sessionCloseMinutes, sourceError, systemClock, throwIfAborted, unsupported, vendorTime } from "./common.mjs";

export const ALPHAVANTAGE_HOST = "www.alphavantage.co";
export const ALPHAVANTAGE_USER_AGENT = "Bridge-DataSource/1.0 (self-hosted market-data bridge; read-only; personal use)";
const NAME = "Alpha Vantage";
const CLOSE_MS = sessionCloseMinutes("BSE") * 60_000;

const descriptor = Object.freeze({
  id: "alphavantage",
  name: "Alpha Vantage",
  kind: "free",
  tier: "byok",
  class: "eod",
  delaySec: null,
  official: true,
  capabilities: Object.freeze(["quotes", "history"]),
  limits: Object.freeze({ perMinute: 5, perDay: 25 }),
  needsKey: true,
  terms: Object.freeze({
    url: "https://www.alphavantage.co/terms_of_service/",
    note: "You use your own free Alpha Vantage key (25 requests a day), you accept Alpha Vantage's terms, and you are responsible for having the right to use its Indian exchange data.",
  }),
  note: "Daily end-of-day data for BSE only; intraday needs a premium plan and is not offered. The free key's 25 requests per day is documented; 5 per minute is the older documented free limit and is kept as a safety margin.",
});

/** Bridge symbol to Alpha Vantage ticker (BSE only). */
export function toAlphaVantageSymbol(bridgeSymbol) {
  let p;
  try {
    p = parseSymbol(bridgeSymbol);
  } catch {
    throw sourceError("not-found", `"${String(bridgeSymbol).slice(0, 40)}" is not a Bridge symbol. Use a form like BSE:RELIANCE.`, { source: "alphavantage" });
  }
  if (p.exchange === "NSE") throw unsupported(NAME, `NSE data (it lists BSE only), so ${p.canonical} cannot be looked up there`);
  if (p.exchange !== "BSE" || p.kind !== "EQ") throw unsupported(NAME, `${p.canonical}; only BSE shares are covered`);
  return `${p.underlying}.BSE`;
}

/**
 * @param {{ apiKey?: string | (() => string | null | undefined | Promise<string | null | undefined>), fetch?: typeof fetch,
 *   clock?: object, premium?: boolean, userAgent?: string, timeoutMs?: number, maxWaitMs?: number }} [opts]
 *   apiKey may be a function so a key changed in settings is picked up without re-creating the provider. `premium`
 *   asks for the full history (`outputsize=full`); leave it off for a free key.
 */
export function createAlphaVantageProvider({ apiKey, fetch: fetchImpl = globalThis.fetch, clock = systemClock, premium = false, userAgent = ALPHAVANTAGE_USER_AGENT, timeoutMs, maxWaitMs } = {}) {
  let lastKey = "";
  const limiter = createLimiter({ limits: descriptor.limits, clock, source: "alphavantage", label: NAME, maxWaitMs });
  const http = createHttp({ id: "alphavantage", name: NAME, fetch: fetchImpl, clock, hosts: [ALPHAVANTAGE_HOST], limiter, userAgent, timeoutMs, secrets: () => [lastKey] });
  const flags = () => ["eod"];

  async function key() {
    const k = typeof apiKey === "function" ? await apiKey() : apiKey;
    if (typeof k !== "string" || !k.trim()) throw sourceError("auth", "No Alpha Vantage key is set. Add your key in the Sources settings first.", { source: "alphavantage" });
    lastKey = k.trim();
    return lastKey;
  }

  /** Classify the vendor's HTTP 200 message fields. Returns an error or null. */
  function messageError(json) {
    const text = [json?.Note, json?.Information, json?.["Error Message"]].filter((x) => typeof x === "string").join(" ");
    if (!text) return null;
    const secrets = [lastKey];
    if (/rate limit|requests per day|calls per day|call frequency|per minute|per day|requests per minute/i.test(text)) {
      const perMinute = /per minute/i.test(text) && !/per day/i.test(text);
      const wait = perMinute ? 60_000 : msToNextUtcDay(clock.now());
      limiter.block(wait);
      return sourceError("rate-limited", `${NAME} says the free request limit is used up. It will be tried again in about ${Math.ceil(wait / 60_000)} minutes.`, { source: "alphavantage", retryAfterMs: wait, secrets });
    }
    if (/api\s?key/i.test(text) && /invalid|missing|demo|not valid|claim/i.test(text)) return sourceError("auth", `${NAME} did not accept the key. Check it in the Sources settings.`, { source: "alphavantage", secrets });
    if (/premium/i.test(text)) return sourceError("entitlement", `${NAME} offers this only on a premium plan.`, { source: "alphavantage", secrets });
    if (/invalid api call/i.test(text)) return sourceError("not-found", `${NAME} does not know this symbol.`, { source: "alphavantage", secrets });
    return sourceError("upstream", `${NAME} reported a problem: ${text.slice(0, 120)}`, { source: "alphavantage", secrets });
  }

  async function call(params, signal) {
    const k = await key();
    const url = `https://${ALPHAVANTAGE_HOST}/query?${new URLSearchParams({ ...params, apikey: k })}`;
    const res = await http.get(url, { signal });
    if (res.status === 429) throw http.rateLimited(res);
    if (res.status === 401 || res.status === 403) throw sourceError("auth", `${NAME} did not accept the key. Check it in the Sources settings.`, { source: "alphavantage", secrets: [k] });
    if (res.status >= 500) throw http.upstream(`${NAME} is having trouble (status ${res.status}).`);
    if (res.status !== 200 || !res.json || typeof res.json !== "object") throw http.upstream(`${NAME} sent an answer the Bridge could not read.`);
    const err = messageError(res.json);
    if (err) throw err;
    return res.json;
  }

  /** Epoch ms of an IST calendar date at midnight. */
  const istDayStart = (isoDate) => Date.parse(`${isoDate}T00:00:00+05:30`);

  async function quotes(symbols, ctx = {}) {
    const items = [];
    let firstError = null;
    const nowMs = readNow(ctx, clock);
    for (const symbol of symbols) {
      throwIfAborted(ctx.signal);
      try {
        const ticker = toAlphaVantageSymbol(symbol);
        const json = await call({ function: "GLOBAL_QUOTE", symbol: ticker }, ctx.signal);
        const q = json["Global Quote"];
        const ltp = price(q?.["05. price"]);
        const day = /^\d{4}-\d{2}-\d{2}$/.test(q?.["07. latest trading day"] ?? "") ? q["07. latest trading day"] : null;
        const at = day ? vendorTime(istDayStart(day) + CLOSE_MS, nowMs) : null;
        if (!q || ltp === null || !day || at === null) throw sourceError("not-found", `${NAME} has no usable quote for ${symbol}.`, { source: "alphavantage" });
        items.push({
          symbol,
          fields: { ltp, open: price(q["02. open"]), high: price(q["03. high"]), low: price(q["04. low"]), close: price(q["08. previous close"]), volume: num(q["06. volume"]) },
          at,
          provider: "alphavantage",
          flags: flags(),
        });
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        if (!(err instanceof BridgeError)) throw http.upstream(`${NAME} could not be read.`);
        firstError ??= err;
        if (["rate-limited", "auth", "entitlement"].includes(err.fields?.kind)) break;
      }
    }
    if (!items.length && firstError) throw firstError;
    return { items };
  }

  async function history(req, ctx = {}) {
    const { fromMs, toMs } = checkRange(req);
    if (req.interval !== "1d") throw unsupported(NAME, `${req.interval} candles (the free key has daily candles only; intraday is premium)`);
    const ticker = toAlphaVantageSymbol(req.symbol);
    const nowMs = readNow(ctx, clock);
    const json = await call({ function: "TIME_SERIES_DAILY", symbol: ticker, outputsize: premium ? "full" : "compact" }, ctx.signal);
    const series = json["Time Series (Daily)"];
    if (!series || typeof series !== "object") throw sourceError("not-found", `${NAME} has no daily data for ${req.symbol}.`, { source: "alphavantage" });
    const all = [];
    for (const [day, row] of Object.entries(series)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const open = price(row?.["1. open"]);
      const high = price(row?.["2. high"]);
      const low = price(row?.["3. low"]);
      const close = price(row?.["4. close"]);
      if (open === null || high === null || low === null || close === null) continue;
      const time = Math.floor(istDayStart(day) / 1000);
      if (!(time > 0) || time * 1000 > nowMs + FUTURE_SKEW_MS) continue; // a day that has not happened is not a candle
      all.push({ time, open, high, low, close, volume: Math.max(0, num(row["5. volume"]) ?? 0) });
    }
    all.sort((a, b) => a.time - b.time);
    const candles = [];
    for (const c of all) if (c.time !== candles[candles.length - 1]?.time && c.time * 1000 >= istMidnight(fromMs) && c.time * 1000 <= toMs) candles.push(c);
    const out = { candles, at: nowMs, provider: "alphavantage", flags: flags() };
    // A free key returns only the latest 100 days: say so when the request reaches further back.
    if (!premium && all.length && fromMs < all[0].time * 1000 && all.length >= 100) out.partial = true;
    return out;
  }

  async function test(ctx = {}) {
    const started = clock.now();
    try {
      const json = await call({ function: "GLOBAL_QUOTE", symbol: "RELIANCE.BSE" }, ctx.signal);
      // Success means the answer has the documented shape (a "Global Quote" with a price), not merely that it was JSON: an
      // empty object or an unrelated document is the vendor changing or something else answering on its host.
      const q = json["Global Quote"];
      if (!q || typeof q !== "object" || price(q["05. price"]) === null || !/^\d{4}-\d{2}-\d{2}$/.test(q["07. latest trading day"] ?? "")) {
        return { ok: false, latencyMs: clock.now() - started, detail: `${NAME} answered, but not in the documented shape (no "Global Quote" with a price), so the check cannot say the key works.` };
      }
      return { ok: true, latencyMs: clock.now() - started, detail: "The key was accepted. This check used one of the day's requests." };
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      return { ok: false, latencyMs: clock.now() - started, detail: err instanceof BridgeError ? err.detail : `${NAME} could not be reached.` };
    }
  }

  const refuse = (what) => async () => {
    throw unsupported(NAME, what);
  };

  return { descriptor, hosts: [ALPHAVANTAGE_HOST], quotes, history, test, usage: () => limiter.usage(), expiries: refuse("option expiry lists"), optionChain: refuse("option chains") };
}
