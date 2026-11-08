/**
 * The type system: only the three Chartist fonts, self-hosted, renamed and
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

/**
 * The string literals of a JS source (quotes and template text, nested `${…}` included), with comments and regex
 * literals skipped: the text a module can put on the page. A small scanner, enough for these hand-written modules.
 */
function stringLiterals(src) {
  const out = [];
  const stack = []; // one brace counter per open `${`
  const n = src.length;
  let i = 0;
  let prev = ""; // the last significant character, to tell a regex literal from a division
  const template = () => {
    let t = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        t += src.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        i++;
        out.push(t);
        return false;
      } else if (c === "$" && src[i + 1] === "{") {
        i += 2;
        out.push(t);
        return true;
      } else {
        t += c;
        i++;
      }
    }
    out.push(t);
    return false;
  };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let t = "";
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") {
          t += src.slice(j, j + 2);
          j += 2;
        } else t += src[j++];
      }
      out.push(t);
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "`") {
      i++;
      if (template()) stack.push(0);
      prev = "`";
      continue;
    }
    if (c === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(?:return|typeof|case|in|of|void|delete)$/.test(src.slice(Math.max(0, i - 8), i).trimEnd()))) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== "\n") {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) break;
        j++;
      }
      i = j + 1;
      prev = "/";
      continue;
    }
    if (stack.length && c === "{") stack[stack.length - 1]++;
    if (stack.length && c === "}") {
      if (stack[stack.length - 1] === 0) {
        stack.pop();
        i++;
        if (template()) stack.push(0);
        prev = "`";
        continue;
      }
      stack[stack.length - 1]--;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

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

  it("sets no text below 12px: CSS sizes, font shorthands, scale tokens, inline styles and SVG attributes", () => {
    const bad = [];
    const SIZE = [
      /font-size\s*:\s*([0-9.]+)px/g, // CSS, and a style string built in JS
      /(?<![-\w])font\s*:\s*(?:[^;{}"'`]*?\s)?([0-9.]+)px\s*(?:\/|\s|;)/g, // the font shorthand
      /--t-[a-z0-9-]+\s*:\s*[^;]*?([0-9.]+)px\s*\//g, // a step of the type scale
      /["']?font-size["']?\s*[:=]\s*["']?([0-9.]+)(?![0-9.]*(?:em|rem|%))/g, // an SVG attribute (el.setAttribute / svgEl({ "font-size": 10 }))
      /fontSize\s*[:=]\s*["']?([0-9.]+)/g, // el.style.fontSize
    ];
    for (const [f, s] of sources) {
      for (const re of SIZE) for (const m of s.matchAll(re)) if (parseFloat(m[1]) < 12) bad.push(`${f}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it("draws nothing heavier than 600 (weights, shorthands, weight tokens, bold keywords)", () => {
    const bad = [];
    for (const [f, s] of sources) {
      for (const m of s.matchAll(/(?:font-weight|fontWeight)["']?\s*[:=]\s*["']?([0-9]{3})|(?<![-\w])font\s*:\s*(?:italic\s+)?([0-9]{3})\s|--fw-[a-z]+\s*:\s*([0-9]{3})/g)) {
        if (parseInt(m[1] ?? m[2] ?? m[3], 10) > 600) bad.push(`${f}: ${m[0]}`);
      }
      for (const m of s.matchAll(/font-weight\s*:\s*(bold|bolder)\b/g)) bad.push(`${f}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it("keeps uppercase labels at 12px or more with tracking no wider than 0.02em", () => {
    const bad = [];
    for (const [f, s] of sources.filter(([f]) => f.endsWith(".css"))) {
      for (const m of s.matchAll(/([^{}]+)\{([^{}]*text-transform:\s*uppercase[^{}]*)\}/g)) {
        const ls = /letter-spacing:\s*([0-9.]+)em/.exec(m[2]);
        if (ls && parseFloat(ls[1]) > 0.02) bad.push(`${f}: ${m[1].trim()} letter-spacing ${ls[1]}em`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("puts no em dash (U+2014) in visible text: JS string literals, HTML text, CSS content", () => {
    const bad = [];
    for (const [f, s] of sources) {
      const texts = f.endsWith(".js") ? stringLiterals(s) : f.endsWith(".html") ? [s.replace(/<!--[\s\S]*?-->/g, "")] : [...s.matchAll(/content\s*:\s*("[^"]*"|'[^']*')/g)].map((m) => m[1]);
      for (const t of texts) if (t.includes("—")) bad.push(`${f}: ${t.trim().slice(0, 80)}`);
    }
    expect(bad).toEqual([]);
  });

  it("finds string literals and skips comments (the scanner the em dash check relies on)", () => {
    const src = '// a — comment\n/* block — */ const a = "x — y"; const b = `t ${"in — ner"} — end`; const r = /—"/; const c = \'z\';';
    expect(stringLiterals(src)).toEqual(["x — y", "t ", "in — ner", " — end", "z"]);
  });

  it("ships each font with its OFL and the Chartist licence file", () => {
    const files = readdirSync(resolve(here, "fonts"));
    for (const f of ["OFL-ChartistSansFlex.txt", "OFL-ChartistSansFlexSymbols.txt", "OFL-ChartistSans.txt", "OFL-ChartistSerif.txt", "LICENSE.md"]) expect(files).toContain(f);
    expect(files.filter((f) => f.endsWith(".woff2")).sort()).toEqual(["chartist-sans-flex-symbols.woff2", "chartist-sans-flex.woff2", "chartist-sans.woff2", "chartist-serif-italic.woff2"]);
  });
});
