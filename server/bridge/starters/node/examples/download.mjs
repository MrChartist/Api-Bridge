// Save history to files on the Bridge's computer (a download job), then list them.
//   node examples/download.mjs [symbol] [interval] [from date]       for example:  node examples/download.mjs NSE:RELIANCE 5m 2024-01-01
// Downloads are a newer feature. On a Bridge that does not have them yet this prints a note and ends without an error.
import { setTimeout as sleep } from "node:timers/promises";
import { createBridge, explain } from "../bridge.mjs";

const [symbol = "NSE:RELIANCE", interval = "5m", from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)] = process.argv.slice(2);
const bridge = createBridge();
try {
  const made = await bridge.optional("POST", "/v1/downloads", { body: { name: `starter ${symbol} ${interval}`, symbols: [symbol], intervals: [interval], from, format: "csv" } });
  if (!made.available) {
    console.log(`Downloads: ${made.reason}`);
  } else {
    const job = made.data;
    console.log(`Job ${job.id} is ${job.status}. Waiting for it (Ctrl+C leaves it running on the Bridge)...`);
    let now = job;
    // A pause the user asked for, or one the Bridge made by itself (disk low, login lost), can last: say why and stop waiting.
    while (["queued", "running", "paused"].includes(now.status)) {
      if (now.status === "paused") {
        console.log(`  paused (${now.reason ?? "unknown"}): ${now.message ?? ""}`);
        console.log("The job stays on the Bridge and continues when the cause is gone. Stopped waiting.");
        process.exit(0);
      }
      await sleep(1500);
      now = (await bridge.get(`/v1/downloads/${job.id}`)).data;
      const p = now.progress ?? {};
      console.log(`  ${now.status}: ${p.done ?? 0} of ${p.total ?? "?"} done, ${p.rows ?? 0} rows`);
    }
    if (now.status === "failed" && now.failure) console.log(`Why: ${now.failure.message}${now.failure.fix ? ` Fix: ${now.failure.fix}` : ""}`);
    console.log(`Finished: ${now.status}. Data class: ${now.dataClass ?? "unknown"}, source: ${now.source ?? "unknown"}.`);
    const files = await bridge.optional("GET", `/v1/downloads/${job.id}/files`);
    for (const f of files.data ?? []) console.log(`  ${f.name}  ${f.rows ?? "?"} rows  ${f.bytes ?? "?"} bytes`);
    console.log("The files are on the Bridge's computer, under its data folder. Fetch one with GET /v1/downloads/{id}/files/{name}.");
  }
} catch (err) {
  console.error(explain(err));
  process.exitCode = 1;
}
