/**
 * Example source plugin: delayed quotes from a placeholder vendor, quotes.example.com.
 *
 * A plugin is one file. It exports an object with the read methods it declares in mc-source.json (here only `quotes`).
 * It never fetches by itself: ctx.fetch asks the Bridge to do it, and the Bridge only allows the hosts listed under
 * network.allowHosts in the manifest. The vendor below does not exist; the test answers with files from fixtures/.
 *
 * What the vendor is assumed to return for GET /v1/quotes?symbols=NSE:RELIANCE,NSE:TCS:
 *   { "quotes": [ { "symbol": "NSE:RELIANCE", "last": 2891.4, "open": 2880, "high": 2899.9, "low": 2872.1,
 *                   "prevClose": 2875.55, "volume": 4182211, "asOf": "2026-10-19T09:45:00+05:30" } ] }
 * `asOf` is the vendor's own timestamp, 15 minutes behind the market. Always pass the vendor's time through: a delayed
 * answer must never be stamped "now".
 */
const BASE = "https://quotes.example.com";

export default {
  async quotes(symbols, ctx) {
    const url = `${BASE}/v1/quotes?symbols=${encodeURIComponent(symbols.join(","))}&market=${encodeURIComponent(ctx.config.market)}`;
    const res = await ctx.fetch(url, { headers: { accept: "application/json" } });

    // Say what went wrong in the Bridge's own vocabulary; the Bridge decides about retries and failover.
    if (res.status === 429) ctx.fail("RATE_LIMITED", "the vendor asked us to slow down", Number(res.headers["retry-after"] ?? 5) * 1000);
    if (res.status === 401 || res.status === 403) ctx.fail("AUTH", "the vendor refused the request");
    if (res.status === 404) ctx.fail("NOT_FOUND", "the vendor does not know these symbols");
    if (res.status >= 500) ctx.fail("UNAVAILABLE", `the vendor answered ${res.status}`);
    if (!res.ok) ctx.fail("BAD_RESPONSE", `unexpected status ${res.status}`);

    const body = await res.json(); // BAD_RESPONSE if it is not JSON
    if (!Array.isArray(body?.quotes)) ctx.fail("BAD_RESPONSE", "no quotes array in the answer");

    const items = [];
    for (const q of body.quotes) {
      const at = Date.parse(q.asOf);
      if (!Number.isFinite(at)) continue; // no vendor timestamp, no answer
      items.push({
        symbol: q.symbol,
        at,
        fields: { ltp: q.last, open: q.open, high: q.high, low: q.low, close: q.prevClose, volume: q.volume },
      });
    }
    if (items.length === 0) ctx.fail("NOT_FOUND", "none of the symbols was found");
    return { items };
  },

  async test(ctx) {
    const res = await ctx.fetch(`${BASE}/v1/status`);
    return { ok: res.ok, detail: res.ok ? "the vendor answered" : `the vendor answered ${res.status}` };
  },
};
