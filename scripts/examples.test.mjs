/**
 * The curl examples in the docs must work. This runs the safe ones against an in-process demo Bridge (sample data,
 * paper account, no network beyond 127.0.0.1) and fails when one breaks:
 *   - every GET in the per-endpoint pages (docs/api/**), and the POST calls that only read or only place paper orders;
 *   - the calls that need an order (look it up, change it, cancel it) get one created here first;
 *   - every curl in docs/guides/quickstart.md and the README.
 * Examples that need something only you have (a key id, a hook token) are counted as skipped, with the reason.
 * Calls that change settings, keys or the kill switch are never run.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/bridge/core/app.mjs";
import { loadConfig } from "../server/bridge/core/config.mjs";
import { createNullLogger } from "../server/bridge/core/logger.mjs";
import { isoToCompact } from "../server/bridge/compat/mapping.mjs";
import { curlCommands, parseCurl, shellWords } from "./lib/curl.mjs";
import { expectedStatus } from "./lib/endpoint-docs.mjs";
import { REPO_ROOT, loadSpec, operations } from "./lib/openapi-model.mjs";

const DOC_BASE = "http://127.0.0.1:4300";
const ops = new Map(operations(loadSpec()).map((o) => [o.id, o]));

/** POST (and other write) examples that are safe to run: they read, or they place paper orders on demo-paper. */
const SAFE_WRITES = new Set([
  "previewOrder", "placeOrder", "convertSymbols", "paperBasketMargin", "checkReadiness",
  "compatPing", "compatAnalyzer", "compatFunds", "compatOrderbook", "compatTradebook", "compatPositionbook", "compatHoldings",
  "compatQuotes", "compatMultiquotes", "compatDepth", "compatHistory", "compatIntervals", "compatSymbol", "compatSearch", "compatExpiry", "compatOptionchain",
  "compatPlaceorder", "compatPlacesmartorder", "compatBasketorder", "compatSplitorder", "compatOpenposition", "compatOptionsymbol",
]);
/** Examples that need an order: created in the test, then looked up, changed or cancelled. */
const NEEDS_ORDER = new Set(["getOrder", "getOrderByClientId", "modifyOrder", "cancelOrder", "compatOrderstatus", "compatCancelorder", "compatModifyorder"]);
/** GETs that are not plain requests: a WebSocket upgrade, and an event stream that needs a one-time token. */
const NOT_PLAIN = new Set(["openStream", "openSse"]);
/** Run last: they cancel every open paper order and close the paper positions. */
const LAST = new Set(["cancelAllOrders", "compatCancelallorder", "compatCloseposition"]);

/** The per-endpoint pages, as { id, curl } for each operation that has a curl example. */
function pageExamples() {
  const out = [];
  const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  for (const file of walk(join(REPO_ROOT, "docs/api")).sort()) {
    if (!file.endsWith(".md") || /README\.md$|errors\.md$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    const id = /\| Operation \| `(\w+)` \|/.exec(text)?.[1];
    for (const curl of curlCommands(text)) out.push({ id, curl, file: file.slice(REPO_ROOT.length + 1) });
  }
  return out;
}

const pages = pageExamples();
const guideCurls = ["docs/guides/quickstart.md", "README.md"].flatMap((f) => curlCommands(readFileSync(join(REPO_ROOT, f), "utf8")).map((curl) => ({ curl, file: f })));

describe("the curl reader", () => {
  it("reads continuations, quotes, headers and bodies", () => {
    const c = parseCurl(`curl -s -X POST "http://x/y?a=1&b=2" \\\n  -H "Authorization: Bearer $K" \\\n  -d '{"a":"b c"}'`);
    expect(c).toEqual({ method: "POST", url: "http://x/y?a=1&b=2", headers: { Authorization: "Bearer $K" }, body: '{"a":"b c"}' });
    expect(parseCurl("curl http://x/").method).toBe("GET");
    expect(shellWords(`a 'b c' "d \\"e\\""`)).toEqual(["a", "b c", 'd "e"']);
    expect(() => parseCurl("curl --weird http://x/")).toThrow(/not understood/);
  });

  it("finds curl commands in bash fences only", () => {
    const md = "```bash\ncurl -s http://a/\nls\ncurl -X POST http://b/ \\\n  -d '{}'\n```\n```json\ncurl http://c/\n```\n";
    expect(curlCommands(md)).toEqual(["curl -s http://a/", "curl -X POST http://b/ \\\n  -d '{}'"]);
  });

  it("the docs have examples to run", () => {
    expect(pages.length).toBeGreaterThan(100);
    expect(pages.every((p) => ops.has(p.id))).toBe(true);
    expect(guideCurls.length).toBeGreaterThanOrEqual(5);
  });
});

describe("docs examples run against a demo Bridge", () => {
  let app;
  let base;
  let key;
  let expiry;
  const ran = [];
  const skipped = [];

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-docs-examples-"));
    const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
    // Monday 9 November 2026, 10:30 IST (dates in the examples are the week before), so paper MARKET orders fill whatever time this runs.
    let t = Date.UTC(2026, 10, 9, 5, 0, 0);
    app = await createApp({ config, logger: createNullLogger(), clock: { now: () => (t += 50) } });
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
    ({ key } = await app.deps.keyStore.create({ label: "docs-examples", scopes: ["admin", "paper"], accounts: "*" }));
    const ex = await call("GET", "/v1/expiries?underlying=NIFTY");
    expiry = ex.json?.data?.expiries?.[0] ?? ex.json?.data?.[0];
  });
  afterAll(async () => {
    await app?.close();
    console.info(`docs examples: ${ran.length} ran, ${skipped.length} skipped (${[...new Set(skipped.map((s) => s.why))].join("; ")})`);
  });

  async function call(method, path, { body, headers = {}, auth = true } = {}) {
    const h = { ...headers };
    if (auth) h.Authorization = `Bearer ${key}`;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json };
  }

  /** An open paper order (a LIMIT a little below the price, so it stays open), made fresh for each use. */
  let orderNo = 0;
  async function openOrder() {
    const clientOrderId = `docs-client-${++orderNo}`;
    const q = await call("GET", "/v1/ltp?symbols=NSE:RELIANCE");
    // The tick size of the demo RELIANCE is 0.1: a price that is not a multiple of it is refused, so round to it.
    const price = Math.round((q.json.data[0].ltp * 0.99) / 0.1) * 0.1;
    const body = { account: "demo-paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: Number(price.toFixed(1)), clientOrderId };
    const r = await call("POST", "/v1/orders", { body, headers: { "Idempotency-Key": `docs-${Math.random().toString(36).slice(2, 12)}` } });
    expect([200, 201], r.text).toContain(r.status);
    return { ...r.json.data, clientOrderId };
  }

  /** The curl with the key, the address and the time-dependent values filled in; null (and why) when it cannot run. */
  async function prepare(curl) {
    let text = curl.replaceAll(DOC_BASE, base).replaceAll("$MCB_API_KEY", key).replaceAll("${MCB_API_KEY}", key).replaceAll("YOUR_API_KEY", key);
    if (expiry) {
      text = text.replace(/expiry=\d{4}-\d{2}-\d{2}/, `expiry=${expiry}`).replace(/"expiry_date":"\d{2}[A-Z]{3}\d{2}"/, `"expiry_date":"${isoToCompact(expiry)}"`);
    }
    if (text.includes("<orderId>") || text.includes("<clientOrderId>")) {
      const o = await openOrder();
      text = text.replaceAll("<orderId>", o.orderId).replaceAll("<clientOrderId>", o.clientOrderId);
    }
    const left = /<[A-Za-z][A-Za-z ]*>/.exec(text.replace(/-H "X-MCB-Signature[^"]*"/, "").replace(/<unix seconds>|<hex HMAC-SHA256>/g, ""));
    if (left) return { why: `needs ${left[0]}` };
    return { req: parseCurl(text) };
  }

  async function run(label, curl, check) {
    const p = await prepare(curl);
    if (!p.req) { skipped.push({ label, why: p.why }); return; }
    const { method, url, headers, body } = p.req;
    const res = await fetch(url, { method, headers, body: body ?? undefined, redirect: "manual" });
    const text = await res.text();
    ran.push(label);
    check(res.status, text);
  }

  const phase = (rank) => pages
    .map((p) => ({ ...p, op: ops.get(p.id) }))
    .filter(({ op, curl }) => {
      if (NOT_PLAIN.has(op.id) || op.websocket || /-X (PUT|PATCH|DELETE)/.test(curl) && !NEEDS_ORDER.has(op.id)) return false;
      const r = LAST.has(op.id) ? 3 : NEEDS_ORDER.has(op.id) ? 2 : SAFE_WRITES.has(op.id) ? 1 : op.method === "GET" ? 0 : -1;
      return r === rank;
    });

  const phases = [["GET examples", 0], ["paper writes and reads", 1], ["examples that need an order", 2], ["cancel all (runs last)", 3]];
  for (const [title, rank] of phases) {
    describe(title, () => {
      for (const p of phase(rank)) {
        it(`${p.op.method} ${p.op.path} (${p.op.id})`, async () => {
          await run(p.file, p.curl, (status, text) => {
            expect(status, `${p.file}: ${text.slice(0, 300)}`).toBe(expectedStatus(p.op));
          });
        });
      }
    });
  }

  describe("quickstart and README", () => {
    for (const g of guideCurls) {
      it(`${g.file}: ${g.curl.split("\n")[0].slice(0, 70)}`, async () => {
        const live = /"mode":\s*"live"/.test(g.curl);
        await run(g.file, g.curl, (status, text) => {
          if (live) {
            expect(status, text).toBe(403);
            expect(JSON.parse(text).code).toBe("PAPER_ONLY");
          } else {
            expect(status, text.slice(0, 300)).toBeGreaterThanOrEqual(200);
            expect(status, text.slice(0, 300)).toBeLessThan(300);
          }
        });
      });
    }
  });

  it("only operations that change nothing important were left out", () => {
    // Everything the pages show was either run, skipped for a stated reason, or is a write on the never-run list.
    const considered = new Set([...phases.flatMap(([, r]) => phase(r).map((p) => p.op.id))]);
    const neverRun = pages.filter((p) => !considered.has(p.id)).map((p) => ops.get(p.id));
    for (const op of neverRun) {
      const readOnlyGet = op.method === "GET" && !NOT_PLAIN.has(op.id) && !op.websocket;
      expect(readOnlyGet, `${op.id} is a GET and should have been run`).toBe(false);
    }
    expect(considered.size).toBeGreaterThan(60);
  });
});
