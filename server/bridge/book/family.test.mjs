import { mkdtempSync, readdirSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOOK_CONFIG_SCHEMA, bookConfig } from "./config.mjs";
import { automationAllowed, holderList, holderOf, inFamily, relationshipOf, tagOf } from "./family.mjs";
import { createHolderStore, holdersFile, loadHolderTags } from "./holderStore.mjs";

// §7.12 worked example: four accounts, three holders tagged in holders.json.
const CONFIG = {
  accounts: [
    { id: "zerodha-main", broker: "zerodha" },
    { id: "upstox-asha", broker: "upstox", holder: "spouse" },
    { id: "dhan-friend", broker: "dhan", holder: "friend" },
    { id: "angel-huf", broker: "angelone", holder: "rk-huf" },
    { id: "kite-mum", broker: "zerodha", holder: "mum" },
  ],
};
const TAGS = { spouse: { relationship: "spouse", label: "Asha" }, friend: { relationship: "other" }, "rk-huf": { relationship: "huf", label: "RK HUF" } };

describe("family gate (§7.12)", () => {
  it("the worked table", () => {
    expect(automationAllowed(CONFIG, TAGS, "zerodha-main")).toEqual({ ok: true, code: null, reason: null, holder: "self", relationship: "self" });
    expect(automationAllowed(CONFIG, TAGS, "upstox-asha")).toMatchObject({ ok: true, holder: "spouse", relationship: "spouse" });
    const friend = automationAllowed(CONFIG, TAGS, "dhan-friend");
    expect(friend).toMatchObject({ ok: false, code: "AUTOMATION_NOT_ALLOWED", holder: "friend", relationship: "other" });
    expect(friend.reason).toBe("Holder 'friend' is tagged 'other', which is outside the family definition (book.family.relationships).");
  });

  it("HUF is a tag but outside the default family (OQ1)", () => {
    expect(automationAllowed(CONFIG, TAGS, "angel-huf")).toMatchObject({ ok: false, code: "AUTOMATION_NOT_ALLOWED", relationship: "huf" });
    const withHuf = { ...CONFIG, book: { family: { relationships: ["self", "spouse", "huf"] } } };
    expect(automationAllowed(withHuf, TAGS, "angel-huf").ok).toBe(true);
  });

  it("a holder with no tag is refused with the fix in the reason", () => {
    const r = automationAllowed(CONFIG, TAGS, "kite-mum");
    expect(r).toMatchObject({ ok: false, code: "AUTOMATION_NOT_ALLOWED", holder: "mum", relationship: null });
    expect(r.reason).toBe("Holder 'mum' has no relationship tag. Set it on the Accounts page.");
  });

  it("the untagged default: no holder counts as book.untaggedHolder, which is self", () => {
    expect(holderOf(CONFIG, "zerodha-main")).toBe("self");
    expect(tagOf(CONFIG, {}, "self")).toEqual({ relationship: "self", label: null, source: "default" });
    const other = { ...CONFIG, book: { untaggedHolder: "me" } };
    expect(holderOf(other, "zerodha-main")).toBe("me");
    expect(automationAllowed(other, {}, "zerodha-main")).toMatchObject({ ok: true, holder: "me", relationship: "self" });
  });

  it("a config lock beats the file", () => {
    const locked = { ...CONFIG, book: { holders: { friend: { relationship: "spouse", label: "Locked" } } } };
    expect(tagOf(locked, TAGS, "friend")).toEqual({ relationship: "spouse", label: "Locked", source: "config" });
    expect(automationAllowed(locked, TAGS, "dhan-friend").ok).toBe(true);
    // And the file cannot loosen a config lock that says "other".
    const lockedOut = { ...CONFIG, book: { holders: { spouse: { relationship: "other" } } } };
    expect(automationAllowed(lockedOut, TAGS, "upstox-asha").ok).toBe(false);
  });

  it("an unknown account is refused, never allowed", () => {
    expect(automationAllowed(CONFIG, TAGS, "nope")).toMatchObject({ ok: false, code: "ACCOUNT_NOT_FOUND" });
  });

  it("inFamily and relationshipOf", () => {
    expect(inFamily(CONFIG, "dependent-parent")).toBe(true);
    expect(inFamily(CONFIG, "other")).toBe(false);
    expect(inFamily(CONFIG, null)).toBe(false);
    expect(relationshipOf(CONFIG, TAGS, "spouse")).toBe("spouse");
  });

  it("holderList groups accounts per holder with family membership", () => {
    const list = holderList(CONFIG, TAGS);
    expect(list.map((h) => [h.holder, h.relationship, h.inFamily, h.accounts])).toEqual([
      ["self", "self", true, ["zerodha-main"]],
      ["spouse", "spouse", true, ["upstox-asha"]],
      ["friend", "other", false, ["dhan-friend"]],
      ["rk-huf", "huf", false, ["angel-huf"]],
      ["mum", null, false, ["kite-mum"]],
    ]);
    expect(list[0].label).toBe("Me");
    expect(list[1].label).toBe("Asha");
  });

  it("config schema: defaults, strict, closed relationship list", () => {
    const d = bookConfig({});
    expect(d.family.relationships).toEqual(["self", "spouse", "dependent-child", "dependent-parent"]);
    expect(d.untaggedHolder).toBe("self");
    expect(d.cacheSeconds).toBe(10);
    expect(BOOK_CONFIG_SCHEMA.safeParse({ nope: 1 }).success).toBe(false);
    expect(BOOK_CONFIG_SCHEMA.safeParse({ holders: { x: { relationship: "cousin" } } }).success).toBe(false);
  });
});

describe("holder store", () => {
  const paths = () => ({ dataDir: mkdtempSync(join(tmpdir(), "mcb-book-")) });

  it("reads empty, writes atomically (0600 in a 0700 folder) and re-reads after a change", () => {
    const p = paths();
    expect(loadHolderTags(p)).toEqual({});
    const store = createHolderStore({ paths: p, clock: { now: () => Date.UTC(2026, 9, 29, 5, 0) } });
    const doc = store.set("spouse", { relationship: "spouse", label: "Asha" }, "local");
    expect(doc.holders).toEqual({ spouse: { relationship: "spouse", label: "Asha" } });
    expect(doc.updatedAt).toBe("2026-10-29T10:30:00.000+05:30");
    expect(loadHolderTags(p)).toEqual({ spouse: { relationship: "spouse", label: "Asha" } });
    if (process.platform !== "win32") {
      expect(statSync(holdersFile(p)).mode & 0o777).toBe(0o600);
    }
    store.set("spouse", null);
    expect(loadHolderTags(p)).toEqual({});
  });

  it("demo tags live in book-demo/, never mixed with the real file", () => {
    const p = paths();
    createHolderStore({ paths: p, demo: true }).set("demo-spouse", { relationship: "spouse" });
    expect(loadHolderTags(p)).toEqual({});
    expect(loadHolderTags(p, { demo: true })).toEqual({ "demo-spouse": { relationship: "spouse" } });
  });

  it("a corrupt file is quarantined and read as empty; bad rows are dropped", () => {
    const p = paths();
    const f = holdersFile(p);
    mkdirSync(join(p.dataDir, "book"), { recursive: true });
    writeFileSync(f, "{ not json");
    expect(loadHolderTags(p)).toEqual({});
    expect(readdirSync(join(p.dataDir, "book")).some((n) => n.startsWith("holders.json.corrupt-"))).toBe(true);
    writeFileSync(f, JSON.stringify({ version: 1, holders: { ok: { relationship: "spouse" }, bad: { relationship: "cousin" }, "b/ad": { relationship: "self" } } }));
    expect(loadHolderTags(p)).toEqual({ ok: { relationship: "spouse" } });
  });
});
