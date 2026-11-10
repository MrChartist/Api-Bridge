/**
 * OPS-17: the small items. The key command names the wrong field and the allowed scopes; Windows device names are refused as
 * dataset names; a busy port is found before anything is built; downloaded files are owner-only; the unit file gives the
 * Bridge time to stop; the guide no longer says there is no backup command.
 */
import { readFileSync, statSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../core/cli.mjs";
import { checkDatasetName } from "../downloads/datasets.mjs";
import { makeManager, waitStatus } from "../downloads/testkit.mjs";

const ROOT = new URL("../../../", import.meta.url);

function cli(config) {
  const home = mkdtempSync(join(tmpdir(), "mcb-small-"));
  writeFileSync(join(home, "bridge.config.json"), JSON.stringify({ dataDir: "data", logging: { level: "silent" }, ...config }));
  const out = [];
  const err = [];
  return { home, out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s), env: { MCB_HOME: join(home, "h") }, cwd: home } };
}

describe("mc-bridge keys create", () => {
  it("says which field is wrong and what the scopes can be (it used to print only 'The key request is not valid.')", async () => {
    const t = cli({});
    expect(await runCli(["keys", "create"], { label: "bot", scope: "trade" }, t.io)).toBe(1);
    const text = t.err.join("\n");
    expect(text).toMatch(/^Error: The key request is not valid\./);
    expect(text).toMatch(/scopes\.0: /);
    expect(text).toMatch(/Allowed scopes: read, paper, live, admin/);
  });
});

describe("dataset names", () => {
  it("refuses Windows device names, and still takes names that only start with one", () => {
    for (const bad of ["con", "nul", "aux", "prn", "com1", "com9", "lpt1"]) expect(() => checkDatasetName(bad), bad).toThrow(/Windows device names/);
    for (const ok of ["console", "nifty-5m", "com10", "aux-data", "conn"]) expect(checkDatasetName(ok)).toBe(ok);
  });
});

describe("a busy port", () => {
  it("is found before any module is built: no account connects, and the lock is released", async () => {
    const taken = net.createServer();
    await new Promise((r) => taken.listen(0, "127.0.0.1", r));
    const port = taken.address().port;
    const t = cli({ server: { port }, demo: true });
    try {
      expect(await runCli(["start"], { demo: true }, t.io)).toBe(1);
      expect(t.err.join("\n")).toMatch(new RegExp(`Error: Port ${port} is already in use by another program`));
      // nothing was built: no data folder files beyond what the lock left, and no lock left behind
      const dataDir = join(t.home, "data");
      expect(readdirSync(dataDir)).not.toContain("bridge.lock");
      expect(readdirSync(dataDir)).not.toContain("keys.json");
    } finally {
      taken.close();
    }
  });
});

describe("downloaded files", () => {
  it.skipIf(process.platform === "win32")("are owner-only (0600), like the job's own files", async () => {
    const m = makeManager();
    await m.manager.start();
    try {
      const { job } = await m.manager.create({ symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-16" });
      await waitStatus(m.manager, job.id);
      const folder = join(m.dataDir, "downloads", "jobs", job.id);
      for (const name of readdirSync(folder).filter((n) => /\.(csv|json)$/.test(n))) expect(statSync(join(folder, name)).mode & 0o777, name).toBe(0o600);
    } finally {
      await m.manager.stop();
    }
  });
});

describe("deployment files and guides", () => {
  it("the systemd unit gives the Bridge time to stop and enough file handles", () => {
    const unit = readFileSync(new URL("deploy/expose/mc-bridge.service", ROOT), "utf8");
    expect(unit).toMatch(/^TimeoutStopSec=20$/m);
    expect(unit).toMatch(/^KillSignal=SIGTERM$/m);
    expect(unit).toMatch(/^LimitNOFILE=\d+$/m);
  });

  it("the VPS guide points at the backup command and no longer says there is none", () => {
    const guide = readFileSync(new URL("docs/guides/vps.md", ROOT), "utf8");
    expect(guide).not.toMatch(/no backup command/i);
    expect(guide).toMatch(/mc-bridge backup/);
    expect(guide).toMatch(/backup\.md/);
  });
});
