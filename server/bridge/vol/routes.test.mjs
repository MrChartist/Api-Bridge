/**
 * S18 routes (docs/spec/p1-03-pricing-vol.md §3, §4.3, §9.3) on a seeded demo store: every read route's happy path and
 * its §3.2 validation errors; `available: false` shapes and reasons; the rank's three lookbacks and `demoPartial`
 * ("34 of 252", honoured only in demo); history CSV header and file name, cursor paging, `clock=` conversion and
 * `quality=live`; summary, status and predictions; no `accountId` anywhere in a response; and, through the real
 * request pipeline, read vs admin scope on POST /v1/vol/capture (202, audited) and 501 for the back-fill writes.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { toProblem } from "../core/errors.mjs";
import { Reply } from "../core/http.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createDemoRegistry } from "../demo/demoMode.mjs";
import { demoCalendar } from "../reference/demoTables.mjs";
import { createVolRoutes, stripAccountIds } from "./routes.mjs";
import { createVolService } from "./volService.mjs";

const IST = (s) => Date.parse(`${s}+05:30`);
const NOW = IST("2026-10-29T11:00:00");
const cal = demoCalendar();
const reference = {
  session: (exchange, t) => {
    const date = new Date(t + 330 * 60_000).toISOString().slice(0, 10);
    return { date, open: "09:15", close: "15:30", tradingDay: cal.isTradingDay(date, exchange), source: "test" };
  },
  calendar: () => ({ isTradingDay: (d, e = "NFO") => cal.isTradingDay(d, e), holidays: cal.holidays }),
  rate: () => ({ value: 0.065, quality: "default", source: "default (not sourced)" }),
};
const ctx = (query = {}, body) => ({ query: new URLSearchParams(query), body, requestId: "req_t", principal: { kind: "key", id: "k1" } });
const deepKeys = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), deepKeys(x, out));
  return out;
};
async function problem(p) {
  try {
    await p;
  } catch (err) {
    return toProblem(err);
  }
  return null;
}

describe("vol read routes (demo store)", () => {
  let svc;
  let routes;
  const audits = [];
  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-vol-routes-"));
    svc = createVolService({ config: { dataDir, demo: true, vol: {} }, clock: { now: () => NOW }, reference, marketData: null, symbols: null, scheduler: null, recorder: null, bus: null });
    await svc.seedIfDemo();
    await svc.store.flush();
    routes = createVolRoutes(svc, { config: { demo: true }, audit: { append: async (r) => audits.push(r) } });
  }, 30_000);

  it("rank: three lookbacks, same-DTE, VIX and definitions; demoPartial shows 34 of 252", async () => {
    const r = (await routes.rank(ctx({ underlying: "NIFTY" }))).data;
    expect(r).toMatchObject({ underlying: "NIFTY", basis: "cm30", clock: "weighted", available: true, current: { source: "last-capture" } });
    // The windows are the last N trading days (§6.7): the seed's one missed day (12 Oct) leaves n one short, partial.
    expect(r.lookbacks.map((l) => [l.days, l.n, l.partial])).toEqual([
      [30, 29, true],
      [90, 89, true],
      [252, 251, true],
    ]);
    expect(r.lookbacks[2]).toMatchObject({ liveN: 34, backfillN: 217 });
    for (const l of r.lookbacks) {
      expect(l.ivr).toBeGreaterThanOrEqual(0);
      expect(l.ivr).toBeLessThanOrEqual(100);
      expect(l.min.date < l.max.date || l.min.date > l.max.date).toBe(true);
    }
    expect(r.sameDte).toMatchObject({ band: 0.5 });
    expect(r.sameDte.n).toBeGreaterThan(20);
    expect(r.vix).toMatchObject({ n: 252, source: "demo", vsNifty30: { note: "Both on calendar time" } });
    expect(r.definitions.ivp).toMatch(/below current/);
    const p = (await routes.rank(ctx({ underlying: "NIFTY", demoPartial: "1" }))).data;
    expect(p.lookbacks[2]).toMatchObject({ days: 252, n: 34, liveN: 34, partial: true });
    expect(p.lookbacks[0]).toMatchObject({ days: 30, n: 29, partial: true });
    // Fewer than minRankDays: collecting, no rank.
    const few = (await routes.rank(ctx({ underlying: "NIFTY", lookbacks: "10" }))).data.lookbacks[0];
    expect(few).toMatchObject({ n: 10, ivr: null, ivp: null, reason: "COLLECTING" });
    // Per expiry and on another clock.
    const front = (await routes.rank(ctx({ underlying: "NIFTY", basis: "front", clock: "calendar" }))).data;
    expect(front.lookbacks[2].n).toBeGreaterThan(200);
    // Unavailable is not an error.
    expect((await routes.rank(ctx({ underlying: "BANKEX" }))).data).toMatchObject({ available: false, reason: "NOT_LISTED_IN_DEMO" });
    for (const [q, path] of [
      [{}, "underlying"],
      [{ underlying: "NIFTY", basis: "weekly" }, "basis"],
      [{ underlying: "NIFTY", basis: "expiry" }, "expiry"],
      [{ underlying: "NIFTY", lookbacks: "30,abc" }, "lookbacks"],
      [{ underlying: "NIFTY", clock: "solar" }, "clock"],
      [{ underlying: "NIFTY", quality: "best" }, "quality"],
      [{ underlying: "NIFTY", expiry: "2026-02-30", basis: "expiry" }, "expiry"],
    ]) {
      const e = await problem(routes.rank(ctx(q)));
      expect(e?.code, JSON.stringify(q)).toBe("VALIDATION_FAILED");
      expect(e.errors[0].path).toBe(path);
    }
  });

  it("demoPartial is ignored outside demo mode", async () => {
    const plain = createVolRoutes(svc, { config: { demo: false } });
    expect((await plain.rank(ctx({ underlying: "NIFTY", demoPartial: "1" }))).data.lookbacks[2].n).toBe(251);
  });

  it("history: gaps, coverage, quality, clock conversion, cursor paging and CSV", async () => {
    const h = (await routes.history(ctx({ underlying: "NIFTY" }))).data;
    expect(h).toMatchObject({ underlying: "NIFTY", basis: "cm30", clock: "weighted", series: ["iv", "vix", "hv20", "ivHv20"] });
    expect(h.items.length).toBeGreaterThan(250);
    expect(h.gaps).toHaveLength(1);
    expect(h.gaps[0].reason).toBe("BRIDGE_OFF");
    expect(h.items.map((i) => i.date)).not.toContain(h.gaps[0].date);
    expect(new Set(h.items.map((i) => i.quality))).toEqual(new Set(["live", "backfill-eod"]));
    expect(h.coverage).toMatchObject({ liveDays: 34 });
    expect(h.coverage.tradingDaysInRange).toBeGreaterThan(250);
    const live = (await routes.history(ctx({ underlying: "NIFTY", quality: "live" }))).data;
    expect(live.items).toHaveLength(34);
    // clock=calendar returns the stored calendar cm30 (the same total variance on calendar time).
    const both = (await routes.history(ctx({ underlying: "NIFTY", series: "iv,ivCal", clock: "calendar" }))).data;
    expect(both.items.every((i) => i.iv === i.ivCal)).toBe(true);
    // Front basis marks rolls; expiry basis needs an expiry.
    const fr = (await routes.history(ctx({ underlying: "NIFTY", basis: "front", series: "iv,straddle,forward" }))).data;
    expect(fr.items.some((i) => i.roll)).toBe(true);
    expect(fr.items.at(-1).forward).toBeGreaterThan(1000);
    const ex = fr.items.at(-1).frontExpiry;
    const one = (await routes.history(ctx({ underlying: "NIFTY", basis: "expiry", expiry: ex, series: "iv,rr25" }))).data;
    expect(one.items.length).toBeGreaterThan(0);
    // Cursor paging.
    const p1 = (await routes.history(ctx({ underlying: "NIFTY", limit: "100" }))).data;
    expect(p1.items).toHaveLength(100);
    const p2 = (await routes.history(ctx({ underlying: "NIFTY", limit: "100", cursor: p1.nextCursor }))).data;
    expect(p2.items[0].date > p1.items.at(-1).date).toBe(true);
    // CSV.
    const c = await routes.history(ctx({ underlying: "NIFTY", format: "csv", from: "2026-10-01", to: "2026-10-28" }));
    expect(c).toBeInstanceOf(Reply);
    const lines = c.body.trim().split("\r\n");
    expect(lines[0]).toBe("date,iv,vix,hv20,ivHv20,quality,roll");
    expect(c.headers["Content-Disposition"]).toMatch(/^attachment; filename="NIFTY-vol-cm30-2026-10-01-2026-10-28\.csv"$/);
    for (const [q, path] of [
      [{ underlying: "NIFTY", series: "iv,delta" }, "series"],
      [{ underlying: "NIFTY", from: "2026-10-28", to: "2026-10-01" }, "from"],
      [{ underlying: "NIFTY", from: "2021-01-01", to: "2026-10-01" }, "from"],
      [{ underlying: "NIFTY", limit: "2001" }, "limit"],
      [{ underlying: "NIFTY", cursor: "junk" }, "cursor"],
      [{ underlying: "NIFTY", format: "xml" }, "format"],
    ]) {
      const e = await problem(routes.history(ctx(q)));
      expect(e?.code, JSON.stringify(q)).toBe("VALIDATION_FAILED");
      expect(e.errors[0].path).toBe(path);
    }
  });

  it("snapshot, summary, status, clock and predictions; no accountId anywhere", async () => {
    const snap = (await routes.snapshot(ctx({ underlying: "NIFTY" }))).data;
    expect(snap).toMatchObject({ underlying: "NIFTY", available: true, stale: false, rank: { lookback: 252, n: 251 }, clock: { mode: "weighted" } });
    expect(snap.rows.length).toBeGreaterThanOrEqual(2);
    const partial = (await routes.snapshot(ctx({ underlying: "NIFTY", demoPartial: "true" }))).data;
    expect(partial.rank).toMatchObject({ n: 34, partial: true });
    // With a fresh snapshot the rank's current value is the live one.
    expect((await routes.rank(ctx({ underlying: "NIFTY" }))).data.current.source).toBe("live-snapshot");
    const sum = (await routes.summary(ctx({ underlyings: "NIFTY,BANKEX,RELIANCE" }))).data;
    expect(sum.items).toEqual([
      expect.objectContaining({ underlying: "NIFTY", available: true, n: 251, liveN: 34 }),
      { underlying: "BANKEX", available: false, reason: "NOT_LISTED_IN_DEMO", n: 0 },
      { underlying: "RELIANCE", available: false, reason: "NOT_LISTED_IN_DEMO", n: 0 },
    ]);
    expect((await problem(routes.summary(ctx({}))))?.code).toBe("VALIDATION_FAILED");
    const st = (await routes.status(ctx())).data;
    expect(st).toMatchObject({ demo: true, clock: { mode: "weighted" }, account: { broker: "demo" }, backfill: null });
    expect(st.underlyings.find((u) => u.underlying === "NIFTY")).toMatchObject({ liveDays: 34, backfillDays: 265 });
    expect(st.underlyings.find((u) => u.underlying === "BANKEX")).toEqual({ underlying: "BANKEX", available: false, reason: "NOT_LISTED_IN_DEMO" });
    const clock = (await routes.clock(ctx({ underlying: "NIFTY", expiry: "2026-11-03", at: "2026-10-29T10:00:00+05:30" }))).data;
    expect(clock.expiries[0].units).toBeCloseTo(3.96133, 5);
    expect((await problem(routes.clock(ctx({ underlying: "NIFTY", expiry: "3 Nov" }))))?.code).toBe("VALIDATION_FAILED");
    const preds = (await routes.predictions(ctx({ from: "2026-09-01", to: "2026-10-29", underlying: "NIFTY", metric: "band1", limit: "10" }))).data;
    expect(preds.items).toHaveLength(10);
    expect(preds.nextCursor).toBeTruthy();
    const next = (await routes.predictions(ctx({ from: "2026-09-01", to: "2026-10-29", underlying: "NIFTY", metric: "band1", limit: "10", cursor: preds.nextCursor }))).data;
    expect(next.items[0].ts >= preds.items.at(-1).ts).toBe(true);
    for (const body of [snap, sum, st, clock, preds, (await routes.history(ctx({ underlying: "NIFTY", basis: "expiry", expiry: snap.rows[0].expiry }))).data]) expect(deepKeys(body).has("accountId")).toBe(false);
    expect(stripAccountIds({ a: [{ accountId: "x", b: 1 }] })).toEqual({ a: [{ b: 1 }] });
  });

  it("POST capture answers 202 with the job and is audited; a second one while it runs is 409", async () => {
    const first = routes.capture(ctx({}, { underlyings: ["NIFTY"], replace: true }));
    const busy = await problem(routes.capture(ctx({}, {})));
    expect(busy?.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    const r = await first;
    expect(r).toBeInstanceOf(Reply);
    expect(r.status).toBe(202);
    expect(JSON.parse(r.body).data).toMatchObject({ underlyings: ["NIFTY"] });
    expect(audits.at(-1)).toMatchObject({ type: "vol.capture.manual", data: { underlyings: ["NIFTY"], replace: true } });
    expect((await problem(routes.capture(ctx({}, { underlyings: ["NIFTY"], extra: 1 }))))?.code).toBe("VALIDATION_FAILED");
    for (let i = 0; i < 50 && svc.status().running; i++) await new Promise((res) => setTimeout(res, 20));
    await svc.store.flush();
    expect(svc.status().lastRun).toMatchObject({ trigger: "manual", results: [{ underlying: "NIFTY", status: "ok" }] });
    expect(svc.store.summaryOn("NIFTY", "2026-10-29")).toMatchObject({ quality: "live" });
  });
});

describe("vol routes through the request pipeline (demo)", () => {
  let app;
  let base;
  let read;
  let admin;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-vol-app-"));
    const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
    app = await createApp({ config, logger: createNullLogger(), brokers: createDemoRegistry() });
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
    ({ key: read } = await app.deps.keyStore.create({ label: "r", scopes: ["read"], accounts: "*" }));
    ({ key: admin } = await app.deps.keyStore.create({ label: "a", scopes: ["admin"], accounts: "*" }));
  }, 30_000);
  afterAll(async () => app?.close());
  const call = (method, path, key, body) => fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

  it("reads need the read scope; capture needs admin (202, audited); back-fill answers 501 until P1-3c", async () => {
    const st = await call("GET", "/v1/vol/status", read);
    expect(st.status).toBe(200);
    for (let i = 0; i < 200; i++) {
      const s = (await (await call("GET", "/v1/vol/status", read)).json()).data;
      if (s.seeding?.state === "done") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const rank = await (await call("GET", "/v1/vol/rank?underlying=NIFTY&demoPartial=1", read)).json();
    expect(rank.data.lookbacks.map((l) => l.days)).toEqual([30, 90, 252]);
    expect(rank.data.lookbacks[2]).toMatchObject({ n: 34, partial: true });
    const denied = await call("POST", "/v1/vol/capture", read, { underlyings: ["NIFTY"] });
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("SCOPE_REQUIRED");
    const ok = await call("POST", "/v1/vol/capture", admin, { underlyings: ["NIFTY"], replace: true });
    expect(ok.status).toBe(202);
    expect((await ok.json()).data.jobId).toMatch(/^cap_/);
    const audit = await app.deps.audit.query({ type: "vol.capture.manual" });
    expect(audit.items).toHaveLength(1);
    expect((await call("POST", "/v1/vol/backfill", admin, {})).status).toBe(501);
    const csv = await call("GET", "/v1/vol/history?underlying=NIFTY&format=csv", read);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect((await csv.text()).split("\r\n")[0]).toBe("date,iv,vix,hv20,ivHv20,quality,roll");
  }, 60_000);
});
