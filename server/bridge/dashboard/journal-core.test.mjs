import { describe, expect, it } from "vitest";
import { buildTrades, cleanTags, csvCell, journalCsv, maxDrawdown, mergeDaily, monthGrid, parseContract, shiftMonth, statsOf, tradeStats } from "./journal-core.js";

const CE = "NFO:NIFTY-2026-11-03-26800-CE";
const PE = "NFO:NIFTY-2026-11-03-25800-PE";
const CE2 = "NFO:NIFTY-2026-11-10-26800-CE";
const f = (symbol, side, qty, price, at, extra = {}) => ({ accountId: "demo-paper", symbol, side, qty, price, charges: 20, tradedAt: `2026-10-${at}+05:30`, ...extra });

describe("contracts", () => {
  it("reads options, futures and equity symbols", () => {
    expect(parseContract(CE)).toMatchObject({ underlying: "NIFTY", expiry: "2026-11-03", kind: "OPT", strike: 26800, right: "CE" });
    expect(parseContract("NFO:BANKNIFTY-2026-11-24-FUT")).toMatchObject({ underlying: "BANKNIFTY", kind: "FUT" });
    expect(parseContract("NSE:RELIANCE")).toMatchObject({ underlying: "RELIANCE", kind: "EQ", expiry: null });
  });
});

describe("fills into trades", () => {
  const fills = [
    f(CE, "SELL", 65, 100, "27T09:30:00"),
    f(PE, "SELL", 65, 90, "27T09:30:05"),
    f(CE, "BUY", 65, 40, "29T14:00:00"),
    f(PE, "BUY", 65, 30, "29T14:00:05"),
    // A new trade in the same group after it went flat, still open.
    f(CE, "SELL", 65, 50, "30T10:00:00"),
    // A roll into the next expiry opens a separate group.
    f(CE2, "SELL", 65, 120, "30T10:05:00", { charges: 0 }),
  ];
  const trades = buildTrades(fills, { marks: { [CE]: 45 }, notes: {} });

  it("closes a strategy group when every leg is flat, with P&L after charges", () => {
    const closed = trades.find((t) => t.status === "closed");
    expect(closed).toMatchObject({ underlying: "NIFTY", expiry: "2026-11-03", structure: "Short strangle", fills: 4, charges: 80 });
    expect(closed.pnl).toBe((100 + 90 - 40 - 30) * 65 - 80);
    expect(closed.legs.map((l) => l.q)).toEqual([-65, -65]);
  });

  it("keeps later fills as a new open trade marked to the last price; unpriced legs give no P&L", () => {
    const open = trades.filter((t) => t.status === "open");
    expect(open).toHaveLength(2);
    const near = open.find((t) => t.expiry === "2026-11-03");
    expect(near.pnl).toBe(65 * (50 - 45) - 20);
    expect(open.find((t) => t.expiry === "2026-11-10").pnl).toBeNull();
    // Newest first.
    expect(trades[0].status).toBe("open");
  });

  it("ids are stable and notes attach by id", () => {
    const again = buildTrades(fills, { notes: { [trades.at(-1).id]: { tags: ["weekly"], notes: "Held through RBI", setup: "IV rank high" } } });
    expect(again.map((t) => t.id)).toEqual(trades.map((t) => t.id));
    expect(again.at(-1)).toMatchObject({ tags: ["weekly"], notes: "Held through RBI", setup: "IV rank high" });
  });

  it("drops malformed fills", () => {
    expect(buildTrades([{ symbol: CE, side: "HOLD", qty: 1, price: 1, tradedAt: "2026-10-27T09:30:00+05:30" }, { symbol: CE, side: "BUY", qty: 0, price: 1, tradedAt: "x" }])).toEqual([]);
  });
});

describe("stats", () => {
  const t = (pnl, day, tags = [], structure = "Short strangle") => ({ status: "closed", pnl, closedAt: Date.parse(`2026-10-${day}T15:00:00+05:30`), tags, structure, setup: "", underlying: "NIFTY" });
  const trades = [t(1000, "01", ["weekly"]), t(-500, "02", ["weekly", "event"]), t(2000, "03"), t(-1500, "06", [], "Iron condor"), t(800, "07", ["event"], "Iron condor")];

  it("win rate with its sample size, average win and loss, expectancy and drawdown", () => {
    const s = statsOf(trades);
    expect(s).toMatchObject({ n: 5, wins: 3, losses: 2, winRate: 60, avgWin: (1000 + 2000 + 800) / 3, avgLoss: (-500 - 1500) / 2, total: 1800, best: 2000, worst: -1500 });
    expect(s.expectancy).toBeCloseTo(360, 6);
    // Running total 1000, 500, 2500, 1000, 1800: the high is 2500, the low after it 1000.
    expect(s.maxDrawdown).toBe(1500);
    expect(maxDrawdown([-100, -50])).toBe(150);
    expect(statsOf([]).winRate).toBeNull();
  });

  it("per tag (a trade counts under each tag), per structure and per setup", () => {
    const byTag = Object.fromEntries(tradeStats(trades, "tag").map((r) => [r.key, r.n]));
    expect(byTag).toEqual({ weekly: 2, event: 2, Untagged: 2 });
    const byS = tradeStats(trades, "structure");
    expect(byS.map((r) => [r.key, r.n, r.total])).toEqual([["Short strangle", 3, 2500], ["Iron condor", 2, -700]]);
    expect(tradeStats(trades, "setup")[0].key).toBe("No setup");
    expect(tradeStats([{ status: "open", pnl: 5 }], "structure")).toEqual([]);
  });
});

describe("calendar", () => {
  it("sums accounts per day and lays a month out Monday first", () => {
    const daily = mergeDaily([[{ day: "2026-10-01", pnl: 1000 }, { day: "2026-10-30", pnl: -400 }], [{ day: "2026-10-01", pnl: 500 }, { day: "bad", pnl: 1 }]]);
    expect(daily).toEqual([{ day: "2026-10-01", pnl: 1500, accounts: 2 }, { day: "2026-10-30", pnl: -400, accounts: 1 }]);
    const g = monthGrid(daily, "2026-10");
    // 1 October 2026 is a Thursday: the first row starts on Monday 28 September.
    expect(g.weeks[0][0]).toMatchObject({ day: "2026-09-28", inMonth: false, pnl: null });
    expect(g.weeks[0][3]).toMatchObject({ day: "2026-10-01", inMonth: true, pnl: 1500 });
    expect(g.weeks).toHaveLength(5);
    expect(g).toMatchObject({ total: 1100, days: 2, green: 1, red: 1, best: 1500, worst: -400, scale: 1500 });
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});

describe("CSV and tags", () => {
  it("quotes, guards formulas and writes one row per trade", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(-1234.567)).toBe("-1234.57");
    const csv = journalCsv(buildTrades([f(CE, "SELL", 65, 100, "27T09:30:00"), f(CE, "BUY", 65, 40, "28T09:30:00")], { notes: {} }));
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Opened \(IST\),Closed \(IST\),Account/);
    expect(lines[1]).toContain("2026-10-27 09:30,2026-10-28 09:30,demo-paper,paper,NIFTY,2026-11-03,Short call,closed");
  });

  it("cleans tags", () => {
    expect(cleanTags([" weekly ", "Weekly", "", "a very long tag that goes on and on"])).toEqual(["weekly", "a very long tag that goe"]);
    expect(cleanTags("event, trend")).toEqual(["event", "trend"]);
  });
});
