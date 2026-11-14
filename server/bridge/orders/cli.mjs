/**
 * `mc-bridge orders acknowledge-state`: after the Bridge set a damaged order-records file aside (stateFile.mjs), say
 * that the broker's order book was checked so live orders may go again. A running Bridge is asked through its API with
 * the control token in the data folder (no key needed on this computer); with the Bridge stopped the marker file is
 * removed directly.
 */
import { join } from "node:path";
import { readControlToken } from "../core/controlToken.mjs";
import { createStateFile } from "./stateFile.mjs";

/**
 * @param {string[]} args  the words after "orders"
 * @param {Record<string, string | boolean | undefined>} flags
 * @param {{ out(s: string): void, err(s: string): void, env: NodeJS.ProcessEnv }} io
 * @param {{ dataDir: string, baseUrl: string, usage: string, fetchImpl?: typeof fetch }} ctx
 */
export async function ordersCommand(args, flags, io, { dataDir, baseUrl, usage, fetchImpl = fetch }) {
  if (args[0] !== "acknowledge-state") {
    io.err(usage);
    return 1;
  }
  const alive = await fetchImpl(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  if (alive) {
    const key = typeof flags.key === "string" ? flags.key : (io.env.MCB_API_KEY ?? readControlToken(dataDir));
    if (!key) {
      io.err(`Error: the Bridge is running at ${baseUrl} but its control token is not in ${dataDir}. Pass --key (an admin key), or run this on the computer the Bridge runs on.`);
      return 1;
    }
    const res = await fetchImpl(`${baseUrl}/v1/orders/state/acknowledge`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) {
      const problem = await res.json().catch(() => ({}));
      io.err(`Error: ${problem.detail ?? `the Bridge answered HTTP ${res.status}`}`);
      return 1;
    }
    const answer = await res.json().catch(() => ({}));
    io.out(answer?.data?.acknowledged ? "Acknowledged. Live orders are allowed again." : "Nothing was waiting: the order records are not marked as damaged.");
    return 0;
  }
  const had = createStateFile(join(dataDir, "orders", "state.json")).acknowledge();
  io.out(had ? "Acknowledged. Live orders will be allowed when the Bridge starts." : "Nothing was waiting: the order records are not marked as damaged.");
  return 0;
}
