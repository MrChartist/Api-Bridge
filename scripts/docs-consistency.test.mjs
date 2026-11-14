import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readText, repoFiles } from "./lib/repo-files.mjs";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const pkg = JSON.parse(read("package.json"));
const mdFiles = repoFiles().filter((f) => f.endsWith(".md") && !f.startsWith("node_modules/") && !f.startsWith("docs/api/"));

describe("the guides index", () => {
  const rows = [...read("docs/guides/README.md").matchAll(/^\| \[([^\]]+)\]\(([^)]+\.md)\) \|/gm)].map((m) => m[2]);

  it("lists every guide exactly once", () => {
    const guides = readdirSync(join(ROOT, "docs/guides")).filter((f) => f.endsWith(".md") && f !== "README.md");
    const seen = new Map();
    for (const r of rows) seen.set(r, (seen.get(r) ?? 0) + 1);
    expect(guides.filter((g) => !seen.has(g))).toEqual([]);
    expect([...seen].filter(([, n]) => n > 1).map(([f]) => f)).toEqual([]);
    expect(rows.filter((r) => !guides.includes(r))).toEqual([]);
  });

  it("the docs home has no two bullets with the same lead-in", () => {
    const leads = read("docs/README.md").split("\n").filter((l) => /^\s*- [A-Z][^:]{3,40}:/.test(l)).map((l) => l.trim().split(":")[0]);
    expect(leads.filter((l, i) => leads.indexOf(l) !== i)).toEqual([]);
  });
});

describe("commands in the docs exist", () => {
  it("every `npm run <script>` in a Markdown file is a script in package.json", () => {
    const missing = [];
    for (const f of mdFiles) {
      for (const m of (readText(f) ?? "").matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
        if (!pkg.scripts[m[1]]) missing.push(`${f}: npm run ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("no doc tells people to run vitest projects or a lint step that do not exist", () => {
    const hits = mdFiles.filter((f) => /vitest run --project|npm run lint\b/.test(readText(f) ?? ""));
    expect(hits).toEqual([]);
  });

  it("the broker checklist and CONTRIBUTING name the same adapter test file", () => {
    expect(read("docs/broker-contract.md")).not.toMatch(/\.contract\.test\.mjs/);
    expect(read("CONTRIBUTING.md")).toContain("server/brokers/<id>.test.mjs");
    expect(readdirSync(join(ROOT, "server/brokers")).filter((f) => f === "dhan.test.mjs")).toHaveLength(1);
  });

  it("CONTRIBUTING lists what CI runs", () => {
    const ci = read(".github/workflows/ci.yml");
    const contributing = read("CONTRIBUTING.md");
    const npmSteps = [...ci.matchAll(/run: (npm run [a-z:]+|npm audit --omit=dev)\s*$/gm)];
    expect(npmSteps.length).toBeGreaterThanOrEqual(3); // typecheck, docs:check and audit at least: the pattern still matches ci.yml
    for (const m of npmSteps) expect(contributing, m[1]).toContain(m[1]);
    for (const m of ci.matchAll(/run: node --test (.+)$/gm)) expect(contributing, m[1]).toContain(`node --test ${m[1].trim()}`);
    for (const m of ci.matchAll(/run: node (scripts\/[\w-]+\.mjs)\s*$/gm)) expect(contributing + read("package.json"), m[1]).toContain(m[1].replace("scripts/check-mjs.mjs", "check:mjs"));
  });
});

describe("the minimum Node.js version is one number everywhere", () => {
  it("package.json, the lockfile and the docs say 22.12", () => {
    expect(pkg.engines.node).toBe(">=22.12");
    for (const f of ["README.md", "CONTRIBUTING.md", "docs/guides/quickstart.md", "docs/guides/vps.md"]) expect(read(f), f).toMatch(/Node\.js 22\.12 or newer/);
    for (const f of mdFiles) expect(readText(f) ?? "", f).not.toMatch(/Node(\.js)? 22\.(?:[0-9]|1[01])\b/);
    expect(read(".github/ISSUE_TEMPLATE/bug_report.yml")).not.toMatch(/Node 22\.(?:[0-9]|1[01])\b/);
  });
});

describe("community files for outside contributors", () => {
  const FILES = ["SECURITY.md", "CONTRIBUTING.md", ".github/pull_request_template.md", ".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/feature_request.yml", ".github/ISSUE_TEMPLATE/config.yml", ".github/ISSUE_TEMPLATE/new_broker.yml"];

  it("exist", () => {
    for (const f of FILES) expect(repoFiles(), f).toContain(f);
  });

  it("carry no e-mail address, phone number or fill-in-later placeholder", () => {
    const bad = [];
    for (const f of FILES) {
      const text = read(f);
      if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text)) bad.push(`${f}: e-mail address`);
      if (/\b(?:TODO|TBD|FIXME|your-email|your\.email|contact@|security@|<email>|\[email\]|example\.com)\b/i.test(text)) bad.push(`${f}: placeholder`);
      if (/\+?\d[\d -]{9,}\d/.test(text.replace(/https?:\/\/\S+/g, ""))) bad.push(`${f}: phone-like number`);
    }
    expect(bad).toEqual([]);
  });

  it("SECURITY.md uses GitHub's private reporting form and give an aim for answering", () => {
    const security = read("SECURITY.md");
    expect(security).toContain("https://github.com/MrChartist/api-bridge-v2/security/advisories/new");
    expect(security).toMatch(/private vulnerability reporting/i);
    expect(security).toMatch(/within 3 working days/);
    expect(security).toMatch(/within 10 working days/);
  });

  it("the bug form covers the newer areas", () => {
    const bug = read(".github/ISSUE_TEMPLATE/bug_report.yml");
    for (const area of ["Telegram", "Events", "Data downloads", "Recorder", "Data sources"]) expect(bug, area).toContain(area);
    expect(read(".github/ISSUE_TEMPLATE/feature_request.yml")).toMatch(/connection layer/);
  });

  it("CONTRIBUTING has a quick path that needs no worktrees and says what the project will not accept", () => {
    const c = read("CONTRIBUTING.md");
    expect(c).toMatch(/## Quick path for a first pull request/);
    expect(c).toMatch(/do \*\*not\*\* need[^.]*worktrees/);
    expect(c).toMatch(/connection layer/);
  });

  it("the README says near the top that it is beta, self-hosted and unaffiliated", () => {
    const top = read("README.md").split("\n").slice(0, 12).join("\n");
    expect(top).toMatch(/Status: beta/);
    expect(top).toMatch(/no hosted service/);
    expect(top).toMatch(/not affiliated with, sponsored by or endorsed by any broker/);
  });
});

describe("deploy/hostinger", () => {
  it("is marked as an optional community recipe, not a hosted offering, and holds no personal data", () => {
    const readme = read("deploy/hostinger/README.md");
    expect(readme.split("\n").slice(0, 6).join("\n")).toMatch(/optional community recipe, not a hosted offering/);
    expect(readme).toMatch(/does not run, host or sell any service/);
    for (const f of repoFiles().filter((p) => p.startsWith("deploy/hostinger/"))) {
      const text = read(f);
      expect(text, f).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/);
      expect(text, f).not.toMatch(/\b(?!127\.|0\.0\.0\.0)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    }
  });
});
