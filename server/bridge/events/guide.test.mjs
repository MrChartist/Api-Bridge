/**
 * docs/guides/events.md is checked against the code:
 *  - every offered topic is in the topic table with the right scope, and the table lists nothing else;
 *  - the receiver snippets (Node, Python, shell) are extracted from the guide and RUN against signatures made by the real
 *    signer, with a matrix of good and bad requests; they must agree with verifySignature();
 *  - the Node receiver is started as a real process and sent signed requests.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { EVENT_TOPICS } from "./catalog.mjs";
import { computeSignature, signatureHeaders, verifySignature } from "./signature.mjs";
import { tmpDir } from "./testkit.mjs";

const GUIDE = readFileSync(resolve(import.meta.dirname, "../../../docs/guides/events.md"), "utf8");

/** The code block that follows `<!-- snippet:NAME -->`. */
function snippet(name) {
  const m = new RegExp(`<!-- snippet:${name} -->\\n\`\`\`\\w*\\n([\\s\\S]*?)\\n\`\`\``).exec(GUIDE);
  if (!m) throw new Error(`no snippet ${name} in docs/guides/events.md`);
  return `${m[1]}\n`;
}

const SECRET = "guide-test-secret-0123456789abcdef";
const BODY = '{"id":"7","topic":"order.updated","time":"2026-11-09T04:01:02.000Z","apiVersion":"v1","data":{"orderId":"o1","note":"₹ 182.40\\nline"}}\n';
const now = () => Math.floor(Date.now() / 1000);

/** The matrix: the same requests every implementation must judge the way verifySignature() does. */
function cases() {
  const good = (ts, body = BODY, secret = SECRET) => ({ secret: SECRET, timestamp: String(ts), signature: `v1=${computeSignature(secret, ts, body)}`, body });
  const t = now();
  return [
    ["a good request", good(t)],
    ["a request 250 s old", good(t - 250)],
    ["an empty body", good(t, "")],
    ["a body that is not JSON", good(t, "plain text, é")],
    ["too old (400 s)", good(t - 400)],
    ["from the future (400 s)", good(t + 400)],
    ["a changed body", { ...good(t), body: `${BODY} ` }],
    ["a different secret", good(t, BODY, "another-secret-another-secret-12")],
    ["a changed timestamp", { ...good(t), timestamp: String(t - 1) }],
    ["two signatures, one good", (() => { const g = good(t); return { ...g, signature: `v1=${computeSignature("old-secret-old-secret-old-secret", t, BODY)} ${g.signature}` }; })()],
    ["two signatures separated by a comma", (() => { const g = good(t); return { ...g, signature: `${g.signature},v1=${"0".repeat(64)}` }; })()],
    ["no v1= prefix", (() => { const g = good(t); return { ...g, signature: g.signature.slice(3) }; })()],
    ["a short signature", { ...good(t), signature: "v1=abcdef" }],
    ["a missing signature", { ...good(t), signature: "" }],
    ["a missing timestamp", { ...good(t), timestamp: "" }],
    ["a timestamp that is not a number", { ...good(t), timestamp: "1e9" }],
    ["a negative timestamp", { ...good(t), timestamp: "-5" }],
  ].map(([name, c]) => ({ name, ...c, expected: verifySignature({ secret: c.secret, timestamp: c.timestamp || undefined, signature: c.signature || undefined, body: c.body }).ok }));
}

describe("docs/guides/events.md topic table", () => {
  const rows = [...GUIDE.matchAll(/^\| `([a-z_.]+)` \| (read|admin) \|/gm)].map((m) => [m[1], m[2]]);
  it("lists every offered topic with its scope, and nothing else", () => {
    expect(rows.map((r) => r[0]).sort()).toEqual(EVENT_TOPICS.map((t) => t.topic).sort());
    for (const [topic, scope] of rows) expect(EVENT_TOPICS.find((t) => t.topic === topic).scope, topic).toBe(scope);
  });
  it("matrix sanity: the signer accepts the good cases and refuses the bad ones", () => {
    const m = cases();
    expect(m.filter((c) => c.expected).map((c) => c.name)).toEqual(["a good request", "a request 250 s old", "an empty body", "a body that is not JSON", "two signatures, one good", "two signatures separated by a comma"]);
  });
  it("says the plain things: read-only, no approval, https only, never a secret", () => {
    for (const phrase of [/notifications only/i, /Nothing you receive can place, change, confirm or reject an\s+order/, /order-approval\s+token/, /`https:\/\/` only/, /never returned/]) expect(GUIDE).toMatch(phrase);
  });
});

describe("Node snippet", () => {
  it("agrees with the real signer on every case", () => {
    const dir = tmpDir("mcb-guide-node-");
    writeFileSync(join(dir, "verify.js"), snippet("node"));
    const { verify } = createRequire(join(dir, "x.js"))("./verify.js");
    for (const c of cases()) expect(verify({ secret: c.secret, timestamp: c.timestamp, signature: c.signature, rawBody: Buffer.from(c.body) }), c.name).toBe(c.expected);
    // a Buffer or a string body both work
    const t = now();
    const h = signatureHeaders(SECRET, t, BODY);
    expect(verify({ secret: SECRET, timestamp: h["X-Bridge-Timestamp"], signature: h["X-Bridge-Signature"], rawBody: BODY })).toBe(true);
    expect(verify({ secret: SECRET, timestamp: h["X-Bridge-Timestamp"], signature: h["X-Bridge-Signature"], rawBody: Buffer.from(BODY), toleranceSec: 1 })).toBe(true);
    expect(verify({ secret: SECRET, timestamp: String(t - 10), signature: `v1=${computeSignature(SECRET, t - 10, BODY)}`, rawBody: BODY, toleranceSec: 5 })).toBe(false);
  });

  it("the complete receiver, started as a process, accepts signed events once and refuses the rest", async () => {
    const dir = tmpDir("mcb-guide-recv-");
    writeFileSync(join(dir, "verify.js"), snippet("node"));
    writeFileSync(join(dir, "receiver.js"), snippet("node-server"));
    const port = await new Promise((r) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => r(p));
      });
    });
    const child = spawn(process.execPath, ["receiver.js"], { cwd: dir, env: { ...process.env, SECRET, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    try {
      for (let i = 0; i < 200 && !out.includes("listening"); i += 1) await new Promise((r) => setTimeout(r, 25));
      expect(out).toContain("listening");
      const post = async (body, headers) => (await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body, headers })).status;
      const t = now();
      const signed = { ...signatureHeaders(SECRET, t, BODY), "X-Bridge-Event-Id": "7", "Content-Type": "application/json" };
      expect(await post(BODY, signed)).toBe(204);
      expect(await post(BODY, signed)).toBe(204); // a retry of the same event: acknowledged, handled once
      // a captured copy with another, unsigned header is the same event: still handled once (audit S3)
      expect(await post(BODY, { ...signed, "X-Bridge-Event-Id": "evt-changed-1" })).toBe(204);
      expect(await post(BODY, { ...signatureHeaders(SECRET, t, BODY), "Content-Type": "application/json" })).toBe(204);
      expect(await post(`${BODY} `, signed)).toBe(401);
      expect(await post(BODY, { ...signed, "X-Bridge-Signature": `v1=${"0".repeat(64)}` })).toBe(401);
      expect(await post(BODY, { "X-Bridge-Event-Id": "7" })).toBe(401);
      const old = { ...signatureHeaders(SECRET, t - 1000, BODY), "X-Bridge-Event-Id": "8" };
      expect(await post(BODY, old)).toBe(401);
      await new Promise((r) => setTimeout(r, 100));
      expect(out.match(/order\.updated/g)).toHaveLength(1);
    } finally {
      child.kill();
    }
  });
});

const py = spawnSync("python3", ["--version"]);
describe.skipIf(py.status !== 0)("Python snippet", () => {
  it("agrees with the real signer on every case", () => {
    const dir = tmpDir("mcb-guide-py-");
    const lib = join(dir, "lib");
    mkdirSync(lib);
    writeFileSync(join(lib, "verify.py"), snippet("python"));
    writeFileSync(
      join(dir, "harness.py"),
      ["import base64, json, sys", "sys.path.insert(0, sys.argv[1])", "from verify import verify", "cases = json.load(sys.stdin)", "print(json.dumps([verify(c['secret'], c['timestamp'], c['signature'], base64.b64decode(c['body'])) for c in cases]))"].join("\n"),
    );
    const list = cases();
    const input = JSON.stringify(list.map((c) => ({ secret: c.secret, timestamp: c.timestamp, signature: c.signature, body: Buffer.from(c.body).toString("base64") })));
    const r = spawnSync("python3", ["-I", join(dir, "harness.py"), lib], { input, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual(list.map((c) => c.expected));
  });

  it("takes an injected clock", () => {
    const dir = tmpDir("mcb-guide-py2-");
    writeFileSync(join(dir, "verify.py"), snippet("python"));
    const sig = `v1=${computeSignature(SECRET, 1_700_000_000, BODY)}`;
    const script = ["import sys", "sys.path.insert(0, sys.argv[1])", "from verify import verify", `b = ${JSON.stringify(BODY)}.encode()`, `print(verify(${JSON.stringify(SECRET)}, "1700000000", ${JSON.stringify(sig)}, b, now=1700000100), verify(${JSON.stringify(SECRET)}, "1700000000", ${JSON.stringify(sig)}, b, now=1700000400), verify(${JSON.stringify(SECRET)}, "1700000000", ${JSON.stringify(sig)}, b, tolerance_sec=500, now=1700000400))`].join("\n");
    writeFileSync(join(dir, "t.py"), script);
    const r = spawnSync("python3", ["-I", join(dir, "t.py"), dir], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe("True False True");
  });
});

const sh = spawnSync("bash", ["-c", "command -v openssl >/dev/null && command -v sed >/dev/null"]);
describe.skipIf(sh.status !== 0)("shell snippet", () => {
  it("agrees with the real signer on every case (lower-case hex, as the Bridge sends it)", () => {
    const dir = tmpDir("mcb-guide-sh-");
    const script = join(dir, "verify-bridge-signature.sh");
    writeFileSync(script, snippet("shell"), { mode: 0o700 });
    for (const c of cases()) {
      writeFileSync(join(dir, "body"), c.body);
      const r = spawnSync("bash", [script, c.secret, c.timestamp, c.signature, join(dir, "body")], { encoding: "utf8" });
      expect(r.status === 0, c.name).toBe(c.expected);
    }
  });

  it("honours TOLERANCE_SEC", () => {
    const dir = tmpDir("mcb-guide-sh2-");
    const script = join(dir, "v.sh");
    writeFileSync(script, snippet("shell"), { mode: 0o700 });
    writeFileSync(join(dir, "body"), BODY);
    const t = now() - 100;
    const sig = `v1=${computeSignature(SECRET, t, BODY)}`;
    expect(spawnSync("bash", [script, SECRET, String(t), sig, join(dir, "body")], { env: { ...process.env, TOLERANCE_SEC: "50" } }).status).toBe(1);
    expect(spawnSync("bash", [script, SECRET, String(t), sig, join(dir, "body")], { env: { ...process.env, TOLERANCE_SEC: "500" } }).status).toBe(0);
  });
});
