import { describe, expect, it } from "vitest";
import { freshness } from "./normalise.mjs";
import { isTrustedRealtime, trustedLtp } from "./trusted.mjs";

const NOW = Date.parse("2026-10-19T10:00:00+05:30");
const fresh = (over = {}) => freshness({ source: "broker", at: NOW, now: NOW, targetMs: 2000, ...over });
const item = (f, ltp = 100) => ({ symbol: "NSE:X", ltp, freshness: f });

describe("trusted real-time values", () => {
  it("accepts what the market service labels for a broker, the stream, the cache within its target and the paper engine", () => {
    for (const source of ["broker", "stream", "cache", "paper"]) {
      expect(isTrustedRealtime(item(fresh({ source })))).toBe(true);
      expect(trustedLtp(item(fresh({ source })))).toBe(100);
    }
  });

  it("refuses everything the service labels as not current, not real-time, not official or from a source", () => {
    const cases = {
      "a stale cached value": fresh({ source: "cache", at: NOW - 60_000, stale: true }),
      "a stale-forced value": fresh({ stale: true }),
      "a revalidating value": { ...fresh(), revalidating: true },
      "a delayed backup source": fresh({ source: "backup", class: "delayed", delaySec: 900, official: false, confidence: "low" }),
      "an end-of-day backup source": fresh({ source: "backup", class: "eod", official: true }),
      "an unofficial value": fresh({ official: false }),
      "a plugin value": fresh({ source: "backup", class: "delayed", delaySec: 60, official: false, flags: ["plugin", "unofficial", "delayed"] }),
      "a backup answer claiming realtime": fresh({ source: "backup", class: "realtime", official: true, confidence: "high" }),
      "an untrusted source flag": fresh({ flags: ["untrusted_source"] }),
    };
    for (const [name, f] of Object.entries(cases)) {
      expect(isTrustedRealtime(item(f)), name).toBe(false);
      expect(trustedLtp(item(f)), name).toBeNull();
    }
  });

  it("fails closed: no label, a label without a class, or a bad price is not trusted", () => {
    expect(isTrustedRealtime(undefined)).toBe(false);
    expect(isTrustedRealtime({ symbol: "NSE:X", ltp: 1 })).toBe(false);
    expect(isTrustedRealtime({ symbol: "NSE:X", ltp: 1, freshness: { source: "broker", stale: false } })).toBe(false);
    for (const bad of [0, -1, NaN, Infinity, "100", null]) expect(trustedLtp(item(fresh(), bad))).toBeNull();
    expect(trustedLtp({ symbol: "NSE:X", freshness: fresh() })).toBeNull();
  });
});
