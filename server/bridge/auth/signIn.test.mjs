import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PENDING, SIGN_IN_CODE_RE, SIGN_IN_TTL_MS, consumeSignInCode, createSignInCode, signInPath } from "./signIn.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "mcb-signin-"));
const stored = (d) => JSON.parse(readFileSync(signInPath(d), "utf8"));

describe("one-time sign-in codes", () => {
  it("stores only a SHA-256 hash with the expiry, in a private file", async () => {
    const d = dir();
    const t = Date.parse("2026-10-28T10:00:00Z");
    const { code, expiresAt } = await createSignInCode(d, { now: t });
    expect(code).toMatch(SIGN_IN_CODE_RE);
    expect(expiresAt).toBe(new Date(t + SIGN_IN_TTL_MS).toISOString());
    const raw = readFileSync(signInPath(d), "utf8");
    expect(raw).not.toContain(code);
    expect(stored(d).codes).toEqual([{ hash: createHash("sha256").update(code).digest("hex"), expiresAt }]);
    if (process.platform !== "win32") expect(statSync(signInPath(d)).mode & 0o777).toBe(0o600);
    // The lock file is gone afterwards.
    expect(existsSync(join(d, ".sign-in-codes.json.lock"))).toBe(false);
  });

  it("works once, then never again", async () => {
    const d = dir();
    const { code } = await createSignInCode(d);
    const other = await createSignInCode(d);
    expect(await consumeSignInCode(d, code)).toBe(true);
    expect(await consumeSignInCode(d, code)).toBe(false);
    expect(stored(d).codes).toHaveLength(1);
    expect(await consumeSignInCode(d, other.code)).toBe(true);
  });

  it("refuses an expired code and drops it", async () => {
    const d = dir();
    const t = Date.now();
    const { code } = await createSignInCode(d, { now: t });
    expect(await consumeSignInCode(d, code, { now: t + SIGN_IN_TTL_MS + 1 })).toBe(false);
    expect(stored(d).codes).toEqual([]);
    expect(await consumeSignInCode(d, code, { now: t })).toBe(false);
  });

  it("keeps at most MAX_PENDING codes, dropping the oldest", async () => {
    const d = dir();
    const codes = [];
    for (let i = 0; i < MAX_PENDING + 2; i += 1) codes.push((await createSignInCode(d)).code);
    expect(stored(d).codes).toHaveLength(MAX_PENDING);
    expect(await consumeSignInCode(d, codes[0])).toBe(false);
    expect(await consumeSignInCode(d, codes[1])).toBe(false);
    expect(await consumeSignInCode(d, codes.at(-1))).toBe(true);
  });

  it("refuses garbage, and a missing or damaged file", async () => {
    const d = dir();
    for (const bad of [undefined, null, 42, "", "short", "x".repeat(44), "a b".padEnd(43, "c"), { code: "x" }]) expect(await consumeSignInCode(d, bad)).toBe(false);
    expect(await consumeSignInCode(d, "A".repeat(43))).toBe(false);
    writeFileSync(signInPath(d), "{ not json");
    expect(await consumeSignInCode(d, "A".repeat(43))).toBe(false);
    // A damaged file is replaced by the next code.
    const { code } = await createSignInCode(d);
    expect(await consumeSignInCode(d, code)).toBe(true);
  });

  it("creates the data folder when it does not exist yet", async () => {
    const d = join(dir(), "nested", "data");
    const { code } = await createSignInCode(d);
    expect(await consumeSignInCode(d, code)).toBe(true);
  });

  it("never loses a consume to a concurrent create (both take the lock)", async () => {
    const d = dir();
    const first = await createSignInCode(d);
    const [ok] = await Promise.all([consumeSignInCode(d, first.code), createSignInCode(d), createSignInCode(d)]);
    expect(ok).toBe(true);
    expect(await consumeSignInCode(d, first.code)).toBe(false);
    expect(stored(d).codes).toHaveLength(2);
  });

  it("takes over a lock left behind by a crashed process", async () => {
    const d = dir();
    await createSignInCode(d);
    const lock = join(d, ".sign-in-codes.json.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const { code } = await createSignInCode(d);
    expect(await consumeSignInCode(d, code)).toBe(true);
  });
});
