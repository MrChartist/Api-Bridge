// The code in docs/guides/developers.md runs: the signature checks in the guide accept what the Bridge's outbound webhooks
// carry (X-Bridge-Timestamp and X-Bridge-Signature: v1=HMAC-SHA256(secret, "<timestamp>." + raw body)).
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { realNow } from "../../../test/realClock.mjs";

const guide = readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "guides", "developers.md"), "utf8");
const block = (lang) => new RegExp("```" + lang + "\\n([\\s\\S]*?)```").exec(guide)[1];
const SECRET = "a-secret-that-is-long-enough";
const BODY = '{"id":"evt_1","topic":"order.updated"}';
const T = Math.floor(Date.now() / 1000);
const header = (secret, t, body) => `v1=${createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex")}`;

describe("docs/guides/developers.md", () => {
  it("the Node signature check accepts what the Bridge sends, and refuses a changed body, a wrong secret or an old timestamp", async () => {
    const mod = await import(`data:text/javascript,${encodeURIComponent(`${block("js")}\nexport { verify };`)}`);
    const ok = { secret: SECRET, timestamp: String(T), signature: header(SECRET, T, BODY), rawBody: Buffer.from(BODY) };
    expect(mod.verify(ok)).toBe(true);
    expect(mod.verify({ ...ok, rawBody: Buffer.from(`${BODY} `) })).toBe(false);
    expect(mod.verify({ ...ok, secret: "other-secret-long-enough" })).toBe(false);
    expect(mod.verify({ ...ok, timestamp: String(T - 3600), signature: header(SECRET, T - 3600, BODY) })).toBe(false);
    expect(mod.verify({ ...ok, signature: `v1=${"0".repeat(64)} ${ok.signature}` })).toBe(true);
    expect(mod.verify({ ...ok, signature: undefined })).toBe(false);
  });

  it("the Python signature check agrees", (ctx) => {
    const run = (code) => spawnSync("python3", ["-c", code], { encoding: "utf8" });
    if (run("print(1)").status !== 0) return ctx.skip();
    const T = Math.floor(realNow() / 1000); // a Python child reads the real clock
    const sig = header(SECRET, T, BODY);
    const script = `${block("python")}\nprint(verify("${SECRET}", "${T}", "${sig}", b'${BODY}'), verify("${SECRET}", "${T}", "${sig}", b'${BODY} '), verify("${SECRET}", "${T - 3600}", "${header(SECRET, T - 3600, BODY)}", b'${BODY}'))`;
    const r = run(script);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("True False False");
  });

  it("agrees with the Bridge's own signer when this checkout has one", async (ctx) => {
    const file = join(import.meta.dirname, "..", "events", "signature.mjs");
    if (!existsSync(file)) return ctx.skip();
    const bridge = await import(file);
    const mod = await import(`data:text/javascript,${encodeURIComponent(`${block("js")}\nexport { verify };`)}`);
    const h = bridge.signatureHeaders(SECRET, T, BODY);
    expect(mod.verify({ secret: SECRET, timestamp: h["X-Bridge-Timestamp"], signature: h["X-Bridge-Signature"], rawBody: Buffer.from(BODY) })).toBe(true);
  });

  it("names the starters, the real events routes and the signing headers, and not the old inbound scheme", () => {
    for (const id of ["node", "python", "curl", "sheets", "webhook-receiver", "mcp-client"]) expect(guide).toContain(id);
    for (const s of ["GET /v1/errors", "Idempotency-Key", "/v1/events/stream", "/v1/subscriptions/{id}/test", "X-Bridge-Signature", "X-Bridge-Timestamp", "X-Bridge-Event-Id", "allowPrivateTargets"]) expect(guide).toContain(s);
    expect(guide).not.toContain("X-MCB-Signature");
    expect(guide).toMatch(/versioning promise/i);
  });
});
