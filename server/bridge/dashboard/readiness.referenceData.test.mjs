import { describe, expect, it } from "vitest";
import { referenceDataModel } from "./readiness.js";

describe("Safety page: market reference data", () => {
  it("says nothing when the Bridge sent nothing", () => {
    expect(referenceDataModel(null)).toBeNull();
    expect(referenceDataModel({ accounts: [] })).toBeNull();
  });

  it("current data is one plain line", () => {
    const m = referenceDataModel({ referenceData: { level: "ok", items: [{ level: "ok", message: "x" }] } });
    expect(m).toMatchObject({ tone: "ok", summary: "Up to date", lines: [] });
  });

  it("each out-of-date item becomes a sentence, with a count in the summary", () => {
    const m = referenceDataModel({
      referenceData: {
        level: "warn",
        items: [
          { level: "warn", message: "The holiday calendar has no rows for 2027 yet.", fix: "Update the file at the next release." },
          { level: "ok", message: "Session hours: as of 2026-11-10." },
          { level: "warn", message: "Statutory charges: as of 2026-02-28 (8 months ago)." },
        ],
      },
    });
    expect(m.tone).toBe("warn");
    expect(m.summary).toBe("2 things need a check");
    expect(m.lines.map((l) => l.text)).toEqual(["The holiday calendar has no rows for 2027 yet.", "Statutory charges: as of 2026-02-28 (8 months ago)."]);
    expect(referenceDataModel({ referenceData: { items: [{ level: "warn", message: "m" }] } }).summary).toBe("1 thing needs a check");
  });
});
