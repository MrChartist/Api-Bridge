/**
 * Static checks for the Options polish (docs/prd/08-responsive-polish.md §10.1) and the global theme foundation
 * (docs/design/foundation.md §11). They read files as text only: no DOM, no server.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(resolve(here, f), "utf8");
const css = read("app.css");
const palette = read("palette.css");
const html = read("index.html");
const jsFiles = readdirSync(here).filter((f) => f.endsWith(".js") && !f.endsWith(".min.js"));

/** The text between two section headers of app.css. */
function section(from, to) {
  const a = css.indexOf(from);
  const b = css.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`section ${from} … ${to} not found`);
  return css.slice(a, b);
}
/** The Options sections, 12b … 12z (they end where 13 · RESPONSIVE starts). */
const optionsCss = section("12b · OPTION DESK", "13 · RESPONSIVE");
/** Drop @media (forced-colors …) { … } blocks (balanced braces). */
function withoutForcedColors(text) {
  let out = "";
  let i = 0;
  for (;;) {
    const j = text.indexOf("@media (forced-colors", i);
    if (j < 0) return out + text.slice(i);
    out += text.slice(i, j);
    let k = text.indexOf("{", j);
    let depth = 0;
    for (; k < text.length; k++) {
      if (text[k] === "{") depth++;
      else if (text[k] === "}" && --depth === 0) break;
    }
    i = k + 1;
  }
}
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "");
/** Every innermost rule: { selector, body, media } (media = the enclosing @media prelude, or ""). */
function rules(text) {
  const t = stripComments(text);
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
        const media = stack.filter((s) => s.prelude.startsWith("@media")).map((s) => s.prelude).join(" ");
        out.push({ selector: open.prelude, body, media });
      }
      start = i + 1;
    } else if (t[i] === ";" && !stack.length) start = i + 1;
  }
  return out;
}
/** The body of the first rule whose selector is exactly `sel` inside `text`. */
function block(text, sel) {
  const i = text.indexOf(`${sel} {`);
  if (i < 0) throw new Error(`no ${sel}`);
  let depth = 0;
  let k = text.indexOf("{", i);
  const from = k + 1;
  for (; k < text.length; k++) {
    if (text[k] === "{") depth++;
    else if (text[k] === "}" && --depth === 0) break;
  }
  return text.slice(from, k);
}

describe("PRD 08: Options CSS sections", () => {
  it("use no font size below 10 px", () => {
    const small = [];
    for (const r of rules(optionsCss)) {
      for (const m of r.body.matchAll(/font-size:\s*([\d.]+)px/g)) if (Number(m[1]) < 10) small.push(`${r.selector}: ${m[0]}`);
      for (const m of r.body.matchAll(/font:\s*(?:italic\s+)?\d{3}\s+([\d.]+)px/g)) if (Number(m[1]) < 10) small.push(`${r.selector}: ${m[0]}`);
    }
    expect(small).toEqual([]);
  });
  it("draw no border (hairlines are inset box-shadows), except under forced colours", () => {
    // A reset (border: 0 / none) draws nothing and is allowed.
    const hits = stripComments(withoutForcedColors(optionsCss)).match(/(^|[\s;{])border(-(top|right|bottom|left))?\s*:(?!\s*(0|none)\s*[;}])/g) ?? [];
    expect(hits).toEqual([]);
  });
  it("use only the 360 / 720 / 1024 / 1280 breakpoints", () => {
    const allowed = new Set([359, 360, 719, 720, 1023, 1024, 1279, 1280]);
    // Media queries only: container queries size panels, not devices.
    const widths = [...optionsCss.matchAll(/@media[^{]*/g)].flatMap((m) => [...m[0].matchAll(/\((?:max|min)-width:\s*(\d+)px\)/g)].map((x) => Number(x[1])));
    expect(widths.filter((w) => !allowed.has(w))).toEqual([]);
  });
  it("give every PRD 08 §9.4 control a 44 px target on coarse pointers", () => {
    const coarse = rules(css)
      .filter((r) => r.media.includes("pointer: coarse") && /min-height:\s*44px/.test(r.body))
      .map((r) => r.selector)
      .join(" ");
    for (const sel of ["button.q-btn", ".side-btn", ".chain-tools .segmented button", "button.preset", "button.live-ctl", ".panel-tools button", ".atm-pill", ".col-move .reorder", ".step-btn"]) expect(coarse, sel).toContain(sel);
  });
});

describe("PRD 08: Options modules", () => {
  const pages = jsFiles.filter((f) => /^(desk|strategy|strategy-place|oi|screener|vol|vol-curves|arbitrage|positions)\.js$/.test(f));
  it("covers the Options page modules", () => expect(pages.length).toBeGreaterThanOrEqual(8));
  for (const f of pages) {
    it(`${f}: no desk-empty, no "Loading the chain", no ms label, no ₹-`, () => {
      const t = read(f);
      expect(t).not.toMatch(/desk-empty/);
      expect(t).not.toMatch(/Loading the chain/);
      expect(t).not.toMatch(/` ms`|" ms"|' ms'/);
      expect(t).not.toMatch(/₹-/);
    });
    it(`${f}: keyboard hints ("press B") only inside keyHint()`, () => {
      const t = read(f);
      for (const m of t.matchAll(/press ⇧?B/g)) {
        const before = t.slice(Math.max(0, m.index - 80), m.index);
        expect(before, `${f} at ${m.index}`).toMatch(/keyHint\([^)]*$/);
      }
    });
  }
  it("no module reaches into the modal's action row", () => {
    for (const f of jsFiles) expect(read(f), f).not.toContain('document.querySelector("#dialog .dialog-actions');
  });
});

describe("Foundation §3: tokens", () => {
  const light = block(css, ":root");
  const darkMedia = block(block(css, "@media (prefers-color-scheme: dark)"), ':root:not([data-theme="light"])');
  const darkForced = block(css, ':root[data-theme="dark"]');
  const norm = (t) =>
    t
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
  const COLOUR_TOKENS = ["--sel-bg", "--sel-fg", "--seg-track", "--surface-raised", "--dv-call", "--dv-call-ink", "--dv-put", "--dv-put-ink", "--pos", "--pos-ink", "--neg", "--neg-ink", "--warn", "--warn-ink", "--dv-spot", "--dv-iv", "--dv-iv-ink", "--dv-band", "--dv-today", "--dv-grid", "--dv-axis", ...[1, 2, 3, 4, 5].flatMap((i) => [`--seq-${i}`, `--seq-ink-${i}`]), ...["n3", "n2", "n1", "0", "p1", "p2", "p3"].flatMap((k) => [`--div-${k}`, `--div-ink-${k}`])];
  it("defines every colour token in the light block and in both dark blocks", () => {
    for (const [name, body] of [["light", light], ["dark (system)", darkMedia], ["dark (forced)", darkForced]]) for (const t of COLOUR_TOKENS) expect(body, `${name} ${t}`).toMatch(new RegExp(`${t}:\\s*[^;]+;`));
  });
  it("defines the motion tokens", () => {
    for (const t of ["--dur-1", "--dur-2", "--dur-3", "--dur-4", "--dur-flash", "--ease-std", "--ease-in", "--ease-out"]) expect(light, t).toMatch(new RegExp(`${t}:\\s*[^;]+;`));
  });
  it("keeps the two dark blocks identical", () => {
    expect(norm(darkMedia)).toBe(norm(darkForced));
  });
  it("makes the dark canvas near-black (lightness ≤ 3 %) and drops the copper wash", () => {
    const bg = darkForced.match(/--background:\s*[\d.]+\s+[\d.]+%\s+([\d.]+)%/);
    expect(Number(bg?.[1])).toBeLessThanOrEqual(3);
    expect(darkForced).toMatch(/--wall-a:\s*transparent;/);
  });
  it("keeps captions at or above the text floor (0.60 light, 0.54 dark)", () => {
    expect(Number(light.match(/--a-quiet:\s*([\d.]+)/)[1])).toBeGreaterThanOrEqual(0.6);
    expect(Number(darkForced.match(/--a-quiet:\s*([\d.]+)/)[1])).toBeGreaterThanOrEqual(0.54);
  });
  it("has no --seg-thumb left", () => {
    expect(css + palette).not.toMatch(/--seg-thumb/);
  });
  it("sets panel radius 16 and panel gap 12", () => {
    expect(css).toMatch(/--r-panel:\s*16px/);
    expect(css).toMatch(/--panel-gap:\s*12px/);
  });
});

describe("Foundation §3.3: one contrast selection rule", () => {
  // Rows and status toggles are not selections (fill + leading bar, or a status dot); listed by name.
  const EXCEPT = [/tr\[aria-selected/, /tr\.sel/, /tr\.focus/, /\.live-toggle/, /\.liq i\.on/, /\.col-row\.on/, /\.arb-card\.sel/, /scr-card\.sel/];
  it("no selected-state rule outside the 3b block paints its own background", () => {
    const all = [...rules(css), ...rules(palette)];
    const bad = [];
    for (const r of all) {
      // Only rules that style the selected element itself: not a descendant of it, not a pseudo-element, not :not(…).
      const own = r.selector.split(",").some((part) => {
        const m = part.match(/\[aria-(?:pressed|selected|checked)="true"\]|\.on\b(?!-)/);
        if (!m || part.slice(0, m.index).includes(":not(")) return false;
        const rest = part.slice(m.index + m[0].length);
        return !/^\S*\s+\S/.test(rest) && !rest.includes("::");
      });
      if (!own || /::(before|after)\s*$/.test(r.selector)) continue;
      if (EXCEPT.some((re) => re.test(r.selector)) || r.media.includes("forced-colors")) continue;
      for (const m of r.body.matchAll(/background(?:-color)?:\s*([^;]+)/g)) {
        const v = m[1].trim();
        if (v.includes("var(--sel-bg)") || v === "transparent") continue;
        bad.push(`${r.selector} → ${v}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("lists every selectable control in the one rule", () => {
    const i = css.indexOf("3b · SELECTION");
    const rule = css.slice(i, css.indexOf("}", css.indexOf("{", i)));
    for (const s of ['.segmented button[aria-pressed="true"]', '.tabs button[aria-selected="true"]', '.scr-tabs button[aria-selected="true"]', 'button.chip-btn[aria-pressed="true"]', '.pct-btns button[aria-pressed="true"]', 'button.vol-wings[aria-pressed="true"]', 'button.vol-bidask[aria-pressed="true"]', "button.preset.on", "button.preset-chip.on", "table.chain .side-btn.on", ".arb-filters-btn.on", "button.scr-uchip.on", '[role="tab"][aria-selected="true"]', '[role="radio"][aria-checked="true"]', '.palette-option[aria-selected="true"]'])
      expect(rule, s).toContain(s);
    expect(rule).toMatch(/background:\s*hsl\(var\(--sel-bg\)\)/);
    expect(rule).toMatch(/color:\s*hsl\(var\(--sel-fg\)\)/);
  });
  it("switch, checkbox and radio use the contrast pair, never green", () => {
    expect(css).toMatch(/\.switch input:checked \+ i \{ background: hsl\(var\(--sel-bg\)\)/);
    expect(css).not.toMatch(/\.switch input:checked \+ i \{[^}]*ios-green/);
    for (const r of rules(css).filter((x) => /checkbox|radio|-inc\b/.test(x.selector))) expect(r.body, r.selector).not.toMatch(/accent-color/);
  });
});

describe("Foundation §4.6 and §7: chain cues and one demo indicator", () => {
  it("in-the-money cells are neutral (no yellow) and the ITM edge is not orange", () => {
    const itm = rules(css).filter((r) => /table\.chain td\.itm\b/.test(r.selector));
    expect(itm.length).toBeGreaterThan(0);
    for (const r of itm) expect(r.body).not.toMatch(/ios-yellow/);
    expect(css).not.toMatch(/--itm-edge:[^;]*ios-orange/);
  });
  it("index.html has no demo banner and one toolbar demo indicator", () => {
    expect(html).not.toMatch(/demo-banner/);
    expect(html.match(/data-demo-indicator/g)?.length).toBe(1);
    expect(html).toMatch(/id="toolbar-ctx"/);
    expect(html).toMatch(/id="dv-hatch-call"/);
    expect(html).toMatch(/id="dv-hatch-put"/);
  });
  it('"Demo data" appears only in the toolbar indicator code; "Demo prices:" nowhere', () => {
    const withText = jsFiles.filter((f) => read(f).includes("Demo data"));
    for (const f of withText) expect(["views.js", "desk.js"], f).toContain(f);
    for (const f of jsFiles) expect(read(f), f).not.toContain("Demo prices:");
    expect(read("views.js")).not.toMatch(/demoPill/);
  });
  it("the server's demo account is a plain paper account", () => {
    expect(readFileSync(resolve(here, "../demo/demoMode.mjs"), "utf8")).not.toContain("Demo paper account");
  });
});

describe("Foundation §6: motion", () => {
  it("has one skeleton keyframe (dv-shimmer)", () => {
    expect(css).toMatch(/@keyframes dv-shimmer/);
    for (const k of ["skel-pulse", "arb-shimmer"]) expect(css).not.toMatch(new RegExp(`@keyframes ${k}\\b`));
  });
  it("every keyframe used has a reduced-motion rule for the element that runs it", () => {
    const reduced = rules(css + palette)
      .filter((r) => r.media.includes("prefers-reduced-motion"))
      .map((r) => r.selector)
      .join(" ");
    const global = /\*,\s*\*::before,\s*\*::after/.test(reduced);
    const names = [...(css + palette).matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    const missing = [];
    for (const name of names) {
      const users = rules(css + palette).filter((r) => !r.media.includes("prefers-reduced-motion") && new RegExp(`animation(-name)?:[^;]*\\b${name}\\b`).test(r.body));
      for (const u of users) {
        // The element's own class (the last class in the selector) must appear in a reduced-motion rule.
        const cls = [...u.selector.split(",")[0].matchAll(/\.[\w-]+/g)].map((m) => m[0]).pop();
        if (cls && reduced.includes(cls)) continue;
        if (!cls && global) continue;
        missing.push(`${name} (${u.selector})`);
      }
    }
    expect(global, "the global reduced-motion rule").toBe(true);
    expect(missing).toEqual([]);
  });
  it("shares the dv-flash keyframes (no flash-up2 duplicates)", () => {
    expect(css).toMatch(/@keyframes dv-flash-up\b/);
    expect(css).toMatch(/@keyframes dv-flash-down\b/);
    expect(css).not.toMatch(/@keyframes flash-(up|down)2?\b/);
  });
});

describe("Foundation §4: contrast of the data-viz colours (WCAG 2.x)", () => {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  // Mirrors docs/design/foundation.md §3.2, §3.3 and §4.1 (card: light #FFFFFF, dark #0D0D0F).
  const T = {
    light: { card: "#FFFFFF", fg: "#0A0A0B", ink: { call: "#0A62C9", put: "#A65300", pos: "#0A7A33", neg: "#C9241C", warn: "#8A5A00", iv: "#6E35D6" }, fill: { call: "#1C7BEA", put: "#E07800", pos: "#1FA347", neg: "#E2382E", iv: "#7F55DB" }, sel: ["#0A0A0B", "#FFFFFF"] },
    dark: { card: "#0D0D0F", fg: "#F4F4F6", ink: { call: "#4AA8FF", put: "#FF9F2E", pos: "#30D158", neg: "#FF5A50", warn: "#FFD60A", iv: "#BF8CFF" }, fill: { call: "#3A93F0", put: "#F28A1A", pos: "#30D158", neg: "#FF5A50", iv: "#8A63D9" }, sel: ["#FFFFFF", "#000000"] },
  };
  for (const [theme, t] of Object.entries(T)) {
    it(`${theme}: text inks hold 4.5:1 and fills 3:1 on a card; the selection pair is ≥ 15:1`, () => {
      expect(ratio(t.fg, t.card)).toBeGreaterThan(15);
      for (const [k, v] of Object.entries(t.ink)) expect(ratio(v, t.card), `${k} ink`).toBeGreaterThanOrEqual(4.5);
      for (const [k, v] of Object.entries(t.fill)) expect(ratio(v, t.card), `${k} fill`).toBeGreaterThanOrEqual(3);
      expect(ratio(t.sel[0], t.sel[1])).toBeGreaterThanOrEqual(15);
    });
  }
  it("the sequential and diverging steps carry readable text (≥ 4.5:1 on their ink)", () => {
    const steps = {
      light: { seq: [["#F3EEFE", "#0A0A0B"], ["#DDCCFB", "#0A0A0B"], ["#B898F2", "#0A0A0B"], ["#7F55DB", "#FFFFFF"], ["#4E2AA6", "#FFFFFF"]], div: [["#C9241C", "#FFFFFF"], ["#F08A84", "#000000"], ["#FBD9D6", "#000000"], ["#F2F2F3", "#000000"], ["#CDEFD7", "#000000"], ["#6FCB8B", "#000000"], ["#0A7A33", "#FFFFFF"]] },
      dark: { seq: [["#1E1631", "#F4F4F6"], ["#33235A", "#F4F4F6"], ["#553A93", "#F4F4F6"], ["#8A63D9", "#000000"], ["#C7A8FF", "#000000"]], div: [["#FF5A50", "#000000"], ["#B8423C", "#FFFFFF"], ["#5A2725", "#FFFFFF"], ["#1C1C20", "#FFFFFF"], ["#1E4D2C", "#FFFFFF"], ["#237F3F", "#FFFFFF"], ["#30D158", "#000000"]] },
    };
    for (const [theme, s] of Object.entries(steps)) for (const [bg, ink] of [...s.seq, ...s.div]) expect(ratio(bg, ink), `${theme} ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
});

describe("Foundation §10: shared files are registered", () => {
  it("viz.js is served and covered by the format bans", () => {
    expect(readFileSync(resolve(here, "../core/app.mjs"), "utf8")).toMatch(/"viz\.js":\s*"text\/javascript/);
    expect(read("format.test.mjs")).toContain('"viz.js"');
  });
});

describe("Arbitrage round 2 (docs/design/arb.md §16)", () => {
  const all = readFileSync(resolve(here, "app.css"), "utf8");
  const sec = all.slice(all.indexOf("12g · ARBITRAGE"), all.indexOf("12s · SCREENER")).replace(/\/\*[\s\S]*?\*\//g, "");
  const js = readFileSync(resolve(here, "arbitrage.js"), "utf8");
  it("uses the foundation tokens and no iOS blue / indigo / orange", () => {
    expect(sec.length).toBeGreaterThan(1000);
    expect(all).toContain("12g · ARBITRAGE");
    expect(sec).not.toMatch(/--ios-(blue|indigo|orange)/);
    for (const t of ["--pos", "--neg", "--warn", "--dv-call", "--dv-put", "--dv-iv", "--dv-spot", "--sel-bg"]) expect(sec, t).toContain(`var(${t}`);
  });
  it("has no arb-shimmer or .sh skeleton, and every keyframe in the section has a reduced-motion rule", () => {
    expect(all).not.toMatch(/arb-shimmer|\.sh\b\s*[{,]/);
    const reduced = sec.slice(sec.indexOf("prefers-reduced-motion"));
    for (const [, name] of sec.matchAll(/@keyframes\s+([\w-]+)/g)) {
      const users = [...sec.matchAll(new RegExp(`([^{}]+)\\{[^}]*animation:[^;]*\\b${name}\\b`, "g"))].map((m) => m[1].trim());
      expect(users.length, name).toBeGreaterThan(0);
      for (const u of users) expect(reduced, `${name} on ${u}`).toContain(u.split(",")[0].trim());
    }
  });
  it("drops the demo lead-in and formats numbers only through format.js", () => {
    expect(js).not.toContain("Demo prices:");
    expect(js).not.toContain("Sample prices:");
    expect(js).not.toMatch(/toFixed\(/);
  });
});
