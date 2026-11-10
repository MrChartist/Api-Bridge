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
    while (["queued", "running", "paused"].includes(now.status)) {
      await sleep(1500);
      now = (await bridge.get(`/v1/downloads/${job.id}`)).data;
      const p = now.progress ?? {};
      console.log(`  ${now.status}: ${p.done ?? 0} of ${p.total ?? "?"} done, ${p.rows ?? 0} rows`);
    }
    console.log(`Finished: ${now.status}. Data class: ${now.dataClass ?? "unknown"}, source: ${now.source ?? "unknown"}.`);
    const files = await bridge.optional("GET", `/v1/downloads/${job.id}/files`);
    for (const f of files.data ?? []) console.log(`  ${f.name}  ${f.rows ?? "?"} rows  ${f.bytes ?? "?"} bytes`);
    console.log("The files are on the Bridge's computer, under its data folder. Fetch one with GET /v1/downloads/{id}/files/{name}.");
  }
} catch (err) {
  console.error(explain(err));
  process.exitCode = 1;
}
