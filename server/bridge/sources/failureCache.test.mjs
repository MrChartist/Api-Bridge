/**
 * Failure cache and the facade registry view, under a fake clock.
 */
import { describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { FAILURE_TTL, createFailureCache, failureTtlMs } from "./failureCache.mjs";
import { LEGACY_SOURCE_ID, createFacadeRegistry } from "./facadeRegistry.mjs";

function setup(random = () => 0.5) {
  let t = 1_000_000;
  const clock = { now: () => t };
  return { cache: createFailureCache({ clock, random }), advance: (ms) => (t += ms), now: () => t };
}
const err = (code, detail = "nope") => new BridgeError(code, detail);

describe("failure cache", () => {
  it("remembers an upstream error for 2 s, with +-25% jitter from the injected random", () => {
    const mid = setup(() => 0.5);
    expect(mid.cache.note("z1", "quote", "NSE:A", err("UPSTREAM_ERROR"))).toBe(true);
    mid.advance(1999);
    expect(mid.cache.get("z1", "quote", "NSE:A")).toMatchObject({ code: "UPSTREAM_ERROR", message: "nope" });
    mid.advance(1);
    expect(mid.cache.get("z1", "quote", "NSE:A")).toBeNull();

    const lo = setup(() => 0);
    lo.cache.note("z1", "quote", "x", err("UPSTREAM_TIMEOUT"));
    lo.advance(1499);
    expect(lo.cache.get("z1", "quote", "x")).not.toBeNull();
    lo.advance(1);
    expect(lo.cache.get("z1", "quote", "x")).toBeNull();

    const hi = setup(() => 1);
    hi.cache.note("z1", "quote", "x", err("BROKER_UNAVAILABLE"));
    hi.advance(2499);
    expect(hi.cache.get("z1", "quote", "x")).not.toBeNull();
    hi.advance(1);
    expect(hi.cache.get("z1", "quote", "x")).toBeNull();
  });

  it("remembers not-found for 10 minutes and unsupported for 60 minutes", () => {
    const { cache, advance } = setup();
    cache.note("z1", "quote", "A", err("SYMBOL_NOT_FOUND"));
    cache.note("z1", "quote", "B", err("CAPABILITY_UNSUPPORTED"));
    advance(599_999);
    expect(cache.get("z1", "quote", "A")).not.toBeNull();
    advance(1);
    expect(cache.get("z1", "quote", "A")).toBeNull();
    expect(cache.get("z1", "quote", "B")).not.toBeNull();
    advance(2_999_999);
    expect(cache.get("z1", "quote", "B")).not.toBeNull();
    advance(1);
    expect(cache.get("z1", "quote", "B")).toBeNull();
  });

  it("never remembers a 429, an auth problem, a validation error or a caller that went away", () => {
    const { cache } = setup();
    for (const e of [err("UPSTREAM_RATE_LIMITED"), err("RATE_LIMITED"), err("SESSION_EXPIRED"), err("VALIDATION_FAILED"), Object.assign(new Error("x"), { name: "AbortError" }), new Error("plain"), null]) {
      expect(cache.note("z1", "quote", "A", e)).toBe(false);
    }
    expect(cache.size()).toBe(0);
    expect(failureTtlMs(err("UPSTREAM_RATE_LIMITED"))).toBe(0);
    expect(failureTtlMs(err("UPSTREAM_ERROR"))).toBe(FAILURE_TTL.upstreamMs);
  });

  it("keys by source, kind and key", () => {
    const { cache } = setup();
    cache.note("z1", "quote", "A", err("UPSTREAM_ERROR"));
    expect(cache.get("z1", "ltp", "A")).toBeNull();
    expect(cache.get("z2", "quote", "A")).toBeNull();
    expect(cache.get("z1", "quote", "B")).toBeNull();
    expect(cache.get("z1", "quote", "A")).not.toBeNull();
  });

  it("clear forgets one entry, or everything for a source", () => {
    const { cache } = setup();
    cache.note("z1", "quote", "A", err("UPSTREAM_ERROR"));
    cache.note("z1", "history", "A", err("UPSTREAM_ERROR"));
    cache.note("z2", "quote", "A", err("UPSTREAM_ERROR"));
    cache.clear("z1", "quote", "A");
    expect(cache.get("z1", "quote", "A")).toBeNull();
    expect(cache.get("z1", "history", "A")).not.toBeNull();
    cache.clear("z1");
    expect(cache.get("z1", "history", "A")).toBeNull();
    expect(cache.get("z2", "quote", "A")).not.toBeNull();
  });

  it("is bounded: the oldest entries go first", () => {
    const t = 0;
    const cache = createFailureCache({ clock: { now: () => t }, maxEntries: 3 });
    for (const k of ["a", "b", "c", "d"]) cache.note("s", "quote", k, err("SYMBOL_NOT_FOUND"));
    expect(cache.size()).toBe(3);
    expect(cache.get("s", "quote", "a")).toBeNull();
    expect(cache.get("s", "quote", "d")).not.toBeNull();
  });

  it("truncates a very long message and works with the real clock", () => {
    const cache = createFailureCache();
    cache.note("s", "quote", "k", err("SYMBOL_NOT_FOUND", "x".repeat(5000)));
    expect(cache.get("s", "quote", "k").message.length).toBe(500);
  });
});

describe("facade registry", () => {
  const clock = (() => {
    let t = 0;
    return { now: () => t, advance: (ms) => (t += ms) };
  })();

  it("a bare facade shows one delayed, unofficial pseudo-source", () => {
    const reg = createFacadeRegistry({ backup: { quotes() {} }, clock });
    const rows = reg.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].descriptor).toMatchObject({ id: LEGACY_SOURCE_ID, class: "delayed", delaySec: 900, official: false, kind: "free" });
    expect(rows[0].enabled).toBe(true);
    expect(reg.isEnabled(LEGACY_SOURCE_ID)).toBe(true);
    expect(reg.get("backup").descriptor.id).toBe("backup");
    expect(reg.get("zzz")).toBeNull();
  });

  it("no facade, no sources", () => {
    expect(createFacadeRegistry({ backup: undefined, clock }).list()).toEqual([]);
    expect(createFacadeRegistry({ backup: { quotes() {} }, clock, usable: () => false }).list()).toEqual([]);
  });

  it("a facade with a management list() shows its rows; a keyless one that needs a key is off", () => {
    const rows = [
      { id: "a", name: "A", kind: "free", tier: "byok", enabled: true, configured: true, needsKey: true, class: "eod", official: false, capabilities: ["history"], limits: { perDay: 25 }, terms: { url: "https://x.test", note: "n" } },
      { id: "b", enabled: true, configured: false, needsKey: true, class: "delayed", delaySec: 900, capabilities: ["quotes"] },
      { id: "c", enabled: false, class: "delayed", delaySec: 900, capabilities: ["quotes"] },
      { notAnId: true },
    ];
    const reg = createFacadeRegistry({ backup: { list: () => rows }, clock });
    const out = reg.list();
    expect(out.map((r) => [r.descriptor.id, r.enabled])).toEqual([["a", true], ["b", false], ["c", false]]);
    expect(out[0].descriptor).toMatchObject({ name: "A", class: "eod", tier: "byok", official: false, terms: { url: "https://x.test" } });
    expect(out[1].descriptor.name).toBe("b");
  });

  it("caches for a second, then looks again", () => {
    let calls = 0;
    const reg = createFacadeRegistry({ backup: { list: () => (calls += 1, [{ id: "a", enabled: true, class: "delayed", delaySec: 900, capabilities: ["quotes"] }]) }, clock });
    reg.list();
    reg.list();
    expect(calls).toBe(1);
    clock.advance(1000);
    reg.list();
    expect(calls).toBe(2);
  });

  it("a management list() that throws or does not answer with an array means nothing is on (never the pseudo-source)", () => {
    const throwing = createFacadeRegistry({ backup: { list: () => { throw new Error("boom"); }, quotes() {} }, clock: { now: () => 99_999 } });
    expect(throwing.list()).toEqual([]);
    const asyncList = createFacadeRegistry({ backup: { list: async () => [], quotes() {} }, clock: { now: () => 199_999 } });
    expect(asyncList.list()).toEqual([]);
  });
});
