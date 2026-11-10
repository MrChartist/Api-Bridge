import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CANDLE_FIELDS, QUOTE_FIELDS } from "../market/routes.mjs";
import { INSTRUMENT_FIELDS } from "../symbols/routes.mjs";
import { parseFields, pickAll, pickFields } from "./fields.mjs";

const q = (s) => new URLSearchParams(s);
const ALLOWED = ["symbol", "ltp", "bid", "freshness"];

describe("parseFields", () => {
  it("is null when fields was not sent, or sent empty", () => {
    expect(parseFields(q(""), { allowed: ALLOWED })).toBeNull();
    expect(parseFields(q("fields="), { allowed: ALLOWED })).toBeNull();
  });

  it("names are trimmed and de-duplicated; always-kept fields are added", () => {
    const p = parseFields(q("fields=ltp, bid,ltp"), { allowed: ALLOWED, always: ["symbol", "freshness"] });
    expect(p.names).toEqual(["ltp", "bid"]);
    expect([...p.keep].sort()).toEqual(["bid", "freshness", "ltp", "symbol"]);
  });

  it("an unknown name is a 400 that lists the allowed ones", () => {
    try {
      parseFields(q("fields=ltp,lpt"), { allowed: ALLOWED });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
      expect(e.detail).toMatch(/lpt/);
      expect(e.detail).toMatch(/Allowed: symbol, ltp, bid, freshness/);
    }
    expect(() => parseFields(q("fields=,"), { allowed: ALLOWED })).toThrow(/empty/);
    expect(() => parseFields(q("fields=ltp&fields=bid"), { allowed: ALLOWED })).toThrow(/only once/);
  });
});

describe("pickFields", () => {
  it("keeps the named keys in the item's own order and does not change the input", () => {
    const item = { symbol: "A", ltp: 1, bid: 2, extra: 3 };
    const out = pickFields(item, new Set(["bid", "symbol"]));
    expect(out).toEqual({ symbol: "A", bid: 2 });
    expect(Object.keys(out)).toEqual(["symbol", "bid"]);
    expect(item).toEqual({ symbol: "A", ltp: 1, bid: 2, extra: 3 });
    expect(pickAll([item], null)).toEqual([item]);
    expect(pickFields(null, new Set())).toBeNull();
  });
});

const SPEC = readFileSync(resolve(import.meta.dirname, "../../../docs/openapi.yaml"), "utf8");

/** Property names of a component schema in the spec's disciplined layout. */
function schemaProps(name) {
  const lines = SPEC.split("\n");
  const start = lines.findIndex((l) => l === `    ${name}:`);
  expect(start).toBeGreaterThan(0);
  const props = [];
  let inProps = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^ {4}\S/.test(l)) break;
    if (/^ {6}properties:\s*$/.test(l)) {
      inProps = true;
      continue;
    }
    if (inProps && /^ {6}\S/.test(l)) inProps = false;
    const m = inProps ? /^ {8}([A-Za-z]\w*):/.exec(l) : null;
    if (m) props.push(m[1]);
  }
  return props;
}

describe("the fields each answer allows are the fields the OpenAPI schema has", () => {
  it("quotes", () => expect([...QUOTE_FIELDS].sort()).toEqual(schemaProps("QuoteItem").sort()));
  it("candles", () => expect([...CANDLE_FIELDS].sort()).toEqual(schemaProps("Candle").sort()));
  it("instruments (refs is only there with include=refs on one instrument)", () => expect([...INSTRUMENT_FIELDS].sort()).toEqual(schemaProps("Instrument").filter((p) => p !== "refs").sort()));
});
