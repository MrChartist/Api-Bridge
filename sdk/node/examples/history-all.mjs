// Candles over a long range, with local-first reads to save API calls.
//   MCB_API_KEY=... node history-all.mjs [SYMBOL] [INTERVAL] [FROM]
// The Bridge answers from data it already stored (realtime class, no gaps) and asks the broker only for the rest.
import { BridgeClient } from "@mrchartist/bridge-client";

const [symbol = "NSE:RELIANCE", interval = "5m", from = "2024-01-01"] = process.argv.slice(2);
const bridge = new BridgeClient();

const candles = bridge.historyAll({ symbol, interval, from, localFirst: true });
let n = 0;
for await (const c of candles) n += 1; // fetched window by window, oldest first, no duplicates
console.log(`${n} candles in ${candles.calls} calls; ${candles.localWindows} from the Bridge's disk, ${candles.brokerWindows} from the broker`);
console.log("label:", candles.freshness?.class, "from", candles.freshness?.source, candles.partial ? "(partial)" : "");
console.log((await candles.toCsv()).split("\n")[0]); // the freshness columns travel with the data
