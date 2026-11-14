/**
 * Run by host.exit.test.mjs in its own process: loads one plugin for real, calls it once (the plugin then spins forever in a
 * busy loop, which ignores a closed stdin), prints the plugin process's pid and then ends the way the Bridge ends.
 *   node exitProbe.mjs <plugin folder> exit      process.exit(0)
 *   node exitProbe.mjs <plugin folder> signals   SIGINT and SIGTERM handlers that call process.exit(0), as `mc-bridge start` does
 */
import { spawn } from "node:child_process";
import { inspectPluginFolder, loadPlugins } from "../loader.mjs";
import { createFetchBroker } from "../netbroker.mjs";

const [dir, mode] = process.argv.slice(2);
const pin = inspectPluginFolder(dir).pin;
const { providers, problems } = loadPlugins({
  entries: [{ path: dir, sha256: pin, granted: true }],
  broker: createFetchBroker({ id: "fake-plugin", version: "1.0.0", allowHosts: ["api.vendor-example.com"], limits: { perSecond: 5 }, transport: async () => { throw new Error("no network"); } }),
  spawnImpl: (cmd, args, options) => {
    const proc = spawn(cmd, args, options);
    process.stdout.write(`PID ${proc.pid}\n`);
    return proc;
  },
  readyTimeoutMs: 15_000,
});
if (problems.length) {
  process.stdout.write(`PROBLEM ${JSON.stringify(problems)}\n`);
  process.exit(2);
}
await providers[0].quotes(["NSE:X"], { now: Date.now() });
await new Promise((r) => setTimeout(r, 300)); // let the plugin start spinning
if (mode === "signals") {
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => process.exit(0));
  process.stdout.write("READY\n");
  setInterval(() => {}, 1000);
} else {
  process.stdout.write("READY\n");
  await new Promise((r) => setTimeout(r, 1000)); // the test reads READY and checks the plugin is alive before the exit
  process.exit(0);
}
