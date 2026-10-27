/**
 * Route handlers for stream S12 (docs/openapi.yaml, tag "Backup data").
 *
 *   GET /v1/backup/status                                     providers, pacing, health (no network calls)
 *   GET /v1/backup/quotes?symbols=NSE:RELIANCE,NSE:NIFTY      straight from the backup sources, skipping brokers
 *   GET /v1/backup/history?symbol=NSE:INFY&interval=1d&(from=&to= | countback=N)
 *
 * The normal /v1/ltp, /v1/quotes, /v1/history, /v1/expiries and /v1/optionchain already fall back to these sources
 * on their own (backup.autoFallback); these routes are for checking a source directly or for reads that should
 * never spend broker budget (a nightly scan of daily candles, for example).
 */
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { INTERVALS, countbackRange } from "../market/history.mjs";
import { freshness, quoteFields, toLtpItem, toQuoteItem } from "../market/normalise.mjs";
import { parseTimeInput } from "../market/time.mjs";

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};

export function createBackupRoutes(deps) {
  const svc = () => deps.backupData;
  const now = () => deps.clock.now();

  return {
    async status(ctx) {
      return { data: svc().status(), meta: { requestId: ctx.requestId } };
    },

    async quotes(ctx) {
      const list = String(ctx.query.get("symbols") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!list.length) throw invalid("symbols", "symbols is required: a comma-separated list such as NSE:NIFTY,NSE:RELIANCE.");
      if (list.length > 200) throw invalid("symbols", "Ask for at most 200 symbols at a time.");
      const ltpOnly = opt(ctx.query, "fields") === "ltp";
      const r = await svc().quotes(list);
      const t = now();
      const data = r.items.map((it) => {
        const f = freshness({ source: "backup", at: it.at, now: t, targetMs: 0, provider: it.provider });
        return ltpOnly ? toLtpItem(it.symbol, { ltp: it.fields.ltp }, f) : toQuoteItem(it.symbol, quoteFields(it.fields) ?? it.fields, f);
      });
      return { data, errors: r.errors, meta: { requestId: ctx.requestId } };
    },

    async history(ctx) {
      const q = ctx.query;
      const symbol = opt(q, "symbol");
      if (!symbol) throw invalid("symbol", "symbol is required, for example NSE:NIFTY.");
      const interval = opt(q, "interval");
      if (!interval || !INTERVALS.includes(interval)) throw invalid("interval", `interval must be one of ${INTERVALS.join(", ")}.`);
      const t = now();
      const toMs = Math.min(t, opt(q, "to") !== undefined ? parseTimeInput(opt(q, "to"), { endOfDay: true, field: "to" }) : t);
      let fromMs;
      if (opt(q, "from") !== undefined) fromMs = parseTimeInput(opt(q, "from"), { field: "from" });
      else {
        const cb = Number(opt(q, "countback"));
        if (!Number.isInteger(cb) || cb < 1 || cb > 5000) throw invalid("countback", "Give from (and optionally to), or countback from 1 to 5000.");
        fromMs = countbackRange({ toMs, countback: cb, interval, exchange: parseSymbol(symbol).exchange });
      }
      if (fromMs > toMs) throw invalid("from", "from must be before to.");
      const r = await svc().history({ symbol, interval, fromMs, toMs });
      let candles = r.candles;
      const cb = Number(opt(q, "countback"));
      if (Number.isInteger(cb) && cb > 0 && candles.length > cb) candles = candles.slice(candles.length - cb);
      const data = { symbol: r.symbol, interval, candles, partial: r.partial, freshness: freshness({ source: "backup", at: r.at, now: t, targetMs: 0, provider: r.provider }) };
      return { data, meta: { requestId: ctx.requestId, freshness: data.freshness } };
    },
  };
}
