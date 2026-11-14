/** Collection writes are audited (audit "security", S6): create, change, duplicate, import, replace and delete leave a record with the actor. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLibraryApp } from "./__fixtures__/app.mjs";

let t;
const records = [];
let sink = async (e) => records.push(e);
beforeAll(async () => {
  t = await startLibraryApp({ overrides: { audit: { append: (e) => sink(e), query: async () => ({ items: [], nextCursor: null }), verify: async () => ({ ok: true }) } } });
});
afterAll(async () => t.close());

const w = (path, body, method = "POST", query = "", key = t.keys.read) => t.request(path + query, { method, key, body });
const types = () => records.map((r) => r.type);

describe("collection writes are audited", () => {
  it("records create, update, duplicate, import with replace and delete, with who did it and never the symbols", async () => {
    expect((await w("/v1/collections", { name: "banks", symbols: ["NSE:HDFCBANK", "NSE:ICICIBANK"] })).status).toBe(201);
    expect((await w("/v1/collections/banks", { description: "x" }, "PATCH")).status).toBe(200);
    expect((await w("/v1/collections/banks/duplicate", { name: "banks2" })).status).toBe(201);
    expect((await w("/v1/collections/import", { name: "banks", symbols: ["NSE:SBIN"] }, "POST", "?replace=true", t.keys.admin)).status).toBe(201);
    expect((await t.request("/v1/collections/banks2", { method: "DELETE", key: t.keys.admin })).status).toBe(204);
    expect(types()).toEqual(["collection.created", "collection.updated", "collection.created", "collection.imported", "collection.deleted"]);
    expect(records.every((r) => r.actor.kind === "key" && r.actor.id && r.source && r.requestId)).toBe(true);
    expect(records[3].data).toMatchObject({ replace: true, replaced: ["banks"] });
    expect(records[4].data).toMatchObject({ name: "banks2", force: false });
    expect(JSON.stringify(records)).not.toContain("HDFCBANK");
  });

  it("a failed audit write does not undo the change", async () => {
    sink = async () => {
      throw new Error("disk full");
    };
    expect((await w("/v1/collections", { name: "kept", symbols: ["NSE:SBIN"] })).status).toBe(201);
    expect((await t.request("/v1/collections/kept", { key: t.keys.read })).status).toBe(200);
  });
});
