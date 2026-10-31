import { describe, expect, it, vi } from "vitest";
import { FORM_PAGES, GO_KEYS, PAGE_CODES, PAGE_KEYWORDS, codeTable, isFormPage, REFRESH_CHOICES, backoffDelay, createContext, createNavState, createRecents, createRefresher, createDensity, createSequencer, expiryNote, formatCountdown, goKeyTable, isAutoRefreshable, marketStatus, normalizeContext, normalizeUnderlying, pushRecent, safeStore, stampText, upcomingExpiries } from "./workspace.js";

/** A Storage stand-in. `broken` makes every call throw, like blocked storage. */
const memory = (broken = false) => {
  const m = new Map();
  const guard = () => {
    if (broken) throw new Error("blocked");
  };
  return {
    getItem: (k) => (guard(), m.has(k) ? m.get(k) : null),
    setItem: (k, v) => (guard(), void m.set(k, String(v))),
    removeItem: (k) => (guard(), void m.delete(k)),
  };
};
const stores = (local = memory(), session = memory()) => ({ local: safeStore("local", local), session: safeStore("session", session), raw: { local, session } });

describe("workspace context", () => {
  it("validates symbols and clamps stored garbage to the defaults", () => {
    expect(normalizeUnderlying(" banknifty ")).toBe("BANKNIFTY");
    expect(normalizeUnderlying("M&M")).toBe("M&M");
    expect(normalizeUnderlying("NIFTY 50")).toBe("NIFTY50");
    expect(normalizeUnderlying("@@")).toBeNull();
    expect(normalizeUnderlying("")).toBeNull();
    expect(normalizeUnderlying("X".repeat(31))).toBeNull();
    expect(normalizeContext({ underlying: "@@", expiry: "soon", strikes: -3 })).toEqual({ underlying: "NIFTY", expiry: "", strikes: 10 });
    expect(normalizeContext(null)).toEqual({ underlying: "NIFTY", expiry: "", strikes: 10 });
  });

  it("persists a change and a new instance (a reload) reads it back", () => {
    const s = stores();
    const a = createContext(s);
    a.state.underlying = "banknifty";
    a.state.expiry = "2026-11-26";
    a.state.strikes = 20;
    const b = createContext(stores(s.raw.local, s.raw.session));
    expect(b.get()).toEqual({ underlying: "BANKNIFTY", expiry: "2026-11-26", strikes: 20 });
  });

  it("falls back to sessionStorage when localStorage has nothing", () => {
    const s = stores();
    s.raw.session.setItem("mcb.dashboard.context", JSON.stringify({ underlying: "SENSEX", expiry: "", strikes: 15 }));
    expect(createContext(s).get().underlying).toBe("SENSEX");
  });

  it("changing the underlying clears the expiry, and assigning the same value does nothing", () => {
    const c = createContext(stores());
    c.set({ expiry: "2026-11-26" });
    const seen = vi.fn();
    c.subscribe(seen);
    expect(c.set({ underlying: "NIFTY" })).toEqual([]);
    expect(seen).not.toHaveBeenCalled();
    expect(c.set({ underlying: "BANKNIFTY" })).toEqual(["underlying"]);
    expect(c.get().expiry).toBe("");
    expect(seen).toHaveBeenCalledTimes(1);
    // underlying and expiry together: the new expiry survives
    c.set({ underlying: "FINNIFTY", expiry: "2026-12-01" });
    expect(c.get()).toMatchObject({ underlying: "FINNIFTY", expiry: "2026-12-01" });
  });

  it("ignores invalid assignments (the shared `selection` object is written by raw text inputs)", () => {
    const c = createContext(stores());
    c.state.underlying = "@@";
    c.state.strikes = "lots";
    c.state.expiry = "tomorrow";
    expect(c.get()).toEqual({ underlying: "NIFTY", expiry: "", strikes: 10 });
  });

  it("works with blocked storage: it just lives in memory", () => {
    const c = createContext(stores(memory(true), memory(true)));
    expect(c.get().underlying).toBe("NIFTY");
    c.state.underlying = "SENSEX";
    expect(c.get().underlying).toBe("SENSEX");
  });

  it("a throwing subscriber does not stop the others", () => {
    const c = createContext(stores());
    const ok = vi.fn();
    c.subscribe(() => {
      throw new Error("boom");
    });
    c.subscribe(ok);
    c.state.underlying = "SENSEX";
    expect(ok).toHaveBeenCalled();
  });

  it("lists only upcoming expiries and describes them", () => {
    expect(upcomingExpiries(["2026-10-01", "2026-11-05", "2026-10-29"], "2026-10-29")).toEqual(["2026-10-29", "2026-11-05"]);
    expect(upcomingExpiries(undefined)).toEqual([]);
    expect(expiryNote("2026-11-05", "2026-10-30")).toBe("Thu · in 6 days");
    expect(expiryNote("2026-10-30", "2026-10-30")).toBe("Fri · today");
  });
});

describe("collapsible sidebar groups", () => {
  it("remembers collapsed groups per browser and keeps the active group open", () => {
    const s = stores();
    const nav = createNavState(s.local);
    expect(nav.isOpen("Analytics", null)).toBe(true);
    nav.toggle("Analytics");
    expect(nav.isOpen("Analytics", "Overview")).toBe(false);
    expect(nav.isOpen("Analytics", "Analytics")).toBe(true); // the page you are on is never hidden
    expect(nav.isCollapsedPref("Analytics")).toBe(true); // ...but the saved choice stays
    const again = createNavState(safeStore("local", s.raw.local));
    expect(again.isOpen("Analytics", "Trading")).toBe(false);
    again.toggle("Analytics");
    expect(again.isOpen("Analytics", "Trading")).toBe(true);
  });
  it("survives blocked storage and corrupt data, and prunes renamed groups", () => {
    expect(createNavState(safeStore("local", memory(true))).toggle("X")).toBe(false);
    const raw = memory();
    raw.setItem("mcb.dashboard.navCollapsed", "{nope");
    const nav = createNavState(safeStore("local", raw));
    expect(nav.isOpen("Trading", null)).toBe(true);
    nav.set("Gone", false);
    nav.prune(["Trading"]);
    expect(JSON.parse(raw.getItem("mcb.dashboard.navCollapsed"))).toEqual([]);
  });
});

describe("recent pages and density", () => {
  it("keeps the latest five, newest first, without duplicates", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["1", "2", "3", "4", "5"], "6")).toEqual(["6", "1", "2", "3", "4"]);
    const raw = memory();
    const r = createRecents(safeStore("local", raw));
    r.push("oi");
    r.push("chain");
    expect(createRecents(safeStore("local", raw)).list()).toEqual(["chain", "oi"]);
  });
  it("density defaults to comfortable, stores only compact and ignores junk", () => {
    const raw = memory();
    const d = createDensity(safeStore("local", raw));
    expect(d.get()).toBe("comfortable");
    d.set("compact");
    expect(createDensity(safeStore("local", raw)).get()).toBe("compact");
    d.set("huge");
    expect(d.get()).toBe("comfortable");
    expect(raw.getItem("mcb.dashboard.density")).toBeNull();
  });
});

describe("market status (IST)", () => {
  const at = (iso) => marketStatus(Date.parse(iso));
  it("is pre-open from 09:00 to 09:15 IST on weekdays", () => {
    const m = at("2026-10-30T03:30:00Z"); // Fri 09:00 IST
    expect(m).toMatchObject({ state: "preopen", next: "open" });
    expect(m.text).toBe("Pre-open · opens in 15m");
  });
  it("is open from 09:15 to 15:30 with the time to the close", () => {
    expect(at("2026-10-30T03:45:00Z")).toMatchObject({ state: "open", remainingMs: 6.25 * 3_600_000, text: "Market open · closes in 6h 15m" });
    expect(at("2026-10-30T10:00:00Z")).toMatchObject({ state: "closed" }); // 15:30 IST exactly: closed
    expect(at("2026-10-30T09:59:59Z").state).toBe("open");
  });
  it("is closed before pre-open, counting to today's open", () => {
    const m = at("2026-10-30T01:30:00Z"); // 07:00 IST
    expect(m).toMatchObject({ state: "closed", remainingMs: 2.25 * 3_600_000 });
    expect(m.text).toBe("Market closed · opens in 2h 15m");
  });
  it("counts Friday evening and the weekend to Monday 09:15", () => {
    expect(at("2026-10-30T11:00:00Z").text).toBe("Market closed · opens in 2d 16h"); // Fri 16:30 IST
    expect(at("2026-10-31T06:00:00Z")).toMatchObject({ state: "closed", text: "Market closed · opens in 1d 21h" }); // Sat 11:30 IST
    expect(at("2026-11-01T18:00:00Z").text).toBe("Market closed · opens in 9h 45m"); // Sun 23:30 IST
  });
  it("uses IST, not the machine's zone: Thursday 22:00 UTC is already Friday morning in India", () => {
    expect(at("2026-10-29T22:00:00Z")).toMatchObject({ state: "closed" }); // Fri 03:30 IST
    expect(at("2026-10-29T22:00:00Z").remainingMs).toBe(5.75 * 3_600_000);
  });
  it("formats countdowns compactly", () => {
    expect(formatCountdown(45_000)).toBe("45s");
    expect(formatCountdown(9 * 60_000 + 5_000)).toBe("9m 05s");
    expect(formatCountdown(14 * 60_000)).toBe("14m");
    expect(formatCountdown(2 * 3_600_000 + 4 * 60_000)).toBe("2h 04m");
    expect(formatCountdown(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
  });
  it("stamps hh:mm:ss in IST", () => {
    expect(stampText(Date.parse("2026-10-30T04:05:09Z"))).toBe("09:35:09");
  });
});

describe("Vim-style navigation", () => {
  const pages = ["home", "oi", "gex", "chain", "payoff"];
  const table = goKeyTable(pages);
  it("maps g then o to OI and g then g to gamma, only for pages that exist", () => {
    expect(table).toEqual({ h: "home", o: "oi", g: "gex", c: "chain", p: "payoff" });
    expect(goKeyTable(["scanner", "screener", "expiry", "exposure"])).toEqual({ sn: "scanner", sc: "screener", ed: "expiry", ex: "exposure" });
    expect(goKeyTable(["new-page"])).toEqual({});
  });
  it("gives every page its own key", () => {
    const keys = Object.values(GO_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(GO_KEYS).every((id) => id in PAGE_KEYWORDS)).toBe(true);
  });
  it("gives every page a code and no key is the start of another", () => {
    const all = goKeyTable(Object.keys(GO_KEYS));
    expect(Object.keys(all).length).toBe(Object.keys(GO_KEYS).length);
    expect(Object.keys(all).every((k) => k.length <= 2)).toBe(true);
    expect(all.ex).toBe("exposure");
    expect(all.sc).toBe("screener");
    for (const a of Object.keys(all)) for (const b of Object.keys(all)) if (a !== b) expect(b.startsWith(a)).toBe(false);
    // a clashing table loses the shorter key rather than becoming ambiguous
    expect(goKeyTable(["a", "b"], { a: "e", b: "ex" })).toEqual({ ex: "b" });
    const codes = Object.values(PAGE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => /^[A-Z]{2,4}$/.test(c) && !["EQ", "FUT", "OPT", "HELP"].includes(c))).toBe(true);
    expect(Object.keys(PAGE_CODES).sort()).toEqual(Object.keys(GO_KEYS).sort());
    expect(codeTable(["chain", "oi"])).toEqual({ OC: "chain", OI: "oi" });
  });
  it("supports one- and two-key sequences unambiguously (g e x, g s c, g c)", () => {
    const t2 = goKeyTable(Object.keys(GO_KEYS));
    let t = 0;
    const s = createSequencer({ table: t2, now: () => t });
    s.feed("g");
    expect(s.feed("e")).toEqual({ kind: "pending" }); // e only starts ex and ed
    expect(s.typed()).toBe("e");
    expect(s.feed("x")).toEqual({ kind: "go", id: "exposure" });
    s.feed("g");
    s.feed("s");
    expect(s.feed("c")).toEqual({ kind: "go", id: "screener" });
    s.feed("g");
    s.feed("s");
    expect(s.feed("n")).toEqual({ kind: "go", id: "scanner" });
    s.feed("g");
    expect(s.feed("c")).toEqual({ kind: "go", id: "chain" }); // a whole one-key code fires at once
    s.feed("g");
    s.feed("e");
    expect(s.feed("z")).toEqual({ kind: "none" }); // dead end disarms
    expect(s.isPending()).toBe(false);
    s.feed("g");
    s.feed("e");
    t = 2000; // the second key came too late
    expect(s.feed("x")).toEqual({ kind: "none" });
  });
  it("form pages are the five Analytics forms", () => {
    expect([...FORM_PAGES].sort()).toEqual(["alerts", "calculators", "payoff", "positions", "strategies"]);
    expect(isFormPage("chain")).toBe(false);
  });
  it("arms on g, then goes on the second key", () => {
    let t = 0;
    const s = createSequencer({ table, now: () => t });
    expect(s.feed("g")).toEqual({ kind: "pending" });
    expect(s.feed("o")).toEqual({ kind: "go", id: "oi" });
    expect(s.feed("o")).toEqual({ kind: "none" }); // disarmed
    s.feed("g");
    expect(s.feed("g")).toEqual({ kind: "go", id: "gex" });
  });
  it("never fires while typing, and typing disarms a pending g", () => {
    const s = createSequencer({ table });
    expect(s.feed("g", { typing: true })).toEqual({ kind: "none" });
    expect(s.feed("o")).toEqual({ kind: "none" });
    s.feed("g");
    expect(s.feed("o", { typing: true })).toEqual({ kind: "none" });
    expect(s.feed("o")).toEqual({ kind: "none" });
    expect(s.feed("g", { modifier: true })).toEqual({ kind: "none" });
  });
  it("times out, cancels on Escape or an unknown key, and ignores Shift+G and key repeat", () => {
    let t = 0;
    const s = createSequencer({ table, timeoutMs: 1000, now: () => t });
    s.feed("g");
    t = 1500;
    expect(s.feed("o")).toEqual({ kind: "none" });
    s.feed("g");
    expect(s.feed("Escape")).toEqual({ kind: "none" });
    expect(s.feed("o")).toEqual({ kind: "none" });
    s.feed("g");
    expect(s.feed("q")).toEqual({ kind: "none" });
    expect(s.isPending()).toBe(false);
    expect(s.feed("G", { shift: true })).toEqual({ kind: "none" });
    s.feed("g");
    expect(s.feed("g", { repeat: true })).toEqual({ kind: "pending" });
    expect(s.feed("O", { shift: true })).toEqual({ kind: "none" });
  });
});

describe("every page is classified for refresh", () => {
  it("is refreshable, a form page, or deliberately manual (so a new page must be decided)", () => {
    const manual = ["accounts", "console", "safety", "keys", "integrations", "scanner", "screener"]; // forms, tokens, filters or secrets: Reload only
    for (const id of Object.keys(PAGE_CODES)) expect(isAutoRefreshable(id) || isFormPage(id) || manual.includes(id), id).toBe(true);
    expect(isAutoRefreshable("exposure")).toBe(true);
    for (const id of FORM_PAGES) expect(isAutoRefreshable(id), id).toBe(false);
  });
});

describe("auto-refresh backoff", () => {
  it("keeps the cadence while healthy, doubles after failures (capped) and honours Retry-After", () => {
    expect(backoffDelay(5000, 0)).toBe(5000);
    expect(backoffDelay(5000, 1)).toBe(10_000);
    expect(backoffDelay(5000, 3)).toBe(40_000);
    expect(backoffDelay(60_000, 6)).toBe(300_000);
    expect(backoffDelay(5000, 1, 90_000)).toBe(90_000);
    expect(backoffDelay(5000, 1, 7_200_000)).toBe(600_000);
  });
  it("only data pages are refreshable", () => {
    expect(isAutoRefreshable("chain")).toBe(true);
    expect(isAutoRefreshable("payoff")).toBe(false);
    expect(isAutoRefreshable("keys")).toBe(false);
  });
});

/** A controllable clock and timer queue. */
function rig(opts = {}) {
  let now = 1_000_000;
  let id = 0;
  const queue = new Map();
  const timers = { set: (fn, ms) => (queue.set(++id, { fn, at: now + ms }), id), clear: (i) => void queue.delete(i) };
  const state = { hidden: false, busy: false, calls: 0, results: [], states: [] };
  const run = vi.fn(async () => {
    state.calls += 1;
    state.running = (state.running ?? 0) + 1;
    state.maxRunning = Math.max(state.maxRunning ?? 0, state.running);
    await state.gate;
    state.running -= 1;
    const r = state.results.shift();
    if (r instanceof Error) throw r;
    return r;
  });
  const r = createRefresher({ run, onState: (s) => state.states.push(s), canRun: () => !state.busy, isHidden: () => state.hidden, now: () => now, timers, store: safeStore("local", memory()), ...opts });
  /** Move time forward and fire everything that comes due, awaiting the runs. */
  const advance = async (ms) => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const end = now + ms;
    for (;;) {
      const next = [...queue.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      queue.delete(next[0]);
      now = Math.max(now, next[1].at);
      next[1].fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    now = end;
  };
  return { r, run, state, advance, queue, clock: () => now };
}

describe("auto-refresh scheduler", () => {
  it("is off by default and starts nothing", async () => {
    const t = rig();
    t.r.pageChanged(true);
    await t.advance(120_000);
    expect(t.run).not.toHaveBeenCalled();
    expect(t.r.snapshot().status).toBe("off");
  });

  it("runs on the chosen cadence and remembers it", async () => {
    const t = rig();
    t.r.pageChanged(true);
    t.r.setInterval(5000);
    await t.advance(4_900);
    expect(t.run).not.toHaveBeenCalled();
    await t.advance(200);
    expect(t.run).toHaveBeenCalledTimes(1);
    await t.advance(5000);
    expect(t.run).toHaveBeenCalledTimes(2);
    expect(t.r.snapshot()).toMatchObject({ intervalMs: 5000, status: "idle", failures: 0 });
    expect(REFRESH_CHOICES.map((c) => c.ms)).toEqual([0, 5000, 15000, 30000, 60000]);
  });

  it("never stacks: the next wait starts only after a slow run finishes", async () => {
    const t = rig();
    let release;
    t.state.gate = new Promise((res) => (release = res));
    t.r.pageChanged(true);
    t.r.setInterval(5000);
    await t.advance(5000);
    await t.advance(60_000); // the run is still in flight for a minute
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(t.state.maxRunning).toBe(1);
    expect(t.r.snapshot().status).toBe("running");
    t.state.gate = null;
    release();
    await t.advance(0);
    await t.advance(5000);
    expect(t.run).toHaveBeenCalledTimes(2);
    expect(t.state.maxRunning).toBe(1);
  });

  it("waits instead of running while something else is loading or the person is typing", async () => {
    const t = rig();
    t.state.busy = true;
    t.r.pageChanged(true);
    t.r.setInterval(5000);
    await t.advance(30_000);
    expect(t.run).not.toHaveBeenCalled();
    t.state.busy = false;
    await t.advance(5000);
    expect(t.run).toHaveBeenCalled();
  });

  it("pauses while the tab is hidden and runs at once on return when it came due", async () => {
    const t = rig();
    t.r.pageChanged(true);
    t.r.setInterval(5000);
    await t.advance(1000);
    t.state.hidden = true;
    t.r.visibilityChanged();
    expect(t.queue.size).toBe(0);
    expect(t.r.snapshot().status).toBe("paused");
    await t.advance(120_000);
    expect(t.run).not.toHaveBeenCalled();
    t.state.hidden = false;
    t.r.visibilityChanged();
    await t.advance(0);
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it("backs off on errors and on 429 (Retry-After), then recovers", async () => {
    const t = rig();
    t.state.results = [{ ok: false, status: 500 }, { ok: false, status: 429, retryAfterMs: 45_000 }, new Error("down"), { ok: true }];
    t.r.pageChanged(true);
    t.r.setInterval(5000);
    await t.advance(5000); // run 1 fails -> next in 10s
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(t.r.snapshot()).toMatchObject({ failures: 1, status: "backoff" });
    await t.advance(9_900);
    expect(t.run).toHaveBeenCalledTimes(1);
    await t.advance(200); // run 2: 429 asking for 45s
    expect(t.run).toHaveBeenCalledTimes(2);
    expect(t.r.snapshot().lastError.status).toBe(429);
    await t.advance(44_000);
    expect(t.run).toHaveBeenCalledTimes(2);
    await t.advance(2_000); // run 3 throws -> 5s * 2^3 = 40s
    expect(t.run).toHaveBeenCalledTimes(3);
    expect(t.r.snapshot().failures).toBe(3);
    await t.advance(41_000); // run 4 succeeds
    expect(t.run).toHaveBeenCalledTimes(4);
    expect(t.r.snapshot()).toMatchObject({ failures: 0, status: "idle", lastError: null });
    await t.advance(5_100);
    expect(t.run).toHaveBeenCalledTimes(5);
  });

  it("an ineligible page (one with forms) stops the timer but keeps the chosen cadence", async () => {
    const t = rig();
    t.r.pageChanged(true);
    t.r.setInterval(15000);
    t.r.pageChanged(false);
    expect(t.queue.size).toBe(0);
    expect(t.r.snapshot()).toMatchObject({ intervalMs: 15000, status: "unavailable", eligible: false });
    await t.advance(60_000);
    expect(t.run).not.toHaveBeenCalled();
    t.r.pageChanged(true);
    await t.advance(15_100);
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it("a manual load restarts the wait so a timer run does not follow it immediately", async () => {
    const t = rig();
    t.r.pageChanged(true);
    t.r.setInterval(5000);
    await t.advance(4000);
    t.r.loaded();
    await t.advance(4000);
    expect(t.run).not.toHaveBeenCalled();
    await t.advance(1100);
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it("ignores an unknown cadence and reads a stored one", async () => {
    const raw = memory();
    raw.setItem("mcb.dashboard.autoRefresh", "15000");
    const t = rig({ store: safeStore("local", raw) });
    expect(t.r.intervalMs).toBe(15000);
    t.r.setInterval(1234);
    expect(t.r.intervalMs).toBe(0);
    expect(raw.getItem("mcb.dashboard.autoRefresh")).toBeNull();
  });
});

describe("shared with the analytics controls", () => {
  it("analyticsViews' `selection` is the persisted workspace context", async () => {
    const { selection } = await import("./analyticsViews.js");
    const { workspace } = await import("./workspace.js");
    selection.underlying = "finnifty";
    selection.strikes = 15;
    expect(workspace.get()).toMatchObject({ underlying: "FINNIFTY", strikes: 15 });
    workspace.set({ underlying: "NIFTY", strikes: 10 });
    expect(selection.underlying).toBe("NIFTY");
  });
});
