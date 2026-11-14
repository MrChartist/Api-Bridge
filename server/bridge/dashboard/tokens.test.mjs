/**
 * The design tokens: the dark values are declared twice (system dark and forced dark) and must match, the semantic names
 * exist, no brand token is left, and every text and control pair the system introduces holds its contrast (4.5:1 for
 * text, 3:1 for glyphs and UI) in light and dark. Reads app.css as text only.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "app.css"), "utf8");

const block = (start) => {
  const at = css.indexOf(start);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return "";
};
const light = block(":root {");
const darkForced = block(':root[data-theme="dark"] {');
const darkAuto = block(':root:not([data-theme="light"]) {');
const decl = (text) => new Map([...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const L = decl(light);
const D = new Map([...L, ...decl(darkForced)]);

// ── Colour maths ──
const hslToRgb = (h, s, l) => {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => v * 255);
};
/** "193.1 88.6% 34.5%" (or an hsl(... / a) value) to { rgb, a }. */
const parse = (value) => {
  const m = /^(?:hsl\()?\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+))?\)?$/.exec(value.trim());
  if (!m) throw new Error(`not an HSL triplet: ${value}`);
  return { rgb: hslToRgb(Number(m[1]), Number(m[2]), Number(m[3])), a: m[4] === undefined ? 1 : Number(m[4]) };
};
const over = (top, bottom) => ({ rgb: top.rgb.map((c, i) => c * top.a + bottom.rgb[i] * (1 - top.a)), a: 1 });
const lum = ({ rgb }) => {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (fg, bg) => {
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

function themes() {
  return [["light", L], ["dark", D]].map(([name, T]) => {
    const t = (n) => parse(T.get(n));
    const alpha = (n, a) => ({ ...t(n), a });
    const card = t("--card");
    const canvas = t("--background");
    const fg = t("--foreground");
    const fillOf = (v) => parse(v);
    return { name, t, alpha, card, canvas, fg, fillOf, num: (n) => Number(T.get(n)), T };
  });
}

describe("tokens: structure", () => {
  it("declares the dark values twice, identically (system dark and forced dark)", () => {
    expect(darkAuto.trim().length).toBeGreaterThan(500);
    expect(decl(darkAuto)).toEqual(decl(darkForced));
  });
  it("has the semantic names the pages and components use", () => {
    for (const n of ["--accent", "--accent-hover", "--accent-ink", "--on-accent", "--label", "--label-2", "--label-3", "--fill-1", "--fill-2", "--fill-3", "--surface", "--surface-grouped", "--separator", "--success", "--danger", "--warning", "--info", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--space-1", "--space-4", "--space-16", "--ease-out", "--dur-1", "--dur-2", "--dur-3", "--shadow-1", "--shadow-3", "--z-toast"]) {
      expect(L.has(n), n).toBe(true);
    }
    for (const n of ["--accent", "--accent-ink", "--on-accent", "--success", "--danger", "--warning", "--fill-1", "--separator", "--card", "--background", "--foreground", "--mat-thick"]) expect(decl(darkForced).has(n), `dark ${n}`).toBe(true);
  });
  it("keeps the 4px spacing scale and the 6/10/14/20 radii", () => {
    expect([...Array(5).keys()].map((i) => L.get(`--space-${[1, 2, 3, 4, 5][i]}`))).toEqual(["4px", "8px", "12px", "16px", "20px"]);
    expect([L.get("--radius-sm"), L.get("--radius-md"), L.get("--radius-lg"), L.get("--radius-xl")]).toEqual(["6px", "10px", "14px", "20px"]);
    expect(L.get("--ease-out")).toBe("cubic-bezier(0.2, 0.8, 0.2, 1)");
  });
  it("carries no brand token or leftover system-colour name", () => {
    expect(css).not.toMatch(/--brand-wine|--sel-ring|--ios-[a-z]|--font-serif-accent/);
  });
});

describe("tokens: contrast (text 4.5:1, glyphs and UI 3:1)", () => {
  for (const th of themes()) {
    const { name } = th;
    const surfaces = [["card", th.card], ["canvas", th.canvas]];
    it(`${name}: labels and accent text on the card and the canvas`, () => {
      const bad = [];
      for (const [sn, s] of surfaces) {
        const checks = {
          label: th.fg,
          "label-2 (--a-label)": { ...th.fg, a: th.num("--a-label") },
          "label-3 (--a-quiet)": { ...th.fg, a: th.num("--a-quiet") },
          "accent-ink": th.t("--accent-ink"),
          "success-ink": th.t("--success-ink"),
          "danger-ink": th.t("--danger-ink"),
          "warning-ink": th.t("--warning-ink"),
          "info-ink": th.t("--info-ink"),
        };
        for (const [k, c] of Object.entries(checks)) {
          const r = ratio(over(c, s), s);
          if (r < 4.5) bad.push(`${k} on ${sn}: ${r.toFixed(2)}`);
        }
      }
      expect(bad).toEqual([]);
    });
    it(`${name}: text on a fill (primary, destructive, buy and sell buttons, selected rows)`, () => {
      const pairs = [["on-accent on accent", th.t("--on-accent"), th.t("--accent")], ["on-accent on accent-hover", th.t("--on-accent"), th.t("--accent-hover")], ["on-status on buy (success fill)", th.t("--on-status"), th.t(name === "light" ? "--success-ink" : "--success")], ["on-status on danger", th.t("--on-status"), th.t("--danger")]];
      const bad = pairs.filter(([, fg, bg]) => ratio(fg, bg) < 4.5).map(([k, fg, bg]) => `${k}: ${ratio(fg, bg).toFixed(2)}`);
      expect(bad).toEqual([]);
    });
    it(`${name}: tinted states (pills, the current nav item and tab, tinted buttons, the segmented track)`, () => {
      const chip = th.num("--chip-tint");
      const bad = [];
      for (const [sn, s] of surfaces) {
        for (const tone of ["success", "danger", "warning"]) {
          const bg = over({ ...th.t(`--${tone}`), a: chip }, s);
          const r = ratio(th.t(`--${tone}-ink`), bg);
          if (r < 4.5) bad.push(`${tone} pill on ${sn}: ${r.toFixed(2)}`);
        }
        const accentBg = over({ ...th.t("--accent"), a: 0.2 }, s);
        const r1 = ratio(th.t("--accent-ink"), accentBg);
        if (r1 < 4.5) bad.push(`accent tint (.2) on ${sn}: ${r1.toFixed(2)}`);
        const track = over(th.fillOf(th.T.get("--seg-track")), s);
        const r2 = ratio(over({ ...th.fg, a: th.num("--a-label") }, track), track);
        if (r2 < 4.5) bad.push(`segmented label on track on ${sn}: ${r2.toFixed(2)}`);
        const chipBg = over(th.fillOf(th.T.get("--fill-2")), s);
        const r3 = ratio(over({ ...th.fg, a: th.num("--a-label") }, chipBg), chipBg);
        if (r3 < 4.5) bad.push(`chip (label-2 on fill-2) on ${sn}: ${r3.toFixed(2)}`);
      }
      expect(bad).toEqual([]);
    });
    it(`${name}: white glyphs on the icon-tile hues, and the accent against the surface (UI 3:1)`, () => {
      const bad = [];
      for (const tile of ["teal", "blue", "indigo", "purple", "pink", "orange", "green", "red", "gray"]) {
        const r = ratio({ rgb: [255, 255, 255], a: 1 }, th.t(`--tile-${tile}`));
        if (r < 3) bad.push(`tile ${tile}: ${r.toFixed(2)}`);
      }
      for (const [sn, s] of surfaces) {
        const r = ratio(th.t("--accent"), s);
        if (r < 3) bad.push(`accent on ${sn}: ${r.toFixed(2)}`);
        const sw = ratio(th.fg, s);
        if (sw < 3) bad.push(`label on ${sn}: ${sw.toFixed(2)}`);
      }
      expect(bad).toEqual([]);
    });
  }
});
