import { describe, expect, it } from "vitest";
import { endOfDay, ladderSummary, levelCounts, levelOf, levelRank, levelText, loginNeed, loginPlan, methodOf, progress, progressText } from "./morning-core.js";

const NOW = Date.parse("2026-10-19T08:50:00+05:30");
const acct = (id, broker, state, extra = {}) => ({ id, label: id.toUpperCase(), broker, enabled: true, session: { state, ...extra } });
const brokers = [
  { id: "dhan", authKind: "apiKeyToken", verification: { level: "live-verified" } },
  { id: "zerodha", authKind: "oauthRedirect", verification: { level: "contract" } },
  { id: "angelone", authKind: "sessionLogin", verification: { level: "beta" } },
  { id: "aliceblue", authKind: "requestTokenExchange" },
  { id: "iifl", authKind: "requestTokenExchange", singleSession: true, verification: { level: "contract" } },
];

describe("loginNeed", () => {
  it("names what is wrong, and ignores paper, demo, disabled and connecting accounts", () => {
    expect(loginNeed(acct("a", "dhan", "missing"), NOW)).toBe("missing");
    expect(loginNeed(acct("a", "dhan", "expired"), NOW)).toBe("expired");
    expect(loginNeed(acct("a", "dhan", "error"), NOW)).toBe("error");
    expect(loginNeed(acct("a", "dhan", "connecting"), NOW)).toBeNull();
    expect(loginNeed(acct("p", "paper", "connected"), NOW)).toBeNull();
    expect(loginNeed(acct("d", "demo", "missing"), NOW)).toBeNull();
    expect(loginNeed({ ...acct("a", "dhan", "missing"), enabled: false }, NOW)).toBeNull();
  });

  it("flags a connected session that ends later today, but not one that lasts into tomorrow", () => {
    expect(loginNeed(acct("a", "zerodha", "connected", { expiresAt: "2026-10-19T11:00:00+05:30" }), NOW)).toBe("ends-early");
    expect(loginNeed(acct("a", "zerodha", "connected", { expiresAt: "2026-10-20T06:00:00+05:30" }), NOW)).toBeNull();
    expect(loginNeed(acct("a", "zerodha", "connected", { expiresAt: "2026-10-19T08:00:00+05:30" }), NOW)).toBeNull(); // already past
    expect(loginNeed(acct("a", "zerodha", "connected"), NOW)).toBeNull();
    expect(endOfDay(NOW)).toBe(Date.parse("2026-10-20T00:00:00+05:30"));
  });
});

describe("loginPlan", () => {
  const accounts = [
    acct("late", "zerodha", "connected", { expiresAt: "2026-10-19T11:00:00+05:30" }),
    acct("angel", "angelone", "missing"),
    acct("dhan-main", "dhan", "expired"),
    acct("fine", "dhan", "connected", { expiresAt: "2026-10-20T03:00:00+05:30" }),
    acct("paper", "paper", "connected"),
    acct("iifl-1", "iifl", "missing"),
  ];

  it("lists only the accounts that need a login, most urgent first, with how each one logs in", () => {
    const plan = loginPlan(accounts, brokers, NOW);
    expect(plan.map((p) => [p.account.id, p.need])).toEqual([["dhan-main", "expired"], ["angel", "missing"], ["iifl-1", "missing"], ["late", "ends-early"]]);
    expect(plan.map((p) => p.method.label)).toEqual(["Access token", "Session login", "One-time code", "OAuth link"]);
    expect(plan.find((p) => p.account.id === "iifl-1").singleSession).toBe(true);
    expect(plan.find((p) => p.account.id === "late").endsAt).toBe("2026-10-19T11:00:00+05:30");
    expect(plan.every((p) => p.needText && p.tone)).toBe(true);
  });

  it("is empty when everything is fine", () => {
    expect(loginPlan([acct("fine", "dhan", "connected", { expiresAt: "2026-10-20T03:00:00+05:30" })], brokers, NOW)).toEqual([]);
    expect(loginPlan(undefined, brokers, NOW)).toEqual([]);
  });

  it("falls back to the account's own auth kind and to the token method for an unknown broker", () => {
    expect(loginPlan([{ ...acct("x", "unknown", "missing"), authKind: "sessionLogin" }], [], NOW)[0].method.label).toBe("Session login");
    expect(methodOf(null).label).toBe("Access token");
  });
});

describe("progress", () => {
  const plan0 = loginPlan([acct("a", "dhan", "missing"), acct("b", "angelone", "missing"), acct("c", "zerodha", "expired")], brokers, NOW);
  const ids = plan0.map((p) => p.account.id);

  it("counts accounts that no longer need a login as done and offers the next one", () => {
    let p = progress(ids, plan0);
    expect(p).toMatchObject({ total: 3, done: 0, left: 3, finished: false });
    expect(p.current.account.id).toBe("c"); // expired first
    const plan1 = plan0.filter((x) => x.account.id !== "c");
    p = progress(ids, plan1);
    expect(p).toMatchObject({ done: 1, left: 2 });
    expect(progressText(p)).toBe("1 of 3 logged in");
    p = progress(ids, []);
    expect(p).toMatchObject({ done: 3, left: 0, finished: true });
    expect(progressText(p)).toBe("All 3 logged in");
  });

  it("a skipped account is left for later and does not block the finish", () => {
    const skipped = new Set(["a", "b"]);
    const plan1 = plan0.filter((x) => x.account.id !== "c");
    const p = progress(ids, plan1, skipped);
    expect(p).toMatchObject({ done: 1, skipped: 2, left: 0, finished: true, current: null });
    expect(progressText(p)).toBe("1 of 3 logged in, 2 left for later");
    expect(progressText({ total: 0, finished: true, skipped: 0 })).toBe("Nothing to log in to");
    expect(progressText({ total: 1, done: 1, skipped: 0, finished: true })).toBe("Logged in");
  });
});

describe("verification badge", () => {
  it("reads the ladder level, with a fallback for a Bridge that sends only `verified`", () => {
    expect(levelOf({ verification: { level: "contract" } })).toBe("contract");
    expect(levelOf({ verified: true })).toBe("live-verified");
    expect(levelOf({})).toBe("beta");
    expect(levelText({ verification: { level: "contract" } })).toBe("Contract-tested");
    expect(levelRank({ verification: { level: "live-verified" } })).toBeGreaterThan(levelRank({ verification: { level: "contract" } }));
    expect(levelRank({ verification: { level: "contract" } })).toBeGreaterThan(levelRank({}));
  });

  it("counts and describes brokers from the data, never from typed numbers", () => {
    expect(levelCounts(brokers)).toEqual([
      { level: "live-verified", text: "Verified", n: 1 },
      { level: "contract", text: "Contract-tested", n: 2 },
      { level: "beta", text: "Beta", n: 2 },
    ]);
    expect(ladderSummary(brokers)).toMatch(/^1 verified with a live account, 2 contract-tested, 2 in beta\./);
    expect(ladderSummary([])).toBe("");
  });
});
