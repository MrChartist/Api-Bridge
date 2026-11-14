// Download history in the background on the Bridge, keep it as files, read it back.
//   MCB_API_KEY=... node download-save.mjs [FOLDER]
// The job runs at the lowest priority, so it never slows live reads or orders. Every file says its data class
// (realtime, delayed or eod) in the manifest.json written next to it.
import { BridgeClient, DownloadFailedError, describeDataClass } from "@mrchartist/bridge-client";

const folder = process.argv[2] ?? "data";
const bridge = new BridgeClient();

let job = await bridge.downloads.create({ symbols: ["NSE:RELIANCE", "NSE:TCS"], intervals: "5m", from: "2024-01-01", dataset: "large-caps-5m" });
console.log("queued", job.id, "-", describeDataClass(job));
try {
  job = await bridge.downloads.wait(job, { onProgress: (j) => console.log(`  ${j.status} ${j.progress.done}/${j.progress.total} items, ${j.progress.rows} rows`) });
} catch (e) {
  if (e instanceof DownloadFailedError) {
    console.error("stopped:", e.message);
    process.exit(1);
  }
  throw e;
}

for (const f of await bridge.downloads.save(job, folder)) console.log(f.skipped ? "kept " : "saved", f.path, f.bytes, "bytes", f.sha256.slice(0, 12));
const rows = await bridge.downloads.read(job);
console.log(rows.length, "rows; first:", rows[0]);
