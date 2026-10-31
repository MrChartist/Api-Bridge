import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAIN_KEYS, GLOSSARY, SHORTCUT_GROUPS, filterGlossary, filterShortcuts, groupShortcuts, shortcutRegistry } from "./shortcuts-core.js";
import { findBanned } from "./copyRules.mjs";

const reg = shortcutRegistry({ mod: "Ctrl", pages: [{ label: "Home", key: 1 }, { label: "Option Chain", key: 2 }, { label: "No key" }], goKeys: [{ keys: "c", label: "Option Chain" }, { keys: "sn", label: "Scanner" }] });

describe("shortcut registry", () => {
  it("has unique ids, known groups and something to say for every entry", () => {
    expect(new Set(reg.map((e) => e.id)).size).toBe(reg.length);
    for (const e of reg) {
      expect(SHORTCUT_GROUPS).toContain(e.group);
      expect(e.keys.length).toBeGreaterThan(0);
      expect(e.what.length).toBeGreaterThan(3);
    }
  });
  it("lists the app-wide keys, the page keys and the go-keys", () => {
    const whats = reg.map((e) => `${e.keys.join("|")} ${e.what}`);
    expect(whats).toContain("Ctrl K Search pages and actions");
    expect(whats).toContain("Ctrl 2 Go to Option Chain");
    expect(whats).toContain("g|s|n Go to Scanner");
    expect(reg.some((e) => e.group === "Trading" && e.keys[0] === "Ctrl Alt 1")).toBe(true);
    expect(reg.filter((e) => e.what === "Go to No key")).toEqual([]);
  });
  it("has every chain key but the chain's own ?, and no clash inside the chain group", () => {
    const chain = reg.filter((e) => e.group === "Option Chain");
    expect(chain.length).toBe(CHAIN_KEYS.length - 1);
    const seen = new Set();
    for (const e of chain) for (const k of e.keys) {
      expect(seen.has(k), k).toBe(false);
      seen.add(k);
    }
  });
  it("Shift+B / Shift+S trade the focused contract on the chain; strategy legs moved to + and −", () => {
    const sb = CHAIN_KEYS.find(([k]) => k[0] === "⇧B");
    expect(sb[2]).toMatch(/1-Tap/);
    expect(CHAIN_KEYS.find(([k]) => k[0] === "+")[2]).toMatch(/leg to the strategy/);
  });
  it("swaps the modifier on a Mac", () => {
    expect(shortcutRegistry({ mod: "⌘" }).find((e) => e.what === "Search pages and actions").keys).toEqual(["⌘ K"]);
    expect(shortcutRegistry({ mod: "⌘" }).find((e) => e.what === "Save this strategy").keys).toEqual(["⌘ S"]);
  });
  it("lists the chart and workspace keys as real", () => {
    expect(reg.some((e) => e.coming)).toBe(false);
    expect(reg.filter((e) => e.group === "Charts").map((e) => e.keys[0]).slice(0, 4)).toEqual(["Alt T", "Alt H", "Alt F", "/"]);
    expect(reg.filter((e) => e.group === "Workspaces").map((e) => e.keys[0])).toEqual(["⇧1–⇧6", "Ctrl Alt L"]);
  });
  it("matches the positions page's own key list", () => {
    const src = readFileSync(new URL("./positions.js", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("export const POSITION_KEYS"), src.indexOf("];", src.indexOf("export const POSITION_KEYS")));
    const keys = [...block.matchAll(/^\s*\[\[(.*?)\], "/gm)].map((m) => m[1]);
    const ours = reg.filter((e) => e.group === "Positions").map((e) => e.keys.map((k) => JSON.stringify(k)).join(", "));
    for (const k of keys.filter((x) => x !== '"?"')) expect(ours, k).toContain(k);
  });
});

describe("search and grouping", () => {
  it("finds by words, keys and Shift spelled either way", () => {
    expect(filterShortcuts(reg, "")).toBe(reg);
    expect(filterShortcuts(reg, "expiry").every((e) => /expiry/i.test(`${e.what} ${e.group}`))).toBe(true);
    const sb = filterShortcuts(reg, "shift b");
    expect(sb.some((e) => e.group === "Trading")).toBe(true);
    expect(filterShortcuts(reg, "⇧B").length).toBe(sb.length);
    expect(filterShortcuts(reg, "ctrl k").some((e) => e.what === "Search pages and actions")).toBe(true);
    expect(filterShortcuts(reg, "zzzz")).toEqual([]);
  });
  it("groups in the sheet's order and drops empty groups", () => {
    const g = groupShortcuts(filterShortcuts(reg, "1-tap"));
    expect(g.map((x) => x.group)).toEqual(["Trading", "Option Chain", "Positions"]);
    expect(groupShortcuts([])).toEqual([]);
  });
});

describe("glossary", () => {
  it("has unique terms and plain meanings, no advice words beyond order sides", () => {
    expect(new Set(GLOSSARY.map(([t]) => t)).size).toBe(GLOSSARY.length);
    const advice = /^(recommend|best|rich|cheap|safe|avoid|opportunit|signal|bullish|bearish|support|resistance)/i;
    for (const [t, m] of GLOSSARY) for (const w of findBanned(`${t} ${m}`)) expect(advice.test(w.word), `${t}: ${w.word}`).toBe(false);
  });
  it("searches terms and meanings", () => {
    expect(filterGlossary("theta").map(([t]) => t)).toEqual(["Theta (θ)"]);
    expect(filterGlossary("").length).toBe(GLOSSARY.length);
    expect(filterGlossary("open interest").map(([t]) => t)).toContain("Open interest (OI)");
  });
});
