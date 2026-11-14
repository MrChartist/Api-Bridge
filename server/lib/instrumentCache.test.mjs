import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, getCachedOrFetch } from "./instrumentCache.mjs";

describe("instrument cache location", () => {
  it("a test run keeps the cache in its own temp folder, never in the source tree", async () => {
    const dir = process.env.MCB_INSTRUMENT_CACHE_DIR;
    expect(dir, "vitest.config.mjs sets MCB_INSTRUMENT_CACHE_DIR").toBeTruthy();
    expect(resolve(dir).startsWith(resolve(process.env.MCB_TEST_TMPDIR))).toBe(true);
    const key = `cache-location-test-${Math.random().toString(36).slice(2)}`;
    const data = await getCachedOrFetch(key, async () => ({ rows: [1, 2, 3] }), ONE_DAY_MS);
    expect(data).toEqual({ rows: [1, 2, 3] });
    const file = join(dir, `${key}.json`);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).data).toEqual({ rows: [1, 2, 3] });
    expect(existsSync(join(import.meta.dirname, "..", "..", ".cache", `${key}.json`))).toBe(false);
  });
});
