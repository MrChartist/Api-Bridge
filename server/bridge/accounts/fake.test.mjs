import { describe, expect, it } from "vitest";
import { assertService } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createFakeAccountManager } from "./fake.mjs";
import { apiKeyAdapter } from "./__fixtures__/stubs.mjs";

const codeOf = async (p) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    return err.code;
  }
  return null;
};

describe("createFakeAccountManager", () => {
  it("satisfies the AccountManager contract and mirrors the real semantics", async () => {
    const bus = createEventBus();
    const events = [];
    bus.on("account.status", (p) => events.push(p));
    const adapter = apiKeyAdapter({ id: "dhan" });
    const fake = createFakeAccountManager({
      bus,
      policies: { dhan: { pooling: "allowed" } },
      accounts: [
        { id: "dhan-main", broker: "dhan", adapter, creds: { clientId: "1", accessToken: "t" }, pooling: true },
        { id: "dhan-2", broker: "dhan", pooling: true, state: "expired" },
        { id: "zerodha-1", broker: "zerodha", pooling: true, capabilities: ["ltp", "historical"] },
        { id: "paper", broker: "paper" },
      ],
    });
    assertService("accounts", fake);
    expect(fake.list().map((a) => [a.id, a.session.state, a.pooling])).toEqual([
      ["dhan-main", "connected", true],
      ["dhan-2", "expired", true],
      ["zerodha-1", "connected", false],
      ["paper", "connected", false],
    ]);
    expect(fake.get("dhan-main").capabilities).toEqual(["testConnection", "expiries", "optionChain", "ltp", "quotes", "depth"]);
    expect(fake.adapter("dhan-main")).toBe(adapter);
    expect(await codeOf(() => fake.adapter("paper"))).toBe("CAPABILITY_UNSUPPORTED");
    expect(await fake.creds("dhan-main")).toEqual({ clientId: "1", accessToken: "t" });
    expect(await codeOf(fake.creds("dhan-2"))).toBe("SESSION_EXPIRED");
    expect(await codeOf(fake.creds("paper"))).toBe("CAPABILITY_UNSUPPORTED");
    expect(await codeOf(() => fake.get("nope"))).toBe("ACCOUNT_NOT_FOUND");

    expect(fake.marketDataCandidates({ capability: "ltp" })).toEqual(["dhan-main"]);
    expect(fake.marketDataCandidates({ capability: "historical" })).toEqual(["zerodha-1"]);
    expect(fake.marketDataCandidates({ capability: "ltp", accountId: "dhan-2" })).toEqual(["dhan-2"]);
    expect(fake.marketDataCandidates({ capability: "ltp", accountId: "paper" })).toEqual([]);

    await fake.connect("dhan-2", { values: { accessToken: "new" }, secrets: { password: "never-kept" } });
    expect(events.at(-1)).toMatchObject({ accountId: "dhan-2", session: "connected" });
    expect(JSON.stringify(fake.calls)).not.toContain("never-kept");
    expect(fake.marketDataCandidates({ capability: "ltp" })).toEqual(["dhan-main", "dhan-2"]);

    bus.emit("account.session_rejected", { accountId: "dhan-main", broker: "dhan", code: "UPSTREAM_AUTH" });
    expect(fake.status("dhan-main").state).toBe("expired");
    expect(await fake.testConnection("dhan-main")).toMatchObject({ ok: false });
    expect(await fake.testConnection("paper")).toMatchObject({ ok: true });

    expect((await fake.disconnect("dhan-2")).state).toBe("missing");
    expect(await codeOf(fake.connect("paper"))).toBe("CAPABILITY_UNSUPPORTED");
    expect(await codeOf(fake.disconnect("paper"))).toBe("CAPABILITY_UNSUPPORTED");
    expect(fake.capabilities("dhan-main").policy).toEqual({ pooling: "allowed" });
    expect(fake.capabilities("paper").policy).toBeNull();

    fake.setCreds("dhan-2", { accessToken: "x" });
    fake.setState("dhan-2", "connected");
    expect(await fake.creds("dhan-2")).toEqual({ accessToken: "x" });
    fake.dispose();
  });

  it("works without a bus and refuses duplicate ids", () => {
    const fake = createFakeAccountManager({ accounts: [{ id: "aa", broker: "dhan" }] });
    fake.setState("aa", "error", { message: "x" });
    expect(fake.status("aa")).toMatchObject({ state: "error", message: "x" });
    expect(() => createFakeAccountManager({ accounts: [{ id: "aa", broker: "dhan" }, { id: "aa", broker: "dhan" }] })).toThrow(/duplicate/);
  });
});
