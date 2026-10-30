// algo-core.js: the pure part of Trade › Algo (Python strategies, docs/STRATEGIES-PYTHON.md). Status words and tones,
// the params form model and its checks (the same rules as the SDK's Param and the Bridge's checkParams), uptime text,
// totals for the summary strip, and the template on the "How to write one" panel. No DOM, no fetch. Numbers become
// text only through format.js.
import { DASH, formatInt, formatNumber } from "./format.js";

/** A limit as typed in the strategy file: 10, 0.05, 1.2 (no grouping, no trailing zeros). */
const plain = (v) => formatNumber(v, { maximumFractionDigits: 6, useGrouping: false });

/** Status -> { text, tone }; tone is a pill class (ok, warn, bad, info, or "" for neutral). */
export const STATUS = Object.freeze({
  stopped: { text: "Stopped", tone: "" },
  starting: { text: "Starting", tone: "info" },
  running: { text: "Running", tone: "ok" },
  stopping: { text: "Stopping", tone: "warn" },
  restarting: { text: "Restarting", tone: "warn" },
  finished: { text: "Finished", tone: "" },
  failed: { text: "Failed", tone: "bad" },
});
export const statusOf = (s) => STATUS[s] ?? { text: s ? `${String(s)[0].toUpperCase()}${String(s).slice(1)}` : DASH, tone: "" };
/** Whether a strategy holds a process (or is about to): Stop is the action, not Start. */
export const isActive = (s) => s === "starting" || s === "running" || s === "stopping" || s === "restarting";

/** "45 s", "12 min", "2 h 05 min", "3 d 4 h". Missing -> DASH. */
export function uptimeText(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms)) || Number(ms) < 0) return DASH;
  const s = Math.floor(Number(ms) / 1000);
  if (s < 60) return `${formatInt(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${formatInt(m)} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${formatInt(h)} h ${formatInt(m % 60).padStart(2, "0")} min`;
  return `${formatInt(Math.floor(h / 24))} d ${formatInt(h % 24)} h`;
}

/** A param's label: its own label, else its name in words ("stop_loss_pct" -> "Stop loss %"). */
export function paramLabel(p) {
  if (p.label) return p.label;
  const words = String(p.name).split("_").filter(Boolean).map((w) => (w === "pct" ? "%" : w === "pcr" ? "PCR" : w === "oi" ? "OI" : w === "ema" ? "EMA" : w));
  const t = words.join(" ");
  return t ? `${t[0].toUpperCase()}${t.slice(1)}` : p.name;
}

/**
 * The form for a strategy's declared params: one field per param with its current value (saved, else default).
 * @param {Array<{ name: string, kind: string, default: unknown, min?: number, max?: number, step?: number, choices?: unknown[], help?: string, label?: string }>} params
 * @param {Record<string, unknown>} values
 */
export function paramFields(params, values = {}) {
  return (params ?? []).map((p) => {
    const value = Object.hasOwn(values ?? {}, p.name) ? values[p.name] : p.default;
    const input = p.kind === "bool" ? "checkbox" : p.kind === "choice" ? "select" : p.kind === "str" ? "text" : "number";
    const step = p.step ?? (p.kind === "int" ? 1 : p.kind === "float" ? "any" : undefined);
    return { name: p.name, kind: p.kind, label: paramLabel(p), help: p.help ?? "", input, value, def: p.default, min: p.min, max: p.max, step, choices: p.choices ?? null, changed: value !== p.default };
  });
}

/** One raw form value as the param's kind: { value } or { error } (the SDK's Param.coerce rules). */
export function readParam(field, raw) {
  if (field.kind === "bool") return { value: raw === true || raw === "true" || raw === "on" };
  if (field.kind === "choice") {
    const hit = (field.choices ?? []).find((c) => String(c) === String(raw));
    return hit === undefined ? { error: `Choose one of ${(field.choices ?? []).join(", ")}` } : { value: hit };
  }
  if (field.kind === "str") {
    const t = String(raw ?? "");
    return t.length > 200 ? { error: "At most 200 characters" } : { value: t };
  }
  const t = String(raw ?? "").trim();
  if (t === "") return { error: "Enter a number" };
  const n = Number(t);
  if (!Number.isFinite(n)) return { error: "Enter a number" };
  if (field.kind === "int" && !Number.isInteger(n)) return { error: "Enter a whole number" };
  if (field.min !== undefined && field.min !== null && n < field.min) return { error: `At least ${plain(field.min)}` };
  if (field.max !== undefined && field.max !== null && n > field.max) return { error: `At most ${plain(field.max)}` };
  return { value: n };
}

/** Read a whole form: { values, errors: { name: message } }. `raw` maps a name to its input's value. */
export function readParams(fields, raw) {
  const values = {};
  const errors = {};
  for (const f of fields) {
    const r = readParam(f, raw[f.name]);
    if (r.error) errors[f.name] = r.error;
    else values[f.name] = r.value;
  }
  return { values, errors };
}

/** Totals for the summary strip: running, P&L today and orders today over every strategy. */
export function totals(items) {
  let pnl = 0;
  let withPnl = 0;
  let orders = 0;
  let running = 0;
  for (const s of items ?? []) {
    if (isActive(s.status)) running += 1;
    if (s.pnl && Number.isFinite(s.pnl.total)) {
      pnl += s.pnl.total;
      withPnl += 1;
    }
    orders += Number(s.orderCount) || 0;
  }
  return { running, count: (items ?? []).length, pnl: withPnl ? Math.round(pnl * 100) / 100 : null, orders };
}

/** "Paper" or "Live" for a strategy's mode chip. */
export const modeText = (m) => (m === "live" ? "Live" : "Paper");

/** Heartbeat in words for a running strategy: "Heartbeat 2 s ago", or a warning once it is late. */
export function heartbeatText(ageMs) {
  if (ageMs === null || ageMs === undefined || !Number.isFinite(Number(ageMs))) return { text: "No heartbeat yet", late: false };
  const s = Math.max(0, Math.round(Number(ageMs) / 1000));
  return { text: `Heartbeat ${formatInt(s)} s ago`, late: s > 15 };
}

/** The server's per-field errors ({ path: "params.lots", message }) as { lots: message }. */
export function serverFieldErrors(err) {
  const out = {};
  for (const e of err?.body?.errors ?? []) {
    const m = /^params\.(\w+)$/.exec(String(e.path ?? ""));
    if (m) out[m[1]] = e.message;
  }
  return out;
}

export const DOCS_URL = "https://github.com/MrChartist/api-bridge/blob/main/docs/STRATEGIES-PYTHON.md";

/** The copyable starting point on "How to write one". */
export const TEMPLATE = `"""My strategy: what it does, in one line."""

from mrchartist_bridge.strategy import Param, Strategy


class MyStrategy(Strategy):
    name = "My strategy"
    description = "Buys the NIFTY ATM call when a 1 minute bar closes up."
    symbols = ["NSE:NIFTY"]          # live ticks for on_tick, bars for on_bar
    timeframes = ["1m"]              # 15s to 1h
    params = {                       # the form on this page
        "lots": Param(1, min=1, max=10, help="Lots per order"),
        "max_trades": Param(3, min=1, max=20, help="Entries per day at most"),
    }

    def on_start(self):
        self.trades = 0
        self.log.info("Ready on %s (%s)", self.account, self.mode)

    def on_bar(self, bar, timeframe):
        if self.trades >= self.p.max_trades or any(self.positions().values()):
            return
        if bar.close > bar.open:
            expiry = self.nearest_expiry("NIFTY")
            chain = self.option_chain("NIFTY", expiry, strikes=1, greeks=False)
            row = next(r for r in chain["rows"] if r["strike"] == chain["atmStrike"])
            self.buy(row["ce"]["symbol"], lots=self.p.lots)   # paper unless started live
            self.trades += 1

    def on_order_update(self, order):
        self.log.info("Order %s is %s", order["orderId"], order["status"])

    def on_stop(self):
        self.exit_all()                  # closes only this strategy's positions
`;
