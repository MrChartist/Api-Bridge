#!/usr/bin/env node
/**
 * Dashboard and broker-budget performance harness (docs/perf/README.md).
 *
 *   node scripts/perf/run.mjs [--port 4480] [--home <dir>] [--latency 200] [--seconds 15] [--busy 60] [--idle 20]
 *                             [--only chain,oi,busy] [--out file.json] [--shots dir]
 *   node scripts/perf/run.mjs --base http://127.0.0.1:4480 --key mcb_...      use a Bridge that is already running
 *
 * Without --base it starts a demo Bridge itself (MCB_HOME=<home> MCB_PORT=<port> mc-bridge start --demo), makes an
 * admin key there, and stops that Bridge (its own PID only) at the end. --latency sets MCB_DEMO_LATENCY_MS: every demo
 * broker REST read answers after that many ms, like a real broker over the internet (default 200).
 *
 * Per page (Playwright + Chromium, 1440 x 900, dark):
 *   - cold load: first contentful paint, time to first data (the page's content is drawn, no skeleton, no
 *     "Loading…"), JS and CSS bytes;
 *   - page switch: from Home to the page, then away and back (the second switch is the "from cache" case);
 *   - steady state for --seconds: REST calls per minute from the page, duplicate requests (the same GET while an
 *     identical one is in flight or within 300 ms of it), main-thread long tasks, tick to cell (data time of the price
 *     to the frame its table cell changed), and broker calls per minute (the rate-limit engine's own counters,
 *     GET /v1/usage callsToday, minus the idle background rate measured with no page open).
 * Then the busiest demo scenario: Option Chain, OI Analysis, Strategy and Live events open together on NIFTY for
 * --busy seconds; broker calls in that window.
 *
 * Prints one JSON document (and writes it to --out). Numbers on a busy machine are noisy: run it 2-3 times.
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
const SECONDS = Number(arg("seconds", "15"));
const BUSY = Number(arg("busy", "60"));
const IDLE = Number(arg("idle", "20"));
const ONLY = (arg("only", "") ?? "").split(",").filter(Boolean);
const OUT = arg("out");
const SHOTS = arg("shots");
/** Simulated broker round trip for the demo adapter (a real broker answers a REST read in roughly 100-400 ms). */
const LATENCY = Number(arg("latency", "200"));
/** Seconds of the steady window that are traced for paint, layout and style (Chromium trace, renderer main thread). */
const TRACE = Number(arg("trace", "6"));
/** Minutes of the heap soak (0: no soak). */
const SOAK = Number(arg("soak", "0"));
const VIEWPORT = (() => {
  const [w, h] = String(arg("viewport", "1440x900")).split("x").map(Number);
  return { width: w || 1440, height: h || 900 };
})();

export const PAGES = [
  ["home", "#/home"],
  ["chain", "#/chain"],
  ["strategy", "#/strategy"],
  ["positions", "#/positions"],
  ["orders", "#/orders"],
  ["oi", "#/oi/strike"],
  ["vol", "#/vol"],
  ["screener", "#/screeners/options"],
  ["events", "#/screeners/events"],
  ["accounts", "#/accounts"],
  ["api", "#/api/keys"],
  ["limits", "#/api/limits"],
  // Pages added on 30 October (perf round 4).
  ["exposure", "#/exposure/strike"],
  ["flow", "#/flow/unusual"],
  ["futures", "#/futures/chain"],
  ["risk", "#/risk/var"],
  ["lab", "#/lab/finder"],
  ["watchlists", "#/screeners/watchlists"],
];
/** Pages that stay open for the --soak run (JS heap over --soak minutes); "cycle" walks every page in turn. */
const SOAK_PAGES = ["chain", "oi", "strategy", "positions", "orders", "watchlists", "exposure", "flow", "cycle"];

function loadPlaywright() {
  try {
    return createRequire(import.meta.url)("playwright");
  } catch {
    return createRequire(join(execSync("npm root -g").toString().trim(), "noop.js"))("playwright");
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, q) => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((q / 100) * s.length))]) : null;
};

async function startBridge() {
  const home = resolve(arg("home") ?? mkdtempSync(join(tmpdir(), "mcb-perf-")));
  const port = Number(arg("port", "4480"));
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
  const out = execSync(`"${process.execPath}" "${CLI}" keys create --label perf --scope admin,paper`, { cwd: ROOT, env }).toString();
  const key = out.match(/mcb_[A-Za-z0-9_-]+/)?.[0];
  if (!key) throw new Error(`no key:\n${out}`);
  const stop = async () => {
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGTERM");
    await Promise.race([exited, sleep(5000)]);
  };
  return { base, key, stop, pid: proc.pid };
}

/** Sum of broker calls the rate-limit engine has started today, over every account and class. */
async function brokerCalls(base, key) {
  const r = await fetch(`${base}/v1/usage`, { headers: { Authorization: `Bearer ${key}`, "X-MCB-Client": "perf-harness" } });
  const body = await r.json();
  let calls = 0;
  const byClass = {};
  for (const a of body.data?.accounts ?? []) {
    for (const [cls, v] of Object.entries(a.classes ?? {})) {
      calls += v.callsToday ?? 0;
      byClass[cls] = (byClass[cls] ?? 0) + (v.callsToday ?? 0);
    }
  }
  return { calls, byClass, savings: body.data?.savings ?? {} };
}
const diffClass = (a, b) => Object.fromEntries(Object.keys(b.byClass).map((k) => [k, b.byClass[k] - (a.byClass[k] ?? 0)]).filter(([, v]) => v));

/**
 * Runs in the page before any of its scripts: long tasks, a fetch and WebSocket tap (data times), and a watcher that
 * timestamps the first useful paint and every table-cell change.
 */
function initScript() {
  const P = (window.__perf = { longTasks: [], dataAt: [], cellSamples: [], useful: null, navAt: null, requests: [] });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.longTasks.push({ at: e.startTime, ms: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  const parseAsOf = (v) => {
    const t = typeof v === "number" ? v : Date.parse(v);
    return Number.isFinite(t) ? t : null;
  };
  // Data time of a price: freshness.asOf of a chain or quotes answer, receivedAt of a stream tick.
  const of = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url ?? "";
    const res = await of.call(this, input, init);
    if (/\/v1\/(optionchain|quotes|ltp|positions)\b/.test(url)) {
      res
        .clone()
        .json()
        .then((b) => {
          const f = b?.data?.freshness ?? b?.meta?.freshness ?? (Array.isArray(b?.data) ? b.data[0]?.freshness : null);
          const at = parseAsOf(f?.asOf);
          if (at) P.dataAt.push(at);
        })
        .catch(() => {});
    }
    return res;
  };
  const OWS = window.WebSocket;
  if (OWS) {
    window.WebSocket = class extends OWS {
      constructor(...a) {
        super(...a);
        this.addEventListener("message", (m) => {
          try {
            const msg = JSON.parse(m.data);
            if (msg.type === "tick" && Number.isFinite(msg.receivedAt)) P.dataAt.push(msg.receivedAt);
            if (msg.type === "chain_delta" || msg.type === "ticks") for (const t of msg.ticks ?? []) if (Number.isFinite(t.receivedAt)) P.dataAt.push(t.receivedAt);
          } catch {}
        });
      }
    };
  }
  const useful = () => {
    const c = document.getElementById("content");
    if (!c || c.hasAttribute("aria-busy")) return false;
    // Any skeleton (the generic one, the chain's layout-shaped one, a skeleton bar) means the data is not drawn yet.
    if (c.querySelector(".skel-state, .chain-skel, .skel")) return false;
    const t = c.textContent.trim();
    if (!t || t === "Loading…" || t.endsWith("Loading…")) return false;
    return c.querySelectorAll("*").length > 20;
  };
  P.reset = () => {
    P.useful = null;
    P.navAt = performance.now();
  };
  const frame = () => {
    if (P.useful === null && useful()) P.useful = performance.now();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // Tick to cell: the first cell change after a NEW data time (newer than anything painted so far: a refresh that
  // brings older data than the stream already showed is not a tick), painted on the next frame.
  let pendingCells = false;
  let paintedUpTo = 0;
  const mo = new MutationObserver((list) => {
    if (pendingCells) return;
    if (!list.some((m) => (m.target.nodeType === 3 ? m.target.parentElement : m.target)?.closest?.("td, .q-cell, [data-cell]"))) return;
    pendingCells = true;
    requestAnimationFrame(() => {
      pendingCells = false;
      if (!P.dataAt.length) return;
      const latest = Math.max(...P.dataAt);
      P.dataAt.length = 0;
      if (latest <= paintedUpTo) return;
      paintedUpTo = latest;
      P.cellSamples.push(Date.now() - latest);
    });
  });
  const attach = () => {
    const c = document.getElementById("content");
    if (c) mo.observe(c, { subtree: true, childList: true, characterData: true });
    else setTimeout(attach, 50);
  };
  attach();
}

/** Watch a page's requests: per-URL concurrency gives the duplicates. */
function tapRequests(page) {
  const log = [];
  const open = new Map();
  const lastDone = new Map();
  let dups = 0;
  const dupUrls = new Map();
  page.on("request", (req) => {
    const url = req.url();
    if (!/\/v1\//.test(url) || url.includes("/v1/usage?perf")) return;
    const k = `${req.method()} ${url.replace(/^https?:\/\/[^/]+/, "")}`;
    const t = Date.now();
    if (req.method() === "GET" && ((open.get(k) ?? 0) > 0 || t - (lastDone.get(k) ?? -1e9) < 300)) {
      dups += 1;
      dupUrls.set(k, (dupUrls.get(k) ?? 0) + 1);
    }
    open.set(k, (open.get(k) ?? 0) + 1);
    log.push({ t, k });
  });
  const done = (req) => {
    const k = `${req.method()} ${req.url().replace(/^https?:\/\/[^/]+/, "")}`;
    if (!open.has(k)) return;
    open.set(k, Math.max(0, open.get(k) - 1));
    lastDone.set(k, Date.now());
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return {
    since(t0) {
      return log.filter((r) => r.t >= t0);
    },
    reset() {
      log.length = 0;
      dups = 0;
      dupUrls.clear();
    },
    dups: () => dups,
    dupUrls: () => Object.fromEntries([...dupUrls].sort((a, b) => b[1] - a[1]).slice(0, 5)),
  };
}

/** JS heap after a forced garbage collection (CDP), in KB. */
async function heapKB(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("HeapProfiler.collectGarbage");
    const { usedSize } = await cdp.send("Runtime.getHeapUsage");
    return Math.round(usedSize / 1024);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Chromium's own main-thread counters (CDP Performance.getMetrics), in seconds. */
async function metrics(cdp) {
  const { metrics: m } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(m.map((x) => [x.name, x.value]));
}

/**
 * Trace `seconds` of the page and sum the renderer main thread's paint (Paint, PrePaint, Layerize, UpdateLayerTree,
 * PaintImage), layout (Layout) and style (UpdateLayoutTree, RecalculateStyles) work, in ms per second.
 */
async function traceRender(browser, page, seconds) {
  await browser.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] });
  await sleep(seconds * 1000);
  const buf = await browser.stopTracing();
  const events = JSON.parse(buf.toString()).traceEvents ?? [];
  const mainTids = new Set(events.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`));
  const sum = { paint: 0, layout: 0, style: 0 };
  const PAINT = new Set(["Paint", "PrePaint", "Layerize", "UpdateLayerTree", "PaintImage"]);
  const STYLE = new Set(["UpdateLayoutTree", "RecalculateStyles"]);
  for (const e of events) {
    if (e.ph !== "X" || !e.dur || !mainTids.has(`${e.pid}:${e.tid}`)) continue;
    if (PAINT.has(e.name)) sum.paint += e.dur / 1000;
    else if (e.name === "Layout") sum.layout += e.dur / 1000;
    else if (STYLE.has(e.name)) sum.style += e.dur / 1000;
  }
  return { paintMsPerS: Math.round(sum.paint / seconds), layoutMsPerS: Math.round(sum.layout / seconds), styleMsPerS: Math.round(sum.style / seconds) };
}

async function waitUseful(page, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await page.evaluate(() => (window.__perf.useful === null ? null : window.__perf.useful - window.__perf.navAt));
    if (v !== null) return Math.round(v);
    await sleep(20);
  }
  return null;
}

async function switchTo(page, hash) {
  await page.evaluate((h) => {
    window.__perf.reset();
    location.hash = h;
  }, hash);
  return waitUseful(page);
}

async function newPage(browser, base, key) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark" });
  await ctx.addInitScript((k) => sessionStorage.setItem("mcb.dashboard.key", k), key);
  await ctx.addInitScript(initScript);
  const page = await ctx.newPage();
  return { ctx, page };
}

async function measurePage(browser, base, key, id, hash) {
  const out = { page: id };
  // Cold load in a fresh context (empty HTTP cache).
  {
    const { ctx, page } = await newPage(browser, base, key);
    const tap = tapRequests(page);
    await page.addInitScript(() => (window.__perf.navAt = 0));
    await page.goto(`${base}/dashboard${hash}`, { waitUntil: "load" });
    out.firstData = await waitUseful(page, 20_000);
    const nav = await page.evaluate(() => {
      const paint = Object.fromEntries(performance.getEntriesByType("paint").map((e) => [e.name, Math.round(e.startTime)]));
      let js = 0;
      let css = 0;
      let jsFiles = 0;
      for (const r of performance.getEntriesByType("resource")) {
        const size = r.decodedBodySize || r.transferSize || 0;
        if (/\.m?js(\?|$)/.test(r.name)) {
          js += size;
          jsFiles += 1;
        } else if (/\.css(\?|$)/.test(r.name)) css += size;
      }
      return { fcp: paint["first-contentful-paint"] ?? null, js, css, jsFiles };
    });
    Object.assign(out, { fcp: nav.fcp, jsKB: Math.round(nav.js / 1024), cssKB: Math.round(nav.css / 1024), jsFiles: nav.jsFiles });
    // A second load in the same context: what the HTTP cache saves.
    await page.goto(`${base}/dashboard#/home`, { waitUntil: "load" });
    const t0 = Date.now();
    await page.reload({ waitUntil: "load" });
    out.reloadLoadMs = Date.now() - t0;
    tap.reset();
    await ctx.close();
  }
  // Page switch and steady state.
  {
    const { ctx, page } = await newPage(browser, base, key);
    const tap = tapRequests(page);
    await page.goto(`${base}/dashboard#/home`, { waitUntil: "load" });
    await waitUseful(page, 20_000);
    await sleep(500);
    if (id === "home") {
      await switchTo(page, "#/orders");
      await sleep(800);
    } else {
      // Hover the menu item first, as a person would (lets a prefetch start), then switch.
      await page.hover(`#nav a[data-page="${hash.split("/")[1].split("?")[0]}"]`, { timeout: 2000 }).catch(() => {});
      await sleep(120);
    }
    out.switchFirst = await switchTo(page, hash);
    await sleep(1500);
    out.switchBack = await switchTo(page, id === "home" ? "#/orders" : "#/home");
    await sleep(800);
    out.switchCached = await switchTo(page, hash);
    await sleep(1000);
    await page.evaluate(() => {
      window.__perf.longTasks.length = 0;
      window.__perf.cellSamples.length = 0;
    });
    tap.reset();
    out.heapStartKB = await heapKB(page);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Performance.enable");
    const m0 = await metrics(cdp);
    const before = await brokerCalls(base, key);
    const t0 = Date.now();
    if (TRACE > 0 && TRACE < SECONDS) {
      Object.assign(out, await traceRender(browser, page, TRACE));
      await sleep(SECONDS * 1000 - (Date.now() - t0));
    } else await sleep(SECONDS * 1000);
    const after = await brokerCalls(base, key);
    const m1 = await metrics(cdp);
    const secs = (Date.now() - t0) / 1000;
    out.mainMsPerS = Math.round(((m1.TaskDuration - m0.TaskDuration) * 1000) / secs);
    out.scriptMsPerS = Math.round(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / secs);
    out.heapEndKB = await heapKB(page);
    const mins = (Date.now() - t0) / 60_000;
    const reqs = tap.since(t0);
    const perf = await page.evaluate(() => ({ longTasks: window.__perf.longTasks, cells: window.__perf.cellSamples }));
    out.restPerMin = Math.round(reqs.length / mins);
    out.duplicates = tap.dups();
    out.duplicateUrls = tap.dupUrls();
    out.brokerPerMinRaw = Math.round((after.calls - before.calls) / mins);
    out.brokerByClass = diffClass(before, after);
    out.longTasks = perf.longTasks.length;
    out.longTaskMs = Math.round(perf.longTasks.reduce((a, b) => a + b.ms, 0));
    out.longTaskMax = Math.round(Math.max(0, ...perf.longTasks.map((l) => l.ms)));
    out.tickToCell = { n: perf.cells.length, p50: pct(perf.cells, 50), p95: pct(perf.cells, 95), max: pct(perf.cells, 100), samples: perf.cells.map(Math.round) };
    const top = new Map();
    for (const r of reqs) top.set(r.k.split("?")[0], (top.get(r.k.split("?")[0]) ?? 0) + 1);
    out.topRequests = Object.fromEntries([...top].sort((a, b) => b[1] - a[1]).slice(0, 6));
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `${id}.png`) });
    }
    await ctx.close();
  }
  return out;
}

async function busiest(browser, base, key) {
  const tabs = [];
  for (const hash of ["#/chain", "#/oi/strike", "#/strategy", "#/screeners/events"]) {
    const p = await newPage(browser, base, key);
    await p.page.goto(`${base}/dashboard${hash}`, { waitUntil: "load" });
    tabs.push(p);
  }
  await sleep(4000);
  const before = await brokerCalls(base, key);
  const t0 = Date.now();
  await sleep(BUSY * 1000);
  const after = await brokerCalls(base, key);
  const mins = (Date.now() - t0) / 60_000;
  for (const t of tabs) await t.ctx.close();
  return { seconds: BUSY, brokerCalls: after.calls - before.calls, brokerPerMinRaw: Math.round((after.calls - before.calls) / mins), byClass: diffClass(before, after) };
}

/**
 * JS heap over SOAK minutes: every page in SOAK_PAGES open in its own browser (its own renderer process, so the heaps do
 * not mix), heap after a forced GC at 1 minute and at the end. "cycle" switches page every 4 s through every page.
 */
async function soak(base, key) {
  const { chromium } = loadPlaywright();
  const runs = [];
  for (const id of SOAK_PAGES) {
    const browser = await chromium.launch();
    const { ctx, page } = await newPage(browser, base, key);
    const hash = id === "cycle" ? "#/home" : PAGES.find((p) => p[0] === id)[1];
    await page.goto(`${base}/dashboard${hash}`, { waitUntil: "load" });
    runs.push({ id, browser, ctx, page });
  }
  let stop = false;
  const cyc = runs.find((r) => r.id === "cycle");
  const cycling = (async () => {
    if (!cyc) return 0;
    let n = 0;
    while (!stop) {
      for (const [, hash] of PAGES) {
        if (stop) break;
        await cyc.page.evaluate((h) => (location.hash = h), hash).catch(() => {});
        n += 1;
        await sleep(4000);
      }
    }
    return n;
  })();
  await sleep(60_000);
  for (const r of runs) {
    if (r.id === "cycle") await r.page.evaluate(() => (location.hash = "#/home"));
    await sleep(r.id === "cycle" ? 1500 : 0);
    r.heap1 = await heapKB(r.page);
    r.nodes1 = await r.page.evaluate(() => document.getElementsByTagName("*").length);
  }
  await sleep(SOAK * 60_000 - 60_000);
  stop = true;
  const switches = await cycling;
  const out = {};
  for (const r of runs) {
    if (r.id === "cycle") {
      await r.page.evaluate(() => (location.hash = "#/home"));
      await sleep(1500);
    }
    const heapEnd = await heapKB(r.page);
    const nodesEnd = await r.page.evaluate(() => document.getElementsByTagName("*").length);
    out[r.id] = { heap1minKB: r.heap1, heapEndKB: heapEnd, growthKB: heapEnd - r.heap1, nodes1min: r.nodes1, nodesEnd, ...(r.id === "cycle" ? { switches } : {}) };
    console.error(`soak ${r.id}: ${JSON.stringify(out[r.id])}`);
    await r.browser.close();
  }
  return { minutes: SOAK, pages: out };
}

async function idleRate(base, key) {
  const before = await brokerCalls(base, key);
  const t0 = Date.now();
  await sleep(IDLE * 1000);
  const after = await brokerCalls(base, key);
  return { seconds: IDLE, brokerPerMin: Math.round((after.calls - before.calls) / ((Date.now() - t0) / 60_000)), byClass: diffClass(before, after) };
}

async function main() {
  let bridge;
  if (arg("base")) bridge = { base: arg("base"), key: arg("key") ?? process.env.MCB_API_KEY, stop: async () => {} };
  else bridge = await startBridge();
  if (!bridge.key) throw new Error("Give --key with --base.");
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const result = { at: new Date().toISOString(), node: process.version, seconds: SECONDS, latencyMs: arg("base") ? null : LATENCY, pages: [] };
  try {
    // Let the demo Bridge settle (instrument master, recorder plan) before measuring anything.
    await sleep(3000);
    result.idle = await idleRate(bridge.base, bridge.key);
    console.error(`idle: ${JSON.stringify(result.idle)}`);
    for (const [id, hash] of PAGES) {
      if (ONLY.length && !ONLY.includes(id)) continue;
      const r = await measurePage(browser, bridge.base, bridge.key, id, hash);
      r.brokerPerMinNet = Math.max(0, r.brokerPerMinRaw - result.idle.brokerPerMin);
      console.error(JSON.stringify(r));
      result.pages.push(r);
    }
    if (!ONLY.length || ONLY.includes("busy")) {
      result.busiest = await busiest(browser, bridge.base, bridge.key);
      result.busiest.brokerPerMinNet = Math.max(0, result.busiest.brokerPerMinRaw - result.idle.brokerPerMin);
      console.error(`busiest: ${JSON.stringify(result.busiest)}`);
    }
    if (SOAK > 0) result.soak = await soak(bridge.base, bridge.key);
  } finally {
    await browser.close();
    await bridge.stop();
  }
  const text = JSON.stringify(result, null, 2);
  if (OUT) writeFileSync(OUT, text);
  console.log(text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
