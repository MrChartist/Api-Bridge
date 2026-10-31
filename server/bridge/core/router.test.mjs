import { describe, expect, it } from "vitest";
import { createRouter } from "./router.mjs";

const h = () => null;

describe("router", () => {
  it("matches static paths and params", () => {
    const r = createRouter();
    r.add("GET", "/v1/orders", h);
    r.add("GET", "/v1/orders/:orderId", h);
    expect(r.match("GET", "/v1/orders").params).toEqual({});
    expect(r.match("GET", "/v1/orders/ord_1").params).toEqual({ orderId: "ord_1" });
    expect(r.match("GET", "/v1/orders/").params).toEqual({});
  });

  it("decodes params, keeps colons and refuses encoded slashes", () => {
    const r = createRouter();
    r.add("GET", "/v1/instruments/:symbol", h);
    expect(r.match("GET", "/v1/instruments/NFO%3ANIFTY-2026-10-27-25000-CE").params.symbol).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect(r.match("GET", "/v1/instruments/NSE:M&M").params.symbol).toBe("NSE:M&M");
    expect(r.match("GET", "/v1/instruments/a%2Fb").route).toBeNull();
    expect(r.match("GET", "/v1/instruments/%E0%A4").route).toBeNull();
  });

  it("static segments win over params regardless of order", () => {
    const r = createRouter();
    r.add("GET", "/v1/instruments/:symbol", () => "param");
    r.add("GET", "/v1/instruments/search", () => "static");
    expect(r.match("GET", "/v1/instruments/search").route.handler()).toBe("static");
    expect(r.match("GET", "/v1/instruments/NSE:SBIN").route.handler()).toBe("param");
  });

  it("supports a trailing wildcard, beaten by exact routes", () => {
    const r = createRouter();
    r.add("GET", "/xl/*", () => "wild");
    r.add("GET", "/xl/config", () => "exact");
    expect(r.match("GET", "/xl/config").route.handler()).toBe("exact");
    const m = r.match("GET", "/xl/a/b");
    expect(m.route.handler()).toBe("wild");
    expect(m.params["*"]).toBe("a/b");
  });

  it("reports allowed methods for 405 and treats HEAD as GET", () => {
    const r = createRouter();
    r.add("GET", "/v1/orders", h);
    r.add("POST", "/v1/orders", h);
    expect(r.match("DELETE", "/v1/orders")).toEqual({ route: null, allowed: ["GET", "POST"] });
    expect(r.match("HEAD", "/v1/orders").route.method).toBe("GET");
    expect(r.match("GET", "/v1/nothing")).toEqual({ route: null, allowed: [] });
  });

  it("refuses duplicates, bad patterns and bad methods", () => {
    const r = createRouter();
    r.add("GET", "/a", h);
    expect(() => r.add("GET", "/a", h)).toThrow(/already registered/);
    expect(() => r.add("GET", "a", h)).toThrow(/start with/);
    expect(() => r.add("GET", "/a/*/b", h)).toThrow(/last segment/);
    expect(() => r.add("TRACE", "/b", h)).toThrow(/Unsupported/);
    expect(() => r.add("GET", "/c/:1x", h)).toThrow(/param/);
    expect(() => r.add("GET", "/d", "nope")).toThrow(/function/);
  });

  it("lists routes with their options and module", () => {
    const r = createRouter();
    r.add("GET", "/v1/quotes", h, { scope: "read" }, "market");
    expect(r.list()).toEqual([{ method: "GET", pattern: "/v1/quotes", options: { scope: "read" }, module: "market" }]);
  });
});
