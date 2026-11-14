/**
 * The step-by-step guides (orders, data, the TradingView checks) must work as written against a demo Bridge.
 *
 * A block is run when the line right before its fence is the marker below. `sh` blocks run under bash with `mc-bridge` on the
 * PATH (a small shim around bin/mc-bridge.mjs, pointed at the demo Bridge with MCB_BRIDGE_URL) and with the documented address
 * 127.0.0.1:4300 rewritten to the demo Bridge's port; `python` blocks run with the repository's library on the path. The Bridge is
 * in-process (sample data, paper account `demo-paper`, nothing beyond 127.0.0.1) and the key is an admin + paper key, which is
 * what the guides say these steps need. Blocks of one guide run in order, in one folder, against one Bridge, so a later step can
 * use what an earlier one made. A block that needs a tool this machine lacks (python3, pandas) is skipped, never faked.
 *
 * Two things are changed for speed, and nothing else: a download's `--from` date is moved to a recent one (the guide shows a date
 * two years back), and the Python step that reads a rule's recording is pointed at the manual trial recording the guide makes
 * just before (a rule needs a trading day to pass). Both are marked below.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootDemoBridge } from "../server/bridge/core/__fixtures__/demoBridge.mjs";
import { ROOT } from "./lib/repo-files.mjs";

const run = promisify(execFile);
export const MARKER = "<!-- runs against a demo Bridge in scripts/guide-recipes.test.mjs -->";

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
const blocksOf = (rel) => markedBlocks(read(rel));

let python = null;
let pandas = false;
try {
  await run("python3", ["--version"]);
  python = "python3";
  await run("python3", ["-c", "import pandas"]).then(() => {
    pandas = true;
  }, () => {});
} catch {
  /* no Python here: the Python steps are skipped */
}

describe("the recipe blocks are found", () => {
  it("orders.md and data.md mark their runnable steps", () => {
    expect(blocksOf("docs/guides/orders.md").length).toBeGreaterThanOrEqual(4);
    expect(blocksOf("docs/guides/data.md").length).toBeGreaterThanOrEqual(7);
  });
  it("a marker without a fence after it is an error", () => {
    expect(() => markedBlocks(`${MARKER}\n\nplain text\n`)).toThrow(/not followed by a code fence/);
  });
});

/** Run every marked block of one guide, in order, against a fresh demo Bridge. `before(block, ctx)` may rewrite a block. */
function guideSuite(rel, { before = (b) => b, beforeRun = async () => {}, after = () => {} } = {}) {
  describe(`${rel}: the marked steps run as written`, () => {
    let demo;
    let dir;
    let env;
    const outputs = [];
    beforeAll(async () => {
      demo = await bootDemoBridge();
      dir = mkdtempSync(join(tmpdir(), "mcb-guide-recipes-"));
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "mc-bridge"), `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "bin/mc-bridge.mjs")}" "$@"\n`);
      chmodSync(join(bin, "mc-bridge"), 0o755);
      const clean = { ...process.env };
      for (const k of ["MCB_ACCOUNT", "MCB_API_KEY", "MCB_ADMIN_KEY", "MCB_BRIDGE_URL", "MCB_HOME", "MCB_CONFIG", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete clean[k];
      env = {
        ...clean,
        HOME: dir,
        USERPROFILE: dir,
        APPDATA: dir,
        MCB_HOME: join(dir, "bridge-home"),
        MCB_API_KEY: demo.key,
        MCB_ADMIN_KEY: demo.key,
        MCB_BRIDGE_URL: demo.base,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        PATH: `${bin}:${process.env.PATH}`,
        PYTHONDONTWRITEBYTECODE: "1",
      };
    });
    afterAll(async () => {
      await demo?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    async function exec(cmd, args) {
      try {
        const r = await run(cmd, args, { env, cwd: dir, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
        return { code: 0, out: r.stdout + r.stderr };
      } catch (e) {
        return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    }

    for (const original of blocksOf(rel)) {
      const needsPandas = /pandas|as_dataframe/.test(original.code);
      const skip = original.lang === "python" ? !python || (needsPandas && !pandas) : false;
      const title = original.code.split("\n").find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("import ") && !l.startsWith("from ")) ?? original.code;
      it.skipIf(skip)(`line ${original.line}: ${title.trim().slice(0, 70)}`, async () => {
        await beforeRun(original, { demo, dir, env });
        const block = before(original, { demo, dir, env });
        let r;
        if (block.lang === "sh") {
          const code = block.code.replaceAll("http://127.0.0.1:4300", demo.base).replaceAll("127.0.0.1:4300", demo.base.replace("http://", ""));
          const file = join(dir, `step-${block.line}.sh`);
          writeFileSync(file, code);
          r = await exec("bash", ["-e", "-o", "pipefail", file]);
        } else if (block.lang === "python") {
          const file = join(dir, `step-${block.line}.py`);
          writeFileSync(file, `import sys\nsys.path.insert(0, ${JSON.stringify(join(ROOT, "sdk/python"))})\n${block.code}\n`);
          r = await exec(python, ["-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, "sdk/python"))}); exec(compile(open(${JSON.stringify(file)}).read(), ${JSON.stringify(file)}, "exec"))`]);
        } else throw new Error(`the test cannot run a ${block.lang} block (line ${block.line})`);
        outputs.push({ line: original.line, ...r });
        expect(r.code, r.out.slice(-1200)).toBe(0);
        expect(r.out).not.toMatch(/Traceback|ConfigurationError|Error: /);
      });
    }

    it("the steps left the state the guide says they leave", async () => {
      await after({ demo, dir, env, outputs, call: demo.call });
    });
  });
}

// ---- orders.md ----------------------------------------------------------------------------------------------------
guideSuite("docs/guides/orders.md", {
  async after({ demo, outputs }) {
    const first = outputs.find((o) => /"orderId":"PAPER-/.test(o.out));
    expect(first, "the first example prints an order").toBeTruthy();
    expect(first.out).toMatch(/"mode":"paper"/);
    expect(first.out).toMatch(/"status":"filled"/);
    // the replayed order is the same one: the book holds one order for that key, not two
    const orders = await demo.call("GET", "/v1/orders?limit=50");
    expect(orders.json.data.filter((o) => o.symbol === "NSE:RELIANCE")).toHaveLength(1);
    // the target example was a dry run: nothing was placed for INFY
    expect(orders.json.data.filter((o) => o.symbol === "NSE:INFY")).toHaveLength(0);
    // the last example printed the replay header
    expect(outputs.at(-1).out).toMatch(/idempotency-replayed: true/i);
    expect(outputs.at(-1).out).toMatch(/HTTP\/1\.1 201/);
  },
});

// ---- data.md ------------------------------------------------------------------------------------------------------
guideSuite("docs/guides/data.md", {
  before(b, ctx) {
    // Speed only: the guide shows a download from two years back; the test moves the date to a recent one.
    let code = b.code.replace(/--from 2024-11-11/g, "--from 2026-10-26");
    if (b.lang === "sh" && /history\?symbol/.test(code)) code = code.replace("from=2025-06-02&to=2025-06-03", "from=2026-10-27&to=2026-10-28");
    // The guide reads the rule's recording the day after; the test reads the manual trial recording made a step earlier.
    if (b.lang === "python" && /rule-index-option-chains/.test(code) && ctx.demoRecordingId) code = code.replace('"rule-index-option-chains"', JSON.stringify(ctx.demoRecordingId));
    return { ...b, code };
  },
  async beforeRun(b, ctx) {
    if (!(b.lang === "python" && /rule-index-option-chains/.test(b.code))) return;
    // Wait for the trial recording to have written its first rows.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const list = await ctx.demo.call("GET", "/v1/recordings");
      const rec = list.json.data.find((r) => r.id.startsWith("rec_") && r.rows > 0);
      if (rec) {
        ctx.demoRecordingId = rec.id;
        return;
      }
      if (Date.now() > deadline) throw new Error("the trial recording wrote no rows in 60 seconds");
      await new Promise((r) => setTimeout(r, 500));
    }
  },
  async after({ demo, outputs }) {
    const ds = await demo.call("GET", "/v1/datasets/watchlist-5m");
    expect(ds.status).toBe(200);
    expect(ds.json.data.series).toBe(5);
    expect(ds.json.data.dataClass).toBe("realtime");
    const dry = outputs.find((o) => /This was a dry run: nothing was started/.test(o.out));
    expect(dry, "the dry run says nothing was started").toBeTruthy();
    expect(dry.out).toMatch(/Broker calls: \d+/);
    const update = outputs.find((o) => /Started dl_\w+ to fetch what is new for watchlist-5m/.test(o.out));
    expect(update, "the update script starts a job for the dataset").toBeTruthy();
    const status = await demo.call("GET", "/v1/recordings/status");
    expect(status.json.data.line ?? JSON.stringify(status.json.data)).toMatch(/Auto-record is on|Recording today/);
    if (pandas) {
      const rec = outputs.find((o) => /\d+ rows from \d+ options/.test(o.out));
      expect(rec, "the Python step reads the recording back").toBeTruthy();
      expect(Number(/(\d+) rows from/.exec(rec.out)[1])).toBeGreaterThan(0);
      expect(outputs.find((o) => /'class': 'realtime'|"class": "realtime"|class=realtime|realtime/.test(o.out) && /NSE:RELIANCE|open|close/.test(o.out)), "the dataset read prints its data class").toBeTruthy();
    }
    const hist = outputs.find((o) => /"source":"local"/.test(o.out));
    expect(hist, "the local history read answers from disk").toBeTruthy();
  },
});

// ---- tradingview.md -----------------------------------------------------------------------------------------------
guideSuite("docs/guides/tradingview.md", {
  async after({ demo, outputs }) {
    const out = outputs.at(-1).out;
    expect(out).toMatch(/hook: hk_[a-z0-9]+/);
    expect(out).toMatch(/"outcome":"placed"/);
    expect(out).toMatch(/Placed a paper order/);
    // the test alert made a paper order for the hook: it came in as a webhook and carries a derived client order id (mcb-<hook>-<hash>)
    const orders = await demo.call("GET", "/v1/orders?limit=10");
    const placed = orders.json.data.find((o) => /^PAPER-/.test(o.orderId));
    expect(placed, "the test alert placed a paper order").toBeTruthy();
    expect(placed.mode).toBe("paper");
    expect(placed.source).toBe("webhook");
    expect(placed.clientOrderId).toMatch(/^mcb-[a-z0-9]+-[0-9a-f]+/);
  },
});

// ---- what orders.md says about tickets and refusals -----------------------------------------------------------------
describe("orders.md: the refusals and the ticket steps behave as described", () => {
  let demo;
  beforeAll(async () => {
    demo = await bootDemoBridge();
  });
  afterAll(async () => demo?.close());

  const body = { account: "demo-paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET" };
  const key = (k) => ({ "Idempotency-Key": k });

  it("there is no default product or order type", async () => {
    const r = await demo.call("POST", "/v1/orders", { body: { account: "demo-paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1 }, headers: key("no-default-0001") });
    expect(r.status).toBe(400);
  });

  it("an idempotency key is 8 to 255 characters; the same key and body replays; another body is a 409", async () => {
    const short = await demo.call("POST", "/v1/orders", { body, headers: key("short") });
    expect(short.status).toBe(400);
    const a = await demo.call("POST", "/v1/orders", { body, headers: key("replay-0001") });
    const b = await demo.call("POST", "/v1/orders", { body, headers: key("replay-0001") });
    expect(a.status).toBe(201);
    expect(b.headers.get("idempotency-replayed")).toBe("true");
    expect(b.json.data.orderId).toBe(a.json.data.orderId);
    const c = await demo.call("POST", "/v1/orders", { body: { ...body, quantity: 2 }, headers: key("replay-0001") });
    expect(c.status).toBe(409);
    expect(c.json.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("MIS is read as INTRADAY and the answer says so", async () => {
    const r = await demo.call("POST", "/v1/orders", { body: { ...body, product: "MIS" }, headers: key("alias-0001") });
    expect(r.status).toBe(201);
    expect(r.json.data.product).toBe("INTRADAY");
    expect(r.json.meta.normalised).toEqual([{ field: "product", from: "MIS", to: "INTRADAY" }]);
  });

  it("a clientOrderId finds the order later", async () => {
    const r = await demo.call("POST", "/v1/orders", { body: { ...body, clientOrderId: "my-order-1" }, headers: key("client-0001") });
    expect(r.status).toBe(201);
    const found = await demo.call("GET", "/v1/orders/by-client-id/my-order-1");
    expect(found.json.data.orderId).toBe(r.json.data.orderId);
  });

  it("live on a paper account is PAPER_ONLY; a key without the live scope is told so", async () => {
    const r = await demo.call("POST", "/v1/orders", { body: { ...body, mode: "live" }, headers: key("live-0001") });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("PAPER_ONLY");
    expect(r.json.errors.map((e) => e.message).join(" ")).toMatch(/"live" scope/);
  });

  it("an assistant's key: no order without a confirmation; preview opens a ticket; confirm gives a single-use token", async () => {
    const mcp = (await demo.app.deps.keyStore.create({ label: "assistant", scopes: ["paper"], accounts: "*", clientKind: "mcp" })).key;
    const as = (method, path, extra = {}) => demo.call(method, path, { auth: mcp, ...extra });
    const refused = await as("POST", "/v1/orders", { body, headers: key("assist-0001") });
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe("CONFIRMATION_REQUIRED");

    const preview = await as("POST", "/v1/orders/preview", { body });
    expect(preview.json.data.requiresHumanConfirmation).toBe(true);
    const ticketId = preview.json.data.ticketId;
    expect(ticketId).toMatch(/^tkt_/);

    // the assistant cannot confirm its own ticket
    const self = await as("POST", `/v1/tickets/${ticketId}/confirm`);
    expect(self.status).toBeGreaterThanOrEqual(400);

    const open = await demo.call("GET", "/v1/tickets");
    expect(open.json.data.map((t) => t.ticketId)).toContain(ticketId);
    const confirmed = await demo.call("POST", `/v1/tickets/${ticketId}/confirm`);
    expect(confirmed.status).toBe(200);
    const token = confirmed.json.data.confirmToken;

    const placed = await as("POST", "/v1/orders", { body: { ...body, confirmToken: token }, headers: key("assist-0002") });
    expect(placed.status).toBe(201);
    const again = await as("POST", "/v1/orders", { body: { ...body, confirmToken: token }, headers: key("assist-0003") });
    expect(again.status).toBeGreaterThanOrEqual(400); // the token is used up
  });

  it("a declined ticket can never be confirmed", async () => {
    const mcp = (await demo.app.deps.keyStore.create({ label: "assistant-2", scopes: ["paper"], accounts: "*", clientKind: "mcp" })).key;
    const preview = await demo.call("POST", "/v1/orders/preview", { auth: mcp, body });
    const id = preview.json.data.ticketId;
    const no = await demo.call("POST", `/v1/tickets/${id}/reject`, { body: { reason: "Wrong quantity" } });
    expect(no.status).toBe(200);
    const late = await demo.call("POST", `/v1/tickets/${id}/confirm`);
    expect(late.status).toBe(409);
    expect(late.json.state ?? late.json.errors?.[0]?.state).toBeTruthy();
  });

  it("the settings the guide names have the defaults it quotes", async () => {
    const { ORDERS_DEFAULTS } = await import("../server/bridge/orders/config.mjs");
    expect(ORDERS_DEFAULTS.ticketTtlMs).toBe(60_000);
    expect(ORDERS_DEFAULTS.confirmTokenTtlMs).toBe(60_000);
    expect(ORDERS_DEFAULTS.liveCallTimeoutMs).toBe(15_000);
    expect(ORDERS_DEFAULTS.reconcileIntervalMs).toBe(3000);
    expect(ORDERS_DEFAULTS.reconcileGiveUpMs).toBe(600_000);
    const guide = read("docs/guides/orders.md");
    for (const t of ["orders.ticketTtlMs", "orders.confirmTokenTtlMs", "orders.liveCallTimeoutMs", "orders.reconcileIntervalMs", "orders.reconcileGiveUpMs", "orders.confirmPaperFromMcp", "orders.sliceAboveFreeze"]) expect(guide, t).toContain(t);
  });
});
