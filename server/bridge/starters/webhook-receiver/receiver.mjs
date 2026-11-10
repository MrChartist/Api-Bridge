// A small server that receives signed events from the Bridge.   Run it with:  node receiver.mjs
// It listens on this computer only (127.0.0.1) until you decide otherwise. Rules it follows, and you should keep:
//   - verify the signature BEFORE you trust anything in the body (verify.mjs)
//   - answer 2xx quickly and do slow work afterwards: the Bridge retries anything that is not 2xx, with growing waits
//   - expect the same event twice (a retry after a slow answer, or a copy someone captured): handle each event id once,
//     using the `id` INSIDE the signed body. The X-Bridge-Event-Id header is not covered by the signature: anyone can change it.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.mjs";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "./verify.mjs";

const env = loadEnv();
const SECRET = env.WEBHOOK_SECRET;
const PORT = Number(env.RECEIVER_PORT ?? 4600);
const HOST = env.RECEIVER_HOST ?? "127.0.0.1";
const MAX_BODY = 1024 * 1024;
if (!SECRET) {
  console.error("No WEBHOOK_SECRET. It is in .env (made by mc-bridge init webhook-receiver). Put the same value in the subscription: node register.mjs");
  process.exit(1);
}

/**
 * Event ids handled recently, so a retry (or a replayed copy) of the same event is acknowledged but not handled again.
 * Remembered for 10 minutes (longer than the 5-minute signature window, so a captured request cannot be replayed after
 * it is forgotten) and at most MAX_SEEN ids, so a flood of events cannot grow it without bound.
 */
const SEEN_MS = 10 * 60_000;
const MAX_SEEN = 10_000;
const seen = new Map();
export function seenBefore(id, now = Date.now()) {
  for (const [k, at] of seen) {
    if (now - at > SEEN_MS) seen.delete(k);
    else break; // insertion order is time order: the rest are newer
  }
  if (typeof id !== "string" || !id) return false; // an event with no id cannot be matched: handle it
  if (seen.has(id)) return true;
  seen.set(id, now);
  while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value); // the oldest goes first
  return false;
}

/** What you do with an event. Replace this: write to a database, start a job, send yourself a message. */
export function handleEvent(event) {
  console.log(`${new Date().toISOString()}  ${event.topic ?? "event"}  ${JSON.stringify(event.data ?? event).slice(0, 160)}`);
}

/** Where an event is saved when your handler throws, one JSON line each, so you can fix the bug and replay it. */
const FAILED_FILE = env.RECEIVER_FAILED_FILE ?? fileURLToPath(new URL("./failed-events.jsonl", import.meta.url));

/**
 * Run your handler after the answer went out. A bug in it must not end this process or lose the event: the Bridge already
 * has its 200 and will not send the event again, so on a failure the id is forgotten (a replayed copy is handled again) and
 * the event is saved to failed-events.jsonl. Awaits a handler that returns a promise.
 */
export async function runHandler(event, onEvent = handleEvent, failedFile = FAILED_FILE) {
  try {
    await onEvent(event);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`Your handler failed on event ${event?.id ?? "(no id)"}: ${why}. The event is saved in ${basename(failedFile)}.`);
    if (event?.id !== undefined && event?.id !== null) seen.delete(String(event.id));
    try {
      appendFileSync(failedFile, `${JSON.stringify({ failedAt: new Date().toISOString(), error: why, event })}\n`, { mode: 0o600 });
    } catch (writeErr) {
      console.error(`Could not save it either (${writeErr.message}). The event: ${JSON.stringify(event).slice(0, 500)}`);
    }
  }
}

export function createReceiver({ secret = SECRET, onEvent = handleEvent, failedFile = FAILED_FILE } = {}) {
  return createServer((req, res) => {
    if (req.method !== "POST" || req.url?.split("?")[0] !== "/events") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks); // the exact bytes: this is what was signed
      const check = verifySignature({ secret, timestamp: req.headers[TIMESTAMP_HEADER], signature: req.headers[SIGNATURE_HEADER], rawBody: raw });
      if (!check.ok) {
        console.warn(`Refused a request: ${check.reason}`);
        res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid signature" }));
        return;
      }
      let event;
      try {
        event = JSON.parse(raw.toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      // The id from the body, which the signature covers. Never the X-Bridge-Event-Id header: it is not signed.
      const duplicate = seenBefore(event?.id === undefined || event?.id === null ? undefined : String(event.id));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, duplicate }));
      if (!duplicate) setImmediate(() => void runHandler(event, onEvent, failedFile)); // after the answer: slow work must not delay it
    });
  });
}

// Start only when run directly (send-test.mjs and tests import createReceiver).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createReceiver().listen(PORT, HOST, () => console.log(`Waiting for events at http://${HOST}:${PORT}/events  (Ctrl+C to stop)`));
}
