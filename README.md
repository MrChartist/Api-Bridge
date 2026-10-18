# Mr. Chartist API Bridge

**One local API for all your Indian broker accounts.**

The Bridge runs on your own computer, logs in to your brokers once, and lets every tool you use share those
connections: Option Hub, charts (a TradingView-compatible UDF datafeed), TradingView / ChartInk / GoCharting alerts,
AmiBroker, Python and Node scripts, Excel and Google Sheets, and AI assistants such as Claude over MCP.

Your broker then sees **one careful client** instead of ten tools each polling on their own. That is how the Bridge
solves the headline problem of broker APIs: **rate limits**.

- **41 Indian brokers** behind one tested contract ([docs/BROKERS.md](docs/BROKERS.md)), several brokers and several
  accounts at the same time, each with its own session and its own limits.
- **Rate-limit engine:** live stream first, then a freshness-labelled cache, then batched and coalesced broker calls
  inside per-account, per-endpoint token buckets, with orders always ahead of reads.
- **One symbol format** for every broker: `NSE:RELIANCE`, `NSE:NIFTY`, `NFO:NIFTY-2026-10-27-25000-CE`.
- **Safe by default:** paper trading, `127.0.0.1` only, scoped API keys, kill switch, daily limits, idempotency keys,
  and a hash-chained audit log. Live orders need explicit opt-ins in your config file.

> Personal use only: the Bridge serves you (and family accounts you configure) on your own machine. It is not a
> hosted or multi-user service. See [Compliance notes](#compliance-notes).

---

## Contents

1. [Quick start](#quick-start)
2. [Connect brokers and multiple accounts](#connect-brokers-and-multiple-accounts)
3. [How rate limits are handled](#how-rate-limits-are-handled)
4. [Integrations](#integrations): REST · WebSocket/SSE · TradingView charts (UDF) · TradingView, ChartInk and GoCharting
   alerts · AmiBroker · Python · TypeScript/Node · Excel and Google Sheets · Claude Desktop and Claude Code (MCP) ·
   ChatGPT and OpenAI
5. [Safety model](#safety-model)
6. [Compliance notes](#compliance-notes)
7. [Configuration reference](#configuration-reference)
8. [Development](#development)
9. [Licence](#licence)

Detailed guides live in [`docs/guides/`](docs/guides/README.md). The HTTP contract is [`docs/openapi.yaml`](docs/openapi.yaml)
(also served at `/openapi.yaml`), the stream protocol is [`docs/asyncapi.yaml`](docs/asyncapi.yaml), and the design is
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Quick start

Requires **Node.js 20 or newer**.

```bash
git clone https://github.com/MrChartist/api-bridge.git
cd api-bridge
npm ci
cp bridge.config.example.json bridge.config.json   # edit "accounts" (see below)
npm run bridge -- doctor                           # checks Node, config, data folder, master key, port
npm start                                          # http://127.0.0.1:4300, paper mode
```

In a second terminal (in the same `api-bridge` folder), create your first keys (each key is printed **once**; copy it
then):

```bash
npm run bridge -- keys create --label me      --scope admin          # dashboard, connecting accounts, hooks
npm run bridge -- keys create --label scripts --scope paper          # paper orders from your own code
npm run bridge -- keys create --label charts  --scope read           # charts, scripts, AI assistants
npm run bridge -- keys create --label excel   --scope read --allow-query --client excel --expires 90d   # Excel (?key= in the URL)
```

> **Run the CLI as `npm run bridge -- <command>` (or `node bin/mc-bridge.mjs <command>`) from the `api-bridge`
> folder.** Do not type a bare `npx mc-bridge ...`: outside this folder npx fetches an unrelated public npm package of
> that name and runs it with your arguments. To get a global `mc-bridge` command, run `npm link` once in this folder.
> The command table below uses `mc-bridge` as shorthand for either form.

Then:

- open the **dashboard** at <http://127.0.0.1:4300/> (this computer only) and paste the admin key: accounts and
  sessions, rate-limit savings, live streams, pending confirmations and the kill switch;
- check the service: `curl http://127.0.0.1:4300/v1/health`;
- connect one broker account: `npm run bridge -- accounts connect dhan-main` (see [Log in each account](#2-log-in-each-account));
- read a price: `curl -H "Authorization: Bearer $MCB_API_KEY" "http://127.0.0.1:4300/v1/ltp?symbols=NSE:NIFTY,NSE:RELIANCE"`.

> **Every data call needs one connected broker account, paper trading included.** The built-in `paper` account
> simulates orders, but its prices and its instrument list (lot sizes, tick sizes, option chains) come from your
> broker sessions. Until one broker account is logged in, quotes, history, option chains, symbol lookups, UDF charts,
> streams, MCP price tools and paper orders all return an error (`BROKER_UNAVAILABLE`, `SYMBOL_NOT_FOUND`, or "no
> broker instrument master is loaded yet"). `mc-bridge doctor` and the startup lines say "No market-data source
> connected" while that is the case. There is no offline demo feed yet.

**Windows (PowerShell).** The commands above work as they are except `cp`, `export` and the curl lines:

```powershell
Copy-Item bridge.config.example.json bridge.config.json
$env:MCB_API_KEY = "mcb_..."                       # the key printed by keys create
$h = @{ Authorization = "Bearer $env:MCB_API_KEY" }
Invoke-RestMethod -Headers $h "http://127.0.0.1:4300/v1/ltp?symbols=NSE:NIFTY,NSE:RELIANCE"
# A paper order: JSON goes in a variable, not in single quotes on the command line
$order = @{ account = "paper"; symbol = "NSE:RELIANCE"; side = "BUY"; quantity = 1; product = "CNC"; orderType = "MARKET" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Headers ($h + @{ "Idempotency-Key" = [guid]::NewGuid().ToString() }) -ContentType "application/json" -Body $order "http://127.0.0.1:4300/v1/orders"
```

| Command | What it does |
|---|---|
| `mc-bridge start [--config file]` | Runs the Bridge (REST, WebSocket/SSE, UDF, `/xl`, webhooks, MCP over HTTP, dashboard) |
| `mc-bridge doctor [--no-port-check] [--json]` | Environment and config checks |
| `mc-bridge keys create --label <name> --scope read[,paper,live,admin] [--accounts a,b] [--expires 30d] [--allow-query] [--client excel]` | New API key (shown once) |
| `mc-bridge keys list` / `mc-bridge keys revoke <keyId>` | Manage keys; a revoked key fails on its very next request and its open streams close |
| `mc-bridge accounts list` | Accounts from your config and their session state |
| `mc-bridge accounts connect <accountId> [--key <admin key>]` | Log an account in: asks for each field the broker needs with hidden input and sends it to the running Bridge (nothing in shell history or `ps`) |
| `mc-bridge kill [--reason "<why>"] [--cancel-open] [--key <key>]` / `mc-bridge kill release [--key <admin key>]` | Kill switch from the terminal: through the API when the Bridge is running, straight to its saved state when it is not (audited either way). The reason defaults to "manual" |
| `mc-bridge mcp --key <key> [--url <bridge url>] [--config <file>]` | MCP over stdio for Claude Desktop, Claude Code, Cursor (relays to the running Bridge) |
| `mc-bridge openai-tools [--scope read\|paper] [--format responses\|chat]` | The same tools as strict OpenAI function schemas |

Config is read from `--config`, else `MCB_CONFIG`, else `./bridge.config.json`, else the per-user folder
(`~/.mc-bridge/bridge.config.json`, or `%APPDATA%\MrChartist\Bridge\bridge.config.json` on Windows; `MCB_HOME`
moves it). A relative `dataDir` is resolved next to the config file. Without any file the Bridge starts with safe
defaults (paper only, `127.0.0.1:4300`, no accounts) and keeps its data in the per-user folder, so a command run from
another folder still finds the same keys. `start` prints the dashboard address, the data folder and what to do next.

---

## Connect brokers and multiple accounts

### 1. List your accounts in `bridge.config.json`

```json
{
  "accounts": [
    { "id": "dhan-main",      "broker": "dhan",    "label": "Dhan (main)",      "holder": "self" },
    { "id": "zerodha-main",   "broker": "zerodha", "label": "Zerodha (main)",   "holder": "self",   "marketData": { "pooling": true } },
    { "id": "zerodha-2",      "broker": "zerodha", "label": "Zerodha (second)", "holder": "self",   "marketData": { "pooling": true } },
    { "id": "zerodha-spouse", "broker": "zerodha", "label": "Zerodha (spouse)", "holder": "spouse" },
    { "id": "paper",          "broker": "paper",   "label": "Practice account" }
  ]
}
```

- `id` is yours to choose (lowercase letters, digits, hyphens). `broker` is an adapter id from
  [docs/BROKERS.md](docs/BROKERS.md) (`dhan`, `zerodha`, `upstox`, `angelone`, `fyers`, `kotak`, `shoonya` ... 41 in all)
  or `paper`.
- You can list several accounts at the same broker (family accounts) and several brokers at once.
- `holder` says whose account it is (any label such as `self` or `spouse`, never a PAN). Market-data pooling only
  spreads reads over accounts with the **same** holder, and an account without a `holder` is never pooled: a family
  member is a different user under the brokers' personal-use terms. Pooling also needs the broker's policy to allow
  it, which none does yet (**needs verification per broker**).
- An unpinned read (no `account=`) is served only by accounts the API key may use; a key limited to some accounts
  never borrows another account's data entitlement or rate budget.
- `paper` is a built-in simulator account with ₹10,00,000 of practice capital. Every account can also take paper
  orders; paper is the default mode everywhere.
- **No credential ever goes in this file.**

### 2. Log in each account

Credentials go to the Bridge's encrypted store (AES-256-GCM, see [Safety model](#safety-model)) through the session
route, from this computer and with an admin key. The easy way, with the Bridge running:

```bash
export MCB_ADMIN_KEY=mcb_...                      # your admin key (PowerShell: $env:MCB_ADMIN_KEY = "mcb_...")
npm run bridge -- accounts connect dhan-main      # asks for each field this broker needs; typing is hidden
npm run bridge -- accounts connect angel-main     # session-login brokers also ask for PIN and TOTP (used once, never stored)
```

Option Hub's Broker Settings page does the same. For reference, the raw request (keep tokens, PINs and TOTP codes off
the command line: put the JSON in a file only you can read, or pipe it in, then delete it):

```bash
# API-key brokers (for example Dhan): the fields each broker needs are listed by GET /v1/brokers
#   dhan.json: {"values": {"clientId": "1100000000", "accessToken": "eyJ..."}}
curl -X POST http://127.0.0.1:4300/v1/accounts/dhan-main/session \
  -H "Authorization: Bearer $MCB_ADMIN_KEY" -H "Content-Type: application/json" -d @dhan.json

# Session-login brokers such as Angel One: PIN + current TOTP code are used ONCE for login, never stored
#   {"values": {"apiKey": "...", "clientId": "A123"}, "secrets": {"password": "<PIN>", "totpCode": "123456"}}
curl -X POST http://127.0.0.1:4300/v1/accounts/angel-main/session \
  -H "Authorization: Bearer $MCB_ADMIN_KEY" -H "Content-Type: application/json" -d @- < angel.json

curl -H "Authorization: Bearer $MCB_ADMIN_KEY" http://127.0.0.1:4300/v1/accounts      # session state per account
curl -X POST -H "Authorization: Bearer $MCB_ADMIN_KEY" http://127.0.0.1:4300/v1/accounts/dhan-main/test
```

Sessions follow each broker's daily expiry (most end early every morning, a daily re-login that brokers apply under
SEBI's retail algo framework, circular SEBI/HO/MIRSD/MIRSD-PoD/P/CIR/2025/0000013 of 4 February 2025; **needs
verification** against your broker's current notice). When one ends, reads
answer `SESSION_EXPIRED` with a plain message; log in again the same way. The Bridge never automates a broker's 2FA.

Full guide: [docs/guides/accounts.md](docs/guides/accounts.md).

### 3. Use them

- **Pin** a read or an order to an account with `account=<id>` (query) or `"account": "<id>"` (order body).
- **Unpinned** market-data reads use your primary account (the first connected one, in config order, that can serve
  the request), or are spread across accounts as described next.
- API keys can be limited to some accounts (`--accounts dhan-main,paper`).

---

## How rate limits are handled

A broker that allows one quote request a second cannot serve ten tools that each poll every second. The Bridge
puts every request through the same pipeline, so the broker only sees what is really needed:

1. **Streaming first.** If a live feed is subscribed for the symbol (because any tool is streaming it), the read is
   answered from the latest tick, with zero broker calls. One broker subscription is shared by every client.
2. **Freshness-labelled cache.** Recent values are reused within a per-kind freshness target (LTP 1 s, quote 2 s,
   depth 1 s, chain 3 s by default). Every value says where it came from and how old it is:
   `"freshness": { "source": "stream" | "cache" | "broker" | "paper", "asOf": "...", "ageMs": 420, "stale": false, "accountId": "dhan-main" }`.
3. **Coalescing and batching.** Identical requests in flight share one broker call (20 tools asking for the same
   price at once cause **one** call), and symbols from many requests are batched up to each broker's documented
   batch size.
4. **Token buckets per account and per endpoint class** (`order`, `quote`, `depth`, `history`, `chain`, `portfolio`,
   `master`), with second, minute and IST-day windows from each broker's documented limits. Unknown limits get
   conservative defaults; config may only **lower** them. The Bridge never bursts past a documented limit.
5. **Priority queues:** orders > live > interactive reads > background work, with ageing so background work still
   finishes. A broker 429 backs off only that account and endpoint class.
6. **Under pressure, honest fallbacks:** a value older than the target is served only labelled `"stale": true`
   (never for depth older than 5 s), and a symbol that could not be fetched in time is reported in `errors[]` with
   `UPSTREAM_RATE_LIMITED` and `retryAfterMs`, never silently dropped.
7. **Spreading reads across your own accounts.** Unpinned read-only market data may use several of **your** accounts
   only when both (a) the account opts in with `"marketData": { "pooling": true }` and (b) that broker's policy entry
   says pooling is `"allowed"`. Today every broker is `"unknown"`, which the Bridge treats as **not allowed**, so
   reads stay on your primary account until a broker's terms are verified. Orders and portfolio reads are never
   pooled. Each account's calls only ever use that account's own credentials.

See it working: `GET /v1/limits` (your key's budget and each broker's effective policy) and `GET /v1/usage` (calls,
queues and **savings**: calls served from stream, from cache, coalesced and batched). Your own per-key budget
(50 requests/s by default) comes back in `RateLimit` and `RateLimit-Policy` headers.

Every number in the policy table carries its source URL and a `verified` flag
([server/bridge/ratelimit/brokerPolicies.mjs](server/bridge/ratelimit/brokerPolicies.mjs)). Full guide:
[docs/guides/rate-limits.md](docs/guides/rate-limits.md).

---

## Integrations

Create one key per tool, with the least scope it needs. All examples assume the default address
`http://127.0.0.1:4300`.

### REST

```bash
K="Authorization: Bearer $MCB_API_KEY"
curl -H "$K" "http://127.0.0.1:4300/v1/quotes?symbols=NSE:NIFTY,NSE:RELIANCE"
curl -H "$K" "http://127.0.0.1:4300/v1/optionchain?underlying=NIFTY&expiry=2026-10-27&strikes=10&greeks=true"
curl -H "$K" "http://127.0.0.1:4300/v1/history?symbol=NSE:NIFTY&interval=5m&countback=300"
curl -H "$K" "http://127.0.0.1:4300/v1/symbols/convert?input=NSE:NIFTY1!"      # TradingView → canonical

# A paper order (the default), with an Idempotency-Key so a retry never creates a second order.
IDEM=$(node -e "console.log(crypto.randomUUID())")      # works on Linux, macOS and Git Bash; reuse it for retries
curl -X POST http://127.0.0.1:4300/v1/orders -H "$K" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEM" \
  -d '{"account":"paper","symbol":"NFO:NIFTY-2026-10-27-25000-CE","side":"BUY","lots":1,"product":"MARGIN","orderType":"LIMIT","price":180}'
```

PowerShell: `$idem = [guid]::NewGuid().ToString()` and send `-Headers @{ Authorization = "Bearer $env:MCB_API_KEY";
"Idempotency-Key" = $idem }` with `Invoke-RestMethod`.

`Idempotency-Key`: 8 to 255 characters from letters, digits and `_ . : -` (a UUID works; a short value such as `k1`
is refused with 400). It is **required for live orders** (or send a `clientOrderId`): a live order without either is
refused with 400 `VALIDATION_FAILED`, so a retry after a timeout can never place it twice. For paper orders it is
optional but recommended. The same key with a different body answers 409. A `clientOrderId` is unique per account per
IST day; another key reusing one gets 409 `DUPLICATE_CLIENT_ORDER_ID` and never sees the first key's order.

Responses are `{ "data": ..., "meta": { "requestId", ... } }`; errors are RFC 9457 `application/problem+json` with a
stable `code` and a `retryable` flag. Reference: [docs/openapi.yaml](docs/openapi.yaml).

### Live stream (WebSocket and SSE)

```js
// 1. Swap your key for a single-use, 60-second stream token (so the key never appears in a URL)
const { data } = await (await fetch("http://127.0.0.1:4300/v1/stream/token", { method: "POST", headers: { Authorization: `Bearer ${KEY}` } })).json();
// 2. Connect and subscribe
const ws = new WebSocket(`ws://127.0.0.1:4300/v1/stream?token=${encodeURIComponent(data.token)}`);
ws.onopen = () => ws.send(JSON.stringify({ op: "subscribe", symbols: ["NSE:NIFTY", "NSE:RELIANCE"], mode: "ltp" }));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "tick") console.log(m.symbol, m.ltp); };
```

Ops: `subscribe`, `unsubscribe`, `subscribe_orders`, `unsubscribe_orders`, `ping`. Messages: `snapshot`, `tick`,
`order`, `status`, `error`, `heartbeat`, `go_away`. SSE: `GET /v1/stream/sse?token=...&symbols=NSE:NIFTY&mode=ltp`
(add `&orders=1` for order updates). Slow clients get the latest value per symbol (gaps in `seq` show conflation),
never an unbounded buffer. Guide: [docs/guides/streaming.md](docs/guides/streaming.md).

### Charts: TradingView-compatible UDF datafeed

```js
// Any UDF client: base URL http://127.0.0.1:4300/udf, read key in the Authorization header
const auth = { headers: { Authorization: "Bearer mcb_..." } };
const cfg  = await (await fetch("http://127.0.0.1:4300/udf/config", auth)).json();
const bars = await (await fetch("http://127.0.0.1:4300/udf/history?symbol=NSE:NIFTY&resolution=5&countback=300&to=" + Math.floor(Date.now() / 1000), auth)).json();
// bars = { s: "ok", t: [...], o: [...], h: [...], l: [...], c: [...], v: [...] }
```

**Chart libraries that cannot send an `Authorization` header.** Every `/udf/*` route also accepts `?key=` with a
read-only key made for URLs (anything else answers 401 with a UDF `{"s":"error"}` body):

```bash
npm run bridge -- keys create --label charts-url --scope read --allow-query --expires 30d
# then: http://127.0.0.1:4300/udf/history?symbol=NSE:NIFTY&resolution=5&countback=300&to=...&key=mcb_...
```

A URL key ends up in browser history and server logs, so keep it read-only (it cannot be anything else) and short-lived
(`--expires`), and revoke it when you are done.

TradingView Advanced Charts (your own TradingView licence): its `UDFCompatibleDatafeed` builds each request as
`<base URL>/<path>?<params>`, so a `?key=` in the base URL does **not** work. Either give the datafeed a request
helper that adds the `Authorization: Bearer <read key>` header (the datafeed sources include a `Requester` that takes
headers; whether your library build exposes it **needs verification**), or put the chart page behind a small local
proxy on the same origin that adds the header.

Routes: `/udf/config`, `/udf/symbols`, `/udf/search`, `/udf/history`, `/udf/time`, `/udf/quotes`; Asia/Kolkata
sessions, `minmov`/`pricescale` from tick size; errors (including a bad key) come back as UDF `{"s":"error"}` bodies.
For a free chart, use TradingView **Lightweight Charts** (Apache 2.0):
[integrations/charts/lightweight-charts.html](integrations/charts/lightweight-charts.html) draws candles from UDF and
keeps the last bar live from the WebSocket. Guide: [docs/guides/charts.md](docs/guides/charts.md).

### TradingView, ChartInk and GoCharting alerts (webhooks)

Create a hook (admin key, this computer only). Its URL carries a 256-bit secret token and is **shown once**:

```bash
curl -X POST http://127.0.0.1:4300/v1/hooks -H "Authorization: Bearer $MCB_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"source":"tradingview","label":"NIFTY breakout","account":"paper","product":"MARGIN","orderType":"LIMIT",
       "maxLotsPerSignal":2,"allowedSymbols":["NFO:NIFTY-2026-10-27-FUT"]}'
```

> `allowedSymbols` holds exact contracts. A dated contract such as `NFO:NIFTY-2026-10-27-FUT` stops matching on its
> expiry day, and from then on every alert is refused while your chart keeps sending (for example `NSE:NIFTY1!`).
> The create response warns when an allowed contract expires within 7 days or has already expired; update the hook
> (delete and create it again) at each roll-over, or leave `allowedSymbols` out and rely on `maxLotsPerSignal`.

**TradingView alert message** (strategy alerts; paste into the alert's *Message* box, and the hook URL into
*Webhook URL*):

```json
{
  "symbol": "{{exchange}}:{{ticker}}",
  "side": "{{strategy.order.action}}",
  "quantity": "{{strategy.order.contracts}}",
  "price": "{{close}}",
  "id": "{{strategy.order.id}}",
  "time": "{{timenow}}"
}
```

- `id` + `time` make a TradingView double-fire place **one** order, not two.
- Hooks are **paper** unless created with `"mode": "live"`. Creating a live hook is refused unless: the creating key
  has the `live` scope as well as `admin` (admin alone never grants live trading; the CLI is exempt), live trading is
  enabled for that account with `"webhook"` in its `live.allowedSources`, and, because TradingView, ChartInk and
  GoCharting cannot sign their alerts (the URL is the only credential), the hook has `allowSourceIps` (for example the
  `"tradingview"` preset), or `"requireConfirmation": true`, or an explicit `"acknowledgeUnsignedLive": true`. The
  creating key is recorded on the hook; revoke that key and the live hook stops accepting alerts.
  `"requireConfirmation": true` makes every signal wait for you to confirm it on the dashboard; once you confirm,
  exactly that order is placed.
- The receiver answers `202` within milliseconds (TradingView gives up after 3 seconds) and processes the order in
  the background, through the same safety checks, rate limits and audit log as everything else.
- TradingView only posts to ports 80/443 on the public internet, so you need a tunnel (for example Cloudflare
  Tunnel) to the opt-in **public ingress** listener, which serves `/hooks/*` and nothing else:
  `"server": { "publicIngress": { "enabled": true, "port": 4301 } }`. Optional source-IP allowlist per hook.
- **ChartInk** (`"source": "chartink"`; set `"side"` on the hook because ChartInk alerts carry none),
  **GoCharting** (`"source": "gocharting"`, plain text such as `BUY NSE:RELIANCE 10`) and a **signed generic** hook
  (`"source": "generic"`, header `X-MCB-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + body)>`, 5-minute
  replay window) are also supported.

Guide: [docs/guides/webhooks.md](docs/guides/webhooks.md).

### AmiBroker

```c
#include_once <mrchartist-bridge.afl>      // from integrations/amibroker, copied to Formulas\Include

ltp = McbLtp("NSE:NIFTY");
chg = McbQuote("NSE:RELIANCE", "changePct");
Title = "NIFTY " + NumToStr(ltp, 1.2) + "   RELIANCE " + NumToStr(chg, 1.2) + "%";
```

The include reads a read-only URL key from the `MCB_AMIBROKER_KEY` environment variable (never from a strategy file),
caches each value for at least a second, and the Bridge answers from its stream or cache first. History imports use
`/xl/history?layout=amibroker` with the shipped `.format` files. Guide: [docs/guides/amibroker.md](docs/guides/amibroker.md).

### Python

```bash
python3 -m venv .venv && . .venv/bin/activate      # Windows: py -m venv .venv  then  .venv\Scripts\Activate.ps1
pip install ./sdk/python                            # standard library only, Python 3.9+ (or: pipx / uv pip install ./sdk/python)
export MCB_API_KEY=mcb_...                          # PowerShell: $env:MCB_API_KEY = "mcb_..."
```

Recent Debian, Ubuntu and Homebrew Pythons refuse `pip install` outside a virtual environment
(`externally-managed-environment`, PEP 668), hence the venv.

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()                                  # http://127.0.0.1:4300, key from $MCB_API_KEY
for q in bridge.ltp(["NSE:NIFTY", "NSE:RELIANCE"])["data"]:
    print(q["symbol"], q["ltp"], q["freshness"]["source"])

res = bridge.place_order({"account": "paper", "symbol": "NSE:RELIANCE", "side": "BUY",
                          "quantity": 1, "product": "CNC", "orderType": "MARKET"})   # paper; Idempotency-Key added for you
print(res["data"]["orderId"], res["replayed"])

with bridge.stream(["NSE:NIFTY"], mode="ltp") as s:     # reconnects and re-subscribes by itself
    for msg in s:
        if msg["type"] == "tick":
            print(msg["symbol"], msg["ltp"])
```

Guide: [sdk/python/README.md](sdk/python/README.md) · [docs/guides/python.md](docs/guides/python.md).

### TypeScript / Node

```bash
cd sdk/node && npm pack            # then, in your project: npm install /path/to/mrchartist-bridge-client-0.1.0.tgz ws
```

The SDK is **ESM only**: use `import`, or `await import("@mrchartist/bridge-client")` from CommonJS (`require()`
fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`). Types are included (`src/index.d.ts`). It has no runtime dependencies;
streaming on Node 20 needs `ws` (Node 22 and later have a built-in WebSocket). Installing the packed tarball rather
than `npm install ./sdk/node` (a symlink that quietly borrows the Bridge's own `ws`) shows a missing `ws` at once.

```ts
import { BridgeClient } from "@mrchartist/bridge-client";

const bridge = new BridgeClient({ apiKey: process.env.MCB_API_KEY! });
// Partial failures come back with HTTP 200: good symbols in data[], the rest in errors[]. Before any broker account
// is connected, every symbol is in errors[] and data[] is empty, so never assume data[0] exists.
const { data, errors } = await bridge.ltp(["NSE:NIFTY", "NSE:RELIANCE"]);
for (const q of data) console.log(q.symbol, q.ltp, q.freshness.source);
for (const e of errors) console.log(e.symbol, e.code, e.message);

const { data: order, replayed } = await bridge.placeOrder({
  account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET",
});

const stream = bridge.stream({ symbols: ["NSE:NIFTY"], mode: "ltp" });
stream.on("tick", (t) => console.log(t.symbol, t.ltp));
```

Guide: [sdk/node/README.md](sdk/node/README.md) · [docs/guides/typescript.md](docs/guides/typescript.md).

### Excel and Google Sheets

Excel for Windows, one live value per cell (read-only URL key kept in a named cell `BridgeKey`). `WEBSERVICE` can
only put the key in the URL, so it needs a key created for that, not the `charts` key above:

```bash
npm run bridge -- keys create --label excel --scope read --allow-query --client excel --expires 90d
```

```
=VALUE(WEBSERVICE("http://127.0.0.1:4300/xl/ltp?symbol="&ENCODEURL(A2)&"&key="&BridgeKey))
=VALUE(WEBSERVICE("http://127.0.0.1:4300/xl/quote?symbol="&ENCODEURL(A2)&"&field=changePct&key="&BridgeKey))
```

Errors (including a bad key) come back as `#N/A` (so `IFERROR` works) with the reason in the `X-Error-Code` header.
A `#N/A` on every cell with `X-Error-Code: UNAUTHENTICATED` usually means the key was created without
`--allow-query`.
Power Query tables (option chain, candles) send the key in a header: [integrations/excel](integrations/excel). Google
Sheets runs on Google's servers and cannot reach `127.0.0.1`; it needs your own tunnel and a read-only key with an
expiry, then `=BRIDGE_LTP("NSE:NIFTY")` from [integrations/google-sheets/bridge.gs](integrations/google-sheets/bridge.gs).
Nothing under `/xl` can place an order. Guide: [docs/guides/excel-sheets.md](docs/guides/excel-sheets.md).

### Claude Desktop and Claude Code (MCP)

The Bridge is an MCP server: Streamable HTTP at `POST /mcp`, and stdio through `mc-bridge mcp`, which relays to the
running Bridge so AI tools share its connections, limits, safety checks and audit log. Use a **read** key, and keep
the Bridge running (`npm start` in the `api-bridge` folder). If the AI app starts before the Bridge, `mc-bridge mcp`
still starts: it lists no tools and answers each call with "Bridge not running" until the Bridge is up, then the
tools appear without restarting the app.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mr-chartist-bridge": {
      "command": "node",
      "args": ["/path/to/api-bridge/bin/mc-bridge.mjs", "mcp"],
      "env": { "MCB_API_KEY": "mcb_...", "MCB_BRIDGE_URL": "http://127.0.0.1:4300" }
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add mr-chartist-bridge --env MCB_API_KEY=mcb_... --env MCB_BRIDGE_URL=http://127.0.0.1:4300 -- node /path/to/api-bridge/bin/mc-bridge.mjs mcp
# or straight to the HTTP endpoint:
claude mcp add --transport http mr-chartist-bridge http://127.0.0.1:4300/mcp --header "Authorization: Bearer mcb_..."
```

AI apps start the relay in their own folder, where your `bridge.config.json` is not: set `MCB_BRIDGE_URL` (or pass
`--url`, or `--config /path/to/bridge.config.json`) to the address the Bridge listens on, especially if you changed
`server.port`.

Tools (read-only by default): `get_ltp`, `get_quotes`, `get_depth`, `get_history`, `get_expiries`,
`get_option_chain`, `search_instruments`, `convert_symbol`, `option_chain_summary`, `history_summary`,
`list_accounts`, `get_positions`, `get_holdings`, `get_funds`, `list_orders`, `get_order`, `get_safety_status`.
Order tools (`prepare_order`, `submit_confirmed_order`) exist only when `mcp.toolsets` includes `"orders"`,
`mcp.orderAccounts` lists the account and the key has the `paper` scope; even then the AI only **prepares** a ticket
and nothing is sent until you confirm it on the dashboard. Guide: [docs/guides/mcp.md](docs/guides/mcp.md).

### ChatGPT and OpenAI

ChatGPT's connectors call MCP servers over the public internet (HTTPS, usually with OAuth). The Bridge deliberately
keeps `/mcp` on this computer and has no OAuth, so **a ChatGPT connector cannot reach it out of the box**
(ChatGPT's current options for local servers **need verification**). What works today:

- **OpenAI function calling from your own script:** `npm run -s bridge -- openai-tools > tools.json` prints the same tools
  as strict OpenAI function schemas (`--format chat` for Chat Completions); your script runs each call against the
  local REST API or `POST /mcp`.
- Do **not** expose `/mcp` through a tunnel without your own access control in front of it.

Guide: [docs/guides/chatgpt-openai.md](docs/guides/chatgpt-openai.md).

---

## Safety model

| Protection | Default |
|---|---|
| Paper trading | Default for every order, webhook and AI tool. Each order says `"mode": "paper"` or `"live"`. |
| Live orders | Need **all** of: (1) `safety.liveTrading: true` and (2) the account's `live.enabled: true` in the config file; (3) the request source (`rest`, `webhook`, `mcp`, `cli`) in the account's `live.allowedSources`; (4) a `live`-scoped key; (5) `"mode": "live"` in the request; (6) a person's confirmation on this computer for every AI-prepared order and for hooks with `requireConfirmation`; (7) every safety check. "AI-prepared" is decided by the key: a key made for an AI assistant (`--client mcp`) needs a confirmed ticket on every route, REST included, and the client that prepared a ticket can never confirm it. Nothing in the API, environment, MCP or a webhook can switch live trading on. Creating a live key or a live webhook needs a key that has `live` itself (admin alone is not enough). Same list as [the safety guide](docs/guides/safety.md#live-orders-need-every-one-of-these). |
| API keys | `mcb_<id>_<secret>`, stored only as scrypt hashes (N=2^15), scopes `read` < `paper` < `live`, plus `admin` (admin does **not** include live). Constant time in the secret; malformed keys and unknown key ids are refused without hashing, scrypt work is capped (2 at a time) and an address with many bad keys is refused for a minute. Revocation is immediate. `?key=` only for read-only keys created with `--allow-query`. |
| Order-rate cap | 5 orders/s per account by default (place, modify and cancel all count), counted when the order actually leaves for the broker; paper orders are paced the same way in their own window. Config cannot exceed 10/s, the SEBI threshold for unregistered retail algos (**needs verification**; your broker may set lower). |
| Kill switch | `POST /v1/safety/kill-switch` with any key and an empty body (or `{"reason": "..."}`) stops all new orders, including ones already queued or the remaining parts of a sliced order. `"cancelOpenOrders": true` needs a `live` key (or admin on this computer) and cancels only orders the Bridge placed on that key's accounts (`"includeExternal": true`, admin on this computer only, also cancels orders placed elsewhere, such as stop-losses set in the broker app). Release: `DELETE /v1/safety/kill-switch` with body `{"confirm": "RELEASE"}`, an admin key, from this computer. Also `mc-bridge kill` / `mc-bridge kill release` and the dashboard. |
| Daily limits | Order count (reserved as soon as an order passes its checks, so a burst cannot overshoot; every slice of a sliced order counts), loss (paper: realised from the paper engine's fills; live: the broker's day P&L including open positions, read before each live order, with a warning when it cannot be read), order value, lots per order, price band against LTP (also on every live modify); per account, per IST day. Market hours: NSE/BSE/NFO/BFO from the exchange calendar; MCX and CDS by weekday time window (**needs verification**, holidays not known). |
| Market orders | `protect` (converted to a protected limit) by default, or `reject`. No default product or order type. |
| Idempotency | `Idempotency-Key` header (8–255 characters) or `clientOrderId`, **required for live orders** and recommended for paper: the same key never reaches a broker twice. A live call that times out becomes `outcome_unknown` and is reconciled from the broker's order book, never retried blindly. |
| Audit log | Append-only, hash-chained JSON lines per IST day in `data/audit/`, redacted; `GET /v1/audit/verify` checks the chain. The CLI and the running Bridge can both append (a lock file keeps one chain). |
| Webhooks | 256-bit URL tokens (only a hash stored), HMAC signatures with a timestamp and a replay cache that refuses rather than forgets when full (generic hooks; the signature is checked before the hook's rate budget is charged), per-hook symbol, lot and product limits, rate limits, optional IP allowlists. Unsigned sources (TradingView, ChartInk, GoCharting) can go live only with an IP allowlist, confirmation, or an explicit acknowledgement. |
| Network | Binds `127.0.0.1`; other hosts need `allowNonLoopback`. Host-header check against DNS rebinding; `Origin` allowlist for browsers (no `*`). Admin, credential and confirmation routes answer only from this computer. |
| Secrets | Broker credentials encrypted at rest with AES-256-GCM (fresh IV per write, HMAC over the whole file). Master key from `MCB_MASTER_KEY` (base64 of 32 bytes) or a `0600` key file created on first start. By default that file is `data/master.key`, **next to** `secrets.enc`, so a backup, cloud sync or zip of the data folder carries both: set `MCB_MASTER_KEY_FILE` to a path outside the data folder (`mc-bridge doctor` warns until you do; on Windows also restrict the file with `icacls`, as the Bridge cannot check Windows permissions). Passwords, PINs and TOTP codes are used once for login and never stored. |
| Logs | Structured and redacted: secret field names, keys, bearer tokens, JWTs and every decrypted credential are masked; no request bodies; webhook paths are logged without their tokens. |
| AI | Read-only by default; an AI-prepared order is only a ticket until a person confirms it on this computer. |

Guide: [docs/guides/safety.md](docs/guides/safety.md).

---

## Compliance notes

None of this is legal advice. Items marked **needs verification** must be checked against the primary SEBI, NSE and
BSE circulars and your broker's current notices before you rely on them.

- **SEBI retail algo framework** (SEBI circular SEBI/HO/MIRSD/MIRSD-PoD/P/CIR/2025/0000013 of 4 February 2025, NSE
  implementation standards NSE/INVG/67858 of 5 May 2025). Mandatory from 1 April 2026 after extensions
  (SEBI/HO/MIRSD/MIRSD-PoD/P/CIR/2025/108 and /132; **needs verification**: both the effective date and any later
  changes). The Bridge is self-hosted
  personal software: you run your own logic with your own broker keys.
- **Order threshold:** unregistered client algos must stay at or below 10 orders/s per exchange segment, as measured
  by the broker (**needs verification per broker**). The Bridge caps at 5/s per account by default and never above
  10/s.
- **Static IP:** brokers require API orders to come from a static IP you registered with them (a primary and an
  optional secondary IP, changeable only occasionally; **needs verification** against the 4 February 2025 circular,
  the NSE standards and your broker's current rules). A tunnel to a home PC with a changing IP cannot place live
  orders. Set `live.registeredIp` per account for a pre-order check.
- **Daily logout:** API sessions end before the next trading day (**needs verification** per broker and against the
  4 February 2025 circular); the Bridge never stores TOTP secrets or automates 2FA.
- **Family use only:** a retail algo may be used by you, your spouse, dependent children and dependent parents
  (**needs verification**: the family definition in the 4 February 2025 circular and the NSE standards). Do
  not run the Bridge for anyone else; doing so, or selling signals, would likely need exchange empanelment as an algo
  provider (legal review needed).
- **Market data terms:** broker data is generally for personal use. By default the Bridge serves only you, on
  loopback, and spreads reads only across accounts with the same `holder` where the broker's policy allows it
  (**needs verification per broker**; all are treated as not allowed today). If you open a tunnel to the main API
  (for example so Google Sheets can fetch prices), you create a public endpoint and your broker's data passes through
  a third party's servers; your broker's data terms may not allow that (**needs verification per broker**), and that
  risk is yours. See [docs/guides/compliance.md](docs/guides/compliance.md#tunnels-and-public-endpoints).
- **Order threshold per client:** the cap is kept per Bridge account. Two config entries for the same broker login
  (or two brokers under the same PAN) each get their own 5/s, so set lower per-account limits if you run several
  (**needs verification**: whether the threshold is per client, per PAN or per exchange).
- **AI-placed orders:** no regulator or broker guidance covers AI agents placing orders; an AI order through your key
  is still your API order. Hence read-only by default and human confirmation for every AI order (**gray area**).
- **Live order support:** live orders are wired for Dhan, Zerodha and Upstox; only Dhan has been verified against a
  live account. The other adapters are fixture-tested, and every live preview and order on them carries a warning
  saying so.

More: [docs/guides/compliance.md](docs/guides/compliance.md) and [docs/ARCHITECTURE.md §12](docs/ARCHITECTURE.md#12-compliance-notes).

---

## Configuration reference

[`bridge.config.example.json`](bridge.config.example.json) shows every section. Core: `server`, `cors`, `dataDir`,
`logging`, `accounts`, `safety`. Modules: `ratelimit`, `symbols`, `market`, `stream`, `orders`, `paper`,
`integrations`, `hooks`, `mcp`. Unknown sections are errors, so typos are caught at start.

| Variable | Effect |
|---|---|
| `MCB_CONFIG` | Config file path |
| `MCB_HOST`, `MCB_PORT` | Listener (a non-loopback host still needs `server.allowNonLoopback` in the file) |
| `MCB_DATA_DIR`, `MCB_LOG_LEVEL` | Data folder, log level |
| `MCB_MASTER_KEY` / `MCB_MASTER_KEY_FILE` | Encryption key (base64 of 32 bytes) or key file path |
| `MCB_PAPER_ONLY=1` | Forces paper only (can only tighten) |
| `MCB_KILL_SWITCH=1` | Engages the kill switch at start (can only tighten) |
| `MCB_HOME` | Per-user folder for the config file and data when the current folder has no `bridge.config.json` (default `~/.mc-bridge`; Windows `%APPDATA%\MrChartist\Bridge`) |
| `MCB_API_KEY` | Key used by `mc-bridge mcp`, `mc-bridge kill` and the SDKs |
| `MCB_BRIDGE_URL` | Address of the running Bridge for `mc-bridge mcp`, `mc-bridge kill` and the SDKs (default `http://127.0.0.1:4300`) |

---

## Development

```bash
npm ci
npm test                       # unit, contract and end-to-end tests (no live broker calls)
npx vitest run --coverage      # vitest is a local dev dependency, so npx uses the repo's copy
npm run audit:runtime          # runtime dependencies must have no known vulnerabilities (CI checks this)
npm run check:mjs              # node --check on every .mjs file
npm run typecheck
cd sdk/node && npm test        # Node SDK
python3 -m pytest sdk/python/tests   # Python SDK (or: python3 -m unittest discover -s sdk/python/tests -t sdk/python)
```

Layout: `server/brokers/` (41 adapters behind [the broker contract](docs/broker-contract.md)),
`server/bridge/core/` (config, pipeline, security, CLI), one folder per service under `server/bridge/`
(`accounts`, `auth`, `ratelimit`, `symbols`, `market`, `stream`, `orders`, `paper`, `safety`, `integrations`,
`hooks`, `mcp`, `dashboard`), end-to-end tests in `server/bridge/e2e/`, SDKs in `sdk/`, ready-made integrations in
`integrations/`. CI runs on every push and pull request ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

---

## Licence

Proprietary. See [LICENSE](LICENSE). © 2026 Investology (Mr. Chartist). All rights reserved.

OpenAlgo (AGPL-3.0) was consulted for publicly documented facts only; no OpenAlgo code is copied or translated.
TradingView, Lightweight Charts and Advanced Charts are trademarks of TradingView, Inc.; Advanced Charts is not
included.
