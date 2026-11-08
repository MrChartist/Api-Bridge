/**
 * Broker metadata for GET /v1/brokers and account summaries: display names, verification status, and
 * the broker policy table published by the ratelimit module (server/bridge/ratelimit/brokerPolicies.mjs, data only).
 *
 * The policy module is loaded lazily and tolerantly: until ratelimit ships it, every broker's pooling flag reads as
 * "unknown", which the Bridge treats as "not allowed" (one user's reads are never spread over accounts).
 */
import { declaredCapabilities } from "../../brokers/contract.mjs";

/** Display names, matching docs/BROKERS.md. Unknown ids fall back to the id. */
export const BROKER_NAMES = Object.freeze({
  dhan: "Dhan",
  fivepaisa: "5paisa",
  aliceblue: "Alice Blue",
  angelone: "Angel One (SmartAPI)",
  arrow: "Arrow",
  compositedge: "Composite Edge (XTS)",
  definedge: "Definedge Securities (INTEGRATE)",
  firstock: "Firstock",
  flattrade: "Flattrade (Pi)",
  fyers: "Fyers",
  groww: "Groww",
  hdfcsecurities: "HDFC Securities (InvestRight)",
  hdfcsky: "HDFC Sky (HDFC Securities)",
  iiflcapital: "IIFL Capital",
  iifl: "IIFL Securities (XTS)",
  ibulls: "IndiaBulls Securities (XTS)",
  indmoney: "IndMoney (INDstocks)",
  jainamxts: "Jainam (XTS)",
  kotak: "Kotak Securities (Neo)",
  motilal: "Motilal Oswal",
  mstock: "mStock (Mirae Asset)",
  nubra: "Nuvama Nubra",
  paytm: "Paytm Money",
  pocketful: "Pocketful",
  rmoney: "RMoney (XTS)",
  samco: "SAMCO Securities (StockNote)",
  shoonya: "Shoonya (Finvasia)",
  tradejini: "Tradejini (CubePlus)",
  tradesmart: "TradeSmart (Noren v2)",
  upstox: "Upstox",
  wisdom: "Wisdom Capital (XTS)",
  zebu: "Zebu (Mynt)",
  zerodha: "Zerodha (Kite)",
  rupeezy: "Rupeezy (Vortex)",
  icicidirect: "ICICI Direct (Breeze)",
  goodwill: "Goodwill (GWC)",
  bigul: "Bigul (Bigul Connect)",
  anandrathi: "Anand Rathi (Algozy, XTS)",
  fivepaisaxts: "5paisa (XTS)",
  profitmart: "Profitmart (ProfitMax API)",
  axisdirect: "Axis Direct (RAPID APIs)",
});

/** Brokers checked end to end against a live account (docs/BROKERS.md). Only Dhan today. */
export const VERIFIED_BROKERS = Object.freeze(["dhan"]);

export const PAPER_BROKER = "paper";

/** Contract capability names that are plumbing, not something a caller can use. */
const HIDDEN_CAPABILITIES = new Set(["auth", "normaliseError"]);

/** User-facing capabilities an adapter declares (strict contract), in contract order. */
export function adapterCapabilities(adapter) {
  return declaredCapabilities(adapter).filter((c) => !HIDDEN_CAPABILITIES.has(c));
}

/**
 * Normalise whatever ratelimit exports into a lookup: an object keyed by broker id, or an array of { brokerId, ... }.
 * @param {unknown} raw
 * @returns {Readonly<Record<string, import("../core/contracts.mjs").BrokerPolicy>>}
 */
export function normalisePolicies(raw) {
  const out = {};
  if (Array.isArray(raw)) {
    for (const p of raw) if (p && typeof p === "object" && typeof p.brokerId === "string") out[p.brokerId] = p;
  } else if (raw && typeof raw === "object") {
    for (const [id, p] of Object.entries(raw)) if (p && typeof p === "object") out[id] = p;
  }
  return Object.freeze(out);
}

/**
 * Load BROKER_POLICIES from ratelimit's data module. A missing module (ratelimit not merged yet) gives an empty table; any other
 * failure is logged and also gives an empty table, so a policy bug can only make pooling stricter, never looser.
 * @param {{ warn(msg: string, f?: object): void }} [logger]
 * @param {() => Promise<any>} [importer] test seam
 */
export async function loadBrokerPolicies(logger, importer = () => import("../ratelimit/brokerPolicies.mjs")) {
  try {
    const mod = await importer();
    return normalisePolicies(mod?.BROKER_POLICIES ?? mod?.default ?? null);
  } catch (err) {
    const missing = err?.code === "ERR_MODULE_NOT_FOUND" && String(err?.message ?? "").includes("brokerPolicies");
    if (!missing) logger?.warn("broker policy table could not be loaded; treating every broker's pooling as unknown", { err });
    return Object.freeze({});
  }
}

/** The pooling flag for a broker, defaulting to "unknown" (treated as not allowed). */
export function poolingFor(policies, brokerId) {
  const p = policies?.[brokerId]?.pooling;
  return p === "allowed" || p === "not-allowed" ? p : "unknown";
}
