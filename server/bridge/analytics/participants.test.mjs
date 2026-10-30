import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { parseParticipantCsv, participantsRoutes, participantsUrl, productsOf, sentimentOf } from "./participants.mjs";

const HEAD = "Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short,Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short,Option Stock Call Long,Option Stock Put Long,Option Stock Call Short,Option Stock Put Short,Total Long Contracts,Total Short Contracts";
const line = (name, v) => `${name},${v.join(",")},0,0`;
const csv = (k = 1) =>
  [
    "Participant wise Open Interest (no. of contracts) in Futures & Options as on 30-Oct-2026",
    HEAD,
    line("Client", [100, 200, 300, 400, 10, 20, 30, 40, 5, 6, 7, 8].map((x) => x * k)),
    line("DII", [50, 10, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0].map((x) => x * k)),
    line("FII", [900, 100, 1000, 500, 100, 50, 20, 60, 9, 9, 9, 9].map((x) => x * k)),
    line("Pro", [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120].map((x) => x * k)),
    "TOTAL,1,1,1,1,1,1,1,1,1,1,1,1,0,0",
  ].join("\r\n");
const ctx = (qs = "") => ({ requestId: "r1", query: new URLSearchParams(qs) });
// 2026-10-30 is a Friday
const NOW = Date.parse("2026-10-30T20:00:00+05:30");
const setup = (files, extraDeps = {}) => {
  let t = NOW;
  const calls = [];
  const participantsFetcher = async (iso) => {
    calls.push(iso);
    const f = files[iso];
    if (f instanceof Error) throw f;
    return f ?? null;
  };
  const [[, , , h]] = participantsRoutes({ participantsFetcher, clock: { now: () => t }, ...extraDeps });
  return { h, calls, tick: (ms) => (t += ms) };
};
const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("participants", () => {
  it("declares its route and builds the archive URL", () => {
    const [[m, p, o]] = participantsRoutes({ participantsFetcher: async () => null });
    expect([m, p, o]).toEqual(["GET", "/v1/analytics/participants", { scope: "read" }]);
    expect(participantsUrl("2026-10-30")).toBe("https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_30102026.csv");
  });

  it("parses by header name and ignores the TOTAL row", () => {
    const r = parseParticipantCsv(csv());
    expect(Object.keys(r).sort()).toEqual(["Client", "DII", "FII", "Pro"]);
    expect(r.FII.fil).toBe(900);
    expect(r.Pro.sps).toBe(120);
  });

  it("derives long, short, net, ratio and sentiment", () => {
    const fii = parseParticipantCsv(csv()).FII;
    const p = productsOf(fii);
    expect(p.indexFutures).toMatchObject({ long: 900, short: 100, net: 800, longShortRatio: 9, longPct: 90 });
    expect(p.indexOptions.call).toMatchObject({ long: 100, short: 20 });
    expect(sentimentOf(fii).label).toBe("strongly_bullish");
    expect(sentimentOf({ ...fii, fil: 100, fis: 900, icl: 0, ipl: 100, ics: 100, ips: 0 }).label).toBe("strongly_bearish");
    expect(sentimentOf(parseParticipantCsv(csv()).Client).label).toBe("bearish");
  });

  it("rejects a changed shape with UPSTREAM_ERROR", () => {
    expect(() => parseParticipantCsv("<html>blocked</html>")).toThrow(BridgeError);
    expect(() => parseParticipantCsv("Client Type,Foo\nFII,1")).toThrow(/missing expected columns/);
    expect(() => parseParticipantCsv(csv().replace("FII,", "XXX,"))).toThrow(/no row for FII/);
  });

  it("reports sessions with day-on-day change, skipping holidays", async () => {
    // Thu 29 has no file (holiday); Wed 28 and Fri 30 do
    const { h, calls } = setup({ "2026-10-30": csv(1), "2026-10-28": csv(2) });
    const r = await h(ctx("days=2"));
    expect(r.data.sessions.map((s) => s.date)).toEqual(["2026-10-30", "2026-10-28"]);
    expect(r.data.sessions[0].previousDate).toBe("2026-10-28");
    expect(r.data.sessions[0].participants.FII.change.indexFutures).toEqual({ long: -900, short: -100, net: -800 });
    expect(r.data.latest.sentiment.FII).toBe("strongly_bullish");
    expect(r.meta.source).toBe("nse-archives");
    expect(r.meta.notes).toMatch(/unverified/);
    expect(calls.every((d) => !["2026-10-31", "2026-10-25"].includes(d))).toBe(true); // weekends not requested
  });

  it("caches within the TTL and serves stale on refresh failure", async () => {
    const files = { "2026-10-30": csv() };
    const { h, calls, tick } = setup(files);
    await h(ctx("days=1"));
    const n = calls.length;
    await h(ctx("days=1"));
    expect(calls.length).toBe(n);
    tick(3 * 86_400_000);
    files["2026-11-02"] = new BridgeError("UPSTREAM_ERROR", "down");
    const r = await h(ctx("days=1"));
    expect(r.meta.stale).toBe(true);
    expect(r.data.sessions[0].date).toBe("2026-10-30");
  });

  it("surfaces UPSTREAM_ERROR when nothing is cached and the shape is wrong", async () => {
    const { h } = setup({ "2026-10-30": "nonsense" });
    await expect(h(ctx())).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("validates days", async () => {
    const { h } = setup({});
    for (const bad of ["0", "61", "x", "1.5"]) await expect(h(ctx(`days=${bad}`))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("persists history and reloads it; a corrupt file is moved aside", async () => {
    const dir = mkdtempSync(join(tmpdir(), "part-"));
    dirs.push(dir);
    const deps = { paths: { dataDir: dir } };
    await setup({ "2026-10-30": csv() }, deps).h(ctx("days=1"));
    const file = join(dir, "analytics", "participants.json");
    expect(JSON.parse(readFileSync(file, "utf8")).rows[0].date).toBe("2026-10-30");
    const second = setup({}, deps);
    const r = await second.h(ctx("days=1"));
    expect(r.data.sessions[0].date).toBe("2026-10-30");
    writeFileSync(file, "{not json");
    const third = setup({ "2026-10-30": csv() }, deps);
    await third.h(ctx("days=1"));
    expect(readdirSync(join(dir, "analytics")).some((f) => f.includes("corrupt"))).toBe(true);
  });
});
