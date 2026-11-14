/**
 * Refuse unknown symbols at the door. Downloads and recordings call this when a job or a recording is created, so a
 * typo fails at once with a clear message and the closest real symbols, instead of failing hours later on the first
 * broker call.
 *
 * It asks the symbol service (the instrument masters of the connected brokers). It does nothing when there is no
 * service or no master is loaded yet (nothing to check against: the symbol would be refused wrongly), and says so by
 * returning `{ checked: false }`.
 *
 * Expired contracts are not in the masters. For history that is a legitimate request, so `allowExpired` lets a
 * well-formed canonical symbol with an expiry date in the past through. A recording never wants one (it saves live data
 * from now on), so recordings do not pass it.
 */
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { istDateOf } from "../reference/calendar.mjs";

const MAX_LISTED = 10;

/**
 * @param {any} service the symbol service (resolveInput, status)
 * @param {string[]} symbols canonical symbols
 * @param {{ allowExpired?: boolean, nowMs: number, path?: string, allowFlag?: string | null, what?: string }} o
 * @returns {Promise<{ checked: boolean, expiredAllowed: string[] }>}
 * @throws {BridgeError} VALIDATION_FAILED (400) naming the unknown symbols, with `unknownSymbols` [{ symbol, reason, expired, suggestions }]
 */
export async function assertKnownSymbols(service, symbols, { allowExpired = false, nowMs, path = "symbols", allowFlag = "allowExpired", what = "download" } = {}) {
  if (typeof service?.resolveInput !== "function") return { checked: false, expiredAllowed: [] };
  try {
    if (!(service.status?.().instruments > 0)) return { checked: false, expiredAllowed: [] };
  } catch {
    return { checked: false, expiredAllowed: [] };
  }
  const today = istDateOf(nowMs);
  const unknown = [];
  const expiredAllowed = [];
  for (const symbol of symbols) {
    let r;
    try {
      r = await service.resolveInput({ q: symbol, limit: 5 });
    } catch (err) {
      unknown.push({ symbol, reason: err?.detail ?? "not a symbol the Bridge understands", expired: false, suggestions: [] });
      continue;
    }
    if (r.status === "resolved") continue;
    let expiry = null;
    try {
      expiry = parseSymbol(symbol).expiry ?? null;
    } catch {
      /* not parseable: handled as unknown */
    }
    const expired = expiry !== null && expiry < today;
    if (expired && allowExpired) {
      expiredAllowed.push(symbol);
      continue;
    }
    const suggestions = (r.candidates ?? []).map((c) => c.instrument?.canonical).filter((s) => typeof s === "string" && s !== symbol).slice(0, 3);
    unknown.push({
      symbol,
      reason: expired ? `the contract expired on ${expiry}` : r.status === "ambiguous" ? r.rule : "it is not in any connected broker's instrument master",
      expired,
      suggestions,
    });
  }
  if (!unknown.length) return { checked: true, expiredAllowed };
  const shown = unknown.slice(0, MAX_LISTED);
  const lines = shown.map((u) => `${u.symbol} (${u.reason}${u.suggestions.length ? `; did you mean ${u.suggestions.join(", ")}?` : ""})`);
  const more = unknown.length > shown.length ? ` and ${unknown.length - shown.length} more` : "";
  const onlyExpired = unknown.every((u) => u.expired);
  const fix = onlyExpired
    ? allowFlag
      ? ` To get the history of an expired contract, send ${allowFlag}: true.`
      : ` ${what === "recording" ? "A recording saves live data from now on, so an expired contract cannot be recorded." : ""}`.trimEnd()
    : " Check the spelling with GET /v1/symbols/resolve?q=... or GET /v1/instruments/search?q=...";
  const message = `${unknown.length === 1 ? "This symbol is" : `${unknown.length} symbols are`} not known to the Bridge, so the ${what} was not created: ${lines.join("; ")}${more}.${fix}`;
  throw new BridgeError("VALIDATION_FAILED", message, {
    errors: unknown.slice(0, 20).map((u) => ({ path, message: `${u.symbol}: ${u.reason}` })),
    fields: { unknownSymbols: unknown.slice(0, 50).map(({ symbol, reason, expired, suggestions }) => ({ symbol, reason, expired, suggestions })) },
  });
}
