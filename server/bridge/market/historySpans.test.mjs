/**
 * Per-broker history spans: the figures each adapter documents in its manifest (capabilities.historical), and how
 * historySpanDays turns them into days per request. Only brokers whose own page or release note was read declare spans.
 */
import { describe, expect, it } from "vitest";
import * as angelone from "../../brokers/angelone.mjs";
import * as dhan from "../../brokers/dhan.mjs";
import * as upstox from "../../brokers/upstox.mjs";
import * as zerodha from "../../brokers/zerodha.mjs";
import { historySpanDays, sessionMinutes } from "./history.mjs";

const DEFAULTS = { intraday: 60, daily: 2000 };
const at = (iso) => Date.parse(iso);

describe("the manifests", () => {
  it("Upstox: minutes 1-15 one month, above 15 and hours one quarter, days a decade", () => {
    expect(upstox.capabilities.historical.maxSpanDays).toEqual({ "1m": 30, "3m": 30, "5m": 30, "15m": 30, "30m": 90, "60m": 90, "1d": 3650 });
  });

  it("Angel One: the documented days per interval and the 8000-record cap of one-minute data", () => {
    expect(angelone.capabilities.historical.maxSpanDays).toEqual({ "1m": 30, "3m": 60, "5m": 100, "15m": 200, "30m": 200, "60m": 400, "1d": 2000 });
    expect(angelone.capabilities.historical.maxRecords).toEqual({ "1m": 8000 });
  });

  it("Dhan: 90 days at once for intraday", () => {
    expect(dhan.capabilities.historical.maxSpanDays).toEqual({ "1m": 90, "5m": 90, "15m": 90, "60m": 90 });
  });

  it("Zerodha declares no span: its own docs state none, the default applies", () => {
    expect(zerodha.capabilities.historical.maxSpanDays).toBeUndefined();
  });

  it("every declared figure names an interval the adapter offers, and says where and when it was read", () => {
    for (const a of [upstox, angelone, dhan]) {
      const h = a.capabilities.historical;
      for (const k of [...Object.keys(h.maxSpanDays ?? {}), ...Object.keys(h.maxRecords ?? {})]) expect(h.intervals, `${a.id} ${k}`).toContain(k);
      expect(h.limitsSource.url, a.id).toMatch(/^https?:\/\//);
      expect(h.limitsSource.readOn, a.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("historySpanDays", () => {
  const up = upstox.capabilities.historical;
  const ang = angelone.capabilities.historical;
  const span = (base, manifest, extra = {}) => historySpanDays({ base, defaults: DEFAULTS, manifest, exchange: "NSE", ms: at("2026-11-10T10:00:00+05:30"), ...extra });

  it("a broker with no documented span gets the default", () => {
    expect(span("5m", null)).toBe(60);
    expect(span("1d", {})).toBe(2000);
  });

  it("the manifest lowers the default, never raises it", () => {
    expect(span("5m", up)).toBe(30);
    expect(span("60m", up)).toBe(60); // the quarter (90) is above the default (60)
    expect(span("1d", up)).toBe(2000); // a decade is above the default
    expect(span("1m", dhan.capabilities.historical)).toBe(60);
  });

  it("an explicit per-broker span from the config wins over the manifest", () => {
    expect(span("5m", up, { override: 90 })).toBe(90);
  });

  it("a record cap turns into whole trading days: 8000 records of a 375-minute session is 21 trading days, 29 calendar days", () => {
    expect(span("1m", ang)).toBe(29);
    // A derivatives session is 385 minutes from 3 Aug 2026: 20 trading days, 28 calendar days.
    expect(span("1m", ang, { exchange: "NFO" })).toBe(28);
    // 390 minutes from 7 Dec 2026: 20 trading days, 28 calendar days.
    expect(span("1m", ang, { exchange: "NFO", ms: at("2026-12-08T10:00:00+05:30") })).toBe(28);
    // The cap only applies to the interval it was documented for.
    expect(span("5m", ang)).toBe(60);
  });

  it("session length follows the dated rules: derivatives 385 minutes from 3 Aug 2026, 390 from 7 Dec; cash 375 throughout", () => {
    expect(sessionMinutes("NFO", at("2026-07-30T10:00:00+05:30"))).toBe(375);
    expect(sessionMinutes("NFO", at("2026-11-10T10:00:00+05:30"))).toBe(385);
    expect(sessionMinutes("BFO", at("2026-12-08T10:00:00+05:30"))).toBe(390);
    expect(sessionMinutes("NSE", at("2026-12-08T10:00:00+05:30"))).toBe(375);
    // A special session has its own length (Muhurat 2026-11-08: 14:20 to 15:30).
    expect(sessionMinutes("NSE", at("2026-11-08T14:30:00+05:30"))).toBe(70);
  });
});
