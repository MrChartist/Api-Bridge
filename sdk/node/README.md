# Mr. Chartist API Bridge — Node client

A small, dependency-free client for the Bridge's `/v1` API (Node 20+). Streaming uses the runtime's `WebSocket`
(Node 22+) or the `ws` package.

**ESM only.** Use `import { BridgeClient } from "@mrchartist/bridge-client"`, or from CommonJS
`const { BridgeClient } = await import("@mrchartist/bridge-client")`; `require()` fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

**Install** from a packed tarball so your project resolves its own dependencies:

```bash
cd sdk/node && npm pack
# in your project (add ws on Node 20 if you stream):
npm install /path/to/mrchartist-bridge-client-0.2.0.tgz ws
```

`npm install ./sdk/node` creates a symlink, and the SDK then finds `ws` in the Bridge repo's own `node_modules`, which
hides a missing `ws` until you move the project.

```js
import { BridgeClient } from "@mrchartist/bridge-client";

const bridge = new BridgeClient({ apiKey: process.env.MCB_API_KEY }); // baseUrl defaults to http://127.0.0.1:4300

// Partial failures come back with HTTP 200: data[] holds what worked, errors[] the rest (data[] can be empty).
const { data, errors } = await bridge.ltp(["NSE:NIFTY", "NFO:NIFTY-2026-10-27-25000-CE"]);
for (const q of data) console.log(q.symbol, q.ltp, q.freshness.source);
for (const e of errors) console.log(e.symbol, e.code, e.message);

const chain = await bridge.optionChain({ underlying: "NIFTY", expiry: "2026-10-27", strikes: 10 });

// Paper order (the default). Live needs mode: "live", a live-scoped key and an account enabled for live trading.
const { data: order, replayed, idempotencyKey } = await bridge.placeOrder({
  account: "dhan-main", symbol: "NFO:NIFTY-2026-10-27-25000-CE", side: "BUY",
  lots: 1, product: "MARGIN", orderType: "LIMIT", price: 180,
});
```

## What it does for you

- **Idempotency keys on every order write.** `placeOrder`, `modifyOrder`, `cancelOrder` and `cancelAllOrders`
  send an `Idempotency-Key` (a fresh UUID unless you pass `{ idempotencyKey }`). The key is returned with the result
  and attached to errors. Sending the same key again returns the first result with `replayed: true`, so a retry can
  never create a second order.
- **Retries only when it is safe.** The client retries when the Bridge marks an error `retryable` (rate limits,
  broker briefly unavailable), waiting for `Retry-After`, and retries reads after a dropped connection. It never
  retries a write that got no reply: that raises `BridgeConnectionError` with `outcomeUnknown: true`. Check the order
  book (`orders()`, `orderByClientId()`), or resend with the same `idempotencyKey`. `OUTCOME_UNKNOWN` from the Bridge
  is never retried.
- **Freshness stays visible.** Methods return the Bridge's envelope `{ data, meta, errors? }`; every market-data item
  has `freshness` (`stream`, `cache` or `broker`, its age, and which account served it).
- **Your key stays out of URLs and logs.** It is sent as `Authorization: Bearer …` and is not an enumerable property
  of the client. Streams use single-use tokens from `POST /v1/stream/token`.

Errors: `BridgeApiError` (`status`, `code`, `retryable`, `detail`, `requestId`, `errors`) and
`BridgeConnectionError` (`outcomeUnknown`, `timedOut`, `idempotencyKey`).

## Live stream

```js
const stream = bridge.stream({ symbols: ["NSE:NIFTY"], mode: "quote", orders: true });
stream.on("tick", (t) => console.log(t.symbol, t.ltp));
stream.on("order", (m) => console.log(m.order.status));
stream.on("gap", (g) => console.log("conflated", g));       // a slow reader skipped values; the newest still arrives
stream.subscribe(["NSE:RELIANCE"], "ltp");
// or: for await (const msg of stream) { ... }
stream.close();
```

The stream reconnects with back-off and a fresh token, and re-subscribes everything after a drop or a Bridge restart.

## Data you keep, and events (0.2)

Needs a Bridge that has the downloader, recorder, library and events routes; an older one answers 404. These groups return
the reply's `data` (the one-route-one-method calls below return the whole envelope). Still no dependencies; there is no
Parquet or DataFrame in Node: `records()`, `toCsv()` and plain arrays.

```js
import { BridgeClient, optionUniverse, verifySignature } from "@mrchartist/bridge-client";
const bridge = new BridgeClient();

// Download in the background on the Bridge, keep the files, read them back
let job = await bridge.downloads.create({ symbols: ["NSE:RELIANCE", "NSE:TCS"], intervals: "5m", from: "2024-01-01", dataset: "large-caps-5m" });
job = await bridge.downloads.wait(job, { onProgress: (j) => console.log(j.status, j.progress.done, "of", j.progress.total) });
await bridge.downloads.save(job, "data/");           // each file checked against its SHA-256; manifest.json written; files already there are skipped
const rows = await bridge.downloads.read(job);
await bridge.datasets.update("large-caps-5m", { wait: true });   // later: only the bars after the last stored one

// Record what brokers do not give you, by hand or by rule
await bridge.recordings.create({ kind: "chain", underlying: "NIFTY", expiry: "2026-11-12", everySec: 30 });
await bridge.recordings.rules.create({ name: "Index chains", kind: "chain", everySec: 30, collection: "index-options" });

// Named lists and option universes
await bridge.collections.create("nifty-near", { universe: optionUniverse({ underlying: "NIFTY", count: 10 }) });
const res = await bridge.collections.resolve("nifty-near");      // a delayed or stale price is refused unless { allowStale: true }; then res.warnings says so

// Candles over any range; localFirst lets the Bridge answer from data it already stored (fewer broker calls)
for await (const c of bridge.historyAll({ symbol: "NSE:RELIANCE", interval: "5m", from: "2024-01-01", localFirst: true })) { /* ... */ }

// Events: reconnects, resumes after the last cursor
for await (const ev of bridge.events.subscribe({ topics: ["download.*"], since: savedCursor })) console.log(ev.cursor, ev.topic, ev.data);

// A webhook receiver: check the signature on the raw body before trusting it
const ok = verifySignature(SECRET, rawBodyBuffer, req.headers);   // X-Bridge-Signature + X-Bridge-Timestamp; false: answer 401
```

Every job, dataset and recording carries `dataClass`, `source` and `delaySec`, and `save()` keeps them in `manifest.json`;
delayed and end-of-day files are for analysis only. Errors: `DownloadFailedError` (with `job.reason`), `WaitTimeoutError`,
`ChecksumMismatchError`, `SignatureInvalidError`. `bridge.events.poll()` and `.topics()` read the event log without a stream; `sub.gap` says events were lost; `bridge.subscriptions.deadLetters(id)`, `retryDeadLetter`, `retryAllDeadLetters` and `clearDeadLetters` handle deliveries that kept failing. Examples: `sdk/node/examples/`.

## Methods

System `health`, `meta`, `brokers` · accounts `accounts`, `account`, `testAccount`, `limits`, `usage` ·
instruments `searchInstruments`, `instrument`, `convertSymbol`, `convertSymbols` · market data `ltp`, `quotes`,
`depth`, `history` (`format: "csv"` returns text), `expiries`, `optionChain`, `streamStats` · portfolio `positions`,
`holdings`, `funds` · orders `orders`, `order`, `orderByClientId`, `trades`, `previewOrder`, `placeOrder`,
`modifyOrder`, `cancelOrder`, `cancelAllOrders` · paper `paperAccount`, `resetPaperAccount` · safety `safety`,
`engageKillSwitch` · data `createDownload`, `listDownloads`, `download`, `pauseDownload`, `resumeDownload`, `cancelDownload`,
`deleteDownload`, `editDownload`, `downloadFiles`, `listDatasets`, `dataset`, `updateDataset`, `editDataset`, `listRecordings`,
`createRecording`, `recording`, `pauseRecording`, `resumeRecording`, `stopRecording`, `deleteRecording`, `recordingFiles`,
`recordingRules`, `createRecordingRule`, `updateRecordingRule`, `deleteRecordingRule`, `listCollections`, `collection`,
`createCollection`, `updateCollection`, `deleteCollection`, `resolveCollection`, `collectionUsage`, `collectionEstimate`,
`listSubscriptions`, `createSubscription`, `updateSubscription`, `deleteSubscription`, `testSubscription`,
`subscription`, `subscriptionDeliveries`, `subscriptionDeadLetters`, `retryDeadLetter`, `clearDeadLetters` · helpers `paginate`, `streamToken`, `streamUrl`, `stream`, `historyAll`, `openStream`, `request`.

Admin actions (API keys, broker sessions, the audit log, confirming AI-prepared tickets, releasing the kill switch)
are deliberately not in the SDK: use `mc-bridge` or the dashboard on the same computer.

Types: `src/index.d.ts`, written against `docs/openapi.yaml`.

## Tests

`npm test` (or `node --test sdk/node/test/client.test.mjs sdk/node/test/data.test.mjs sdk/node/test/events.test.mjs
sdk/node/test/examples.test.mjs` from the repository root) runs the client against a local fake Bridge
(`test/fakeServer.mjs`, with the data routes in `test/fakeData.mjs`); no broker or real Bridge is involved.
