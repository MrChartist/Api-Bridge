/**
 * `mc-bridge record ...`: start, watch and manage recordings from the terminal. It talks to the RUNNING Bridge over
 * loopback with an admin key (the same way `notify` and `sources` do).
 *
 *   mc-bridge record quotes <symbols...> --every 1 [--all-day] [--format jsonl] [--name n] [--keep-days n] [--max-disk-mb n]
 *   mc-bridge record chain <UNDERLYING> --every 30 [--expiry 2026-11-12] [--strikes 10] [--all-day] [--name n]
 *   mc-bridge record list | status
 *   mc-bridge record show <id> | files <id> | pause <id> | resume <id> | stop <id> | delete <id>
 *   mc-bridge record auto on | off | status
 *   mc-bridge record rules
 *   mc-bridge record rule add quotes|chain <symbols or UNDERLYINGS (comma separated)> --every 30 [--strikes 10] [--expiry current-weekly]
 *                    [--days mon,tue,wed --start 09:15 --end 15:30] [--name n] [--keep-days n] [--format jsonl]
 *   mc-bridge record rule on|off|remove <id> [--delete-files]
 *   mc-bridge record preset index-option-chains | my-watchlist [--collection name]
 */
import { BridgeError } from "../core/errors.mjs";

const KB = 1024;
const MB = KB * KB;
export const sizeText = (n) => (n < 0.95 * MB ? `${Math.max(0, Math.round(n / KB))} KB` : n < 1024 * MB ? `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB` : `${(n / MB / 1024).toFixed(1)} GB`);

/** One line per recording for `record list`. @param {any} r */
export function recordingLine(r) {
  return `${r.id}  ${r.status.padEnd(9)} ${r.kind.padEnd(6)} every ${String(r.everySec).padStart(3)} s  ${String(r.symbols.count).padStart(4)} symbols  ${String(r.rows).padStart(9)} rows  ${sizeText(r.bytes).padStart(8)}  ${r.name}`;
}

/** The lines of `record show`. @param {any} r */
export function showLines(r) {
  const out = [`${r.name} (${r.id})`, `  ${r.statusText}`];
  out.push(`  kind ${r.kind}, every ${r.everySec} s, ${r.sessionOnly ? "market hours only" : "all day"}, format ${r.format}, data class ${r.dataClass}`);
  if (r.symbols.rule) out.push(`  symbols: ${r.symbols.count} chosen by: ${r.symbols.rule}`);
  else out.push(`  symbols: ${r.symbols.count}`);
  for (const n of r.symbols.notes ?? []) out.push(`    note: ${n}`);
  out.push(`  saved: ${r.rows} rows, ${sizeText(r.bytes)}; today ${r.today.rows} rows${r.lastWriteAt ? `; last write ${r.lastWriteAt}` : ""}`);
  out.push(`  gaps: ${r.gaps.total} in total, ${r.gaps.today} today${r.gaps.open ? `; open now: ${r.gaps.open.message}` : ""}`);
  for (const g of r.gaps.recent ?? []) out.push(`    ${g.from} to ${g.to ?? "now"}  ${g.reason}${g.seconds != null ? ` (${g.seconds} s)` : ""}`);
  if (r.refused.total) out.push(`  not recorded because not real-time: ${r.refused.total} answers. ${r.refused.last?.reason ?? ""}`);
  out.push(`  API calls today: ${r.apiCalls.madeToday} made, ${r.apiCalls.savedToday} saved by the live feed and the cache`);
  out.push(`  disk: ${sizeText(r.disk.usedBytes)} of ${r.disk.limitMb ? `${r.disk.limitMb} MB (this recording)` : `${r.disk.totalLimitMb} MB (all recordings)`}`);
  return out;
}

const list = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean);
const num = (flags, name) => {
  if (flags[name] === undefined) return undefined;
  const n = Number(flags[name]);
  if (!Number.isFinite(n)) throw new BridgeError("VALIDATION_FAILED", `--${name} must be a number.`);
  return n;
};
const need = (v, what) => {
  if (!v) throw new BridgeError("VALIDATION_FAILED", what);
  return v;
};

/** The target part of a body from `quotes`/`chain` arguments. */
function targetFrom(kind, args, flags, cli) {
  const body = {};
  if (flags.collection) {
    body.collection = String(flags.collection);
    return body;
  }
  if (kind === "chain") {
    const names = args.flatMap(list).map((s) => s.toUpperCase());
    need(names.length, `chain needs an underlying, for example: ${cli} record chain NIFTY --every 30`);
    body.underlying = names.length === 1 ? names[0] : names;
    return body;
  }
  const symbols = args.flatMap(list);
  need(symbols.length, `quotes needs symbols, for example: ${cli} record quotes NSE:NIFTY NSE:RELIANCE --every 1`);
  body.symbols = symbols;
  return body;
}

/**
 * @param {string[]} args  after "record"
 * @param {Record<string, string | boolean | undefined>} flags
 * @param {{ out(s: string): void, err(s: string): void, env: NodeJS.ProcessEnv }} io
 * @param {{ connect: () => Promise<{ call: (method: string, path: string, body?: any) => Promise<any> }>, cli: string, usage: string }} helpers
 */
export async function recordCommand(args, flags, io, helpers) {
  const [sub, a, b, ...rest] = args;
  const cli = helpers.cli;
  const json = flags.json === true;
  const show = (data, text) => io.out(json ? JSON.stringify(data, null, 2) : text);
  const id = (v, what = "a recording id (see: record list)") => need(v, `${sub} needs ${what}.`);

  if (sub === "quotes" || sub === "chain") {
    const { call } = await helpers.connect();
    const body = { kind: sub, ...targetFrom(sub, [a, b, ...rest].filter(Boolean), flags, cli), everySec: need(num(flags, "every"), `${sub} needs --every <seconds>${sub === "chain" ? " (at least 15)" : ""}.`) };
    if (flags.name) body.name = String(flags.name);
    if (flags.format) body.format = String(flags.format);
    if (flags["all-day"] === true) body.sessionOnly = false;
    if (sub === "chain" && flags.expiry) body.expiry = String(flags.expiry);
    if (sub === "chain" && flags.strikes !== undefined) body.strikes = num(flags, "strikes");
    if (flags["keep-days"] !== undefined) body.keepDays = num(flags, "keep-days");
    if (flags["max-disk-mb"] !== undefined) body.maxDiskMb = num(flags, "max-disk-mb");
    const { data } = await call("POST", "/v1/recordings", body);
    show(data, `Started ${data.id}: ${data.statusText}\nIt saves real-time data only, one file per symbol per trading day. Watch it with: ${cli} record show ${data.id}`);
    return 0;
  }

  if (sub === "list" || sub === undefined) {
    const { call } = await helpers.connect();
    const res = await call("GET", "/v1/recordings");
    show(res.data, res.data.length ? `${res.data.map(recordingLine).join("\n")}\n${res.meta?.status ?? ""}` : `No recordings. ${res.meta?.status ?? ""}\nStart one: ${cli} record quotes NSE:NIFTY --every 1   or turn on auto-record: ${cli} record preset index-option-chains`);
    return 0;
  }

  if (sub === "status") {
    const { call } = await helpers.connect();
    const { data } = await call("GET", "/v1/recordings/status");
    show(data, `${data.line}\nDisk: ${sizeText(data.disk.usedBytes)} used of ${data.disk.limitMb} MB${data.disk.freeBytes != null ? `, ${sizeText(data.disk.freeBytes)} free on the disk` : ""}.\nAPI calls today: ${data.apiCalls.made} made, ${data.apiCalls.saved} saved. Background share of the budget: ${Math.round(data.budgetShare * 100)} %.`);
    return 0;
  }

  if (sub === "show") {
    const { call } = await helpers.connect();
    const { data } = await call("GET", `/v1/recordings/${encodeURIComponent(id(a))}`);
    show(data, showLines(data).join("\n"));
    return 0;
  }

  if (sub === "files") {
    const { call } = await helpers.connect();
    const { data } = await call("GET", `/v1/recordings/${encodeURIComponent(id(a))}/files`);
    show(data, data.length ? data.map((f) => `${f.name}  ${String(f.rows).padStart(8)} rows  ${sizeText(f.bytes).padStart(8)}`).join("\n") : "No files yet.");
    return 0;
  }

  if (["pause", "resume", "stop"].includes(sub)) {
    const { call } = await helpers.connect();
    const { data } = await call("POST", `/v1/recordings/${encodeURIComponent(id(a))}/${sub}`);
    show(data, `${data.id}: ${data.statusText}`);
    return 0;
  }

  if (sub === "delete") {
    const { call } = await helpers.connect();
    await call("DELETE", `/v1/recordings/${encodeURIComponent(id(a))}`);
    io.out("Deleted, with its files.");
    return 0;
  }

  if (sub === "auto") {
    const { call } = await helpers.connect();
    if (a === "on" || a === "off") {
      const { data } = await call("PUT", "/v1/recordings/auto", { enabled: a === "on" });
      io.out(data.enabled ? `Auto-record is on: ${data.activeRules} of ${data.rules} rule(s) will run at their next session.` : "Auto-record is off. Recordings by rules stopped; their files stay.");
      return 0;
    }
    if (a === "status" || a === undefined) {
      const { data } = await call("GET", "/v1/recordings/auto");
      io.out(`Auto-record is ${data.enabled ? "on" : "off"} (${data.rules} rule(s), ${data.activeRules} running or waiting).`);
      return 0;
    }
    throw new BridgeError("VALIDATION_FAILED", `auto takes on, off or status.`);
  }

  if (sub === "rules") {
    const { call } = await helpers.connect();
    const { data } = await call("GET", "/v1/recordings/rules");
    show(data, data.length ? data.map((r) => `${r.id}  ${r.enabled ? "on " : "off"}  ${r.kind.padEnd(6)} every ${r.everySec} s  ${r.name}\n    ${r.statusText}`).join("\n") : `No rules. Add one: ${cli} record preset index-option-chains`);
    return 0;
  }

  if (sub === "rule") {
    const { call } = await helpers.connect();
    if (a === "add") {
      const kind = need(["quotes", "chain"].includes(b) ? b : null, "rule add needs quotes or chain, for example: record rule add chain NIFTY,BANKNIFTY --every 30");
      const target = rest.flatMap(list);
      const body = { name: String(flags.name ?? `${kind === "chain" ? "Chain" : "Quotes"} ${target.join(" ").slice(0, 40)}`), kind, everySec: need(num(flags, "every"), "rule add needs --every <seconds>.") };
      if (flags.collection) body.collection = String(flags.collection);
      else if (kind === "chain") {
        body.underlying = target.length === 1 ? target[0].toUpperCase() : target.map((s) => s.toUpperCase());
        const universe = { expiries: flags.expiry ? (/^\d{4}-/.test(String(flags.expiry)) ? list(flags.expiry) : String(flags.expiry)) : "current-weekly", strikes: { around: "atm", count: num(flags, "strikes") ?? 10 }, sides: ["CE", "PE"], includeUnderlying: true, includeFuture: false };
        body.universe = universe;
      } else body.symbols = need(target.length ? target : null, "rule add quotes needs symbols.");
      if (flags.start || flags.end || flags.days) {
        need(flags.start && flags.end, "Custom hours need both --start and --end (IST, HH:MM). Leave all three out to follow the market calendar's session.");
        body.schedule = { days: flags.days ? list(flags.days) : ["mon", "tue", "wed", "thu", "fri"], start: String(flags.start), end: String(flags.end) };
      }
      if (flags.format) body.format = String(flags.format);
      if (flags["keep-days"] !== undefined) body.keepDays = num(flags, "keep-days");
      if (flags["max-disk-mb"] !== undefined) body.maxDiskMb = num(flags, "max-disk-mb");
      const { data } = await call("POST", "/v1/recordings/rules", body);
      io.out(`Rule ${data.id} added. ${data.statusText}\nAuto-record is a switch you turn on yourself: ${cli} record auto on`);
      return 0;
    }
    if (a === "on" || a === "off") {
      await call("PATCH", `/v1/recordings/rules/${encodeURIComponent(id(b, "a rule id (see: record rules)"))}`, { enabled: a === "on" });
      io.out(`Rule ${b} is ${a}.`);
      return 0;
    }
    if (a === "remove") {
      await call("DELETE", `/v1/recordings/rules/${encodeURIComponent(id(b, "a rule id (see: record rules)"))}${flags["delete-files"] === true ? "?deleteFiles=true" : ""}`);
      io.out(`Rule ${b} removed.${flags["delete-files"] === true ? " Its files were deleted." : " Its files stay."}`);
      return 0;
    }
    throw new BridgeError("VALIDATION_FAILED", "rule takes add, on, off or remove.");
  }

  if (sub === "preset") {
    const { call } = await helpers.connect();
    if (!a) {
      const { data } = await call("GET", "/v1/recordings/presets");
      io.out(data.map((p) => `${p.id}\n  ${p.title}: ${p.about}\n  Needs: ${p.needs}`).join("\n"));
      return 0;
    }
    const { data } = await call("POST", `/v1/recordings/presets/${encodeURIComponent(a)}/apply`, flags.collection ? { collection: String(flags.collection) } : {});
    io.out(`${data.created ? "Added" : "Already added"}: ${data.rule.name}. Auto-record is on.\n${data.rule.statusText}`);
    return 0;
  }

  io.err(helpers.usage);
  return 1;
}
