/**
 * One temporary folder per test run. The tests make their own `mcb-*` folders with mkdtemp(os.tmpdir()) and most do not
 * remove them, so a long session filled the disk with tens of thousands of them. vitest.config.mjs points TMPDIR at a
 * fresh folder before any worker starts (workers and the processes tests spawn inherit it); this global setup removes
 * that folder, and everything the run left in it, when the run ends.
 */
import { rmSync } from "node:fs";

export default function setup() {
  return () => {
    const dir = process.env.MCB_TEST_TMPDIR;
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
}
