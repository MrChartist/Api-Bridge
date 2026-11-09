/**
 * Naming tolerance for native order inputs. Alert text, spreadsheet cells and chart tools write the words people use
 * (MIS, NRML, mkt, stop_loss); the Bridge keeps one canonical value per field and says what it changed.
 *
 *   product    MIS -> INTRADAY · NRML, CARRYFORWARD -> MARGIN · DELIVERY -> CNC (case does not matter)
 *   orderType  MKT -> MARKET · SLM, SL_M -> SL-M · STOPLOSS, STOP_LOSS -> SL · STOP_LOSS_MARKET -> SL-M
 *   side, validity, orderType: case does not matter (buy -> BUY)
 *
 * Nothing is guessed: a word that is not on these lists is left alone and the normal validation refuses it. `mode`
 * is never touched (live must be asked for in exactly the right word). Pure functions, no I/O.
 */

export const PRODUCT_ALIASES = Object.freeze({
  MIS: "INTRADAY",
  NRML: "MARGIN",
  CARRYFORWARD: "MARGIN",
  CARRY_FORWARD: "MARGIN",
  DELIVERY: "CNC",
});

export const ORDER_TYPE_ALIASES = Object.freeze({
  MKT: "MARKET",
  SLM: "SL-M",
  SL_M: "SL-M",
  SLMKT: "SL-M",
  STOPLOSS: "SL",
  STOP_LOSS: "SL",
  STOPLOSS_MARKET: "SL-M",
  STOP_LOSS_MARKET: "SL-M",
});

const upper = (s) => s.trim().toUpperCase();

/**
 * @param {unknown} raw an order-like body (OrderRequest)
 * @returns {{ input: unknown, notes: Array<{ field: string, from: string, to: string }> }}
 *   input: a copy with canonical values (the same object when nothing changed); notes: each change, for the reply
 */
export function canonicaliseOrderInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { input: raw, notes: [] };
  /** @type {Record<string, unknown>} */
  let out = raw;
  const notes = [];
  const set = (field, to) => {
    if (out === raw) out = { ...raw };
    out[field] = to;
  };
  const apply = (field, table, canonical) => {
    const v = raw[field];
    if (typeof v !== "string" || v.length > 40) return;
    const u = upper(v);
    const to = table?.[u] ?? (canonical.includes(u) ? u : null);
    if (to === null) return; // not a known word: validation reports it
    if (to !== v) {
      set(field, to);
      notes.push({ field, from: v, to });
    }
  };
  apply("product", PRODUCT_ALIASES, ["CNC", "INTRADAY", "MARGIN", "MTF"]);
  apply("orderType", ORDER_TYPE_ALIASES, ["LIMIT", "MARKET", "SL", "SL-M"]);
  apply("side", null, ["BUY", "SELL"]);
  apply("validity", null, ["DAY", "IOC"]);
  return { input: out, notes };
}
