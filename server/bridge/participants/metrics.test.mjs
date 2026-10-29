import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSummary, cell, csvRows, headline, longPct, lotRegimeOn, publishedNote, round2, seriesFor, summaryTable } from "./metrics.mjs";
import { parseParticipantOi } from "./parser.mjs";

const parsed = parseParticipantOi(readFileSync(resolve(import.meta.dirname, "__fixtures__/fao_participant_oi_28102026.csv"), "utf8"), { date: "2026-10-28" });
const day = { date: "2026-10-28", rows: parsed.rows, quality: parsed.quality, lotRegime: "2026-01" };
// Previous day (§7.10): FII index futures long 1,18,900 and short 2,39,905.
const prev = { date: "2026-10-27", rows: structuredClone(parsed.rows), quality: "ok" };
prev.rows.FII.IDX_FUT = [118900, 239905];

describe("participant metrics (§7.10 worked example)", () => {
  it("FII index futures: long %, Δ pts, net, Δ net and shares", () => {
    const c = cell(day, prev, "FII", "IDX_FUT");
    expect(c.longPct).toBe(31.1);
    expect(c.longPctChange).toBe(-2.04);
    expect(c.net).toBe(-136570);
    expect(c.netChange).toBe(-15565);
    expect(c.shareOfLong).toBe(27.43);
    expect(c.shareOfShort).toBe(60.79);
  });

  it("index option nets", () => {
    expect(cell(day, prev, "CLIENT", "IDX_CE").net).toBe(430000);
    expect(cell(day, prev, "FII", "IDX_CE").net).toBe(-80000);
    expect(cell(day, prev, "FII", "IDX_PE").net).toBe(90000);
  });

  it("previous day long % is 33.14 and the TOTAL row is balanced", () => {
    expect(longPct(118900, 239905)).toBe(33.14);
    const t = cell(day, null, "TOTAL", "IDX_FUT");
    expect(t.long).toBe(409490);
    expect(t.short).toBe(409490);
    expect(t.net).toBe(0);
    expect(t.netChange).toBeNull();
    expect(t.longPct).toBe(50);
  });

  it("long % is null for an empty position, and rounding is half-up", () => {
    expect(longPct(0, 0)).toBeNull();
    expect(round2(31.095)).toBe(31.1);
    expect(round2(-2.045)).toBe(-2.05);
  });

  it("the table has 5 participants × 6 instruments", () => {
    const t = summaryTable(day, prev);
    expect(t).toHaveLength(30);
    expect(t[0]).toMatchObject({ participant: "CLIENT", instrument: "IDX_FUT" });
  });

  it("headline and the summary body", () => {
    const h = headline(day, prev);
    expect(h).toMatchObject({ fiiIndexFutLongPct: 31.1, fiiIndexFutLongPctChange: -2.04, fiiIndexFutNet: -136570, fiiIndexFutNetChange: -15565 });
    expect(h.clientIndexCall).toEqual({ net: 430000, netChange: 0 });
    expect(h.formula).toMatch(/FII long ÷ \(FII long \+ FII short\) × 100/);
    const s = buildSummary({ day, prev, history: [prev, day], revisions: [{ date: "2026-01-01", text: "x" }, { date: "2026-10-28", text: "y" }] });
    expect(s).toMatchObject({ date: "2026-10-28", previousDate: "2026-10-27", exchange: "NSE", unit: "contracts", quality: "ok", lotRegime: "2026-01" });
    expect(s.publishedNote).toBe("NSE only. Summed over all strikes and expiries. Number of contracts, for the trading day ended 28 Oct 2026.");
    expect(s.history.fiiIndexFutLongPct).toEqual([{ date: "2026-10-27", value: 33.14 }, { date: "2026-10-28", value: 31.1 }]);
    expect(s.revisions).toEqual([{ date: "2026-10-28", text: "y" }]);
  });

  it("series, lot regimes and CSV", () => {
    expect(seriesFor([prev, day], "fiiIndexFutNet")).toEqual([{ date: "2026-10-27", value: -121005 }, { date: "2026-10-28", value: -136570 }]);
    expect(() => seriesFor([day], "nope")).toThrow();
    const rev = [{ date: "2024-11-20", regime: "2024-11" }, { date: "2026-01-01", regime: "2026-01" }];
    expect(lotRegimeOn("2024-01-02", rev)).toBe("pre-2024-11");
    expect(lotRegimeOn("2025-06-02", rev)).toBe("2024-11");
    expect(lotRegimeOn("2026-01-01", rev)).toBe("2026-01");
    const rows = csvRows([day], { participants: ["FII"], instruments: ["IDX_FUT"] });
    expect(rows).toEqual([
      ["date", "exchange", "participant", "instrument", "long", "short", "net", "long_pct", "unit", "quality", "lot_regime"],
      ["2026-10-28", "NSE", "FII", "IDX_FUT", 112340, 248910, -136570, 31.1, "contracts", "ok", "2026-01"],
    ]);
    expect(publishedNote("2026-01-05")).toMatch(/5 Jan 2026\.$/);
  });
});
