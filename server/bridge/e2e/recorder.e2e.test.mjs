/**
 * Recorder end to end (docs/spec/p1-01-recorder.md §12, steps 1–5):
 * the real Bridge (every module, real scheduler, market data and HTTP) with a clock that starts on Mon 19 Oct 2026
 * at 10:00:58 IST and runs in real time, and stub brokers with an instrument master and an option-chain endpoint.
 *
 *  1. Within 5 s a snapshot of every planned chain exists, on disk and via GET /v1/options/snapshots.
 *  2. GET /v1/options/recorder: state recording, coverage, disk bytes.
 *  3. Stop; boot again at 10:03:58 on the same data folder: 10:01–10:03 are bridge-down gaps and a snapshot is
 *     written at 10:04 (resume within a minute).
 *  4. PUT /v1/options/recorder/config asking a 1 request/s broker for 200 stocks: 422 CAPACITY_EXCEEDED with
 *     canCarry; nothing changes (status and the config file).
 *  5. Demo mode with the clock on Mon 19 Oct 2026 at 11:00:30 IST: within 5 s the nearest NIFTY expiry has back-filled
 *     minutes since 09:15 (quality demo-backfill / demo) and /v1/options/daily has rows for 2 previous weekdays.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { bootBridge, eventually, shiftedClock, stubBroker } from "./fixtures.mjs";

const EXPIRY = "2026-10-27";
const SPOT = 25010;
const STRIKES = Array.from({ length: 61 }, (_, i) => 23500 + i * 50);

/** A stub broker with NIFTY options and future in its master, a chain endpoint, and optional stock options. */
function chainBroker(id, { stocks = [] } = {}) {
  const b = stubBroker(id);
  const base = b.adapter.fetchInstruments;
  b.adapter.fetchInstruments = async (creds) => {
    const res = await base(creds);
    const rows = [...res.data, { token: "IDX-NIFTY", exchange: "NSE", tradingSymbol: "NIFTY", underlying: "NIFTY", instrumentType: "INDEX", expiry: null, strike: null, optionType: null, lotSize: 1, tickSize: 0.05 }];
    rows.push({ token: "FUT-NIFTY", exchange: "NFO", tradingSymbol: `NIFTY-${EXPIRY}-FUT`, underlying: "NIFTY", instrumentType: "FUTIDX", expiry: EXPIRY, strike: null, optionType: null, lotSize: 75, tickSize: 0.05 });
    for (const k of STRIKES) for (const r of ["CE", "PE"]) rows.push({ token: `O-NIFTY-${k}-${r}`, exchange: "NFO", tradingSymbol: `NIFTY-${EXPIRY}-${k}-${r}`, underlying: "NIFTY", instrumentType: "OPTIDX", expiry: EXPIRY, strike: k, optionType: r, lotSize: 75, tickSize: 0.05 });
    for (const s of stocks) for (let i = 0; i < 31; i++) for (const r of ["CE", "PE"]) rows.push({ token: `O-${s}-${i}-${r}`, exchange: "NFO", tradingSymbol: `${s}-${EXPIRY}-${100 + i * 5}-${r}`, underlying: s, instrumentType: "OPTSTK", expiry: EXPIRY, strike: 100 + i * 5, optionType: r, lotSize: 500, tickSize: 0.05 });
    return { status: "success", data: rows };
  };
  b.adapter.fetchOptionChain = async (creds, underlying, expiry) => {
    b.calls.push({ method: "fetchOptionChain", account: String(creds?.accessToken ?? "").replace(/^token-/, ""), underlying, expiry });
    const oc = {};
    for (const k of STRIKES) {
      const c = Math.max(1, 120 + (SPOT - k) * 0.55);
      const p = Math.max(1, 110 + (k - SPOT) * 0.45);
      oc[k.toFixed(6)] = { ce: { last_price: c, top_bid_price: c - 0.5, top_ask_price: c + 0.5, oi: 75 * 1000, previous_oi: 75 * 990, volume: 7500 }, pe: { last_price: p, top_bid_price: p - 0.5, top_ask_price: p + 0.5, oi: 75 * 900, previous_oi: 75 * 905, volume: 6000 } };
    }
    return { status: "success", data: { last_price: SPOT, oc } };
  };
  return b;
}

const RECORDER = { indices: ["NIFTY"], indexExpiries: 1, indexStrikes: 10, sources: { stream: false } };

async function boot({ dataDir, start, brokerId = "upstox", stocks = [], recorder = RECORDER, withConfigFile = false }) {
  const broker = chainBroker(brokerId, { stocks });
  const bridge = await bootBridge({
    brokers: { [brokerId]: broker },
    clock: shiftedClock(start),
    raw: { dataDir, accounts: [{ id: "acc-1", broker: brokerId }], recorder },
    withConfigFile,
  });
  const { key } = await bridge.deps.keyStore.create({ label: "rec", scopes: ["admin"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" });
  const r = await bridge.http("/v1/accounts/acc-1/session", { method: "POST", key, body: { values: { apiKey: "k", accessToken: "token-acc-1" } } });
  expect(r.status).toBe(200);
  await bridge.deps.symbols.refresh();
  return { bridge, broker, key };
}

const open = [];
afterAll(async () => {
  for (const b of open) await b.close().catch(() => {});
});

describe("recorder end to end", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-rec-e2e-"));

  it("steps 1–3: records at once, reports status, writes bridge-down gaps after a restart and resumes within a minute", async () => {
    const first = await boot({ dataDir, start: Date.parse("2026-10-19T10:00:58+05:30") });
    open.push(first.bridge);
    const t0 = Date.now();
    // Step 1: within 5 s, a snapshot of the planned chain (masters arrive in the background; the plan follows them).
    const page = await eventually(
      async () => {
        const r = await first.bridge.http(`/v1/options/snapshots?underlying=NIFTY&expiry=${EXPIRY}&fields=oi,ltp&from=2026-10-19`, { key: first.key });
        return r.json?.data?.snapshots?.length ? r.json.data : null;
      },
      { ms: 5000, every: 100 },
    );
    expect(Date.now() - t0).toBeLessThan(5000);
    // The minute the plan first had the chain (10:00, or 10:01 when boot and login crossed the minute).
    expect(page.snapshots[0].slot).toMatch(/^2026-10-19T10:0[01]:00\.000\+05:30$/);
    expect(page.snapshots[0]).toMatchObject({ source: "rest", accountId: "acc-1", broker: "upstox", quality: "live" });
    expect(page.snapshots[0].ts).toMatch(/^2026-10-19T10:0/);
    expect(existsSync(join(dataDir, "recorder", "s1", "2026-10-19", "NIFTY", `${EXPIRY}.ndjson`))).toBe(true);
    expect(first.broker.calls.filter((c) => c.method === "fetchOptionChain").every((c) => c.account === "acc-1")).toBe(true);
    // Step 2: status.
    const st = await first.bridge.http("/v1/options/recorder", { key: first.key });
    expect(st.json.data).toMatchObject({ state: "recording", account: { id: "acc-1", broker: "upstox" } });
    expect(st.json.data.coverage[0]).toMatchObject({ underlying: "NIFTY", expiry: EXPIRY, recordedSlots: 1, source: "rest" });
    expect(st.json.data.disk.bytes).toBeGreaterThan(0);
    const last = (await first.bridge.http(`/v1/options/snapshots?underlying=NIFTY&expiry=${EXPIRY}&fields=oi&from=2026-10-19`, { key: first.key })).json.data.snapshots.at(-1).slot;
    await first.bridge.close();

    // Step 3: boot again at 10:03:58 on the same folder.
    const second = await boot({ dataDir, start: Date.parse("2026-10-19T10:03:58+05:30") });
    open.push(second.bridge);
    const after = await eventually(
      async () => {
        const r = await second.bridge.http(`/v1/options/snapshots?underlying=NIFTY&expiry=${EXPIRY}&fields=oi&from=2026-10-19`, { key: second.key });
        return r.json?.data?.snapshots?.length >= 2 ? r.json.data : null;
      },
      { ms: 15_000, every: 200 },
    );
    // Every minute after the last record up to 10:03 is a bridge-down gap (10:01–10:03 when the first run recorded
    // only 10:00); the next snapshot is 10:04, at most a minute after the restart.
    const minute = (iso) => Number(iso.slice(14, 16));
    const missed = 3 - minute(last);
    expect(after.gaps).toEqual([{ from: `2026-10-19T10:0${minute(last) + 1}:00.000+05:30`, to: "2026-10-19T10:03:00.000+05:30", slots: missed, reason: "bridge-down", detail: "The Bridge was not running." }]);
    expect(after.snapshots.at(-1).slot).toBe("2026-10-19T10:04:00.000+05:30");
    expect(after.coverage).toMatchObject({ gapSlots: missed });
    await second.bridge.close();
    expect(readdirSync(dataDir)).not.toContain("recorder-demo");
  }, 40_000);

  it("step 4: a 1 request/s broker asked for 200 stocks answers 422 CAPACITY_EXCEEDED with canCarry; nothing changes", async () => {
    const stocks = Array.from({ length: 200 }, (_, i) => `STK${String(i).padStart(3, "0")}`);
    const b = await boot({ dataDir: mkdtempSync(join(tmpdir(), "mcb-rec-e2e4-")), start: Date.parse("2026-10-19T10:00:58+05:30"), brokerId: "dhan", stocks, recorder: { ...RECORDER, sources: { stream: true, rest: true } }, withConfigFile: true });
    open.push(b.bridge);
    await eventually(async () => ((await b.bridge.http("/v1/options/recorder", { key: b.key })).json?.data?.plan?.chains?.length ? true : null), { ms: 5000 });
    const before = (await b.bridge.http("/v1/options/recorder", { key: b.key })).json.data;
    const fileBefore = readFileSync(b.bridge.configFile);
    const r = await b.bridge.http("/v1/options/recorder/config", { method: "PUT", key: b.key, body: { stocks } });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("CAPACITY_EXCEEDED");
    expect(r.json.canCarry.indices).toEqual(["NIFTY"]);
    expect(r.json.canCarry.stocks.length).toBeLessThan(200);
    expect(r.json.refused.length).toBe(200 - r.json.canCarry.stocks.length);
    expect(r.json.detail).toMatch(/Nothing was saved/);
    const afterSt = (await b.bridge.http("/v1/options/recorder", { key: b.key })).json.data;
    expect(afterSt.settings.stocks).toEqual(before.settings.stocks);
    expect(afterSt.plan.chains).toEqual(before.plan.chains);
    // The real config file the Bridge was started from is byte for byte unchanged.
    expect(readFileSync(b.bridge.configFile).equals(fileBefore)).toBe(true);
    // ...and it is the file a change that fits is saved to (so the check above can fail).
    const ok = await b.bridge.http("/v1/options/recorder/config", { method: "PUT", key: b.key, body: { indexStrikes: 9 } });
    expect(ok.status).toBe(200);
    expect(ok.json.data.persisted).toBe(true);
    expect(JSON.parse(readFileSync(b.bridge.configFile, "utf8")).recorder.indexStrikes).toBe(9);
    await b.bridge.close();
  }, 30_000);

  it("step 5: demo mode back-fills today's minutes since 09:15 and daily rows for previous weekdays within 5 s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-rec-e2e5-"));
    const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
    const app = await createApp({ config, logger: createNullLogger(), clock: shiftedClock(Date.parse("2026-10-19T11:00:30+05:30")) });
    open.push(app);
    const { port } = await app.listen();
    const { key } = await app.deps.keyStore.create({ label: "t", scopes: ["read"], accounts: "*" });
    const get = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${key}` } })).json();
    const t0 = Date.now();
    const expiry = (await get("/v1/expiries?underlying=NIFTY")).data.expiries[0];
    const page = await eventually(
      async () => {
        const d = (await get(`/v1/options/snapshots?underlying=NIFTY&expiry=${expiry}&fields=oi,ltp&limit=500`)).data;
        return d?.snapshots?.length >= 100 ? d : null;
      },
      { ms: 5000, every: 100 },
    );
    expect(Date.now() - t0).toBeLessThan(5000);
    // Default range: today's session open (09:15) to now, one snapshot a minute.
    expect(page.snapshots[0].slot).toBe("2026-10-19T09:15:00.000+05:30");
    expect(page.snapshots.some((x) => x.quality === "demo-backfill")).toBe(true);
    expect(page.snapshots.every((x) => x.quality === "demo-backfill" || x.quality === "demo")).toBe(true);
    expect(page.snapshots.every((x) => x.ce.oi.every((v) => v === null || v % page.snapshots[0].lotSize === 0))).toBe(true);
    await app.deps.recorder.backfillDone();
    const daily = (await get("/v1/options/daily?underlying=NIFTY")).data.rows;
    expect([...new Set(daily.map((r) => r.date))].sort()).toEqual(expect.arrayContaining(["2026-10-15", "2026-10-16"]));
    expect(existsSync(join(dir, "recorder-demo"))).toBe(true);
    expect(existsSync(join(dir, "recorder"))).toBe(false);
    // The demo can show "cannot carry all of it": every index at 4 expiries is over the demo's REST budget, and the
    // page's "Use what fits" (fewer expiries) then saves, in memory only.
    const { key: admin } = await app.deps.keyStore.create({ label: "a", scopes: ["admin"], accounts: "*" });
    const put = async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/options/recorder/config`, { method: "PUT", headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    const over = await put({ indexExpiries: 4 });
    expect(over.status).toBe(422);
    expect(over.json.code).toBe("CAPACITY_EXCEEDED");
    expect(over.json.refused.length).toBeGreaterThan(0);
    // What the page's "Use what fits" sends: the carried indices and stocks (fewer expiries when an index lost some).
    const lostIndex = over.json.refused.some((r) => r.kind === "index");
    const fits = await put({ indices: over.json.canCarry.indices, stocks: over.json.canCarry.stocks, indexExpiries: lostIndex ? 3 : 4 });
    expect(fits.status).toBe(200);
    expect(fits.json.data.persisted).toBe(false);
    await app.close();
  }, 30_000);
});
