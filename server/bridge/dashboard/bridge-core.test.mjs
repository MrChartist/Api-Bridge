import { describe, expect, it } from "vitest";
import {
  ACTIVITY_FILTERS,
  AUDIT_FILTERS,
  DAY,
  HOUR,
  INTEGRATION_INFO,
  MINUTE,
  accountCounts,
  accountGroups,
  accountStatus,
  accountUsage,
  actorText,
  attentionItems,
  auditEntry,
  auditKind,
  auditTitle,
  classRows,
  filterRequests,
  fullestWindow,
  keyStatus,
  lastUsedText,
  minuteWindow,
  relativeText,
  requestSummary,
  sessionLine,
  shareTone,
  sortKeys,
  spanWords,
  statusText,
  timeBuckets,
  windowWord,
} from "./bridge-core.js";
import { DASH } from "./format.js";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

describe("spans and relative times", () => {
  it("words a span by its largest unit", () => {
    expect(spanWords(20_000)).toBe("under a minute");
    expect(spanWords(12 * MINUTE + 5)).toBe("12 min");
    expect(spanWords(HOUR)).toBe("1 hour");
    expect(spanWords(5 * HOUR + 59 * MINUTE)).toBe("5 hours");
    expect(spanWords(3 * DAY)).toBe("3 days");
    // A 7-day key a minute after it was made still reads "7 days".
    expect(spanWords(7 * DAY - MINUTE)).toBe("7 days");
    expect(spanWords(DAY + HOUR)).toBe("1 day");
    expect(spanWords(NaN)).toBe(DASH);
  });
  it("says in / ago, and a dash for a missing time", () => {
    expect(relativeText(iso(NOW + 3 * DAY), NOW)).toBe("in 3 days");
    expect(relativeText(NOW - 2 * HOUR, NOW)).toBe("2 hours ago");
    expect(relativeText(null, NOW)).toBe(DASH);
  });
});

describe("accounts", () => {
  const acct = (state, extra = {}) => ({ id: state, label: `Acc ${state}`, broker: "zerodha", session: { state, ...extra } });
  it("reads each session state in words, paper always ready", () => {
    expect(accountStatus({ broker: "paper" }, NOW)).toMatchObject({ kind: "paper", text: "Ready", tone: "ok", attention: false });
    expect(accountStatus(acct("connected"), NOW)).toMatchObject({ kind: "connected", tone: "ok", attention: false });
    expect(accountStatus(acct("expired"), NOW)).toMatchObject({ kind: "expired", tone: "bad", attention: true });
    expect(accountStatus(acct("error"), NOW)).toMatchObject({ kind: "error", tone: "bad", attention: true });
    expect(accountStatus(acct("missing"), NOW)).toMatchObject({ kind: "missing", text: "Not logged in", attention: true });
    expect(accountStatus({ broker: "dhan" }, NOW).kind).toBe("missing");
  });
  it("flags a session ending within two hours, and one past its end as expired", () => {
    expect(accountStatus(acct("connected", { expiresAt: iso(NOW + 40 * MINUTE) }), NOW)).toMatchObject({ kind: "expiring", text: "Ends in 40 min", tone: "warn", attention: true });
    expect(accountStatus(acct("connected", { expiresAt: iso(NOW + 5 * HOUR) }), NOW).kind).toBe("connected");
    expect(accountStatus(acct("connected", { expiresAt: iso(NOW - MINUTE) }), NOW).kind).toBe("expired");
  });
  it("groups and counts", () => {
    const list = [acct("connected"), acct("expired"), acct("missing"), { id: "p", broker: "paper" }, { ...acct("connected", { expiresAt: iso(NOW + HOUR) }), liveAllowedByConfig: true }];
    expect(accountGroups(list).paper.map((a) => a.id)).toEqual(["p"]);
    expect(accountGroups(list).brokers).toHaveLength(4);
    expect(accountCounts(list, NOW)).toEqual({ loggedIn: 2, needLogin: 2, paper: 1, live: 1 });
  });
  it("writes a session line for every state", () => {
    const fmt = () => "31 Oct, 15:30";
    expect(sessionLine(acct("connected", { expiresAt: iso(NOW + 5 * HOUR) }), NOW, fmt)).toBe("Session until 31 Oct, 15:30");
    expect(sessionLine(acct("connected"), NOW, fmt)).toMatch(/no end time/);
    expect(sessionLine(acct("error", { message: "Wrong TOTP" }), NOW, fmt)).toBe("Last try: Wrong TOTP");
    expect(sessionLine({ broker: "paper" }, NOW, fmt)).toMatch(/Simulated/);
    expect(sessionLine(acct("missing"), NOW, fmt)).toMatch(/Log in/);
  });
});

describe("keys", () => {
  const key = (o) => ({ id: "k", label: "K", createdAt: iso(NOW - DAY), ...o });
  it("knows active, expiring, expired and revoked", () => {
    expect(keyStatus(key({}), NOW)).toMatchObject({ kind: "active", expiry: "Never expires" });
    expect(keyStatus(key({ expiresAt: iso(NOW + 3 * DAY) }), NOW)).toMatchObject({ kind: "expiring", tone: "warn", expiry: "Expires in 3 days" });
    expect(keyStatus(key({ expiresAt: iso(NOW + 30 * DAY) }), NOW).kind).toBe("active");
    expect(keyStatus(key({ expiresAt: iso(NOW - 2 * DAY) }), NOW)).toMatchObject({ kind: "expired", tone: "bad", expiry: "Expired 2 days ago" });
    expect(keyStatus(key({ revokedAt: iso(NOW - HOUR), expiresAt: iso(NOW + DAY) }), NOW).kind).toBe("revoked");
  });
  it("sorts expiring, expired, active (newest first), revoked", () => {
    const list = [
      key({ id: "rev", revokedAt: iso(NOW) }),
      key({ id: "old", createdAt: iso(NOW - 9 * DAY) }),
      key({ id: "new", createdAt: iso(NOW - HOUR) }),
      key({ id: "gone", expiresAt: iso(NOW - DAY) }),
      key({ id: "soon", expiresAt: iso(NOW + DAY) }),
    ];
    expect(sortKeys(list, NOW).map((k) => k.id)).toEqual(["soon", "gone", "new", "old", "rev"]);
  });
  it("words the last use", () => {
    expect(lastUsedText({}, NOW)).toBe("Never used");
    expect(lastUsedText({ lastUsedAt: iso(NOW - 5 * MINUTE) }, NOW)).toBe("Used 5 min ago");
  });
});

describe("rate limits", () => {
  const cls = (windows, extra = {}) => ({ windows, callsToday: 0, ...extra });
  it("uses the API budget's tone steps", () => {
    expect([shareTone(0.5), shareTone(0.7), shareTone(0.95)]).toEqual(["ok", "warn", "bad"]);
    expect(windowWord("1m")).toBe("minute");
  });
  it("finds the fullest window and the minute window", () => {
    const c = cls([{ window: "1s", used: 1, limit: 10 }, { window: "1m", used: 300, limit: 400 }, { window: "1m", used: 10, limit: 0 }]);
    expect(fullestWindow(c)).toMatchObject({ window: "1m", used: 300, limit: 400, tone: "warn" });
    expect(minuteWindow(c)).toMatchObject({ used: 300, limit: 400 });
    expect(fullestWindow(cls([]))).toBeNull();
    expect(fullestWindow({ used: 9, limit: 10, window: "1s" })).toMatchObject({ share: 0.9, tone: "bad" });
  });
  it("lists classes fullest first and leaves out idle unlimited ones", () => {
    const a = { classes: { quote: cls([{ window: "1m", used: 10, limit: 100 }], { callsToday: 50 }), chain: cls([{ window: "1m", used: 30, limit: 32 }], { callsToday: 4, throttledToday: 1 }), idle: cls([]) } };
    expect(classRows(a).map((r) => r.cls)).toEqual(["chain", "quote"]);
    expect(accountUsage(a)).toMatchObject({ today: 54, throttled: 1, refused: 0 });
    expect(accountUsage(a).minute).toMatchObject({ used: 30, limit: 32 });
  });
});

describe("needs attention", () => {
  it("lists sessions, keys and budget, most urgent first", () => {
    const items = attentionItems(
      {
        accounts: [
          { id: "z", label: "Zerodha", broker: "zerodha", session: { state: "missing" } },
          { id: "d", label: "Dhan", broker: "dhan", session: { state: "expired" } },
          { id: "p", broker: "paper" },
          { id: "ok", broker: "dhan", session: { state: "connected" } },
        ],
        keys: [
          { id: "k1", label: "Excel", expiresAt: iso(NOW + 2 * DAY) },
          { id: "k2", label: "Old", expiresAt: iso(NOW - 60 * DAY) },
          { id: "k3", label: "Gone", revokedAt: iso(NOW), expiresAt: iso(NOW + DAY) },
        ],
        usage: {
          accounts: [
            { accountId: "d", broker: "dhan", healthy: true, classes: { quote: { windows: [{ window: "1m", used: 380, limit: 400 }] } } },
            { accountId: "z", broker: "zerodha", healthy: false, classes: {} },
            { accountId: "pp", broker: "paper", healthy: false, classes: {} },
          ],
        },
      },
      NOW,
    );
    expect(items.map((x) => x.id)).toEqual(["acct:d", "budget:d:quote", "budget:z:backoff", "acct:z", "key:k1"]);
    expect(items[0]).toMatchObject({ tone: "bad", action: { kind: "login", id: "d", label: "Log in again" } });
    expect(items[1].title).toBe("d: quote calls at 95% of the minute limit");
    expect(items.find((x) => x.id === "acct:z").action.label).toBe("Log in");
  });
  it("is empty when all is well", () => {
    expect(attentionItems({ accounts: [{ broker: "paper" }], keys: [{ id: "a", label: "a" }], usage: { accounts: [] } }, NOW)).toEqual([]);
    expect(attentionItems(undefined, NOW)).toEqual([]);
  });
});

describe("activity", () => {
  const rows = [
    { at: iso(NOW - 10_000), method: "GET", path: "/v1/ltp", status: 200, ms: 3, client: "dashboard", keyId: "abc" },
    { at: iso(NOW - 3 * MINUTE), method: "POST", path: "/v1/orders", status: 201, ms: 1200, client: null, keyId: "xyz" },
    { at: iso(NOW - 30 * MINUTE), method: "GET", path: "/v1/quotes", status: 429, ms: 1, client: null, keyId: null },
    { at: iso(NOW - 3 * HOUR), method: "DELETE", path: "/v1/keys/a", status: 500, ms: 9, client: null, keyId: "xyz" },
  ];
  it("words statuses", () => {
    expect(statusText(200)).toEqual({ text: "200 OK", tone: "ok" });
    expect(statusText(429)).toEqual({ text: "429 Too many requests", tone: "warn" });
    expect(statusText(599)).toEqual({ text: "599 Error", tone: "bad" });
    expect(statusText(undefined).text).toBe(DASH);
  });
  it("filters by kind, search and the dashboard's own", () => {
    expect(ACTIVITY_FILTERS.map(([id]) => id)).toEqual(["all", "errors", "slow", "writes"]);
    expect(filterRequests(rows, { kind: "errors" })).toHaveLength(2);
    expect(filterRequests(rows, { kind: "slow" }).map((x) => x.path)).toEqual(["/v1/orders"]);
    expect(filterRequests(rows, { kind: "writes" })).toHaveLength(2);
    expect(filterRequests(rows, { q: "QUOTE" })).toHaveLength(1);
    expect(filterRequests(rows, { q: "xyz" })).toHaveLength(2);
    expect(filterRequests(rows, { hideOwn: true })).toHaveLength(3);
  });
  it("sums up and buckets by time", () => {
    expect(requestSummary(rows)).toEqual({ count: 4, errors: 2, slow: 1, median: 6 });
    expect(requestSummary([]).median).toBeNull();
    expect(timeBuckets(rows, NOW).map((g) => [g.label, g.rows.length])).toEqual([["Last minute", 1], ["Last 5 minutes", 1], ["Last hour", 1], ["Earlier", 1]]);
  });
});

describe("audit log", () => {
  it("sorts events into filters", () => {
    expect(AUDIT_FILTERS.map(([id]) => id)).toEqual(["all", "orders", "keys", "accounts", "safety"]);
    expect(["order.placed", "key.created", "account.added", "killSwitch.engaged", "hook.created", "chain.verified"].map(auditKind)).toEqual(["orders", "keys", "accounts", "safety", "safety", "other"]);
  });
  it("titles and details an event in words, with the order side for its dot", () => {
    expect(auditTitle("killSwitch.engaged")).toBe("Kill switch engaged");
    expect(auditTitle("")).toBe(DASH);
    const o = auditEntry({ type: "order.placed", accountId: "paper", data: { side: "SELL", quantity: 20, symbol: "BFO:SENSEX", status: "filled", mode: "paper" } });
    expect(o).toEqual({ title: "Order placed", detail: "SELL 20 · BFO:SENSEX · filled · paper · paper", kind: "orders", side: "sell" });
    expect(auditEntry({ type: "key.created", data: { label: "Excel", scopes: ["read"], keyId: "abc" } }).detail).toBe("“Excel” · read");
    // Secrets and nested objects never reach the detail.
    expect(auditEntry({ type: "chain.checked", data: { ok: true, hash: "x", token: "t", nested: { a: 1 } } }).detail).toBe("ok true");
  });
  it("names the actor", () => {
    expect(actorText({ kind: "system", id: "bridge" })).toBe("The Bridge");
    expect(actorText({ kind: "local", id: "dashboard-local" })).toBe("This computer");
    expect(actorText({ kind: "key", id: "abc" })).toBe("Key abc");
    expect(actorText(null)).toBe(DASH);
  });
});

describe("integrations", () => {
  it("has a tile with three steps for every tool", () => {
    for (const id of ["webhooks", "python", "node", "excel", "amibroker", "claude", "chatgpt", "rest"]) {
      expect(INTEGRATION_INFO[id], id).toBeTruthy();
      expect(INTEGRATION_INFO[id].steps, id).toHaveLength(3);
    }
  });
});
