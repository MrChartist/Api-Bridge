import { describe, expect, it } from "vitest";
import { allowedAccountsFor } from "../market/routes.mjs";
import { sourceLabel } from "../orders/modeDecision.mjs";
import { AUTOMATED_SOURCES, createCallContext, isAutomatedContext } from "./context.mjs";
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

  it("unpinned reads use the same accounts as pinned access for a guard (and a hook)", () => {
    const guard = createCallContext({ source: "guard", principal: { kind: "guard", id: "g_1" }, scopes: ["read"], hookAccounts: ["acc-1"], log });
    expect(allowedAccountsFor(guard)).toEqual(["acc-1"]);
    const hook = createCallContext({ source: "webhook", principal: { kind: "hook", id: "h_1" }, scopes: ["read"], hookAccounts: ["acc-2"], log });
    expect(allowedAccountsFor(hook)).toEqual(["acc-2"]);
    expect(allowedAccountsFor(createCallContext({ source: "alert", scopes: ["read"], log }))).toEqual([]);
  });

  it("every automation counts as automated (no ticket confirmation), people do not", () => {
    expect(AUTOMATED_SOURCES).toEqual(["mcp", "webhook", "guard", "alert"]);
    for (const source of AUTOMATED_SOURCES) expect(isAutomatedContext({ source }), source).toBe(true);
    expect(isAutomatedContext({ source: "rest", principal: { kind: "guard", id: "g" } })).toBe(true);
    expect(isAutomatedContext({ source: "rest", principal: { kind: "hook", id: "h" } })).toBe(true);
    expect(isAutomatedContext({ source: "rest", key: { clientKind: "mcp" }, principal: { kind: "key" } })).toBe(true);
    expect(isAutomatedContext({ source: "rest", principal: { kind: "key" } })).toBe(false);
    expect(isAutomatedContext({ source: "cli", principal: { kind: "local", id: "cli" } })).toBe(false);
  });

  it("live refusals name the new sources in words", () => {
    expect(sourceLabel("guard")).toBe("strategy guards");
    expect(sourceLabel("alert")).toBe("alert actions");
  });
});
