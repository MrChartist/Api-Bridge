#!/usr/bin/env node
// Regenerates docs/screenshots/*.webp and manifest.json from a throwaway demo Bridge.
//
//   node scripts/capture-screenshots.mjs [--out docs/screenshots] [--only home,scanner]
//   node scripts/capture-screenshots.mjs --gallery-only     rewrite README.md from manifest.json
//
// Needs Playwright with Chromium (npx playwright install chromium). Everything runs in a temporary
// folder on a free port: demo data only, no broker, no network calls (backup data is switched off).
// Images are encoded to WebP inside Chromium, so no image tooling is needed.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "mc-bridge.mjs");
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const OUT = resolve(ROOT, flag("--out", "docs/screenshots"));
const ONLY = flag("--only", "")
  .split(",")
  .filter(Boolean);

const DESKTOP = { width: 1600, height: 1000 };
const MOBILE = { width: 390, height: 844 };
const THEMES = ["dark", "light"];

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

function run(cmd, argv, opts) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => (code === 0 ? res(out) : rej(new Error(`${argv.join(" ")} exited ${code}\n${out}`))));
  });
}

async function startBridge() {
  const dir = mkdtempSync(join(tmpdir(), "mcb-shots-"));
  const env = { ...process.env, MCB_HOME: dir, MCB_MASTER_KEY_FILE: join(dir, "master.key"), NO_COLOR: "1" };
  delete env.MCB_CONFIG;
  const initOut = await run(process.execPath, [CLI, "init", "--yes", "--demo"], { cwd: dir, env });
  const adminKey = initOut.match(/mcb_[A-Za-z0-9_-]+/)?.[0];
  if (!adminKey) throw new Error(`could not read the admin key from init:\n${initOut}`);

  const cfgPath = join(dir, "bridge.config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const port = await freePort();
  cfg.server.port = port;
  cfg.logging = { level: "warn" };
  cfg.backup = { ...cfg.backup, enabled: false };
  cfg.mcp = { ...cfg.mcp, toolsets: ["market", "analytics", "account", "orders"], orderAccounts: ["demo-paper"] };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const proc = spawn(process.execPath, [CLI, "start", "--demo", "--config", cfgPath], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`Bridge exited early:\n${log}`);
    try {
      if ((await fetch(`${base}/v1/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const stop = async () => {
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  };
  return { base, adminKey, account: cfg.accounts[0].id, stop };
}

/** Puts some realistic traffic, keys and one AI ticket into the demo Bridge. */
async function seed({ base, adminKey, account }) {
  const call = async (method, path, body, key = adminKey, headers = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  const keys = {};
  for (const [label, scopes] of [
    ["Excel sheet", ["read"]],
    ["Python strategy", ["read", "paper"]],
    ["Claude Desktop", ["read", "paper"]],
    ["Alert webhooks", ["paper"]],
  ]) {
    const r = await call("POST", "/v1/keys", { label, scopes });
    keys[label] = r?.data?.key;
    if (!keys[label]) console.warn(`  seed: key "${label}" not created: ${JSON.stringify(r).slice(0, 200)}`);
  }
  const accounts = (await call("GET", "/v1/accounts"))?.data ?? [];
  const paper = accounts.find((a) => a.broker === "paper")?.id ?? account;
  const py = keys["Python strategy"] ?? adminKey;
  const xl = keys["Excel sheet"] ?? adminKey;
  for (let i = 0; i < 3; i++) {
    await call("GET", "/v1/ltp?symbols=NSE:RELIANCE,NSE:INFY,NSE:NIFTY", null, xl);
    await call("GET", "/v1/quotes?symbols=NSE:HDFCBANK,NSE:TCS", null, py);
  }
  await call("GET", "/v1/history?symbol=NSE:NIFTY&interval=1d&countback=120", null, py);
  await call("GET", "/v1/depth?symbol=NSE:RELIANCE", null, py);
  // Demo prices drift with the clock, so price the limit ticket off the current LTP (inside the price band).
  const ltp = (await call("GET", "/v1/ltp?symbols=NSE:RELIANCE", null, py))?.data ?? [];
  const near = (sym, pct) => {
    const v = ltp.find?.((x) => x.symbol === sym)?.ltp;
    return typeof v === "number" ? Math.round(v * (1 - pct / 100) * 10) / 10 : undefined;
  };
  const placed = await call("POST", "/v1/orders", { account: paper, symbol: "NSE:INFY", side: "BUY", quantity: 10, product: "CNC", orderType: "MARKET" }, py);
  if (!placed?.data) console.warn(`  seed: paper order failed: ${JSON.stringify(placed).slice(0, 200)}`);

  const claude = keys["Claude Desktop"] ?? adminKey;
  const ticket = await call(
    "POST",
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "prepare_order", arguments: { account: paper, symbol: "NSE:RELIANCE", side: "BUY", quantity: 5, product: "CNC", orderType: "LIMIT", price: near("NSE:RELIANCE", 0.5) } },
    },
    claude,
    { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
  );
  if (!ticket?.result || ticket.result.isError) console.warn(`  seed: prepare_order failed: ${JSON.stringify(ticket).slice(0, 300)}`);
}

const manifest = [];
const PAGE_ORDER = ["login", "home", "accounts", "console", "limits", "scanner", "orders", "safety", "keys", "integrations", "activity"];
const KIND = (f) => (f.startsWith("mobile-") ? 2 : f.startsWith("feature-") ? 1 : 0);
/** Dashboard order: plain pages, then features, then phone; nav order within each. */
const byNav = (a, b) => KIND(a.file) - KIND(b.file) || PAGE_ORDER.indexOf(a.page) - PAGE_ORDER.indexOf(b.page) || a.file.localeCompare(b.file);

/** docs/screenshots/README.md: every shot from the manifest, grouped dark / light / features / phone. */
function writeGallery(list) {
  const groups = [
    ["Dark theme", (e) => !e.file.startsWith("feature-") && !e.file.startsWith("mobile-") && e.theme === "dark"],
    ["Light theme", (e) => !e.file.startsWith("feature-") && !e.file.startsWith("mobile-") && e.theme === "light"],
    ["Features", (e) => e.file.startsWith("feature-")],
    ["On a phone", (e) => e.file.startsWith("mobile-")],
  ];
  const out = [
    "# Dashboard screenshots",
    "",
    "Every screenshot was taken from a Bridge running in **demo mode** (`npm start -- --demo`): the prices are sample data generated on the computer, not live market data, which is why each page shows the DEMO DATA banner. Desktop shots are 1600 x 1000 (full page where the page is longer); phone shots are 390 x 844 at 2x. The list with sizes is in [manifest.json](manifest.json).",
    "",
    "They are made by `node scripts/capture-screenshots.mjs`, which starts a throwaway demo Bridge, puts some traffic, keys and an AI-prepared ticket into it, and drives the dashboard with Playwright. Run it again after any dashboard change.",
  ];
  for (const [heading, pick] of groups) {
    const rows = list.filter(pick).sort(byNav);
    if (!rows.length) continue;
    out.push("", `## ${heading}`);
    for (const e of rows) {
      const theme = e.file.startsWith("feature-") && !/-(dark|light)\.webp$/.test(e.file) ? "" : ` (${e.theme})`;
      out.push("", `### ${e.title}${theme}`, "", e.description, "", `![${e.title}](${e.file})`);
    }
  }
  writeFileSync(join(OUT, "README.md"), `${out.join("\n")}\n`);
}

async function main() {
  if (args.includes("--gallery-only")) {
    writeGallery(JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8")));
    return;
  }
  // A project install first, then a global one (require() honours NODE_PATH; import() does not).
  const { chromium } = await import("playwright").catch(() => createRequire(import.meta.url)("playwright"));
  const bridge = await startBridge();
  console.log(`demo Bridge on ${bridge.base}`);
  const browser = await chromium.launch();
  try {
    await seed(bridge);
    mkdirSync(OUT, { recursive: true });
    const encoder = await browser.newPage();

    const save = async (page, file, meta, { fullPage = true } = {}) => {
      if (ONLY.length && !ONLY.some((o) => file.startsWith(o) || file.includes(`-${o}`))) return;
      await page.mouse.move(0, 0);
      await page.waitForTimeout(450); // let entrance animations settle
      // A tall page is shot by growing the window to fit it, so the sidebar runs the full height too.
      const vp0 = page.viewportSize();
      const tall = fullPage ? await page.evaluate(() => document.documentElement.scrollHeight) : 0;
      if (tall > vp0.height) {
        await page.setViewportSize({ width: vp0.width, height: tall });
        await page.waitForTimeout(250);
      }
      const png = await page.screenshot({ animations: "disabled" });
      if (tall > vp0.height) await page.setViewportSize(vp0);
      const webp = await encoder.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return { data: c.toDataURL("image/webp", 0.86).split(",")[1], w: c.width, h: c.height };
      }, png.toString("base64"));
      writeFileSync(join(OUT, file), Buffer.from(webp.data, "base64"));
      const vp = vp0;
      const scale = meta.mobile ? 2 : 1;
      manifest.push({
        file,
        title: meta.title,
        page: meta.page,
        theme: meta.theme,
        viewport: `${meta.mobile ? "mobile" : "desktop"} ${vp.width}x${vp.height}`,
        width: webp.w / scale,
        height: webp.h / scale,
        description: meta.description,
      });
      console.log(`  ${file} (${webp.w}x${webp.h})`);
    };

    for (const theme of THEMES) {
      for (const mobile of [false, true]) {
        const ctx = await browser.newContext({
          viewport: mobile ? MOBILE : DESKTOP,
          deviceScaleFactor: mobile ? 2 : 1,
          colorScheme: theme,
          reducedMotion: "no-preference",
        });
        await ctx.addInitScript((t) => localStorage.setItem("mcb.dashboard.theme", t), theme);
        const page = await ctx.newPage();
        const go = async (hash, waitFor) => {
          await page.goto(`${bridge.base}/dashboard#${hash}`);
          await page.waitForLoadState("networkidle").catch(() => {});
          if (waitFor) await page.locator(waitFor).first().waitFor({ timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(500);
        };
        await page.goto(`${bridge.base}/dashboard`);
        await page.locator("#key-input").waitFor();
        const m = (page_, title, description, extra = {}) => ({ page: page_, title, description, theme, mobile, ...extra });
        if (!mobile) await save(page, `login-${theme}.webp`, m("login", "Sign in", "Sign-in screen: paste the admin key printed once by mc-bridge init. The key stays in this browser tab."), { fullPage: false });
        await page.fill("#key-input", bridge.adminKey);
        await page.keyboard.press("Enter");
        await page.locator("nav a[data-page]:visible").first().waitFor();

        if (mobile) {
          const prefix = "mobile-";
          await go("/home");
          await save(page, `${prefix}home-${theme}.webp`, m("home", "Home on a phone", "Home at phone width: the sidebar becomes a floating tab bar and cards stack."), { fullPage: false });
          await go("/console");
          await save(page, `${prefix}console-${theme}.webp`, m("console", "Test console on a phone", "Test console at phone width."), { fullPage: false });
          await go("/scanner");
          await save(page, `${prefix}scanner-${theme}.webp`, m("scanner", "Scanner on a phone", "Scanner at phone width: condition, universe and example buttons wrap cleanly."), { fullPage: false });
          await go("/integrations?tab=python");
          await save(page, `${prefix}integrations-${theme}.webp`, m("integrations", "Integrations on a phone", "Integrations at phone width, with copy-paste snippets."), { fullPage: false });
          await go("/safety");
          await save(page, `${prefix}safety-${theme}.webp`, m("safety", "Safety on a phone", "Safety at phone width: the kill switch is one tap away."), { fullPage: false });
          await ctx.close();
          continue;
        }

        await go("/home");
        await save(page, `home-${theme}.webp`, m("home", "Home", "Home: welcome checklist, market snapshot, broker accounts, calls saved and safety status."));
        await go("/accounts");
        await save(page, `accounts-${theme}.webp`, m("accounts", "Accounts", "Accounts: connected broker accounts with session state, and the directory of 41 supported brokers."), { fullPage: false });

        await go("/console");
        const sel = page.getByLabel("Endpoint");
        await sel.selectOption("quotes").catch(() => {});
        await page.getByRole("button", { name: "Send request" }).click().catch(() => {});
        await page.waitForTimeout(900);
        await save(page, `console-${theme}.webp`, m("console", "Test console", "Test console: pick an endpoint, send it, and see the response, status and timing."), { fullPage: false });
        if (theme === "dark") {
          await sel.selectOption("optionchain").catch(() => {});
          await page.getByRole("button", { name: "Send request" }).click().catch(() => {});
          await page.waitForTimeout(1200);
          await save(page, "feature-test-console-option-chain.webp", m("console", "Option chain in the test console", "The test console calling the option chain endpoint on demo data."), { fullPage: false });
        }

        await go("/limits");
        await page.getByRole("button", { name: /Send 20 identical requests/ }).click().catch(() => {});
        await page.waitForTimeout(1500);
        await save(page, `limits-${theme}.webp`, m("limits", "Rate limits", "Rate limits: live per-endpoint budgets for each account and the calls the Bridge saved through streaming, caching, coalescing and batching."));
        if (theme === "dark") await save(page, "feature-rate-limit-usage.webp", m("limits", "Rate-limit usage", "Per-endpoint budget bars after a burst of identical requests: most were coalesced into one broker call."), { fullPage: false });

        await go("/scanner");
        await save(page, `scanner-${theme}.webp`, m("scanner", "Scanner", "Scanner: a readable condition, a universe and the accounts it is shared across."), { fullPage: false });
        await page.getByRole("button", { name: "Run scan" }).click().catch(() => {});
        await page.getByText(/completed · \d+\/\d+ symbols/).first().waitFor({ timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(800);
        await save(page, `feature-scanner-results-${theme}.webp`, m("scanner", "Scan results", "A finished scan: matched symbols with their values, progress per account and the calls it cost."));

        await go("/orders");
        await save(page, `orders-${theme}.webp`, m("orders", "Orders", "Orders: an AI-prepared ticket waiting for confirmation, open orders and positions on the paper account."));
        if (theme === "dark") {
          await page.getByRole("button", { name: "Review" }).first().click().catch(() => {});
          await page.waitForTimeout(600);
        }
        if (theme === "dark") await save(page, "feature-ai-ticket-confirmation.webp", m("orders", "AI ticket confirmation", "An order prepared by Claude through MCP waits here; nothing is sent until you check every field and confirm."), { fullPage: false });
        if (theme === "dark") await page.keyboard.press("Escape");

        await go("/safety");
        await save(page, `safety-${theme}.webp`, m("safety", "Safety", "Safety: kill switch, daily limits, live-trading status and audit-log verification."));
        if (theme === "dark") {
          await page.locator("#kill-action").click();
          await page.waitForTimeout(500);
          await save(page, "feature-kill-switch-dialog.webp", m("safety", "Kill switch sheet", "Engaging the kill switch: a sheet asks for a reason and whether to cancel open orders."), { fullPage: false });
          const dlg = page.locator("dialog[open], .sheet").last();
          await dlg.getByRole("button", { name: /stop all orders|engage|stop/i }).last().click().catch(() => {});
          await page.waitForTimeout(800);
          await save(page, "feature-kill-switch-engaged.webp", m("safety", "Kill switch engaged", "With the kill switch on, every order route refuses until an admin releases it."), { fullPage: false });
          await page.locator("#kill-action").click().catch(() => {});
          await page.waitForTimeout(400);
          const sheet = page.locator("dialog[open], .sheet").last();
          await sheet.getByPlaceholder("RELEASE").fill("RELEASE").catch(() => {});
          await sheet.getByRole("button", { name: "Release", exact: true }).click().catch(() => {});
          await page.waitForTimeout(800);
        }

        await go("/keys");
        await save(page, `keys-${theme}.webp`, m("keys", "API keys", "API keys: one key per tool with only the scopes and accounts it needs."));
        if (theme === "dark") {
          await page.getByPlaceholder(/Excel prices/).fill("Strategy notebook").catch(() => {});
          await page.waitForTimeout(300);
          await save(page, "feature-keys-scopes.webp", m("keys", "Key scopes", "Creating a key: choose its access, the accounts it can use, the tool it is for and when it expires."), { fullPage: false });
        }

        for (const tab of ["python", "node", "excel", "amibroker", "claude", "chatgpt", "rest", "webhooks"]) {
          await go(`/integrations?tab=${tab}`);
          const name = { python: "Python", node: "Node.js", excel: "Excel", amibroker: "AmiBroker", claude: "Claude", chatgpt: "ChatGPT", rest: "REST", webhooks: "Webhooks" }[tab];
          await save(page, `integrations-${tab}-${theme}.webp`, m("integrations", `Integrations: ${name}`, `Integrations, ${name} tab: copy-paste setup with a key made for that tool.`));
          if (theme === "dark" && ["python", "excel", "claude"].includes(tab)) await save(page, `feature-snippets-${tab}.webp`, m("integrations", `${name} snippet`, `The ${name} snippet, ready to paste.`), { fullPage: false });
        }

        await go("/activity");
        await save(page, `activity-${theme}.webp`, m("activity", "Activity", "Activity: recent requests with the tool, endpoint, status and time each took."));
        if (theme === "dark") await save(page, "feature-request-log.webp", m("activity", "Request log", "The request log: every call with its client, account, status and latency."), { fullPage: false });
        await page.getByRole("tab", { name: "Audit log" }).click().catch(() => {});
        await page.waitForTimeout(700);
        await save(page, `audit-${theme}.webp`, m("activity", "Audit log", "The tamper-evident audit log: key changes, orders and kill-switch actions, hash-chained per day."));

        await go("/home");
        await page.keyboard.press("Control+k");
        await page.waitForTimeout(400);
        await page.keyboard.type("scan");
        await page.waitForTimeout(300);
        await save(page, `feature-command-palette-${theme}.webp`, m("home", "Command palette", "Press Command-K (Ctrl-K) to jump to any page or action from the keyboard."), { fullPage: false });
        await page.keyboard.press("Escape");

        if (theme === "dark") {
          await go("/home");
          await save(page, "feature-welcome-checklist.webp", m("home", "Welcome checklist", "The welcome checklist on Home walks through connecting a broker, making a key, copying a snippet and testing a call."), { fullPage: false });
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    await bridge.stop();
  }

  if (!ONLY.length) {
    manifest.sort(byNav);
    writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeGallery(manifest);
    console.log(`wrote ${manifest.length} screenshots and manifest.json`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
