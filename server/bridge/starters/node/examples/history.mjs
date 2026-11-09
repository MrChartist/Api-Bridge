// Candles: node examples/history.mjs [symbol] [interval] [how many]     for example:  node examples/history.mjs NSE:RELIANCE 5m 20
// The Bridge splits long ranges across the broker's limits by itself; you ask for the range you want.
import { createBridge, explain } from "../bridge.mjs";

const [symbol = "NSE:RELIANCE", interval = "1d", count = "5"] = process.argv.slice(2);
const bridge = createBridge();
try {
  const { data, meta } = await bridge.get("/v1/history", { symbol, interval, countback: Number(count) });
  const f = data.freshness ?? meta?.freshness;
  console.log(`${data.symbol} ${data.interval}: ${data.candles.length} candles (${f?.class ?? "unknown class"}, from ${f?.source ?? "unknown"})`);
  for (const c of data.candles) {
    const t = new Date(c.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
    console.log(`${t.padEnd(24)} O ${c.open}  H ${c.high}  L ${c.low}  C ${c.close}  V ${c.volume}`);
  }
  if (data.partial) console.log("The answer is partial: the broker could not give the whole range. Ask for a shorter range or try again.");
} catch (err) {
  console.error(explain(err));
  process.exitCode = 1;
}
