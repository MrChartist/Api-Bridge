import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkModel, exposeModel } from "./expose-card.js";

const off = { state: "off", exposed: [], headline: "Nothing on this computer is set up to be reached from the internet.", alerts: { enabled: false }, sheets: { enabled: false }, checks: [{ level: "ok", check: "expose", message: "Nothing on this computer is set up to be reached from the internet." }], restartNote: "Restart the Bridge to apply this." };

describe("exposeModel", () => {
  it("not exposed: a neutral pill, both listeners off with the command that turns each on", () => {
    const m = exposeModel(off, "mc-bridge");
    expect(m.pill).toEqual({ text: "Not exposed", tone: "" });
    expect(m.listeners.map((l) => [l.id, l.on, l.setup])).toEqual([["alerts", false, "mc-bridge expose alerts"], ["sheets", false, "mc-bridge expose sheets"]]);
    expect(m.problems).toEqual([]);
  });

  it("on and clean: 'On' with the address pattern to copy", () => {
    const m = exposeModel({ ...off, state: "on", alerts: { enabled: true, urlPattern: "https://hooks.example.com/hooks/<source>/<token>" }, checks: [{ level: "ok", check: "expose", message: "fine" }] });
    expect(m.pill).toEqual({ text: "On", tone: "ok" });
    expect(m.listeners[0]).toMatchObject({ on: true, address: "https://hooks.example.com/hooks/<source>/<token>", copy: "https://hooks.example.com/hooks/<source>/<token>" });
  });

  it("a listener with no host yet says so and has nothing to copy", () => {
    const m = exposeModel({ ...off, state: "on", alerts: { enabled: true, urlPattern: undefined } });
    expect(m.listeners[0]).toMatchObject({ address: "No public address set yet", copy: null });
  });

  it("warnings give 'Check'; a blocking one gives 'Unsafe'; each problem keeps its fix", () => {
    const warn = exposeModel({ ...off, state: "on", alerts: { enabled: true }, checks: [{ level: "warn", check: "expose-allowlist", message: "No allowlist.", fix: "Run mc-bridge expose alerts." }] });
    expect(warn.pill).toEqual({ text: "Check", tone: "warn" });
    expect(warn.problems).toEqual([{ message: "No allowlist.", fix: "Run mc-bridge expose alerts.", blocking: false }]);
    const bad = exposeModel({ ...off, state: "on", alerts: { enabled: true }, checks: [{ level: "warn", check: "x", message: "Open.", fix: "Close it.", blocking: true }] });
    expect(bad.pill).toEqual({ text: "Unsafe", tone: "bad" });
  });

  it("survives a missing or empty answer", () => {
    expect(exposeModel(null).pill.text).toBe("Not exposed");
    expect(exposeModel({}).listeners).toHaveLength(2);
  });
});

describe("checkModel", () => {
  it("words and tones for each status, and the verdict tone", () => {
    const m = checkModel({ verdict: "unsafe", headline: "Unsafe: turn the tunnel off.", items: [{ title: "a", detail: "d", status: "pass" }, { title: "b", detail: "d", fix: "f", status: "fail" }, { title: "c", detail: "d", status: "warn" }, { title: "d", detail: "d", status: "skipped" }] });
    expect(m.tone).toBe("bad");
    expect(m.rows.map((r) => [r.word, r.tone])).toEqual([["OK", "ok"], ["Failing", "bad"], ["Note", "warn"], ["Skipped", ""]]);
    expect(m.rows[1].fix).toBe("f");
    expect(checkModel({ verdict: "good", items: [] }).tone).toBe("ok");
    expect(checkModel({ verdict: "notes", items: [] }).tone).toBe("warn");
  });
});

describe("the card's copy", () => {
  const src = readFileSync(resolve(import.meta.dirname, "expose-card.js"), "utf8");
  it("loads nothing from another site and calls only this Bridge's two routes", () => {
    expect(src).not.toMatch(/https?:\/\/(?!github\.com)/);
    expect(src.match(/api\("([^"]+)"/g)).toEqual(['api("/v1/expose/check"', 'api("/v1/expose"']);
  });
  it("never sends allowOutbound (the dashboard tests only this computer)", () => {
    expect(src).not.toMatch(/allowOutbound|publicUrl/);
  });
});
