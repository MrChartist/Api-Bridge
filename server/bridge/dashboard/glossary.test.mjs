/**
 * The glossary: every definition is one or two short plain sentences, every word is found where it is used and not
 * where it is only an everyday word.
 */
import { describe, expect, it } from "vitest";
import { GLOSSARY, glossLabel, glossaryEntry, termsIn } from "./glossary.js";

// A plain Flesch-Kincaid grade, enough to keep the definitions honest.
const syl = (w) => {
  w = w.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return w ? 1 : 0;
  const m = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
};
const grade = (text) => {
  const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  const sentences = Math.max(1, (text.match(/[.!?](\s|$)/g) ?? []).length);
  return 0.39 * (words.length / sentences) + 11.8 * (words.reduce((n, w) => n + syl(w), 0) / words.length) - 15.59;
};

describe("glossary", () => {
  it("has unique ids and a definition for each", () => {
    expect(new Set(GLOSSARY.map((g) => g.id)).size).toBe(GLOSSARY.length);
    for (const g of GLOSSARY) {
      expect(g.term.length, g.id).toBeGreaterThan(1);
      expect(g.text.endsWith("."), g.id).toBe(true);
    }
  });

  it("defines each word in one or two short sentences at grade 8 or lower", () => {
    for (const g of GLOSSARY) {
      const words = g.text.split(/\s+/).length;
      const sentences = (g.text.match(/[.!?](\s|$)/g) ?? []).length;
      expect(sentences, g.id).toBeLessThanOrEqual(2);
      expect(words, `${g.id}: ${words} words`).toBeLessThanOrEqual(28);
      // The grade formula is meaningless for a five-word line; the length cap is the rule there.
      if (words > 8) expect(grade(g.text), `${g.id}: ${g.text}`).toBeLessThanOrEqual(8);
    }
  });

  it("covers the jargon the pages use", () => {
    const ids = GLOSSARY.map((g) => g.id);
    for (const id of ["quota", "burst", "pooling", "scope", "fingerprint", "endpoint", "token", "websocket", "mcp", "webhook", "oauth", "killswitch", "staticip"]) expect(ids).toContain(id);
  });

  it("finds a word where it is used", () => {
    expect(termsIn("Every API key has its own quota.")).toEqual(["quota"]);
    expect(termsIn("The MCP server and a webhook")).toEqual(["mcp", "webhook"]);
    expect(termsIn("Set sources.autoFallback to true")).toEqual([]);
    expect(termsIn("Pooling lets your accounts share the work")).toEqual(["pooling"]);
    expect(termsIn("The kill switch is off")).toEqual(["killswitch"]);
    expect(termsIn("Prices are delayed 15 min")).toEqual(["delayed"]);
  });

  it("does not trigger on everyday words that only look similar", () => {
    expect(termsIn("Pool your brokers")).toEqual([]);
    expect(termsIn("The rest of the day")).toEqual([]);
    expect(termsIn("Open the bridge in a mode you like")).toEqual([]);
    expect(termsIn("bridge.config.json")).toEqual([]);
    expect(termsIn("Send it as JSON")).toEqual(["json"]);
  });

  it("names its button for a screen reader", () => {
    expect(glossLabel(glossaryEntry("quota"))).toBe("What does “Quota” mean?");
    expect(glossaryEntry("nope")).toBeNull();
  });
});
