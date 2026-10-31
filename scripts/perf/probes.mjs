#!/usr/bin/env node
/**
 * Targeted request-count probes for the broker features (docs/perf/README.md, round 5):
 *
 *   node scripts/perf/probes.mjs --port 4730 [--home <dir>] [--latency 200] [--seconds 20] [--out probes.json]
 *   node scripts/perf/probes.mjs --base http://127.0.0.1:4730 --key mcb_...
 *
 * - orders: Cancel all's dry run (POST /v1/orders/cancel-all { dryRun: true }) per page render, per minute while the
 *   page sits still, per Reload click, and whether a page switch after Orders still paints from remembered answers.
 * - algo: REST per minute on Algo with a paper strategy running, the log lines it shows against the lines the Bridge
 *   holds (a duplicated line means two log polls ran at once), and the rate after a few clicks between strategies.
 * - depth: GET /v1/depth per minute with the order ticket's Market depth closed, open, closed again and the ticket shut.
 *
 * Starts its own demo Bridge unless --base is given, and stops it (its own PID only).
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "bin", "mc-bridge.mjs");
const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const SECONDS = Number(arg("seconds", "20"));
const LATENCY = Number(arg("latency", "200"));
const ONLY = (arg("only", "") ?? "").split(",").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
  try {
    return createRequire(import.meta.url)("playwright");
  } catch {
    return createRequire(join(execSync("npm root -g").toString().trim(), "noop.js"))("playwright");
  }
}

async function startBridge() {
  const home = resolve(arg("home") ?? mkdtempSync(join(tmpdir(), "mcb-probe-")));
  const port = Number(arg("port", "4730"));
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, MCB_HOME: home, MCB_PORT: String(port), MCB_DEMO_LATENCY_MS: String(LATENCY), NO_COLOR: "1" };
  delete env.MCB_CONFIG;
  const proc = spawn(process.execPath, [CLI, "start", "--demo"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode !== null) throw new Error(`Bridge exited early:\n${log}`);
    try {
      if ((await fetch(`${base}/v1/health`)).ok) break;
    } catch {}
    await sleep(150);
  }
  const out = execSync(`"${process.execPath}" "${CLI}" keys create --label probe --scope admin,paper`, { cwd: ROOT, env }).toString();
  const key = out.match(/mcb_[A-Za-z0-9_-]+/)?.[0];
  if (!key) throw new Error(`no key:\n${out}`);
  const stop = async () => {
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGTERM");
    await Promise.race([exited, sleep(5000)]);
  };
  return { base, key, stop };
}

/** Every /v1 request the page makes, with its method and (for POSTs) its body. */
function tap(page) {
  const log = [];
  page.on("request", (req) => {
    const url = req.url();
    if (!/\/v1\//.test(url)) return;
    log.push({ t: Date.now(), method: req.method(), path: url.replace(/^https?:\/\/[^/]+/, ""), body: req.postData() ?? "" });
  });
  return {
    count(f, t0 = 0, t1 = Infinity) {
      return log.filter((r) => r.t >= t0 && r.t < t1 && f(r)).length;
    },
    since(t0) {
      return log.filter((r) => r.t >= t0);
    },
  };
}
const isDry = (r) => r.method === "POST" && r.path.startsWith("/v1/orders/cancel-all") && /"dryRun":true/.test(r.body);
const perMin = (n, ms) => Math.round((n / ms) * 60_000 * 10) / 10;

async function newPage(browser, key) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await ctx.addInitScript((k) => sessionStorage.setItem("mcb.dashboard.key", k), key);
  const page = await ctx.newPage();
  return { ctx, page };
}

async function useful(page, timeoutMs = 15_000) {
  await page.waitForFunction(() => {
    const c = document.getElementById("content");
    return c && !c.hasAttribute("aria-busy") && !c.querySelector(".skel-state, .chain-skel, .skel") && c.querySelectorAll("*").length > 20;
  }, null, { timeout: timeoutMs }).catch(() => {});
}

async function probeOrders(browser, base, key) {
  const { ctx, page } = await newPage(browser, key);
  const t = tap(page);
  await page.goto(`${base}/dashboard#/home`, { waitUntil: "load" });
  await useful(page);
  await sleep(1500);
  let t0 = Date.now();
  await page.evaluate(() => (location.hash = "#/orders"));
  await useful(page);
  await sleep(3000);
  const firstVisit = t.count(isDry, t0);
  // Still page.
  t0 = Date.now();
  await sleep(SECONDS * 1000);
  const still = t.count(isDry, t0);
  const stillAll = t.count(() => true, t0);
  const stillMs = Date.now() - t0;
  // Reload clicks: user actions, one dry run each is expected.
  t0 = Date.now();
  for (let i = 0; i < 3; i++) {
    await page.click(".toolbar-refresh").catch(() => {});
    await sleep(1500);
  }
  const reloads = t.count(isDry, t0);
  // Leave for Home: does Home still paint from what the dashboard remembered (a dry run that forgets every answer
  // makes this a cold read)?
  await sleep(1000);
  const sw = await page.evaluate(async () => {
    const t = performance.now();
    location.hash = "#/home";
    for (;;) {
      await new Promise((r) => requestAnimationFrame(r));
      const c = document.getElementById("content");
      if (c && !c.hasAttribute("aria-busy") && !c.querySelector(".skel-state, .skel") && !c.textContent.trim().endsWith("Loading…") && c.querySelectorAll("*").length > 20) return Math.round(performance.now() - t);
      if (performance.now() - t > 10_000) return null;
    }
  });
  // Cost of one dry run, measured from here.
  const ms = [];
  for (let i = 0; i < 5; i++) {
    const a = Date.now();
    await fetch(`${base}/v1/orders/cancel-all`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: true }) });
    ms.push(Date.now() - a);
  }
  await ctx.close();
  return { dryRunsFirstVisit: firstVisit, dryRunsPerMinStill: perMin(still, stillMs), restPerMinStill: perMin(stillAll, stillMs), dryRunsFor3Reloads: reloads, homeSwitchAfterOrdersMs: sw, dryRunMs: ms.sort((a, b) => a - b)[2] };
}

async function probeAlgo(browser, base, key) {
  const H = { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-MCB-Client": "perf-probe" };
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.json().catch(() => ({}));
  };
  await call("POST", "/v1/strategies/examples");
  const list = (await call("GET", "/v1/strategies")).data?.items ?? [];
  const accounts = (await call("GET", "/v1/accounts")).data ?? [];
  const account = accounts.find((a) => a.broker === "paper" || a.mode === "paper")?.id ?? accounts[0]?.id;
  const started = [];
  for (const s of list.slice(0, 2)) {
    const r = await call("POST", `/v1/strategies/${encodeURIComponent(s.id)}/start`, { account, params: {} });
    started.push({ id: s.id, ok: !r.error, error: r.error?.code ?? null });
  }
  await sleep(3000);
  const { ctx, page } = await newPage(browser, key);
  const t = tap(page);
  await page.goto(`${base}/dashboard#/algo`, { waitUntil: "load" });
  await useful(page);
  await sleep(3000);
  const rate = async () => {
    const t0 = Date.now();
    await sleep(SECONDS * 1000);
    const rs = t.since(t0);
    const ms = Date.now() - t0;
    const by = (re) => perMin(rs.filter((r) => re.test(r.path)).length, ms);
    return { restPerMin: perMin(rs.length, ms), logsPerMin: by(/\/v1\/strategies\/[^/]+\/logs/), listPerMin: by(/\/v1\/strategies(\?|$)/), detailPerMin: by(/\/v1\/strategies\/[^/?]+(\?|$)/) };
  };
  const settled = await rate();
  // Click between strategies a few times quickly (each a select()), as a person comparing two runs would.
  const rows = await page.$$(".algo-row-main");
  for (let i = 0; i < 6 && rows.length > 1; i++) {
    await rows[i % 2].click().catch(() => {});
    await sleep(150);
  }
  if (rows.length > 1) await rows[0].click().catch(() => {});
  await sleep(2500);
  const afterClicks = await rate();
  // Shown log lines against the lines the Bridge holds for the selected strategy: more shown means duplicates.
  const sel = await page.evaluate(() => document.querySelector('.algo-row-main[aria-current="true"] .muted')?.textContent ?? null);
  const shown = await page.$$eval(".algo-ll:not(.muted)", (els) => els.map((e) => e.textContent));
  const dupLines = shown.length - new Set(shown).size;
  for (const s of started) await call("POST", `/v1/strategies/${encodeURIComponent(s.id)}/stop`);
  await ctx.close();
  return { started, selected: sel, settled, afterClicks, logLinesShown: shown.length, duplicateLogLines: dupLines };
}

async function probeDepth(browser, base, key) {
  const { ctx, page } = await newPage(browser, key);
  const t = tap(page);
  await page.goto(`${base}/dashboard#/chain`, { waitUntil: "load" });
  await useful(page, 20_000);
  await sleep(3000);
  const isDepth = (r) => r.method === "GET" && r.path.startsWith("/v1/depth");
  const window = async () => {
    const t0 = Date.now();
    await sleep(10_000);
    return perMin(t.count(isDepth, t0), Date.now() - t0);
  };
  const ticketClosed = await window();
  await page.keyboard.press("b");
  await page.waitForSelector("details.bk-depth", { timeout: 10_000 }).catch(() => {});
  await sleep(1000);
  const depthClosed = await window();
  await page.click("details.bk-depth > summary").catch(() => {});
  const depthOpen = await window();
  await page.click("details.bk-depth > summary").catch(() => {});
  await sleep(300);
  const depthClosedAgain = await window();
  await page.click("details.bk-depth > summary").catch(() => {});
  await sleep(2500);
  await page.keyboard.press("Escape");
  await sleep(2500);
  const ticketShut = await window();
  await ctx.close();
  return { depthPerMin: { ticketClosed, depthClosed, depthOpen, depthClosedAgain, ticketShut } };
}

async function main() {
  const bridge = arg("base") ? { base: arg("base"), key: arg("key") ?? process.env.MCB_API_KEY, stop: async () => {} } : await startBridge();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const out = { at: new Date().toISOString(), seconds: SECONDS, latencyMs: LATENCY };
  try {
    await sleep(3000);
    if (!ONLY.length || ONLY.includes("orders")) out.orders = await probeOrders(browser, bridge.base, bridge.key);
    console.error(JSON.stringify(out.orders));
    if (!ONLY.length || ONLY.includes("depth")) out.depth = await probeDepth(browser, bridge.base, bridge.key);
    console.error(JSON.stringify(out.depth));
    if (!ONLY.length || ONLY.includes("algo")) out.algo = await probeAlgo(browser, bridge.base, bridge.key);
    console.error(JSON.stringify(out.algo));
  } finally {
    await browser.close();
    await bridge.stop();
  }
  const text = JSON.stringify(out, null, 2);
  if (arg("out")) writeFileSync(arg("out"), text);
  console.log(text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
