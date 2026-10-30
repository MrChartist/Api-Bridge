#!/usr/bin/env node
/**
 * Live events: measure tick-to-paint in a real browser and take screenshots (Playwright + Chromium).
 *
 *   MCB_HOME=$(mktemp -d) MCB_PORT=4391 node bin/mc-bridge.mjs start --demo &
 *   MCB_HOME=<same> node bin/mc-bridge.mjs keys create --label qa --scope admin,paper
 *   node scripts/events-paint.mjs --base http://127.0.0.1:4391 --key mcb_... [--seconds 20] [--shots <dir>]
 *
 * Tick to paint = the time the Bridge detected an event (record.detectedAt) to the frame after its row was drawn,
 * measured by the page itself (window.__mcbEventsPerf, events.js). Prints p50 / p95 and exits 1 when p95 > 100 ms.
 * With --shots it also saves the desktop, tablet and phone views in light and dark.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const base = arg("base", "http://127.0.0.1:4391");
const key = arg("key", process.env.MCB_API_KEY);
const seconds = Number(arg("seconds", "20"));
const shots = arg("shots");
if (!key) {
  console.error("Give --key mcb_... (an API key of that Bridge).");
  process.exit(2);
}

// Playwright is not a dependency of the Bridge: use a local or global install (NODE_PATH, or `npm root -g`).
const { createRequire } = await import("node:module");
const { execSync } = await import("node:child_process");
let pw;
try {
  pw = createRequire(import.meta.url)("playwright");
} catch {
  pw = createRequire(join(execSync("npm root -g").toString().trim(), "noop.js"))("playwright");
}
const { chromium } = pw;
const browser = await chromium.launch();

async function page({ width, height, scheme, touch = false, hash = "#/screeners/events?debug=1" }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1 });
  await ctx.addInitScript((k) => sessionStorage.setItem("mcb.dashboard.key", k), key);
  const p = await ctx.newPage();
  await p.goto(`${base}/dashboard${hash}`);
  await p.waitForSelector(".ev-row", { timeout: 30_000 });
  return { p, ctx };
}

const pct = (a, q) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor((q / 100) * s.length))] : null;
};

const { p, ctx } = await page({ width: 1440, height: 900, scheme: "dark" });
await p.waitForTimeout(seconds * 1000);
const samples = await p.evaluate(() => window.__mcbEventsPerf?.samples() ?? []);
const out = { samples: samples.length, p50: pct(samples, 50), p95: pct(samples, 95), max: samples.length ? Math.max(...samples) : null };
console.log(JSON.stringify({ tickToPaintMs: out }));
if (shots) {
  mkdirSync(shots, { recursive: true });
  await p.screenshot({ path: join(shots, "events-desktop-dark.png") });
  await ctx.close();
  const views = [
    ["events-desktop-light.png", { width: 1440, height: 900, scheme: "light" }],
    ["events-tablet-dark.png", { width: 820, height: 1180, scheme: "dark", touch: true }],
    ["events-tablet-light.png", { width: 820, height: 1180, scheme: "light", touch: true }],
    ["events-phone-dark.png", { width: 390, height: 844, scheme: "dark", touch: true }],
    ["events-phone-light.png", { width: 390, height: 844, scheme: "light", touch: true }],
  ];
  for (const [name, v] of views) {
    const s = await page(v);
    await s.p.waitForTimeout(1500);
    await s.p.screenshot({ path: join(shots, name) });
    await s.ctx.close();
  }
  const o = await page({ width: 1440, height: 900, scheme: "dark" });
  await o.p.click(".ev-ctl-row .segmented button[data-value=option]");
  await o.p.waitForTimeout(1500);
  await o.p.screenshot({ path: join(shots, "events-options-desktop-dark.png") });
  await o.p.locator(".ev-row").first().click();
  await o.p.waitForTimeout(800);
  await o.p.screenshot({ path: join(shots, "events-options-sheet-desktop-dark.png") });
  await o.ctx.close();
  const s2 = await page({ width: 1440, height: 900, scheme: "dark" });
  await s2.p.waitForTimeout(800);
  await s2.p.locator(".ev-row").first().click();
  await s2.p.waitForTimeout(800);
  await s2.p.screenshot({ path: join(shots, "events-sheet-desktop-dark.png") });
  await s2.p.keyboard.press("Escape");
  await s2.p.waitForTimeout(500);
  await s2.p.click("text=Events");
  await s2.p.waitForTimeout(800);
  await s2.p.screenshot({ path: join(shots, "events-picker-desktop-dark.png") });
  await s2.ctx.close();
  const op = await page({ width: 390, height: 844, scheme: "dark", touch: true });
  await op.p.click(".ev-ctl-row .segmented button[data-value=option]");
  await op.p.waitForTimeout(1500);
  await op.p.screenshot({ path: join(shots, "events-options-phone-dark.png") });
  await op.ctx.close();
} else await ctx.close();
await browser.close();
process.exit(out.p95 !== null && out.p95 > 100 ? 1 : 0);
