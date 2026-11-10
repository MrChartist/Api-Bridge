import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { errorCatalogue } from "../core/errorCatalogue.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { STARTERS as SERVER_STARTERS } from "../starters/starters.mjs";
import {
  APP_PRESETS, DASHBOARD_KEY_LABEL, ERROR_GROUPS, STARTERS, agoText, appBody, appSnippetGroups, appUseLine, buildApps, defaultAppName, errorGroup, expiryText,
  filterCatalogue, filterRequests, findRoutes, keyPlaceholder, logFilters, presetForScope, presetById, quickStart, quotaText, requestOwner, requestStats,
  routeAccess, sampleProblem, capabilityLines, scopeAdvice, scopeBadge, starterCommand, statusTone,
} from "./developers-core.js";

const NOW = Date.parse("2026-11-09T06:30:00Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

let app;
beforeAll(async () => {
  const { config } = loadConfig({ raw: { dataDir: mkdtempSync(join(tmpdir(), "mcb-devcore-")), logging: { level: "silent" }, server: { port: 0 } }, env: {}, demo: true });
  app = await createApp({ config, logger: createNullLogger() });
});
afterAll(async () => app?.close());

describe("presets: what an app may be", () => {
  it("offers the least access each kind of program needs, and never a live key", () => {
    expect(APP_PRESETS.map((p) => p.id)).toEqual(["read", "paper", "sheet", "assistant", "admin"]);
    for (const p of APP_PRESETS) {
      expect(p.scopes, p.id).not.toContain("live");
      expect(p.can.length, p.id).toBeGreaterThan(0);
      expect(p.cannot.length, p.id).toBeGreaterThan(0);
    }
    expect(presetById("read").scopes).toEqual(["read"]);
    expect(presetById("paper").scopes).toEqual(["paper"]);
    expect(presetById("nope").id).toBe("read");
    expect(APP_PRESETS.find((p) => p.id === "assistant").scopes).not.toContain("admin");
    expect(APP_PRESETS.find((p) => p.id === "admin").expiresDays).toBeLessThanOrEqual(7);
    expect(APP_PRESETS.filter((p) => p.allowQuery).map((p) => [p.id, p.scopes])).toEqual([["sheet", ["read"]]]);
  });

  it("every preset makes a key the real key store accepts, with exactly the preset's scope", async () => {
    for (const p of APP_PRESETS) {
      // The key store checks "expires in the future" against the real clock, so build the expiry from the real clock too.
      const { body } = appBody(p.id, { name: `${p.id} test`, now: new Date() });
      const { record } = await app.deps.keyStore.create(body, { loopback: true });
      expect(record.scopes, p.id).toEqual(p.scopes);
      expect(record.clientKind, p.id).toBe(p.clientKind);
      expect(record.allowQuery, p.id).toBe(p.allowQuery);
      expect(Boolean(record.expiresAt), p.id).toBe(Boolean(p.expiresDays));
    }
  });

  it("appBody: a name is required, expiry follows the preset unless chosen, one account can be chosen", () => {
    expect(appBody("read", { name: "  " }).error).toMatchObject({ field: "label" });
    expect(appBody("read", { name: "x".repeat(61) }).error.message).toMatch(/60 characters/);
    const now = new Date(NOW);
    expect(appBody("read", { name: "bot", now }).body).toMatchObject({ label: "bot", scopes: ["read"], accounts: "*", clientKind: "script", expiresAt: new Date(NOW + 90 * DAY).toISOString() });
    expect(appBody("read", { name: "bot", now, expiresDays: "" }).body.expiresAt).toBeUndefined();
    expect(appBody("read", { name: "bot", now, expiresDays: "30" }).body.expiresAt).toBe(new Date(NOW + 30 * DAY).toISOString());
    expect(appBody("paper", { name: "bot", account: "demo-paper" }).body.accounts).toEqual(["demo-paper"]);
    expect(appBody("sheet", { name: "s" }).body.allowQuery).toBe(true);
    expect(appBody("assistant", { name: "ai", now }).body.expiresAt).toBeUndefined();
  });

  it("names tell apps apart and never repeat", () => {
    const first = defaultAppName("read", new Date("2026-11-09T06:30:00Z"));
    expect(first).toBe("Data app · 9 Nov");
    expect(defaultAppName("read", new Date("2026-11-09T06:30:00Z"), [first])).toBe("Data app · 9 Nov 2");
    expect(defaultAppName("paper", new Date("2026-11-09T06:30:00Z"), [first])).toBe("Practice app · 9 Nov");
  });
});

describe("apps: keys joined with quotas and use", () => {
  const keys = [
    { id: "aaaaaaaaaa", label: "Excel prices", scopes: ["read"], accounts: "*", clientKind: "excel", allowQuery: true, createdAt: iso(5 * DAY), expiresAt: new Date(NOW + 40 * DAY).toISOString(), lastUsedAt: iso(3 * MIN), revokedAt: null },
    { id: "bbbbbbbbbb", label: "Bot", scopes: ["paper", "read"], accounts: ["demo-paper"], clientKind: "script", allowQuery: false, createdAt: iso(2 * DAY), expiresAt: null, lastUsedAt: iso(30 * DAY), revokedAt: null },
    { id: "cccccccccc", label: "Old", scopes: ["read"], accounts: "*", createdAt: iso(90 * DAY), expiresAt: iso(DAY), lastUsedAt: null, revokedAt: null },
    { id: "dddddddddd", label: "Gone", scopes: ["admin"], accounts: "*", createdAt: iso(9 * DAY), expiresAt: null, lastUsedAt: iso(DAY), revokedAt: iso(DAY / 2) },
    { id: "eeeeeeeeee", label: DASHBOARD_KEY_LABEL, scopes: ["admin", "paper"], accounts: "*", createdAt: iso(DAY), expiresAt: null, lastUsedAt: iso(1000), revokedAt: null },
    { id: "ffffffffff", label: "Soon", scopes: ["read"], accounts: "*", createdAt: iso(DAY), expiresAt: new Date(NOW + 3 * DAY).toISOString(), lastUsedAt: iso(2 * 60 * MIN), revokedAt: null },
  ];
  const quotas = {
    keys: [
      { keyId: "aaaaaaaaaa", perSecond: 5, burst: 10, perDay: 5000, usage: { lastMinute: 2, today: 1234, throttledToday: 3 }, source: "override" },
      { keyId: "bbbbbbbbbb", perSecond: 50, burst: 50, perDay: null, usage: { lastMinute: 0, today: 1, throttledToday: 0 }, source: "default" },
    ],
  };
  const apps = buildApps({ keys, quotas, now: NOW, ownKeyId: "bbbbbbbbbb" });

  it("leaves out the dashboard's own sign-in key, and sorts usable apps first by last use, revoked last", () => {
    expect(apps.map((a) => a.id)).toEqual(["aaaaaaaaaa", "ffffffffff", "bbbbbbbbbb", "cccccccccc", "dddddddddd"]);
  });

  it("says each app's status, scope, expiry, last use and quota in words", () => {
    const [excel, soon, bot, old, gone] = apps;
    expect(excel).toMatchObject({ name: "Excel prices", statusText: "Active", lastUsedText: "3 min ago", requestsToday: 1234, throttledToday: 3, quotaCustom: true, usable: true });
    expect(excel.badge).toEqual({ id: "read", word: "Read only", tone: "info" });
    expect(excel.expiryText).toBe("expires in 40 days");
    expect(excel.quotaText).toMatch(/^5 a second, burst 10, 5,?000 a day$/);
    expect(soon).toMatchObject({ status: "expiring", statusText: "Expires soon", expiryText: "expires in 3 days" });
    expect(bot).toMatchObject({ own: true, accountsText: "demo-paper", expiryText: "no expiry", lastUsedText: "on 10 Oct" });
    expect(bot.badge.word).toBe("Paper orders");
    expect(old).toMatchObject({ status: "expired", usable: false, lastUsedText: "never", requestsToday: 0 });
    expect(old.expiryText).toMatch(/^expired /);
    expect(gone).toMatchObject({ status: "revoked", usable: false, expiryText: "revoked" });
    expect(gone.badge.word).toBe("Admin");
  });

  it("describes use on one line, and honestly when there is none", () => {
    expect(appUseLine(apps[0])).toMatch(/^Last used 3 min ago · 1,?234 requests today, 3 slowed down$/);
    expect(appUseLine(apps[2])).toBe("Last used on 10 Oct · 1 request today");
    expect(appUseLine(apps[3])).toBe("Never used yet · no requests today");
    expect(appUseLine(apps[4])).toBe("Revoked. It no longer works.");
  });

  it("copes with no keys, no quotas and odd values", () => {
    expect(buildApps({})).toEqual([]);
    expect(buildApps({ keys: [{ id: "x", label: "k", scopes: ["read"] }], now: NOW })[0]).toMatchObject({ requestsToday: 0, quotaText: "default quota", status: "active", accountsText: "all accounts" });
    expect(agoText("garbage")).toBe("never");
    expect(agoText(null)).toBe("never");
    expect(agoText(iso(10_000), NOW)).toBe("just now");
    expect(agoText(iso(5 * 60 * MIN), NOW)).toBe("5 h ago");
    expect(expiryText(null, NOW)).toBe("no expiry");
    expect(expiryText(new Date(NOW + 10 * MIN).toISOString(), NOW)).toBe("expires within the hour");
    expect(expiryText(new Date(NOW + 5 * 60 * MIN).toISOString(), NOW)).toBe("expires in 5 h");
    expect(quotaText(null)).toBe("default quota");
    expect(scopeBadge([]).id).toBe("read");
    expect(scopeBadge(["read", "admin"]).id).toBe("admin");
  });
});

describe("snippets with the real address", () => {
  const base = "http://127.0.0.1:4467";
  const readApp = { id: "aaaaaaaaaa", scopes: ["read"], allowQuery: false, clientKind: "script" };

  it("fill in this Bridge's address and the app's key id, never a real secret, and say where the secret goes", () => {
    const groups = appSnippetGroups(readApp, { base });
    expect(groups.map((g) => g.id)).toEqual(["curl", "node", "python"]);
    const all = JSON.stringify(groups);
    expect(all).toContain(base);
    expect(all).toContain(keyPlaceholder(readApp));
    expect(keyPlaceholder(readApp)).toBe("mcb_aaaaaaaaaa_PASTE_THE_SECRET_HERE");
    expect(all).not.toMatch(/mcb_[a-z2-7]{10}_[A-Za-z0-9_-]{43}/);
  });

  it("use the real key right after it is created, and leave order lines out of a read key's examples", () => {
    const key = "mcb_aaaaaaaaaa_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-_abcde";
    const groups = appSnippetGroups(readApp, { base, key });
    expect(JSON.stringify(groups)).toContain(key);
    expect(JSON.stringify(groups)).not.toMatch(/place_order|placeOrder/);
    const paper = appSnippetGroups({ ...readApp, scopes: ["paper"] }, { base, key });
    expect(JSON.stringify(paper)).toMatch(/place_order/);
  });

  it("add Excel only for a key that may sit in a web address, and AI settings only for an assistant key", () => {
    expect(appSnippetGroups({ ...readApp, allowQuery: true }, { base }).map((g) => g.id)).toContain("excel");
    expect(appSnippetGroups({ ...readApp, clientKind: "mcp" }, { base }).map((g) => g.id)).toContain("assistant");
    expect(appSnippetGroups(readApp, { base }).map((g) => g.id)).not.toContain("excel");
  });

  it("the quick start has three steps with the real address", () => {
    const steps = quickStart({ base, cli: "npm run bridge --" });
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(steps[0].code).toBe(`curl ${base}/v1/health`);
    expect(steps[2].code).toContain(`${base}/v1/ltp?symbols=NSE:RELIANCE`);
    expect(steps[2].code).toContain("Authorization: Bearer $BRIDGE_KEY");
    expect(steps[2].code).not.toMatch(/\?key=|&key=/);
    expect(quickStart({ base, haveApps: true })[1].title).toMatch(/Use an app/);
  });

  it("lists the same starters the command line has", () => {
    expect(STARTERS.map((s) => s.id)).toEqual(SERVER_STARTERS.map((s) => s.id));
    expect(STARTERS.map((s) => s.title)).toEqual(SERVER_STARTERS.map((s) => s.title));
    expect(starterCommand("node")).toBe("mc-bridge init node --with-key");
    expect(starterCommand("webhook-receiver", "npm run bridge --")).toBe("npm run bridge -- init webhook-receiver");
  });
});

describe("the live request log, by app", () => {
  const apps = buildApps({ keys: [{ id: "aaaaaaaaaa", label: "Excel", scopes: ["read"] }, { id: "bbbbbbbbbb", label: "Bot", scopes: ["paper"] }] });
  const log = [
    { at: iso(1000), method: "GET", path: "/v1/ltp", status: 200, ms: 12, keyId: "aaaaaaaaaa", client: "excel", requestId: "r1" },
    { at: iso(2000), method: "POST", path: "/v1/orders", status: 403, ms: 3, keyId: "bbbbbbbbbb", client: "script", requestId: "r2" },
    { at: iso(3000), method: "GET", path: "/v1/accounts", status: 200, ms: 5, keyId: "zzzzzzzzzz", client: "dashboard", requestId: "r3" },
    { at: iso(4000), method: "GET", path: "/v1/health", status: 200, ms: 1, keyId: null, client: null, requestId: "r4" },
    { at: iso(5000), method: "GET", path: "/v1/ltp", status: 429, ms: 2, keyId: "aaaaaaaaaa", client: "excel", requestId: "r5" },
  ];

  it("filters by app, by the dashboard's own requests, and by no key", () => {
    expect(filterRequests(log, { app: "aaaaaaaaaa" }).map((x) => x.requestId)).toEqual(["r1", "r5"]);
    expect(filterRequests(log, { app: "bbbbbbbbbb" }).map((x) => x.requestId)).toEqual(["r2"]);
    expect(filterRequests(log, { app: "dashboard" }).map((x) => x.requestId)).toEqual(["r3"]);
    expect(filterRequests(log, { app: "none" }).map((x) => x.requestId)).toEqual(["r4"]);
    expect(filterRequests(log).map((x) => x.requestId)).toEqual(["r1", "r2", "r4", "r5"]);
    expect(filterRequests(log, { includeDashboard: true })).toHaveLength(5);
  });

  it("filters by outcome and by a search word", () => {
    expect(filterRequests(log, { status: "err" }).map((x) => x.requestId)).toEqual(["r2", "r5"]);
    expect(filterRequests(log, { status: "ok" }).map((x) => x.requestId)).toEqual(["r1", "r4"]);
    expect(filterRequests(log, { q: "orders" }).map((x) => x.requestId)).toEqual(["r2"]);
    expect(filterRequests(log, { q: "429" }).map((x) => x.requestId)).toEqual(["r5"]);
  });

  it("offers every app plus the dashboard and no key, including keys only the log knows", () => {
    expect(logFilters(apps, log)).toEqual([["all", "All apps"], ["aaaaaaaaaa", "Excel"], ["bbbbbbbbbb", "Bot"], ["zzzzzzzzzz", "Key zzzzzzzzzz"], ["dashboard", "This dashboard"], ["none", "No key"]]);
  });

  it("counts, names the owner of a row, and picks a tone for a status", () => {
    expect(requestStats(log)).toMatchObject({ total: 5, errors: 2, ok: 3, medianMs: 3 });
    expect(requestStats([])).toEqual({ total: 0, errors: 0, ok: 0, medianMs: null });
    expect(requestOwner(log[0], apps)).toBe("Excel");
    expect(requestOwner(log[2], apps)).toBe("This dashboard");
    expect(requestOwner(log[3], apps)).toBe("No key");
    expect(requestOwner({ keyId: "qqqqqqqqqq" }, apps)).toBe("Key qqqqqqqqqq");
    expect([200, 404, 500].map(statusTone)).toEqual(["ok", "warn", "bad"]);
  });
});

describe("the scope finder, on the real route table", () => {
  const routes = () => app.router.list().map((r) => ({ method: r.method, path: r.pattern, scope: r.options.scope ?? null, auth: r.options.auth ?? "key" }));

  it("finds a route by a few words and says which key it needs", () => {
    const orders = findRoutes(routes(), "post orders");
    expect(orders[0]).toMatchObject({ method: "POST", path: "/v1/orders", scope: "paper" });
    expect(orders[0].words).toMatch(/paper scope/);
    expect(findRoutes(routes(), "ltp")[0]).toMatchObject({ method: "GET", path: "/v1/ltp", scope: "read", words: "Any key works: read, paper, live or admin." });
    expect(findRoutes(routes(), "keys")[0].scope).toBe("admin");
    expect(findRoutes(routes(), "health")[0]).toMatchObject({ auth: "none", scope: null, words: "No key needed." });
    expect(findRoutes(routes(), "")).toEqual([]);
    expect(findRoutes(routes(), "zzzzzz")).toEqual([]);
    expect(findRoutes(routes(), "v1", 3)).toHaveLength(3);
  });

  it("gives every route in this Bridge an answer, and every scope a preset or an honest 'no preset'", () => {
    for (const r of routes()) {
      const a = routeAccess(r);
      expect(a.words.length, `${r.method} ${r.path}`).toBeGreaterThan(5);
      if (a.scope) expect(["read", "paper", "live", "admin"]).toContain(a.scope);
    }
    expect([presetForScope("read"), presetForScope("paper"), presetForScope("admin"), presetForScope("live")]).toEqual(["read", "paper", "admin", null]);
    expect(scopeAdvice("live")).toMatch(/command line/);
    expect(scopeAdvice("admin")).toMatch(/this computer only/);
  });

  it("the keys a route needs agree with what the real Bridge accepts: a read key is refused on a paper route", async () => {
    const { key } = await app.deps.keyStore.create({ label: "finder", scopes: ["read"], accounts: "*" });
    const { port } = await app.listen();
    const res = await fetch(`http://127.0.0.1:${port}/v1/orders/preview`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: "{}" });
    const route = routes().find((r) => r.method === "POST" && r.path === "/v1/orders/preview");
    expect(res.status).toBe(route.scope === "read" ? 400 : 403);
  });
});

describe("the error catalogue in the page", () => {
  const entries = errorCatalogue();

  it("filters by words, by group and by status", () => {
    expect(filterCatalogue(entries, { q: "scope" }).map((e) => e.code)).toContain("SCOPE_REQUIRED");
    expect(filterCatalogue(entries, { q: "retry after" }).length).toBeGreaterThan(0);
    expect(filterCatalogue(entries, { group: "rate" }).map((e) => e.status)).toEqual(expect.arrayContaining([429]));
    expect(new Set(filterCatalogue(entries, { group: "rate" }).map((e) => e.status))).toEqual(new Set([429]));
    expect(filterCatalogue(entries, { group: "request" }).every((e) => e.status < 500 && e.status !== 429)).toBe(true);
    expect(filterCatalogue(entries, { group: "server" }).every((e) => e.status >= 500)).toBe(true);
    expect(filterCatalogue(entries, { status: 403 }).map((e) => e.code)).toContain("SCOPE_REQUIRED");
    expect(filterCatalogue(entries, { status: 403, q: "kill" })).toEqual([]);
    expect(filterCatalogue(entries, { status: 423 }).map((e) => e.code)).toEqual(["KILL_SWITCH_ACTIVE"]);
    expect(filterCatalogue(entries, { q: "  " })).toHaveLength(entries.length);
  });

  it("shows the shape of each answer, with the extra fields a 429 and a validation error carry", () => {
    const by = Object.fromEntries(entries.map((e) => [e.code, e]));
    expect(JSON.parse(sampleProblem(by.SCOPE_REQUIRED))).toMatchObject({ status: 403, code: "SCOPE_REQUIRED", retryable: false });
    expect(JSON.parse(sampleProblem(by.RATE_LIMITED))).toMatchObject({ status: 429, retryable: true, scope: "client", retryAfterMs: 1200 });
    expect(JSON.parse(sampleProblem(by.VALIDATION_FAILED)).errors).toHaveLength(1);
    for (const e of entries) expect(Object.keys(JSON.parse(sampleProblem(e))), e.code).toEqual(expect.arrayContaining(["title", "status", "detail", "code", "retryable", "requestId"]));
  });

  it("says what a key may do in words: the preset's own when it matches, honest generic words otherwise", () => {
    expect(capabilityLines(["read"], "script").can).toEqual(presetById("read").can);
    expect(capabilityLines(["paper"], "script").cannot.join(" ")).toMatch(/real-money/);
    expect(capabilityLines(["read"], "other").cannot.join(" ")).toMatch(/cannot place or change any order/);
    expect(capabilityLines(["admin", "paper"], "ui").can.join(" ")).toMatch(/revoke keys/);
    expect(capabilityLines(["live", "paper", "read"], "script").cannot.join(" ")).toMatch(/approval stays on this computer/);
  });

  it("every code is in exactly one group, so no error is hidden by the group chips", () => {
    const [, ...groups] = ERROR_GROUPS.map(([id]) => id);
    const total = groups.reduce((n, g) => n + filterCatalogue(entries, { group: g }).length, 0);
    expect(total).toBe(entries.length);
    expect([400, 403, 429, 500, 504].map(errorGroup)).toEqual(["request", "request", "rate", "server", "server"]);
  });
});
