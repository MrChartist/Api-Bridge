/**
 * Idempotency-Key on the create routes that are not orders (core/idempotency.mjs): a repeat returns the first answer.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDEMPOTENT_ROUTES, createWriteIdempotency, fingerprint, ignoresIdempotencyKey, readIdempotencyKey } from "./idempotency.mjs";
import { bootDemoBridge } from "./__fixtures__/demoBridge.mjs";

describe("write idempotency store", () => {
  const fp = (body) => fingerprint({ method: "POST", path: "/v1/x", query: new URLSearchParams(), body });
  it("RDATA-19e never evicts a request that is still running, however many others come", () => {
    const s = createWriteIdempotency({ now: () => 1000 });
    s.begin("key:1", "running-key-1", fp({ a: 1 }));
    for (let i = 0; i < 2100; i += 1) s.begin("key:1", `other-${String(i).padStart(6, "0")}`, fp({ i })).done({ status: 201, body: "x", headers: {} });
    expect(() => s.begin("key:1", "running-key-1", fp({ a: 1 }))).toThrow(/still running/);
  });

  it("replays, refuses a different request and forgets a failed one", () => {
    let t = 1000;
    const s = createWriteIdempotency({ now: () => t });
    const a = s.begin("key:1", "k-12345678", fp({ a: 1, b: 2 }));
    expect(a.replay).toBe(false);
    expect(() => s.begin("key:1", "k-12345678", fp({ a: 1, b: 2 }))).toThrow(/still running/);
    a.done({ status: 201, body: "{}", headers: { "Content-Type": "application/json" } });
    const again = s.begin("key:1", "k-12345678", fp({ b: 2, a: 1 })); // same body, other key order
    expect(again).toMatchObject({ replay: true, reply: { status: 201 } });
    expect(() => s.begin("key:1", "k-12345678", fp({ a: 2 }))).toThrow(/different request/);
    expect(s.begin("key:2", "k-12345678", fp({ a: 2 })).replay).toBe(false); // another caller, same key text
    const f = s.begin("key:1", "k-failing01", fp({}));
    f.release();
    expect(s.begin("key:1", "k-failing01", fp({})).replay).toBe(false);
    t += 25 * 3600 * 1000;
    expect(s.begin("key:1", "k-12345678", fp({ a: 2 })).replay).toBe(false); // expired after 24 hours
  });

  it("validates the header and names the write routes that ignore it", () => {
    expect(readIdempotencyKey({})).toBeUndefined();
    expect(readIdempotencyKey({ "idempotency-key": "abcdefgh-1234" })).toBe("abcdefgh-1234");
    expect(() => readIdempotencyKey({ "idempotency-key": "short" })).toThrow(/8-255/);
    expect(ignoresIdempotencyKey("POST", "/v1/downloads")).toBe(false);
    expect(ignoresIdempotencyKey("POST", "/v1/orders")).toBe(false);
    expect(ignoresIdempotencyKey("GET", "/v1/quotes")).toBe(false);
    expect(ignoresIdempotencyKey("POST", "/v1/downloads/:downloadId/pause")).toBe(true);
  });
});

describe("Idempotency-Key over HTTP on the create routes", () => {
  let b;
  beforeAll(async () => {
    b = await bootDemoBridge({ raw: { events: { webhooks: { allowPrivateTargets: true } } } });
  });
  afterAll(() => b?.close());

  let n = 0;
  const idk = () => `test-key-${++n}-abcdef`;
  /** POST twice with one key: the second answer is the first, replayed. */
  async function twice(path, body, { status = 201 } = {}) {
    const h = { "Idempotency-Key": idk() };
    const first = await b.call("POST", path, { body, headers: h });
    expect(first.status, first.text).toBe(status);
    expect(first.headers.get("idempotency-replayed")).toBeNull();
    const second = await b.call("POST", path, { body, headers: h });
    expect(second.status, second.text).toBe(status);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(second.text).toBe(first.text);
    return first;
  }

  it("a repeated POST /v1/keys mints one key, not two", async () => {
    const before = (await b.call("GET", "/v1/keys")).json.data.length;
    const first = await twice("/v1/keys", { label: "idem-key-test", scopes: ["read"], accounts: "*" });
    expect(first.text).toContain("idem-key-test");
    expect((await b.call("GET", "/v1/keys")).json.data.length).toBe(before + 1);
  });

  it("a repeated POST /v1/downloads starts one job", async () => {
    const body = { symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-30" };
    const first = await twice("/v1/downloads", body, { status: 202 });
    const jobs = (await b.call("GET", "/v1/downloads")).json.data;
    expect(jobs.filter((j) => j.id === first.json.data.id)).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });

  it("a repeated POST /v1/collections is a replay, not STATE_CONFLICT", async () => {
    await twice("/v1/collections", { name: "idem-col", symbols: ["NSE:RELIANCE"] });
    const clash = await b.call("POST", "/v1/collections", { body: { name: "idem-col", symbols: ["NSE:RELIANCE"] }, headers: { "Idempotency-Key": idk() } });
    expect(clash.status).toBe(409); // a different key is a different request: the name clash is reported as before
    expect(clash.json.code).toBe("STATE_CONFLICT");
  });

  it("a repeated POST /v1/recordings and /v1/recordings/rules create one each", async () => {
    const rec = await twice("/v1/recordings", { kind: "quotes", symbols: ["NSE:RELIANCE"], everySec: 5 });
    const list = (await b.call("GET", "/v1/recordings")).json.data;
    expect(list.filter((r) => r.id === rec.json.data.id)).toHaveLength(1);
    const rule = await twice("/v1/recordings/rules", { name: "idem-rule", kind: "quotes", symbols: ["NSE:INFY"], everySec: 5 });
    expect(rule.json.data.id).toBeTruthy();
  });

  it("a repeated POST /v1/subscriptions creates one subscription", async () => {
    const first = await twice("/v1/subscriptions", { url: "http://127.0.0.1:9/in", topics: ["order.*"], secret: "0123456789abcdef-secret" });
    const list = (await b.call("GET", "/v1/subscriptions")).json.data;
    expect(list.filter((s) => s.id === first.json.data.id)).toHaveLength(1);
    expect(list).toHaveLength(1);
  });

  it("a repeated POST /v1/hooks creates one hook", async () => {
    await twice("/v1/hooks", { source: "generic", label: "idem-hook", account: "demo-paper" });
    expect((await b.call("GET", "/v1/hooks")).json.data.filter((h) => h.label === "idem-hook")).toHaveLength(1);
  });

  it("the same key with another body is 409 IDEMPOTENCY_KEY_REUSED, and a refused request can be retried", async () => {
    const h = { "Idempotency-Key": idk() };
    const bad = await b.call("POST", "/v1/collections", { body: { name: "bad name!" }, headers: h });
    expect(bad.status).toBe(400);
    const ok = await b.call("POST", "/v1/collections", { body: { name: "idem-retry", symbols: ["NSE:INFY"] }, headers: h });
    expect(ok.status, ok.text).toBe(201); // the 400 did not use up the key
    const other = await b.call("POST", "/v1/collections", { body: { name: "idem-other", symbols: ["NSE:INFY"] }, headers: h });
    expect(other.status).toBe(409);
    expect(other.json.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("a malformed key is a 400 and a write route that ignores the header says so", async () => {
    expect((await b.call("POST", "/v1/collections", { body: { name: "x1", symbols: [] }, headers: { "Idempotency-Key": "short" } })).status).toBe(400);
    const pause = await b.call("POST", "/v1/downloads/dl_nope/pause", { headers: { "Idempotency-Key": idk() } });
    expect(pause.headers.get("idempotency-ignored")).toBe("true");
  });

  it("every listed route is a real route and is documented with the header", () => {
    const routes = new Set(b.app.router.list().map((r) => `${r.method} ${r.pattern}`));
    for (const r of IDEMPOTENT_ROUTES) expect(routes.has(r), r).toBe(true);
    const spec = readFileSync(resolve(import.meta.dirname, "../../../docs/openapi.yaml"), "utf8");
    for (const r of IDEMPOTENT_ROUTES) {
      const [method, pattern] = r.split(" ");
      const path = pattern.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
      const at = spec.indexOf(`\n  ${path}:\n`);
      expect(at, path).toBeGreaterThan(0);
      const block = spec.slice(at + 1).split(/\n {2}\/\S*:\n/)[0];
      const op = block.split(new RegExp(`\\n {4}${method.toLowerCase()}:\\n`))[1]?.split(/\n {4}(?:get|post|put|patch|delete):\n/)[0] ?? "";
      expect(op, r).toContain("IdempotencyKey");
    }
  });
});
