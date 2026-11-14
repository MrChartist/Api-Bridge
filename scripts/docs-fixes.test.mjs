/**
 * Regression tests for the documentation audit: each one guards a mistake that was in the guides and was fixed.
 * (The guide examples that must run are in guide-examples.test.mjs, the error-code page in troubleshooting.test.mjs.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readText, repoFiles } from "./lib/repo-files.mjs";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const guides = readdirSync(join(ROOT, "docs/guides")).filter((f) => f.endsWith(".md"));
const NOT_TESTS = (f) => !f.endsWith(".test.mjs") && !f.startsWith("node_modules/") && f !== "package-lock.json" && !/^docs\/(llms-full\.txt|search-index\.json)$/.test(f);

describe("running the command (D-01)", () => {
  const CLI_LINE = /(^|[^-/.\w`])mc-bridge (start|init|keys|download|record|collections|subscriptions|accounts|backup|restore|doctor|open|kill|expose|notify|mcp|sources|orders)\b/m;
  const SKIP = new Set(["README.md", "quickstart.md", "faq.md", "compliance.md", "connect.md", "streaming.md", "typescript.md", "paper-margin.md", "compat-api.md", "alert-orders.md"]);

  it("the guides index explains once how to run mc-bridge from a checkout, and not through npx", () => {
    const index = read("docs/guides/README.md");
    expect(index).toMatch(/^## Running mc-bridge$/m);
    expect(index).toMatch(/npm run bridge -- <command>/);
    expect(index).toMatch(/node bin\/mc-bridge\.mjs <command>/);
    expect(index).toMatch(/Do not run it through npx/);
  });

  it("every guide that shows an mc-bridge command points at that explanation near the top", () => {
    const missing = [];
    for (const g of guides.filter((x) => !SKIP.has(x))) {
      const text = read(`docs/guides/${g}`);
      if (!CLI_LINE.test(text)) continue;
      const top = text.split("\n").slice(0, 6).join("\n");
      if (!top.includes("README.md#running-mc-bridge")) missing.push(g);
    }
    expect(missing).toEqual([]);
  });

  it("the guides that are checkout-first use npm run bridge in their own commands", () => {
    expect(read("docs/guides/quickstart.md")).toMatch(/npm run bridge -- keys create/);
    expect(read("README.md")).toMatch(/npm run bridge -- keys create/);
  });
});

describe("Windows (D-02, D-23, D-24)", () => {
  const quick = read("docs/guides/quickstart.md");

  it("the quickstart has a PowerShell form of each step and never uses bare curl there", () => {
    const blocks = [...quick.matchAll(/```powershell\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThanOrEqual(6);
    const all = blocks.join("\n");
    expect(all).toMatch(/Invoke-RestMethod/);
    expect(all).toMatch(/\$env:MCB_API_KEY/);
    expect(all).toMatch(/\$env:MCB_PORT = "4301"/);
    expect(all).not.toMatch(/(^|\s)curl\s/m);
    expect(quick).toMatch(/`curl\.exe`/);
    expect(quick).toMatch(/windows\.md/);
  });

  it("windows.md covers the shell differences and is in the index", () => {
    const w = read("docs/guides/windows.md");
    for (const s of ["Invoke-RestMethod", "curl.exe", "$env:", "icacls", "%APPDATA%\\MrChartist\\Bridge", "alias"]) expect(w, s).toContain(s);
    expect(read("docs/guides/README.md")).toContain("[windows.md](windows.md)");
  });

  it("icacls is shown for both shells (the %USERNAME% form alone fails in PowerShell)", () => {
    const safety = read("docs/guides/safety.md");
    expect(safety).toMatch(/\$\{env:USERNAME\}/);
    expect(safety).toMatch(/%USERNAME%/);
  });

  it("the AmiBroker key file is read from the Bridge's own Windows folder first and the old path still works", () => {
    const afl = read("integrations/amibroker/mrchartist-bridge.afl");
    expect(afl.indexOf("APPDATA")).toBeGreaterThan(-1);
    expect(afl.indexOf("APPDATA")).toBeLessThan(afl.indexOf("USERPROFILE\") +"));
    expect(afl).toContain("USERPROFILE");
    expect(read("docs/guides/amibroker.md")).toMatch(/%APPDATA%\\MrChartist\\Bridge\\amibroker\.key/);
  });
});

describe("one name for the address variable (D-16)", () => {
  it("MCB_URL appears nowhere: every tool reads MCB_BRIDGE_URL", () => {
    const hits = repoFiles().filter(NOT_TESTS).filter((f) => /\bMCB_URL\b/.test(readText(f) ?? ""));
    expect(hits).toEqual([]);
  });

  it("the quickstart's examples use the variable and the Node guide mentions it", () => {
    const quick = read("docs/guides/quickstart.md");
    expect(quick).toMatch(/\$MCB_BRIDGE_URL\/v1\/health/);
    expect(quick).not.toMatch(/curl -s[^\n]*http:\/\/127\.0\.0\.1:4300/);
    expect(read("docs/guides/typescript.md")).toMatch(/MCB_BRIDGE_URL/);
  });
});

describe("the auth contract (D-07) and the 429 sample (D-21)", () => {
  it("quickstart, developers and the OpenAPI file all say X-API-Key is accepted", () => {
    const quick = read("docs/guides/quickstart.md");
    expect(quick).not.toMatch(/`X-API-Key`, is not accepted/);
    expect(quick).toMatch(/`X-API-Key: <key>` is\)/);
    expect(read("docs/guides/developers.md")).toMatch(/`X-API-Key: mcb_<id>_<secret>`/);
    expect(read("docs/openapi.yaml")).toMatch(/\(or `X-API-Key`\)/);
  });

  it("the quickstart's Retry-After is never below the wait in its own body, and says how the header is made", () => {
    const quick = read("docs/guides/quickstart.md");
    const header = Number(/Retry-After: (\d+)/.exec(quick)?.[1]);
    const ms = Number(/"retryAfterMs":(\d+)/.exec(quick)?.[1]);
    expect(header).toBeGreaterThanOrEqual(Math.ceil(ms / 1000));
    expect(header).toBeLessThanOrEqual(Math.ceil((ms * 1.25) / 1000));
    expect(quick).toMatch(/rounded up to whole seconds with up to a quarter more/);
  });
});

describe("what the guides say about the product (D-12, D-13, D-22)", () => {
  it("the FAQ broker counts are the ones in server/brokers/verification.json", () => {
    const v = JSON.parse(read("server/brokers/verification.json"));
    const levels = Object.values(v.brokers).map((b) => b.level);
    const n = (l) => levels.filter((x) => x === l).length;
    const faq = read("docs/guides/faq.md");
    expect(faq).toContain(`${levels.length} brokers are supported`);
    expect(faq).toMatch(new RegExp(`${n("live-verified")} is \\*\\*live-verified\\*\\*`));
    expect(faq).toMatch(new RegExp(`${n("contract")} are \\*\\*contract-tested\\*\\*`));
    expect(faq).toMatch(new RegExp(`${n("beta")} are\\s+\\*\\*beta\\*\\*`));
    expect(faq).not.toMatch(/The other 40 are \*\*beta\*\*/);
  });

  it("telegram.md no longer says there is no backup job, and lists the backup message", () => {
    const t = read("docs/guides/telegram.md");
    expect(t).not.toMatch(/has no backup job/);
    expect(t).toMatch(/A backup could not be written/);
  });

  it("accounts.md and notifications.md both say the two morning reminders are independent", () => {
    const a = read("docs/guides/accounts.md");
    const n = read("docs/guides/notifications.md");
    for (const t of [a, n]) {
      expect(t).toMatch(/morningLogin\.remindAt/);
      expect(t).toMatch(/notify\.morning\.at|`morning\.at`/);
    }
    expect(a).toMatch(/independent/);
    expect(n).toMatch(/separate/);
  });
});

describe("pages that name the API page (D-04)", () => {
  it("each guide that sends people to API > ... says how to get there from the Simple view", () => {
    for (const g of ["telegram", "webhooks", "expose-alerts", "excel-sheets", "connect"]) {
      expect(read(`docs/guides/${g}.md`), g).toMatch(/Simple view/);
    }
    expect(read("docs/guides/connect.md")).toMatch(/Looking for the API page\?/);
  });
});

describe("the key in an address (D-03, D-05)", () => {
  it("excel-sheets.md gives the exact command with --allow-query and says never to use IMPORTDATA with a key", () => {
    const x = read("docs/guides/excel-sheets.md");
    expect(x).toContain("mc-bridge keys create --label excel --scope read --allow-query --expires 90d");
    expect(x).toMatch(/is the one thing not to do/);
    expect(x).toMatch(/may not be sent in a web address/);
  });

  it("the Connect guide and the Excel guide agree: Sheets is the Apps Script with the key in a script property", () => {
    expect(read("docs/guides/connect.md")).toMatch(/never an `IMPORTDATA` link/);
    expect(read("docs/guides/excel-sheets.md")).toMatch(/key in a script property/);
  });
});

describe("the command line page (D-11)", () => {
  const cli = read("docs/guides/cli.md");
  it("says which commands need no key, the control token, a read key or an admin key, and that an exported read key does not stop kill release", () => {
    for (const s of ["control token", "MCB_ADMIN_KEY", "admin key", "`kill release`"]) expect(cli, s).toContain(s);
    expect(cli).toMatch(/does\s+\*\*not\*\* stop `kill` and `kill release`/);
    expect(read("docs/guides/README.md")).toContain("[cli.md](cli.md)");
  });

  it("every command group it names is in mc-bridge --help", () => {
    const help = readFileSync(join(ROOT, "server/bridge/core/cli.mjs"), "utf8");
    for (const cmd of ["init", "start", "open", "keys", "accounts", "doctor", "expose", "backup", "restore", "kill", "orders acknowledge-state", "mcp", "openai-tools", "sources", "notify", "collections", "subscriptions", "download", "record"]) {
      expect(help, cmd).toContain(`mc-bridge ${cmd}`);
    }
  });
});
