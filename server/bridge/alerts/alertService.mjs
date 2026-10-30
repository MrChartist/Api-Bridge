/**
 * Position alerts (stream S24, the position part of docs/spec/p1-11-alerts.md): rules on an account's legs, checked
 * on the Bridge with the browser closed. The maths is dashboard/alert-core.js (pure, shared with the page).
 *
 * Storage in the Bridge home: <dataDir>/alerts/rules.json (rules, their latch state and the inbox read mark, written
 * atomically) and <dataDir>/alerts/fires.jsonl (one line per fire, the newest FIRES_KEPT kept). A restart restores the
 * latches, so a condition that was already true does not fire again.
 *
 * Every `intervalMs` (15 s): for each account with enabled rules, one positions read (paper: the paper engine; live:
 * the broker, at most once per `liveIntervalMs`, 30 s) and one LTP call for the underlyings. A fire is written to the
 * log and emitted on the bus as `option.alert` { kind: "position", ... }; the notify module sends it to the targets
 * that listen to option.alert when the rule asks (`notify: true`).
 *
 * Alerts only notify. This module never imports orders/ placement, paper/ or safety/, and places nothing.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCallContext } from "../core/context.mjs";
import { BridgeError } from "../core/errors.mjs";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { DEFAULT_COOLDOWN_MIN, groupMetrics, ruleProblems, spotSymbolOf, step, symbolParts } from "../dashboard/alert-core.js";

export const MAX_RULES = 200;
export const FIRES_KEPT = 300;
const NAME_MAX = 80;

const rupee = (n) => `${n < 0 ? "−" : ""}₹${Math.round(Math.abs(n))}`;
/** Fixed decimals with a true minus; a value that rounds to zero has no sign. */
const fixed = (n, d) => {
  const t = Math.abs(n).toFixed(d);
  return n < 0 && Number(t) !== 0 ? `−${t}` : t;
};

/** Plain words for one condition (server side: messages and the log). */
export function conditionWords(c) {
  switch (c.kind) {
    case "pnl_above":
      return `P&L at or above ${rupee(c.value)}`;
    case "pnl_below":
      return `P&L at or below ${rupee(c.value)}`;
    case "spot_above":
      return `spot at or above ${fixed(c.value, 2)}`;
    case "spot_below":
      return `spot at or below ${fixed(c.value, 2)}`;
    case "delta_outside":
      return `delta outside ${fixed(c.value, 0)} to ${fixed(c.value2, 0)}`;
    case "expiry_within":
      return `expiry within ${Math.round(c.value)} min`;
    case "premium_multiple":
      return `a leg at ${fixed(c.value, 1)}× its average price`;
    default:
      return c.kind;
  }
}

/** The values a fire reports, in words. */
function valueWords(m) {
  const parts = [];
  if (m.pnl !== null) parts.push(`P&L ${rupee(m.pnl)}`);
  if (m.spot !== null) parts.push(`spot ${fixed(m.spot, 2)}`);
  if (m.delta !== null) parts.push(`delta ${fixed(m.delta, 0)}`);
  if (m.premiumMultiple !== null && m.premiumMultiple >= 1.5) parts.push(`${m.premiumLeg ?? "a leg"} at ${fixed(m.premiumMultiple, 2)}×`);
  return parts.join(" · ");
}

/**
 * @param {object} deps  core deps (paths, bus, clock, logger, config) plus orders and marketData
 * @param {{ timers?: { setInterval: Function, clearInterval: Function }, intervalMs?: number, liveIntervalMs?: number }} [opts]
 */
export function createAlertService(deps, { timers = { setInterval, clearInterval }, intervalMs = 15_000, liveIntervalMs = 30_000 } = {}) {
  const dir = join(deps.paths.dataDir, "alerts");
  const rulesFile = join(dir, "rules.json");
  const firesFile = join(dir, "fires.jsonl");
  const now = () => deps.clock?.now?.() ?? Date.now();
  const log = deps.logger?.child?.({ module: "alerts" }) ?? deps.logger;
  let state = { v: 1, seq: 0, readAt: 0, rules: [] };
  let fires = [];
  let timer = null;
  let running = false;
  const lastLive = new Map();
  let marketSeq = 0;

  function load() {
    try {
      if (existsSync(rulesFile)) {
        const s = JSON.parse(readFileSync(rulesFile, "utf8"));
        if (s && Array.isArray(s.rules)) state = { v: 1, seq: Number(s.seq) || 0, readAt: Number(s.readAt) || 0, rules: s.rules };
      }
    } catch (err) {
      log?.warn?.("alert rules could not be read; starting with none", { err: err?.message });
    }
    try {
      if (existsSync(firesFile)) {
        fires = readFileSync(firesFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .slice(-FIRES_KEPT);
      }
    } catch {
      fires = [];
    }
  }
  function save() {
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(rulesFile, `${JSON.stringify(state, null, 1)}\n`);
  }
  function logFire(f) {
    mkdirSync(dir, { recursive: true });
    fires.push(f);
    if (fires.length > FIRES_KEPT * 2) {
      fires = fires.slice(-FIRES_KEPT);
      writeFileSync(firesFile, fires.map((x) => JSON.stringify(x)).join("\n") + "\n");
    } else appendFileSync(firesFile, `${JSON.stringify(f)}\n`);
  }

  const view = (r) => ({ ...r, state: undefined, armed: r.state?.armed !== false, blind: Boolean(r.state?.blind), lastFireAt: r.state?.lastFireMs ? new Date(r.state.lastFireMs).toISOString() : null, last: r.last ?? null });

  function clean(input, prev = null) {
    const r = {
      id: prev?.id,
      name: String(input.name ?? prev?.name ?? "").trim().slice(0, NAME_MAX),
      account: String(input.account ?? prev?.account ?? ""),
      underlying: String(input.underlying ?? prev?.underlying ?? "").toUpperCase(),
      symbols: input.symbols === undefined ? (prev?.symbols ?? null) : input.symbols,
      conditions: (input.conditions ?? prev?.conditions ?? []).map((c) => ({ kind: c.kind, value: Number(c.value), ...(c.kind === "delta_outside" ? { value2: Number(c.value2) } : {}) })),
      match: input.match ?? prev?.match ?? "any",
      repeat: input.repeat ?? prev?.repeat ?? "once",
      cooldownMin: Number(input.cooldownMin ?? prev?.cooldownMin ?? DEFAULT_COOLDOWN_MIN),
      notify: Boolean(input.notify ?? prev?.notify ?? false),
      enabled: input.enabled === undefined ? (prev?.enabled ?? true) : Boolean(input.enabled),
    };
    const problems = ruleProblems(r);
    if (problems.length) throw new BridgeError("VALIDATION_FAILED", problems.join(" "), { errors: problems.map((message) => ({ path: "alert", message })) });
    if (!r.name) r.name = `${r.underlying} ${r.conditions.map(conditionWords).join(r.match === "all" ? " and " : " or ")}`.slice(0, NAME_MAX);
    return r;
  }

  async function evaluate() {
    const active = state.rules.filter((r) => r.enabled);
    if (!active.length) return 0;
    const ctx = createCallContext({ source: "system", principal: { kind: "local", id: "alerts" }, scopes: ["read"], log });
    const accounts = [...new Set(active.map((r) => r.account))];
    const positions = new Map();
    const t0 = now();
    for (const id of accounts) {
      const acc = (deps.config?.accounts ?? []).find((a) => a.id === id);
      if (!acc) continue;
      const live = acc.broker !== "paper";
      if (live && t0 - (lastLive.get(id) ?? 0) < liveIntervalMs) continue;
      try {
        const r = await deps.orders.positions(ctx, id);
        positions.set(id, r?.items ?? []);
        if (live) lastLive.set(id, t0);
      } catch (err) {
        log?.debug?.("alert positions read failed", { account: id, code: err?.code });
      }
    }
    const unders = [...new Set(active.filter((r) => positions.has(r.account)).map((r) => r.underlying))];
    const spots = new Map();
    if (unders.length) {
      try {
        const r = await deps.marketData.ltp(unders.map(spotSymbolOf), { maxAgeMs: intervalMs, priority: "background" });
        for (const it of r?.items ?? []) {
          const u = symbolParts(it.symbol)?.underlying;
          if (u && Number(it.ltp) > 0 && !it.freshness?.stale) spots.set(u, Number(it.ltp));
        }
      } catch (err) {
        log?.debug?.("alert spot read failed", { code: err?.code });
      }
    }
    let fired = 0;
    let changed = false;
    const t = now();
    for (const r of active) {
      if (!positions.has(r.account)) continue;
      const m = groupMetrics(positions.get(r.account), { underlying: r.underlying, symbols: r.symbols, spot: spots.get(r.underlying) ?? null, nowMs: t });
      const s = step(r, m, r.state, t);
      const prev = JSON.stringify(r.state ?? null);
      r.state = s.state;
      r.last = { at: new Date(t).toISOString(), pnl: m.pnl, spot: m.spot, delta: m.delta, minutesToExpiry: m.minutesToExpiry, premiumMultiple: m.premiumMultiple, legs: m.legs };
      if (JSON.stringify(r.state) !== prev) changed = true;
      if (!s.fire) continue;
      fired += 1;
      changed = true;
      const met = r.conditions.filter((_, i) => s.results[i]?.met);
      const f = { id: `fire_${t.toString(36)}_${fired}`, ruleId: r.id, name: r.name, account: r.account, underlying: r.underlying, at: new Date(t).toISOString(), title: `${r.name}`, text: `${met.map(conditionWords).join("; ")}. Now: ${valueWords(m)}.`, values: r.last };
      logFire(f);
      r.fires = (r.fires ?? 0) + 1;
      if (r.repeat === "once") r.enabled = false;
      // The notify module sends option.alert only when the rule asks; messages carry no account id or key.
      deps.bus?.emit("option.alert", { kind: "position", ruleId: r.id, name: r.name, underlying: r.underlying, title: `Alert: ${r.name}`, text: f.text, at: f.at, notify: r.notify === true });
    }
    if (changed) save();
    return fired;
  }

  const svc = {
    start() {
      load();
      if (!timer) timer = timers.setInterval(() => void svc.runOnce(), intervalMs);
    },
    stop() {
      if (timer) timers.clearInterval(timer);
      timer = null;
    },
    async runOnce() {
      if (running) return 0;
      running = true;
      try {
        return await evaluate();
      } catch (err) {
        log?.error?.("alert evaluation failed", { err: err?.message });
        return 0;
      } finally {
        running = false;
      }
    },
    /** Rules (filtered by `allowed(accountId)`), newest first. */
    list(allowed = () => true) {
      return state.rules.filter((r) => allowed(r.account)).map(view).reverse();
    },
    create(input) {
      if (state.rules.length >= MAX_RULES) throw new BridgeError("ALERT_LIMIT", `At most ${MAX_RULES} alerts. Delete some first.`);
      const r = clean(input);
      state.seq += 1;
      r.id = `alert_${now().toString(36)}_${state.seq}`;
      r.createdAt = new Date(now()).toISOString();
      r.fires = 0;
      r.state = { armed: true, lastFireMs: null, blind: false };
      state.rules.push(r);
      save();
      return view(r);
    },
    get(id) {
      const r = state.rules.find((x) => x.id === id);
      if (!r) throw new BridgeError("NOT_FOUND", `No alert ${String(id).slice(0, 60)}.`);
      return r;
    },
    update(id, patch) {
      const r = svc.get(id);
      const next = clean(patch ?? {}, r);
      const rearm = JSON.stringify(next.conditions) !== JSON.stringify(r.conditions) || (next.enabled && !r.enabled);
      Object.assign(r, next, { id: r.id });
      if (rearm) r.state = { armed: true, lastFireMs: null, blind: false };
      save();
      return view(r);
    },
    remove(id) {
      svc.get(id);
      state.rules = state.rules.filter((x) => x.id !== id);
      save();
    },
    /** A market rule's fire (alerts/module.mjs hears analytics.alert): into the same inbox, with no account. */
    record({ ruleId, name, underlying, text, at, values } = {}) {
      const t = Date.parse(at) || now();
      const f = { id: `fire_${t.toString(36)}_m${(marketSeq += 1)}`, kind: "market", ruleId: ruleId ?? null, name: String(name ?? "Market alert"), account: null, underlying: underlying ?? null, at: new Date(t).toISOString(), title: String(name ?? "Market alert"), text: String(text ?? ""), values: values ?? null };
      logFire(f);
      return f;
    },
    /** Fires, newest first, with how many are unread. Market fires carry no account, so every key that reads sees them. */
    inbox(allowed = () => true, { limit = 50 } = {}) {
      const mine = fires.filter((f) => f.account === null || f.account === undefined || allowed(f.account));
      const unread = mine.filter((f) => Date.parse(f.at) > state.readAt).length;
      return { items: mine.slice(-limit).reverse(), unread, readAt: state.readAt ? new Date(state.readAt).toISOString() : null };
    },
    markRead() {
      state.readAt = now();
      save();
    },
  };
  return svc;
}
