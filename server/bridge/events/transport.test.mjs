/**
 * The real transport, against servers on 127.0.0.1 only (the test run's guard allows this computer and nothing else).
 * Proves what the fake transport cannot: the connection goes to the pinned address whatever the name says, redirects are
 * not followed, the answer's size and time are capped, and a certificate that cannot be verified is refused.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSender } from "./sender.mjs";
import { classifySocketError, createHttpTransport } from "./transport.mjs";
import { SECRET, tmpDir } from "./testkit.mjs";

const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
});

async function listen(handler, make = (h) => http.createServer(h)) {
  const seen = [];
  const server = make((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, seen);
    });
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, server };
}

const call = (transport, over) =>
  transport({ url: new URL("http://receiver.example.test/in?x=1"), address: "127.0.0.1", family: 4, headers: { "Content-Type": "application/json" }, body: '{"a":1}', timeoutMs: 2000, maxResponseBytes: 1024, ...over });

describe("real transport (loopback servers)", () => {
  it("connects to the pinned address, not to what the name says, and sends Host, path, body and length", async () => {
    const s = await listen((req, res) => res.writeHead(204).end());
    const r = await call(createHttpTransport(), { url: new URL(`http://receiver.example.test:${s.port}/in?x=1`) });
    expect(r).toEqual({ status: 204, retryAfter: null, hasLocation: false });
    expect(s.seen[0]).toMatchObject({ method: "POST", url: "/in?x=1", body: '{"a":1}' });
    expect(s.seen[0].headers.host).toBe(`receiver.example.test:${s.port}`);
    expect(s.seen[0].headers["content-length"]).toBe("7");
    expect(s.seen[0].headers.connection).toBe("close");
  });

  it("does not follow a redirect", async () => {
    const target = await listen((req, res) => res.writeHead(200).end("reached"));
    const s = await listen((req, res) => res.writeHead(307, { Location: `http://127.0.0.1:${target.port}/elsewhere` }).end());
    const r = await call(createHttpTransport(), { url: new URL(`http://receiver.example.test:${s.port}/in`) });
    expect(r).toMatchObject({ status: 307, hasLocation: true });
    await new Promise((x) => setTimeout(x, 50));
    expect(target.seen).toEqual([]);
  });

  it("reports Retry-After", async () => {
    const s = await listen((req, res) => res.writeHead(429, { "Retry-After": "30" }).end());
    expect(await call(createHttpTransport(), { url: new URL(`http://receiver.example.test:${s.port}/`) })).toMatchObject({ status: 429, retryAfter: "30" });
  });

  it("stops reading a huge answer at the cap and closes the connection", async () => {
    let closed;
    const done = new Promise((r) => (closed = r));
    const s = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      const chunk = Buffer.alloc(16 * 1024, 120);
      const timer = setInterval(() => res.write(chunk), 2);
      res.on("close", () => {
        clearInterval(timer);
        closed();
      });
    });
    const r = await call(createHttpTransport(), { url: new URL(`http://receiver.example.test:${s.port}/`), maxResponseBytes: 2048 });
    expect(r.status).toBe(200);
    await done; // the server saw the connection go away instead of streaming forever
  });

  it("gives up on a receiver that never answers", async () => {
    const s = await listen(() => {});
    const t0 = Date.now();
    const err = await call(createHttpTransport(), { url: new URL(`http://receiver.example.test:${s.port}/`), timeoutMs: 200 }).catch((e) => e);
    expect(classifySocketError(err)).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("closes a receiver that trickles its answer past the deadline", async () => {
    let closed;
    const done = new Promise((r) => (closed = r));
    const s = await listen((req, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write("x"), 20);
      res.on("close", () => {
        clearInterval(timer);
        closed();
      });
    });
    const r = await call(createHttpTransport(), { url: new URL(`http://receiver.example.test:${s.port}/`), timeoutMs: 300, maxResponseBytes: 1_000_000 });
    expect(r.status).toBe(200);
    await done;
  });

  it("fails fast when nothing listens", async () => {
    const s = await listen(() => {});
    const port = s.port;
    await new Promise((r) => s.server.close(r));
    servers.length = 0;
    const err = await call(createHttpTransport(), { url: new URL(`http://receiver.example.test:${port}/`) }).catch((e) => e);
    expect(classifySocketError(err)).toBe("connect_failed");
  });
});

describe("classifySocketError", () => {
  it("never needs the error's text", () => {
    for (const [code, want] of [["ETIMEDOUT", "timeout"], ["ENOTFOUND", "dns_failed"], ["EAI_AGAIN", "dns_failed"], ["ECONNREFUSED", "connect_failed"], ["EHOSTUNREACH", "connect_failed"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls_failed"], ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_failed"], ["SELF_SIGNED_CERT_IN_CHAIN", "tls_failed"], ["WHATEVER", "request_failed"]]) {
      expect(classifySocketError(Object.assign(new Error("connect to 10.0.0.1:443 failed"), { code }))).toBe(want);
    }
    expect(classifySocketError(undefined)).toBe("request_failed");
  });
});

describe("TLS is always verified", () => {
  it("refuses a certificate it cannot verify, through the sender too", async () => {
    const dir = tmpDir();
    let have = true;
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=receiver.example.test", "-days", "1"], { stdio: "ignore" });
      writeFileSync(join(dir, "ok"), "1");
    } catch {
      have = false;
    }
    if (!have) return; // no openssl on this machine: the other tests still cover the rest
    const s = await listen((req, res) => res.writeHead(200).end(), (h) => https.createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, h));
    const err = await call(createHttpTransport(), { url: new URL(`https://receiver.example.test:${s.port}/`) }).catch((e) => e);
    expect(classifySocketError(err)).toBe("tls_failed");
    const sender = createSender({
      policy: () => ({ allowPrivateTargets: true, allowedHosts: [], timeoutMs: 2000, maxResponseBytes: 1024 }),
      transport: createHttpTransport(),
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    const r = await sender.send({ url: `https://receiver.example.test:${s.port}/in`, secret: SECRET, body: "{}" });
    expect(r).toMatchObject({ ok: false, code: "tls_failed" });
    expect(s.seen).toEqual([]); // nothing was sent over the unverified connection
  });
});

describe("sender with the real transport", () => {
  it("delivers to a local receiver when private targets are allowed, with a verifiable signature", async () => {
    const { verifySignature } = await import("./signature.mjs");
    const s = await listen((req, res) => res.writeHead(200).end("ok"));
    const sender = createSender({
      policy: () => ({ allowPrivateTargets: true, allowedHosts: [], timeoutMs: 2000, maxResponseBytes: 1024 }),
      transport: createHttpTransport(),
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    const body = '{"id":"1"}';
    const r = await sender.send({ url: `http://receiver.example.test:${s.port}/in`, secret: SECRET, body });
    expect(r).toMatchObject({ ok: true, status: 200 });
    const h = s.seen[0].headers;
    expect(verifySignature({ secret: SECRET, timestamp: h["x-bridge-timestamp"], signature: h["x-bridge-signature"], body: s.seen[0].body })).toEqual({ ok: true });
    expect(s.seen[0].body).toBe(body);
  });

  it("is refused by default: the same loopback target needs allowPrivateTargets", async () => {
    const s = await listen((req, res) => res.writeHead(200).end());
    const sender = createSender({
      policy: () => ({ allowPrivateTargets: false, allowedHosts: [], timeoutMs: 2000, maxResponseBytes: 1024 }),
      transport: createHttpTransport(),
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    expect(await sender.send({ url: `https://receiver.example.test:${s.port}/in`, secret: SECRET, body: "{}" })).toMatchObject({ ok: false, code: "blocked_address" });
    expect(await sender.send({ url: `http://127.0.0.1:${s.port}/in`, secret: SECRET, body: "{}" })).toMatchObject({ ok: false, code: "blocked_scheme" });
    expect(s.seen).toEqual([]);
  });
});
