import { describe, expect, it } from "vitest";
import { createCallContext } from "./context.mjs";
import { createLogger } from "./logger.mjs";

const log = createLogger({ write: () => {} });

describe("call context for automations", () => {
  it("a guard principal may use only its own accounts", () => {
    const ctx = createCallContext({ source: "guard", principal: { kind: "guard", id: "g_1" }, scopes: ["read"], hookAccounts: ["acc-1"], log });
    expect(ctx.source).toBe("guard");
    expect(() => ctx.requireAccountAccess("acc-1")).not.toThrow();
    expect(() => ctx.requireAccountAccess("acc-2")).toThrow(expect.objectContaining({ code: "ACCOUNT_FORBIDDEN" }));
  });

  it("an alert source with no key and no hook accounts is refused account access", () => {
    const ctx = createCallContext({ source: "alert", scopes: ["read"], log });
    expect(() => ctx.requireAccountAccess("acc-1")).toThrow(expect.objectContaining({ code: "ACCOUNT_FORBIDDEN" }));
  });
});
