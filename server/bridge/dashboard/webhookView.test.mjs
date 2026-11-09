/**
 * The pure parts of the webhook panel: the final address, the plain-words outcomes, the quiet-hook hint and the
 * TradingView messages. No DOM, no server.
 */
import { describe, expect, it } from "vitest";
import { alertTemplates } from "../hooks/templates.mjs";
import { countsLine, finalHookUrl, outcomeView, silentHint, snippets, tradingViewAlert } from "./snippets.js";

const PATH = "/hooks/tradingview/abc";
const LOCAL = "http://127.0.0.1:4300/hooks/tradingview/abc";

describe("finalHookUrl", () => {
  it("puts the secret path on the public address, whatever trailing slash was typed", () => {
    expect(finalHookUrl({ path: PATH, localUrl: LOCAL, publicBase: "https://alerts.example.com" })).toEqual({ url: "https://alerts.example.com/hooks/tradingview/abc", isPublic: true, problem: null });
    expect(finalHookUrl({ path: PATH, localUrl: LOCAL, publicBase: "  https://alerts.example.com/ " }).url).toBe("https://alerts.example.com/hooks/tradingview/abc");
    expect(finalHookUrl({ path: PATH, localUrl: LOCAL, publicBase: "https://alerts.example.com:443" }).problem).toBeNull();
  });

  it("falls back to the local address (which only works on this computer) without one", () => {
    expect(finalHookUrl({ path: PATH, localUrl: LOCAL, publicBase: "" })).toEqual({ url: LOCAL, isPublic: false, problem: null });
    expect(finalHookUrl({ path: PATH, publicBase: undefined }).url).toBe(PATH);
  });

  it("says what is wrong with an address that cannot work", () => {
    expect(finalHookUrl({ path: PATH, localUrl: LOCAL, publicBase: "alerts.example.com" }).problem).toMatch(/https:\/\/your-name/);
    expect(finalHookUrl({ path: PATH, localUrl: LOCAL, publicBase: "https://alerts.example.com/hooks" }).isPublic).toBe(false);
    expect(finalHookUrl({ path: PATH, localUrl: LOCAL, publicBase: "http://127.0.0.1:4301" })).toMatchObject({ isPublic: false, url: LOCAL });
    expect(finalHookUrl({ path: PATH, localUrl: LOCAL, publicBase: "http://localhost" }).problem).toMatch(/only works on this computer/);
    expect(finalHookUrl({ path: PATH, localUrl: LOCAL, publicBase: "https://alerts.example.com:8443" })).toMatchObject({ isPublic: true, problem: expect.stringMatching(/port 80 or 443/) });
  });
});

describe("outcome words and counts", () => {
  it("gives every outcome a short word and a tone, and an unknown one a safe default", () => {
    const outcomes = ["placed", "queued", "processing", "awaiting_confirmation", "duplicate", "stale", "refused", "rejected", "failed", "outcome_unknown", "dropped"];
    for (const o of outcomes) expect(outcomeView({ outcome: o, summary: "x" }).word.length).toBeGreaterThan(2);
    expect(outcomeView({ outcome: "placed" })).toMatchObject({ word: "Placed", tone: "ok" });
    expect(outcomeView({ outcome: "stale" }).tone).toBe("warn");
    expect(outcomeView({ outcome: "rejected", reason: "No." })).toEqual({ word: "Not placed", tone: "bad", text: "No." });
    expect(outcomeView({ outcome: "something new" }).word).toBe("Unknown");
    expect(outcomeView(undefined).word).toBe("Unknown");
  });

  it("writes the counts as one plain line", () => {
    expect(countsLine({ placed: 3, rejected: 1, authFailed: 2, duplicate: 1, badRequest: 1, stale: 1 })).toBe("3 placed, 1 repeat, 1 not placed, 1 too old, 1 unreadable, 2 wrong passphrases");
    expect(countsLine({})).toBe("");
    expect(countsLine({ authFailed: 1 })).toBe("1 wrong passphrase");
  });
});

describe("silentHint", () => {
  const now = Date.parse("2026-11-09T12:00:00+05:30");
  const iso = (ms) => new Date(ms).toISOString();
  it("a brand-new hook is told to send a test alert", () => {
    const r = silentHint({ lastSignalAt: null, createdAt: iso(now - 60_000) }, now);
    expect(r).toMatchObject({ state: "new", text: "No alert received yet" });
    expect(r.hint).toMatch(/test alert/);
  });

  it("a hook that never heard anything for a while is flagged and told where to look", () => {
    const r = silentHint({ lastSignalAt: null, createdAt: iso(now - 3 * 3_600_000) }, now);
    expect(r).toMatchObject({ state: "never", tone: "warn" });
    expect(r.text).toMatch(/3 hours ago/);
    expect(r.hint).toMatch(/Webhook URL.*tunnel/);
  });

  it("a recent alert says how long ago, and a long silence is flagged", () => {
    expect(silentHint({ lastSignalAt: iso(now - 5 * 60_000), createdAt: iso(now - 9e9) }, now)).toMatchObject({ state: "recent", text: "Last alert 5 minutes ago", hint: null });
    expect(silentHint({ lastSignalAt: iso(now - 30_000), createdAt: null }, now).text).toBe("Last alert just now");
    const quiet = silentHint({ lastSignalAt: iso(now - 5 * 86_400_000), createdAt: iso(now - 9e9) }, now);
    expect(quiet).toMatchObject({ state: "quiet", tone: "warn", text: "Quiet for 5 days" });
    expect(quiet.hint).toMatch(/alert in TradingView/);
  });
});

describe("TradingView messages", () => {
  it("the dashboard snippet and the server template are the same message", () => {
    const server = alertTemplates({ source: "tradingview", orderType: "LIMIT", maxLotsPerSignal: 1, mode: "paper", maxAgeSec: 120, product: null, side: null }, { passphrase: "PP" });
    expect(tradingViewAlert({ passphrase: "PP" })).toBe(server[0].message);
    expect(tradingViewAlert({ strategy: true, passphrase: "PP" })).toBe(server[1].message);
  });

  it("is listed first in the webhook snippets, with the placeholder passphrase", () => {
    const s = snippets({ base: "http://127.0.0.1:4300" }).webhooks;
    expect(s[0].title).toMatch(/TradingView.*plain alert/);
    expect(s[0].code).toContain("YOUR_PASSPHRASE");
    expect(s[1].code).toContain("{{strategy.order.action}}");
    expect(s[0].code).toContain('"time": "{{timenow}}"');
  });
});
