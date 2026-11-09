// The Node examples parse, and the ones that finish run against the fake Bridge. Run: node --test sdk/node/test/
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { bars } from "./fakeData.mjs";
import { TEST_KEY, createFakeBridge } from "./fakeServer.mjs";

const EX = fileURLToPath(new URL("../examples/", import.meta.url));
let fake;
let baseUrl;

before(async () => {
  fake = createFakeBridge();
  baseUrl = `http://127.0.0.1:${await fake.listen()}`;
});
after(async () => {
  await fake.close();
});

// Async on purpose: the fake Bridge lives in this process, so it must keep serving while the example runs.
const run = (script, args = [], cwd = os.tmpdir()) =>
  new Promise((resolve) =>
    execFile(process.execPath, [path.join(EX, script), ...args], { cwd, encoding: "utf8", timeout: 60_000, env: { ...process.env, MCB_BRIDGE_URL: baseUrl, MCB_API_KEY: TEST_KEY, NODE_OPTIONS: "" } }, (err, stdout, stderr) =>
      resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));

describe("examples", () => {
  for (const f of fs.readdirSync(EX).filter((n) => n.endsWith(".mjs"))) {
    it(`${f} parses`, () => {
      const r = spawnSync(process.execPath, ["--check", path.join(EX, f)], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    });
  }

  it("download-save runs: progress, saved files with a manifest, rows read back", async () => {
    fake.reset();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcb-ex-"));
    const r = await run("download-save.mjs", [path.join(dir, "data")]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /saved .*NSE-RELIANCE_5m\.csv/);
    assert.match(r.stdout, /6 rows/);
    assert.ok(fs.existsSync(path.join(dir, "data", "manifest.json")));
  });

  it("history-all runs and reports the label", async () => {
    fake.reset();
    fake.data.historySeries.set("NSE:RELIANCE", bars(1_760_000_000, 20));
    const r = await run("history-all.mjs", ["NSE:RELIANCE", "5m", "2025-10-01"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /20 candles/);
    assert.match(r.stdout, /label: realtime from broker/);
    assert.match(r.stdout, /time,open,high,low,close,volume,source,class/);
  });
});
