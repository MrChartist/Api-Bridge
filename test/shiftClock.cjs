/**
 * Node preload for `npm run test:future` (scripts/test-future.mjs): the wall clock reads "now + TEST_CLOCK_SHIFT_DAYS days" from
 * the moment the process starts and then runs on at real speed. Loaded through NODE_OPTIONS, so the test workers and every
 * node child process they start see the same shifted clock. Only `Date` moves (timers keep real durations). A test that
 * silently depends on today's date (a hard-coded expiry, a key that "expires in a week", a price that follows the clock)
 * fails on this run weeks before it fails for the next contributor.
 */
const days = Number(process.env.TEST_CLOCK_SHIFT_DAYS);
if (Number.isFinite(days) && days !== 0) {
  const RealDate = Date;
  const offset = Math.round(days * 86_400_000);
  function ShiftedDate(...args) {
    if (!new.target) return new RealDate(RealDate.now() + offset).toString();
    if (args.length === 0) return new RealDate(RealDate.now() + offset);
    return new RealDate(...args);
  }
  ShiftedDate.prototype = RealDate.prototype;
  Object.setPrototypeOf(ShiftedDate, RealDate);
  ShiftedDate.now = () => RealDate.now() + offset;
  ShiftedDate.UTC = RealDate.UTC;
  ShiftedDate.parse = RealDate.parse;
  globalThis.Date = ShiftedDate;
  // The un-shifted clock, for tests that hand a time to something outside node (a Python or shell child, a file's mtime).
  globalThis.__mcbRealNow = () => RealDate.now();
}
