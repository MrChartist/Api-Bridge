/**
 * An order-records file that cannot even be opened (a folder in its place: EISDIR; the same road is taken for permission
 * denied or a lock) goes the way of a damaged one: set aside, a plain message, the damaged marker (live orders refused,
 * paper keeps working). It never ends the start-up with a raw stack trace.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadJsonOrQuarantine } from "../../lib/safeStore.mjs";
import { resetQuarantined } from "../../lib/storageHealth.mjs";
import { bootDemoBridge } from "../core/__fixtures__/demoBridge.mjs";
import { createStateFile } from "./stateFile.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "mcb-unreadable-"));
afterEach(() => resetQuarantined());

describe("a state file that cannot be opened", () => {
  it("loadJsonOrQuarantine does not throw: the folder is set aside and the reason is plain words", () => {
    const d = tmp();
    const f = join(d, "state.json");
    mkdirSync(f);
    const lines = [];
    const r = loadJsonOrQuarantine(f, { what: "order records (orders/state.json)", log: { warn: (m) => lines.push(m), error: (m) => lines.push(m) } });
    expect(r).toMatchObject({ value: null, missing: false });
    expect(r.reason).toBe("could not be opened (a folder is in its place, not a file)");
    expect(r.quarantinedTo).toMatch(/state\.json\.corrupt-/);
    expect(existsSync(f)).toBe(false);
    expect(lines.join(" ")).toMatch(/could not be opened \(a folder is in its place, not a file\)/);
    expect(lines.join(" ")).not.toMatch(/at .*\.mjs/); // no stack frames
  });

  it("the order state file marks itself damaged (live refused) and starts empty", () => {
    const d = tmp();
    mkdirSync(join(d, "state.json"));
    const f = createStateFile(join(d, "state.json"), { logger: { warn() {}, error() {} } });
    expect(f.read()).toBeNull();
    expect(f.damage()).toMatchObject({ reason: expect.stringMatching(/could not be opened/) });
    expect(readdirSync(d).some((n) => n.startsWith("state-damaged"))).toBe(true);
  });

  it("a Bridge starts with orders/state.json being a folder: paper orders work and health says why", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "orders", "state.json"), { recursive: true });
    const b = await bootDemoBridge({ raw: { dataDir: dir } });
    try {
      const health = await b.call("GET", "/v1/health");
      expect(JSON.stringify(health.json)).toMatch(/order_state_damaged|damaged/);
      const paper = await b.call("POST", "/v1/orders", { body: { account: "demo-paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "MIS", orderType: "MARKET" } });
      expect(paper.status, paper.text).toBe(201);
    } finally {
      await b.close();
    }
  });
});
