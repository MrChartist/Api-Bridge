/**
 * Order-safety contract cases for every adapter (contractOrderCases.mjs), on recorded replies with no network, plus proof
 * that the cases catch the mistakes they exist for (a fake adapter that makes each mistake must fail them).
 */
import { describe, expect, it } from "vitest";
import { BrokerError, OrderIdMissingError, SESSION_ERROR_CODES, withOrderGate } from "./contract.mjs";
import { issueOrderGate } from "./orderGate.mjs";
import { createBrokerRegistry } from "./registry.mjs";
import { loadFixtures } from "./contractHarness.mjs";
import { CASE_LABELS, buildContractMatrix, renderVerificationSection } from "./contractMatrix.mjs";
import { ORDER_CASES, loadOrderCases, runOrderSafetyCases, bridgeCodeOfWrite } from "./contractOrderCases.mjs";
import { guardAdapterErrors, sessionErrorCode } from "./errorGuard.mjs";
import { fromBrokerError } from "../bridge/core/errors.mjs";

describe("order-safety contract cases, every adapter", () => {
  it("no adapter fails any case; gaps are listed as needs fixture, never hidden", async () => {
    const rows = await buildContractMatrix();
    expect(rows).toHaveLength(41);
    expect(rows.flatMap((r) => r.failures)).toEqual([]);
    for (const r of rows) {
      if (!r.hasOrders) continue;
      expect(Object.keys(r.cases), r.id).toEqual([...ORDER_CASES]);
      for (const c of Object.values(r.cases)) expect(["pass", "needs-fixture", "n/a"]).toContain(c.state);
    }
  });

  it("every case an adapter is held to is derived from its recorded sample or carries a source", () => {
    for (const id of createBrokerRegistry().list()) {
      const cases = loadOrderCases(id);
      if (!cases) continue;
      for (const r of cases.refusals ?? []) expect(r.source, `${id} refusal ${r.name}`).toMatch(/^https:\/\//);
      if (cases.sessionExpired) expect(cases.sessionExpired.source, `${id} session`).toMatch(/^https:\/\//);
      if (cases.stopLoss && cases.stopLoss.offered !== false) expect(cases.stopLoss.source, `${id} stopLoss`).toMatch(/^https:\/\//);
      expect(cases.provenance, id).toMatch(/official documentation/);
    }
  });

  it("the generated table names every case and every broker", async () => {
    const rows = await buildContractMatrix();
    const text = renderVerificationSection(rows);
    for (const label of Object.values(CASE_LABELS)) expect(text).toContain(label);
    for (const r of rows) expect(text).toContain(`\`${r.id}\``);
  });
});

describe("the central order guard", () => {
  const gate = (action = "placeOrder") => issueOrderGate({ verdict: { ok: true }, liveArmed: true, action, brokerId: "x" });

  it("turns an order reply with no order id into an OrderIdMissingError the Bridge reads as OUTCOME_UNKNOWN", async () => {
    for (const reply of [{ orderId: "", orderStatus: "UNKNOWN" }, {}, null, { orderId: "  " }, { orderId: 12345 }]) {
      const place = withOrderGate("placeOrder", async () => reply, { brokerId: "x" });
      const err = await place({}, {}, 75, gate()).then(() => null, (e) => e);
      expect(err, JSON.stringify(reply)).toBeInstanceOf(OrderIdMissingError);
      expect(err).toBeInstanceOf(BrokerError);
      expect(bridgeCodeOfWrite(err)).toBe("OUTCOME_UNKNOWN");
    }
  });

  it("passes a real order id through and does not apply to modify or cancel", async () => {
    const place = withOrderGate("placeOrder", async () => ({ orderId: "77", orderStatus: "OPEN" }), { brokerId: "x" });
    await expect(place({}, {}, 75, gate())).resolves.toEqual({ orderId: "77", orderStatus: "OPEN" });
    const cancel = withOrderGate("cancelOrder", async () => ({ orderId: "", orderStatus: "UNKNOWN" }), { brokerId: "x" });
    await expect(cancel({}, "77", gate("cancelOrder"))).resolves.toEqual({ orderId: "", orderStatus: "UNKNOWN" });
  });
});

/** A small adapter that makes one chosen mistake, to prove the cases catch it. */
function fakeAdapter(mistake) {
  const send = async (body) => {
    const res = await fetch("https://api.fake.example/order", { method: "POST", body: JSON.stringify(body) });
    return res;
  };
  const place = async (creds, order) => {
    let res;
    try {
      res = await send(order);
    } catch (e) {
      if (mistake === "retries") res = await send(order); // blind retry after a lost reply
      else throw e;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (mistake === "fakeId") return { orderId: json?.id ?? "local-1", orderStatus: "OPEN" }; // invents an id
    if (mistake === "ignoresErrorBody") return { orderId: String(json?.id ?? "9"), orderStatus: "OPEN" };
    if (json?.stat === "Not_Ok") throw new BrokerError(`refused: ${json.emsg}`);
    if (!json?.id) throw new OrderIdMissingError();
    return { orderId: String(json.id), orderStatus: "OPEN" };
  };
  return {
    id: "fakebroker",
    capabilities: { placeOrder: true },
    placeOrder: withOrderGate("placeOrder", place, { brokerId: "fakebroker" }),
    normaliseError: (err) => ({ statusCode: 502, code: /session/i.test(String(err?.message)) ? "UPSTREAM_AUTH" : "UPSTREAM_ERROR", message: String(err?.message) }),
  };
}
const fakeFixtures = {
  manifest: { creds: {}, symbol: "NIFTY", expiry: "2026-12-31" },
  byCapability: { placeOrder: { args: [{ orderType: "LIMIT", side: "BUY", price: 100, lots: 1 }, 75], responses: [{ method: "POST", url: "https://api.fake.example/order", json: { stat: "Ok", id: "ORD1" } }] } },
};
const fakeCases = { refusals: [{ name: "Not_Ok", source: "https://example.test/docs", reply: { status: 200, json: { stat: "Not_Ok", emsg: "RMS: margin" } } }] };

describe("the cases catch the mistakes they exist for", () => {
  it("passes a careful adapter", async () => {
    const r = await runOrderSafetyCases(fakeAdapter("none"), fakeFixtures, { cases: fakeCases });
    expect(r.cases.missingOrderId.state).toBe("pass");
    expect(r.cases.garbledReply.state).toBe("pass");
    expect(r.cases.lostReply.state).toBe("pass");
    expect(r.cases.refusedBody.state).toBe("pass");
  });

  it("fails an adapter that invents an order id when the reply has none", async () => {
    const r = await runOrderSafetyCases(fakeAdapter("fakeId"), fakeFixtures, { cases: fakeCases });
    expect(r.cases.missingOrderId.state).toBe("fail");
    expect(r.cases.garbledReply.state).toBe("fail");
  });

  it("fails an adapter that reads a refusal body as a placement", async () => {
    const r = await runOrderSafetyCases(fakeAdapter("ignoresErrorBody"), fakeFixtures, { cases: fakeCases });
    expect(r.cases.refusedBody.state).toBe("fail");
  });

  it("fails an adapter that sends the order again after a lost reply", async () => {
    const r = await runOrderSafetyCases(fakeAdapter("retries"), fakeFixtures, { cases: fakeCases });
    expect(r.cases.lostReply.state).toBe("fail");
    expect(r.cases.lostReply.problems.join(" ")).toMatch(/2 times/);
  });

  it("marks a broker with no refusal or session fixture as needs fixture, not pass", async () => {
    const r = await runOrderSafetyCases(fakeAdapter("none"), fakeFixtures, { cases: null });
    expect(r.cases.refusedBody.state).toBe("needs-fixture");
    expect(r.cases.sessionExpired.state).toBe("needs-fixture");
  });

  it("fails an adapter that drops the trigger price of a stop-loss order", async () => {
    const dropsTrigger = fakeAdapter("none");
    const base = dropsTrigger.placeOrder;
    expect(base).toBeTypeOf("function");
    const noTrigger = {
      ...dropsTrigger,
      placeOrder: withOrderGate("placeOrder", async (creds, order) => {
        const res = await fetch("https://api.fake.example/order", { method: "POST", body: JSON.stringify({ type: order.orderType, price: order.price }) });
        return { orderId: String((await res.json()).id), orderStatus: "OPEN" };
      }, { brokerId: "fakebroker" }),
    };
    const r = await runOrderSafetyCases(noTrigger, fakeFixtures, { cases: fakeCases });
    expect(r.cases.stopLoss.state).toBe("fail");
    expect(r.cases.stopLoss.problems.join(" ")).toMatch(/trigger price/);
  });

  it("fails a session-ended reply that is not tagged as a session error", async () => {
    const cases = { ...fakeCases, sessionExpired: { source: "https://example.test/docs", reply: { status: 200, json: { stat: "Not_Ok", emsg: "Something odd" } } } };
    const r = await runOrderSafetyCases(fakeAdapter("none"), fakeFixtures, { cases });
    expect(r.cases.sessionExpired.state).toBe("fail");
  });

  it("passes a session-ended reply that the adapter's own normaliseError recognises (the guard tags it)", async () => {
    const cases = { ...fakeCases, sessionExpired: { source: "https://example.test/docs", reply: { status: 200, json: { stat: "Not_Ok", emsg: "Session expired" } } } };
    const r = await runOrderSafetyCases(fakeAdapter("none"), fakeFixtures, { cases });
    expect(r.cases.sessionExpired.state).toBe("pass");
  });
});

describe("errorGuard: session errors are tagged for the Bridge", () => {
  const adapter = {
    id: "g",
    capabilities: { auth: { kind: "apiKeyToken" } },
    normaliseError: (e) => ({ statusCode: 502, code: /expired/.test(e?.message) ? "UPSTREAM_AUTH" : "UPSTREAM_ERROR", message: e?.message }),
    async fetchFunds() { throw new Error("token expired"); },
    async fetchPositions() { throw new Error("boom"); },
    async login() { throw new Error("token expired"); },
    fetchSync() { throw new Error("token expired"); },
    value: 7,
  };

  it("adds a session code to an error the adapter's normaliseError calls a session error, and nothing else", async () => {
    const g = guardAdapterErrors(adapter);
    const e1 = await g.fetchFunds({}).then(() => null, (e) => e);
    expect(SESSION_ERROR_CODES).toContain(e1.code);
    expect(e1.message).toBe("token expired");
    expect(fromBrokerError(e1, { write: true }).code).toBe("SESSION_EXPIRED");
    const e2 = await g.fetchPositions({}).then(() => null, (e) => e);
    expect(e2.code).toBeUndefined();
    expect(() => g.fetchSync()).toThrow(/token expired/);
    expect(sessionErrorCode(adapter, Object.assign(new Error("x"), { code: "SESSION_LOGIN_REQUIRED" }))).toBe("SESSION_LOGIN_REQUIRED");
    expect(g.value).toBe(7);
    expect(g.id).toBe("g");
  });

  it("leaves login errors alone: a refused login is bad input, not an expired session", async () => {
    const e = await guardAdapterErrors(adapter).login({}).then(() => null, (x) => x);
    expect(e.code).toBeUndefined();
  });

  it("keeps the order-gate marker so gated methods stay recognisable", () => {
    const gated = withOrderGate("placeOrder", async () => ({ orderId: "1" }), { brokerId: "g" });
    const g = guardAdapterErrors({ ...adapter, placeOrder: gated });
    expect(g.placeOrder).not.toBe(gated);
    expect(Object.getOwnPropertySymbols(g.placeOrder)).toEqual(Object.getOwnPropertySymbols(gated));
  });
});

describe("real adapters: the Bridge sees their own session wording as a session error on reads and orders", () => {
  it("Dhan DH-901 and Zerodha TokenException reach the scheduler with a session code", async () => {
    const reg = createBrokerRegistry();
    const cases = [
      ["dhan", { status: 401, json: { errorType: "Invalid_Authentication", errorCode: "DH-901", errorMessage: "Client ID or user generated access token is invalid or expired." } }],
      ["zerodha", { status: 403, json: { status: "error", message: "Incorrect `api_key` or `access_token`.", data: null, error_type: "TokenException" } }],
    ];
    for (const [id, reply] of cases) {
      const adapter = guardAdapterErrors(reg.get(id));
      const fixtures = loadFixtures(id);
      const fx = fixtures.byCapability.funds;
      const r = fx.responses.map((x) => ({ ...x, ...reply }));
      const real = globalThis.fetch;
      const { createFetchStub } = await import("./contractHarness.mjs");
      globalThis.fetch = createFetchStub(r).fetch;
      try {
        const err = await adapter.fetchFunds({ ...fixtures.manifest.creds, ...(fx.creds ?? {}) }).then(() => null, (e) => e);
        expect(SESSION_ERROR_CODES, `${id}: ${err?.code}`).toContain(err?.code);
      } finally {
        globalThis.fetch = real;
      }
    }
  });
});
