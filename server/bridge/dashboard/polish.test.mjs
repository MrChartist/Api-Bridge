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
    // A <button> may instead take the button system's invisible 44 px hit area (app.css 8a), so its paint stays dense.
    const hitArea = rules(css).some((r) => r.media.includes("pointer: coarse") && /^:where\(button, \.btn\)[^,]*::after$/.test(r.selector) && /width:\s*max\(100%, 44px\)/.test(r.body) && /height:\s*max\(100%, 44px\)/.test(r.body));
    expect(hitArea, "the 44 px hit area on every button").toBe(true);
    for (const sel of ["button.q-btn", ".side-btn", ".chain-tools .segmented button", "button.preset", "button.live-ctl", ".panel-tools button", ".atm-pill", ".col-move .reorder", ".step-btn"]) expect(coarse.includes(sel) || (hitArea && sel.startsWith("button.")), sel).toBe(true);
  });
});

describe("PRD 08: Options modules", () => {
  const pages = jsFiles.filter((f) => /^(desk|strategy|strategy-place|oi|screener|vol|vol-curves|arbitrage|positions|calendar|reference|readiness)\.js$/.test(f));
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
  it("defines the UI pass 3 scales in the first :root (radii, edge, spacing, z-index)", () => {
    // docs/design/ui-pass-3.md §2-§4: one panel radius (20), the inner / popover / sheet radii, one L1 edge, the panel
    // gaps (24, dense 12 on desk pages) and the stacking tiers.
    expect(light).toMatch(/--r-panel:\s*20px;/);
    expect(light).toMatch(/--r-inner:\s*12px;/);
    expect(light).toMatch(/--r-pop:\s*16px;/);
    expect(light).toMatch(/--r-sheet:\s*28px;/);
    expect(light).toMatch(/--edge-1:\s*0 0 0 var\(--hl\) var\(--mat-separator\);/);
    expect(light).toMatch(/--panel-shadow:\s*var\(--edge-1\);/);
    expect(light).toMatch(/--panel-gap:\s*24px;/);
    expect(light).toMatch(/--panel-gap-dense:\s*12px;/);
    expect(css).toMatch(/:root\[data-layout="desk"\] \{ --panel-gap: var\(--panel-gap-dense\); \}/);
    for (const t of ["--page-gutter", "--panel-head-h", "--ctl-h", "--page-tabs-h", "--surface-raised"]) expect(light, t).toMatch(new RegExp(`${t}:\\s*[^;]+;`));
    const z = { sticky: 2, "sticky-corner": 3, pinned: 6, raised: 20, veil: 40, chrome: 50, popover: 60, "panel-max": 70, toast: 90 };
    for (const [k, v] of Object.entries(z)) expect(light, `--z-${k}`).toMatch(new RegExp(`--z-${k}:\\s*${v};`));
    // The radius and gap live in the first :root only (not redefined as literals further down).
    expect(css.match(/--r-panel:\s*\d/g)?.length).toBe(1);
  });
  it("dark shadows are pure drop shadows (the L1 edge is --edge-1, never a ring inside a shadow token)", () => {
    for (const body of [darkMedia, darkForced]) {
      for (const t of ["--shadow-1", "--shadow-2", "--shadow-3", "--shadow-float"]) expect(body.match(new RegExp(`${t}:\\s*([^;]+);`))?.[1], t).not.toMatch(/^0 0 0 /);
      expect(body).toMatch(/--panel-shadow:\s*var\(--edge-1\);/);
    }
  });
});

describe("UI pass 3 §1: no strips in the shared CSS", () => {
  // The foundation's sections (ui-pass-3.md §11): 0-12 and the desk base, movable panels, the reference banners and
  // chip, responsive and accessibility, and palette.css. Page sections follow the same rule as their areas land.
  const shared = [
    css.slice(0, css.indexOf("/* ── The chain (docs/design/chain.md")),
    section("12c · MOVABLE PANELS", "12d · STRATEGY BUILDER"),
    section("12r · REFERENCE DATA AND MARKET CALENDAR", "── Market calendar page ──"),
    section("13 · RESPONSIVE", "── Positions scope"),
    palette,
  ].join("\n");
  const sharedRules = rules(withoutForcedColors(shared));
  /** The comma-separated layers of a box-shadow value (commas inside hsl() / calc() / var() are not layer breaks). */
  const layers = (v) => {
    const out = [];
    let depth = 0;
    let cur = "";
    for (const ch of v) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  /** The neutral edge colours a rule may draw (a separator hairline is not a strip). */
  const NEUTRAL = /var\(--mat-(separator|hairline)\)|transparent/;
  /** Accent, status and selection colours: never on one side of anything. */
  const ACCENT = /var\(--(sel-bg|sel-fg|sel-ring|pos|neg|warn|dv-|ios-|c-|edge\b|tone|tint|btn-buy|btn-sell|itm-edge)/;
  /** Data marks are not strips (ui-pass-3.md §1): chart legend keys draw their line style. */
  const DATA_MARKS = /\.dv-key\b/;
  const px = (t) => (/^calc\(|var\(--hl\)/.test(t) ? 0.5 : Math.abs(parseFloat(t)) || 0);
  it("finds the shared rules", () => expect(sharedRules.length).toBeGreaterThan(400));
  it("no one-sided inset box-shadow in an accent, status or selection colour (and none of 1.5 px or more at all)", () => {
    const bad = [];
    for (const r of sharedRules) {
      const decls = [...r.body.matchAll(/box-shadow:\s*([^;]+)/g)].map((m) => m[1]);
      for (const v of decls) {
        for (const layer of layers(v)) {
          const m = layer.match(/^inset\s+(\S+)\s+(\S+)(?:\s+(\S+))?/);
          if (!m) continue;
          const [x, y] = [m[1], m[2]];
          const oneSided = (px(x) > 0) !== (px(y) > 0) || (x !== "0" && y !== "0" && !(px(x) === 0 && px(y) === 0));
          if (!oneSided) continue;
          // A hairline (under 1.5 px) in a neutral ink is a separator or the button system's glass specular, not a strip.
          if (!ACCENT.test(layer) && Math.max(px(x), px(y)) < 1.5) continue;
          bad.push(`${r.selector} → ${layer}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
  it("no thin ::before / ::after bar along one edge in a colour other than the separator", () => {
    const bad = sharedRules.filter((r) => {
      if (!/::?(before|after)\s*$/.test(r.selector.split(",").pop())) return false;
      const thin = /(?:^|[\s;])(width|height):\s*(0?\.\d+|[1-4])px/.test(r.body) || /(?:^|[\s;])(width|height):\s*var\(--hl\)/.test(r.body);
      const edge = /(?:^|[\s;])(left|right|top|bottom):\s*0\b/.test(r.body) || /inset:\s*0 auto|inset:\s*auto 0|inset:\s*0 0 auto|inset:\s*auto auto 0/.test(r.body);
      const colour = r.body.match(/background(?:-color)?:\s*([^;]+)/)?.[1] ?? "";
      return thin && edge && colour && !NEUTRAL.test(colour);
    });
    expect(bad.map((r) => r.selector)).toEqual([]);
  });
  it("no one-sided border in a colour other than the separator", () => {
    const bad = [];
    for (const r of sharedRules.filter((x) => !DATA_MARKS.test(x.selector))) for (const m of r.body.matchAll(/border-(top|right|bottom|left):\s*([^;]+)/g)) if (!/^(0|none)\b/.test(m[2].trim()) && !NEUTRAL.test(m[2])) bad.push(`${r.selector} → ${m[0]}`);
    expect(bad).toEqual([]);
  });
  it("the current nav item and the More sheet's current row are fills, never a leading bar", () => {
    expect(css).not.toMatch(/\.nav a\[aria-current="page"\]::before/);
    expect(stripComments(css)).not.toMatch(/\.list-row\[aria-current="page"\][^{]*\{[^}]*inset 3px/);
    expect(css).toMatch(/\.nav a\[aria-current="page"\] \{[^}]*background: var\(--mat-fill-3\)/);
  });
  it("cards are L1: opaque, one edge, no drop shadow, no blur, no top highlight; no card-in-card surface", () => {
    const card = block(css, ".card");
    expect(card).toMatch(/background: var\(--mat-grouped-solid\)/);
    expect(card).toMatch(/box-shadow: var\(--edge-1\)/);
    expect(card).not.toMatch(/backdrop-filter|--spec-top|--shadow-/);
    expect(block(css, ".card .card")).toMatch(/background: transparent/);
    expect(stripComments(css)).not.toMatch(/\.icon-tile \{[^}]*linear-gradient/);
  });
  it("hover fills on rows and nav items only on a hovering pointer (a tap never leaves a second selected look)", () => {
    const loose = sharedRules.filter((r) => /(\.nav a|\.list-row|tbody tr):hover/.test(r.selector) && /background/.test(r.body) && !/transparent/.test(r.body) && !r.media.includes("hover: hover"));
    expect(loose.map((r) => r.selector)).toEqual([]);
  });
});

describe("UI pass 3 §4: one stacking scale", () => {
  it("no literal z-index of 10 or more in app.css or palette.css", () => {
    const hits = [...stripComments(css + palette).matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])).filter((n) => n >= 10);
    expect(hits).toEqual([]);
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
  // Mirrors docs/design/foundation.md §3.2, §3.3 and §4.1 (card: light #FFFFFF, dark #1C1C1E).
  const T = {
    light: { card: "#FFFFFF", fg: "#000000", ink: { call: "#0A62C9", put: "#A65300", pos: "#1F7F37", neg: "#D70015", warn: "#8A5A00", iv: "#6E35D6" }, fill: { call: "#1C7BEA", put: "#E07800", pos: "#22A34A", neg: "#FF3B30", iv: "#7F55DB" }, sel: ["#000000", "#FFFFFF"] },
    dark: { card: "#1C1C1E", fg: "#FFFFFF", ink: { call: "#4AA8FF", put: "#FF9F2E", pos: "#64C775", neg: "#ED756A", warn: "#FFD60A", iv: "#BF8CFF" }, fill: { call: "#3A93F0", put: "#F28A1A", pos: "#50B863", neg: "#E46156", iv: "#8A63D9" }, sel: ["#FFFFFF", "#000000"] },
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
      light: { seq: [["#F3EEFE", "#000000"], ["#DDCCFB", "#000000"], ["#B898F2", "#000000"], ["#7F55DB", "#FFFFFF"], ["#4E2AA6", "#FFFFFF"]], div: [["#D70015", "#FFFFFF"], ["#F08A84", "#000000"], ["#FBD9D6", "#000000"], ["#F2F2F3", "#000000"], ["#CDEFD7", "#000000"], ["#6FCB8B", "#000000"], ["#1F7F37", "#FFFFFF"]] },
      dark: { seq: [["#271C3F", "#FFFFFF"], ["#33235A", "#FFFFFF"], ["#553A93", "#FFFFFF"], ["#8A63D9", "#000000"], ["#C7A8FF", "#000000"]], div: [["#ED756A", "#000000"], ["#B8423C", "#FFFFFF"], ["#5A2725", "#FFFFFF"], ["#1C1C20", "#FFFFFF"], ["#1E4D2C", "#FFFFFF"], ["#237F3F", "#FFFFFF"], ["#64C775", "#000000"]] },
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
  it("names the heat-strip sides by the structure that captures them (calls rich = conversion)", () => {
    expect(js).toContain('"Calls rich (conversion side)"');
    expect(js).toContain('"Puts rich (reversal side)"');
    expect(js).not.toContain("Calls rich (reversal side)");
    expect(js).not.toContain("Puts rich (conversion side)");
  });
  it("keeps rail cards free of nested controls and the matrix grid owned by rows", () => {
    expect(js).not.toMatch(/class: "arb-opp skel", role: "button"/);
    expect(js).toContain('role: "row"');
    expect(js).toContain("aria-activedescendant");
  });
});

describe("Positions round 2 (docs/design/positions.md §10)", () => {
  const all = readFileSync(resolve(here, "app.css"), "utf8");
  const sec = all.slice(all.indexOf("12f · POSITIONS AND RISK"), all.indexOf("12v · VOLATILITY")).replace(/\/\*[\s\S]*?\*\//g, "");
  const js = readFileSync(resolve(here, "positions.js"), "utf8");
  it("uses role tokens only: no iOS green / red / orange and no accent-color", () => {
    expect(sec.length).toBeGreaterThan(2000);
    expect(sec).not.toMatch(/--ios-(green|red|orange|blue|teal|purple|indigo)/);
    expect(sec).not.toMatch(/accent-color/);
    for (const t of ["--pos", "--neg", "--warn", "--dv-today", "--dv-band", "--dv-call", "--dv-put", "--dv-iv", "--sel-bg", "--sel-fg"]) expect(sec, t).toContain(`var(${t}`);
  });
  it("every keyframe in the section has a reduced-motion rule", () => {
    const reduced = sec.slice(sec.lastIndexOf("prefers-reduced-motion"));
    for (const [, name] of sec.matchAll(/@keyframes\s+([\w-]+)/g)) {
      const users = [...sec.matchAll(new RegExp(`([^{}]+)\\{[^}]*animation:[^;]*\\b${name}\\b`, "g"))].map((m) => m[1].trim());
      expect(users.length, name).toBeGreaterThan(0);
      for (const u of users) expect(reduced, `${name} on ${u}`).toContain(u.split(",")[0].trim());
    }
  });
  it("shares the builder's payoff, has no style attributes, no demo text and no always-on key hint row", () => {
    expect(js).toContain('import { drawPayoff } from "./payoff.js"');
    expect(js).not.toContain("createBookPayoff");
    expect(js).not.toMatch(/style="/);
    expect(js).not.toMatch(/[Dd]emo/);
    expect(js).not.toContain("desk-keys");
  });
});

describe("Reference data and Market calendar (docs/spec/p1-02-reference.md §5)", () => {
  const sec = stripComments(section("12r · REFERENCE DATA AND MARKET CALENDAR", "13 · RESPONSIVE"));
  it("uses tokens only: no colour literals", () => {
    expect(sec.length).toBeGreaterThan(1000);
    expect(sec.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(\s*\d/gi) ?? []).toEqual([]);
  });
  it("gives the chip, tiles, banner actions, lot check and calendar controls a 44 px target on touch screens", () => {
    const coarse = rules(sec)
      .filter((r) => r.media.includes("pointer: coarse") && /min-height:\s*44px/.test(r.body))
      .map((r) => r.selector)
      .join(" ");
    // The month arrows, the "?" and CSV are <button>s: the button system's invisible 44 px area (app.css 8a) covers them.
    const hitArea = rules(css).some((r) => r.media.includes("pointer: coarse") && /^:where\(button, \.btn\)[^,]*::after$/.test(r.selector) && /height:\s*max\(100%, 44px\)/.test(r.body));
    for (const sel of ["button.ref-chip", "button.cal-tile", ".ref-banner-act", "button.lot-gate-units"]) expect(coarse, sel).toContain(sel);
    for (const sel of [".cal-nav .icon-btn", "button.cal-help", "button.cal-csv"]) expect(coarse.includes(sel) || hitArea, sel).toBe(true);
  });
  it("calendar.js and reference.js are registered and covered by the format bans", () => {
    for (const f of ["calendar.js", "reference.js"]) {
      expect(readFileSync(resolve(here, "../core/app.mjs"), "utf8")).toMatch(new RegExp(`"${f.replace(".", "\\.")}":\\s*"text/javascript`));
      expect(read("format.test.mjs")).toContain(`"${f}"`);
    }
  });
});

describe("toast tones (QA pass, 30 Oct)", () => {
  it("every toast names a tone toast() knows, so a problem never shows the green tick", () => {
    const known = new Set(["ok", "info", "warn", "error"]);
    const bad = [];
    for (const f of jsFiles) {
      for (const line of read(f).split("\n")) {
        if (!line.includes("toast(")) continue;
        for (const m of line.matchAll(/toast\([^;]*?\{ tone: "([a-z]*)" \}/g)) if (!known.has(m[1])) bad.push(`${f}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("Final sweep (31 Oct)", () => {
  it("a bare <small> never falls under the 12 px type floor (the UA 'smaller' drew 10.4 px in Watchlists)", () => {
    expect(css).toMatch(/:where\(small\) \{ font-size: max\(12px, 0\.8333em\); \}/);
  });
});
