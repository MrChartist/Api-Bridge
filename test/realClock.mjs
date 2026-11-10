/**
 * The real wall clock in epoch milliseconds, even while `npm run test:future` has moved `Date` forward (test/shiftClock.cjs).
 * Use it when a test hands a time to something that reads the REAL clock: a Python or shell child, a file's modification time.
 * Everything inside node keeps using Date.now().
 */
export const realNow = () => (typeof globalThis.__mcbRealNow === "function" ? globalThis.__mcbRealNow() : Date.now());
