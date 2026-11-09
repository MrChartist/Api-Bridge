// Your first call: is the Bridge up, and what is the price of two symbols?   Run it with:  node index.mjs
import { createBridge, explain } from "./bridge.mjs";

const bridge = createBridge();
try {
  // 1. Health needs no key. It also says whether you are looking at sample (demo) data.
  const health = await bridge.get("/v1/health");
  console.log(`Bridge ${health.version} is ${health.status}${health.demo ? " (demo mode: sample prices, not market data)" : ""}`);

  // 2. Prices need a key with the read scope. Every row says how fresh it is and where it came from.
  const { data, errors } = await bridge.get("/v1/ltp", { symbols: "NSE:RELIANCE,NSE:NIFTY" });
  for (const row of data) {
    const f = row.freshness;
    console.log(`${row.symbol.padEnd(14)} ${String(row.ltp).padStart(10)}   ${f.class}, from ${f.source}, ${f.ageMs} ms old`);
  }
  for (const e of errors ?? []) console.log(`${e.symbol ?? "?"}: ${e.code} ${e.message ?? ""}`);
  console.log("\nIt works. Next: node examples/history.mjs   (candles),  node examples/download.mjs   (data files),  node examples/events.mjs   (live events)");
} catch (err) {
  console.error(explain(err));
  process.exitCode = 1;
}
