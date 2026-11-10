# TypeScript and Node

A small client with no runtime dependencies (Node 20+), with TypeScript types in `src/index.d.ts`. Streaming uses
Node 22's built-in `WebSocket` or the `ws` package. Full method list: [sdk/node/README.md](../../sdk/node/README.md).

```bash
npm install /path/to/api-bridge-v2/sdk/node      # or: npm install ws  (Node 20/21 streaming)
```

```ts
import { BridgeClient, BridgeApiError } from "@mrchartist/bridge-client";

const bridge = new BridgeClient({ apiKey: process.env.MCB_API_KEY! });   // baseUrl defaults to http://127.0.0.1:4300

const { data, errors } = await bridge.quotes(["NSE:NIFTY", "NSE:RELIANCE"]);
for (const q of data) console.log(q.symbol, q.ltp, q.freshness.source, q.freshness.ageMs);

try {
  const { data: order, replayed, idempotencyKey } = await bridge.placeOrder({
    account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET",
  });
  console.log(order.orderId, order.status, replayed, idempotencyKey);
} catch (e) {
  if (e instanceof BridgeApiError) console.error(e.status, e.code, e.detail);
  else throw e;
}

const stream = bridge.stream({ symbols: ["NSE:NIFTY"], mode: "ltp", orders: true });
stream.on("tick", (t) => console.log(t.symbol, t.ltp));
stream.on("order", (m) => console.log(m.order.status));
```

Same guarantees as the Python client: an `Idempotency-Key` on every order write, retries only where the Bridge says
an error is retryable, never a blind retry of a write (`BridgeConnectionError` with `outcomeUnknown: true`), the key
sent only as a header, and single-use stream tokens.

## Downloads, recordings, collections, history and events

The Bridge can fetch history for many symbols in the background and keep it as files, record option chains and quotes going
forward from its own live data, keep named lists of instruments, and tell you what happened without polling. These groups
return the reply's `data`; the plain one-route-one-method calls (`createDownload`, `listCollections`, ...) return the envelope.

```ts
import { BridgeClient, optionUniverse, verifySignature, DownloadFailedError } from "@mrchartist/bridge-client";

let job = await bridge.downloads.create({ symbols: ["NSE:RELIANCE", "NSE:TCS"], intervals: "5m", from: "2024-01-01", dataset: "large-caps-5m" });
try {
  job = await bridge.downloads.wait(job, { onProgress: (j) => console.log(j.status, j.progress.done, "of", j.progress.total) });
} catch (e) {
  if (e instanceof DownloadFailedError) console.error(e.job.reason);   // kill switch, lost login, full disk ...
  else throw e;
}
await bridge.downloads.save(job, "data/");      // each file checked against its SHA-256; manifest.json (with the data class) written
await bridge.datasets.update("large-caps-5m", { wait: true });   // later: only the bars after the last stored one

await bridge.recordings.rules.create({ name: "Index chains", kind: "chain", everySec: 30, collection: "index-options" });
await bridge.collections.create("nifty-near", { universe: optionUniverse({ underlying: "NIFTY", count: 10 }) });
const { symbols, warnings } = await bridge.collections.resolve("nifty-near");   // refused (422/503) on a delayed or stale price unless { allowStale: true }; then warnings say so

for await (const c of bridge.historyAll({ symbol: "NSE:RELIANCE", interval: "5m", from: "2024-01-01", localFirst: true })) { /* typed Candle */ }
for await (const ev of bridge.events.subscribe({ topics: ["download.*"], since: savedCursor })) console.log(ev.cursor, ev.topic, ev.data);
```

- Look before you start: `bridge.downloads.estimate({ symbols, intervals, from })` takes the same fields as `create`, starts
  nothing and returns `{ brokerCalls, callsSaved, rows, bytes, etaSec, budgetShare, disk }`. `await bridge.savedCalls()` says how
  many broker calls the Bridge did not make today (`total`, `byReason`, and `totalToday` with the stream, cache and shared calls).
- The share of the broker's budget background work may use: `bridge.downloads.settings()` and `bridge.recordings.settings()`
  (`maxBudgetShare`, 0.05 to 0.8). `setSettings({ maxBudgetShare: 0.5 })` changes it while the Bridge runs and needs an admin
  key from the Bridge's computer; downloads also take `afterHoursOnly`, recordings do not (they record in market hours).
- `(await bridge.recordings.status()).line` is the plain sentence ("Recording today: 3 rules, 41 symbols, 18 MB, last write
  09:31:02"). `bridge.recordings.presets()` lists the one-click rules; `applyPreset("index-option-chains")` makes the rule once and
  turns auto-record on (admin key from this computer; `applyPreset("my-watchlist", { collection: "mine" })` picks the list).
- Jobs run at the lowest priority on the Bridge (they never slow live reads or orders), survive a restart and stop with a stated
  reason. Every job, dataset and recording says its data class, source and delay; delayed and end-of-day files are for analysis
  only, never for orders, risk checks, paper fills or alerts.
- `historyAll` asks for windows that fit the Bridge's per-call limit and halves any it reports as `partial`. With
  `localFirst: true` the Bridge answers from data it already stored (real-time class, no gaps) and asks the broker only for the
  rest: `candles.localWindows` and `candles.brokerWindows` show the split, and `candles.freshness` is the least current label.
- `events.subscribe` reconnects with growing waits and resumes after the last cursor, so a restart loses nothing the Bridge
  still keeps. For a URL on your side, `bridge.subscriptions.create({ url, topics, secret })` (admin key, from the Bridge's
  computer) and check every delivery on the raw body: `verifySignature(secret, rawBody, req.headers)`. The Bridge sends
  `X-Bridge-Signature: v1=<hex>` and `X-Bridge-Timestamp: <unix seconds>` (plus `X-Bridge-Event-Id`, `X-Bridge-Delivery`,
  `X-Bridge-Attempt`); the hex is the HMAC-SHA256 of `"<timestamp>." + raw body`, with a 5-minute window. Delivery is at least
  once: de-duplicate on the `id` in the verified body (`X-Bridge-Event-Id` is not signed, so a captured copy could change it). A delivery that keeps failing becomes a dead letter:
  `bridge.subscriptions.deadLetters(id)`, `retryDeadLetter`, `retryAllDeadLetters`, `clearDeadLetters`.
- If the cursor you pass is older than what the Bridge kept, `sub.gap` is true (`onGap` is called): read the current state from the
  API again, then carry on. `bridge.events.poll({ since })` is the same replay as one JSON answer.
- Reading collections needs a `read` key; changing them needs the `paper` scope.
- There is no Parquet or DataFrame in Node: `candles.records()`, `candles.toCsv()` and plain arrays. Python has both.

## Browser apps

A page served from another origin (for example a Vite dev server on `http://localhost:5173`) must be listed in
`cors.allowedOrigins`. Never put an admin or live key in browser code.
