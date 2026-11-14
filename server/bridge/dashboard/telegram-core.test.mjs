import { describe, expect, it } from "vitest";
import { EVENT_KEYS } from "../notify/events.mjs";
import { EVENT_GROUPS, groupEvents, healthView } from "./telegram-core.js";

describe("event groups", () => {
  it("every event the Bridge has is in exactly one group, so none is hidden from the card", () => {
    const listed = EVENT_GROUPS.flatMap(([, keys]) => keys);
    expect([...listed].sort()).toEqual([...EVENT_KEYS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });
  it("keeps the group order and skips keys the server did not send", () => {
    const g = groupEvents([{ key: "hook.stale" }, { key: "order.rejected" }, { key: "order.filled" }]);
    expect(g.map((x) => x.title)).toEqual(["Orders", "Webhook alerts"]);
    expect(g[0].events.map((e) => e.key)).toEqual(["order.rejected", "order.filled"]);
  });
});

describe("health words", () => {
  it("says working, not tested, slowed, cannot reach, or needs attention", () => {
    expect(healthView({ state: "ok" })).toEqual({ word: "Working", tone: "ok" });
    expect(healthView({ state: "unverified" })).toEqual({ word: "Not tested yet", tone: "" });
    expect(healthView(undefined)).toEqual({ word: "Not tested yet", tone: "" });
    expect(healthView({ state: "rate_limited" }).tone).toBe("warn");
    expect(healthView({ state: "network" }).word).toBe("Cannot reach Telegram");
    expect(healthView({ state: "token_invalid" })).toEqual({ word: "Needs attention", tone: "bad" });
    expect(healthView({ state: "blocked" }).tone).toBe("bad");
  });
});
