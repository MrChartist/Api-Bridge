import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSpec } from "../../../scripts/lib/openapi-model.mjs";
import { ERROR_CODES } from "./errors.mjs";
import { ERROR_GUIDE, errorCatalogue, retryAdvice, undocumentedCodes } from "./errorCatalogue.mjs";

const SERVER = join(import.meta.dirname, "..", "..");

/** Every non-test source file under server/ (the Bridge's own code). */
function sources(dir = SERVER) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" || f === "__fixtures__" ? [] : sources(p);
    return /\.(mjs|js)$/.test(f) && !/\.test\.mjs$/.test(f) ? [p] : [];
  });
}

describe("error catalogue", () => {
  it("has a plain explanation and a fix for every code in ERROR_CODES (a new code with no entry fails here)", () => {
    expect(undocumentedCodes(), "add these codes to ERROR_GUIDE in errorCatalogue.mjs").toEqual([]);
    expect(errorCatalogue().map((e) => e.code).sort()).toEqual(Object.keys(ERROR_CODES).sort());
  });

  it("explains nothing that does not exist (a renamed or removed code leaves no stale entry)", () => {
    expect(Object.keys(ERROR_GUIDE).filter((c) => !ERROR_CODES[c])).toEqual([]);
  });

  it("takes status, title and retryable from the real definitions, never from this file", () => {
    for (const e of errorCatalogue()) {
      expect(e.status, e.code).toBe(ERROR_CODES[e.code].status);
      expect(e.title, e.code).toBe(ERROR_CODES[e.code].title);
      expect(e.retryable, e.code).toBe(ERROR_CODES[e.code].retryable);
    }
  });

  it("is sorted by status then code, and each entry has complete sentences", () => {
    const list = errorCatalogue();
    const sorted = [...list].sort((a, b) => a.status - b.status || a.code.localeCompare(b.code));
    expect(list.map((e) => e.code)).toEqual(sorted.map((e) => e.code));
    for (const e of list) {
      expect(e.means.length, `${e.code} means`).toBeGreaterThan(20);
      expect(e.fix.length, `${e.code} fix`).toBeGreaterThan(20);
      expect(e.means, e.code).toMatch(/[.)]$/);
      expect(e.fix, e.code).toMatch(/[.)]$/);
      expect(`${e.means} ${e.fix}`, `${e.code}: no emoji`).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it("never tells a client to retry an order whose outcome is unknown, and says why a 429 comes back", () => {
    expect(retryAdvice("OUTCOME_UNKNOWN")).toMatch(/check the order book/i);
    expect(retryAdvice("RATE_LIMITED")).toMatch(/Retry-After/);
    expect(retryAdvice("VALIDATION_FAILED")).toMatch(/Do not retry/);
    expect(retryAdvice("BROKER_UNAVAILABLE")).toMatch(/Safe to retry/);
    const byCode = Object.fromEntries(errorCatalogue().map((e) => [e.code, e]));
    expect(byCode.OUTCOME_UNKNOWN.fix).toMatch(/Do not send it again/);
    expect(byCode.RATE_LIMITED.fix).toMatch(/retryAfterMs/);
  });

  it("covers every code the Bridge's own code throws by name (a literal code that is not defined would become INTERNAL)", () => {
    const thrown = new Set();
    for (const file of sources()) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/new BridgeError\(\s*"([A-Z][A-Z0-9_]+)"/g)) thrown.add(m[1]);
    }
    const unknown = [...thrown].filter((c) => !ERROR_CODES[c]);
    expect(unknown, "these codes are thrown but not defined in errors.mjs, so the client would see INTERNAL").toEqual([]);
    expect(thrown.size).toBeGreaterThan(10);
  });

  it("refers only to routes and commands that exist in this repository", () => {
    const text = JSON.stringify(ERROR_GUIDE);
    const openapi = readFileSync(join(SERVER, "..", "docs", "openapi.yaml"), "utf8");
    for (const m of text.matchAll(/(?:GET|POST) (\/v1\/[a-z/{}A-Z-]+)/g)) {
      const path = m[1].replace(/\/$/, "");
      expect(openapi.includes(`  ${path}:`), `${path} is in docs/openapi.yaml`).toBe(true);
    }
  });

  it("names the right HTTP method for every route it mentions (a POST on a GET-only route answers 405)", () => {
    const spec = loadSpec();
    const text = JSON.stringify(ERROR_GUIDE);
    let seen = 0;
    for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE) (\/v1\/[a-z/{}A-Z-]+)/g)) {
      const path = m[2].replace(/\/$/, "");
      expect(spec.paths[path]?.[m[1].toLowerCase()], `${m[1]} ${path} is a real operation`).toBeTruthy();
      seen++;
    }
    expect(seen).toBeGreaterThan(5);
  });
});
