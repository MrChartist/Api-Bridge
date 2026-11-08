import { describe, expect, it } from "vitest";
import * as proto from "./protocol.mjs";

const ok = (m) => proto.parseChildMessage(typeof m === "string" ? m : JSON.stringify(m));
const bad = (m, re) => {
  const r = ok(m);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(re);
};

describe("parseChildMessage", () => {
  it("accepts every valid child message", () => {
    expect(ok({ type: "ready", apiVersion: 1, capabilities: ["quotes"] }).ok).toBe(true);
    expect(ok({ type: "result", id: 3, data: { items: [] } }).ok).toBe(true);
    expect(ok({ type: "error", id: 3, code: "NOT_FOUND", message: "x", retryAfterMs: 5 }).ok).toBe(true);
    expect(ok({ type: "log", level: "info", msg: "hi" }).ok).toBe(true);
    expect(ok({ type: "fetch", id: 1, url: "https://a.example.com/x", init: { method: "GET", headers: { accept: "a" } } }).ok).toBe(true);
    expect(ok({ type: "pong", id: 1 }).ok).toBe(true);
  });

  it("rejects invalid JSON, non-objects and arrays", () => {
    bad("{nope", /not valid JSON/);
    bad("42", /not an object/);
    bad("null", /not an object/);
    bad("[1,2]", /not an object/);
    bad('"text"', /not an object/);
    bad("", /not valid JSON/);
  });

  it("rejects unknown types, missing fields, extra fields and bad ids", () => {
    bad({ type: "exec", cmd: "id" }, /invalid/);
    bad({ type: "result", data: {} }, /id/);
    bad({ type: "result", id: 0, data: {} }, /id/);
    bad({ type: "result", id: 1.5, data: {} }, /id/);
    bad({ type: "result", id: "1", data: {} }, /id/);
    bad({ type: "result", id: 1, data: {}, extra: true }, /invalid/);
    bad({ type: "fetch", id: 1, url: "https://a.example.com", init: { agent: "x" } }, /init/);
    bad({ type: "fetch", id: 1, url: "x".repeat(3000) }, /url/);
    bad({ type: "log", level: "fatal", msg: "x" }, /level/);
    bad({ type: "error", id: 1, code: "X", retryAfterMs: -1 }, /retryAfterMs/);
    bad({ type: "ready", apiVersion: "1", capabilities: [] }, /apiVersion/);
    bad({}, /invalid/);
  });

  it("rejects a message over the size cap", () => {
    bad(JSON.stringify({ type: "result", id: 1, data: "x".repeat(proto.MAX_MESSAGE_BYTES) }), /too large/);
  });

  it("strips __proto__, constructor and prototype keys instead of letting them through", () => {
    const r = ok('{"type":"result","id":1,"data":{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":2,"a":{"__proto__":1,"b":2}}}');
    expect(r.ok).toBe(true);
    expect(r.msg.data).toEqual({ a: { b: 2 } });
    expect({}.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(r.msg.data)).toBe(Object.prototype);
  });

  it("rejects deeply nested JSON and huge value counts", () => {
    let deep = '"x"';
    for (let i = 0; i < 40; i += 1) deep = `[${deep}]`;
    bad(`{"type":"result","id":1,"data":${deep}}`, /deeply/);
    const wide = `[${Array(proto.MAX_JSON_NODES + 5).fill(1).join(",")}]`;
    expect(Buffer.byteLength(wide)).toBeLessThan(proto.MAX_MESSAGE_BYTES);
    bad(`{"type":"result","id":1,"data":${wide}}`, /too many/);
  });

  it("keeps data opaque for the capability checks", () => {
    expect(ok({ type: "result", id: 1, data: { n: "NaN", i: "Infinity" } }).msg.data).toEqual({ n: "NaN", i: "Infinity" });
  });
});

describe("LineDecoder", () => {
  it("splits lines across chunks and multi-byte characters", () => {
    const d = new proto.LineDecoder();
    const bytes = Buffer.from('{"a":"₹"}\n{"b":2}\n');
    const out = [...d.push(bytes.subarray(0, 7)), ...d.push(bytes.subarray(7, 9)), ...d.push(bytes.subarray(9))];
    expect(out).toEqual([{ line: '{"a":"₹"}' }, { line: '{"b":2}' }]);
  });

  it("handles CRLF, blank lines and strings", () => {
    const d = new proto.LineDecoder();
    expect(d.push('a\r\n\n\nb\n')).toEqual([{ line: "a" }, { line: "b" }]);
  });

  it("reports a line that never ends once it passes the cap, then goes quiet", () => {
    const d = new proto.LineDecoder(100);
    expect(d.push(Buffer.alloc(60, 97))).toEqual([]);
    expect(d.push(Buffer.alloc(60, 97))).toEqual([{ error: "message too large" }]);
    expect(d.push("more\n")).toEqual([]);
    expect(d.buf.length).toBe(0);
  });

  it("reports a complete line that is too long", () => {
    const d = new proto.LineDecoder(10);
    expect(d.push(`${"x".repeat(50)}\nok\n`)).toEqual([{ error: "message too large" }]);
  });

  it("never buffers much more than the cap for a flood without newlines", () => {
    const d = new proto.LineDecoder(1000);
    let errors = 0;
    for (let i = 0; i < 200; i += 1) errors += d.push(Buffer.alloc(500, 1)).filter((e) => e.error).length;
    expect(errors).toBe(1);
    expect(d.buf.length).toBe(0);
  });
});

describe("host-to-child messages", () => {
  it("are single lines of JSON", () => {
    for (const line of [proto.hello("2"), proto.init({ a: 1 }, { apiKey: "k" }), proto.call(1, "quotes", { symbols: ["A"] }, 5000, 1), proto.cancel(1), proto.ping(1), proto.shutdown(), proto.fetchOk(1, 200, {}, "x\ny"), proto.fetchFail(1, "RATE_LIMITED", "slow", 5)]) {
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1)).not.toContain("\n");
      expect(JSON.parse(line).type).toBeTypeOf("string");
    }
    expect(JSON.parse(proto.hello("2"))).toMatchObject({ protocol: "bridge-source/1", apiVersion: 1 });
  });

  it("carry the secrets only in init", () => {
    const lines = [proto.hello("2"), proto.call(1, "quotes", {}, 1, 1), proto.cancel(1), proto.ping(1), proto.shutdown(), proto.fetchOk(1, 200, {}, "")];
    expect(lines.join("")).not.toContain("canary");
    expect(proto.init({}, { apiKey: "canary" })).toContain("canary");
  });
});

describe("error code map", () => {
  it("maps every plugin code to a code the Bridge's taxonomy knows", async () => {
    const { ERROR_CODES } = await import("../../core/errors.mjs");
    for (const bridge of Object.values(proto.PLUGIN_ERROR_CODES)) expect(ERROR_CODES[bridge]).toBeDefined();
    expect(proto.PLUGIN_ERROR_CODES).toMatchObject({ RATE_LIMITED: "UPSTREAM_RATE_LIMITED", UNAVAILABLE: "BROKER_UNAVAILABLE", TIMEOUT: "UPSTREAM_TIMEOUT", NOT_FOUND: "SYMBOL_NOT_FOUND", UNSUPPORTED: "CAPABILITY_UNSUPPORTED" });
  });
});
