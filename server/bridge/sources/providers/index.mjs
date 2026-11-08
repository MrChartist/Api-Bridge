/**
 * The built-in free providers: Yahoo (opt-in, unofficial, delayed), Alpha Vantage and Twelve Data (bring your own key,
 * official, end of day). All are read-only, take an injected `fetch` and clock, and enforce their documented limits.
 *
 * Deliberately NOT built here:
 *  - NSE and BSE: the exchanges' terms prohibit systematic or automated data collection, and their website JSON sits
 *    behind anti-bot controls that the Bridge will not work around. Their file downloads need a legal read first.
 *  - AMFI (mutual fund NAV): the terms say personal, non-commercial use and no storing a significant part of the file;
 *    that is unverified for an automated, cached download.
 * See docs/sources-architecture.md and the data-source research for the reasons and the sources.
 */
import { createAlphaVantageProvider } from "./alphavantage.mjs";
import { createTwelveDataProvider } from "./twelvedata.mjs";
import { createYahooProvider } from "./yahoo.mjs";

export { createAlphaVantageProvider, createTwelveDataProvider, createYahooProvider };
export { toYahooSymbol, YAHOO_INDEX_TABLE, YAHOO_INTERVALS } from "./yahoo.mjs";
export { toAlphaVantageSymbol } from "./alphavantage.mjs";
export { toTwelveDataSymbol } from "./twelvedata.mjs";

/**
 * @param {{ fetch?: typeof fetch, getSecret?: (sourceId: string) => string | null | undefined | Promise<string | null | undefined>,
 *   clock?: { now(): number, sleep(ms: number, signal?: AbortSignal): Promise<void> } }} [deps]
 *   getSecret receives the provider id ("alphavantage", "twelvedata") and returns the user's key. It is called on every
 *   request, so a key saved or removed in settings takes effect at once. Keys are never logged or returned.
 * @returns {Array<import("../contract.mjs").SourceProvider & { hosts: string[] }>}
 */
export function createBuiltinProviders({ fetch: fetchImpl = globalThis.fetch, getSecret, clock } = {}) {
  const keyFor = (id) => () => (typeof getSecret === "function" ? getSecret(id) : null);
  const common = { fetch: fetchImpl, ...(clock ? { clock } : {}) };
  return [
    createYahooProvider(common),
    createAlphaVantageProvider({ ...common, apiKey: keyFor("alphavantage") }),
    createTwelveDataProvider({ ...common, apiKey: keyFor("twelvedata") }),
  ];
}
