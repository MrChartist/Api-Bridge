/**
 * `mc-bridge expose`: let TradingView alerts or a Google Sheet reach this Bridge through a tunnel or reverse proxy
 * without exposing the dashboard, and check that it is set up safely. The rules and the config writer are in
 * expose.mjs; this file asks the questions and prints the result.
 *
 *   mc-bridge expose [alerts|sheets] [--provider <id>] [--host <name>] [--port <n>] [--allow-ips tradingview|none|a,b]
 *                    [--yes] [--check] [--json]
 *   mc-bridge expose check [alerts|sheets] [--public-url <url> --allow-outbound] [--json]
 *   mc-bridge expose status [--json]
 *   mc-bridge expose off [alerts|sheets]
 *
 * Nothing here calls out. The Bridge never contacts a tunnel provider or TradingView; the only outbound request is
 * the self-check's call to your own public address, and only with --allow-outbound (or a yes to its question).
 */
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { BridgeError } from "./errors.mjs";
import { configFileForWrites, loadConfig } from "./config.mjs";
import {
  ALERTS_PORT,
  INTEGRATIONS,
  PROVIDERS,
  PROVIDER_IDS,
  RESTART_SENTENCE,
  SHEETS_PORT,
  TRADINGVIEW_HELP_URL,
  TRADINGVIEW_SENDER_IPS,
  connectionSheet,
  exposureChecks,
  exposureState,
  formatSelfCheck,
  planExpose,
  planOff,
  providerSteps,
  readHooksQuietly,
  runSelfCheck,
  writeExposeConfig,
} from "./expose.mjs";
import { ipEntrySchema } from "../hooks/config.mjs";

const load = (flags, io) => loadConfig({ path: flags.config, env: io.env, cwd: io.cwd, knownBrokers: createBrokerRegistry().list() });

/**
 * @param {string | undefined} sub  alerts | sheets | check | status | off | undefined
 * @param {string | undefined} arg  the integration for `check` and `off`
 * @param {Record<string, any>} flags
 * @param {{ out(s: string): void, err(s: string): void, env: NodeJS.ProcessEnv, cwd: string, prompt?: (q: string, o?: object) => Promise<string>, interactive?: boolean, transport?: Function, lookup?: Function }} io
 * @returns {Promise<number>}
 */
export async function runExposeCommand(sub, arg, flags, io) {
  switch (sub) {
    case "check":
      return await checkCommand(arg, flags, io);
    case "status":
      return await statusCommand(flags, io);
    case "off":
      return await offCommand(arg, flags, io);
    case undefined:
    case "alerts":
    case "sheets":
      return await wizard(sub, flags, io);
    default:
      throw new BridgeError("VALIDATION_FAILED", `Unknown expose command "${sub}". Use: expose [alerts|sheets], expose check, expose status or expose off.`);
  }
}

const isInteractive = (flags, io) => io.interactive ?? (!flags.yes && Boolean(process.stdin.isTTY));

function printChecks(io, checks) {
  for (const c of checks) {
    if (c.level === "ok") continue;
    io.out(`${c.blocking ? "BLOCK" : "WARN "}  ${c.message}`);
    if (c.fix) io.out(`      Fix: ${c.fix}`);
  }
}

async function statusCommand(flags, io) {
  const { config } = load(flags, io);
  const state = exposureState(config, { hooks: readHooksQuietly(config.dataDir) });
  if (flags.json) {
    io.out(JSON.stringify(state, null, 2));
    return 0;
  }
  io.out(state.headline);
  for (const [name, l] of [["Alerts", state.alerts], ["Sheets", state.sheets]]) {
    io.out(`${name}: ${l.enabled ? `on, listening on ${l.listen}, allowed hosts: ${l.hosts.join(", ") || "none yet"}` : "off"}`);
  }
  if (state.alerts.enabled) io.out(`Sender allowlist: ${state.alerts.senderAllowlist ? `${state.alerts.senderAllowlist} address(es)` : "none"}; caller address from header: ${state.alerts.clientIpHeader ?? "no (the connection's own address)"}`);
  printChecks(io, state.checks);
  return state.tone === "bad" ? 1 : 0;
}

async function offCommand(arg, flags, io) {
  const which = arg === "alerts" || arg === "sheets" ? arg : "all";
  const { source } = load(flags, io);
  const file = configFileForWrites(source, io.env);
  const res = writeExposeConfig({ file, plan: planOff(which) });
  if (flags.json) {
    io.out(JSON.stringify({ ...res, which }, null, 2));
    return 0;
  }
  io.out(res.changes.length ? `Turned off ${which === "all" ? "the alerts and Sheets listeners" : `the ${which} listener`} in ${res.file}:` : "Already off: nothing to change.");
  for (const c of res.changes) io.out(`  ${c}`);
  if (res.restartRequired) io.out(RESTART_SENTENCE);
  io.out("Also: stop the tunnel or proxy (Ctrl+C in its window, or `sudo systemctl stop cloudflared` / caddy), delete the webhook on the dashboard (API > Integrations > Webhooks) and remove the alert in TradingView. For Sheets, revoke the key: mc-bridge keys revoke <keyId>.");
  return 0;
}

async function checkCommand(arg, flags, io) {
  const { config } = load(flags, io);
  const kinds = arg === "alerts" || arg === "sheets" ? [arg] : undefined;
  let publicUrl = typeof flags["public-url"] === "string" ? flags["public-url"] : null;
  let allowOutbound = flags["allow-outbound"] === true;
  if (publicUrl && !allowOutbound && isInteractive(flags, io) && io.prompt) {
    const a = String(await io.prompt(`To test ${publicUrl} this computer will look up its name and send three small requests to it. Nothing is sent anywhere else. Go ahead? (y/n) [n]`, { hidden: false })).trim().toLowerCase();
    allowOutbound = a.startsWith("y");
  }
  const result = await runSelfCheck({ config, kinds, publicUrl, allowOutbound, ...(io.transport ? { request: io.transport } : {}), ...(io.lookup ? { lookup: io.lookup } : {}) });
  if (flags.json) io.out(JSON.stringify(result, null, 2));
  else {
    io.out(formatSelfCheck(result));
    if (!publicUrl) io.out("\nNo outbound call was made. To also test your public address from this computer: mc-bridge expose check --public-url https://<your host> --allow-outbound");
  }
  return result.verdict === "unsafe" || result.verdict === "not_working" ? 1 : 0;
}

function parseAllowIps(value, { integration, hasChartInk }) {
  if (integration !== "alerts") return false;
  if (value === undefined) return hasChartInk ? false : true;
  const v = String(value).trim().toLowerCase();
  if (v === "tradingview" || v === "true" || v === "yes") return true;
  if (v === "none" || v === "false" || v === "no" || v === "") return false;
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const e of list) if (!ipEntrySchema.safeParse(e).success) throw new BridgeError("VALIDATION_FAILED", `--allow-ips: "${e}" is not an IP address or an IPv4 range like 52.89.0.0/16. Use tradingview, none, or a comma-separated list.`);
  return list;
}

async function wizard(sub, flags, io) {
  const interactive = isInteractive(flags, io) && Boolean(io.prompt);
  const ask = async (q, def) => {
    if (!interactive) return def;
    const a = String(await io.prompt(`${q}${def !== undefined && def !== "" ? ` [${def}]` : ""}`, { hidden: false })).trim();
    return a === "" ? def : a;
  };
  const say = (s = "") => {
    if (!flags.json) io.out(s);
  };
  const need = (what, flag) => new BridgeError("VALIDATION_FAILED", `${what} is needed. Pass ${flag}, or run without --yes to be asked.`);

  const { config, source } = load(flags, io);
  const file = configFileForWrites(source, io.env);
  const hooks = readHooksQuietly(config.dataDir);
  say("Mr. Chartist API Bridge: reach it from outside, safely");
  say("Only the alerts address (/hooks/*) or the read-only Sheets address (/xl/*) is opened. The dashboard and the API stay on this computer.");
  say("");

  let integration = sub;
  if (!integration) {
    const a = await ask("What should reach the Bridge? 1 = TradingView alerts, 2 = Google Sheets", flags.yes ? undefined : "1");
    integration = a === "2" || String(a).toLowerCase().startsWith("s") ? "sheets" : a === "1" || String(a).toLowerCase().startsWith("a") ? "alerts" : undefined;
    if (!integration) throw need("The integration (alerts or sheets)", "alerts or sheets as the first word");
  }
  if (!INTEGRATIONS.includes(integration)) throw need("The integration", "alerts or sheets");

  let provider = flags.provider;
  if (!provider) {
    if (interactive) {
      const ids = PROVIDER_IDS.filter((id) => !(integration === "sheets" && PROVIDERS[id].portForward));
      say("How will the internet reach it?");
      ids.forEach((id, i) => say(`  ${i + 1}  ${PROVIDERS[id].label}`));
      const a = await ask("Choose a number", "1");
      provider = ids[Number(a) - 1] ?? (ids.includes(a) ? a : undefined);
    }
    if (!provider) throw need("The provider", `--provider ${PROVIDER_IDS.join("|")}`);
  }
  if (!PROVIDERS[provider]) throw new BridgeError("VALIDATION_FAILED", `Unknown provider "${provider}". Choose one of: ${PROVIDER_IDS.join(", ")}.`);
  say(PROVIDERS[provider].note);
  say("");

  let host = flags.host;
  if (!host) {
    host = await ask(provider === "cloudflare-quick" ? "The address cloudflared printed (ends in trycloudflare.com)" : provider === "port-forward" ? "Your public address or dynamic-DNS name" : "Public host name (for example hooks.example.com)", undefined);
    if (!host) throw need("The public host name", "--host <name>");
  }
  const port = flags.port !== undefined ? Number(flags.port) : (integration === "alerts" ? config.server.publicIngress.port : config.server.sheetsIngress.port) || (integration === "alerts" ? ALERTS_PORT : SHEETS_PORT);
  const hasChartInk = hooks.some((h) => h.source === "chartink");
  let allowIps = parseAllowIps(flags["allow-ips"], { integration, hasChartInk });
  if (integration === "alerts" && flags["allow-ips"] === undefined && interactive) {
    const a = String(await ask(`Only accept alerts from TradingView's published addresses (${TRADINGVIEW_SENDER_IPS.length} of them)? This applies to every webhook${hasChartInk ? "; you have a ChartInk webhook, whose senders are different, so the default is no" : ""}. (y/n)`, allowIps ? "y" : "n")).toLowerCase();
    allowIps = a.startsWith("y");
  }

  const plan = planExpose({ integration, provider, host, port, allowIps });
  const preview = writeExposeConfig({ file, plan, dryRun: true });
  say(`This will change ${file}:`);
  for (const c of preview.changes) say(`  ${c}`);
  if (!preview.changes.length) say("  (already set: no change)");
  say("");
  if (interactive) {
    const go = String(await ask("Write these changes? (y/n)", "y")).toLowerCase();
    if (!go.startsWith("y")) {
      say("Nothing was changed.");
      return 0;
    }
  }
  const res = writeExposeConfig({ file, plan });
  const sheet = connectionSheet(plan);
  const after = load({ ...flags, config: file }, io).config;
  const checks = exposureChecks(after, { hooks });
  if (flags.json) {
    io.out(JSON.stringify({ plan, written: res, sheet, steps: providerSteps(plan), checks, restart: RESTART_SENTENCE }, null, 2));
  } else {
    say(res.changes.length ? `Saved to ${file}.${res.backup ? ` The old file is kept as ${res.backup}.` : ""}` : "Nothing needed to change.");
    say("");
    say("1. Start the tunnel or proxy");
    for (const l of providerSteps(plan)) say(`   ${l}`);
    say("");
    say(`2. ${RESTART_SENTENCE}`);
    say("");
    say("3. Paste this where it asks");
    for (const l of sheet.lines) say(`   ${l}`);
    say("");
    say("4. Check it. After the restart and with the tunnel running:");
    say(`   mc-bridge expose check --public-url ${sheet.base} --allow-outbound`);
    for (const w of plan.warnings) say(`\nNote: ${w}`);
    if (integration === "alerts") say(`\nTradingView facts (from ${TRADINGVIEW_HELP_URL}): ports 80 and 443 only, 3 seconds to answer, no IPv6, 2-factor sign-in required. If TradingView's address list changes, set it yourself with --allow-ips.`);
    if (PROVIDERS[provider].headerVerified === false) say(`\nNote: that ${provider} sends the header "${plan.clientIpHeader}" is not confirmed from its documentation. After your first test alert, look in the Bridge log for "source address not allowed"; if you see it, run this command again with --allow-ips none, or change hooks.clientIpHeader.`);
    printChecks(io, checks);
  }
  if (flags.check) {
    say("");
    say("Self-check (needs the restarted Bridge):");
    const publicUrl = typeof flags["public-url"] === "string" ? flags["public-url"] : null;
    const result = await runSelfCheck({ config: after, kinds: [integration], publicUrl, allowOutbound: flags["allow-outbound"] === true, ...(io.transport ? { request: io.transport } : {}), ...(io.lookup ? { lookup: io.lookup } : {}) });
    io.out(formatSelfCheck(result));
    return result.verdict === "unsafe" ? 1 : 0;
  }
  return 0;
}
