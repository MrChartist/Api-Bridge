import { describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { fromStoreDay, parseParticipantCsv, participantsRoutes, participantsUrl, productsOf, sentimentOf } from "./participants.mjs";

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
/** Our store's day shape (participants/ series): { date, rows: { FII: { IDX_FUT: [long, short], ... } } }. */
const KEYMAP = { IDX_FUT: ["fil", "fis"], IDX_CE: ["icl", "ics"], IDX_PE: ["ipl", "ips"], STK_FUT: ["sfl", "sfs"], STK_CE: ["scl", "scs"], STK_PE: ["spl", "sps"] };
const storeDay = (date, k = 1) => {
  const raw = parseParticipantCsv(csv(k));
  const rows = {};
  for (const [store, name] of [["FII", "FII"], ["DII", "DII"], ["PRO", "Pro"], ["CLIENT", "Client"]]) rows[store] = Object.fromEntries(Object.entries(KEYMAP).map(([x, [l, sh]]) => [x, [raw[name][l], raw[name][sh]]]));
  return { date, rows };
};
const setup = (days) => {
  const asked = [];
  const participants = { series: (q) => (asked.push(q), days) };
  const [[, , , h]] = participantsRoutes({ participants });
  return { h, asked };
};

describe("participants", () => {
  it("declares its route and builds the archive URL", () => {
    const [[m, p, o]] = participantsRoutes({ participants: { series: () => [] } });
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

  it("is an alias over the participant OI store: sessions newest first with day-on-day change", async () => {
    const { h } = setup([storeDay("2026-10-28", 2), storeDay("2026-10-30", 1)]);
    const r = await h(ctx("days=5"));
    expect(r.data.sessions.map((s) => s.date)).toEqual(["2026-10-30", "2026-10-28"]);
    expect(r.data.sessions[0].previousDate).toBe("2026-10-28");
    expect(r.data.sessions[0].participants.FII.indexFutures).toMatchObject({ long: 900, short: 100 });
    expect(r.data.sessions[0].participants.FII.change.indexFutures).toMatchObject({ long: -900, short: -100 });
    expect(r.data.sessions[1].participants.FII.change).toBeNull();
    expect(r.data.latest).toMatchObject({ date: "2026-10-30" });
    expect(r.meta).toMatchObject({ source: "participants-store", aliasOf: "/v1/participants/oi", available: 2 });
  });

  it("maps the store's rows and skips a day with a missing participant", () => {
    const d = fromStoreDay(storeDay("2026-10-30"));
    expect(d.rows.FII).toEqual(parseParticipantCsv(csv()).FII);
    const broken = storeDay("2026-10-29");
    delete broken.rows.DII;
    expect(fromStoreDay(broken)).toBeNull();
  });

  it("says UPSTREAM_ERROR when the store has nothing, and validates days", async () => {
    await expect(setup([]).h(ctx())).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    await expect(participantsRoutes({})[0][3](ctx())).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    for (const bad of ["0", "61", "x"]) await expect(setup([storeDay("2026-10-30")]).h(ctx(`days=${bad}`))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
