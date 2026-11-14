/**
 * docs/guides/troubleshooting.md is keyed by the Bridge's real error codes. This keeps it honest:
 *   - every code it names exists, and each "### CODE (status)" heading carries the real HTTP status;
 *   - the ten codes a beginner meets all have a section;
 *   - every "detail" it quotes is what a demo Bridge really answers (the example requests are run here).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootDemoBridge } from "../server/bridge/core/__fixtures__/demoBridge.mjs";
import { errorCatalogue } from "../server/bridge/core/errorCatalogue.mjs";
import { ERROR_CODES } from "../server/bridge/core/errors.mjs";
import { ROOT } from "./lib/repo-files.mjs";

const page = readFileSync(join(ROOT, "docs/guides/troubleshooting.md"), "utf8");
const BEGINNER = ["UNAUTHENTICATED", "SCOPE_REQUIRED", "VALIDATION_FAILED", "PAPER_ONLY", "SYMBOL_NOT_FOUND", "INVALID_ORDER", "MARKET_CLOSED", "RATE_LIMITED", "KILL_SWITCH_ACTIVE", "LOOPBACK_ONLY", "CANNOT_TRADE"];

describe("troubleshooting.md and the error catalogue", () => {
  const sections = [...page.matchAll(/^### ([A-Z][A-Z_]+) \((\d{3})[,)]/gm)].map((m) => ({ code: m[1], status: Number(m[2]) }));

  it("has a section for each code a beginner meets, with the real status", () => {
    expect(sections.map((s) => s.code)).toEqual(expect.arrayContaining(BEGINNER.filter((c) => !["CANNOT_TRADE"].includes(c))));
    for (const s of sections) expect(ERROR_CODES[s.code]?.status, `${s.code} is a real code with status ${s.status}`).toBe(s.status);
    expect(page).toMatch(/### CANNOT_TRADE \(403\)/);
  });

  it("names no error code the Bridge does not define", () => {
    const named = new Set([
      ...[...page.matchAll(/"code":"([A-Z][A-Z_]+)"/g)].map((m) => m[1]),
      ...[...page.matchAll(/`([A-Z][A-Z]+_[A-Z_]+)`/g)].map((m) => m[1]).filter((c) => !c.startsWith("MCB_")),
      ...[...page.matchAll(/^\| `([A-Z][A-Z_]+)` \(\d{3}\)/gm)].map((m) => m[1]),
    ]);
    const unknown = [...named].filter((c) => !ERROR_CODES[c]);
    expect(unknown).toEqual([]);
    expect(named.size).toBeGreaterThan(10);
  });

  it("links the full list and every code in its closing table has a catalogue entry", () => {
    expect(page).toContain("../api/errors.md");
    const cat = new Map(errorCatalogue().map((e) => [e.code, e]));
    for (const m of page.matchAll(/^\| `([A-Z][A-Z_]+)` \((\d{3})\) \|/gm)) {
      expect(cat.get(m[1])?.status, m[1]).toBe(Number(m[2]));
    }
  });
});

describe("the worked examples are what a demo Bridge answers", () => {
  let demo;
  const seen = [];
  const note = (r) => {
    seen.push(r.text);
    return r;
  };
  let readKey;
  const ORDER = { account: "demo-paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET" };
  const order = (extra = {}, idem = "ts-test-0001", auth) => demo.call("POST", "/v1/orders", { body: { ...ORDER, ...extra }, headers: idem ? { "Idempotency-Key": idem } : {}, ...(auth !== undefined ? { auth } : {}) }).then(note);

  beforeAll(async () => {
    demo = await bootDemoBridge();
    readKey = (await demo.app.deps.keyStore.create({ label: "ts-read", scopes: ["read"], accounts: "*" })).key;
  });
  afterAll(async () => {
    await demo?.close();
  });

  it("UNAUTHENTICATED: no key, and a key that does not match", async () => {
    const none = note(await demo.call("GET", "/v1/ltp?symbols=NSE:RELIANCE", { auth: null }));
    expect(none.status).toBe(401);
    expect(none.json.code).toBe("UNAUTHENTICATED");
    const wrong = note(await demo.call("GET", "/v1/ltp?symbols=NSE:RELIANCE", { auth: "mcb_abcdefghij_wrongwrongwrongwrong" }));
    expect(wrong.status).toBe(401);
    // the X-API-Key header is accepted as well as Authorization: Bearer (the guides say both)
    const viaHeader = await demo.call("GET", "/v1/ltp?symbols=NSE:RELIANCE", { auth: null, headers: { "X-API-Key": demo.key } });
    expect(viaHeader.status).toBe(200);
  });

  it("SCOPE_REQUIRED: a read key places an order", async () => {
    const r = await order({}, "ts-test-0002", readKey);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("SCOPE_REQUIRED");
  });

  it("VALIDATION_FAILED: a short Idempotency-Key names the header", async () => {
    const r = await order({}, "abc");
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("VALIDATION_FAILED");
    expect(r.json.errors[0].path).toBe("Idempotency-Key");
  });

  it("PAPER_ONLY, INVALID_ORDER", async () => {
    const live = await order({ mode: "live" }, "ts-test-0003");
    expect([live.status, live.json.code]).toEqual([403, "PAPER_ONLY"]);
    const big = await order({ quantity: 1000 }, "ts-test-0004");
    expect([big.status, big.json.code]).toEqual([422, "INVALID_ORDER"]);
  });

  it("SYMBOL_NOT_FOUND: a list route answers 200 with errors[], a one-symbol route 404, and the fix names real routes", async () => {
    const list = note(await demo.call("GET", "/v1/ltp?symbols=NSE:NOPE"));
    expect(list.status).toBe(200);
    expect(list.json.errors[0].code).toBe("SYMBOL_NOT_FOUND");
    const one = note(await demo.call("GET", "/v1/symbols/resolve?q=NSE:NOPE"));
    expect([one.status, one.json.code]).toEqual([404, "SYMBOL_NOT_FOUND"]);
    expect((await demo.call("GET", "/v1/instruments/search?q=RELIANCE")).status).toBe(200);
    expect((await demo.call("GET", "/v1/expiries?underlying=NIFTY")).status).toBe(200);
  });

  it("MARKET_CLOSED: the calendar route the page points at answers status, reason and nextOpen fields", async () => {
    const r = await demo.call("GET", "/v1/calendar/status");
    expect(r.status).toBe(200);
    expect(r.json.data).toHaveProperty("status");
    expect(Object.keys(r.json.data)).toEqual(expect.arrayContaining(["reason", "nextOpen"]));
  });

  it("LOOPBACK_ONLY: a forwarding header makes a request count as outside", async () => {
    const r = note(await demo.call("GET", "/v1/keys", { headers: { "X-Forwarded-For": "1.2.3.4" } }));
    expect([r.status, r.json.code]).toEqual([403, "LOOPBACK_ONLY"]);
  });

  it("KILL_SWITCH_ACTIVE: new orders are refused with 423, then it is released", async () => {
    expect((await demo.call("POST", "/v1/safety/kill-switch", { body: { reason: "troubleshooting test" } })).status).toBe(200);
    const r = await order({}, "ts-test-0005");
    expect([r.status, r.json.code]).toEqual([423, "KILL_SWITCH_ACTIVE"]);
    expect(r.json.detail).toMatch(/cancels still work/i);
    expect((await demo.call("DELETE", "/v1/safety/kill-switch", { body: { confirm: "RELEASE" } })).status).toBe(200);
  });

  it("every detail the page quotes in full is a real answer", () => {
    // Demo prices move, so an amount of money is compared as a shape.
    const shape = (s) => s.replace(/₹[\d,]+/g, "₹N");
    const blob = shape(seen.join("\n").replaceAll("\\\"", '"'));
    const quoted = [...page.matchAll(/"detail":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replaceAll('\\"', '"')).filter((d) => !d.includes("..."));
    expect(quoted.length).toBeGreaterThanOrEqual(5);
    for (const d of quoted) expect(blob, d).toContain(shape(d));
  });
});
