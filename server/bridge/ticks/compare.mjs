/**
 * Compares two runs of a signal (runner.mjs outputs), output by output: the historical run against the live run, or any
 * two runs. "Identical" means the same outputs, for the same ticks, in the same order, with equal values.
 *
 * Outputs are matched by (time, symbol, k), where k counts outputs with that same time and symbol, so one missing
 * output shows as one missing output instead of shifting everything after it. The answer says what differs and where
 * it first did, which usually names the cause:
 *   missing  the live run did not produce an output the historical run did (a tick that never arrived, a dropped symbol)
 *   extra    the reverse (a tick the store does not have)
 *   value    same tick, different value (state shared between runs, Date.now() or randomness in the signal, a different
 *            normaliser, floating-point work done in a different order)
 *   order    the same outputs in a different order (ticks delivered in another order than recorded)
 */

const isNum = (v) => typeof v === "number";

/**
 * Deep equality for plain data. Numbers are equal when both are NaN, or |a - b| <= tolerance (0: exactly equal, with
 * 0 and -0 equal).
 */
export function valuesEqual(a, b, tolerance = 0) {
  if (isNum(a) && isNum(b)) {
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
    return tolerance > 0 ? Math.abs(a - b) <= tolerance : a === b;
  }
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || !valuesEqual(a[k], b[k], tolerance)) return false;
  return true;
}

const keysOf = (outputs) => {
  const seen = new Map();
  return outputs.map((o) => {
    const base = `${o.time}|${o.symbol}`;
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    return `${base}|${k}`;
  });
};

/**
 * @param {Array<{ n: number, time: number, symbol: string, value: any }>} expected  usually the historical run
 * @param {Array<{ n: number, time: number, symbol: string, value: any }>} actual    usually the live run
 * @param {{ tolerance?: number, maxReported?: number }} [opts]
 */
export function compareRuns(expected, actual, { tolerance = 0, maxReported = 20 } = {}) {
  const ek = keysOf(expected);
  const ak = keysOf(actual);
  const actualAt = new Map(ak.map((k, i) => [k, i]));
  const expectedKeys = new Set(ek);
  const diffs = [];
  const counts = { compared: 0, equal: 0, value: 0, missing: 0, extra: 0, order: 0 };
  const report = (d) => {
    if (diffs.length < maxReported) diffs.push(d);
  };

  // Matched pairs, walked in expected order; positions in `actual` must rise, or the order differs.
  let lastPos = -1;
  ek.forEach((key, i) => {
    const e = expected[i];
    const j = actualAt.get(key);
    if (j === undefined) {
      counts.missing += 1;
      report({ kind: "missing", n: e.n, time: e.time, symbol: e.symbol, expected: e.value });
      return;
    }
    counts.compared += 1;
    const a = actual[j];
    if (j < lastPos) {
      counts.order += 1;
      report({ kind: "order", n: e.n, time: e.time, symbol: e.symbol, actualN: a.n });
    }
    lastPos = Math.max(lastPos, j);
    if (valuesEqual(e.value, a.value, tolerance)) counts.equal += 1;
    else {
      counts.value += 1;
      report({ kind: "value", n: e.n, time: e.time, symbol: e.symbol, expected: e.value, actual: a.value });
    }
  });
  ak.forEach((key, j) => {
    if (expectedKeys.has(key)) return;
    counts.extra += 1;
    const a = actual[j];
    report({ kind: "extra", n: a.n, time: a.time, symbol: a.symbol, actual: a.value });
  });

  const firstDivergence = diffs.length ? diffs.reduce((m, d) => (d.time < m.time || (d.time === m.time && d.n < m.n) ? d : m)) : null;
  const identical = counts.value + counts.missing + counts.extra + counts.order === 0;
  return {
    identical,
    expected: expected.length,
    actual: actual.length,
    ...counts,
    tolerance,
    firstDivergence,
    diffs,
    summary: identical
      ? `Identical: ${expected.length} outputs match tick by tick.`
      : `Not identical: ${counts.value} different values, ${counts.missing} missing, ${counts.extra} extra, ${counts.order} out of order (of ${expected.length} expected).`,
  };
}
