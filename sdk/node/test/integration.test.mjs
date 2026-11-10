// Node SDK against the real Bridge routes (an in-process demo Bridge on 127.0.0.1, sample data, paper account; nothing
// leaves this computer). The other test files use a fake server whose shapes can drift from the real ones; this one cannot.
// Skipped when the repository's Bridge or its dependencies are not there (the SDK is also published on its own).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { BridgeClient, optionUniverse } from "../src/index.mjs";

let demo = null;
let skip = false;
let bridge;

before(async () => {
  try {
    const fixture = await import("../../../server/bridge/core/__fixtures__/demoBridge.mjs");
    demo = await fixture.bootDemoBridge({ raw: { events: { webhooks: { allowPrivateTargets: true } } } });
    bridge = new BridgeClient({ baseUrl: demo.base, apiKey: demo.key, account: "demo-paper" });
  } catch (err) {
    skip = `the repository's Bridge is not available (${String(err?.message ?? err).slice(0, 80)})`;
  }
});
after(async () => {
  await demo?.close();
});

describe("Node SDK against a real demo Bridge", () => {
  it("downloads and datasets: create, wait, files, save, read, edit, update", async (t) => {
    if (skip) return t.skip(skip);
    const job = await bridge.downloads.create({ symbols: ["NSE:RELIANCE"], intervals: "1d", from: "2026-10-01", to: "2026-10-30", dataset: "node-ds" });
    const done = await bridge.downloads.wait(job, { timeoutMs: 60_000, pollMs: 100 });
    assert.equal(done.status, "done");
    assert.equal(done.dataClass, "realtime");
    const files = await bridge.downloads.files(done);
    assert.equal(files.length, 1);
    assert.equal(files[0].symbol, "NSE:RELIANCE");
    assert.ok(files[0].rows > 0 && files[0].sha256);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcb-node-int-"));
    const saved = await bridge.downloads.save(done, dir);
    assert.equal(saved[0].bytes, files[0].bytes);
    assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
    assert.ok((await bridge.downloads.list()).some((j) => j.id === done.id));

    const ds = await bridge.datasets.get("node-ds");
    assert.equal(ds.series, 1);
    assert.ok(ds.files[0].firstBar && ds.files[0].lastBar, "the bars are kept per file");
    const hist = await bridge.datasets.read("node-ds"); // used to throw: it looked for firstBar on the dataset
    assert.ok(hist.candles.length > 0);
    const edited = await bridge.datasets.edit("node-ds", { tags: ["node"], description: "from node" }); // used to be refused: the field is title
    assert.equal(edited.title, "from node");
    assert.deepEqual((await bridge.datasets.list({ tag: "node" })).map((d) => d.name), ["node-ds"]);
    const upd = await bridge.datasets.update("node-ds", { wait: true, timeoutMs: 60_000, pollMs: 100 });
    assert.equal(upd.status, "done");
  });

  it("recordings and rules", async (t) => {
    if (skip) return t.skip(skip);
    const rec = await bridge.recordings.create({ kind: "quotes", symbols: ["NSE:RELIANCE", "NSE:INFY"], everySec: 5 });
    try {
      assert.equal(rec.kind, "quotes");
      assert.deepEqual(rec.target.symbols, ["NSE:RELIANCE", "NSE:INFY"]);
      assert.ok(["recording", "waiting"].includes(rec.status));
      assert.ok((await bridge.recordings.list()).some((r) => r.id === rec.id));
      assert.equal((await bridge.recordings.pause(rec)).status, "paused");
      assert.equal((await bridge.recordings.stop(rec)).status, "stopped");
    } finally {
      await bridge.recordings.delete(rec);
    }
    const rule = await bridge.recordings.rules.create({ name: "node-rule", kind: "quotes", symbols: ["NSE:INFY"], everySec: 5 });
    try {
      assert.equal(rule.name, "node-rule");
      assert.ok((await bridge.recordings.rules.list()).some((r) => r.id === rule.id));
    } finally {
      await bridge.recordings.rules.delete(rule.id);
    }
  });

  it("collections: create, get, tag, resolve, estimate, export, delete; a missing one is a 404", async (t) => {
    if (skip) return t.skip(skip);
    const c = await bridge.collections.create("node-col", { symbols: ["NSE:RELIANCE", "NSE:INFY"], tags: ["node"], description: "two" });
    try {
      assert.deepEqual(c.symbols, ["NSE:RELIANCE", "NSE:INFY"]);
      assert.equal((await bridge.collections.get("node-col")).description, "two");
      assert.deepEqual((await bridge.collections.list({ tag: "node" })).map((x) => x.name), ["node-col"]);
      assert.deepEqual((await bridge.collections.resolve("node-col")).symbols, ["NSE:RELIANCE", "NSE:INFY"]);
      assert.ok(await bridge.collections.estimate("node-col", { intervals: ["1d"], days: 30 }));
      assert.match(await bridge.collections.export("node-col", { format: "csv" }), /NSE:INFY/);
    } finally {
      await bridge.collections.delete("node-col");
    }
    const u = await bridge.collections.create("node-uni", { universe: optionUniverse({ underlying: "NIFTY", expiries: "current-weekly", count: 2 }) });
    assert.equal(u.kind, "option-universe");
    await bridge.collections.delete("node-uni");
    await assert.rejects(() => bridge.collections.get("nope"), (e) => e.status === 404);
  });

  it("pages a list with limit and cursor", async (t) => {
    if (skip) return t.skip(skip);
    for (const n of ["pg-a", "pg-b", "pg-c"]) await bridge.collections.create(n, { symbols: ["NSE:INFY"] });
    const first = await bridge._get("/v1/collections", { limit: 2 });
    assert.equal(first.data.length, 2);
    assert.ok(first.meta.nextCursor);
    const second = await bridge._get("/v1/collections", { limit: 2, cursor: first.meta.nextCursor });
    assert.ok(second.data.length >= 1);
  });
});
