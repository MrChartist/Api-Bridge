/**
 * Studies: the ChartistScript core (server/vendor/chartist-core, the owner's code, compiled unchanged) run over a
 * symbol's candles. Pure: no I/O, no clock. The worker (worker.mjs) calls planJob and runJob; tests call them directly.
 *
 *   catalogue()            the studies (`ind.<id>`) and candlestick patterns the core offers, with their settings
 *   planJob(job)           check a job and compile it; gives how many earlier candles it needs (the warm-up)
 *   runJob(job, candles)   the job's output series and markers over the candles, aligned to them
 *
 * A job is { studies: [{ id, params?, key? }], patterns: [...] | "all" } or { script, inputs? }. Every study, every
 * group of up to 8 patterns, and a script each become one chart script that the core checks (as host "client-chart")
 * and runs (runIndicator) within its own budget. Study settings are checked against the core's own ranges before any
 * script text is written, so a request can never write script text of its own through them.
 *
 * The core reads one candle per session (daily, or weekly / monthly candles built by the Bridge): candles are passed
 * with their IST date as yyyymmdd. Two candles on one date cannot be read, so intraday intervals are refused (the
 * owner's chart does the same).
 */
import * as core from "../../vendor/chartist-core/index.js";
// Data only: each study's pane (on the price or in a panel of its own) and its integer / true-false fields. The public
// entry gives settings and outputs (FUNCTIONS) but not the pane.
import { STUDY_SPEC_BY_ID } from "../../vendor/chartist-core/stdlib/studies/specs.js";
import { BridgeError } from "../core/errors.mjs";

/** At most this many studies in one request. */
export const MAX_STUDIES = 16;
/** At most this many candles in the visible range (the warm-up comes on top, up to the core's MAX_LOOKBACK). */
export const MAX_BARS = 5000;
/** The whole request runs within this many elements touched: the core's own default budget for one run. */
export const REQUEST_BUDGET = core.DEFAULT_MAX_ELEMENTS;
/** Plots per chart script (the core's limit for one indicator). Patterns are run in groups of this size. */
const PLOTS_PER_SCRIPT = core.MAX_INDICATOR_PLOTS;

const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
const IST_OFFSET_MS = 330 * 60_000;

/** `src=` choices for studies that read the close: a series name, or a blend written as script text here. */
const SOURCES = Object.freeze({
  close: "close",
  open: "open",
  high: "high",
  low: "low",
  volume: "volume",
  hl2: "(high + low) / 2",
  hlc3: "(high + low + close) / 3",
  ohlc4: "(open + high + low + close) / 4",
});

/** Where a pattern's marker sits: under the low for bullish ones, over the high for bearish and neutral ones. */
const PATTERN_BIAS = Object.freeze({
  hammer: "bullish",
  bullish_marubozu: "bullish",
  dragonfly_doji: "bullish",
  bullish_engulfing: "bullish",
  bullish_harami: "bullish",
  piercing_line: "bullish",
  tweezer_bottom: "bullish",
  morning_star: "bullish",
  three_white_soldiers: "bullish",
  three_inside_up: "bullish",
  shooting_star: "bearish",
  bearish_marubozu: "bearish",
  gravestone_doji: "bearish",
  bearish_engulfing: "bearish",
  bearish_harami: "bearish",
  dark_cloud_cover: "bearish",
  tweezer_top: "bearish",
  evening_star: "bearish",
  three_black_crows: "bearish",
  three_inside_down: "bearish",
});
const biasOf = (id) => PATTERN_BIAS[id] ?? "neutral";

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const tooMuch = (detail) => new BridgeError("COMPUTE_LIMIT", detail);

// ── catalogue ──

const IND = new Map(core.FUNCTIONS.filter((f) => f.name.startsWith("ind.")).map((f) => [f.name.slice(4), f]));
const PATTERN_IDS = Object.freeze([...core.PATTERN_IDS]);

function paramInfo(p) {
  const a = p.arg;
  if (p.name === "src") return { name: "src", type: "source", values: Object.keys(SOURCES), default: "close" };
  if (a.t === "len") return { name: p.name, type: "int", min: a.min, max: a.max, default: p.default };
  if (a.t === "cnum") return { name: p.name, type: "number", min: a.min, max: a.max, default: p.default };
  if (a.t === "choice") return { name: p.name, type: "choice", values: [...a.values], default: p.default };
  return { name: p.name, type: a.t, default: p.default };
}

function outputsOf(id, f) {
  const spec = STUDY_SPEC_BY_ID.get(id);
  const types = spec?.fieldTypes ?? {};
  const fields = f.returns.kind === "record" ? Object.keys(f.returns.fields) : ["value"];
  return fields.map((name) => ({ name, type: types[name] ?? "float" }));
}

let cachedCatalogue = null;

/** Everything a client needs to offer studies: ids, settings with ranges and defaults, outputs, pane, causality. */
export function catalogue() {
  if (cachedCatalogue) return cachedCatalogue;
  const studies = [];
  for (const [id, f] of IND) {
    const spec = STUDY_SPEC_BY_ID.get(id);
    studies.push({
      id,
      summary: f.summary,
      pane: spec?.pane ?? "panel",
      available: f.tag !== null,
      ...(f.tag === null ? { reason: f.reason ?? "Not available yet." } : {}),
      causality: f.tag,
      params: f.params.map(paramInfo),
      outputs: outputsOf(id, f),
    });
  }
  studies.sort((a, b) => a.id.localeCompare(b.id));
  const patterns = PATTERN_IDS.map((id) => ({ id, bias: biasOf(id), position: biasOf(id) === "bullish" ? "below" : "above" }));
  cachedCatalogue = Object.freeze({
    studies,
    patterns,
    intervals: ["1d", "1w", "1M"],
    limits: {
      maxStudies: MAX_STUDIES,
      maxBars: MAX_BARS,
      maxLookback: core.MAX_LOOKBACK,
      scriptMaxChars: core.SOURCE_MAX_CHARS,
      scriptMaxLines: core.SOURCE_MAX_LINES,
      maxPlotsPerScript: core.MAX_INDICATOR_PLOTS,
      budgetElements: REQUEST_BUDGET,
    },
    core: { version: core.CORE_VERSION, stdlib: core.STDLIB_VERSION, ir: core.IR_VERSION, stdlibFrozen: core.STDLIB_IS_FROZEN },
  });
  return cachedCatalogue;
}

// ── jobs ──

/** A finite number as script text: plain digits, never an exponent. */
function numText(n) {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

/** Check one study's settings against the core's ranges; gives resolved settings and the call text. */
function studyCall(item, i) {
  const at = `studies[${i}]`;
  if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid(at, `${at} must be an object such as { "id": "sma", "params": { "length": 50 } }.`);
  const id = item.id;
  if (typeof id !== "string" || !IND.has(id)) throw invalid(`${at}.id`, `${at}.id is not a study id. GET /v1/studies lists them.`);
  const f = IND.get(id);
  if (f.tag === null) throw invalid(`${at}.id`, `The ${id} study is not available yet: ${f.reason ?? "not built"}`);
  const given = item.params ?? {};
  if (typeof given !== "object" || Array.isArray(given) || given === null) throw invalid(`${at}.params`, `${at}.params must be an object of settings.`);
  const byName = new Map(f.params.map((p) => [p.name, p]));
  for (const name of Object.keys(given)) if (!byName.has(name)) throw invalid(`${at}.params.${name}`, `${id} has no setting "${name}". Its settings: ${[...byName.keys()].join(", ") || "none"}.`);
  const params = {};
  const args = [];
  for (const p of f.params) {
    const v = given[p.name];
    const path = `${at}.params.${p.name}`;
    if (p.name === "src") {
      const s = v ?? "close";
      if (typeof s !== "string" || !Object.hasOwn(SOURCES, s)) throw invalid(path, `src must be one of ${Object.keys(SOURCES).join(", ")}.`);
      params.src = s;
      if (s !== "close") args.push(`src=${SOURCES[s]}`);
      continue;
    }
    const a = p.arg;
    if (v === undefined) {
      params[p.name] = p.default;
      continue;
    }
    if (a.t === "choice") {
      if (typeof v !== "string" || !a.values.includes(v)) throw invalid(path, `${p.name} must be one of ${a.values.join(", ")}.`);
      params[p.name] = v;
      args.push(`${p.name}="${v}"`);
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(path, `${p.name} must be a number.`);
    if (a.t === "len" && !Number.isInteger(v)) throw invalid(path, `${p.name} must be a whole number.`);
    if ((a.min !== undefined && v < a.min) || (a.max !== undefined && v > a.max)) throw invalid(path, `${p.name} must be from ${a.min} to ${a.max}.`);
    params[p.name] = v;
    args.push(`${p.name}=${numText(v)}`);
  }
  let key = item.key;
  if (key !== undefined && (typeof key !== "string" || !KEY_RE.test(key))) throw invalid(`${at}.key`, `${at}.key must be 1 to 40 letters, digits, dot, dash or underscore, starting with a letter.`);
  key ??= `${id}${i}`;
  return { key, id, f, params, call: `ind.${id}(${args.join(", ")})` };
}

/** The chart scripts of a job, each with what its plots mean. */
function unitsOf(job) {
  if (!job || typeof job !== "object") throw invalid("body", "Send a JSON object.");
  const hasScript = job.script !== undefined;
  const hasStudies = job.studies !== undefined || job.patterns !== undefined;
  if (hasScript && hasStudies) throw invalid("script", "Send either script, or studies and patterns, not both.");
  if (!hasScript && !hasStudies) throw invalid("studies", "Send studies (and or patterns), or a script.");
  if (hasScript) {
    if (typeof job.script !== "string" || job.script.trim() === "") throw invalid("script", "script must be ChartistScript text.");
    if ([...job.script].length > core.SOURCE_MAX_CHARS) throw tooMuch(`A script may have at most ${core.SOURCE_MAX_CHARS} characters.`);
    if (job.inputs !== undefined && (typeof job.inputs !== "object" || job.inputs === null || Array.isArray(job.inputs))) throw invalid("inputs", "inputs must be an object of setting values by name.");
    const source = job.script.endsWith("\n") ? job.script : `${job.script}\n`;
    return [{ kind: "script", source }];
  }
  const units = [];
  const list = job.studies ?? [];
  if (!Array.isArray(list)) throw invalid("studies", "studies must be a list.");
  if (list.length > MAX_STUDIES) throw tooMuch(`Ask for at most ${MAX_STUDIES} studies at a time.`);
  const keys = new Set();
  list.forEach((item, i) => {
    const s = studyCall(item, i);
    if (keys.has(s.key)) throw invalid(`studies[${i}].key`, `The key ${s.key} is used twice.`);
    keys.add(s.key);
    const fields = outputsOf(s.id, s.f);
    const record = s.f.returns.kind === "record";
    const lines = record ? [`s = ${s.call}`, ...fields.map((o) => `plot(s.${o.name}, "${o.name}")`)] : [`plot(${s.call}, "value")`];
    units.push({ kind: "study", key: s.key, id: s.id, params: s.params, fields, source: `${lines.join("\n")}\n` });
  });
  let pats = job.patterns ?? [];
  if (pats === "all") pats = PATTERN_IDS;
  if (!Array.isArray(pats)) throw invalid("patterns", 'patterns must be a list of pattern ids, or "all".');
  const seen = new Set();
  pats.forEach((p, i) => {
    if (typeof p !== "string" || !PATTERN_IDS.includes(p)) throw invalid(`patterns[${i}]`, `patterns[${i}] is not a pattern id. GET /v1/studies lists them.`);
    seen.add(p);
  });
  const ids = [...seen];
  for (let i = 0; i < ids.length; i += PLOTS_PER_SCRIPT) {
    const group = ids.slice(i, i + PLOTS_PER_SCRIPT);
    units.push({ kind: "patterns", ids: group, source: `${group.map((id) => `plot(candle.pattern("${id}"), "${id}")`).join("\n")}\n` });
  }
  if (!units.length) throw invalid("studies", "Ask for at least one study or pattern.");
  return units;
}

/** Compile a unit as a chart script. A script's own problems come back as VALIDATION_FAILED with line and column. */
function compileUnit(unit) {
  const r = core.compileSource(unit.source, { host: "client-chart" });
  if (!r.ok || !r.compiled) {
    const errs = (r.errors?.length ? r.errors : r.diagnostics).slice(0, 20);
    const where = unit.kind === "script" ? "script" : unit.kind === "study" ? `studies.${unit.key}` : "patterns";
    throw new BridgeError("VALIDATION_FAILED", unit.kind === "script" ? "The script has problems." : `The ${where} request could not be built.`, {
      errors: errs.map((d) => ({ path: where, message: `${d.code} line ${d.line}:${d.col ?? d.column ?? 0}: ${d.message}${d.hint ? ` (${d.hint})` : ""}`.slice(0, 400) })),
    });
  }
  const problem = core.indicatorProblem(r.compiled);
  if (problem) throw invalid("script", problem);
  return r.compiled;
}

/**
 * Check and compile a job.
 * @returns {{ warmBars: number, units: number, costPerBar: number }}
 *   warmBars: earlier candles the job needs before its first reliable value (the core's plan, at most MAX_LOOKBACK).
 */
export function planJob(job) {
  const units = unitsOf(job);
  let need = 0;
  let cost = 0;
  for (const u of units) {
    const c = compileUnit(u);
    need = Math.max(need, core.candlesticksNeeded(c.plan) - 1);
    cost += c.plan.costPerBar;
  }
  return { warmBars: Math.min(core.MAX_LOOKBACK, Math.max(0, need)), units: units.length, costPerBar: cost };
}

/** yyyymmdd of a candle's IST date. */
export function istYmd(timeSec) {
  const d = new Date(timeSec * 1000 + IST_OFFSET_MS);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** Candles (ascending, epoch seconds) as the core's daily input. Refuses two candles on one IST date. */
export function dailyInput(candles) {
  const n = candles.length;
  const date = new Array(n);
  const open = new Array(n);
  const high = new Array(n);
  const low = new Array(n);
  const close = new Array(n);
  const volume = new Array(n);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);
  for (let i = 0; i < n; i += 1) {
    const c = candles[i];
    date[i] = istYmd(c.time);
    if (i > 0 && !(date[i] > date[i - 1])) {
      throw new BridgeError("CAPABILITY_UNSUPPORTED", "Studies read one candle per session: daily, weekly or monthly candles. These candles share a date (intraday).");
    }
    open[i] = num(c.open);
    high[i] = num(c.high);
    low[i] = num(c.low);
    close[i] = num(c.close);
    volume[i] = num(c.volume);
  }
  return { date, open, high, low, close, volume };
}

const valuesOf = (arr, from) => {
  const out = new Array(arr.length - from);
  for (let i = from; i < arr.length; i += 1) out[i - from] = Number.isFinite(arr[i]) ? arr[i] : null;
  return out;
};

/** A core runtime error (budget, bad setting, missing data) as a Bridge error. */
function runError(err) {
  const code = typeof err?.code === "string" ? err.code : "";
  const msg = String(err?.message ?? "The calculation failed.").slice(0, 400);
  if (code === "E-BUDGET") return tooMuch(msg);
  if (code === "E-RT-INPUT") return invalid("inputs", msg);
  if (code === "E-RT-DATA") return new BridgeError("CAPABILITY_UNSUPPORTED", `${msg} Studies here get the symbol's own candles only.`);
  if (code.startsWith("E-")) return invalid("script", `${code}: ${msg}`);
  if (err instanceof RangeError) return invalid("script", msg);
  return err;
}

/**
 * Run a job over candles and keep the candles from index `from` on (the ones before are its warm-up).
 * @param {object} job
 * @param {Array<{ time: number, open: number, high: number, low: number, close: number, volume: number }>} candles ascending
 * @param {{ from?: number, budget?: number }} [o] budget: elements for the whole request (default REQUEST_BUDGET)
 * @returns {{ time: number[], series: object[], markers: object[], fills: object[], studies: object[], script?: object, usage: object }}
 */
export function runJob(job, candles, { from = 0, budget: total = REQUEST_BUDGET } = {}) {
  const units = unitsOf(job);
  const daily = dailyInput(candles);
  const n = candles.length;
  const start = Math.max(0, Math.min(from, n));
  const compiled = units.map(compileUnit);
  const estimate = compiled.reduce((s, c) => s + c.plan.costPerBar * n, 0);
  if (estimate > total) throw tooMuch(`This request would touch about ${Math.round(estimate)} values; the limit is ${total}. Ask for fewer candles or studies.`);
  const time = candles.slice(start).map((c) => c.time);
  const series = [];
  const markers = [];
  const fills = [];
  const studies = [];
  let script;
  let budget = total;
  units.forEach((u, k) => {
    const c = compiled[k];
    const maxElements = Math.max(1, Math.floor(budget));
    let columns;
    try {
      columns = core.runIndicator(c, daily, { maxElements, ...(u.kind === "script" && job.inputs ? { inputs: job.inputs } : {}) });
    } catch (err) {
      throw runError(err);
    }
    budget -= c.plan.costPerBar * n;
    const d = core.describeIndicator(c);
    const col = new Map(columns.map((x) => [x.key, x]));
    if (u.kind === "study") {
      const pane = STUDY_SPEC_BY_ID.get(u.id)?.pane ?? "panel";
      studies.push({ key: u.key, id: u.id, params: u.params, pane, causality: IND.get(u.id).tag, outputs: u.fields.map((o) => `${u.key}.${o.name}`), warmBars: core.candlesticksNeeded(c.plan) - 1 });
      const settings = Object.entries(u.params).filter(([k, v]) => !(k === "src" && v === "close")).map(([, v]) => v);
      const name = settings.length ? `${u.id}(${settings.join(", ")})` : u.id;
      d.plots.forEach((p, i) => {
        const field = u.fields[i];
        series.push({
          key: `${u.key}.${field.name}`,
          study: u.key,
          field: field.name,
          label: u.fields.length === 1 ? name : `${name} ${field.name}`,
          pane,
          style: "line",
          type: field.type,
          values: valuesOf(col.get(p.key).values, start),
        });
      });
    } else if (u.kind === "patterns") {
      d.plots.forEach((p, i) => {
        const id = u.ids[i];
        const bias = biasOf(id);
        const position = bias === "bullish" ? "below" : "above";
        const v = col.get(p.key).values;
        for (let j = start; j < n; j += 1) {
          if (v[j] !== 1) continue;
          const price = position === "below" ? daily.low[j] : daily.high[j];
          markers.push({ key: `pattern.${id}`, time: candles[j].time, price: Number.isFinite(price) ? price : null, position, shape: bias === "bullish" ? "triangle_up" : bias === "bearish" ? "triangle_down" : "dot", text: id, pattern: id, bias });
        }
      });
    } else {
      const pane = d.overlay ? "price" : "panel";
      script = { name: d.name, overlay: d.overlay, irHash: c.irHash, scriptHash: c.scriptHash, inputs: d.inputs.map((x) => ({ name: x.name, type: x.type, default: x.default, ...(x.min !== undefined ? { min: x.min } : {}), ...(x.max !== undefined ? { max: x.max } : {}), ...(x.options ? { options: x.options } : {}) })), warmBars: core.candlesticksNeeded(c.plan) - 1 };
      for (const p of d.plots) {
        const v = col.get(p.key).values;
        if (p.style === "markers") {
          for (let j = start; j < n; j += 1) {
            if (!Number.isFinite(v[j])) continue;
            markers.push({ key: p.key, time: candles[j].time, price: v[j], position: p.where ?? "above", shape: p.shape ?? "dot", text: p.text ?? p.label, ...(p.color?.kind === "fixed" ? { color: p.color.color } : {}) });
          }
          continue;
        }
        const colors = col.get(p.key).colors;
        series.push({
          key: p.key,
          study: "script",
          field: p.key,
          label: p.label,
          pane,
          style: p.style,
          type: "float",
          values: valuesOf(v, start),
          ...(p.level !== undefined ? { level: p.level } : {}),
          ...(p.width !== undefined ? { width: p.width } : {}),
          ...(p.color?.kind === "fixed" ? { color: p.color.color } : {}),
          ...(colors ? { colors: valuesOf(colors, start).map((code) => (code === null ? null : core.colorOfCode(code))) } : {}),
        });
      }
      for (const b of d.backgrounds) {
        series.push({ key: b.key, study: "script", field: b.key, label: "Background", pane, style: "background", type: "bool", values: valuesOf(col.get(b.key).values, start), ...(b.color?.kind === "fixed" ? { color: b.color.color } : {}) });
      }
      for (const f of d.fills) fills.push({ key: f.key, between: f.between, ...(f.color?.kind === "fixed" ? { color: f.color.color } : {}) });
    }
  });
  markers.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
  return { time, series, markers, fills, studies, ...(script ? { script } : {}), usage: { scripts: units.length, estimatedElements: Math.round(estimate), budgetElements: total } };
}
