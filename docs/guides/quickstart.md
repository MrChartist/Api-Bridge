# Quickstart: five minutes to a first answer

This guide takes you from a fresh clone to a price, a paper order, a list of data sources and a live stream. It runs in
**demo mode**, so you need no broker account and no money. Every command and output below was run on a clean checkout;
long output is trimmed with `...` and the keys and one-time codes are shortened.

**Demo caveat.** In demo mode the prices are *sample data generated on your computer*, not market data. The Bridge says
so everywhere: `GET /v1/health` has `"demo": true`, every answer's `meta` carries a `dataNotice`, and the dashboard shows
a Demo badge. Orders go to a paper account. Because the demo "broker" is built in, an answer labelled
`"source": "broker"` here is still sample data; check `demo` before you trust a number.

You need Node.js 22.12 or newer (`node -v`) and git. The examples use the default address `http://127.0.0.1:4300`.

## 1. Get the code and start the Bridge

```bash
git clone https://github.com/MrChartist/api-bridge-v2.git
cd api-bridge-v2
npm ci
npm run dev
```

`npm run dev` is `mc-bridge start --demo --open`. It prints a banner, the data folder and a sign-in link for the
dashboard, and keeps running (stop it with Ctrl+C):

```text
> @mrchartist/api-bridge-v2@2.0.0 dev
> node bin/mc-bridge.mjs start --demo --open

  ************************************************************
  *  DEMO MODE: sample data, not live market data.           *
  *  No broker is connected. Orders are paper only.          *
  ************************************************************

Mr. Chartist API Bridge listening on http://127.0.0.1:4300
Data folder: /home/you/.mc-bridge/data
Dashboard (this computer only): http://127.0.0.1:4300/dashboard
No API keys yet. Open the dashboard signed in with: npm run bridge -- open   (or make one: npm run bridge -- keys create --label me --scope admin,paper)
Market data: demo (sample prices generated on this computer).
Open this link in your browser to see the dashboard, already signed in. It works once and expires in 10 minutes:
  http://127.0.0.1:4300/dashboard#signin=<one-time code>
Press Ctrl+C to stop.
```

(Your data folder will differ: `~/.mc-bridge` on Mac and Linux, `%APPDATA%\MrChartist\Bridge` on Windows.) The browser
opens the dashboard by itself when it can; if it does not, use the link above. Leave this terminal running.

## 2. Make an API key

Open a **second terminal** in the same folder. Each tool gets its own key with only the access it needs. This one can
read and place paper orders:

```bash
npm run bridge -- keys create --label quickstart --scope read,paper
```

```text
Created key bizshnjiv3 (read, paper). Copy it now; it will not be shown again:

  mcb_bizshnjiv3_<the rest of the key>
```

(The CLI also prints a note saying which folder the keys live in.) Keep the key in an environment variable. The Bridge
stores only a fingerprint, so a lost key cannot be shown again: revoke it and make a new one.

```bash
export MCB_API_KEY=mcb_bizshnjiv3_...      # paste your own key
```

On Windows PowerShell: `$env:MCB_API_KEY = "mcb_..."`.

## 3. Ask for health and a price

The health check needs no key:

```bash
curl -s http://127.0.0.1:4300/v1/health
```

```json
{
  "status": "ok",
  "version": "2.0.0",
  "demo": true,
  "dataNotice": "Demo data: sample prices generated on this computer. Not live market data; no broker is connected."
}
```

(The real answer also lists each internal service as `ready`; trimmed here.) Now a price, with your key:

```bash
curl -s "http://127.0.0.1:4300/v1/ltp?symbols=NSE:RELIANCE,NSE:NIFTY" -H "Authorization: Bearer $MCB_API_KEY"
```

```json
{"data":[
  {"symbol":"NSE:RELIANCE","ltp":1461.5,"freshness":{"source":"broker","class":"realtime","official":true,"stale":false, "...": "..."}},
  {"symbol":"NSE:NIFTY","ltp":24882.2,"freshness":{"source":"broker","class":"realtime","official":true,"stale":false, "...": "..."}}
],"errors":[],"meta":{"requestId":"req_...","demo":true,"dataNotice":"Demo data: ..."}}
```

(Reformatted and trimmed; your numbers will differ because demo prices move.) The `freshness` block is how the Bridge is
honest about data: it says where the value came from, whether it is real-time, and how old it is. Symbols are
`EXCHANGE:SYMBOL`.

## 4. Place a paper order

Every order carries an `Idempotency-Key` (8 to 255 letters, digits or `_ . : -`) so a retry can never place it twice.
`demo-paper` is the paper account that demo mode creates.

```bash
curl -s -X POST http://127.0.0.1:4300/v1/orders \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: quickstart-1" \
  -d '{"account":"demo-paper","symbol":"NSE:RELIANCE","side":"BUY","quantity":1,"product":"CNC","orderType":"MARKET"}'
```

```json
{
  "orderId": "PAPER-20261109-000001",
  "mode": "paper",
  "symbol": "NSE:RELIANCE",
  "side": "BUY",
  "quantity": 1,
  "status": "filled",
  "avgPrice": 1461.7
}
```

(This is the `data` part of the answer, trimmed to the main fields.) `"mode": "paper"` is on every order result. The order
now shows on the dashboard's Orders page too.

Live trading is off, and the Bridge shows what that means. The same call with `"mode": "live"` is refused:

```bash
curl -s -X POST http://127.0.0.1:4300/v1/orders \
  -H "Authorization: Bearer $MCB_API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: quickstart-live-1" \
  -d '{"account":"demo-paper","symbol":"NSE:RELIANCE","side":"BUY","quantity":1,"product":"CNC","orderType":"MARKET","mode":"live"}'
```

```json
{"status":403,"code":"PAPER_ONLY","detail":"demo-paper is a paper account; it cannot place live orders."}
```

(Trimmed to those fields.) Going live takes several separate opt-ins, described in [safety.md](safety.md). Nothing in
this guide can turn it on.

## 5. See where data comes from

```bash
curl -s http://127.0.0.1:4300/v1/sources -H "Authorization: Bearer $MCB_API_KEY"
```

Trimmed to one line per source:

```json
{"id":"demo","kind":"broker","enabled":true,"class":"realtime","delaySec":0,"official":true}
{"id":"demo-delayed","kind":"free","enabled":false,"class":"delayed","delaySec":900,"official":false}
{"id":"demo-eod","kind":"free","enabled":false,"class":"eod","delaySec":null,"official":true}
```

In demo mode the list holds the demo broker and two sample sources, so you can see how a delayed (`delaySec` 900, not
official) and an end-of-day source look. With real accounts, your brokers give real-time data and the free sources
(off until you turn them on) give delayed or end-of-day data. Read [sources.md](sources.md) before turning one on. The
dashboard's Sources page shows the same information, plus how much request room is left.

## 6. Watch a live stream

A WebSocket stream needs a single-use token so your key never goes into a URL. Save this as `stream.mjs` in the
repository folder (the `ws` package is already installed there by `npm ci`):

```js
import WebSocket from "ws";

const BASE = process.env.MCB_URL ?? "http://127.0.0.1:4300";
const KEY = process.env.MCB_API_KEY;

// A stream token is single use and lasts 60 seconds, so the key never appears in a URL.
const res = await fetch(`${BASE}/v1/stream/token`, { method: "POST", headers: { Authorization: `Bearer ${KEY}` } });
const { data } = await res.json();

const ws = new WebSocket(`${BASE.replace("http", "ws")}/v1/stream?token=${encodeURIComponent(data.token)}`);
let ticks = 0;
ws.on("open", () => ws.send(JSON.stringify({ op: "subscribe", symbols: ["NSE:RELIANCE"], mode: "ltp", id: "s1" })));
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  console.log(m.type, m.symbol ?? "", m.ltp ?? "");
  if (m.type === "tick" && ++ticks === 3) ws.close();
});
```

```bash
node stream.mjs
```

```text
heartbeat  
status  
snapshot  
tick NSE:RELIANCE 1461.7
tick NSE:RELIANCE 1461.7
tick NSE:RELIANCE 1461.7
```

The `heartbeat`, `status` and `snapshot` messages come first; then a `tick` for every price change. (Demo prices change
slowly, so ticks can repeat a value.) The message formats are in [streaming.md](streaming.md). Node 22 also has a
built-in `WebSocket`, so outside this folder you do not need `ws`.

## 7. Stop and clean up

Press Ctrl+C in the first terminal. Your keys and paper orders stay in the data folder. To start over, see
[How do I reset?](faq.md#how-do-i-reset) in the FAQ.

## Next steps

- [Accounts](accounts.md): connect a real broker (paper mode first) and run several accounts.
- [Rate limits](rate-limits.md): how the Bridge keeps inside each broker's limits, per-key quotas, and what a 429 means.
- [Sources](sources.md): free delayed and end-of-day sources, plugins, and how to read the labels.
- [Safety](safety.md): paper and live, the kill switch, limits and the audit log.
- [MCP](mcp.md): let an AI assistant read prices (and prepare orders you confirm).
- SDKs: [Python](python.md) and [Node and TypeScript](typescript.md).
- Integrations: [Excel and Google Sheets](excel-sheets.md), [AmiBroker](amibroker.md), [webhooks](webhooks.md).
- [FAQ](faq.md), and the [full API reference](../openapi.yaml).

## Troubleshooting

### Port already in use

Starting the Bridge fails at once:

```text
Error: Port 4300 is already in use by another program (not this Bridge). Close that program, or choose another port under "server" in bridge.config.json (for example "port": 4301).
```

Close the other program, or use another port for this run with an environment variable:

```bash
MCB_PORT=4301 npm run dev
```

Every later command that talks to the Bridge (`npm run bridge -- open`, `doctor`, `curl`) must use the same port. If you
forget, `npm run bridge -- open` answers `The Bridge is not running at http://127.0.0.1:4300`. To keep the port, put
`"server": { "port": 4301 }` in `bridge.config.json`.

If a Bridge is already running, starting a second one says so instead:

```text
The Bridge is already running at http://127.0.0.1:4300. To open its dashboard, run: mc-bridge open
```

If that Bridge keeps its files in another folder, you get `A Bridge is running at ..., but it keeps its files in another
folder than ...`: run the command from the folder you started it in, or stop it and start it again.

### Node version

The Bridge needs Node.js 22.12 or newer. Check with `node -v`. `npm run doctor` prints a `Node.js <version>` line and
marks it as failed with "(22 or newer is required)" on an older version. Install a current Node.js (or use the
[one-step installer](install.md), which brings its own) and run `npm ci` again.

### The key is not accepted (401)

A 401 has a `detail` that tells you which of three things is wrong:

| `detail` | Cause and fix |
|---|---|
| `Send your Bridge API key as 'Authorization: Bearer <key>'.` | No key, or the header is not in the `Authorization: Bearer <key>` form (a bare key, or `X-API-Key`, is not accepted). The shell variable may also be empty: run `echo $MCB_API_KEY`. |
| `This API key is not valid, has expired or was revoked.` | The key is mistyped or cut off (a key looks like `mcb_<id>_<secret>` and is shown only once), was revoked, or has expired. Make a new one. |
| the same text, but the key is fresh | The key was made for a *different data folder* than the running Bridge uses (for example the CLI ran with another `MCB_HOME` or config file). The CLI prints "keys live in `<folder>`" when it creates a key; compare that with the "Data folder" line the Bridge printed at start. Run `keys create` from the same folder, with the same `MCB_HOME` or `--config`. |

A key that is valid but lacks the access gets a 403 instead. A key made with `--scope read` that places an order is
answered `SCOPE_REQUIRED: This API key needs the "paper" scope.` Make a key with the scope it needs. A missing or too short `Idempotency-Key` is a 400 `VALIDATION_FAILED` naming the
header.

### The dashboard asks you to sign in

You see "Sign in with an admin key". The dashboard keeps its session in the browser *tab* and forgets it when the tab is
closed, and the sign-in link printed at start works **once** and expires after 10 minutes. Get a fresh link:

```bash
npm run bridge -- open
```

```text
Open this link in your browser to see the dashboard, already signed in. It works once and expires in 10 minutes:
  http://127.0.0.1:4300/dashboard#signin=<one-time code>
```

(Or paste an admin key into the sign-in box: `npm run bridge -- keys create --label me --scope admin,paper`.) The dashboard
works only on the computer running the Bridge. Use the same port and data folder as the running Bridge, as above.

### Requests are refused with 429

A 429 means a limit said no, and the body says whose. This one is from a key whose quota was lowered to one request a
second (`PUT /v1/quotas/<keyId>` with `{"perSecond":1,"burst":2}`; the third request in a second is refused):

```text
HTTP/1.1 429 Too Many Requests
Retry-After: 1
Content-Type: application/problem+json
```

```json
{"title":"Too many requests from this API key","status":429,"detail":"This API key is sending more than 1 requests a second (burst 2). Try again in 944 ms.","code":"RATE_LIMITED","retryable":true,"retryAfterMs":944,"scope":"client","limit":{"name":"perSecond","remaining":0,"resetMs":944}}
```

Read these fields, not the text:

| Field | Meaning |
|---|---|
| `scope` | Whose limit: `client` (this API key's own rate, daily cap or requests in flight), `consumer-cap` (this key already has too many requests waiting), `queue` (the shared queue for that account is full) or `upstream` (the broker's own budget cannot serve you in time) |
| `retryAfterMs` | How long to wait before trying again; `Retry-After` is the same in whole seconds |
| `limit` | The budget that refused: its `name`, what `remaining` and when it resets (`resetMs`) |

For `client` and `consumer-cap`, slow the tool down or raise that key's quota (dashboard: Sources, Quotas). For
`queue` and `upstream`, wait `retryAfterMs`, or read from the stream or cache instead of polling. More in
[rate-limits.md](rate-limits.md).
