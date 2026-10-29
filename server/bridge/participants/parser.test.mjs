import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ParticipantParseError, headerMeaning, parseCount, parseParticipantOi, parseTitleDate, participantOf, validateTotals } from "./parser.mjs";

const fx = (name) => readFileSync(resolve(import.meta.dirname, "__fixtures__", name), "utf8");

describe("participants parser (§7.11)", () => {
  it("parses the published layout with the title line", () => {
    const r = parseParticipantOi(fx("fao_participant_oi_28102026.csv"), { date: "2026-10-28" });
    expect(r.date).toBe("2026-10-28");
    expect(r.quality).toBe("ok");
    expect(r.rows.FII.IDX_FUT).toEqual([112340, 248910]);
    expect(r.rows.CLIENT.IDX_CE).toEqual([1520000, 1090000]);
    expect(r.rows.PRO.IDX_PE).toEqual([520000, 840000]);
    expect(r.rows.TOTAL.IDX_FUT).toEqual([409490, 409490]);
    expect(r.rows.DII.STK_FUT).toEqual([60000, 650000]);
    expect(r.warnings).toEqual([]);
  });

  it("checks the title date against the requested date", () => {
    expect(() => parseParticipantOi(fx("fao_participant_oi_28102026.csv"), { date: "2026-10-27" })).toThrow(/date mismatch/);
    try {
      parseParticipantOi(fx("fao_participant_oi_28102026.csv"), { date: "2026-10-27" });
    } catch (err) {
      expect(err).toBeInstanceOf(ParticipantParseError);
      expect(err.code).toBe("PARSE_FAILED");
    }
  });

  it("reads quoted Indian-comma numbers, blank lines and trailing spaces", () => {
    const r = parseParticipantOi(fx("fao_participant_oi_28102026_extra-blank-lines.csv"), { date: "2026-10-28" });
    expect(r.quality).toBe("ok");
    expect(r.rows.CLIENT.IDX_CE).toEqual([1520000, 1090000]);
    expect(r.rows.TOTAL.STK_FUT).toEqual([2100000, 2100000]);
  });

  it("reads the older abbreviated header without a title line", () => {
    const r = parseParticipantOi(fx("fao_participant_oi_28102026_old-header.csv"), { date: "2026-10-28" });
    expect(r.date).toBe("2026-10-28");
    expect(r.quality).toBe("ok");
    expect(r.rows.FII.IDX_FUT).toEqual([112340, 248910]);
    expect(r.warnings.join(" ")).toMatch(/No title line/);
  });

  it("flags totals that do not add up and keeps the numbers as published", () => {
    const r = parseParticipantOi(fx("fao_participant_oi_28102026_bad-totals.csv"), { date: "2026-10-28" });
    expect(r.quality).toBe("totals-mismatch");
    expect(r.mismatches).toEqual(["IDX_CE"]);
    expect(r.rows.FII.IDX_CE).toEqual([180500, 260000]);
  });

  it("a missing participant row is partial", () => {
    const text = fx("fao_participant_oi_28102026.csv").split("\r\n").filter((l) => !l.startsWith("DII")).join("\r\n");
    const r = parseParticipantOi(text, { date: "2026-10-28" });
    expect(r.quality).toBe("partial");
    expect(r.missing).toEqual(["DII"]);
  });

  it("an HTML page, an empty body or a header without columns fails with PARSE_FAILED", () => {
    expect(() => parseParticipantOi("<!doctype html><html><body>Access denied</body></html>")).toThrow(ParticipantParseError);
    expect(() => parseParticipantOi("")).toThrow(/empty/);
    expect(() => parseParticipantOi("Client Type,Future Index Long,Future Index Short,a,b\nClient,1,2,3,4\n")).toThrow(/lacks/);
    expect(() => parseParticipantOi("a,b,c\n1,2,3\n")).toThrow(/header/);
  });

  it("rejects non-numeric cells", () => {
    const text = fx("fao_participant_oi_28102026.csv").replace("180600", "18O600");
    expect(() => parseParticipantOi(text, { date: "2026-10-28" })).toThrow(/not a whole number/);
  });

  it("helpers: header words, participant names, counts and title dates", () => {
    expect(headerMeaning("Future Index Long")).toEqual({ instrument: "IDX_FUT", side: "long" });
    expect(headerMeaning("Option Stock Put Short")).toEqual({ instrument: "STK_PE", side: "short" });
    expect(headerMeaning("Opt Idx Call Long")).toEqual({ instrument: "IDX_CE", side: "long" });
    expect(headerMeaning("Total Long Contracts")).toEqual({ total: "long" });
    expect(headerMeaning("Client Type")).toEqual({ participant: true });
    expect(headerMeaning("Something")).toBeNull();
    expect(participantOf(" Pro ")).toBe("PRO");
    expect(participantOf("FPI")).toBe("FII");
    expect(participantOf("TOTAL")).toBe("TOTAL");
    expect(participantOf("Others")).toBeNull();
    expect(parseCount("1,52,000")).toBe(152000);
    expect(parseCount(" 152,000 ")).toBe(152000);
    expect(parseCount("-5")).toBeNaN();
    expect(parseTitleDate("as on Oct 28, 2026")).toBe("2026-10-28");
    expect(parseTitleDate("as on 28-Oct-2026")).toBe("2026-10-28");
    expect(parseTitleDate("as on 2 January 2025")).toBe("2025-01-02");
    expect(parseTitleDate("as on 28/10/2026")).toBe("2026-10-28");
    expect(parseTitleDate("no date")).toBeNull();
  });

  it("validateTotals also requires long = short in the TOTAL row", () => {
    const zero = () => Object.fromEntries(["IDX_FUT", "IDX_CE", "IDX_PE", "STK_FUT", "STK_CE", "STK_PE"].map((x) => [x, [0, 0]]));
    const rows = { CLIENT: zero(), DII: zero(), FII: zero(), PRO: zero(), TOTAL: zero() };
    rows.CLIENT.IDX_FUT = [5, 4];
    rows.TOTAL.IDX_FUT = [5, 4];
    expect(validateTotals(rows)).toEqual({ quality: "totals-mismatch", mismatches: ["IDX_FUT"], missing: [] });
  });
});
