import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOC_TERMS, GLOSSARY } from "../server/bridge/dashboard/glossary.js";
import { buildGlossary, glossaryPage } from "./gen-glossary.mjs";
import { ROOT } from "./lib/repo-files.mjs";

describe("docs/guides/glossary.md", () => {
  it("is what scripts/gen-glossary.mjs writes from the dashboard glossary (run: npm run docs:generate)", () => {
    for (const [rel, text] of buildGlossary()) expect(readFileSync(join(ROOT, rel), "utf8"), rel).toBe(text);
  });

  it("has one entry per word, with no id or term in both lists", () => {
    const ids = [...GLOSSARY, ...DOC_TERMS].map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    const terms = [...GLOSSARY, ...DOC_TERMS].map((g) => g.term.toLowerCase());
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("keeps the guide-only definitions short and plain", () => {
    for (const g of DOC_TERMS) {
      const words = g.text.split(/\s+/).length;
      expect(words, g.id).toBeLessThanOrEqual(48);
      expect(g.text.endsWith("."), g.id).toBe(true);
      expect(g.text, g.id).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it("defines the words the guides lean on and the dashboard did not", () => {
    const page = glossaryPage();
    for (const w of ["Freshness", "Stale", "ATM", "Expiry", "CE and PE", "CNC", "INTRADAY", "MARGIN", "Ticket", "Cursor", "SSE", "HMAC", "Dead letter", "Dataset", "Collection", "Readiness", "Ingress", "Master key", "Control token", "Tick", "Snapshot", "Data class", "Loopback"]) {
      expect(page, w).toContain(w);
    }
  });

  it("no longer says what the audit found wrong", () => {
    const byId = Object.fromEntries(GLOSSARY.map((g) => [g.id, g]));
    // A webhook alert is not always a practice order, and outbound webhooks exist too.
    expect(byId.webhook.text).not.toMatch(/^A web address that other services send alerts to\. Each alert becomes a practice order\.$/);
    expect(byId.webhook.text).toMatch(/unless you chose live/);
    // "class" alone (an endpoint class) is not a data class, and the three classes are named.
    expect(byId.dataclass.re.test("the endpoint class")).toBe(false);
    expect(byId.dataclass.text).toMatch(/realtime/);
    expect(byId.dataclass.text).toMatch(/delayed/);
    expect(byId.dataclass.text).toMatch(/eod/);
    // A fallback source is not a file backup, and pooling says it is off by default.
    expect(byId.fallback.text).toMatch(/not a file backup/);
    expect(byId.pooling.text).toMatch(/off until you accept/);
  });

  it("is listed in the guides index", () => {
    expect(readFileSync(join(ROOT, "docs/guides/README.md"), "utf8")).toMatch(/\[glossary\.md\]\(glossary\.md\)/);
  });
});
