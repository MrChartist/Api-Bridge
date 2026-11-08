import { describe, expect, it } from "vitest";
import { FetchRefused, cleanRequestHeaders, createFetchBroker, createRequestLimiter, createSafeLookup } from "./netbroker.mjs";

const ok = (body = "{}", extra = {}) => ({ status: 200, headers: { "content-type": "application/json", "set-cookie": "sid=1", "x-secret": "no", ...extra }, body });

function make({ responses = [ok()], limits = { perSecond: 100 }, ...rest } = {}) {
  const seen = [];
  let i = 0;
  const transport = async (req) => {
    seen.push(req);
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(req) : r;
  };
  const broker = createFetchBroker({ id: "p", version: "1.2.3", allowHosts: ["api.vendor.com"], limits, transport, ...rest });
  return { broker, seen };
}

const refusal = async (promise) => {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FetchRefused);
    return err;
  }
  throw new Error("expected a refusal");
};

describe("the host-brokered fetch", () => {
  it("performs an allowed request with a host-set User-Agent, no cookies, and passes back only safe headers", async () => {
    const { broker, seen } = make();
    const r = await broker.fetch("https://api.vendor.com/v1/q?x=1", { headers: { Accept: "application/json", "X-Api-Key": "k1" } });
    expect(r).toEqual({ status: 200, headers: { "content-type": "application/json" }, body: "{}" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url.href).toBe("https://api.vendor.com/v1/q?x=1");
    expect(seen[0].method).toBe("GET");
    expect(seen[0].headers).toEqual({ accept: "application/json", "x-api-key": "k1", "user-agent": "mc-bridge-plugin/p/1.2.3", "accept-encoding": "identity" });
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it.each([
    ["http://api.vendor.com/x", /https/],
    ["https://evil.example.org/x", /allowHosts/],
    ["https://127.0.0.1/x", /IP/],
    ["https://169.254.169.254/latest", /IP/],
    ["https://[::1]/x", /IP/],
    ["https://10.0.0.5/x", /IP/],
    ["https://localhost/x", /allowHosts/],
    ["https://api.kite.trade/orders", /broker/],
    ["https://user:pw@api.vendor.com/x", /credentials/],
    ["https://api.vendor.com:8080/x", /port/],
  ])("refuses %s without touching the network", async (url, re) => {
    const { broker, seen } = make();
    const err = await refusal(broker.fetch(url));
    expect(err.code).toBe("HOST_NOT_ALLOWED");
    expect(err.message).toMatch(re);
    expect(seen).toHaveLength(0);
  });

  it("refuses a broker host even when the allow-list names it", async () => {
    const { broker, seen } = make({ allowHosts: ["api.kite.trade"] });
    expect((await refusal(broker.fetch("https://api.kite.trade/x"))).code).toBe("HOST_NOT_ALLOWED");
    expect(seen).toHaveLength(0);
  });

  it("allows only GET and HEAD, and POST only when the manifest says so", async () => {
    const { broker, seen } = make();
    expect((await refusal(broker.fetch("https://api.vendor.com/x", { method: "POST", body: "a" }))).code).toBe("BAD_REQUEST");
    expect((await refusal(broker.fetch("https://api.vendor.com/x", { method: "DELETE" }))).code).toBe("BAD_REQUEST");
    expect((await refusal(broker.fetch("https://api.vendor.com/x", { method: "GET", body: "a" }))).code).toBe("BAD_REQUEST");
    expect(seen).toHaveLength(0);
    const post = make({ allowPost: true });
    await post.broker.fetch("https://api.vendor.com/x", { method: "POST", body: "a=1" });
    expect(post.seen[0]).toMatchObject({ method: "POST", body: "a=1" });
    expect(post.seen[0].headers["content-length"]).toBe("3");
  });

  it("never forwards cookies or hop-by-hop headers from the plugin", async () => {
    expect(() => cleanRequestHeaders({ Cookie: "a=b" })).toThrow(/not allowed/);
    expect(() => cleanRequestHeaders({ Host: "evil.com" })).toThrow(FetchRefused);
    expect(() => cleanRequestHeaders({ "Proxy-Authorization": "x" })).toThrow(FetchRefused);
    expect(() => cleanRequestHeaders({ "Content-Length": "5" })).toThrow(FetchRefused);
    expect(() => cleanRequestHeaders({ "User-Agent": "x" })).toThrow(FetchRefused);
    expect(() => cleanRequestHeaders({ "x-a": "line\r\nInjected: 1" })).toThrow(/invalid value/);
    expect(() => cleanRequestHeaders({ "bad name": "x" })).toThrow(/invalid header name/);
    expect(() => cleanRequestHeaders(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`x-${i}`, "1"])))).toThrow(/at most/);
    expect(cleanRequestHeaders({ Accept: "a", "X-Api-Key": "k" })).toEqual({ accept: "a", "x-api-key": "k" });
  });

  it("re-checks every redirect: to an unapproved host, to a private address, to http", async () => {
    for (const location of ["https://evil.example.org/x", "https://127.0.0.1/x", "https://169.254.169.254/x", "http://api.vendor.com/x", "https://api.kite.trade/x", "https://[::1]/x"]) {
      const { broker, seen } = make({ responses: [{ status: 302, headers: { location }, body: "" }, ok()] });
      const err = await refusal(broker.fetch("https://api.vendor.com/x"));
      expect(err.code).toBe("HOST_NOT_ALLOWED");
      expect(err.message).toMatch(/redirect refused/);
      expect(seen).toHaveLength(1);
    }
  });

  it("follows a redirect to an allowed host, switching to GET, and stops after 3 hops", async () => {
    const hop = (to, status = 302) => ({ status, headers: { location: to }, body: "" });
    const a = make({ allowPost: true, responses: [hop("/next"), ok("done")] });
    const r = await a.broker.fetch("https://api.vendor.com/x", { method: "POST", body: "z" });
    expect(r.body).toBe("done");
    expect(a.seen[1]).toMatchObject({ method: "GET", body: undefined });
    expect(a.seen[1].url.href).toBe("https://api.vendor.com/next");

    const b = make({ allowPost: true, responses: [hop("/n", 307), ok()] });
    await b.broker.fetch("https://api.vendor.com/x", { method: "POST", body: "z" });
    expect(b.seen[1]).toMatchObject({ method: "POST", body: "z" });

    const loop = make({ responses: [hop("/again")] });
    const err = await refusal(loop.broker.fetch("https://api.vendor.com/x"));
    expect(err.message).toMatch(/too many redirects/);
    expect(loop.seen).toHaveLength(4);
    expect((await refusal(make({ responses: [{ status: 302, headers: {}, body: "" }] }).broker.fetch("https://api.vendor.com/x"))).message).toMatch(/location/);
  });

  it("caps the response size", async () => {
    const { broker } = make({ limits: { perSecond: 100, maxResponseBytes: 1000 }, responses: [ok("x".repeat(2000))] });
    expect((await refusal(broker.fetch("https://api.vendor.com/x"))).code).toBe("TOO_LARGE");
    const small = make({ limits: { perSecond: 100, maxResponseBytes: 1000 }, responses: [ok("x".repeat(900))] });
    expect((await small.broker.fetch("https://api.vendor.com/x")).body).toHaveLength(900);
    const passes = make({ limits: { perSecond: 100, maxResponseBytes: 1000 } });
    await passes.broker.fetch("https://api.vendor.com/x");
    expect(passes.seen[0].maxBytes).toBe(1000);
  });

  it("applies the plugin's own per-second, per-minute and per-day limits, and counts redirect hops", async () => {
    let t = 1_000_000_000_000;
    const clock = () => t;
    const { broker } = make({ limits: { perSecond: 2 }, clock });
    await broker.fetch("https://api.vendor.com/1");
    await broker.fetch("https://api.vendor.com/2");
    const err = await refusal(broker.fetch("https://api.vendor.com/3"));
    expect(err).toMatchObject({ code: "RATE_LIMITED" });
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(err.retryAfterMs).toBeLessThanOrEqual(1000);
    t += 1001;
    await broker.fetch("https://api.vendor.com/4");

    const hops = make({ limits: { perSecond: 1 }, clock, responses: [{ status: 302, headers: { location: "/b" }, body: "" }, ok()] });
    expect((await refusal(hops.broker.fetch("https://api.vendor.com/a"))).code).toBe("RATE_LIMITED");
  });

  it("the limiter windows: minute and day", () => {
    let t = Date.UTC(2026, 9, 19, 5, 0, 0);
    const l = createRequestLimiter({ perMinute: 3, perDay: 5 }, () => t);
    expect([l.take(), l.take(), l.take()]).toEqual([null, null, null]);
    expect(l.take()).toBeGreaterThan(0);
    t += 61_000;
    expect([l.take(), l.take()]).toEqual([null, null]);
    t += 61_000;
    const wait = l.take();
    expect(wait).toBeGreaterThan(60_000); // the day is used up: wait until the next UTC day
    t = Date.UTC(2026, 9, 20, 0, 0, 1);
    expect(l.take()).toBeNull();
  });

  it("turns transport failures into plain codes without leaking details", async () => {
    const timeout = Object.assign(new Error("boom"), { name: "TimeoutError" });
    expect((await refusal(make({ responses: [timeout] }).broker.fetch("https://api.vendor.com/x"))).code).toBe("TIMEOUT");
    expect((await refusal(make({ responses: [Object.assign(new Error("x"), { code: "EPRIVATEADDR" })] }).broker.fetch("https://api.vendor.com/x"))).code).toBe("HOST_NOT_ALLOWED");
    const net = await refusal(make({ responses: [Object.assign(new Error("connect ECONNREFUSED 10.1.1.1:443"), { code: "ECONNREFUSED" })] }).broker.fetch("https://api.vendor.com/x"));
    expect(net.code).toBe("NETWORK");
    expect(net.message).not.toMatch(/10\.1\.1\.1/);
  });

  it("honours the caller's abort signal and the timeout", async () => {
    const ac = new AbortController();
    const hang = make({ responses: [(req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(Object.assign(new Error("a"), { name: "AbortError" }))))] });
    const p = hang.broker.fetch("https://api.vendor.com/x", {}, { signal: ac.signal, timeoutMs: 10_000 });
    ac.abort();
    expect((await refusal(p)).code).toBe("CANCELLED");
    const slow = make({ responses: [(req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(Object.assign(new Error("a"), { name: "AbortError" }))))] });
    expect((await refusal(slow.broker.fetch("https://api.vendor.com/x", {}, { timeoutMs: 20 }))).code).toBe("TIMEOUT");
  });

  it("counts requests and refusals", async () => {
    const { broker } = make();
    await broker.fetch("https://api.vendor.com/x");
    await refusal(broker.fetch("https://evil.example.org/x"));
    expect(broker.stats()).toMatchObject({ requests: 1, refused: 1 });
  });
});

describe("createSafeLookup (checked at connection time)", () => {
  const resolverFor = (answers) => (hostname, opts, cb) => (answers instanceof Error ? cb(answers) : cb(null, answers));
  const run = (answers, opts = { all: true }) => new Promise((resolve) => createSafeLookup(resolverFor(answers))("api.vendor.com", opts, (err, a, f) => resolve({ err, a, f })));

  it("passes public addresses through", async () => {
    expect((await run([{ address: "8.8.8.8", family: 4 }])).a).toEqual([{ address: "8.8.8.8", family: 4 }]);
    const single = await run([{ address: "8.8.8.8", family: 4 }], {});
    expect(single).toMatchObject({ a: "8.8.8.8", f: 4 });
  });

  it("refuses a name that resolves to a private address, even alongside a public one (DNS rebinding)", async () => {
    for (const bad of ["127.0.0.1", "10.0.0.7", "169.254.169.254", "::1", "fd00::1", "::ffff:192.168.1.1"]) {
      const r = await run([{ address: "8.8.8.8", family: 4 }, { address: bad, family: bad.includes(":") ? 6 : 4 }]);
      expect(r.err?.code).toBe("EPRIVATEADDR");
    }
  });

  it("passes resolver errors and empty answers on as failures", async () => {
    expect((await run(Object.assign(new Error("nx"), { code: "ENOTFOUND" }))).err.code).toBe("ENOTFOUND");
    expect((await run([])).err.code).toBe("EPRIVATEADDR");
  });
});
