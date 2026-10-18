/**
 * Runs the SDK test suites (they live with their packages so each SDK stays self-contained) inside the repository's
 * vitest run: the Node SDK with node:test and the Python SDK with unittest, both against the local fake Bridge
 * (sdk/node/test/fakeServer.mjs). The Python suite is skipped when python3 is not installed.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const hasPython = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, NODE_OPTIONS: "", PYTHONDONTWRITEBYTECODE: "1" } });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, error: r.error };
}

describe("SDKs against the fake Bridge", () => {
  it("Node SDK (node --test)", () => {
    const r = run(process.execPath, ["--test", "sdk/node/test/client.test.mjs"]);
    if (r.status !== 0) console.error(r.out.slice(-6000));
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/# fail 0/);
    const pass = Number(/# pass (\d+)/.exec(r.out)?.[1] ?? 0);
    expect(pass).toBeGreaterThanOrEqual(20);
  });

  it.skipIf(!hasPython)("Python SDK (unittest)", () => {
    const r = run("python3", ["-I", "-m", "unittest", "discover", "-s", "sdk/python/tests", "-v"]);
    if (r.status !== 0) console.error(r.out.slice(-6000));
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/\nOK/);
    expect(r.out).not.toMatch(/skipped=\d+|SkipTest/); // the fake server must actually have run
    const ran = Number(/Ran (\d+) tests/.exec(r.out)?.[1] ?? 0);
    expect(ran).toBeGreaterThanOrEqual(20);
  });
});
