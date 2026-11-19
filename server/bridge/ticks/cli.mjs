/**
 * `mc-bridge ticks ...`: the tick log and signal checks from the terminal. Works on the files in the data folder; the
 * Bridge does not need to be running (it may be: today's file is never rewritten).
 *
 *   mc-bridge ticks status                                  what is recorded, day by day, and the settings
 *   mc-bridge ticks audit [--from <day>] [--to <day>]        holes in seq, torn or bad lines (exit 1 when not complete)
 *   mc-bridge ticks compress                                 gzip finished days
 *   mc-bridge ticks run <signal.mjs> --from <day|time> [--to <day|time>] [--store ticklog|recordings] [--out <file>] [--name <export>]
 *   mc-bridge ticks verify <signal.mjs> --from ... [--to ...] [--live <outputs.jsonl>] [--tolerance <n>] [--store ...] [--name <export>]
 *
 * A signal file is an ES module that exports a defineSignal(...) result: as default, or by name (--name). It runs in
 * this process with your permissions, like any script you start yourself: only run files you wrote or trust.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../core/config.mjs";
import { BridgeError } from "../core/errors.mjs";
import { istDateOf } from "../reference/calendar.mjs";
import { ticksSettings } from "./config.mjs";
import { createOutputLog, readOutputs } from "./outputLog.mjs";
import { runHistorical } from "./runner.mjs";
import { auditTickLog, createRecordingStore, createTickLogStore } from "./store.mjs";
import { compressDay, listTickDays } from "./tickLog.mjs";
import { verifySignal } from "./verify.mjs";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const sizeText = (n) => (n < 1024 * 1024 ? `${Math.max(0, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const bad = (msg) => new BridgeError("VALIDATION_FAILED", msg);

/** "2026-11-18" (an IST day: its start, or its end with `end`) or an ISO time -> epoch ms. */
export function parseWhen(v, { end = false } = {}) {
  const s = String(v ?? "").trim();
  if (DAY_RE.test(s)) return Date.parse(`${s}T${end ? "23:59:59.999" : "00:00:00.000"}+05:30`);
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw bad(`"${s}" is not a day (2026-11-18) or a time (2026-11-18T09:15:00+05:30).`);
  return ms;
}

/** The range of --from / --to: --to defaults to the end of the --from day. */
export function rangeOf(flags) {
  if (!flags.from || flags.from === true) throw bad("Pass --from <day> (for example --from 2026-11-18).");
  const fromMs = parseWhen(flags.from);
  const toMs = flags.to && flags.to !== true ? parseWhen(flags.to, { end: true }) : parseWhen(istDateOf(fromMs), { end: true });
  if (toMs < fromMs) throw bad("--to is before --from.");
  return { fromMs, toMs };
}

const isSignal = (v) => v && typeof v === "object" && typeof v.name === "string" && Array.isArray(v.symbols) && typeof v.create === "function";

/** Import a signal module and pick its signal: --name, else the default export, else the only signal it exports. */
export async function loadSignal(file, { cwd, name } = {}) {
  if (!file) throw bad("Name the signal file: mc-bridge ticks run ./signals/my-signal.mjs --from 2026-11-18");
  const path = resolve(cwd ?? process.cwd(), String(file));
  if (!existsSync(path)) throw bad(`No file at ${path}.`);
  const mod = await import(pathToFileURL(path).href);
  if (name) {
    if (!isSignal(mod[name])) throw bad(`${file} exports no signal named "${name}".`);
    return mod[name];
  }
  if (isSignal(mod.default)) return mod.default;
  const found = Object.entries(mod).filter(([, v]) => isSignal(v));
  if (found.length === 1) return found[0][1];
  if (!found.length) throw bad(`${file} exports no signal. Export defineSignal({ name, symbols, create }) as default.`);
  throw bad(`${file} exports ${found.length} signals (${found.map(([k]) => k).join(", ")}); pick one with --name.`);
}

function storeOf(flags, dataDir) {
  const kind = flags.store === undefined ? "ticklog" : String(flags.store);
  if (kind === "ticklog") return createTickLogStore({ root: join(dataDir, "ticks") });
  if (kind === "recordings") return createRecordingStore({ dataDir });
  throw bad("--store must be ticklog or recordings.");
}

const comparisonLines = (label, c) => {
  if (!c) return [];
  const out = [`  ${c.identical ? "✓" : "✗"} ${label}: ${c.comparison.summary}`];
  const d = c.comparison.firstDivergence;
  if (d) out.push(`      first difference: ${d.kind} at ${new Date(d.time).toISOString()} ${d.symbol} (output ${d.n})${"expected" in d ? ` expected ${JSON.stringify(d.expected)}` : ""}${"actual" in d ? ` got ${JSON.stringify(d.actual)}` : ""}`);
  return out;
};

/**
 * @param {string[]} args  after "ticks"
 * @param {Record<string, any>} flags
 * @param {{ out: (s: string) => void, err: (s: string) => void, env: object, cwd: string }} io
 * @param {{ usage?: string, now?: () => number }} [ctx]
 */
export async function ticksCommand(args, flags, io, { usage = "", now = Date.now } = {}) {
  const [sub, file] = args;
  const { config } = loadConfig({ path: flags.config, env: io.env, cwd: io.cwd });
  const dataDir = config.dataDir;
  const root = join(dataDir, "ticks");
  const cfg = ticksSettings(config);

  switch (sub) {
    case "status": {
      const days = listTickDays(root);
      io.out(`Tick log: ${cfg.record ? "recording" : "off"} (ticks.record ${cfg.record}), folder ${root}`);
      io.out(`  symbols: ${cfg.symbols ? cfg.symbols.join(", ") : "every symbol the live feed carries"}; depth levels ${cfg.depthLevels}; keep ${cfg.keepDays ?? "every"} days${cfg.maxDiskMb ? `; at most ${cfg.maxDiskMb} MB` : ""}`);
      if (!days.length) {
        io.out("  No days recorded yet.");
        return 0;
      }
      for (const d of days) io.out(`  ${d.date}  ${sizeText(d.bytes).padStart(9)}${d.gz ? "  gzipped" : ""}`);
      io.out(`  ${days.length} files, ${sizeText(days.reduce((n, d) => n + d.bytes, 0))} in all. Check them with: mc-bridge ticks audit`);
      return 0;
    }
    case "audit": {
      const fromDate = flags.from && flags.from !== true ? istDateOf(parseWhen(flags.from)) : undefined;
      const toDate = flags.to && flags.to !== true ? istDateOf(parseWhen(flags.to, { end: true })) : undefined;
      const r = await auditTickLog({ root, fromDate, toDate });
      if (!r.days.length) {
        io.out("No tick log days in that range.");
        return 0;
      }
      for (const d of r.days) {
        const holes = d.holes.reduce((n, h) => n + h.to - h.from + 1, 0);
        io.out(`${d.date}  ${String(d.ticks).padStart(10)} ticks  seq ${d.firstSeq ?? "-"}..${d.lastSeq ?? "-"}  ${holes ? `${holes} missing in ${d.holes.length} holes` : "no holes"}${d.bad ? `, ${d.bad} bad lines` : ""}`);
        for (const h of d.holes.slice(0, 5)) io.out(`    missing seq ${h.from}..${h.to}`);
      }
      io.out(r.complete ? "Complete: every tick from first to last is there." : "Not complete: see the holes and bad lines above.");
      return r.complete ? 0 : 1;
    }
    case "compress": {
      const today = istDateOf(now());
      let saved = 0;
      let n = 0;
      for (const d of listTickDays(root)) {
        if (d.gz || d.date >= today) continue;
        saved += compressDay(root, d.date);
        n += 1;
      }
      io.out(n ? `Compressed ${n} finished days, ${sizeText(saved)} saved.` : "Nothing to compress: finished days are already gzipped.");
      return 0;
    }
    case "run": {
      const signal = await loadSignal(file, { cwd: io.cwd, name: flags.name });
      const range = rangeOf(flags);
      const store = storeOf(flags, dataDir);
      const log = flags.out && flags.out !== true ? createOutputLog({ path: resolve(io.cwd, String(flags.out)) }) : null;
      const r = await runHistorical(signal, store, range, { onOutput: log?.append, keep: !log });
      log?.close();
      io.out(`${signal.name} on ${store.id}${store.kind === "samples" ? " (samples, not every tick)" : ""}: ${r.ticks} ticks in, ${r.produced} outputs.`);
      if (log) io.out(`Outputs saved to ${log.path}`);
      else for (const o of r.outputs.slice(-5)) io.out(`  ${new Date(o.time).toISOString()} ${o.symbol} ${JSON.stringify(o.value)}`);
      return 0;
    }
    case "verify": {
      const signal = await loadSignal(file, { cwd: io.cwd, name: flags.name });
      const range = rangeOf(flags);
      const store = storeOf(flags, dataDir);
      const tolerance = flags.tolerance === undefined ? 0 : Number(flags.tolerance);
      if (!(tolerance >= 0)) throw bad("--tolerance must be a number, 0 or more.");
      let liveOutputs = null;
      if (flags.live && flags.live !== true) {
        const { outputs, bad: badLines } = readOutputs(resolve(io.cwd, String(flags.live)));
        liveOutputs = outputs;
        if (badLines) io.err(`Note: ${badLines} lines of the live output log could not be read (a torn last line after a crash is normal).`);
      }
      const r = await verifySignal(signal, store, range, { tolerance, liveOutputs });
      io.out(`${signal.name} on ${store.id}: ${r.ticks} ticks, ${r.outputs} outputs${tolerance ? `, tolerance ${tolerance}` : ""}`);
      for (const line of [
        ...comparisonLines("deterministic (history run twice)", r.checks.deterministic),
        ...comparisonLines("replay through the live StreamHub", r.checks.replay),
        ...comparisonLines("saved live run", r.checks.live),
      ])
        io.out(line);
      if (r.checks.replay?.rejected?.length) io.out(`      the replay refused ${r.checks.replay.rejected.length} symbols: ${r.checks.replay.rejected.map((x) => `${x.symbol} (${x.code})`).join(", ")}`);
      if (!r.outputs) io.out("Note: the signal gave no outputs in this range, so there was nothing to compare. Check the range and the symbols.");
      io.out(r.ok ? "Identical: history and live agree tick by tick." : "Not identical: see above.");
      return r.ok ? 0 : 1;
    }
    default:
      io.err(`Unknown ticks command "${sub ?? ""}".\n\n${usage}`);
      return 1;
  }
}
