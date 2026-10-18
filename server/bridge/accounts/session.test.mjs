import { describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import {
  deriveState,
  describeRecord,
  mergeValues,
  nextIstTimeMs,
  pickSessionFields,
  sessionExpiryFor,
  toIstIso,
  validateConnectInput,
} from "./session.mjs";
import { apiKeyAdapter, oauthAdapter, sessionAdapter } from "./__fixtures__/stubs.mjs";

const expectCode = (fn, code) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error("expected a throw");
};

describe("session expiry times", () => {
  it("nextIstTimeMs picks the next HH:MM IST strictly after now", () => {
    const now = Date.parse("2026-10-19T03:30:00Z"); // 09:00 IST
    expect(new Date(nextIstTimeMs(6, 0, now)).toISOString()).toBe("2026-10-20T00:30:00.000Z"); // 06:00 IST tomorrow
    expect(new Date(nextIstTimeMs(15, 30, now)).toISOString()).toBe("2026-10-19T10:00:00.000Z"); // 15:30 IST today
    expect(new Date(nextIstTimeMs(9, 0, now)).toISOString()).toBe("2026-10-20T03:30:00.000Z"); // exactly now -> tomorrow
  });

  it("handles a time just after IST midnight (UTC date is still the previous day)", () => {
    const now = Date.parse("2026-10-18T19:00:00Z"); // 00:30 IST on the 19th
    expect(new Date(nextIstTimeMs(6, 0, now)).toISOString()).toBe("2026-10-19T00:30:00.000Z");
  });

  it("sessionExpiryFor: apiKeyToken has no daily expiry; oauth uses tokenExpiry; others the next IST midnight", () => {
    const now = Date.parse("2026-10-19T03:30:00Z");
    expect(sessionExpiryFor({ kind: "apiKeyToken" }, now)).toBeNull();
    expect(sessionExpiryFor(undefined, now)).toBeNull();
    expect(new Date(sessionExpiryFor({ kind: "oauthRedirect", tokenExpiry: "03:30 IST next day" }, now)).toISOString()).toBe("2026-10-19T22:00:00.000Z");
    expect(new Date(sessionExpiryFor({ kind: "requestTokenExchange" }, now)).toISOString()).toBe("2026-10-19T18:30:00.000Z");
    expect(new Date(sessionExpiryFor({ kind: "oauthRedirect", tokenExpiry: "whenever" }, now)).toISOString()).toBe("2026-10-19T18:30:00.000Z");
  });

  it("toIstIso writes +05:30 times and passes null through", () => {
    expect(toIstIso(Date.parse("2026-10-19T03:30:00Z"))).toBe("2026-10-19T09:00:00+05:30");
    expect(toIstIso(null)).toBeNull();
  });
});

describe("validateConnectInput", () => {
  it("accepts declared values for a key broker", () => {
    expect(validateConnectInput(apiKeyAdapter(), { values: { clientId: "100", accessToken: "tok" } })).toEqual({ values: { clientId: "100", accessToken: "tok" }, secrets: {} });
    expect(validateConnectInput(apiKeyAdapter(), undefined)).toEqual({ values: {}, secrets: {} });
  });

  it("refuses unknown keys, secret-looking keys and non-text values without echoing values", () => {
    const err = expectCode(() => validateConnectInput(apiKeyAdapter(), { values: { password: "hunter2-very-secret", foo: "x" } }), "VALIDATION_FAILED");
    expect(JSON.stringify(err.errors)).not.toContain("hunter2");
    expect(err.errors.map((e) => e.path)).toEqual(["values.password", "values.foo"]);
    expectCode(() => validateConnectInput(apiKeyAdapter(), { values: { clientId: 5 } }), "VALIDATION_FAILED");
    expectCode(() => validateConnectInput(apiKeyAdapter(), { values: { "bad key": "x" } }), "VALIDATION_FAILED");
    expectCode(() => validateConnectInput(apiKeyAdapter(), { values: [] }), "VALIDATION_FAILED");
    expectCode(() => validateConnectInput(apiKeyAdapter(), { values: { clientId: "x".repeat(4097) } }), "VALIDATION_FAILED");
    expectCode(() => validateConnectInput(apiKeyAdapter(), { other: 1 }), "VALIDATION_FAILED");
    expectCode(() => validateConnectInput(apiKeyAdapter(), "nope"), "VALIDATION_FAILED");
  });

  it("refuses secrets for a broker that has no session login", () => {
    expectCode(() => validateConnectInput(oauthAdapter(), { values: { apiKey: "k" }, secrets: { totpCode: "123456" } }), "VALIDATION_FAILED");
  });

  it("session login: needs every login field, a 6-digit TOTP, and nothing else", () => {
    const a = sessionAdapter();
    expect(validateConnectInput(a, { values: { apiKey: "k" }, secrets: { password: "1234", totpCode: " 123456 " } }).secrets).toEqual({ password: "1234", totpCode: "123456" });
    expectCode(() => validateConnectInput(a, { secrets: { password: "1234" } }), "VALIDATION_FAILED");
    expectCode(() => validateConnectInput(a, { secrets: { password: "1234", totpCode: "12345" } }), "VALIDATION_FAILED");
    expectCode(() => validateConnectInput(a, { secrets: { password: "1234", totpCode: "123456", dob: "x" } }), "VALIDATION_FAILED");
    expectCode(() => validateConnectInput(a, { secrets: { password: "x".repeat(257), totpCode: "123456" } }), "VALIDATION_FAILED");
  });
});

describe("record helpers", () => {
  it("mergeValues keeps declared fields only, drops empty strings and (optionally) daily tokens", () => {
    const a = oauthAdapter();
    expect(mergeValues(a, { apiKey: "k", accessToken: "old", junk: "x" }, { accessToken: "new" })).toEqual({ apiKey: "k", accessToken: "new" });
    expect(mergeValues(a, { apiKey: "k", accessToken: "old" }, { apiKey: "" })).toEqual({ accessToken: "old" });
    expect(mergeValues(a, { apiKey: "k", apiSecret: "s", accessToken: "old" }, {}, { dropDailyTokens: true })).toEqual({ apiKey: "k", apiSecret: "s" });
  });

  it("pickSessionFields keeps declared string fields only", () => {
    expect(pickSessionFields({ sessionToken: "a", feedToken: "", extra: "x", password: "p" }, ["sessionToken", "feedToken", "password"])).toEqual({ sessionToken: "a" });
  });

  it("describeRecord + deriveState walk the state machine", () => {
    const sa = sessionAdapter();
    const now = 1_000_000;
    const none = describeRecord(null, sa);
    expect(deriveState(none, {}, now).state).toBe("missing");
    const live = describeRecord({ values: {}, session: { sessionToken: "s" }, sessionExpiresAt: now + 10, rev: "r1" }, sa);
    expect(live).toMatchObject({ stamp: "r1", usable: true, expiresAt: now + 10 });
    expect(deriveState(live, {}, now).state).toBe("connected");
    expect(deriveState(live, {}, now + 10).state).toBe("expired");
    expect(deriveState(live, { rejectedStamp: "r1" }, now).state).toBe("expired");
    expect(deriveState(live, { rejectedStamp: "other" }, now).state).toBe("connected");
    expect(deriveState(live, { error: { stamp: "r1", message: "bad" } }, now)).toMatchObject({ state: "error", message: "bad" });
    expect(deriveState(live, { checking: true }, now).state).toBe("checking");
    const noSession = describeRecord({ values: { apiKey: "k" }, session: null, rev: "r2" }, sa);
    expect(deriveState(noSession, {}, now).state).toBe("missing");
    const out = describeRecord({ values: { clientId: "1" }, disconnectedAt: "x", rev: "r3" }, apiKeyAdapter());
    expect(deriveState(out, {}, now).state).toBe("missing");
    expect(describeRecord({ values: { clientId: "1" } }, apiKeyAdapter()).stamp).toBe("legacy");
  });
});
