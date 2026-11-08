import { describe, expect, it } from "vitest";
import { clockSkewMs, createEgressDetector } from "./egress.mjs";

const cfg = (over = {}) => ({ mode: "lookup", lookupUrl: "https://api.ipify.org", timeoutMs: 5000, ...over });

function stubFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof answer === "function" ? answer(url, init) : answer;
  };
  fn.calls = calls;
  return fn;
}

describe("egress detector", () => {
  it("looks up over https with redirect: error and a timeout signal, labels the host and registers the IP as a secret", async () => {
    const secrets = [];
    const lines = [];
    const logger = { addSecret: (v) => secrets.push(v), info: (...a) => lines.push(a), warn: (...a) => lines.push(a) };
    const fetchImpl = stubFetch(new Response("198.51.100.23\n", { status: 200, headers: { "content-type": "text/plain" } }));
    const d = createEgressDetector({ cfg: cfg(), fetchImpl, logger });
    const r = await d.lookup();
    expect(r).toMatchObject({ ok: true, ip: "198.51.100.23", family: "ipv4", seenBy: "api.ipify.org" });
    expect(fetchImpl.calls[0].init.redirect).toBe("error");
    expect(fetchImpl.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(secrets).toEqual(["198.51.100.23"]);
    expect(JSON.stringify(lines)).not.toContain("198.51.100.23");
  });

  it("refuses http to anything but this computer, and does nothing when the mode is not lookup", async () => {
    const fetchImpl = stubFetch(new Response("1.2.3.4"));
    expect(await createEgressDetector({ cfg: cfg({ lookupUrl: "http://api.ipify.org" }), fetchImpl }).lookup()).toMatchObject({ ok: false });
    expect(await createEgressDetector({ cfg: cfg({ mode: "off" }), fetchImpl }).lookup()).toMatchObject({ ok: false, error: "lookup is off" });
    expect(fetchImpl.calls).toHaveLength(0);
    const local = stubFetch(new Response('{"ip":"203.0.113.10"}', { headers: { "content-type": "application/json" } }));
    expect(await createEgressDetector({ cfg: cfg({ lookupUrl: "http://127.0.0.1:9/ip" }), fetchImpl: local }).lookup()).toMatchObject({ ok: true, ip: "203.0.113.10", seenBy: "127.0.0.1:9" });
  });

  it("an HTTP error answer is dropped unread, however large its body", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream({
      pull(c) {
        pulled += chunk.byteLength;
        c.enqueue(chunk);
        if (pulled >= 2 * 1024 * 1024) c.close();
      },
    });
    const fetchImpl = stubFetch(new Response(body, { status: 500 }));
    const r = await createEgressDetector({ cfg: cfg(), fetchImpl }).lookup();
    expect(r).toMatchObject({ ok: false, error: "the service answered HTTP 500" });
    // Only what the stream queued on its own (one chunk at most) — never the stream drained into memory.
    expect(pulled).toBeLessThanOrEqual(chunk.byteLength);
  });

  it("a timeout or network error becomes a failed lookup, never a throw", async () => {
    const timeout = stubFetch(() => {
      const e = new Error("t");
      e.name = "TimeoutError";
      throw e;
    });
    expect(await createEgressDetector({ cfg: cfg(), fetchImpl: timeout }).lookup()).toMatchObject({ ok: false, error: "could not reach the service (timed out)" });
    expect(await createEgressDetector({ cfg: cfg(), fetchImpl: stubFetch(new Response("x", { status: 503 })) }).lookup()).toMatchObject({ ok: false, error: "the service answered HTTP 503" });
    expect(await createEgressDetector({ cfg: cfg(), fetchImpl: stubFetch(new Response("9".repeat(2000))) }).lookup()).toMatchObject({ ok: false, error: "the answer was larger than 1 KB" });
    expect(await createEgressDetector({ cfg: cfg(), fetchImpl: stubFetch(new Response("<html>")) }).lookup()).toMatchObject({ ok: false });
  });

  it("clock skew from the Date header (reference case)", () => {
    const start = Date.parse("2026-10-29T10:12:29.800+05:30");
    const end = Date.parse("2026-10-29T10:12:30.200+05:30");
    expect(clockSkewMs("Thu, 29 Oct 2026 04:42:30 GMT", start, end)).toBe(500);
    expect(clockSkewMs(undefined, start, end)).toBeNull();
  });

  it("reports the skew on a lookup", async () => {
    let t = Date.parse("2026-10-29T10:12:29.800+05:30");
    const clock = { now: () => t };
    const fetchImpl = stubFetch(() => {
      t = Date.parse("2026-10-29T10:12:30.200+05:30");
      return new Response("203.0.113.10", { headers: { date: "Thu, 29 Oct 2026 04:42:37 GMT" } });
    });
    const r = await createEgressDetector({ cfg: cfg(), fetchImpl, clock }).lookup();
    expect(r.clockSkewMs).toBe(7500);
  });
});
