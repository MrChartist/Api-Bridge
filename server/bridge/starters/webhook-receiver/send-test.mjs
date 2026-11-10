// Try the receiver without the Bridge: send it a signed sample event, and an unsigned one.   node send-test.mjs
// Start the receiver first (node receiver.mjs) in another window.
import { loadEnv } from "./env.mjs";
import { signatureHeaders } from "./verify.mjs";

const env = loadEnv();
const url = env.RECEIVER_URL ?? `http://${env.RECEIVER_HOST ?? "127.0.0.1"}:${env.RECEIVER_PORT ?? 4600}/events`;
const body = JSON.stringify({ id: `evt_test_${Date.now()}`, topic: "test.ping", at: new Date().toISOString(), data: { hello: "from send-test.mjs" } });
const t = Math.floor(Date.now() / 1000);

async function send(label, headers) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    console.log(`${label}: ${res.status} ${await res.text()}`);
  } catch (err) {
    console.error(`${label}: could not reach ${url}. Is receiver.mjs running? (${err.cause?.code ?? err.message})`);
    process.exitCode = 1;
  }
}

await send("signed event  ", { ...signatureHeaders(env.WEBHOOK_SECRET ?? "", t, body), "X-Bridge-Event-Id": JSON.parse(body).id });
await send("unsigned event", {});
