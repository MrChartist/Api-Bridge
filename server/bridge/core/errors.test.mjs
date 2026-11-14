import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BrokerError, SessionRequiredError } from "../../brokers/contract.mjs";
import { BridgeError, ERROR_CODES, FIELD_ERROR_CODES, NotImplementedError, fromBrokerError, fromValidation, problemHeaders, toProblem } from "./errors.mjs";

describe("error taxonomy", () => {
  it("every code has an HTTP status, a title and a retryable flag", () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      expect(code).toMatch(/^[A-Z_]+$/);
      expect(spec.status).toBeGreaterThanOrEqual(400);
      expect(spec.status).toBeLessThan(600);
      expect(spec.title.length).toBeGreaterThan(3);
      expect(typeof spec.retryable).toBe("boolean");
    }
  });

  it("an order whose outcome is unknown is never retryable", () => {
    expect(ERROR_CODES.OUTCOME_UNKNOWN.retryable).toBe(false);
    expect(ERROR_CODES.RATE_LIMITED.retryable).toBe(true);
  });

  it("toProblem builds RFC 9457 problem details", () => {
    const p = toProblem(new BridgeError("SYMBOL_NOT_FOUND", "No such symbol NSE:XYZ."), { requestId: "req_1" });
    expect(p).toMatchObject({ status: 404, code: "SYMBOL_NOT_FOUND", retryable: false, detail: "No such symbol NSE:XYZ.", requestId: "req_1" });
    expect(p.type).toBe("https://bridge.mrchartist.local/errors/symbol-not-found");
  });

  it("toProblem never leaks the message of an unexpected error", () => {
    const p = toProblem(new Error("secret db path /home/x"));
    expect(p.code).toBe("INTERNAL");
    expect(p.status).toBe(500);
    expect(JSON.stringify(p)).not.toContain("/home/x");
  });

  it("unknown codes collapse to INTERNAL", () => {
    expect(new BridgeError("NOPE").code).toBe("INTERNAL");
  });

  it("Retry-After is whole seconds, at least 1", () => {
    expect(problemHeaders(new BridgeError("RATE_LIMITED", undefined, { retryAfterMs: 1200 }))["Retry-After"]).toBe("2");
    expect(problemHeaders(new BridgeError("RATE_LIMITED", undefined, { retryAfterMs: 10 }))["Retry-After"]).toBe("1");
    expect(problemHeaders(new BridgeError("NOT_FOUND"))).toEqual({});
  });

  it("NotImplementedError is a 501", () => {
    const e = new NotImplementedError("KeyStore.list()");
    expect(e.status).toBe(501);
    expect(e.detail).toContain("KeyStore.list()");
  });

  it("maps broker contract errors and keeps the broker code", () => {
    const s = fromBrokerError(new SessionRequiredError(), { brokerId: "angelone" });
    expect(s.code).toBe("SESSION_EXPIRED");
    expect(s.broker).toMatchObject({ id: "angelone", code: "SESSION_LOGIN_REQUIRED" });
    expect(fromBrokerError(new BrokerError("slow", { code: "UPSTREAM_TIMEOUT" })).code).toBe("UPSTREAM_TIMEOUT");
    expect(fromBrokerError(new BrokerError("throttled", { code: "UPSTREAM_RATE_LIMIT" })).code).toBe("UPSTREAM_RATE_LIMITED");
  });

  it("a failed or timed-out WRITE becomes OUTCOME_UNKNOWN, never a retryable error", () => {
    expect(fromBrokerError(new BrokerError("slow", { code: "UPSTREAM_TIMEOUT" }), { write: true }).code).toBe("OUTCOME_UNKNOWN");
    expect(fromBrokerError(new Error("socket hang up"), { write: true }).code).toBe("OUTCOME_UNKNOWN");
    const refused = fromBrokerError(new BrokerError("bad qty", { code: "BROKER_INPUT_INVALID", statusCode: 422 }), { write: true });
    expect(refused.code).toBe("VALIDATION_FAILED");
  });

  it("fromValidation lists field errors", () => {
    const e = fromValidation({ issues: [{ path: ["order", "qty"], message: "must be positive" }, { path: [], message: "bad" }] });
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.errors).toEqual([
      { path: "order.qty", code: "invalid", message: "must be positive" },
      { path: "(root)", code: "invalid", message: "bad" },
    ]);
  });

  it("gives every field problem a machine code, the allowed values of a list, and plain words instead of the library's", () => {
    const schema = z
      .object({ symbol: z.string(), side: z.enum(["BUY", "SELL"]), qty: z.number().int().min(1).max(100), name: z.string().min(2), note: z.string({ error: "note must be text" }), tags: z.array(z.string()).min(1), when: z.union([z.string(), z.number()]), n: z.int() })
      .strict();
    const r = schema.safeParse({ side: "HOLD", qty: 0, name: "a", note: 5, tags: [], when: true, n: 1.5, extra: 1 });
    const e = fromValidation(r.error).errors;
    const by = Object.fromEntries(e.map((x) => [x.path, x]));
    expect(by.symbol).toEqual({ path: "symbol", code: "required", message: "This field is required." });
    expect(by.side).toEqual({ path: "side", code: "invalid_enum", message: "Must be one of: BUY, SELL.", allowed: ["BUY", "SELL"] });
    expect(by.qty).toMatchObject({ code: "too_small", message: "Too small: at least 1 is needed." });
    expect(by.name).toMatchObject({ code: "too_small", message: "Too small: at least 2 characters is needed." });
    expect(by.tags).toMatchObject({ code: "too_small", message: "Too small: at least 1 item is needed." });
    expect(by.note).toEqual({ path: "note", code: "invalid_type", message: "note must be text" }); // a message written on purpose is kept
    expect(by.when).toMatchObject({ code: "invalid", message: "Not one of the accepted forms." });
    expect(by.n).toMatchObject({ code: "invalid_type", message: "Must be a whole number." });
    expect(by.extra).toEqual({ path: "extra", code: "unknown_field", message: "Unknown field: extra." });
    expect(JSON.stringify(e)).not.toMatch(/Invalid input|received undefined|Invalid option/);
    for (const x of e) expect(FIELD_ERROR_CODES).toContain(x.code);
  });

  it("a request the broker refused as malformed still carries an errors[] entry", () => {
    const refused = fromBrokerError(new BrokerError("expiry not listed", { code: "BROKER_INPUT_INVALID", statusCode: 422 }));
    expect(refused.errors).toEqual([{ path: "(request)", code: "broker_rejected", message: "expiry not listed" }]);
    expect(fromBrokerError(new BrokerError("down", { code: "UPSTREAM_TIMEOUT" })).errors).toBeUndefined();
  });
});
