/**
 * Trade journal — stream S15 (tag "Analytics"). User-owned local notes about trades, plus statistics over them.
 * Nothing here can reach order placement: the only service it touches is the paper engine, read-only (`trades()`),
 * to turn closed paper round trips into journal entries.
 *
 *   GET    /v1/analytics/journal[?account=&strategy=&tag=&from=&to=&limit=]   entries, newest exit first
 *   POST   /v1/analytics/journal                                              add one entry
 *   DELETE /v1/analytics/journal/:entryId                                     remove one entry
 *   GET    /v1/analytics/journal/stats[?account=&strategy=&tag=&from=&to=]    journalStats() over the same filter
 *   POST   /v1/analytics/journal/import-paper?account=                        closed paper trades -> entries
 *
 * Persistence: <dataDir>/analytics/journal.json, written atomically (temp file, fsync, rename; 0600 in a 0700 dir).
 * A file that cannot be read is moved aside to "journal.json.corrupt-<ms>" rather than overwritten.
 * Entries without `account` are shared; entries with one are only visible to keys that may use that account.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BridgeError } from "../core/errors.mjs";
import { isStub } from "../core/contracts.mjs";
import { writeFileAtomic } from "../paper/paperStore.mjs";

export const JOURNAL_VERSION = 1;
export const MAX_ENTRIES = 20_000;
const IST_OFFSET_MS = 330 * 60_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10_000) / 10_000;

const isoTime = z.string().datetime({ offset: true });
const tag = z.string().trim().min(1).max(32);

export const entrySchema = z
  .strictObject({
    symbol: z.string().trim().min(1).max(64),
    side: z.enum(["buy", "sell", "BUY", "SELL"]).transform((s) => s.toLowerCase()),
    qty: z.number().finite().positive(),
    entryPrice: z.number().finite().min(0),
    exitPrice: z.number().finite().min(0),
    entryAt: isoTime,
    exitAt: isoTime,
    fees: z.number().finite().min(0).default(0),
    strategy: z.string().trim().max(64).default(""),
    tags: z.array(tag).max(20).default([]),
    notes: z.string().max(4000).default(""),
    account: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/).optional(),
  })
  .refine((e) => Date.parse(e.exitAt) >= Date.parse(e.entryAt), { message: "exitAt must not be before entryAt.", path: ["exitAt"] });

/** Net P&L of one entry: gross move in the trade's direction, minus fees. */
export function entryPnl(e) {
  const dir = String(e.side).toLowerCase() === "sell" ? -1 : 1;
  return r2(dir * (e.exitPrice - e.entryPrice) * e.qty - (e.fees ?? 0));
}

function bucketize(rows, keyOf) {
  const m = new Map();
  for (const r of rows) {
    for (const k of keyOf(r)) {
      const b = m.get(k) ?? { key: k, trades: 0, wins: 0, netPnl: 0 };
      b.trades += 1;
      if (r.pnl > 0) b.wins += 1;
      b.netPnl += r.pnl;
      m.set(k, b);
    }
  }
  return [...m.values()].map((b) => ({ key: b.key, trades: b.trades, netPnl: r2(b.netPnl), winRate: r4(b.wins / b.trades) }));
}

const brief = (r) => ({ id: r.id ?? null, symbol: r.symbol, side: r.side, exitAt: r.exitAt, pnl: r.pnl });

/**
 * Pure statistics over journal entries. Rates are fractions (0.5 = 50 %); money is rounded to 2 places.
 * profitFactor is null when there are no losses (it would be infinite). avgLoss is negative. maxDrawdown is the
 * largest peak-to-trough fall of the cumulative net P&L curve (starting at 0), reported as a positive amount.
 * @param {Array<object>} entries
 */
export function journalStats(entries) {
  const rows = (entries ?? [])
    .map((e) => ({ ...e, pnl: entryPnl(e) }))
    .sort((a, b) => Date.parse(a.exitAt) - Date.parse(b.exitAt));
  const n = rows.length;
  const wins = rows.filter((r) => r.pnl > 0);
  const losses = rows.filter((r) => r.pnl < 0);
  const grossProfit = wins.reduce((s, r) => s + r.pnl, 0);
  const grossLoss = losses.reduce((s, r) => s + r.pnl, 0);
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  const winRate = n ? wins.length / n : null;

  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  const curve = rows.map((r, i) => {
    cum += r.pnl;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    return { trade: i + 1, at: r.exitAt, cumPnl: r2(cum) };
  });

  const avgWin = wins.length ? grossProfit / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;
  const byWeekday = bucketize(rows, (r) => [WEEKDAYS[new Date(Date.parse(r.exitAt) + IST_OFFSET_MS).getUTCDay()]]).sort(
    (a, b) => WEEKDAYS.indexOf(a.key) - WEEKDAYS.indexOf(b.key),
  );
  const rank = (a, b) => b.netPnl - a.netPnl;
  const sorted = [...rows].sort((a, b) => b.pnl - a.pnl);

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    breakeven: n - wins.length - losses.length,
    netPnl: r2(net),
    grossProfit: r2(grossProfit),
    grossLoss: r2(grossLoss),
    fees: r2(rows.reduce((s, r) => s + (r.fees ?? 0), 0)),
    winRate: winRate === null ? null : r4(winRate),
    profitFactor: grossLoss < 0 ? r4(grossProfit / -grossLoss) : null,
    avgWin: avgWin === null ? null : r2(avgWin),
    avgLoss: avgLoss === null ? null : r2(avgLoss),
    expectancy: n ? r2(net / n) : null,
    maxDrawdown: r2(maxDd),
    best: n ? brief(sorted[0]) : null,
    worst: n ? brief(sorted[n - 1]) : null,
    byStrategy: bucketize(rows, (r) => [r.strategy || "(none)"]).sort(rank),
    byWeekday,
    byTag: bucketize(rows, (r) => (r.tags?.length ? r.tags : ["(untagged)"])).sort(rank),
    curve,
  };
}

/**
 * Turn paper fills (any order) into closed round trips. Fills are matched FIFO per account, symbol and product; a
 * fill that reduces an opposite lot closes (part of) it, and flips through zero open the remainder as a new lot.
 * Fees are split between the pieces in proportion to quantity. Open lots produce nothing.
 * @param {Array<object>} fills paper trades: { tradeId, accountId, symbol, side, product, qty, price, charges, tradedAt }
 * @returns {Array<object>} entries (without id) with `source: "paper"` and a stable `sourceKey`
 */
export function roundTripsFromFills(fills) {
  const ordered = fills
    .filter((f) => f && Number.isFinite(f.qty) && f.qty > 0 && Number.isFinite(f.price))
    .map((f, i) => ({ f, i }))
    .sort((a, b) => Date.parse(a.f.tradedAt) - Date.parse(b.f.tradedAt) || a.i - b.i)
    .map((x) => x.f);
  const books = new Map();
  const out = [];
  for (const f of ordered) {
    const dir = String(f.side).toUpperCase() === "SELL" ? -1 : 1;
    const key = `${f.accountId}|${f.symbol}|${f.product ?? ""}`;
    const lots = books.get(key) ?? [];
    books.set(key, lots);
    const feePerUnit = (f.charges ?? 0) / f.qty;
    let left = f.qty;
    while (left > 0 && lots.length && lots[0].dir !== dir) {
      const lot = lots[0];
      const q = Math.min(left, lot.qty);
      out.push({
        symbol: f.symbol,
        side: lot.dir === 1 ? "buy" : "sell",
        qty: q,
        entryPrice: lot.price,
        exitPrice: f.price,
        entryAt: lot.at,
        exitAt: f.tradedAt,
        fees: r2((lot.feePerUnit + feePerUnit) * q),
        strategy: "paper",
        tags: ["paper"],
        notes: "",
        account: f.accountId,
        source: "paper",
        sourceKey: `${lot.tradeId}>${f.tradeId}`,
      });
      lot.qty -= q;
      left -= q;
      if (lot.qty === 0) lots.shift();
    }
    if (left > 0) lots.push({ dir, qty: left, price: f.price, at: f.tradedAt, feePerUnit, tradeId: f.tradeId });
  }
  return out;
}

/** @param {{ paths: { dataDir: string }, paper?: object, logger?: object }} deps */
export function journalRoutes(deps) {
  const file = () => join(deps.paths.dataDir, "analytics", "journal.json");

  function load() {
    const path = file();
    if (!existsSync(path)) return [];
    try {
      const o = JSON.parse(readFileSync(path, "utf8"));
      if (o?.version === JOURNAL_VERSION && Array.isArray(o.entries)) return o.entries;
    } catch {
      /* fall through to quarantine */
    }
    const to = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, to);
    } catch {
      /* ignore */
    }
    deps.logger?.warn?.("journal file could not be read; moved aside and starting empty", { path, movedTo: to });
    return [];
  }
  const save = (entries) => writeFileAtomic(file(), JSON.stringify({ version: JOURNAL_VERSION, entries }));

  const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });
  const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });
  const opt = (q, name) => {
    const v = q.get(name);
    return v === null || v === "" ? undefined : v;
  };
  const accountParam = (ctx, required) => {
    const a = opt(ctx.query, "account");
    if (a === undefined) {
      if (required) throw invalid("account", "account is required.");
      return undefined;
    }
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(a)) throw invalid("account", "account is not a valid account id.");
    ctx.requireAccountAccess(a);
    return a;
  };
  const dateParam = (q, name) => {
    const v = opt(q, name);
    if (v === undefined) return undefined;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) throw invalid(name, `${name} must be a date or ISO timestamp.`);
    return t;
  };

  /** Entries this caller may see, narrowed by the query filters. */
  function filtered(ctx) {
    const q = ctx.query;
    const account = accountParam(ctx, false);
    const strategy = opt(q, "strategy");
    const tg = opt(q, "tag")?.toLowerCase();
    const from = dateParam(q, "from");
    const to = dateParam(q, "to");
    return load().filter((e) => {
      if (account !== undefined ? e.account !== account : e.account && !ctx.canAccessAccounts([e.account])) return false;
      if (strategy !== undefined && e.strategy !== strategy) return false;
      if (tg !== undefined && !e.tags?.some((t) => t.toLowerCase() === tg)) return false;
      const x = Date.parse(e.exitAt);
      return (from === undefined || x >= from) && (to === undefined || x <= to);
    });
  }
  const view = (e) => {
    const { sourceKey: _k, ...rest } = e;
    return { ...rest, pnl: entryPnl(e) };
  };

  return [
    [
      "GET",
      "/v1/analytics/journal",
      { scope: "read" },
      async (ctx) => {
        const lim = opt(ctx.query, "limit");
        if (lim !== undefined && (!/^\d+$/.test(lim) || Number(lim) < 1 || Number(lim) > 1000)) throw invalid("limit", "limit must be a whole number from 1 to 1000.");
        const all = filtered(ctx).sort((a, b) => Date.parse(b.exitAt) - Date.parse(a.exitAt));
        const items = all.slice(0, lim === undefined ? 200 : Number(lim)).map(view);
        return { data: { entries: items, total: all.length }, meta: meta(ctx) };
      },
    ],
    [
      "POST",
      "/v1/analytics/journal",
      { scope: "read" },
      async (ctx) => {
        const parsed = entrySchema.safeParse(ctx.body ?? {});
        if (!parsed.success) {
          const errors = parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(body)", message: i.message }));
          throw new BridgeError("VALIDATION_FAILED", `The entry is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, { errors });
        }
        if (parsed.data.account) ctx.requireAccountAccess(parsed.data.account);
        const entries = load();
        if (entries.length >= MAX_ENTRIES) throw invalid("(body)", `The journal is full (${MAX_ENTRIES} entries). Delete some first.`);
        const entry = { id: `j_${randomBytes(8).toString("hex")}`, ...parsed.data, source: "manual", createdAt: new Date().toISOString() };
        entries.push(entry);
        save(entries);
        return { data: view(entry), meta: meta(ctx) };
      },
    ],
    [
      "DELETE",
      "/v1/analytics/journal/:entryId",
      { scope: "read", body: "none" },
      async (ctx) => {
        const id = ctx.params.entryId;
        const entries = load();
        const at = entries.findIndex((e) => e.id === id);
        if (at < 0 || (entries[at].account && !ctx.canAccessAccounts([entries[at].account]))) throw new BridgeError("NOT_FOUND", "No journal entry with this id.");
        entries.splice(at, 1);
        save(entries);
        return { data: { deleted: id }, meta: meta(ctx) };
      },
    ],
    [
      "GET",
      "/v1/analytics/journal/stats",
      { scope: "read" },
      async (ctx) => ({ data: journalStats(filtered(ctx)), meta: meta(ctx) }),
    ],
    [
      "POST",
      "/v1/analytics/journal/import-paper",
      { scope: "read", body: "none" },
      async (ctx) => {
        const account = accountParam(ctx, true);
        const paper = deps.paper;
        if (!paper || isStub(paper) || typeof paper.trades !== "function") throw new BridgeError("NOT_FOUND", "The paper trading service is not available.");
        // Read-only: page through the paper fills (newest first), nothing is written back to paper.
        const fills = [];
        let cursor;
        do {
          const page = await paper.trades(account, { limit: 500, ...(cursor ? { cursor } : {}) });
          fills.push(...page.items);
          cursor = page.nextCursor ?? null;
        } while (cursor);
        const trips = roundTripsFromFills(fills);
        const entries = load();
        const known = new Set(entries.filter((e) => e.source === "paper" && e.account === account).map((e) => e.sourceKey));
        let imported = 0;
        for (const t of trips) {
          if (known.has(t.sourceKey)) continue;
          if (entries.length >= MAX_ENTRIES) break;
          entries.push({ id: `j_${randomBytes(8).toString("hex")}`, ...t, createdAt: new Date().toISOString() });
          imported += 1;
        }
        if (imported > 0) save(entries);
        return { data: { account, imported, skipped: trips.length - imported }, meta: meta(ctx, { accountId: account, mode: "paper" }) };
      },
    ],
  ];
}
