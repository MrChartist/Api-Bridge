import { describe, expect, it } from "vitest";
import { TOPICS } from "../core/eventBus.mjs";
import { EVENT_TOPICS, canSee, checkTopicPatterns, isOfferedTopic, matchesAny, parsePatternList, patternMatches, topicsFor, viewerOf } from "./catalog.mjs";

const NEVER_OFFERED = ["tick", "audit.appended", "key.revoked", "account.session_rejected"];

describe("topic catalog", () => {
  it("offers every bus topic except the internal ones, and nothing the bus does not have", () => {
    const offered = EVENT_TOPICS.map((t) => t.topic);
    expect(new Set(offered).size).toBe(offered.length);
    for (const t of offered) expect(TOPICS, `${t} is not a bus topic`).toContain(t);
    for (const t of TOPICS) if (!NEVER_OFFERED.includes(t)) expect(offered, `${t} should be offered`).toContain(t);
    for (const t of NEVER_OFFERED) expect(isOfferedTopic(t)).toBe(false);
  });

  it("includes download.* and recording.* topics", () => {
    for (const t of ["download.progress", "download.done", "download.failed", "recording.started", "recording.stopped", "recording.gap", "recording.disk_low"]) expect(isOfferedTopic(t)).toBe(true);
  });

  it("is read-only: no topic or description is about confirming, approving or placing", () => {
    for (const t of EVENT_TOPICS) expect(`${t.topic} ${t.scope}`).not.toMatch(/confirm(?!ed)|approve|place|submit/i);
  });

  it("matches filters: exact, prefix and star", () => {
    expect(patternMatches("*", "order.updated")).toBe(true);
    expect(patternMatches("order.*", "order.updated")).toBe(true);
    expect(patternMatches("order.*", "orders.updated")).toBe(false);
    expect(patternMatches("order.updated", "order.updated")).toBe(true);
    expect(patternMatches("order.updated", "order.outcome_unknown")).toBe(false);
    expect(matchesAny(["hook.*", "order.updated"], "order.updated")).toBe(true);
  });

  it("checks topic filters", () => {
    expect(checkTopicPatterns(["order.*", "download.done", "order.*"])).toEqual({ ok: true, patterns: ["order.*", "download.done"] });
    expect(checkTopicPatterns(["*"]).ok).toBe(true);
    for (const bad of [[], "order.*", ["nope.*"], ["order.updatedd"], ["ORDER.*"], ["order.*; drop"], [5], ["tick"], Array(51).fill("*")]) expect(checkTopicPatterns(bad).ok, JSON.stringify(bad)).toBe(false);
    expect(parsePatternList(null)).toEqual(["*"]);
    expect(parsePatternList("order.*, download.*")).toEqual(["order.*", "download.*"]);
  });

  it("shows a read key no admin-only topic", () => {
    const read = viewerOf({ scopes: ["read"], accounts: "*" });
    const admin = viewerOf({ scopes: ["admin"], accounts: "*" });
    const readTopics = topicsFor(read).map((t) => t.topic);
    expect(readTopics).toContain("order.updated");
    for (const t of ["ticket.prepared", "ticket.confirmed", "ticket.rejected", "hook.rejected", "hook.stale", "hook.failed", "backup.completed", "backup.failed", "config.warning"]) {
      expect(readTopics).not.toContain(t);
      expect(canSee(read, { topic: t, data: {} })).toBe(false);
      expect(canSee(admin, { topic: t, data: {} })).toBe(true);
    }
    expect(topicsFor(admin).length).toBe(EVENT_TOPICS.length);
  });

  it("limits account events to the key's accounts, and a paper key counts as read", () => {
    const v = viewerOf({ scopes: ["paper"], accounts: ["dhan-main"] });
    expect(canSee(v, { topic: "order.updated", data: { accountId: "dhan-main" } })).toBe(true);
    expect(canSee(v, { topic: "order.updated", data: { accountId: "kite-main" } })).toBe(false);
    expect(canSee(v, { topic: "order.updated", data: {} })).toBe(false);
    expect(canSee(v, { topic: "safety.kill_switch", data: { engaged: true } })).toBe(true);
    expect(canSee(v, { topic: "download.done", data: { id: "d1" } })).toBe(true);
    expect(canSee(viewerOf({ scopes: ["read"], accounts: "*" }), { topic: "order.updated", data: { accountId: "anything" } })).toBe(true);
    expect(canSee(v, { topic: "tick", data: {} })).toBe(false);
  });
});
