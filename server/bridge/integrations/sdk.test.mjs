/**
 * Runs the SDK test suites (they live with their packages so each SDK stays self-contained) inside the repository's
 * vitest run: the Node SDK with node:test (all its files, the integration test against the real routes included: it is the
 * only one that cannot drift from the server) and the Python SDK with pytest, or unittest when pytest is not installed (the
 * pytest-style tests are then not found, so the count is lower). Both use the local fake Bridge (sdk/node/test/fakeServer.mjs)
 * apart from that integration test. The Python suite is skipped when python3 is not installed.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const hasPython = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;
const hasPytest = hasPython && spawnSync("python3", ["-I", "-c", "import pytest"], { encoding: "utf8" }).status === 0;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, NODE_OPTIONS: "", PYTHONDONTWRITEBYTECODE: "1" } });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, error: r.error };
}

describe("SDKs against the fake Bridge", () => {
  it("Node SDK (node --test)", () => {
    const r = run(process.execPath, ["--test", "--test-reporter=tap", "sdk/node/test/client.test.mjs", "sdk/node/test/data.test.mjs", "sdk/node/test/events.test.mjs", "sdk/node/test/examples.test.mjs", "sdk/node/test/integration.test.mjs"]);
    if (r.status !== 0) console.error(r.out.slice(-6000));
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/# fail 0/);
    const pass = Number(/# pass (\d+)/.exec(r.out)?.[1] ?? 0);
    expect(pass).toBeGreaterThanOrEqual(20);
    // The integration test skips itself when the repository's Bridge cannot be loaded: here it must have run.
    expect(r.out).not.toMatch(/# skipped [1-9]/);
    expect(r.out).toMatch(/Node SDK against a real demo Bridge/);
  });

  it.skipIf(!hasPython)("Python SDK (pytest, else unittest)", () => {
    const r = hasPytest
      ? run("python3", ["-I", "-m", "pytest", "sdk/python/tests", "-q", "-p", "no:cacheprovider", "-W", "error::pytest.PytestUnraisableExceptionWarning"])
      : run("python3", ["-I", "-m", "unittest", "discover", "-s", "sdk/python/tests", "-v"]);
    if (r.status !== 0) console.error(r.out.slice(-6000));
    expect(r.status).toBe(0);
    if (hasPytest) {
      expect(r.out).toMatch(/\d+ passed/);
      expect(r.out).not.toMatch(/ failed|error/i);
      expect(Number(/(\d+) passed/.exec(r.out)?.[1] ?? 0)).toBeGreaterThanOrEqual(250); // the whole suite, not the 25 unittest finds
    } else {
      expect(r.out).toMatch(/\nOK/);
      expect(r.out).not.toMatch(/skipped=\d+|SkipTest/); // the fake server must actually have run
      expect(Number(/Ran (\d+) tests/.exec(r.out)?.[1] ?? 0)).toBeGreaterThanOrEqual(20);
    }
  });
});
