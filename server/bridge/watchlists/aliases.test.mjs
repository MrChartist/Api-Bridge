// PR 17's /v1/analytics/watchlists routes are aliases over this module (docs/design/pr17-integration.md). The real app
// round trip is in analytics/analytics.integration.test.mjs; this file checks the declaration and the body mapping.
import { describe, expect, it } from "vitest";
import { ALIAS_ROUTES, ROUTES, aliasUpdateBody } from "./module.mjs";

describe("watchlist aliases", () => {
  it("declares PR 17's five paths with PR 17's read scope", () => {
    expect(ALIAS_ROUTES.map(([m, p]) => `${m} ${p}`)).toEqual([
      "GET /v1/analytics/watchlists",
      "POST /v1/analytics/watchlists",
      "PUT /v1/analytics/watchlists/:listId",
      "DELETE /v1/analytics/watchlists/:listId",
      "GET /v1/analytics/watchlists/:listId/quotes",
    ]);
    expect(new Set(ALIAS_ROUTES.map(([, , o]) => o.scope))).toEqual(new Set(["read"]));
    // The canonical family is unchanged: changes there still need paper.
    expect(ROUTES.filter(([m]) => m !== "GET").map(([, , o]) => o.scope)).toEqual(["paper", "paper", "paper"]);
  });

  it("turns add and remove into the full symbol list, keeping order", () => {
    const cur = { symbols: ["NSE:NIFTY", "NSE:RELIANCE", "NSE:INFY"] };
    expect(aliasUpdateBody({ add: ["tcs", "NSE:NIFTY"], remove: ["NSE:RELIANCE"] }, cur)).toEqual({ symbols: ["NSE:NIFTY", "NSE:INFY", "NSE:TCS"] });
    expect(aliasUpdateBody({ name: "x" }, cur)).toEqual({ name: "x" });
    expect(() => aliasUpdateBody({ symbols: [], add: ["x"] }, cur)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => aliasUpdateBody({ add: "NSE:TCS" }, cur)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});
