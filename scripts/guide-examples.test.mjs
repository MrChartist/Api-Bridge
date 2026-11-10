/**
 * The first Python and Node examples in the guides must run as written against a demo Bridge.
 *
 * A block is run when the line right before its fence is the marker below. The Python blocks run under `python3` with the
 * repository's library on the path, the JavaScript blocks under `node` with the package name pointed at sdk/node. The Bridge
 * is in-process (sample data, paper account `demo-paper`, nothing beyond 127.0.0.1), the key is an admin + paper key, and
 * no account is set in the environment, so an example that forgets to name its account fails here with the same
 * "Say which account to use" a new reader would see. Python missing on this machine skips the Python half.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootDemoBridge } from "../server/bridge/core/__fixtures__/demoBridge.mjs";
import { ROOT, readText, repoFiles } from "./lib/repo-files.mjs";

const run = promisify(execFile);
export const MARKER = "<!-- runs against a demo Bridge in scripts/guide-examples.test.mjs -->";

/** The fenced blocks of a Markdown file that are marked as runnable: [{ lang, code, line }]. */
export function markedBlocks(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== MARKER) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j += 1;
    const open = /^```(\w+)\s*$/.exec(lines[j] ?? "");
    if (!open) throw new Error(`the marker on line ${i + 1} is not followed by a code fence`);
    const body = [];
    for (j += 1; j < lines.length && !lines[j].startsWith("```"); j += 1) body.push(lines[j]);
    out.push({ lang: open[1], code: body.join("\n"), line: i + 1 });
  }
  return out;
}

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const pythonBlocks = markedBlocks(read("docs/guides/python.md"));
const nodeBlocks = markedBlocks(read("docs/guides/typescript.md"));

let python = null;
try {
  await run("python3", ["--version"]);
  python = "python3";
} catch {
  /* no Python here: the Python examples are skipped */
}

describe("the guides mark the examples a new reader runs first", () => {
  it("python.md marks connect, market data, orders and asyncio; typescript.md marks the first example", () => {
    expect(pythonBlocks.length).toBeGreaterThanOrEqual(4);
    expect(nodeBlocks.length).toBeGreaterThanOrEqual(1);
    expect(pythonBlocks.some((b) => /orders\.place/.test(b.code))).toBe(true);
    expect(pythonBlocks.some((b) => /AsyncBridge/.test(b.code))).toBe(true);
    expect(nodeBlocks.some((b) => /placeOrder/.test(b.code))).toBe(true);
  });

  it("every marked block says which account it orders on (a first order must not depend on guessing)", () => {
    for (const b of [...pythonBlocks, ...nodeBlocks]) {
      if (/orders\.place|placeOrder/.test(b.code)) expect(b.code, `line ${b.line}`).toMatch(/account\s*[=:]\s*"demo-paper"/);
    }
  });

  it("no first order example is bigger than the default per-order limit", () => {
    // Rs 2,00,000 by default; one share of a large cap is a fraction of that. Lots of a future are not.
    for (const b of [...pythonBlocks, ...nodeBlocks]) expect(b.code, `line ${b.line}`).not.toMatch(/lots\s*[=:]\s*\d/);
  });
});

describe("the marked examples run against a demo Bridge as written", () => {
  let demo;
  let dir;
  let env;
  beforeAll(async () => {
    demo = await bootDemoBridge();
    dir = mkdtempSync(join(tmpdir(), "mcb-guide-examples-"));
    const clean = { ...process.env };
    for (const k of ["MCB_ACCOUNT", "MCB_API_KEY", "MCB_BRIDGE_URL", "MCB_HOME", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete clean[k];
    env = { ...clean, HOME: dir, USERPROFILE: dir, APPDATA: dir, MCB_API_KEY: demo.key, MCB_BRIDGE_URL: demo.base, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", PYTHONDONTWRITEBYTECODE: "1" };
  });
  afterAll(async () => {
    await demo?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function runFile(cmd, args) {
    try {
      const r = await run(cmd, args, { env, cwd: dir, timeout: 60_000 });
      return { code: 0, out: r.stdout + r.stderr };
    } catch (e) {
      return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  for (const b of pythonBlocks) {
    it.skipIf(!python)(`python.md line ${b.line}: ${b.code.split("\n").find((l) => l.trim() && !l.startsWith("from ") && !l.startsWith("import ")).slice(0, 60)}`, async () => {
      const file = join(dir, `example-${b.line}.py`);
      writeFileSync(file, `import sys\nsys.path.insert(0, ${JSON.stringify(join(ROOT, "sdk/python"))})\n${b.code}\n`);
      const r = await runFile(python, [file]);
      expect(r.code, r.out.slice(-600)).toBe(0);
      expect(r.out).not.toMatch(/Say which account|Traceback/);
    });
  }

  for (const b of nodeBlocks) {
    it(`typescript.md line ${b.line}: the first Node example`, async () => {
      const sdk = pathToFileURL(join(ROOT, "sdk/node/src/index.mjs")).href;
      const code = b.code.replaceAll("@mrchartist/bridge-client", sdk).replaceAll("process.env.MCB_API_KEY!", "process.env.MCB_API_KEY");
      const file = join(dir, `example-${b.line}.mjs`);
      writeFileSync(file, code);
      const r = await runFile(process.execPath, [file]);
      expect(r.code, r.out.slice(-600)).toBe(0);
      expect(r.out).toMatch(/NSE:RELIANCE/);
      expect(r.out).toMatch(/filled|open|PAPER/);
    });
  }

  it("an order example that names no account is refused the way a reader would see it", async () => {
    if (!python) return;
    const file = join(dir, "no-account.py");
    writeFileSync(file, `import sys\nsys.path.insert(0, ${JSON.stringify(join(ROOT, "sdk/python"))})\nfrom mrchartist_bridge import Bridge\nBridge().orders.place("NSE:RELIANCE", "BUY", quantity=1, product="CNC", price=Bridge().quote("NSE:RELIANCE"))\n`);
    const r = await runFile(python, [file]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Say which account/);
  });
});

describe("derivative examples do not expire in a runnable block", () => {
  // A dated contract (NFO:NIFTY-2026-10-27-FUT) is a format illustration in a table or in prose. In a code block that
  // someone copies it stops working on its expiry day, so those blocks use an equity or a `<expiry>` placeholder.
  const DATED = /\b(?:NFO|BFO|MCX|CDS):[A-Z0-9&_-]+?-20\d\d-\d\d-\d\d(?:-FUT|-[\d.]+-(?:CE|PE))\b/;
  const guides = repoFiles().filter((f) => /^docs\/guides\/[^/]+\.md$/.test(f) || /^(sdk\/(node|python)\/README|integrations\/[^/]*\/?README|README)\.md$/.test(f));

  /** Lines inside fenced blocks of a language a reader runs (anything but `text`). */
  function runnableLines(text) {
    const hits = [];
    let lang = null;
    text.split("\n").forEach((line, i) => {
      const fence = /^```(\w*)/.exec(line);
      if (fence) {
        lang = lang === null ? fence[1] || "plain" : null;
        return;
      }
      if (lang !== null && lang !== "text" && lang !== "plain" && DATED.test(line)) hits.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
    });
    return hits;
  }

  it("the pattern finds the forms it is meant to", () => {
    expect(DATED.test("NFO:NIFTY-2026-10-27-FUT")).toBe(true);
    expect(DATED.test("NFO:NIFTY-2026-10-27-25000-CE")).toBe(true);
    expect(DATED.test("NFO:NIFTY-<expiry>-FUT")).toBe(false);
    expect(DATED.test("NSE:RELIANCE")).toBe(false);
  });

  it("no guide, SDK README or integration README has one in a runnable code block", () => {
    const bad = [];
    for (const f of guides) for (const h of runnableLines(readText(f) ?? "")) bad.push(`${f}:${h}`);
    expect(bad).toEqual([]);
  });

  it("the AmiBroker and Excel examples use symbols that stay valid", () => {
    for (const f of repoFiles().filter((x) => /^integrations\/(amibroker|excel|google-sheets)\//.test(x) && /\.(afl|md|pq|gs)$/.test(x))) {
      const lines = (readText(f) ?? "").split("\n").filter((l) => DATED.test(l) && !/^\s*\|/.test(l) && !/→|format|e\.g\./i.test(l));
      expect(lines.map((l) => l.trim().slice(0, 80)), f).toEqual([]);
    }
  });
});
