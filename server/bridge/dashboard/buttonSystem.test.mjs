/**
 * The button system: six intents, no outer focus
 * ring, nothing moves on hover. Reads files as text only: no DOM, no server.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(resolve(here, f), "utf8");
const css = read("app.css");
const palette = read("palette.css");
const jsFiles = readdirSync(here).filter((f) => f.endsWith(".js") && !f.endsWith(".min.js"));

/** Every innermost rule: { selector, body, media } (media = the enclosing @-rule preludes, or ""). */
function rules(text) {
  const t = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "{") {
      stack.push({ prelude: t.slice(start, i).trim(), at: i });
      start = i + 1;
    } else if (t[i] === "}") {
      const open = stack.pop();
      if (!open) continue;
      const body = t.slice(open.at + 1, i);
      if (!body.includes("{") && !open.prelude.startsWith("@")) {
        const media = stack.filter((s) => s.prelude.startsWith("@")).map((s) => s.prelude).join(" ");
        out.push({ selector: open.prelude, body, media });
      }
      start = i + 1;
    } else if (t[i] === ";" && !stack.length) start = i + 1;
  }
  return out;
}
/** Split on the commas (or combinators) that are not inside parentheses or brackets. */
function splitTop(s, at) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (depth === 0 && at.test(c)) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
/** The compound a selector styles: what follows its last combinator. */
const subject = (part) => splitTop(part, /[\s>+~]/).pop() ?? "";
/** A pressable thing of the button system: <button>, .btn, an icon or chip button (.…-btn), or a tab. */
const BUTTONISH = /(^|[^\w-])button\b|\.btn\b|\.[\w-]+-btn\b|\[role="?(button|tab)"?\]/;
/** The selector parts of a rule that style a button itself (not a pseudo-element, not a descendant of one). */
const positive = (s) => s.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "");
const buttonParts = (r) => splitTop(r.selector, /,/).filter((p) => !p.includes("::") && BUTTONISH.test(positive(subject(p))));
const all = rules(css + palette).filter((r) => !r.media.includes("forced-colors"));
// Rows and cards pressable as a whole (a screener card, a menu row) are list and card styling, not buttons: their
// leading edge may carry the row's side or tone, as a table row's does.
const ROWS = /\b(list-row|menu-item)\b/;
const buttonRules = all.filter((r) => buttonParts(r).length && !buttonParts(r).every((p) => ROWS.test(p)));
const decls = (body, prop) => [...body.matchAll(new RegExp(`(?:^|[;\\s{])(${prop})\\s*:\\s*([^;]+)`, "g"))].map((m) => [m[1], m[2].trim()]);

// The six intents draw with these tokens only: the ink and the paper (--btn-*), the selection pair, the neutral
// materials (fills, glass, separators: quiet hovers and glass), and pure white or black light laid on top.
const ALLOWED_VARS = /^--(btn-[\w-]+|sel-(bg|fg)|mat-(fill-\d|glass(-strong)?|separator|hairline|grouped(-solid)?|thick)|surface-[\w-]+|seg-track|hl|fin|foreground|background|card|shadow-\d|spec-top|tick-mask|chev-mask)$/;
/** The colours in a value that are not one of the six intents (an empty list is a pass). */
function strayColours(value) {
  const bad = [];
  for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) if (!ALLOWED_VARS.test(m[1])) bad.push(m[1]);
  for (const m of value.matchAll(/#[0-9a-f]{3,8}\b|\brgba?\(|\b(?:white|black|red|green|blue|orange|yellow|gr[ae]y|purple|pink)\b/gi)) bad.push(m[0]);
  for (const m of value.matchAll(/hsla?\(\s*([^)/]+)/g)) if (!m[1].trim().startsWith("var(") && !/^0\s+0%\s+(0|100)%$/.test(m[1].trim())) bad.push(m[0]);
  return bad;
}

describe("button system: six intents, nothing else", () => {
  it("finds the button rules", () => expect(buttonRules.length).toBeGreaterThan(50));
  it("no button background or edge outside the six intents (no blue, tint, warn or call / put fill)", () => {
    const bad = [];
    for (const r of buttonRules) {
      for (const [p, v] of decls(r.body, "background(?:-color|-image)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|box-shadow|outline-color")) {
        // A buy or sell button draws in the gain or loss colour: through its own tokens only.
        for (const c of strayColours(v)) bad.push(`${r.selector.replace(/\s+/g, " ")} → ${p}: ${c}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("one central rule draws the fill: the ink, the paper, buy and sell", () => {
    const base = all.find((r) => r.selector === "button, .btn");
    expect(base?.body).toMatch(/background-color:\s*var\(--btn-bg\)/);
    expect(base?.body).toMatch(/color:\s*var\(--btn-fg\)/);
    expect(css).toMatch(/\.btn\.buy\s*{\s*--btn-bg:\s*hsl\(var\(--btn-buy\)\)/);
    expect(css).toMatch(/\.btn\.sell\s*{\s*--btn-bg:\s*hsl\(var\(--btn-sell\)\)/);
  });
  it("no page asks for a tinted or danger button", () => {
    const bad = jsFiles.flatMap((f) => read(f).split("\n").map((l, i) => [f, i + 1, l]).filter(([, , l]) => /class:\s*["'`][^"'`]*["'`\s](tinted|danger(-plain)?)["'`\s]|className\s*=\s*[^;]*"danger"|cls:\s*"(danger|tinted)"|, "tinted"\)/.test(l)).map(([f, n]) => `${f}:${n}`));
    expect(bad).toEqual([]);
    expect(css).not.toMatch(/button\.(tinted|danger)\b/);
  });
});

describe("button system: focus is a ring inside the shape", () => {
  it("draws the ring in the button's own ink, inside (negative offset)", () => {
    const ring = all.find((r) => /^:where\(button, \.btn\):focus-visible$/.test(r.selector));
    expect(ring?.body).toMatch(/outline:\s*2px solid currentColor/);
    expect(Number(ring?.body.match(/outline-offset:\s*(-?[\d.]+)px/)?.[1])).toBeLessThan(0);
  });
  it("no button rule draws an outer focus ring (outline-offset above 0, or a spread shadow)", () => {
    const bad = [];
    for (const r of buttonRules.filter((x) => buttonParts(x).some((p) => /:focus/.test(p)))) {
      for (const [, v] of decls(r.body, "outline-offset")) if (parseFloat(v) > 0) bad.push(`${r.selector} → outline-offset: ${v}`);
      for (const [, v] of decls(r.body, "box-shadow")) for (const s of splitTop(v, /,/)) if (!/\binset\b/.test(s) && /^0\s+0\s+0\s+[1-9]/.test(s)) bad.push(`${r.selector} → box-shadow: ${s}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("button system: hover fades, nothing moves", () => {
  it("no hover rule on a button translates it or scales it up", () => {
    const bad = [];
    for (const r of buttonRules.filter((x) => buttonParts(x).some((p) => /:hover/.test(p)))) {
      for (const [p, v] of decls(r.body, "transform|translate|scale")) {
        if (p === "translate" && !/^(0|none)(px)?(\s+0(px)?)?$/.test(v)) bad.push(`${r.selector} → translate: ${v}`);
        if (p === "scale" && v.split(/\s+/).some((n) => parseFloat(n) > 1)) bad.push(`${r.selector} → scale: ${v}`);
        if (p === "transform" && /translate/.test(v) && !/translate[XY3d]*\(\s*0(px)?\s*(,\s*0(px)?\s*)*\)/.test(v)) bad.push(`${r.selector} → transform: ${v}`);
        if (p === "transform") for (const m of v.matchAll(/scale[XY]?\(\s*([\d.]+)/g)) if (Number(m[1]) > 1) bad.push(`${r.selector} → transform: ${v}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("has one press animation: CSS settles and springs back, motion.js no longer presses buttons", () => {
    expect(css).toMatch(/:where\(button, \.btn, \.tab\):active:not\(:disabled\)[^{]*{\s*scale:\s*var\(--press/);
    expect(read("motion.js")).not.toMatch(/export function (pressFeedback|installPressFeedback)/);
    expect(read("app.js")).not.toMatch(/installPressFeedback/);
  });
});
