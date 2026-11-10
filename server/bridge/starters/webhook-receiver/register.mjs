// Tell the Bridge where to send events.   MCB_ADMIN_KEY=mcb_... node register.mjs [topic,topic]
// Creating a subscription needs an admin key and works from this computer only, because the target is a web address
// the Bridge will call. The admin key is read from the environment on purpose and is never written to a file here.
// Events are a newer feature: on a Bridge that does not have them yet this prints a note and ends without an error.
import { loadEnv } from "./env.mjs";

const env = loadEnv();
const base = (env.BRIDGE_URL ?? "http://127.0.0.1:4300").replace(/\/+$/, "");
const adminKey = env.MCB_ADMIN_KEY;
const target = env.RECEIVER_URL ?? `http://${env.RECEIVER_HOST ?? "127.0.0.1"}:${env.RECEIVER_PORT ?? 4600}/events`;
const topics = (process.argv[2] ?? "order.updated,download.done,download.failed").split(",").map((t) => t.trim()).filter(Boolean);

if (!adminKey) {
  console.error("Set MCB_ADMIN_KEY for this one command. Open the dashboard (mc-bridge open) > Developers > Create app > Admin tools, or run: mc-bridge keys create --label events-admin --scope admin --expires 1d");
  process.exit(1);
}
if (!env.WEBHOOK_SECRET) {
  console.error("No WEBHOOK_SECRET in .env.");
  process.exit(1);
}

if (target.startsWith("http://")) {
  console.log(`Note: ${target} is plain http. The Bridge refuses that by default (events.webhooks.allowPrivateTargets is false), so the next step may answer blocked_scheme.`);
  console.log("  To receive on this computer or your home network, set events.webhooks.allowPrivateTargets to true in bridge.config.json and restart the Bridge, or use an https address.");
}
const res = await fetch(`${base}/v1/subscriptions`, {
  method: "POST",
  redirect: "error",
  headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({ url: target, topics, secret: env.WEBHOOK_SECRET, active: true }),
}).catch((err) => {
  console.error(`Could not reach the Bridge at ${base}. Is it running? (${err.cause?.code ?? err.message})`);
  process.exit(1);
});
const body = await res.json().catch(() => ({}));
if (res.ok) {
  console.log(`Subscribed: ${body.data?.id ?? "(id not shown)"}  ${target}  topics: ${topics.join(", ")}`);
  console.log("Try it:  the Bridge can send a test event to this subscription (POST /v1/subscriptions/{id}/test).");
} else if (["NOT_FOUND", "NOT_IMPLEMENTED", "METHOD_NOT_ALLOWED"].includes(body.code)) {
  console.log("Events: This Bridge does not have this feature yet. Update the Bridge and restart it. You can still try the receiver with: node send-test.mjs");
} else {
  console.error(`${body.code ?? res.status}: ${body.detail ?? "the Bridge refused the subscription"}`);
  if (body.requestId) console.error(`  request id: ${body.requestId}`);
  process.exitCode = 1;
}
