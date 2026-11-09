// The code in docs/guides/developers.md runs: the signature check in the guide accepts what the Bridge signs.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sign } from "../auth/hmac.mjs";

const guide = readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "guides", "developers.md"), "utf8");
const block = (lang) => new RegExp("```" + lang + "\\n([\\s\\S]*?)```").exec(guide)[1];
const SECRET = "a-secret-that-is-long-enough";
const BODY = '{"id":"evt_1","topic":"order.updated"}';
const T = Math.floor(Date.now() / 1000);

describe("docs/guides/developers.md", () => {
  it("the Node signature check accepts a header the Bridge made, and refuses a changed body or an old timestamp", async () => {
    const mod = await import(`data:text/javascript,${encodeURIComponent(`${block("js")}\nexport { verify };`)}`);
    const header = sign(SECRET, T, BODY);
    expect(mod.verify(SECRET, header, Buffer.from(BODY))).toBe(true);
    expect(mod.verify(SECRET, header, Buffer.from(`${BODY} `))).toBe(false);
    expect(mod.verify("other-secret-long-enough", header, Buffer.from(BODY))).toBe(false);
    expect(mod.verify(SECRET, sign(SECRET, T - 3600, BODY), Buffer.from(BODY))).toBe(false);
  });

  it("the Python signature check agrees", (ctx) => {
    const run = (code) => spawnSync("python3", ["-c", code], { encoding: "utf8" });
    if (run("print(1)").status !== 0) return ctx.skip();
    const header = sign(SECRET, T, BODY);
    const script = `${block("python")}\nprint(verify(b"${SECRET}", "${header}", b'${BODY}'), verify(b"${SECRET}", "${header}", b'${BODY} '))`;
    const r = run(script);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("True False");
  });

  it("names the starters, scopes and routes that exist", () => {
    for (const id of ["node", "python", "curl", "sheets", "webhook-receiver", "mcp-client"]) expect(guide).toContain(id);
    expect(guide).toContain("GET /v1/errors");
    expect(guide).toContain("Idempotency-Key");
    expect(guide).toMatch(/versioning promise/i);
  });
});
