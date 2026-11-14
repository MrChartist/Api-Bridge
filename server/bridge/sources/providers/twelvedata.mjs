/**
 * Twelve Data as a bring-your-own-key, official, end-of-day source (NSE and BSE quotes and daily history).
 *
 * Documented facts used (vendor pages checked 2026-11-08): the key may be sent as `Authorization: apikey <key>`
 * (the recommended method, used here so the key never appears in a URL) or as an `apikey` query parameter; errors are
 * a JSON object `{ code, message, status: "error" }` and the HTTP status follows the code (400 bad parameter, 401 bad
 * key, 403 plan does not include it, 404 not found, 429 request limit reached); the free Basic plan allows 8 credits
 * per minute and 800 per day; NSE (XNSE) and BSE (XBOM) are listed as end-of-day data and need the Grow plan or above,
 * so a free key gets a 403 for Indian symbols. Each symbol costs one credit, so one request is made per symbol.
 *
 * Terms (twelvedata.com/terms): the free tier may not be used commercially and no data may be redistributed without
 * an add-on. That is why this source is bring-your-own-key: the user holds the account and accepts the terms.
 */
import { BridgeError } from "../../core/errors.mjs";
import { istDate } from "../../market/time.mjs";
import { parseSymbol } from "../../core/symbolFormat.mjs";
import { FUTURE_SKEW_MS, checkRange, createHttp, createLimiter, msToNextUtcDay, num, price, readNow, sourceError, systemClock, throwIfAborted, unsupported, vendorTime } from "./common.mjs";

export const TWELVEDATA_HOST = "api.twelvedata.com";
export const TWELVEDATA_USER_AGENT = "Bridge-DataSource/1.0 (self-hosted market-data bridge; read-only; personal use)";
const NAME = "Twelve Data";
const MIC = Object.freeze({ NSE: "XNSE", BSE: "XBOM" });
const MAX_POINTS = 5000;

const descriptor = Object.freeze({
  id: "twelvedata",
  name: "Twelve Data",
  kind: "free",
  tier: "byok",
  class: "eod",
  delaySec: null,
  official: true,
  capabilities: Object.freeze(["quotes", "history"]),
  limits: Object.freeze({ perMinute: 8, perDay: 800 }),
  needsKey: true,
  terms: Object.freeze({
    url: "https://twelvedata.com/terms",
    note: "You use your own Twelve Data key, Indian exchange data needs its paid Grow plan or above, and its terms bar reselling or redistributing the data and using free-plan data commercially.",
  }),
  note: "End-of-day NSE and BSE shares only. A free Basic key is refused for Indian symbols; the Bridge then says the plan lacks India coverage.",
});

/** Bridge symbol to Twelve Data `{ symbol, mic_code }` (cash equities on NSE and BSE only). */
export function toTwelveDataSymbol(bridgeSymbol) {
  let p;
  try {
    p = parseSymbol(bridgeSymbol);
  } catch {
    throw sourceError("not-found", `"${String(bridgeSymbol).slice(0, 40)}" is not a Bridge symbol. Use a form like NSE:RELIANCE.`, { source: "twelvedata" });
  }
  if (!MIC[p.exchange]) throw unsupported(NAME, `${p.canonical}; only NSE and BSE shares are covered`);
  if (p.kind !== "EQ") throw unsupported(NAME, `${p.canonical}; only NSE and BSE shares are covered, not indices or derivatives`);
  return { symbol: p.underlying, mic_code: MIC[p.exchange] };
}

/**
 * @param {{ apiKey?: string | (() => string | null | undefined | Promise<string | null | undefined>), fetch?: typeof fetch,
 *   clock?: object, userAgent?: string, timeoutMs?: number, maxWaitMs?: number }} [opts]
 */
export function createTwelveDataProvider({ apiKey, fetch: fetchImpl = globalThis.fetch, clock = systemClock, userAgent = TWELVEDATA_USER_AGENT, timeoutMs, maxWaitMs } = {}) {
  let lastKey = "";
  const limiter = createLimiter({ limits: descriptor.limits, clock, source: "twelvedata", label: NAME, maxWaitMs });
  const http = createHttp({ id: "twelvedata", name: NAME, fetch: fetchImpl, clock, hosts: [TWELVEDATA_HOST], limiter, userAgent, timeoutMs, secrets: () => [lastKey] });
  const flags = () => ["eod"];
  const noIndia = () => sourceError("entitlement", "Your Twelve Data plan does not include NSE and BSE data. Indian exchanges need the Grow plan or above.", { source: "twelvedata" });

  async function key() {
    const k = typeof apiKey === "function" ? await apiKey() : apiKey;
    if (typeof k !== "string" || !k.trim()) throw sourceError("auth", "No Twelve Data key is set. Add your key in the Sources settings first.", { source: "twelvedata" });
    lastKey = k.trim();
    return lastKey;
  }

  /** Turn a vendor error (HTTP status and/or body code) into a classified error. */
  function vendorError(res, code, message) {
    const text = String(message ?? "");
    if (code === 429 || res.status === 429) {
      const daily = /day|daily/i.test(text);
      const wait = daily ? msToNextUtcDay(clock.now()) : undefined;
      const err = http.rateLimited(res, { fallbackMs: wait ?? 60_000, message: `${NAME} says the request limit for your key is reached.` });
      if (daily) limiter.block(wait);
      return err;
    }
    if (code === 401 || res.status === 401) return sourceError("auth", `${NAME} did not accept the key. Check it in the Sources settings.`, { source: "twelvedata", secrets: [lastKey] });
    if (code === 403 || res.status === 403 || /available starting with|upgrade|your plan|grow|venture/i.test(text)) return noIndia();
    if (code === 404 || res.status === 404 || /not found|symbol.*(invalid|missing)|invalid.*symbol/i.test(text)) return sourceError("not-found", `${NAME} has no data for this symbol.`, { source: "twelvedata" });
    if (code >= 500 || res.status >= 500) return http.upstream(`${NAME} is having trouble (status ${code ?? res.status}).`);
    return http.upstream(`${NAME} rejected the request: ${text.slice(0, 120)}`);
  }

  async function call(path, params, signal) {
    const k = await key();
    const res = await http.get(`https://${TWELVEDATA_HOST}/${path}?${new URLSearchParams(params)}`, { headers: { authorization: `apikey ${k}` }, signal });
    const body = res.json;
    if (res.status !== 200) throw vendorError(res, num(body?.code), body?.message);
    if (!body || typeof body !== "object") throw http.upstream(`${NAME} sent an answer the Bridge could not read.`);
    // Some errors arrive with HTTP 200 and the code in the body.
    if (body.status === "error" || (Number.isFinite(body.code) && body.code >= 400)) throw vendorError(res, num(body.code), body.message);
    return body;
  }

  const istDayStart = (isoDate) => Date.parse(`${isoDate}T00:00:00+05:30`);

  async function quotes(symbols, ctx = {}) {
    const items = [];
    let firstError = null;
    const nowMs = readNow(ctx, clock);
    for (const symbol of symbols) {
      throwIfAborted(ctx.signal);
      try {
        const body = await call("quote", toTwelveDataSymbol(symbol), ctx.signal);
        const ltp = price(body.close);
        const day = typeof body.datetime === "string" && /^\d{4}-\d{2}-\d{2}/.test(body.datetime) ? body.datetime.slice(0, 10) : null;
        const stamp = num(body.timestamp);
        // The vendor's own time, but never one ahead of the Bridge's clock (vendorTime clamps skew and refuses the future).
        const at = vendorTime(stamp !== null && stamp > 0 ? stamp * 1000 : day ? istDayStart(day) : null, nowMs);
        if (ltp === null || at === null) throw sourceError("not-found", `${NAME} has no usable quote for ${symbol}.`, { source: "twelvedata" });
        items.push({
          symbol,
          fields: { ltp, open: price(body.open), high: price(body.high), low: price(body.low), close: price(body.previous_close), volume: num(body.volume) },
          at,
          provider: "twelvedata",
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
    if (req.interval !== "1d") throw unsupported(NAME, `${req.interval} candles (Indian data here is end of day only)`);
    const nowMs = readNow(ctx, clock);
    const body = await call("time_series", { ...toTwelveDataSymbol(req.symbol), interval: "1day", start_date: istDate(fromMs), end_date: istDate(Math.min(toMs, nowMs)), order: "asc", outputsize: String(MAX_POINTS) }, ctx.signal);
    const values = Array.isArray(body.values) ? body.values : null;
    if (!values) throw sourceError("not-found", `${NAME} has no daily data for ${req.symbol}.`, { source: "twelvedata" });
    const byTime = new Map();
    for (const v of values) {
      const day = typeof v?.datetime === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.datetime) ? v.datetime.slice(0, 10) : null;
      const open = price(v?.open);
      const high = price(v?.high);
      const low = price(v?.low);
      const close = price(v?.close);
      if (!day || open === null || high === null || low === null || close === null) continue;
      const time = Math.floor(istDayStart(day) / 1000);
      if (!(time > 0) || time * 1000 > nowMs + FUTURE_SKEW_MS) continue; // a day that has not happened is not a candle
      byTime.set(time, { time, open, high, low, close, volume: Math.max(0, num(v.volume) ?? 0) });
    }
    const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
    const out = { candles, at: nowMs, provider: "twelvedata", flags: flags() };
    if (values.length >= MAX_POINTS) out.partial = true;
    return out;
  }

  async function test(ctx = {}) {
    const started = clock.now();
    try {
      await call("quote", toTwelveDataSymbol("NSE:RELIANCE"), ctx.signal);
      return { ok: true, latencyMs: clock.now() - started, detail: "The key was accepted and the plan includes NSE data." };
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      return { ok: false, latencyMs: clock.now() - started, detail: err instanceof BridgeError ? err.detail : `${NAME} could not be reached.` };
    }
  }

  const refuse = (what) => async () => {
    throw unsupported(NAME, what);
  };

  return { descriptor, hosts: [TWELVEDATA_HOST], quotes, history, test, usage: () => limiter.usage(), expiries: refuse("option expiry lists"), optionChain: refuse("option chains") };
}
