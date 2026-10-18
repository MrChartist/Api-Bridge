/** S8 IST helpers. */
import { describe, expect, it } from "vitest";
import { istDay, istDayCompact, istTimeOnDay, toIstIso } from "./time.mjs";

describe("IST helpers", () => {
  it("maps instants to IST days across UTC midnight", () => {
    expect(istDay(Date.parse("2026-10-18T18:29:59Z"))).toBe("2026-10-18");
    expect(istDay(Date.parse("2026-10-18T18:30:00Z"))).toBe("2026-10-19");
    expect(istDayCompact(Date.parse("2026-10-19T10:00:00+05:30"))).toBe("20261019");
  });

  it("finds HH:MM IST on the same IST day", () => {
    const t = Date.parse("2026-10-19T00:10:00+05:30");
    expect(istTimeOnDay(t, "15:20")).toBe(Date.parse("2026-10-19T15:20:00+05:30"));
    expect(istTimeOnDay(Date.parse("2026-10-19T23:59:00+05:30"), "09:15")).toBe(Date.parse("2026-10-19T09:15:00+05:30"));
    expect(() => istTimeOnDay(t, "3pm")).toThrow();
  });

  it("formats with the +05:30 offset", () => {
    expect(toIstIso(Date.parse("2026-10-19T04:30:00Z"))).toBe("2026-10-19T10:00:00.000+05:30");
  });
});
