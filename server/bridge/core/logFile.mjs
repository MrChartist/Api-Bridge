/**
 * The log file: <dataDir>/logs/bridge.log, one JSON line per record (what the console shows), rotated by size so it can
 * run for months: when a write would take the file past `maxBytes` it becomes bridge.log.1 (older ones shift up:
 * .1 -> .2 ...), at most `keep` old files are kept, and old files are compressed (bridge.log.2.gz ...). A desktop Bridge keeps its
 * history this way ("what happened at 10:42 yesterday?") even though its console window is gone.
 *
 * Writes are synchronous (a line is small) and failures are swallowed: a full disk or a missing folder must never stop
 * the Bridge, which would only lose its log. Nothing here reads the clock except through `now`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { writeFileAtomic } from "../../lib/jsonl.mjs";

export const LOG_FILE_NAME = "bridge.log";

/**
 * @param {{ dir: string, maxBytes?: number, keep?: number }} o
 * @returns {{ write(line: string): void, path: string, rotate(): void }}
 */
export function createLogFile({ dir, maxBytes = 10 * 1024 * 1024, keep = 5 }) {
  const path = join(dir, LOG_FILE_NAME);
  let size = null;
  let failing = false;

  const archive = (n) => join(dir, `${LOG_FILE_NAME}.${n}.gz`);

  function rotate() {
    try {
      rmSync(archive(keep), { force: true });
      for (let i = keep - 1; i >= 1; i--) if (existsSync(archive(i))) renameSync(archive(i), archive(i + 1));
      if (existsSync(path)) {
        // The newest old file is compressed at once (a plain file would take 10 MB for months of nothing).
        const raw = readFileSync(path);
        writeFileAtomic(archive(1), gzipSync(raw));
        rmSync(path, { force: true });
      }
    } catch {
      /* a rotation that fails leaves the file growing, which is better than losing lines */
    }
    size = 0;
  }

  return {
    path,
    rotate,
    write(line) {
      try {
        if (size === null) {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          size = existsSync(path) ? statSync(path).size : 0;
        }
        const data = `${line}\n`;
        if (size > 0 && size + data.length > maxBytes) rotate();
        appendFileSync(path, data, { mode: 0o600 });
        size += data.length;
        failing = false;
      } catch (err) {
        // Say so once on stderr (it may be a full disk); then stay quiet until a write works again.
        if (!failing) {
          failing = true;
          try {
            process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level: "warn", msg: "the log file cannot be written; logging to the console only", code: err?.code })}\n`);
          } catch {
            /* the console is gone too */
          }
        }
        size = null;
      }
    },
  };
}
