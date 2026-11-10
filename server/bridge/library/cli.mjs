/**
 * `mc-bridge collections ...`: arrange named lists of instruments and option universes from the terminal. It talks to the
 * RUNNING Bridge over its API (the same way `notify` and `sources` do), so it needs a key: --key, or MCB_API_KEY. Reading needs
 * any key; changing things needs a key with the paper scope (the same key you use for the dashboard's Data page).
 *
 *   mc-bridge collections list [--tag t1,t2] [--kind static|option-universe] [--json]
 *   mc-bridge collections show <name> [--json]
 *   mc-bridge collections create <name> (--symbols a,b,c | --file symbols.csv) [--tags a,b] [--description text]
 *   mc-bridge collections universe <name> --underlying NIFTY [--expiries current-weekly|next-weekly|current-monthly|all-weekly|2026-11-24,...]
 *                                   [--strikes atm:10 | --from 24000 --to 26000] [--sides CE,PE] [--future] [--no-underlying] [--tags ..]
 *   mc-bridge collections resolve <name> [--allow-stale] [--spot <price>] [--json]
 *   mc-bridge collections tag <name> add|remove|set <t1,t2>
 *   mc-bridge collections rename <name> <new-name>
 *   mc-bridge collections duplicate <name> [<new-name>]
 *   mc-bridge collections delete <name> [--force]
 *   mc-bridge collections export <name> [--format json|csv] [--out file]
 *   mc-bridge collections import <file.csv|file.json> [--name n] [--tags a,b] [--replace] [--skip-invalid]
 *   mc-bridge collections usage <name>
 *   mc-bridge collections estimate <name> --interval 5m,1d --days 30
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { symbolsFromCsv, symbolsToCsv } from "./interchange.mjs";

const q = (s) => encodeURIComponent(s);
const bad = (msg) => new BridgeError("VALIDATION_FAILED", msg);
const text = (v) => (typeof v === "string" ? v : undefined);
const list = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const num = (v, flag) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${flag} must be a number.`);
  return n;
};
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The universe object from the command line flags. Exported for tests. */
export function universeFromFlags(flags) {
  const underlying = text(flags.underlying);
  if (!underlying) throw bad("universe needs --underlying, for example --underlying NIFTY.");
  const u = { underlying };
  const ex = text(flags.expiries);
  if (ex) u.expiries = /^\d{4}-\d{2}-\d{2}/.test(ex) ? list(ex) : ex;
  const from = num(flags.from, "--from");
  const to = num(flags.to, "--to");
  if (from !== undefined || to !== undefined) {
    if (from === undefined || to === undefined) throw bad("--from and --to go together.");
    u.strikes = { from, to };
  } else if (text(flags.strikes)) {
    const m = /^atm(?::(\d{1,3}))?$/.exec(flags.strikes);
    if (!m) throw bad("--strikes is atm:<count> (for example atm:10), or use --from and --to.");
    u.strikes = { around: "atm", ...(m[1] ? { count: Number(m[1]) } : {}) };
  }
  if (text(flags.sides)) u.sides = list(flags.sides).map((s) => s.toUpperCase());
  if (flags.future === true) u.includeFuture = true;
  if (flags["no-underlying"] === true) u.includeUnderlying = false;
  return u;
}

function showCollection(io, c) {
  io.out(`${c.name}  (${c.kind}, id ${c.id})`);
  if (c.description) io.out(`  ${c.description}`);
  io.out(`  tags: ${c.tags.length ? c.tags.join(", ") : "none"}`);
  if (c.previousNames?.length) io.out(`  earlier names: ${c.previousNames.join(", ")}`);
  if (c.kind === "static") {
    io.out(`  ${c.symbolCount} symbol${c.symbolCount === 1 ? "" : "s"}${c.symbols ? `: ${c.symbols.slice(0, 12).join(", ")}${c.symbols.length > 12 ? `, ... (${c.symbols.length - 12} more)` : ""}` : ""}`);
  } else {
    const u = c.universe;
    const strikes = "around" in u.strikes ? `${u.strikes.count} each side of the ATM strike` : `strikes ${u.strikes.from} to ${u.strikes.to}`;
    io.out(`  ${u.underlying} options, expiries ${Array.isArray(u.expiries) ? u.expiries.join(", ") : u.expiries}, ${strikes}, ${u.sides.join("+")}${u.includeUnderlying ? ", with the index/stock" : ""}${u.includeFuture ? ", with the future" : ""}`);
    io.out("  The symbols are worked out each time it is used: see 'collections resolve'.");
  }
}

/**
 * @param {string[]} args  after "collections"
 * @param {Record<string, string | boolean | undefined>} flags
 * @param {{ out(s: string): void, err(s: string): void, cwd?: string, env?: NodeJS.ProcessEnv }} io
 * @param {{ connect: () => Promise<{ call: (method: string, path: string, body?: any) => Promise<any> }>, cli: string, usage: string }} helpers
 */
export async function collectionsCommand(args, flags, io, helpers) {
  const [sub, name, a3, a4] = args;
  const cli = helpers.cli;
  const cwd = io.cwd ?? process.cwd();
  const file = (p) => (isAbsolute(p) ? p : resolve(cwd, p));
  const need = (what) => {
    if (!name) throw bad(`${sub} needs ${what}. List them with: ${cli} collections list`);
  };
  const SUBS = ["list", "show", "create", "universe", "resolve", "tag", "rename", "duplicate", "delete", "export", "import", "usage", "estimate"];
  if (!SUBS.includes(sub)) {
    io.err(helpers.usage);
    return 1;
  }
  if (sub !== "list") need("a collection name");
  const { call } = await helpers.connect();

  if (sub === "list") {
    const qs = new URLSearchParams();
    if (text(flags.tag)) qs.set("tag", flags.tag);
    if (text(flags.kind)) qs.set("kind", flags.kind);
    const { data } = await call("GET", `/v1/collections${qs.size ? `?${qs}` : ""}`);
    if (flags.json) io.out(JSON.stringify(data, null, 2));
    else if (!data.length) io.out(`No collections yet. Make one with: ${cli} collections create <name> --symbols NSE:RELIANCE,NSE:INFY`);
    else {
      const w = Math.max(...data.map((c) => c.name.length));
      for (const c of data) io.out(`${c.name.padEnd(w)}  ${c.kind === "static" ? `${c.symbolCount} symbols`.padEnd(16) : "option universe".padEnd(16)}  ${c.tags.join(",")}`.trimEnd());
    }
    return 0;
  }

  if (sub === "show") {
    const { data } = await call("GET", `/v1/collections/${q(name)}`);
    if (flags.json) io.out(JSON.stringify(data, null, 2));
    else showCollection(io, data);
    return 0;
  }

  if (sub === "create") {
    let symbols = list(flags.symbols);
    if (text(flags.file)) {
      const p = file(flags.file);
      if (!existsSync(p)) throw bad(`There is no file at ${p}.`);
      symbols = [...(symbols ?? []), ...symbolsFromCsv(readFileSync(p, "utf8")).values];
    }
    if (!symbols) throw bad("create needs --symbols NSE:RELIANCE,NSE:INFY or --file symbols.csv. For an option universe use: collections universe.");
    const { data } = await call("POST", "/v1/collections", { name, symbols, tags: list(flags.tags), description: text(flags.description) });
    io.out(`Created "${data.name}" with ${data.symbolCount} symbol${data.symbolCount === 1 ? "" : "s"}.`);
    return 0;
  }

  if (sub === "universe") {
    const { data } = await call("POST", "/v1/collections", { name, kind: "option-universe", universe: universeFromFlags(flags), tags: list(flags.tags), description: text(flags.description) });
    io.out(`Created the option universe "${data.name}". See what it means today with: ${cli} collections resolve ${data.name}`);
    return 0;
  }

  if (sub === "resolve") {
    const qs = new URLSearchParams();
    if (flags["allow-stale"] === true) qs.set("allowStale", "true");
    if (text(flags.spot)) qs.set("spot", flags.spot);
    const { data } = await call("GET", `/v1/collections/${q(name)}/resolve${qs.size ? `?${qs}` : ""}`);
    if (flags.json) {
      io.out(JSON.stringify(data, null, 2));
      return 0;
    }
    io.out(`${data.name}: ${data.count} symbols at ${data.resolvedAt}`);
    io.out(`Rule: ${data.rule}`);
    if (data.kind === "option-universe") {
      const u = data.underlying;
      io.out(`Price: ${u.price === null ? "none" : `${u.symbol} ${u.price}`} (${data.atmSource}${u.class && u.class !== "realtime" ? `, ${u.class}` : ""}${u.asOf ? `, as of ${u.asOf}` : ""})`);
      for (const e of data.expiries) io.out(`Expiry ${e.expiry} (${e.kind}${e.shifted ? ", shifted" : ""}): ATM ${e.atm ?? "-"}, step ${e.step ?? "-"}, ${e.strikes} strikes ${e.first ?? ""}-${e.last ?? ""}`);
    }
    for (const w of data.warnings) io.out(`Note: ${w}`);
    for (const s of data.symbols) io.out(s);
    return 0;
  }

  if (sub === "tag") {
    const op = a3;
    const tags = list(a4);
    if (!["add", "remove", "set"].includes(op) || !tags) throw bad(`Use: ${cli} collections tag <name> add|remove|set <tag1,tag2>`);
    const { data: cur } = await call("GET", `/v1/collections/${q(name)}`);
    const next = op === "set" ? tags : op === "add" ? [...cur.tags, ...tags] : cur.tags.filter((t) => !tags.map((x) => x.toLowerCase()).includes(t));
    const { data } = await call("PATCH", `/v1/collections/${q(name)}`, { tags: next });
    io.out(`${data.name}: tags are now ${data.tags.length ? data.tags.join(", ") : "none"}.`);
    return 0;
  }

  if (sub === "rename") {
    if (!a3) throw bad(`Use: ${cli} collections rename <name> <new-name>`);
    const { data } = await call("PATCH", `/v1/collections/${q(name)}`, { name: a3 });
    io.out(`Renamed to "${data.name}". The old name "${name}" keeps finding it.`);
    return 0;
  }

  if (sub === "duplicate") {
    const { data } = await call("POST", `/v1/collections/${q(name)}/duplicate`, a3 ? { name: a3 } : {});
    io.out(`Copied to "${data.name}".`);
    return 0;
  }

  if (sub === "delete") {
    await call("DELETE", `/v1/collections/${q(name)}${flags.force === true ? "?force=true" : ""}`);
    io.out(`Deleted "${name}".`);
    return 0;
  }

  if (sub === "export") {
    const fmt = (text(flags.format) ?? "json").toLowerCase();
    if (!["json", "csv"].includes(fmt)) throw bad("--format must be json or csv.");
    let body;
    if (fmt === "csv") {
      const { data } = await call("GET", `/v1/collections/${q(name)}/resolve?allowStale=true`);
      body = symbolsToCsv(data.symbols);
    } else {
      const { data } = await call("GET", `/v1/collections/${q(name)}`);
      body = `${JSON.stringify({ version: 1, collection: { name: data.name, description: data.description, tags: data.tags, kind: data.kind, ...(data.kind === "static" ? { symbols: data.symbols } : { universe: data.universe }) } }, null, 2)}\n`;
    }
    if (text(flags.out)) {
      const p = file(flags.out);
      if (existsSync(p)) throw bad(`${p} already exists. Choose another file name; nothing is overwritten.`);
      writeFileSync(p, body, { flag: "wx" });
      io.out(`Wrote ${p} (${kb(Buffer.byteLength(body))}).`);
    } else io.out(body.trimEnd());
    return 0;
  }

  if (sub === "import") {
    const p = file(name);
    if (!existsSync(p)) throw bad(`There is no file at ${p}.`);
    const content = readFileSync(p, "utf8");
    const isCsv = /\.(csv|txt)$/i.test(p) || !/^\s*[[{]/.test(content);
    const qs = new URLSearchParams();
    if (flags.replace === true) qs.set("replace", "true");
    if (flags["skip-invalid"] === true) qs.set("skipInvalid", "true");
    let body;
    if (isCsv) {
      const base = p.split(/[\\/]/).pop().replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]/g, "-");
      body = { format: "csv", csv: content, name: text(flags.name) ?? base, tags: list(flags.tags), description: text(flags.description) };
    } else {
      try {
        body = JSON.parse(content);
      } catch {
        throw bad(`${p} is not valid JSON.`);
      }
      if (text(flags.name)) qs.set("name", flags.name);
      if (text(flags.tags)) qs.set("tags", flags.tags);
    }
    const { data } = await call("POST", `/v1/collections/import${qs.size ? `?${qs}` : ""}`, body);
    for (const c of data.created) io.out(`Created "${c.name}" (${c.kind === "static" ? `${c.symbolCount} symbols` : "option universe"}).`);
    for (const c of data.replaced) io.out(`Replaced "${c.name}".`);
    for (const w of data.warnings) io.out(`Note: ${w}`);
    return 0;
  }

  if (sub === "usage") {
    const { data } = await call("GET", `/v1/collections/${q(name)}/usage`);
    if (flags.json) {
      io.out(JSON.stringify(data, null, 2));
      return 0;
    }
    io.out(`${data.name}: used by ${data.total} thing${data.total === 1 ? "" : "s"}.`);
    for (const kind of ["downloads", "recordings", "rules", "datasets"]) {
      if (data.sources[kind] !== "available") io.out(`  ${kind}: not counted (${data.sources[kind] === "error" ? "could not be read" : "that part of the Bridge is off"})`);
      else io.out(`  ${kind}: ${data[kind].length ? data[kind].map((r) => r.label ?? r.id).join(", ") : "none"}`);
    }
    return 0;
  }

  if (sub === "estimate") {
    const intervals = text(flags.interval) ?? text(flags.intervals);
    if (!intervals || !text(flags.days)) throw bad(`Use: ${cli} collections estimate <name> --interval 5m,1d --days 30`);
    const qs = new URLSearchParams({ intervals, days: flags.days });
    const { data } = await call("GET", `/v1/collections/${q(name)}/estimate?${qs}`);
    if (flags.json) {
      io.out(JSON.stringify(data, null, 2));
      return 0;
    }
    io.out(`${data.name}: ${data.symbols} symbols x ${data.intervals.join(", ")} x ${data.days} days (${data.tradingDays} trading days)`);
    io.out(`About ${data.rows.toLocaleString("en-IN")} rows, ${kb(data.bytes)} as CSV, ${data.brokerCalls.toLocaleString("en-IN")} broker calls.`);
    for (const w of data.warnings) io.out(`Note: ${w}`);
    for (const n of data.notes) io.out(`Note: ${n}`);
    return 0;
  }
  return 1;
}
