// A small server that receives signed events from the Bridge.   Run it with:  node receiver.mjs
// It listens on this computer only (127.0.0.1) until you decide otherwise. Rules it follows, and you should keep:
//   - verify the signature BEFORE you trust anything in the body (verify.mjs)
//   - answer 2xx quickly and do slow work afterwards: the Bridge retries anything that is not 2xx, with growing waits
//   - expect the same event twice (a retry after a slow answer): handle each event id once
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.mjs";
import { verifySignature, SIGNATURE_HEADER } from "./verify.mjs";

const env = loadEnv();
const SECRET = env.WEBHOOK_SECRET;
const PORT = Number(env.RECEIVER_PORT ?? 4600);
const HOST = env.RECEIVER_HOST ?? "127.0.0.1";
const MAX_BODY = 1024 * 1024;
if (!SECRET) {
  console.error("No WEBHOOK_SECRET. It is in .env (made by mc-bridge init webhook-receiver). Put the same value in the subscription: node register.mjs");
  process.exit(1);
}

/** Event ids handled recently, so a retry of the same event is acknowledged but not handled again. */
const seen = new Map();
function seenBefore(id) {
  const now = Date.now();
  for (const [k, at] of seen) if (now - at > 10 * 60_000) seen.delete(k);
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.set(id, now);
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
      const check = verifySignature({ secret, header: req.headers[SIGNATURE_HEADER], rawBody: raw });
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
      const duplicate = seenBefore(event.id ?? req.headers["x-mcb-event-id"]);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, duplicate }));
      if (!duplicate) setImmediate(() => onEvent(event)); // after the answer: slow work must not delay it
    });
  });
}

// Start only when run directly (send-test.mjs and tests import createReceiver).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createReceiver().listen(PORT, HOST, () => console.log(`Waiting for events at http://${HOST}:${PORT}/events  (Ctrl+C to stop)`));
}
