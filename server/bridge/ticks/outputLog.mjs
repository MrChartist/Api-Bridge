/**
 * Output log: a signal run's outputs saved as JSON lines, so a run made one day (live, in production) can be compared
 * with a historical run made later on the same ticks. One line per output: { n, time, symbol, value }.
 *
 *   const log = createOutputLog({ path: "signals/nifty-vs-bank/2026-11-18.outputs.jsonl" });
 *   await runLive(signal, hub, { onOutput: log.append });     // or a runner fed by your own WebSocket client
 *   ...
 *   log.close();
 *   compareRuns(historical.outputs, readOutputs(path).outputs)
 *
 * Writes are buffered and appended in batches (bounded, like the tick log); a torn last line after a crash is skipped
 * on reading and counted.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @param {{ path: string, maxBuffered?: number, append?: (path: string, data: string) => void }} opts
 */
export function createOutputLog({ path, maxBuffered = 1000, append = (p, d) => appendFileSync(p, d, { mode: 0o600 }) }) {
  if (!path) throw new Error("createOutputLog needs a path");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let buf = [];
  let written = 0;
  const flush = () => {
    if (!buf.length) return;
    append(path, buf.join(""));
    written += buf.length;
    buf = [];
  };
  return {
    path,
    /** Take one runner output ({ n, time, symbol, value }). */
    append(out) {
      buf.push(`${JSON.stringify({ n: out.n, time: out.time, symbol: out.symbol, value: out.value })}\n`);
      if (buf.length >= maxBuffered) flush();
    },
    flush,
    close: flush,
    stats: () => ({ written, buffered: buf.length }),
  };
}

/**
 * Read an output log back. @returns {{ outputs: Array<{ n: number, time: number, symbol: string, value: any }>, bad: number }}
 */
export function readOutputs(path) {
  if (!existsSync(path)) throw new Error(`no output log at ${path}`);
  const outputs = [];
  let bad = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (!Number.isFinite(o?.time) || typeof o.symbol !== "string" || !("value" in o)) throw new Error("not an output");
      outputs.push({ n: Number.isInteger(o.n) ? o.n : outputs.length + 1, time: o.time, symbol: o.symbol, value: o.value });
    } catch {
      bad += 1;
    }
  }
  return { outputs, bad };
}
