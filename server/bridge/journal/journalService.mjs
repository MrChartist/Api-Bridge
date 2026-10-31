/**
 * Trade journal (BRD I5): every paper fill, and every live fill the broker reports, grouped into trades by strategy
 * group (dashboard/journal-core.js, shared with the Journal tab), with the person's tags, notes and setup, the daily
 * P&L snapshots of the paper engine and stats per tag or strategy.
 *
 * Storage: <dataDir>/journal/journal.json (atomic writes) holds only what the person typed ({ id → tags, notes,
 * setup }) and, in demo mode, the sample history. Fills and snapshots stay where they are (the paper engine, the
 * broker); nothing here holds a secret. Reads only: the journal places nothing.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { buildTrades, cleanTags, mergeDaily, tradeStats } from "../dashboard/journal-core.js";
import { demoJournalHistory } from "./demoHistory.mjs";

export const NOTES_MAX = 2000;
export const SETUP_MAX = 80;
const PAGE = 500;
const PAGES = 10;

/**
 * @param {object} deps  core deps (paths, clock, logger, config) plus orders and paper
 */
export function createJournalService(deps) {
  const dir = join(deps.paths.dataDir, "journal");
  const file = join(dir, "journal.json");
  const now = () => deps.clock?.now?.() ?? Date.now();
  const log = deps.logger?.child?.({ module: "journal" }) ?? deps.logger;
  let state = null;

  function load() {
    if (state) return state;
    state = { v: 1, entries: {}, demo: null };
    try {
      if (existsSync(file)) {
        const o = JSON.parse(readFileSync(file, "utf8"));
        if (o && typeof o === "object" && o.entries && typeof o.entries === "object") state = { v: 1, entries: o.entries, demo: o.demo ?? null };
      }
    } catch (err) {
      log?.warn?.("journal file could not be read; starting empty", { code: err?.code });
    }
    return state;
  }
  function persist() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify(state));
  }

  /** Demo mode: a few weeks of sample history for the demo paper account, made once and kept. */
  function demoHistory() {
    if (!deps.config?.demo) return null;
    const s = load();
    if (!s.demo) {
      s.demo = demoJournalHistory({ nowMs: now(), account: "demo-paper" });
      for (const [id, n] of Object.entries(s.demo.notes ?? {})) if (!s.entries[id]) s.entries[id] = n;
      try {
        persist();
      } catch (err) {
        log?.warn?.("demo journal could not be saved", { code: err?.code });
      }
    }
    return s.demo;
  }

  async function fillsOf(ctx, accountId) {
    const out = [];
    let cursor;
    for (let i = 0; i < PAGES; i++) {
      const page = await deps.orders.trades(ctx, { accountId, limit: PAGE, ...(cursor ? { cursor } : {}) });
      out.push(...(page?.items ?? []));
      cursor = page?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }
  async function marksOf(ctx, accountId) {
    try {
      const r = await deps.orders.positions(ctx, accountId, {});
      return Object.fromEntries((r?.items ?? []).filter((p) => Number(p.netQty) && Number.isFinite(Number(p.ltp))).map((p) => [p.symbol, Number(p.ltp)]));
    } catch {
      return {};
    }
  }

  /**
   * The journal for the given accounts: { trades, daily (merged per day), dailyByAccount, stats, accounts, problems }.
   * `accounts`: [{ id, broker }] the key may use. A broker that cannot be read is listed in `problems`, not fatal.
   */
  async function journal(ctx, accounts) {
    const s = load();
    const fills = [];
    const marks = {};
    const dailyByAccount = {};
    const problems = [];
    for (const a of accounts) {
      try {
        fills.push(...(await fillsOf(ctx, a.id)).map((f) => ({ ...f, accountId: f.accountId ?? a.id })));
        Object.assign(marks, await marksOf(ctx, a.id));
      } catch (err) {
        problems.push({ account: a.id, message: err?.message ?? "Could not read the trade book." });
      }
      if (a.broker === "paper" && deps.paper && typeof deps.paper.daily === "function") {
        try {
          dailyByAccount[a.id] = await deps.paper.daily(a.id);
        } catch {
          dailyByAccount[a.id] = [];
        }
      }
    }
    const demo = demoHistory();
    if (demo && accounts.some((a) => a.id === demo.account)) {
      fills.push(...demo.fills);
      // Sample days only where the paper engine has no row of its own.
      const own = new Set((dailyByAccount[demo.account] ?? []).map((r) => r.day));
      dailyByAccount[demo.account] = [...demo.daily.filter((r) => !own.has(r.day)), ...(dailyByAccount[demo.account] ?? [])].sort((x, y) => (x.day < y.day ? -1 : 1));
    }
    const trades = buildTrades(fills, { marks, notes: s.entries });
    return {
      trades,
      daily: mergeDaily(Object.values(dailyByAccount)),
      dailyByAccount,
      stats: { byStructure: tradeStats(trades, "structure"), byTag: tradeStats(trades, "tag") },
      accounts: accounts.map((a) => a.id),
      problems,
      demo: Boolean(demo),
    };
  }

  /** Save the person's tags, notes and setup for a trade id. Only those three fields; empty values clear them. */
  function annotate(tradeId, body) {
    if (typeof tradeId !== "string" || !/^t-[a-z0-9]{2,40}$/.test(tradeId)) throw new BridgeError("VALIDATION_FAILED", "Not a journal trade id.");
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
    if (!b) throw new BridgeError("VALIDATION_FAILED", "Send { tags?, notes?, setup? } as a JSON object.");
    const extra = Object.keys(b).filter((k) => !["tags", "notes", "setup"].includes(k));
    if (extra.length) throw new BridgeError("VALIDATION_FAILED", `Unknown field ${extra[0]}: send tags, notes or setup.`);
    if (b.notes !== undefined && (typeof b.notes !== "string" || b.notes.length > NOTES_MAX)) throw new BridgeError("VALIDATION_FAILED", `notes must be text of at most ${NOTES_MAX} characters.`);
    if (b.setup !== undefined && (typeof b.setup !== "string" || b.setup.length > SETUP_MAX)) throw new BridgeError("VALIDATION_FAILED", `setup must be text of at most ${SETUP_MAX} characters.`);
    if (b.tags !== undefined && !Array.isArray(b.tags)) throw new BridgeError("VALIDATION_FAILED", "tags must be a list of words.");
    const s = load();
    const cur = s.entries[tradeId] ?? { tags: [], notes: "", setup: "" };
    const next = {
      tags: b.tags !== undefined ? cleanTags(b.tags) : cur.tags ?? [],
      notes: b.notes !== undefined ? b.notes.trim() : cur.notes ?? "",
      setup: b.setup !== undefined ? b.setup.trim() : cur.setup ?? "",
      updatedAt: new Date(now()).toISOString(),
    };
    s.entries[tradeId] = next;
    persist();
    return { id: tradeId, ...next };
  }

  return { journal, annotate, entries: () => ({ ...load().entries }) };
}
