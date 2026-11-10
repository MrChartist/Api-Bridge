// React to Bridge events without polling; resume after a restart from the last cursor.
//   MCB_API_KEY=... node events-listen.mjs [TOPIC ...]        (default: download.* recording.*)
// Admin-only events are not sent to a read key.
import fs from "node:fs";
import { BridgeClient } from "@mrchartist/bridge-client";

const CURSOR_FILE = ".events-cursor";
const topics = process.argv.length > 2 ? process.argv.slice(2) : ["download.*", "recording.*"];
const bridge = new BridgeClient();

const since = fs.existsSync(CURSOR_FILE) ? fs.readFileSync(CURSOR_FILE, "utf8").trim() : undefined;
const sub = bridge.events.subscribe({ topics, since }); // reconnects by itself and continues after the last cursor
process.on("SIGINT", () => sub.close());
for await (const ev of sub) {
  console.log(ev.cursor, ev.topic, ev.data);
  fs.writeFileSync(CURSOR_FILE, ev.cursor ?? "");
}
