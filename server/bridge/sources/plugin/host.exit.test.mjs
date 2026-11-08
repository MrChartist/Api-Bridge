/**
 * Plugin children must not outlive a Bridge that exits normally or on SIGINT/SIGTERM, even a plugin stuck in a busy loop
 * (which never notices its stdin closing). A SIGKILL of the Bridge cannot be handled; docs/guides/sources.md says how to find
 * and stop an orphan then. Real processes, no network.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { testManifest } from "./__fixtures__/fakeChild.mjs";

const PROBE = fileURLToPath(new URL("./__fixtures__/exitProbe.mjs", import.meta.url));
const SPINNER = `export default { async quotes(s, ctx) { setTimeout(() => { for (;;) {} }, 20); return { items: [{ symbol: "NSE:X", at: ctx.now - 1000, fields: { ltp: 2 } }] }; } };\n`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const orphans = [];
afterEach(() => {
  for (const pid of orphans.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

function pluginDir() {
  const dir = mkdtempSync(join(tmpdir(), "mcb-plugin-exit-"));
  writeFileSync(join(dir, "mc-source.json"), JSON.stringify(testManifest({ limits: { perSecond: 5, callTimeoutMs: 8000 } })));
  writeFileSync(join(dir, "index.mjs"), SPINNER);
  return dir;
}

async function runProbe(mode, endWith) {
  const proc = spawn(process.execPath, [PROBE, pluginDir(), mode], { stdio: ["ignore", "pipe", "pipe"], env: {} });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  const exited = new Promise((resolve) => proc.on("exit", resolve));
  const start = Date.now();
  while (!out.includes("READY") && !out.includes("PROBLEM") && Date.now() - start < 20_000) await sleep(50);
  expect(out).toContain("READY");
  const pid = Number(/PID (\d+)/.exec(out)?.[1]);
  expect(pid).toBeGreaterThan(0);
  orphans.push(pid);
  expect(alive(pid)).toBe(true); // the plugin is running
  endWith?.(proc);
  await exited;
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
  return pid;
}

describe("plugin processes do not outlive the Bridge", () => {
  it("are killed when the Bridge exits with process.exit", async () => {
    const pid = await runProbe("exit");
    expect(alive(pid)).toBe(false);
  }, 40_000);

  it("are killed when the Bridge stops on SIGTERM", async () => {
    const pid = await runProbe("signals", (proc) => proc.kill("SIGTERM"));
    expect(alive(pid)).toBe(false);
  }, 40_000);

  it("are killed when the Bridge stops on SIGINT", async () => {
    const pid = await runProbe("signals", (proc) => proc.kill("SIGINT"));
    expect(alive(pid)).toBe(false);
  }, 40_000);
});
