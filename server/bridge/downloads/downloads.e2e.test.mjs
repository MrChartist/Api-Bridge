/**
 * Downloads on the REAL Bridge: every built-in module, a real HTTP listener, a stub broker. Scopes, the streamed files,
 * the manifest, datasets, the instrument export, and the saved-calls numbers in /v1/limits?explain=1.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../core/cli.mjs";
import { bootBridge, eventually, stubBroker } from "../e2e/fixtures.mjs";

let bridge;
let broker;
const keys = {};
const events = [];

beforeAll(async () => {
  broker = stubBroker("zerodha");
  bridge = await bootBridge({
    brokers: { zerodha: broker },
    raw: { accounts: [{ id: "zerodha-a", broker: "zerodha", label: "Main" }, { id: "paper", broker: "paper" }], downloads: { maxBudgetShare: 0.5, progressThrottleMs: 100 } },
    withConfigFile: true,
  });
  const mk = async (label, scopes, accounts = "*") => (await bridge.deps.keyStore.create({ label, scopes, accounts, expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  keys.read = await mk("read", ["read"]);
  keys.admin = await mk("admin", ["admin"]);
  keys.paper = await mk("paper-only", ["read"], ["paper"]);
  const r = await bridge.http("/v1/accounts/zerodha-a/session", { method: "POST", key: keys.admin, body: { values: { apiKey: "k", accessToken: "token-zerodha-a" } } });
  expect(r.json.data.state).toBe("connected");
  await bridge.deps.symbols.refresh();
  for (const t of ["download.progress", "download.done", "download.failed"]) bridge.deps.bus.on(t, (e) => events.push({ topic: t, ...e }));
});
afterAll(async () => {
  await bridge?.close();
});

const post = (path, body, key = keys.read) => bridge.http(path, { method: "POST", key, body });
const waitJob = (id, key = keys.read) =>
  eventually(async () => {
    const j = (await bridge.http(`/v1/downloads/${id}`, { key })).json.data;
    return ["done", "failed", "cancelled"].includes(j.status) ? j : null;
  }, { ms: 15_000, every: 50 });

const BODY = { name: "reliance daily", symbols: ["NSE:RELIANCE", "NSE:INFY"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-16" };

describe("estimate and start", () => {
  it("refuses an unknown symbol with a 400 that names it and suggests the closest, and an expired one unless allowExpired", async () => {
    const bad = await post("/v1/downloads", { ...BODY, symbols: ["NSE:RELIANC", "NSE:INFY"] });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("VALIDATION_FAILED");
    expect(bad.json.detail).toContain("NSE:RELIANC");
    expect(bad.json.unknownSymbols.map((u) => u.symbol)).toEqual(["NSE:RELIANC"]);
    expect(bad.json.unknownSymbols[0].suggestions.length).toBeGreaterThan(0);
    const expired = await post("/v1/downloads?dryRun=1", { ...BODY, symbols: ["NFO:NIFTY-2020-01-30-12000-CE"] });
    expect(expired.status).toBe(400);
    expect(expired.json.detail).toContain("allowExpired");
    const allowed = await post("/v1/downloads?dryRun=1", { ...BODY, symbols: ["NFO:NIFTY-2020-01-30-12000-CE"], allowExpired: true });
    expect(allowed.status).toBe(200);
  });

  it("needs a key, and a dryRun starts nothing", async () => {
    expect((await bridge.http("/v1/downloads", { method: "POST", body: BODY })).status).toBe(401);
    const dry = await post("/v1/downloads?dryRun=1", BODY);
    expect(dry.status).toBe(200);
    expect(dry.json.data).toMatchObject({ symbols: 2, intervals: 1, items: 2, account: "zerodha-a", broker: "zerodha", budgetShare: 0.5 });
    expect(dry.json.data.brokerCalls).toBeGreaterThanOrEqual(2);
    expect(dry.json.data.rows).toBe(22); // 11 trading days (2 October is a holiday) x 2 symbols
    expect(dry.json.data.etaSec).toBeGreaterThan(0);
    expect(dry.json.meta.dryRun).toBe(true);
    expect((await bridge.http("/v1/downloads", { key: keys.read })).json.data).toEqual([]);
    expect(broker.calls.filter((c) => c.method === "fetchHistorical")).toEqual([]);
    expect((await post("/v1/downloads?dryRun=maybe", BODY)).status).toBe(400);
  });

  it("answers 202 with the job, runs it, and serves the files with their data class", async () => {
    const res = await post("/v1/downloads", BODY);
    expect(res.status).toBe(202);
    expect(res.headers.get("location")).toBe(`/v1/downloads/${res.json.data.id}`);
    const id = res.json.data.id;
    expect(res.json.data).toMatchObject({ status: "queued", name: "reliance daily", manifestUrl: `/v1/downloads/${id}/files/manifest.json` });
    const done = await waitJob(id);
    expect(done).toMatchObject({ status: "done", dataClass: "realtime", source: "zerodha", official: true });
    expect(done.progress).toMatchObject({ total: 2, done: 2, failed: 0 });
    expect(done.items.map((i) => i.status)).toEqual(["done", "done"]);

    const list = await bridge.http("/v1/downloads?status=done", { key: keys.read });
    expect(list.json.data.map((j) => j.id)).toContain(id);
    expect(list.json.data[0].items).toBeUndefined();
    expect((await bridge.http("/v1/downloads?include=items", { key: keys.read })).json.data[0].items).toHaveLength(2);
    expect((await bridge.http("/v1/downloads?status=nope", { key: keys.read })).status).toBe(400);

    const files = await bridge.http(`/v1/downloads/${id}/files`, { key: keys.read });
    expect(files.json.data.map((f) => f.name).sort()).toEqual(["NSE_INFY_1d.csv", "NSE_RELIANCE_1d.csv"]);
    const f = files.json.data.find((x) => x.symbol === "NSE:RELIANCE");
    expect(f.rows).toBe(12);

    const file = await fetch(`${bridge.base}/v1/downloads/${id}/files/${f.name}`, { headers: { authorization: `Bearer ${keys.read}` } });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toMatch(/text\/csv/);
    expect(file.headers.get("content-disposition")).toContain("NSE_RELIANCE_1d.csv");
    expect(file.headers.get("x-data-class")).toBe("realtime");
    expect(file.headers.get("x-data-source")).toBe("zerodha");
    expect(file.headers.get("x-data-official")).toBe("true");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("x-request-id")).toMatch(/^req_/);
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.length).toBe(f.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(f.sha256);
    expect(bytes.toString("utf8").split("\r\n")[0]).toBe("time,open,high,low,close,volume,oi");

    const manifest = (await bridge.http(`/v1/downloads/${id}/files/manifest.json`, { key: keys.read })).json;
    expect(manifest).toMatchObject({ id, status: "done", dataClass: "realtime", source: "zerodha" });
    expect(manifest.files).toHaveLength(2);

    expect(events.some((e) => e.topic === "download.done" && e.id === id)).toBe(true);
    expect(events.some((e) => e.topic === "download.progress" && e.id === id)).toBe(true);
    // downloads are background reads
    expect(bridge.deps.scheduler.usage().accounts.length).toBeGreaterThan(0);
  });

  it("refuses names that are not files of the job, and ids that are not job ids", async () => {
    const id = (await bridge.http("/v1/downloads", { key: keys.read })).json.data[0].id;
    for (const name of ["job.json", "..%2Fjob.json", "parts", "%2e%2e%2f%2e%2e%2fkeys.json", "NSE_RELIANCE_1d.csv.bak"]) {
      const r = await bridge.http(`/v1/downloads/${id}/files/${name}`, { key: keys.read });
      expect([400, 404], `${name} -> ${r.status}`).toContain(r.status);
    }
    expect((await bridge.http("/v1/downloads/dl_000000000000", { key: keys.read })).status).toBe(404);
    expect((await bridge.http("/v1/downloads/..%2F..%2Fkeys", { key: keys.read })).status).toBe(404);
    expect((await bridge.http("/v1/downloads/not-an-id", { key: keys.read })).json.code).toBe("NOT_FOUND");
  });

  it("validates the body strictly and keeps a key to its accounts", async () => {
    expect((await post("/v1/downloads", { ...BODY, surprise: 1 })).status).toBe(400);
    expect((await post("/v1/downloads", { intervals: ["1d"], from: "2026-10-01" })).status).toBe(400);
    expect((await post("/v1/downloads", { ...BODY, symbols: Array.from({ length: 501 }, (_, i) => `NSE:S${i}`) })).status).toBe(400);
    const wrongAccount = await post("/v1/downloads", { ...BODY, account: "zerodha-a" }, keys.paper);
    expect(wrongAccount.status).toBe(403);
    expect(wrongAccount.json.code).toBe("ACCOUNT_FORBIDDEN");
    expect((await bridge.http("/v1/downloads", { method: "POST", key: keys.read, body: "{nope", headers: { "content-type": "application/json" } })).status).toBe(400);
  });

  it("pauses, resumes and cancels over HTTP", async () => {
    const res = await post("/v1/downloads", { symbols: ["NSE:RELIANCE", "NSE:INFY", "NSE:TCS"], intervals: ["1d"], from: "2026-09-01", to: "2026-09-30" });
    const id = res.json.data.id;
    const paused = await post(`/v1/downloads/${id}/pause`);
    // the job may already have finished (it is small); both answers are honest
    expect([200, 409]).toContain(paused.status);
    if (paused.status === 200) {
      expect(paused.json.data).toMatchObject({ status: "paused", reason: "user" });
      expect((await post(`/v1/downloads/${id}/pause`)).status).toBe(409);
      expect(["queued", "running"]).toContain((await post(`/v1/downloads/${id}/resume`)).json.data.status);
    }
    expect((await waitJob(id)).status).toBe("done");
    expect((await post(`/v1/downloads/${id}/cancel`)).status).toBe(409);
  });
});

describe("delete needs an admin key from this computer", () => {
  it("refuses a read key and a remote caller, and removes the folder for an admin", async () => {
    const id = (await post("/v1/downloads", { ...BODY, name: "to delete" })).json.data.id;
    await waitJob(id);
    expect((await bridge.http(`/v1/downloads/${id}`, { method: "DELETE", key: keys.read })).status).toBe(403);
    const far = await bridge.http(`/v1/downloads/${id}`, { method: "DELETE", key: keys.admin, headers: { "X-Forwarded-For": "192.0.2.5" } });
    expect(far.status).toBe(403);
    expect(far.json.code).toBe("LOOPBACK_ONLY");
    expect((await bridge.http(`/v1/downloads/${id}`, { method: "DELETE", key: keys.admin })).status).toBe(204);
    expect(existsSync(join(bridge.dataDir, "downloads", "jobs", id))).toBe(false);
    expect((await bridge.http(`/v1/downloads/${id}`, { key: keys.read })).status).toBe(404);
  });
});

describe("settings: GET /v1/downloads/settings and PATCH", () => {
  it("is not read as a download id; a read key reads, only an admin key from this computer changes", async () => {
    const got = await bridge.http("/v1/downloads/settings", { key: keys.read });
    expect(got.status).toBe(200);
    expect(got.json.data).toMatchObject({ maxBudgetShare: 0.5, afterHoursOnly: false, limits: { minBudgetShare: 0.05, maxBudgetShare: 0.8 } });
    expect((await bridge.http("/v1/downloads/settings")).status).toBe(401);
    const patch = (body, o = {}) => bridge.http("/v1/downloads/settings", { method: "PATCH", key: keys.admin, body, ...o });
    expect((await patch({ maxBudgetShare: 0.6 }, { key: keys.read })).status).toBe(403);
    const far = await patch({ maxBudgetShare: 0.6 }, { headers: { "X-Forwarded-For": "192.0.2.5" } });
    expect(far.status).toBe(403);
    expect(far.json.code).toBe("LOOPBACK_ONLY");
    const bad = await patch({ maxBudgetShare: 0.95 });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("VALIDATION_FAILED");
    expect((await patch({ maxBudgetShare: 0.6, afterHoursOnly: true })).json.data).toMatchObject({ maxBudgetShare: 0.6, afterHoursOnly: true });
    // applied at once, with no restart: the estimate uses the new share; the saved file is not the config file
    expect((await post("/v1/downloads?dryRun=1", BODY)).json.data.budgetShare).toBe(0.6);
    expect(JSON.parse(readFileSync(join(bridge.dataDir, "downloads", "settings.json"), "utf8"))).toEqual({ maxBudgetShare: 0.6, afterHoursOnly: true });
    expect(JSON.parse(readFileSync(bridge.configFile, "utf8")).downloads.maxBudgetShare).toBe(0.5);
    await patch({ maxBudgetShare: 0.5, afterHoursOnly: false });
  });
});

describe("datasets", () => {
  it("grow by update, take tags, and are listed and filtered", async () => {
    const j = await post("/v1/downloads", { symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", dataset: "reliance-1d", tags: ["eq"] });
    expect(j.status).toBe(202);
    const done = await waitJob(j.json.data.id);
    expect(done.dataset).toBe("reliance-1d");
    const list = await bridge.http("/v1/datasets", { key: keys.read });
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0]).toMatchObject({ name: "reliance-1d", format: "csv", series: 1, tags: ["eq"], dataClass: "realtime" });
    expect((await bridge.http("/v1/datasets?tag=eq", { key: keys.read })).json.data).toHaveLength(1);
    expect((await bridge.http("/v1/datasets?tag=other", { key: keys.read })).json.data).toHaveLength(0);
    const one = (await bridge.http("/v1/datasets/reliance-1d", { key: keys.read })).json.data;
    expect(one.files[0]).toMatchObject({ symbol: "NSE:RELIANCE", interval: "1d", name: "NSE_RELIANCE_1d.csv", rows: 12 });
    expect(one.files[0].coverage.from).toBeTruthy();
    expect((await bridge.http("/v1/datasets/Bad%20Name", { key: keys.read })).status).toBe(404);
    expect((await bridge.http("/v1/datasets/nothing", { key: keys.read })).status).toBe(404);

    const calls = broker.calls.filter((c) => c.method === "fetchHistorical").length;
    const upd = await post("/v1/datasets/reliance-1d/update");
    expect(upd.status).toBe(202);
    await waitJob(upd.json.data.id);
    // the 19 October bar is the last finished one at 10:00 on the 19th; nothing new, so no further broker call
    expect(broker.calls.filter((c) => c.method === "fetchHistorical").length).toBe(calls);

    const patched = await bridge.http("/v1/datasets/reliance-1d", { method: "PATCH", key: keys.read, body: { tags: ["daily", "eq"], title: "Reliance daily" } });
    expect(patched.json.data).toMatchObject({ tags: ["daily", "eq"], title: "Reliance daily" });
    expect((await bridge.http("/v1/datasets/reliance-1d", { method: "DELETE", key: keys.read })).status).toBe(403);
    expect((await bridge.http("/v1/datasets/reliance-1d", { method: "DELETE", key: keys.admin })).status).toBe(204);
    expect((await bridge.http("/v1/datasets", { key: keys.read })).json.data).toEqual([]);
  });
});

describe("instrument export", () => {
  it("streams the master as CSV or JSONL, filtered", async () => {
    const csv = await fetch(`${bridge.base}/v1/instruments/export?exchange=NSE&kind=EQ`, { headers: { authorization: `Bearer ${keys.read}` } });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/instruments-\d{4}-\d{2}-\d{2}\.csv/);
    const lines = (await csv.text()).split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("symbol,exchange,kind,underlying,name,expiry,strike,right,lotSize,tickSize,freezeQty,isin");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((l) => l.startsWith("NSE:RELIANCE,NSE,EQ,"))).toBe(true);
    const jsonl = await fetch(`${bridge.base}/v1/instruments/export?format=jsonl`, { headers: { authorization: `Bearer ${keys.read}` } });
    const rows = (await jsonl.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.find((r) => r.symbol === "NSE:RELIANCE")).toMatchObject({ exchange: "NSE", kind: "EQ", lotSize: 1 });
    expect((await bridge.http("/v1/instruments/export?format=xml", { key: keys.read })).status).toBe(400);
    expect((await bridge.http("/v1/instruments/export?exchange=LSE", { key: keys.read })).status).toBe(400);
    expect((await bridge.http("/v1/instruments/export")).status).toBe(401);
    // the static route wins over /v1/instruments/{symbol}
    expect((await bridge.http("/v1/instruments/NSE:RELIANCE", { key: keys.read })).json.data.symbol).toBe("NSE:RELIANCE");
  });
});

describe("calls saved", () => {
  it("shows in GET /v1/limits?explain=1 next to what the scheduler saved", async () => {
    const r = await bridge.http("/v1/limits?explain=1", { key: keys.read });
    expect(r.status).toBe(200);
    expect(r.json.data.savedCalls).toMatchObject({ total: expect.any(Number), byReason: expect.any(Object), scheduler: { servedFromStream: expect.any(Number), servedFromCache: expect.any(Number), coalesced: expect.any(Number), batched: expect.any(Number) }, totalToday: expect.any(Number) });
    expect((await bridge.http("/v1/limits", { key: keys.read })).json.data.savedCalls).toBeUndefined();
  });

  it("a second download of a stored range makes no broker call and counts the saving", async () => {
    const a = await post("/v1/downloads", { symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-09-01", to: "2026-09-30", dataset: "sept" });
    await waitJob(a.json.data.id);
    const before = broker.calls.filter((c) => c.method === "fetchHistorical").length;
    const b = await post("/v1/downloads", { symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-09-05", to: "2026-09-20" });
    const done = await waitJob(b.json.data.id);
    expect(broker.calls.filter((c) => c.method === "fetchHistorical").length).toBe(before);
    expect(done.callsSaved).toBeGreaterThanOrEqual(1);
    expect(done.notes.join(" ")).toMatch(/came from dataset sept/);
    const limits = (await bridge.http("/v1/limits?explain=1", { key: keys.read })).json.data.savedCalls;
    expect(limits.byReason["local-dataset"]).toBeGreaterThanOrEqual(1);
    // the same count is in GET /v1/usage, which is what the Data page's "API calls saved today" reads
    expect((await bridge.http("/v1/usage", { key: keys.read })).json.data.savings.servedFromLocal).toBe(limits.total);
    expect(readFileSync(join(bridge.dataDir, "downloads", "jobs", b.json.data.id, "NSE_RELIANCE_1d.csv"), "utf8").split("\r\n").filter(Boolean)).toHaveLength(1 + 10);
  });
});

describe("GET /v1/history from a dataset", () => {
  it("reads a stored range from disk with no broker call, and says so", async () => {
    const before = broker.calls.filter((c) => c.method === "fetchHistorical").length;
    const r = await bridge.http("/v1/history?symbol=NSE:RELIANCE&interval=1d&from=2026-09-07&to=2026-09-11&dataset=sept", { key: keys.read });
    expect(r.status).toBe(200);
    expect(r.json.meta).toMatchObject({ source: "local", dataset: "sept", brokerCalls: 0, localBars: 5 });
    expect(r.json.data.candles).toHaveLength(5);
    expect(r.json.data.freshness).toMatchObject({ provider: "dataset:sept", class: "realtime", flags: ["local"] });
    expect(r.headers.get("x-mcb-local")).toBe("local");
    expect(broker.calls.filter((c) => c.method === "fetchHistorical").length).toBe(before);
    const csv = await bridge.http("/v1/history?symbol=NSE:RELIANCE&interval=1d&from=2026-09-07&to=2026-09-11&dataset=sept&format=csv", { key: keys.read });
    expect(csv.text.split("\r\n")[0]).toBe("time,open,high,low,close,volume,oi");
  });

  it("is a 404 for a dataset without that series and a 400 for a bad name, and the plain route is unchanged", async () => {
    expect((await bridge.http("/v1/history?symbol=NSE:INFY&interval=1d&from=2026-09-07&to=2026-09-11&dataset=sept", { key: keys.read })).status).toBe(404);
    expect((await bridge.http("/v1/history?symbol=NSE:INFY&interval=1d&from=2026-09-07&dataset=Bad%20Name", { key: keys.read })).status).toBe(400);
    const plain = await bridge.http("/v1/history?symbol=NSE:RELIANCE&interval=1d&from=2026-09-07&to=2026-09-11", { key: keys.read });
    expect(plain.status).toBe(200);
    expect(plain.json.meta.source).toBeUndefined();
  });
});

describe("mc-bridge download, on this computer", () => {
  it("needs no key: the local control token is enough, and the files can be saved with their checksums", async () => {
    const out = [];
    const err = [];
    const io = { out: (x) => out.push(x), err: (x) => err.push(x), env: {}, cwd: bridge.dataDir, sleep: async () => {} };
    const flags = { config: bridge.configFile, url: bridge.base, interval: "1d", from: "2026-10-01", to: "2026-10-05", watch: true };
    expect(await runCli(["download", "NSE:TCS"], flags, io)).toBe(0);
    expect(err).toEqual([]);
    const text = out.join("\n");
    expect(text).toMatch(/Started dl_[0-9a-f]{12}/);
    expect(text).toMatch(/done/);
    const id = /dl_[0-9a-f]{12}/.exec(text)[0];
    const dir = join(bridge.dataDir, "saved");
    out.length = 0;
    expect(await runCli(["download", "files", id], { ...flags, out: dir, watch: undefined }, io)).toBe(0);
    expect(out.join("\n")).toMatch(/checksum matches/);
    expect(existsSync(join(dir, "NSE_TCS_1d.csv"))).toBe(true);
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    out.length = 0;
    expect(await runCli(["download", "list"], { ...flags, watch: undefined }, io)).toBe(0);
    expect(out.join("\n")).toContain(id);
    // deleting needs this computer's admin; the control token acts as the local administrator
    expect(await runCli(["download", "delete", id], { ...flags, watch: undefined }, io)).toBe(0);
    expect(existsSync(join(bridge.dataDir, "downloads", "jobs", id))).toBe(false);
  });

  it("says so plainly when the Bridge is not running", async () => {
    const err = [];
    const io = { out: () => {}, err: (x) => err.push(x), env: {}, cwd: bridge.dataDir, sleep: async () => {} };
    expect(await runCli(["download", "list"], { config: bridge.configFile, url: "http://127.0.0.1:9" }, io)).toBe(1);
    expect(err.join("\n")).toMatch(/The Bridge is not running/);
  });
});
