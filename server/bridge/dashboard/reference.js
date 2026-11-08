// Reference values the dashboard uses on its own: the statutory charge table behind the Trades tab's estimated charges.
//
// REF_DEFAULTS is the ONLY dashboard copy of these default values (brokerage and the charge table). Every value says
// where it comes from ("dashboard fallback"). The static test reference/noConstants.test.mjs keeps these literals out
// of every other dashboard file.

/** Where a fallback value comes from (shown wherever it is used). */
export const FALLBACK_SOURCE = "dashboard fallback";

/** The fallback values. The charge table has the server's shape (reference/data/charges.json + brokerage). */
export const REF_DEFAULTS = Object.freeze({
  source: FALLBACK_SOURCE,
  charges: Object.freeze({
    asOf: "2026-04-01",
    source: FALLBACK_SOURCE,
    verified: false,
    opt: Object.freeze({ sttSell: 0.0015, exerciseStt: 0.0015, stampBuy: 0.00003, txn: Object.freeze({ NSE: 0.0003503, BSE: 0.000325 }) }),
    fut: Object.freeze({ sttSell: 0.0005, stampBuy: 0.00002, txn: Object.freeze({ NSE: 0.0000173, BSE: 0 }) }),
    sebiPerCrore: 10,
    ipftPerCrore: 0,
    gst: 0.18,
    brokerage: Object.freeze({ kind: "flat", perOrder: 20, source: FALLBACK_SOURCE }),
  }),
});

/**
 * The statutory charge table the Trades tab prices with: { asOfDate, source, brokeragePerOrder, opt, fut, sebiPerCrore,
 * ipftPerCrore, gst } (all numbers are fractions of turnover except the per-crore fees and the flat brokerage).
 */
export function refCharges() {
  const c = REF_DEFAULTS.charges;
  return {
    asOfDate: c.asOf,
    source: c.source,
    brokeragePerOrder: c.brokerage.perOrder,
    opt: { ...c.opt, txn: { ...c.opt.txn } },
    fut: { ...c.fut, txn: { ...c.fut.txn } },
    sebiPerCrore: c.sebiPerCrore,
    ipftPerCrore: c.ipftPerCrore,
    gst: c.gst,
  };
}
