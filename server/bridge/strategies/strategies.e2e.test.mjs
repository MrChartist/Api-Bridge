/**
 * Python strategies end to end (docs/STRATEGIES-PYTHON.md): a real demo Bridge on 127.0.0.1, real python3 child
 * processes running small strategies from a temporary strategies folder. Paper orders through POST /v1/orders, the
 * per-run key, logs, Stop, crash restart and give-up, per-order limits, the kill switch and the live refusals.
 * Skipped when python3 is not installed.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";

let hasPython = true;
try {
  execFileSync("python3", ["--version"], { stdio: "ignore" });
} catch {
  hasPython = false;
}

const BUYER = `
from mrchartist_bridge.strategy import Param, Strategy

class Buyer(Strategy):
    name = "Buyer"
    description = "Buys one ATM call, holds it, sells it on stop."
    timer_seconds = 1
    params = {"lots": Param(1, min=1, max=50, help="Lots"), "side": Param("CE", choices=["CE", "PE"])}

    def on_start(self):
        expiry = self.nearest_expiry("NIFTY")
        chain = self.option_chain("NIFTY", expiry, strikes=1, greeks=False)
        row = next(r for r in chain["rows"] if r["strike"] == chain["atmStrike"])
        self.sym = row[self.p.side.lower()]["symbol"]
        self.subscribe(self.sym)
        try:
            self.buy(self.sym, lots=self.p.lots)
        except Exception as e:
            self.log.warn("entry refused: %s", getattr(e, "code", e))

    def on_timer(self):
        self.log.debug("pnl %s", self.pnl()["total"])

    def on_stop(self):
        self.exit_all()
`;

const CRASHER = `
from mrchartist_bridge.strategy import Strategy

class Crasher(Strategy):
    name = "Crasher"
    def on_start(self):
        raise RuntimeError("boom on purpose")
`;

const BAD = `
from mrchartist_bridge.strategy import Param, Strategy

class Bad(Strategy):
    params = {"x": Param(open("/etc/passwd").read())}
`;

let app;
let base;
let admin;
let live;
let dir;

beforeAll(async () => {
  if (!hasPython) return;
  const home = mkdtempSync(join(tmpdir(), "mcb-strat-e2e-"));
  dir = join(home, "strategies");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  const write = (name, text, mode = 0o644) => {
    writeFileSync(join(dir, name), text);
    chmodSync(join(dir, name), mode);
  };
  write("buyer.py", BUYER);
  write("crasher.py", CRASHER);
  write("bad.py", BAD);
  write("_helper.py", "X = 1\n");
  write("shared.py", BUYER.replace("Buyer", "Shared"), 0o666);
  symlinkSync(join(dir, "buyer.py"), join(dir, "linked.py"));
  const { config } = loadConfig({
    raw: { dataDir: join(home, "data"), server: { port: 0 }, logging: { level: "silent" }, strategies: { restartBackoffMs: 100, maxRestarts: 2, stopGraceMs: 4000 } },
    env: {},
    demo: true,
  });
  app = await createApp({ config, logger: createNullLogger() });
  const { port } = await app.listen();
  base = `http://127.0.0.1:${port}`;
  ({ key: admin } = await app.deps.keyStore.create({ label: "t", scopes: ["admin", "paper"], accounts: "*" }));
  ({ key: live } = await app.deps.keyStore.create({ label: "t-live", scopes: ["admin", "live"], accounts: "*" }));
}, 60_000);

afterAll(async () => {
  await app?.close();
}, 30_000);

const call = async (path, { method = "GET", body, key = admin } = {}) => {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const strategy = async (id) => (await call(`/v1/strategies/${id}`)).body.data;
async function until(fn, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}
const logText = async (id) => (await call(`/v1/strategies/${id}/logs`)).body.data.items.map((l) => `${l.level} ${l.text}`).join("\n");

describe.skipIf(!hasPython)("Python strategies end to end (demo)", () => {
  it("lists the folder: params read without running the file, helpers ignored, unsafe files skipped", async () => {
    const r = await call("/v1/strategies");
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.items.map((s) => s.id)).toEqual(["bad", "buyer", "crasher"]);
    const buyer = d.items.find((s) => s.id === "buyer");
    expect(buyer).toMatchObject({ name: "Buyer", status: "stopped", mode: "paper", problem: null });
    expect(buyer.params).toEqual([
      { name: "lots", kind: "int", default: 1, min: 1, max: 50, help: "Lots" },
      { name: "side", kind: "choice", default: "CE", choices: ["CE", "PE"] },
    ]);
    // Describe never runs the file: the open() call is not a literal, so it is a problem, not a read of /etc/passwd.
    expect(d.items.find((s) => s.id === "bad").problem).toMatch(/literal values only/);
    expect(d.skipped.map((s) => s.file).sort()).toEqual(["linked.py", "shared.py"]);
    expect(d.skipped.find((s) => s.file === "linked.py").reason).toMatch(/Symbolic links/);
    expect(d.skipped.find((s) => s.file === "shared.py").reason).toMatch(/other users can change/i);
  });

  it("names are ids only: nothing outside the folder can be asked for", async () => {
    for (const p of ["/v1/strategies/..%2Fbuyer", "/v1/strategies/Buyer", "/v1/strategies/_helper", "/v1/strategies/linked", "/v1/strategies/shared"]) {
      expect((await call(p)).status, p).toBe(404);
    }
    expect((await call("/v1/strategies/linked/start", { method: "POST", body: { account: "demo-paper" } })).status).toBe(404);
  });

  it("refuses a bad param and an unknown one before starting anything", async () => {
    const r = await call("/v1/strategies/buyer/start", { method: "POST", body: { account: "demo-paper", params: { lots: 0, nope: 1 } } });
    expect(r.status).toBe(400);
    expect(r.body.errors.map((e) => e.path).sort()).toEqual(["params.lots", "params.nope"]);
    expect((await strategy("buyer")).status).toBe("stopped");
  });

  it("starts in paper with a key for this run only, places a real paper order, logs it, and stops cleanly", async () => {
    const r = await call("/v1/strategies/buyer/start", { method: "POST", body: { account: "demo-paper", params: { lots: 1 } } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: "starting", account: "demo-paper", mode: "paper" });
    const keys = (await app.deps.keyStore.list()).filter((k) => k.label === "Algo buyer" && !k.revokedAt);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ scopes: ["paper"], accounts: ["demo-paper"], clientKind: "script" });
    const s = await until(async () => {
      const x = await strategy("buyer");
      return x.status === "running" && x.orders.length >= 1 ? x : null;
    });
    expect(s.orders[0]).toMatchObject({ mode: "paper", side: "BUY", status: "filled", accountId: "demo-paper", source: "rest" });
    expect(s.orders[0].clientOrderId).toMatch(/^A-buyer-[a-z0-9]{6}-1$/);
    expect(s.positions.find((p) => p.qty > 0)).toBeTruthy();
    expect(s.pnl).toMatchObject({ open: 1 });
    // The order is in Orders like any other.
    const book = await call("/v1/orders?account=demo-paper&limit=500");
    expect(book.body.data.some((o) => o.orderId === s.orders[0].orderId)).toBe(true);
    expect(await logText("buyer")).toMatch(/BUY 1 lot NFO:NIFTY-.*filled/);
    await until(async () => (await strategy("buyer")).heartbeatAgeMs !== null);

    const stop = await call("/v1/strategies/buyer/stop", { method: "POST" });
    expect(stop.status).toBe(200);
    const done = await until(async () => {
      const x = await strategy("buyer");
      return x.status === "stopped" ? x : null;
    });
    // on_stop sold what it held; the run's key is revoked.
    expect(done.orders.map((o) => o.side).sort()).toEqual(["BUY", "SELL"]);
    expect(done.pnl.open).toBe(0);
    expect(done.lastExit).toMatchObject({ code: 0 });
    await until(async () => (await app.deps.keyStore.list()).filter((k) => k.label === "Algo buyer" && !k.revokedAt).length === 0);
  }, 60_000);

  it("a strategy cannot get past the per-order limits: the Bridge refuses the order and the strategy keeps running", async () => {
    const r = await call("/v1/strategies/buyer/start", { method: "POST", body: { account: "demo-paper", params: { lots: 20 } } });
    expect(r.status).toBe(200);
    await until(async () => /entry refused/.test(await logText("buyer")));
    const log = await logText("buyer");
    expect(log).toMatch(/Order refused: BUY 20 lots .*\(INVALID_ORDER|Order refused: BUY 20 lots .*(LOT|limit|lots)/i);
    const s = await strategy("buyer");
    expect(["running", "starting"]).toContain(s.status);
    expect(s.orders.filter((o) => o.side === "BUY")).toHaveLength(1); // only the earlier run's order
    await call("/v1/strategies/buyer/stop", { method: "POST" });
    await until(async () => (await strategy("buyer")).status === "stopped");
  }, 60_000);

  it("a crash restarts with back-off, then gives up after maxRestarts", async () => {
    expect((await call("/v1/strategies/crasher/start", { method: "POST", body: { account: "demo-paper" } })).status).toBe(200);
    const s = await until(async () => {
      const x = await strategy("crasher");
      return x.status === "failed" ? x : null;
    }, 45_000);
    expect(s.restarts).toBe(2);
    expect(s.lastError).toMatch(/gave up/);
    expect(s.lastError).toMatch(/boom on purpose/);
    const log = await logText("crasher");
    expect(log).toMatch(/Restarting in 0 s \(restart 1 of 2\)/);
    expect(log).toMatch(/restart 2 of 2/);
    await until(async () => (await app.deps.keyStore.list()).filter((k) => k.label === "Algo crasher" && !k.revokedAt).length === 0);
  }, 60_000);

  it("live needs the second confirmation, a live key and every live gate; the demo refuses it", async () => {
    let r = await call("/v1/strategies/buyer/start", { method: "POST", body: { account: "demo-paper", mode: "live" } });
    expect([r.status, r.body.code]).toEqual([422, "CONFIRMATION_REQUIRED"]);
    r = await call("/v1/strategies/buyer/start", { method: "POST", body: { account: "demo-paper", mode: "live", confirmLive: "buyer" } });
    expect([r.status, r.body.code]).toEqual([403, "SCOPE_REQUIRED"]);
    r = await call("/v1/strategies/buyer/start", { method: "POST", body: { account: "demo-paper", mode: "live", confirmLive: "buyer" }, key: live });
    expect([r.status, r.body.code]).toEqual([403, "PAPER_ONLY"]);
    r = await call("/v1/strategies/buyer/start", { method: "POST", body: { account: "demo", mode: "live", confirmLive: "buyer" }, key: live });
    expect([r.status, r.body.code]).toEqual([403, "PAPER_ONLY"]);
    expect((await strategy("buyer")).status).toBe("stopped");
    expect((await app.deps.keyStore.list()).filter((k) => k.label === "Algo buyer" && !k.revokedAt)).toHaveLength(0);
  });

  it("the kill switch stops every strategy and no strategy starts while it is on", async () => {
    expect((await call("/v1/strategies/buyer/start", { method: "POST", body: { account: "demo-paper", params: { lots: 1 } } })).status).toBe(200);
    await until(async () => (await strategy("buyer")).status === "running");
    expect((await call("/v1/safety/kill-switch", { method: "POST", body: { reason: "test" } })).status).toBe(200);
    const s = await until(async () => {
      const x = await strategy("buyer");
      return x.status === "stopped" ? x : null;
    });
    expect(s.stopReason).toMatch(/Kill switch/);
    const r = await call("/v1/strategies/buyer/start", { method: "POST", body: { account: "demo-paper" } });
    expect([r.status, r.body.code]).toEqual([423, "KILL_SWITCH_ACTIVE"]);
    expect((await call("/v1/safety/kill-switch", { method: "DELETE", body: { confirm: "RELEASE" } })).status).toBe(200);
  }, 60_000);

  it("only admin keys from this computer reach the routes", async () => {
    const { key: paper } = await app.deps.keyStore.create({ label: "p", scopes: ["paper"], accounts: "*" });
    expect((await call("/v1/strategies", { key: paper })).status).toBe(403);
    expect((await call("/v1/strategies/buyer/start", { method: "POST", body: { account: "demo-paper" }, key: paper })).status).toBe(403);
  });
});
