// A small server that receives signed events from the Bridge.   Run it with:  node receiver.mjs
// It listens on this computer only (127.0.0.1) until you decide otherwise. Rules it follows, and you should keep:
//   - verify the signature BEFORE you trust anything in the body (verify.mjs)
//   - answer 2xx only after your handler worked: the Bridge retries anything that is not 2xx, with growing waits. A handler that
//     throws gets a 500, so the event comes again. Keep the handler quick (put slow work on a queue) so the answer is not late
//   - expect the same event twice (a retry after a slow answer, or a copy someone captured): handle each event id once,
//     using the `id` INSIDE the signed body. The X-Bridge-Event-Id header is not covered by the signature: anyone can change it.
import { createServer } from "node:http";
import { resolve } from "node:path";
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
export function forget(id) {
  seen.delete(id);
}
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

export function createReceiver({ secret = SECRET, onEvent = handleEvent } = {}) {
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
      // The Bridge's own delivery test always carries the id "test": it is never treated as a repeat.
      const id = event?.id === undefined || event?.id === null || event?.topic === "subscription.test" ? undefined : String(event.id);
      const duplicate = seenBefore(id);
      if (duplicate) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, duplicate: true }));
        return;
      }
      Promise.resolve()
        .then(() => onEvent(event))
        .then(
          () => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, duplicate: false })),
          (err) => {
            // The handler failed: forget the id and answer 500, so the Bridge sends this event again. The process stays up.
            if (id !== undefined) forget(id);
            console.error(`Your handler failed for event ${id ?? "(no id)"}; answering 500 so it is retried:`, err?.message ?? err);
            res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "handler failed" }));
          },
        );
    });
  });
}

// Start only when run directly (send-test.mjs and tests import createReceiver).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createReceiver().listen(PORT, HOST, () => console.log(`Waiting for events at http://${HOST}:${PORT}/events  (Ctrl+C to stop)`));
}
