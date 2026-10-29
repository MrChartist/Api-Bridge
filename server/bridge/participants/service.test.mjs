import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertService } from "../core/contracts.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { addDays, istInstant, weekdayOf } from "../reference/calendar.mjs";
import { parseParticipantsConfig, pathFor } from "./config.mjs";
import { demoParticipantDay } from "./demo.mjs";
import { createFakeParticipants } from "./fake.mjs";
import { createParticipantsService, jitterMsFor } from "./service.mjs";

const HEAD = "Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short,Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short,Option Stock Call Long,Option Stock Put Long,Option Stock Call Short,Option Stock Put Short,Total Long Contracts,Total Short Contracts";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A file in NSE's layout for any date (rows from the demo generator, so totals balance). */
function csvFor(date) {
  const rows = demoParticipantDay(date)?.rows ?? demoParticipantDay("2026-10-28").rows;
  const name = { CLIENT: "Client", DII: "DII", FII: "FII", PRO: "Pro", TOTAL: "TOTAL" };
  const line = (p) => {
    const r = rows[p];
    const v = [r.IDX_FUT[0], r.IDX_FUT[1], r.STK_FUT[0], r.STK_FUT[1], r.IDX_CE[0], r.IDX_PE[0], r.IDX_CE[1], r.IDX_PE[1], r.STK_CE[0], r.STK_PE[0], r.STK_CE[1], r.STK_PE[1]];
    return [name[p], ...v, 0, 0].join(",");
  };
  const title = `"Participant wise Open Interest (no. of contracts) in Equity Derivatives as on ${MON[Number(date.slice(5, 7)) - 1]} ${date.slice(8, 10)}, ${date.slice(0, 4)}"`;
  return [title, HEAD, ...["CLIENT", "DII", "FII", "PRO", "TOTAL"].map(line)].join("\r\n") + "\r\n";
}

function fakeClient(files = {}) {
  const calls = [];
  return {
    calls,
    async fetchFile(kind, date, { path } = {}) {
      calls.push({ kind, date, path });
      const f = files[date];
      if (f === undefined || f === 404) {
        const err = new Error(`HTTP 404 for ${date}`);
        err.code = "UPSTREAM_ERROR";
        err.httpStatus = 404;
        throw err;
      }
      if (f instanceof Error) throw f;
      const buf = Buffer.from(typeof f === "function" ? f() : f, "utf8");
      return { kind, date, url: `https://archives.test${path}`, name: "x", buf, sha256: `sha-${date}-${buf.length}`, bytes: buf.length };
    },
  };
}

/** A fake reference service: weekdays minus `holidays`, an archive switch, the given client. */
function fakeReference({ enabled = true, holidays = [], client = fakeClient() } = {}) {
  const isTradingDay = (d) => weekdayOf(d) !== 0 && weekdayOf(d) !== 6 && !holidays.includes(d);
  const step = (d, n) => {
    let x = addDays(d, n);
    while (!isTradingDay(x)) x = addDays(x, n);
    return x;
  };
  const sw = { enabled };
  return {
    sw,
    client,
    calendar: () => ({ isTradingDay, prevTradingDay: (d) => step(d, -1), nextTradingDay: (d) => step(d, 1) }),
    archives: () => ({ enabled: sw.enabled, setBy: "dashboard", client: sw.enabled ? client : null }),
    status: () => ({ sources: { nseArchives: { enabled: sw.enabled, setBy: "dashboard" } } }),
  };
}

function setup({ at, enabled = true, holidays = [], files = {}, participants = {}, dataDir = mkdtempSync(join(tmpdir(), "mcb-part-")), bus = null } = {}) {
  const clock = { t: at, now: () => clock.t };
  const client = fakeClient(files);
  const reference = fakeReference({ enabled, holidays, client });
  const sleeps = [];
  const service = createParticipantsService(
    { config: { participants: parseParticipantsConfig(participants), dataDir }, clock, reference, paths: { dataDir }, bus: bus ?? createEventBus(), logger: null },
    { jitterMs: 0, sleep: async (ms) => sleeps.push(ms), timers: { setInterval: () => null, clearInterval: () => {} } },
  );
  return { service, clock, client, reference, sleeps, dataDir };
}

const IST = (date, hhmm) => istInstant(date, hhmm);

describe("participants service", () => {
  it("satisfies the contract (and so does the fake)", () => {
    const { service } = setup({ at: IST("2026-10-28", "12:00") });
    expect(() => assertService("participants", service)).not.toThrow();
    expect(() => assertService("participants", createFakeParticipants())).not.toThrow();
  });

  it("source off: nothing is fetched and latest() says SOURCE_OFF", async () => {
    const { service, client } = setup({ at: IST("2026-10-28", "19:30"), enabled: false });
    await service.tick();
    expect(client.calls).toEqual([]);
    expect(service.latest({ exchange: "NSE" })).toMatchObject({ available: false, reason: "SOURCE_OFF" });
    expect(service.status().source.nseArchives).toBe("off");
    await expect(service.sync({})).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(service.summary({})).toMatchObject({ available: false, reason: "SOURCE_OFF" });
  });

  it("BSE always answers NOT_FOR_BSE", () => {
    const { service } = setup({ at: IST("2026-10-28", "19:30") });
    expect(service.latest({ exchange: "BSE" })).toMatchObject({ available: false, reason: "NOT_FOR_BSE" });
  });

  it("daily schedule: 19:10, retries every 30 min until 22:10; a daily 404 is not 'noFile'", async () => {
    const d = "2026-10-28";
    const { service, client, clock } = setup({ at: IST(d, "19:09"), files: { "2026-10-27": csvFor("2026-10-27") }, participants: { backfill: { enabled: false } } });
    await service.tick();
    expect(client.calls.filter((c) => c.date === d)).toHaveLength(0);
    clock.t = IST(d, "19:10");
    await service.tick();
    expect(client.calls.filter((c) => c.date === d)).toHaveLength(1);
    expect(client.calls.find((c) => c.date === d).path).toBe("/content/nsccl/fao_participant_oi_28102026.csv");
    clock.t = IST(d, "19:25");
    await service.tick();
    expect(client.calls.filter((c) => c.date === d)).toHaveLength(1);
    for (const hm of ["19:40", "20:10", "20:40", "21:10", "21:40", "22:10"]) {
      clock.t = IST(d, hm);
      await service.tick();
    }
    expect(client.calls.filter((c) => c.date === d)).toHaveLength(7);
    clock.t = IST(d, "22:40");
    await service.tick();
    expect(client.calls.filter((c) => c.date === d)).toHaveLength(7);
    expect(service.status().backfill.noFile).toBe(0);
    expect(service.status().lastError).toMatchObject({ code: "NO_FILE", date: d });
  });

  it("the morning catch-up fetches a missed day at 08:40, and a 404 then marks it 'noFile'", async () => {
    const { service, client, clock } = setup({ at: IST("2026-10-29", "08:39"), files: { "2026-10-27": csvFor("2026-10-27") }, participants: { backfill: { enabled: false } } });
    await service.tick();
    expect(client.calls).toHaveLength(0);
    clock.t = IST("2026-10-29", "08:40");
    await service.tick();
    expect(client.calls.map((c) => c.date)).toEqual(["2026-10-28"]);
    await service.tick();
    expect(client.calls).toHaveLength(1);
    expect(service.status().backfill.noFile).toBe(1);
    expect(service.nextBackfillDate()).not.toBe("2026-10-28");
  });

  it("stores a fetched day, emits participants.updated and answers latest() in P1-8's shape", async () => {
    const bus = createEventBus();
    const seen = [];
    bus.on("participants.updated", (p) => seen.push(p));
    const d = "2026-10-28";
    const { service, dataDir } = setup({ at: IST(d, "19:15"), files: { [d]: csvFor(d) }, bus, participants: { backfill: { enabled: false } } });
    await service.tick();
    expect(seen).toEqual([{ date: d, source: "nse-archives:fao_participant_oi_28102026.csv", changed: true }]);
    const l = service.latest({ exchange: "NSE" });
    expect(l).toMatchObject({ available: true, asOfDate: d, source: "nse-participant-oi", unit: "contracts", quality: "ok" });
    expect(l.rows).toHaveLength(24);
    expect(l.rows[0]).toEqual({ participant: "CLIENT", instrument: "IDX_FUT", long: expect.any(Number), short: expect.any(Number) });
    expect(l.rows.some((r) => r.participant === "TOTAL")).toBe(false);
    // On disk: one line in oi/2026.jsonl, the raw file and its sha256.
    expect(readFileSync(join(dataDir, "participants/oi/2026.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(join(dataDir, "participants/raw/2026-10-28/fao_participant_oi_28102026.csv"))).toBe(true);
    expect(existsSync(join(dataDir, "participants/raw/2026-10-28/fao_participant_oi_28102026.csv.sha256"))).toBe(true);
    // A second service on the same folder reads it back.
    const again = createParticipantsService({ config: { dataDir }, clock: { now: () => IST(d, "19:16") }, reference: fakeReference({}), paths: { dataDir } }, { jitterMs: 0 });
    expect(again.latest({ exchange: "NSE" }).asOfDate).toBe(d);
  });

  it("latest() is stale when the newest file is older than the previous trading day", async () => {
    const { service, clock } = setup({ at: IST("2026-10-26", "19:20"), files: { "2026-10-26": csvFor("2026-10-26") }, participants: { backfill: { enabled: false } } });
    await service.tick();
    expect(service.latest({}).available).toBe(true);
    clock.t = IST("2026-10-27", "12:00");
    expect(service.latest({}).available).toBe(true);
    clock.t = IST("2026-10-28", "12:00");
    expect(service.latest({})).toMatchObject({ available: false, reason: "PARTICIPANT_STALE", asOfDate: "2026-10-26" });
  });

  it("skips non-trading days when the reference calendar is present", async () => {
    const d = "2026-11-10";
    const { service, client } = setup({ at: IST(d, "19:30"), holidays: [d], participants: { backfill: { enabled: false } } });
    await service.tick();
    expect(client.calls).toHaveLength(0);
    const sat = setup({ at: IST("2026-10-31", "19:30"), participants: { backfill: { enabled: false } } });
    await sat.service.tick();
    expect(sat.client.calls).toHaveLength(0);
  });

  it("a page that is not the CSV records PARSE_FAILED and stores nothing", async () => {
    const d = "2026-10-28";
    const { service } = setup({ at: IST(d, "19:15"), files: { [d]: "<html>Access denied</html>" }, participants: { backfill: { enabled: false } } });
    await service.tick();
    expect(service.status().lastError).toMatchObject({ code: "PARSE_FAILED" });
    expect(service.latest({}).available).toBe(false);
  });

  it("back-fill: newest first, gap between files, maxPerRun, 404 twice → noFile, resumes from the cursor", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-part-bf-"));
    const files = {};
    let d = "2026-10-27";
    const all = [];
    for (let i = 0; i < 12; i += 1) {
      all.push(d);
      files[d] = csvFor(d);
      d = addDays(d, -1);
      while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d = addDays(d, -1);
    }
    files["2026-10-22"] = 404;
    const cfg = { backfill: { days: 12, maxPerRun: 4 } };
    const a = setup({ at: IST("2026-10-28", "17:00"), files, participants: cfg, dataDir });
    const r1 = await a.service.runBackfill();
    expect(r1.fetched).toEqual(["2026-10-27", "2026-10-26", "2026-10-23"]);
    expect(r1.failed).toEqual([{ date: "2026-10-22", code: "NO_FILE" }]);
    expect(a.sleeps).toEqual([6000, 6000, 6000, 6000]);
    // The hourly cap is reached: nothing more this hour.
    expect((await a.service.runBackfill()).fetched).toEqual([]);
    // Restart: a new service on the same folder resumes below the cursor.
    const b = setup({ at: IST("2026-10-28", "18:05"), files, participants: cfg, dataDir });
    const r2 = await b.service.runBackfill();
    expect(r2.fetched).toEqual(["2026-10-21", "2026-10-20", "2026-10-19", "2026-10-16"]);
    expect(b.client.calls.map((c) => c.date)).not.toContain("2026-10-27");
    b.clock.t = IST("2026-10-28", "19:05");
    const r3 = await b.service.runBackfill();
    expect(r3.fetched).toEqual(["2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12"]);
    // Pass two retries the one 404; a second 404 makes it "noFile".
    b.clock.t = IST("2026-10-28", "20:05");
    const r4 = await b.service.runBackfill();
    expect(r4.noFile).toEqual(["2026-10-22"]);
    // After 19:10 the window moves to end on today (28 Oct; the daily fetch owns it), so 13–27 Oct are the target.
    expect(b.service.status().backfill).toMatchObject({ target: 12, have: 10, noFile: 1, done: true });
    expect(b.client.calls.filter((c) => c.date === "2026-10-22")).toHaveLength(1);
    expect(a.client.calls.filter((c) => c.date === "2026-10-22")).toHaveLength(1);
    expect(b.service.series({ from: "2026-10-01", to: "2026-10-31" }).map((x) => x.date)).toHaveLength(11);
  });

  it("keeps back-filling after the first pass: a day missed while the Bridge was off is fetched on a later tick", async () => {
    const files = {};
    for (let d = "2026-10-01"; d <= "2026-11-06"; d = addDays(d, 1)) if (weekdayOf(d) !== 0 && weekdayOf(d) !== 6) files[d] = csvFor(d);
    const { service, client, clock } = setup({ at: IST("2026-10-28", "17:00"), files, participants: { backfill: { days: 5 } } });
    await service.runBackfill();
    expect(service.status().backfill).toMatchObject({ have: 5, done: true });
    // The Bridge is off on Thu 29 and Fri 30 Oct evenings and Mon 2 Nov evening; it comes back on Tue 3 Nov at 17:00.
    clock.t = IST("2026-11-03", "17:00");
    client.calls.length = 0;
    await service.tick(); // starts the back-fill in the background
    for (let i = 0; i < 50 && (i === 0 || service.status().backfill.running); i += 1) await new Promise((r) => setTimeout(r, 0));
    const got = client.calls.map((c) => c.date);
    expect(got).toEqual(expect.arrayContaining(["2026-11-02", "2026-10-30", "2026-10-29"]));
    expect(service.status().backfill).toMatchObject({ have: 5, done: true });
  });

  it("an evening of NSE errors never drops that day: seven daily 5xx failures, and the back-fill still picks it the next afternoon", async () => {
    const d = "2026-10-28";
    const outage = Object.assign(new Error("NSE archives answered HTTP 503"), { code: "UPSTREAM_ERROR" });
    const files = { [d]: outage };
    const { service, client, clock } = setup({ at: IST(d, "19:10"), files, participants: { backfill: { enabled: false, days: 5 } } });
    for (const hm of ["19:10", "19:40", "20:10", "20:40", "21:10", "21:40", "22:10"]) {
      clock.t = IST(d, hm);
      await service.tick();
    }
    expect(client.calls.filter((c) => c.date === d)).toHaveLength(7);
    expect(service.status().lastError).toMatchObject({ code: "UPSTREAM_ERROR", date: d });
    clock.t = IST("2026-10-29", "16:00");
    expect(service.nextBackfillDate()).toBe(d);
  });

  it("back-fill: rate limits and timeouts never count toward the skip threshold; a parse failure does", async () => {
    const limited = Object.assign(new Error("429"), { code: "UPSTREAM_RATE_LIMITED" });
    const timeout = Object.assign(new Error("timeout"), { code: "UPSTREAM_TIMEOUT" });
    // The page that is not the CSV is the newer day, so each run reaches it before the timing-out day pauses the run.
    const files = { "2026-10-27": "<html>not the csv</html>", "2026-10-26": timeout, "2026-10-23": csvFor("2026-10-23") };
    const { service, clock, client } = setup({ at: IST("2026-10-28", "17:00"), files, participants: { backfill: { days: 3 } } });
    const count = (d) => client.calls.filter((c) => c.date === d).length;
    const run = async () => {
      // Step past the pause, as the minute tick would (same IST evening, so the targets do not move).
      const until = service.status().backfill.pausedUntil;
      if (until) clock.t = Date.parse(until);
      await service.runBackfill({ max: 3 });
    };
    for (let i = 0; i < 4; i += 1) await run();
    expect(count("2026-10-27")).toBe(3); // skipped after three parse failures
    const timeoutTries = count("2026-10-26");
    expect(timeoutTries).toBe(4);
    files["2026-10-26"] = limited;
    await run();
    expect(count("2026-10-27")).toBe(3);
    expect(count("2026-10-26")).toBe(timeoutTries + 1);
    expect(service.nextBackfillDate()).toBe("2026-10-26"); // never dropped
    expect(service.status().backfill).toMatchObject({ failed: 1, lastErrorCode: "UPSTREAM_RATE_LIMITED" });
  });

  it("back-fill backs off while NSE refuses: an archive that always answers 403 gets a handful of requests over six hours", async () => {
    const blocked = () => Object.assign(new Error("NSE archives answered HTTP 403"), { code: "UPSTREAM_ERROR", httpStatus: 403 });
    const files = {};
    for (let d = "2026-10-01"; d <= "2026-10-28"; d = addDays(d, 1)) files[d] = blocked();
    const { service, client, clock } = setup({ at: IST("2026-10-28", "16:00"), files, participants: { backfill: { days: 5 } } });
    const settle = async () => {
      for (let i = 0; i < 50 && (i === 0 || service.status().backfill.running); i += 1) await new Promise((r) => setTimeout(r, 0));
    };
    // A minute tick for six hours, 16:00 to 22:00. From 19:10 the daily fetch asks for the 28th every 30 min; that
    // is the daily schedule (bounded by retryUntil), so only the other dates are counted as back-fill requests.
    for (let m = 0; m < 360; m += 1) {
      clock.t = IST("2026-10-28", "16:00") + m * 60_000;
      await service.tick();
      await settle();
    }
    const backfillCalls = client.calls.filter((c) => c.date !== "2026-10-28").length;
    // Pauses of 30 min, 1 h, 2 h, 4 h: at most 4–5 back-fill requests in six hours (it was 720 without the back-off).
    expect(backfillCalls).toBeLessThanOrEqual(5);
    expect(backfillCalls).toBeGreaterThanOrEqual(3);
    const st = service.status().backfill;
    expect(st.pausedUntil).not.toBeNull();
    expect(st.lastErrorCode).toBe("UPSTREAM_ERROR");
    expect(st.done).toBe(false);
    // The first good answer clears the pause.
    for (const d of Object.keys(files)) files[d] = csvFor(d);
    clock.t = Date.parse(st.pausedUntil) + 1000;
    if (service.status().backfill.pausedUntil) clock.t = Date.parse(service.status().backfill.pausedUntil);
    await service.runBackfill({ max: 1 });
    expect(service.status().backfill).toMatchObject({ pausedUntil: null, lastErrorCode: null });
  });

  it("back-fill backs off on a 429 across ticks instead of asking again every minute", async () => {
    const limited = () => Object.assign(new Error("429"), { code: "UPSTREAM_RATE_LIMITED", httpStatus: 429 });
    const files = {};
    for (let d = "2026-10-01"; d <= "2026-10-28"; d = addDays(d, 1)) files[d] = limited();
    const { service, client, clock } = setup({ at: IST("2026-10-28", "16:00"), files, participants: { backfill: { days: 5 } } });
    for (let m = 0; m < 180; m += 1) {
      clock.t = IST("2026-10-28", "16:00") + m * 60_000;
      await service.tick();
      for (let i = 0; i < 20 && (i === 0 || service.status().backfill.running); i += 1) await new Promise((r) => setTimeout(r, 0));
    }
    // 16:00, 16:30, 17:30, 19:30 (pauses of 30 min, 1 h, 2 h); the daily 19:10 fetch of the 28th is not a back-fill.
    expect(client.calls.filter((c) => c.date !== "2026-10-28").length).toBe(4);
  });

  it("a Bridge started at 10:30 after a night off fetches the missed previous day once", async () => {
    const { service, client, clock } = setup({ at: IST("2026-10-29", "10:30"), files: { "2026-10-28": csvFor("2026-10-28") }, participants: { backfill: { days: 5 } } });
    await service.tick();
    expect(client.calls.map((c) => c.date)).toEqual(["2026-10-28"]);
    expect(service.latest({}).asOfDate).toBe("2026-10-28");
    clock.t = IST("2026-10-29", "11:30");
    await service.tick();
    expect(client.calls).toHaveLength(1); // once a day; the back-fill still waits for 15:45
  });

  it("with reference data stubbed out, latest() and summary() say SOURCE_UNAVAILABLE (not the source-off hint)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-part-"));
    const clock = { now: () => IST("2026-10-28", "20:00") };
    const service = createParticipantsService(
      { config: { participants: parseParticipantsConfig({}), dataDir }, clock, reference: null, paths: { dataDir }, bus: createEventBus(), logger: null },
      { jitterMs: 0, sleep: async () => {}, timers: { setInterval: () => null, clearInterval: () => {} } },
    );
    expect(service.latest({ exchange: "NSE" })).toMatchObject({ available: false, reason: "SOURCE_UNAVAILABLE", detail: "Reference data is not running on this Bridge." });
    expect(service.summary({})).toMatchObject({ available: false, reason: "SOURCE_UNAVAILABLE" });
    expect(service.status().lastError).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it("a manual sync for today before NSE publishes never marks today 'noFile'; the 19:10 fetch still runs", async () => {
    const d = "2026-10-28";
    const files = { [d]: 404 };
    const { service, client, clock } = setup({ at: IST(d, "17:00"), files, participants: { backfill: { enabled: false } } });
    expect((await service.sync({ date: d })).failed).toEqual([{ date: d, code: "NO_FILE" }]);
    expect((await service.sync({ date: d })).noFile).toEqual([]);
    expect(service.status().backfill.noFile).toBe(0);
    files[d] = csvFor(d);
    clock.t = IST(d, "19:10");
    await service.tick();
    expect(client.calls.filter((c) => c.date === d)).toHaveLength(3);
    expect(service.latest({}).asOfDate).toBe(d);
    // After the window closes, two manual 404s for an older day do make it "noFile".
    const o = setup({ at: IST(d, "23:00"), participants: { backfill: { enabled: false } } });
    await o.service.sync({ date: d });
    expect((await o.service.sync({ date: d })).noFile).toEqual([d]);
  });

  it("the back-fill cap is over a rolling hour: no 60-minute window holds more than maxPerRun fetches", async () => {
    const files = {};
    for (let d = "2026-06-01"; d <= "2026-10-28"; d = addDays(d, 1)) if (weekdayOf(d) !== 0 && weekdayOf(d) !== 6) files[d] = csvFor(d);
    const clock = { t: IST("2026-10-28", "17:55"), now: () => clock.t };
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-part-roll-"));
    const reference = fakeReference({ client: fakeClient(files) });
    const at = [];
    const service = createParticipantsService(
      { config: { participants: parseParticipantsConfig({ backfill: { days: 100, maxPerRun: 10, gapSeconds: 60 } }), dataDir }, clock, reference, paths: { dataDir }, logger: null },
      { jitterMs: 0, sleep: async (ms) => { clock.t += ms; }, timers: { setInterval: () => null, clearInterval: () => {} } },
    );
    const orig = reference.client.fetchFile.bind(reference.client);
    reference.client.fetchFile = async (...a) => { at.push(clock.t); return orig(...a); };
    // Runs at :55, then every minute for two hours (each run stops at the cap).
    for (let m = 0; m < 120; m += 1) {
      await service.runBackfill();
      if (clock.t < IST("2026-10-28", "17:55") + (m + 1) * 60_000) clock.t = IST("2026-10-28", "17:55") + (m + 1) * 60_000;
    }
    expect(at.length).toBeGreaterThan(10);
    for (const t0 of at) expect(at.filter((x) => x >= t0 && x < t0 + 3_600_000).length).toBeLessThanOrEqual(10);
  });

  it("summary flags a stale latest file (and names the expected day)", async () => {
    const { service, clock } = setup({ at: IST("2026-10-26", "19:20"), files: { "2026-10-26": csvFor("2026-10-26") }, participants: { backfill: { enabled: false } } });
    await service.tick();
    expect(service.summary({})).toMatchObject({ available: true, stale: false });
    clock.t = IST("2026-10-28", "12:00");
    expect(service.summary({})).toMatchObject({ available: true, date: "2026-10-26", stale: true, expectedDate: "2026-10-27" });
    expect(service.summary({ date: "2026-10-26" }).stale).toBe(false);
  });

  it("back-fill never runs during market hours (notDuring 09:00–15:45)", async () => {
    const { service, client } = setup({ at: IST("2026-10-28", "10:00"), files: { "2026-10-27": csvFor("2026-10-27") } });
    const r = await service.runBackfill();
    expect(r.fetched).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  it("a corrupt state.json is moved aside and a torn year-file line is skipped", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-part-c-"));
    const first = setup({ at: IST("2026-10-28", "12:00"), dataDir });
    void first;
    writeFileSync(join(dataDir, "participants/state.json"), "{not json");
    const day = { v: 1, date: "2026-10-27", exchange: "NSE", source: "x", quality: "ok", unit: "contracts", rows: demoParticipantDay("2026-10-27").rows };
    writeFileSync(join(dataDir, "participants/oi/2026.jsonl"), `${JSON.stringify(day)}\n{"date":"2026-10-2`);
    const s = setup({ at: IST("2026-10-28", "12:00"), dataDir });
    expect(readdirSync(join(dataDir, "participants")).some((n) => n.startsWith("state.json.corrupt-"))).toBe(true);
    expect(s.service.latest({}).asOfDate).toBe("2026-10-27");
  });

  it("series validates its range and filters", () => {
    const { service } = setup({ at: IST("2026-10-28", "12:00") });
    expect(() => service.series({ from: "2024-01-01", to: "2026-10-28" })).toThrow(/at most 750/);
    expect(() => service.series({ from: "2026-10-28", to: "2026-10-01" })).toThrow(/after/);
    expect(() => service.series({ participants: ["XYZ"] })).toThrow(/participants/);
  });

  it("helpers: URL templates and jitter", () => {
    expect(pathFor("{base}/content/nsccl/fao_participant_oi_{DDMMYYYY}.csv", "2026-01-05")).toBe("/content/nsccl/fao_participant_oi_05012026.csv");
    expect(pathFor("{base}/archives/x_{DD-MMM-YYYY}.csv", "2026-01-05")).toBe("/archives/x_05-JAN-2026.csv");
    expect(() => parseParticipantsConfig({ urls: ["https://evil.example/x_{DDMMYYYY}.csv"] })).toThrow();
    expect(() => parseParticipantsConfig({ urls: ["{base}/x.csv"] })).toThrow(/placeholder/);
    expect(jitterMsFor("/a")).toBeLessThan(300_000);
    expect(jitterMsFor("/a")).toBe(jitterMsFor("/a"));
  });
});

describe("participants service in demo mode", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-part-demo-"));
  const at = IST("2026-10-29", "12:00");
  const service = createParticipantsService({ config: { demo: true, dataDir }, clock: { now: () => at }, reference: fakeReference({ enabled: false }), paths: { dataDir } });

  it("serves two years of history without fetching or writing", async () => {
    const st = service.status();
    expect(st).toMatchObject({ demo: true, latestDate: "2026-10-28", source: { nseArchives: "demo" } });
    expect(st.backfill.target).toBe(500);
    expect(st.backfill.have + st.backfill.noFile).toBe(500);
    // The history holds exactly the status window: the same count of days with a file.
    const all = service.series({ from: "2024-11-01", to: "2026-10-29" });
    expect(all.length).toBe(st.backfill.have);
    expect(existsSync(join(dataDir, "participants"))).toBe(false);
    await expect(service.sync({})).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });

  it("today's demo file appears only after 19:10 IST", () => {
    const late = createParticipantsService({ config: { demo: true, dataDir }, clock: { now: () => IST("2026-10-29", "19:20") }, reference: fakeReference({ enabled: false }), paths: { dataDir } });
    expect(late.latest({}).asOfDate).toBe("2026-10-29");
    expect(service.latest({}).asOfDate).toBe("2026-10-28");
  });

  it("summary: previous day, 20-day history, a 404 on a demo holiday", () => {
    const s = service.summary({});
    expect(s).toMatchObject({ available: true, date: "2026-10-28", exchange: "NSE", unit: "contracts", source: "demo" });
    expect(s.history.fiiIndexFutLongPct).toHaveLength(20);
    expect(s.table).toHaveLength(30);
    // A demo holiday: some weekday in the last year has no file.
    let hol = null;
    for (let d = "2026-10-28"; d > "2025-10-01"; d = addDays(d, -1)) if (weekdayOf(d) % 6 !== 0 && !demoParticipantDay(d)) hol = d;
    expect(hol).not.toBeNull();
    expect(() => service.summary({ date: hol })).toThrow(/No participant OI/);
  });
});
