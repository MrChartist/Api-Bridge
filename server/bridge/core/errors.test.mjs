import { describe, expect, it } from "vitest";
import { BrokerError, SessionRequiredError } from "../../brokers/contract.mjs";
import { BridgeError, ERROR_CODES, NotImplementedError, fromBrokerError, fromValidation, problemHeaders, toProblem } from "./errors.mjs";

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
    const e = new NotImplementedError("KeyStore.list() (stream S2)");
    expect(e.status).toBe(501);
    expect(e.detail).toContain("stream S2");
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
      { path: "order.qty", message: "must be positive" },
      { path: "(root)", message: "bad" },
    ]);
  });
});
