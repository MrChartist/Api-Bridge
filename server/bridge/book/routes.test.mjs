/**
 * Book routes (p1-12 §4.3) on the real app: holders GET/PUT (admin, this computer only), the config lock, account
 * visibility, and GET /v1/book (JSON and CSV) with paper accounts across holders.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCallContext } from "../core/context.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { bootBridge } from "../e2e/fixtures.mjs";
import { DEFAULT_TOOL_NAMES, TOOL_DEFS, createToolRegistry } from "../mcp/tools.mjs";

let bridge;
const keys = {};
const remote = { "X-Forwarded-For": "192.0.2.50" };

beforeAll(async () => {
  bridge = await bootBridge({
    brokers: {},
    raw: {
      accounts: [
        { id: "me-paper", broker: "paper", label: "Mine" },
        { id: "asha-paper", broker: "paper", holder: "spouse", label: "Asha" },
        { id: "friend-paper", broker: "paper", holder: "friend", label: "Friend" },
      ],
      book: { holders: { friend: { relationship: "other", label: "Friend" } } },
      mcp: { toolsets: ["market", "analytics", "account", "options"] },
    },
  });
  const mk = async (label, scopes, accounts = "*") => (await bridge.deps.keyStore.create({ label, scopes, accounts, expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  keys.admin = await mk("admin", ["admin"]);
  keys.read = await mk("read", ["read"]);
  keys.mine = await mk("mine", ["read"], ["me-paper"]);
});

afterAll(async () => {
  await bridge?.close();
});

describe("book holder routes", () => {
  it("GET /v1/book/holders lists holders, relationships and family membership", async () => {
    const r = await bridge.http("/v1/book/holders", { key: keys.read });
    expect(r.status).toBe(200);
    const d = r.json.data;
    expect(d.family).toEqual({ name: "Family", relationships: ["self", "spouse", "dependent-child", "dependent-parent"] });
    expect(d.relationships.map((x) => x.value)).toEqual(["self", "spouse", "dependent-child", "dependent-parent", "huf", "other"]);
    expect(d.holders.map((h) => [h.holder, h.relationship, h.inFamily, h.locked, h.accounts])).toEqual([
      ["self", "self", true, false, ["me-paper"]],
      ["spouse", null, false, false, ["asha-paper"]],
      ["friend", "other", false, true, ["friend-paper"]],
    ]);
  });

  it("a key limited to some accounts sees only holders with one of its accounts", async () => {
    const r = await bridge.http("/v1/book/holders", { key: keys.mine });
    expect(r.json.data.holders.map((h) => h.holder)).toEqual(["self"]);
  });

  it("PUT needs admin on this computer; sets the tag; a config lock answers 409", async () => {
    const body = { relationship: "spouse", label: "Asha" };
    expect((await bridge.http("/v1/book/holders/spouse", { method: "PUT", key: keys.read, body })).status).toBe(403);
    const far = await bridge.http("/v1/book/holders/spouse", { method: "PUT", key: keys.admin, body, headers: remote });
    expect(far.status).toBe(403);
    expect(far.json.code).toBe("LOOPBACK_ONLY");
    const ok = await bridge.http("/v1/book/holders/spouse", { method: "PUT", key: keys.admin, body });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ holder: "spouse", relationship: "spouse", inFamily: true, label: "Asha", accounts: ["asha-paper"] });
    const again = await bridge.http("/v1/book/holders", { key: keys.read });
    expect(again.json.data.holders.find((h) => h.holder === "spouse")).toMatchObject({ relationship: "spouse", inFamily: true, source: "file" });
    const locked = await bridge.http("/v1/book/holders/friend", { method: "PUT", key: keys.admin, body });
    expect(locked.status).toBe(409);
    expect(locked.json.code).toBe("STATE_CONFLICT");
    const bad = await bridge.http("/v1/book/holders/spouse", { method: "PUT", key: keys.admin, body: { relationship: "cousin" } });
    expect(bad.status).toBe(400);
    const badName = await bridge.http(`/v1/book/holders/${encodeURIComponent("a/b")}`, { method: "PUT", key: keys.admin, body });
    expect([400, 404]).toContain(badName.status);
  });
});

describe("GET /v1/book", () => {
  it("answers holders and family views; validates the query; checks named accounts", async () => {
    const h = await bridge.http("/v1/book", { key: keys.read });
    expect(h.status).toBe(200);
    expect(h.json.data).toMatchObject({ view: "holders", family: null, outsideFamily: [] });
    expect(h.json.data.holders.map((x) => x.holder)).toEqual(["self", "spouse", "friend"]);
    for (const x of h.json.data.holders) expect(x.priceSource).toEqual({ kind: "paper" });
    const f = await bridge.http("/v1/book?view=family", { key: keys.read });
    expect(f.json.data.family.holders).toEqual(["self", "spouse"]);
    expect(f.json.data.outsideFamily.map((x) => x.holder)).toEqual(["friend"]);
    expect((await bridge.http("/v1/book?view=everyone", { key: keys.read })).status).toBe(400);
    expect((await bridge.http("/v1/book?nope=1", { key: keys.read })).status).toBe(400);
    expect((await bridge.http("/v1/book?account=friend-paper", { key: keys.mine })).status).toBe(403);
    expect((await bridge.http("/v1/book?account=ghost-acct", { key: keys.read })).status).toBe(404);
    const part = await bridge.http("/v1/book?view=family", { key: keys.mine });
    expect(part.json.data.family.totals.partial).toBe(true);
    expect(part.json.data.holders.flatMap((x) => x.accounts.map((a) => a.account))).toEqual(["me-paper"]);
  });

  it("format=csv downloads one row per leg", async () => {
    const r = await bridge.http("/v1/book?format=csv", { key: keys.read });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/csv/);
    expect(r.text.split("\r\n")[0]).toBe("holder,relationship,inFamily,account,underlying,symbol,qty,avg,mark,markSource,pnl,iv,delta,gamma,theta,vega");
  });
});

describe("MCP get_book", () => {
  it("is read-only, opt-in, and returns the same holders as the REST route for the key's accounts", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "get_book");
    expect(def).toMatchObject({ toolset: "options", annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(def.requiredScope).toBeUndefined();
    expect(DEFAULT_TOOL_NAMES).not.toContain("get_book");
    const registry = createToolRegistry({ deps: bridge.deps });
    const key = { id: "kmcp", label: "mcp", scopes: ["read"], accounts: ["me-paper", "asha-paper"], createdAt: "2026-10-18T10:00:00+05:30" };
    const ctx = createCallContext({ source: "mcp", key, log: createNullLogger() });
    const out = await registry.call("get_book", { view: "holders", underlying: null }, ctx);
    expect(out.isError, JSON.stringify(out.content)).toBeUndefined();
    expect(out.structuredContent.data.holders.map((h) => h.holder)).toEqual(["self", "spouse"]);
    expect(out.structuredContent.data.truncated).toBe(false);
  });
});
