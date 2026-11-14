/**
 * The dashboard and the recorder must agree on the request bodies. The Data page builds its bodies with the pure helpers in
 * dashboard/data-core.js; this test sends exactly those bodies to the recorder's own validators (`ruleSchema`,
 * `createSchema`) and to the service behind the routes, so the two cannot drift apart again (the dashboard once sent
 * `underlying` inside `universe`, no rule name and `expiry: "current-weekly"`, and every chain recording was refused).
 */
import { afterEach, describe, expect, it } from "vitest";
import { RECORD_PRESETS, recordingBody } from "../dashboard/data-core.js";
import { createSchema, rulePatchSchema, ruleSchema } from "./config.mjs";
import { NIFTY, at, bootRecorder } from "./testkit.mjs";

let w;
afterEach(async () => {
  await w?.close();
  w = null;
});

const base = { name: "", everySec: 30, format: "csv", expiries: "current-weekly", count: 10, keepDays: "", custom: false, days: ["Mon", "Tue", "Wed", "Thu", "Fri"], start: "", end: "" };
/** Every shape of form the recording sheet can produce. */
const FORMS = {
  "chain of an index": { ...base, kind: "chain", source: "index", underlying: "nifty" },
  "chain of an index, named, other expiry and width": { ...base, kind: "chain", source: "index", underlying: "BANKNIFTY", name: "  My chain ", expiries: "next-weekly", count: 3 },
  "chain from a collection": { ...base, kind: "chain", source: "collection", collection: "nifty-chain" },
  "prices of a collection": { ...base, kind: "quotes", source: "collection", collection: "watchlist", everySec: 5 },
  "prices of pasted symbols": { ...base, kind: "quotes", source: "symbols", symbols: [NIFTY, "NSE:RELIANCE"], everySec: 5, format: "jsonl" },
  "own days and hours, keep 30 days": { ...base, kind: "chain", source: "index", underlying: "NIFTY", custom: true, days: ["Mon", "Wed"], start: "09:15", end: "15:30", keepDays: "30" },
};
const library = { resolve: async (name) => ({ symbols: [NIFTY, "NSE:RELIANCE"], resolvedAt: "2026-11-09T09:15:00+05:30", rule: `collection ${name}` }) };

describe("the Data page request bodies are accepted by the recorder", () => {
  for (const [what, form] of Object.entries(FORMS)) {
    it(`a rule: ${what}`, async () => {
      const body = recordingBody(form, "rule");
      expect(ruleSchema.safeParse(body).error?.issues ?? []).toEqual([]);
      expect(rulePatchSchema.safeParse(body).error?.issues ?? []).toEqual([]);
      w = bootRecorder({ start: at("2026-11-09T09:15:00"), library });
      await w.svc.start();
      const made = await w.svc.createRule(body);
      expect(made.name).toBeTruthy();
      expect(made.enabled).toBe(true);
    });

    it(`a one-off recording: ${what}`, async () => {
      const body = recordingBody(form, "once");
      expect(createSchema.safeParse(body).error?.issues ?? []).toEqual([]);
      w = bootRecorder({ start: at("2026-11-09T09:15:00"), library });
      await w.svc.start();
      const made = await w.svc.create(body);
      expect(made.kind).toBe(form.kind);
    });
  }

  it("never puts the index inside the universe, and always names a rule", () => {
    const rule = recordingBody(FORMS["chain of an index"], "rule");
    expect(rule.underlying).toBe("NIFTY");
    expect(rule.universe).not.toHaveProperty("underlying");
    expect(rule.name).toBe("NIFTY option chain");
    expect(recordingBody({ ...FORMS["chain of an index"], expiries: "current-weekly" }, "once")).not.toHaveProperty("expiry");
    expect(recordingBody(FORMS["chain of an index, named, other expiry and width"], "once").name).toBe("My chain");
  });

  it("every one-click preset makes rules the recorder accepts", async () => {
    w = bootRecorder({ start: at("2026-11-09T09:15:00"), library });
    await w.svc.start();
    for (const preset of RECORD_PRESETS) {
      const bodies = preset.build({ collection: "watchlist" });
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(ruleSchema.safeParse(body).error?.issues ?? []).toEqual([]);
        await w.svc.createRule(body);
      }
    }
    expect(w.svc.listRules().length).toBe(RECORD_PRESETS.reduce((n, p) => n + p.build({ collection: "watchlist" }).length, 0));
  });
});
