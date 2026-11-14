// Watch Bridge events as they happen, without polling.   node examples/events.mjs [seconds] [topic,topic]
// Events are a newer feature. On a Bridge that does not have them yet this prints a note and ends without an error.
// Keep the last event id you handled: reconnect with since=<id> and you get what you missed.
import { createBridge, explain, isMissing } from "../bridge.mjs";

const [seconds = "20", topics] = process.argv.slice(2);
const bridge = createBridge();
const stop = new AbortController();
const timer = setTimeout(() => stop.abort(), Number(seconds) * 1000);
try {
  console.log(`Listening for ${seconds} seconds...`);
  for await (const ev of bridge.events("/v1/events/stream", { query: topics ? { topics } : undefined, signal: stop.signal })) {
    console.log(`${ev.id ?? "-"}  ${ev.event}  ${ev.data.slice(0, 120)}`);
  }
} catch (err) {
  if (isMissing(err)) {
    console.log("Events: This Bridge does not have this feature yet. Update the Bridge and restart it.");
  } else if (err?.name !== "AbortError" && err?.cause?.name !== "AbortError") {
    console.error(explain(err));
    process.exitCode = 1;
  } else {
    console.log("Done listening.");
  }
} finally {
  clearTimeout(timer);
}
