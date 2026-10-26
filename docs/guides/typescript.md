# TypeScript and Node

A small client with no runtime dependencies (Node 20+), with TypeScript types in `src/index.d.ts`. Streaming uses
Node 22's built-in `WebSocket` or the `ws` package. Full method list: [sdk/node/README.md](../../sdk/node/README.md).

```bash
npm install /path/to/api-bridge/sdk/node      # or: npm install ws  (Node 20/21 streaming)
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

## Browser apps

A page served from another origin (for example Option Hub on `http://localhost:5173`) must be listed in
`cors.allowedOrigins`. Never put an admin or live key in browser code.

## Scans and backup data

```js
const job = await bridge.scan(
  { universe: "FNO", condition: "close crosses above ema(20) and rsi(14) > 55", columns: ["rsi(14)"], sort: { by: "rsi(14)" } },
  { waitMs: 60_000 },
);
for (const row of job.data.results ?? []) console.log(row.symbol, row.values["rsi(14)"], row.source);

await bridge.saveScan({ name: "Breakouts", everyMinutes: 15, request: { universe: "NIFTY50", interval: "15m", condition: "close > highest(20)[1]" } });
await bridge.backupQuotes(["NSE:RELIANCE", "NSE:NIFTY"]); // straight from Yahoo / NSE, labelled source "backup"
```

See [scanner.md](scanner.md) and [backup-data.md](backup-data.md).
