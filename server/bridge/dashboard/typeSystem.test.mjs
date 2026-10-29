/**
 * The Mr. Chartist type system (docs/theme/TYPE-SYSTEM.md): only the three Chartist fonts, self-hosted, renamed and
 * licensed. Reads files as text only: no DOM, no server.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(resolve(here, f), "utf8");
const sources = readdirSync(here)
  .filter((f) => /\.(css|js|html)$/.test(f) && !f.endsWith(".min.js"))
  .map((f) => [f, read(f)]);

const ALLOWED = new Set(["Chartist Sans", "Chartist Sans Flex", "Chartist Serif", "Chartist Sans Flex Fallback", "Chartist Sans Fallback", "system-ui", "sans-serif", "serif", "Georgia", "inherit"]);

describe("type system", () => {
  it("names only the Chartist families (and their fallbacks) anywhere", () => {
    const bad = [];
    for (const [f, s] of sources) {
      for (const m of s.matchAll(/(?:font-family\s*:|--font-[a-z-]+\s*:)\s*([^;}{]+)/g)) {
        for (const fam of m[1].split(",").map((x) => x.trim().replace(/^['"]|['"]$/g, ""))) {
          if (fam && !fam.startsWith("var(") && !ALLOWED.has(fam)) bad.push(`${f}: ${fam}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("loads fonts only from the Bridge, never from Google Fonts", () => {
    for (const [f, s] of sources) expect(s, f).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    const urls = [...read("app.css").matchAll(/url\("([^"]+\.woff2)"\)/g)].map((m) => m[1]);
    expect(urls.sort()).toEqual(["/dashboard/font-chartist-sans-flex-symbols.woff2", "/dashboard/font-chartist-sans-flex.woff2", "/dashboard/font-chartist-sans.woff2", "/dashboard/font-chartist-serif-italic.woff2"]);
  });

  it("caps every face at 600 and never fakes a bolder weight", () => {
    const css = read("app.css");
    for (const m of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
      const w = /font-weight:\s*([0-9]+)(?:\s+([0-9]+))?/.exec(m[1]);
      if (w) expect(Number(w[2] ?? w[1]), m[1]).toBeLessThanOrEqual(600);
    }
    expect(css).toMatch(/font-synthesis-weight:\s*none/);
  });

  it("never turns on the slashed zero", () => {
    for (const [f, s] of sources) expect(s, f).not.toMatch(/slashed-zero|["']zero["']\s*1/);
  });

  it("preloads the text and heading fonts", () => {
    const html = read("index.html");
    expect(html).toContain('href="/dashboard/font-chartist-sans-flex.woff2" as="font"');
    expect(html).toContain('href="/dashboard/font-chartist-sans.woff2" as="font"');
  });

  it("ships each font with its OFL and the Chartist licence file", () => {
    const files = readdirSync(resolve(here, "fonts"));
    for (const f of ["OFL-ChartistSansFlex.txt", "OFL-ChartistSansFlexSymbols.txt", "OFL-ChartistSans.txt", "OFL-ChartistSerif.txt", "LICENSE.md"]) expect(files).toContain(f);
    expect(files.filter((f) => f.endsWith(".woff2")).sort()).toEqual(["chartist-sans-flex-symbols.woff2", "chartist-sans-flex.woff2", "chartist-sans.woff2", "chartist-serif-italic.woff2"]);
  });
});
