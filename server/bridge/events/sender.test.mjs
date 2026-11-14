import { describe, expect, it } from "vitest";
import { createSender, parseRetryAfter } from "./sender.mjs";
import { HEADERS } from "./signature.mjs";
import { SECRET, URL_OK, createClock, createFakeDns, createFakeReceiver, publicDns } from "./testkit.mjs";

const POLICY = { allowPrivateTargets: false, allowedHosts: [], timeoutMs: 5000, maxResponseBytes: 1024 };
function mk({ receiver, dns = publicDns(), policy = POLICY, clock = createClock() } = {}) {
  const rx = receiver ?? createFakeReceiver({ clock });
  const sender = createSender({ policy: () => policy, transport: rx.transport, resolve: dns.resolve, now: clock.now });
  return { rx, dns, sender, clock };
}
const BODY = '{"id":"1","topic":"order.updated","data":{}}';
const send = (s, over = {}) => s.send({ url: URL_OK, secret: SECRET, body: BODY, ...over });

describe("sender", () => {
  it("signs the exact body, pins the checked address and sends the identifying headers", async () => {
    const { sender, rx, dns } = mk();
    const r = await send(sender, { headers: { [HEADERS.eventId]: "1", [HEADERS.topic]: "order.updated", [HEADERS.delivery]: "dlv_x", [HEADERS.attempt]: "1" } });
    expect(r).toMatchObject({ ok: true, status: 200, retryable: false });
    expect(dns.lookups).toEqual(["hooks.example.test"]);
    const c = rx.calls[0];
    expect(c.address).toBe("93.184.216.34"); // the connection goes to the address that was checked
    expect(c.url).toBe(URL_OK);
    expect(c.body).toBe(BODY);
    expect(c.signatureOk).toBe(true);
    expect(c.headers).toMatchObject({ "Content-Type": "application/json", [HEADERS.eventId]: "1", [HEADERS.attempt]: "1" });
    expect(c.headers["User-Agent"]).toMatch(/^mc-bridge-events\//);
    expect(c.headers[HEADERS.timestamp]).toBe(String(Math.floor(createClock().now() / 1000)));
  });

  it("refuses a name that resolves to a private address, before anything is sent (DNS rebinding)", async () => {
    const dns = createFakeDns({ "hooks.example.test": ["93.184.216.34"] });
    const { sender, rx } = mk({ dns });
    expect((await send(sender)).ok).toBe(true);
    dns.set("hooks.example.test", ["192.168.1.10"]); // the same name now points inside the network
    const r = await send(sender);
    expect(r).toMatchObject({ ok: false, code: "blocked_address", retryable: false });
    dns.set("hooks.example.test", ["93.184.216.34", "169.254.169.254"]);
    expect(await send(sender)).toMatchObject({ ok: false, code: "blocked_address" });
    expect(rx.calls).toHaveLength(1);
  });

  it("refuses a bad target without a lookup", async () => {
    const { sender, rx, dns } = mk();
    for (const [url, code] of [["http://hooks.example.test/x", "blocked_scheme"], ["https://localhost/x", "blocked_host"], ["https://10.0.0.1/x", "blocked_address"], ["https://u:p@hooks.example.test/x", "blocked_credentials"], ["nonsense", "bad_url"]]) {
      expect(await send(sender, { url }), url).toMatchObject({ ok: false, code, retryable: false });
    }
    expect(dns.lookups).toEqual([]);
    expect(rx.calls).toEqual([]);
  });

  it("classifies answers: success, retryable, permanent, redirects", async () => {
    const { sender, rx } = mk();
    const cases = [
      [200, { ok: true, retryable: false }],
      [204, { ok: true, retryable: false }],
      [301, { ok: false, code: "redirect_refused", retryable: false }],
      [307, { ok: false, code: "redirect_refused", retryable: false }],
      [400, { ok: false, code: "http_4xx", retryable: false }],
      [401, { ok: false, code: "http_4xx", retryable: false }],
      [404, { ok: false, code: "http_4xx", retryable: false }],
      [410, { ok: false, code: "http_4xx", retryable: false }],
      [408, { ok: false, code: "http_408", retryable: true }],
      [425, { ok: false, code: "http_408", retryable: true }],
      [429, { ok: false, code: "http_429", retryable: true }],
      [500, { ok: false, code: "http_5xx", retryable: true }],
      [503, { ok: false, code: "http_5xx", retryable: true }],
    ];
    for (const [status, want] of cases) {
      rx.script({ status, hasLocation: status >= 300 && status < 400 });
      expect(await send(sender), String(status)).toMatchObject({ status, ...want });
    }
  });

  it("never follows a redirect: it reports it and makes no second call", async () => {
    const { sender, rx } = mk();
    rx.script({ status: 302, hasLocation: true, times: 5 });
    const r = await send(sender);
    expect(r.code).toBe("redirect_refused");
    expect(rx.calls).toHaveLength(1);
  });

  it("maps socket failures to short codes and keeps the error text out", async () => {
    const { sender, rx } = mk();
    const cases = [["ETIMEDOUT", "timeout", true], ["ECONNREFUSED", "connect_failed", true], ["ECONNRESET", "connect_failed", true], ["ENOTFOUND", "dns_failed", true], ["CERT_HAS_EXPIRED", "tls_failed", true], ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_failed", true], ["EWHATEVER", "request_failed", true]];
    for (const [throws, code, retryable] of cases) {
      rx.script({ throws });
      const r = await send(sender);
      expect(r, throws).toMatchObject({ ok: false, code, retryable });
      expect(JSON.stringify(r)).not.toContain("fake ");
    }
  });

  it("reads Retry-After in seconds or as a date", async () => {
    const clock = createClock();
    const { sender, rx } = mk({ clock });
    rx.script({ status: 429, retryAfter: "120" });
    expect((await send(sender)).retryAfterMs).toBe(120_000);
    rx.script({ status: 503, retryAfter: new Date(clock.now() + 45_000).toUTCString() });
    expect((await send(sender)).retryAfterMs).toBe(45_000);
    rx.script({ status: 503, retryAfter: "soon" });
    expect((await send(sender)).retryAfterMs).toBeUndefined();
    expect(parseRetryAfter("-5", 0)).toBeNull();
    expect(parseRetryAfter(undefined, 0)).toBeNull();
  });

  it("measures the duration with the injected clock", async () => {
    const clock = createClock();
    const rx = createFakeReceiver({ clock });
    const slow = async (req) => {
      clock.advance(1234);
      return rx.transport(req);
    };
    const sender = createSender({ policy: () => POLICY, transport: slow, resolve: publicDns().resolve, now: clock.now });
    expect((await send(sender)).durationMs).toBe(1234);
  });

  it("returns nothing that could carry the secret, the signature or the URL's path", async () => {
    const { sender, rx } = mk();
    for (const spec of [{ status: 200 }, { status: 500 }, { status: 301, hasLocation: true }, { throws: "ECONNREFUSED" }]) {
      rx.script(spec);
      const text = JSON.stringify(await send(sender));
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("abc123");
      expect(text).not.toMatch(/v1=[0-9a-f]{16}/);
    }
  });

  it("honours the allowed host list and allowPrivateTargets", async () => {
    const dns = createFakeDns({ "nas.example.test": ["192.168.1.5"], "hooks.example.test": ["93.184.216.34"] });
    const a = mk({ dns, policy: { ...POLICY, allowedHosts: ["other.example.test"] } });
    expect(await send(a.sender)).toMatchObject({ ok: false, code: "host_not_listed" });
    const b = mk({ dns, policy: { ...POLICY, allowPrivateTargets: true } });
    expect(await b.sender.send({ url: "https://nas.example.test/in", secret: SECRET, body: BODY })).toMatchObject({ ok: true });
    expect(b.rx.calls[0].address).toBe("192.168.1.5");
    dns.set("meta.example.test", ["169.254.169.254"]);
    expect(await b.sender.send({ url: "https://meta.example.test/in", secret: SECRET, body: BODY })).toMatchObject({ ok: false, code: "blocked_address" });
  });
});
