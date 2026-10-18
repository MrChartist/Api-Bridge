/**
 * UDF conformance: replays chart request sequences (shape of TradingView's UDF-compatible datafeed) against the real
 * core pipeline with fake market data, and checks every response against the UDF wire rules:
 *  - history: s is ok | no_data | error; t/o/h/l/c/v are equal-length arrays; t strictly ascending Unix seconds;
 *    every t < to; t >= from unless countback is given; at most countback bars; daily-and-up bars at 00:00 UTC;
 *    no_data carries nextTime < from only when earlier data exists
 *  - scroll-back pages with contiguous windows neither overlap nor leave gaps between them
 *  - symbols: required LibrarySymbolInfo fields with valid types; search: required fields; quotes: s/n/v per symbol
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_RE } from "./config.mjs";
import { KEYS, NOW_MS } from "./__fixtures__/fakes.mjs";
import { bearer, startTestApp } from "./__fixtures__/testApp.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("./__fixtures__/tradingview-sequences.json", import.meta.url), "utf8"));

let t;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.close();
});

const SYMBOL_FIELDS = {
  name: "string",
  ticker: "string",
  description: "string",
  type: "string",
  session: "string",
  exchange: "string",
  listed_exchange: "string",
  timezone: "string",
  format: "string",
  minmov: "number",
  pricescale: "number",
  has_intraday: "boolean",
  has_daily: "boolean",
  has_weekly_and_monthly: "boolean",
  supported_resolutions: "object",
  volume_precision: "number",
  data_status: "string",
};

function checkBars(body, step, params) {
  const from = Number(params.get("from"));
  const to = Number(params.get("to"));
  expect(["ok", "no_data"]).toContain(body.s);
  if (body.s === "no_data") return [];
  const n = body.t.length;
  expect(n).toBeGreaterThan(0);
  for (const k of ["o", "h", "l", "c", "v"]) {
    expect(Array.isArray(body[k]), k).toBe(true);
    expect(body[k].length, k).toBe(n);
    expect(body[k].every((x) => typeof x === "number" && Number.isFinite(x)), k).toBe(true);
  }
  for (let i = 0; i < n; i += 1) {
    expect(Number.isInteger(body.t[i])).toBe(true);
    expect(body.t[i]).toBeLessThan(to);
    if (i) expect(body.t[i]).toBeGreaterThan(body.t[i - 1]);
    expect(body.l[i]).toBeLessThanOrEqual(Math.min(body.o[i], body.c[i]));
    expect(body.h[i]).toBeGreaterThanOrEqual(Math.max(body.o[i], body.c[i]));
    if (step.daily) expect(body.t[i] % 86_400, "daily bars at 00:00 UTC").toBe(0);
  }
  if (params.has("countback")) expect(n).toBeLessThanOrEqual(Number(params.get("countback")));
  else expect(body.t[0]).toBeGreaterThanOrEqual(from);
  if (step.countback) expect(n, "a full countback when data exists").toBe(Math.min(step.countback, n));
  return body.t;
}

describe("UDF conformance (TradingView request sequences)", () => {
  for (const seq of FIXTURE.sequences) {
    it(seq.name, async () => {
      const pages = {};
      for (const step of seq.steps) {
        const r = await t.request(step.path, { headers: bearer(KEYS.READ) });
        const params = new URL(step.path, "http://x").searchParams;
        const label = `${step.path} -> ${r.status} ${r.raw.slice(0, 200)}`;
        switch (step.expect) {
          case "config":
            expect(r.status, label).toBe(200);
            expect(Array.isArray(r.json.supported_resolutions)).toBe(true);
            for (const k of ["supports_search", "supports_group_request", "supports_marks", "supports_timescale_marks", "supports_time"]) expect(typeof r.json[k], k).toBe("boolean");
            expect(r.json.supports_search || r.json.supports_group_request).toBe(true);
            break;
          case "time":
            expect(r.status, label).toBe(200);
            expect(r.raw).toMatch(/^\d{10}$/);
            expect(Number(r.raw)).toBe(Math.floor(NOW_MS / 1000));
            break;
          case "symbol":
            expect(r.status, label).toBe(200);
            expect(r.json.s, "symbol info must not carry s").toBeUndefined();
            for (const [k, type] of Object.entries(SYMBOL_FIELDS)) expect(typeof r.json[k], `${k} in ${label}`).toBe(type);
            expect(r.json.ticker).toBe(step.ticker);
            expect(r.json.timezone).toBe("Asia/Kolkata");
            expect(SESSION_RE.test(r.json.session)).toBe(true);
            expect(Math.log10(r.json.pricescale) % 1).toBe(0);
            expect(r.json.minmov).toBeGreaterThanOrEqual(1);
            break;
          case "bars": {
            expect(r.status, label).toBe(200);
            expect(r.json.s, label).toBe("ok");
            pages[step.page ?? step.path] = { t: checkBars(r.json, step, params), from: Number(params.get("from")), to: Number(params.get("to")) };
            break;
          }
          case "no_data":
            expect(r.status, label).toBe(200);
            expect(r.json.s, label).toBe("no_data");
            if (step.nextTime === false) expect(r.json.nextTime, label).toBeUndefined();
            else {
              expect(r.json.nextTime, label).toBe(step.nextTime);
              expect(r.json.nextTime).toBeLessThan(Number(params.get("from")));
            }
            break;
          case "search":
            expect(r.status, label).toBe(200);
            expect(Array.isArray(r.json)).toBe(true);
            expect(r.json.length).toBeGreaterThanOrEqual(step.min);
            expect(r.json.length).toBeLessThanOrEqual(Number(params.get("limit")));
            for (const x of r.json) for (const k of ["symbol", "full_name", "description", "exchange", "ticker", "type"]) expect(typeof x[k], k).toBe("string");
            break;
          case "quotes":
            expect(r.status, label).toBe(200);
            expect(r.json.s).toBe("ok");
            expect(r.json.d).toHaveLength(step.n);
            expect(r.json.d.map((x) => x.n)).toEqual(params.get("symbols").split(","));
            for (const x of r.json.d) {
              expect(x.s).toBe("ok");
              expect(typeof x.v.lp).toBe("number");
            }
            break;
          case "error":
            expect(r.status, label).toBeGreaterThanOrEqual(400);
            expect(r.json.s).toBe("error");
            expect(typeof r.json.errmsg).toBe("string");
            break;
          default:
            throw new Error(`unknown expectation ${step.expect}`);
        }
      }
      // Scroll-back pages: windows are contiguous, so the bars inside each [from, to) window must not overlap or
      // repeat across pages. (countback takes priority over from, so a page may also reach back before its from;
      // the chart merges those, and they are left out of this check.)
      if (seq.pagesContiguous) {
        const ordered = seq.pagesContiguous.map((k) => ({ ...pages[k], t: pages[k].t.filter((x) => x >= pages[k].from) }));
        for (let i = 1; i < ordered.length; i += 1) {
          expect(ordered[i].from).toBe(ordered[i - 1].to);
          if (ordered[i - 1].t.length && ordered[i].t.length) expect(ordered[i].t[0]).toBeGreaterThan(ordered[i - 1].t.at(-1));
        }
        const all = ordered.flatMap((p) => p.t);
        expect(new Set(all).size).toBe(all.length);
      }
    });
  }
});

describe("UDF with a read-only URL key (charts that cannot send an Authorization header)", () => {
  it("every request of the sequences works with ?key= appended for a --allow-query key, as documented in the README", async () => {
    for (const seq of FIXTURE.sequences) {
      for (const step of seq.steps.filter((s) => s.expect !== "error")) {
        const sep = step.path.includes("?") ? "&" : "?";
        const r = await t.request(`${step.path}${sep}key=${KEYS.XL}`, { headers: {} });
        expect(r.status, `${step.path} with ?key=`).toBe(200);
      }
    }
  });

  it("refuses ?key= for a key not created with --allow-query, with a UDF error body", async () => {
    const r = await t.request(`/udf/config?key=${KEYS.READ}`, { headers: {} });
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ s: "error" });
  });
});
