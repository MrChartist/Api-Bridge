# Connect Dhan, step by step

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

Dhan is the broker this project has checked end to end with a real account (the project maintainer did that before the verification
ladder existed; the date was not recorded, which [BROKERS.md](../BROKERS.md#verification-ladder) and `server/brokers/verification.json` say too).
Every other broker is beta or contract-tested against recorded samples. This page walks from nothing to a first real price, a paper order
priced by Dhan's data, and what live orders need. It describes only what the Dhan adapter (`server/brokers/dhan*.mjs`) and the Bridge do. It has no screenshots, and it does not
describe Dhan's own web pages, whose menus change: for those use Dhan's documentation, <https://dhanhq.co/docs/v2/>.

Try everything in demo mode first ([quickstart.md](quickstart.md)); the steps below are the same with a real account.

## What you need from Dhan

- **A Client ID** and an **access token**, made on Dhan's web site. The Bridge has no Dhan login call: you paste the Client ID and the token, and
  every request to Dhan sends them as the `client-id` and `access-token` headers. The adapter's own notes call it a **24-hour** token, so
  expect to paste a new one each day.
- **The Data API plan** for prices. Dhan's trading APIs are free; the data APIs (live feed, quotes, history, option chain) cost money
  (the Bridge's policy table records Rs 499 plus tax a month per account, with Dhan's page as the source; check Dhan's current price).
  Without the plan the connection test says so: *Dhan token works, but the Data API plan is not active on this account (needed for option chain and quotes).*
- **For live orders only**, a **static IP address registered with Dhan**. The adapter's own notes say Dhan refuses order calls from any other
  address. A home connection usually has a changing address: see [deployment.md](deployment.md). Data calls work from anywhere.

## 1. Add the account

On the dashboard open **Accounts**, press **Add a broker** and choose Dhan. The account is saved to your settings file and is **paper only**. Or add it
to `bridge.config.json` yourself:

```json
{ "accounts": [
  { "id": "dhan-main", "broker": "dhan", "label": "Dhan (main)", "holder": "self" },
  { "id": "paper", "broker": "paper", "label": "Practice account" }
] }
```

`id` is your name for the account (2 to 32 lowercase letters, digits, hyphens). Keep a `paper` account beside it: paper orders are priced from the same
real prices ([orders.md](orders.md)). Restart the Bridge after editing the file by hand.

## 2. Log in

Dhan's login kind is `apiKeyToken`: two fields, `clientId` and `accessToken`. Use one of:

- the dashboard: **Accounts, Log in** on the Dhan account;
- the terminal, which asks for each field with hidden input so nothing lands in your shell history (needs an admin key in `MCB_ADMIN_KEY`):

  ```sh
  mc-bridge accounts connect dhan-main
  ```

- the API, admin key from this computer: `POST /v1/accounts/dhan-main/session` with `{"values": {"clientId": "...", "accessToken": "..."}}`
  ([accounts.md](accounts.md#2-log-in)).

The values are stored encrypted in your data folder (`secrets.enc`, sealed with the master key) and go only to Dhan, over HTTPS.

## 3. Test it

```sh
curl -s -X POST -H "Authorization: Bearer $MCB_ADMIN_KEY" http://127.0.0.1:4300/v1/accounts/dhan-main/test
```

This makes one cheap call to Dhan (its profile) and answers `{"ok": true, "message": "Dhan API connected. Token valid until ..."}` when the token works.
It says so in plain words when the token is wrong or expired, or when the Data API plan is not active.

## 4. A first real price

```sh
curl -s -H "Authorization: Bearer $MCB_API_KEY" "http://127.0.0.1:4300/v1/quotes?symbols=NSE:RELIANCE&account=dhan-main"
```

Look at the `freshness` block of the answer: `source` is `broker`, `broker` is `dhan`, `accountId` is your account, `class` is `realtime` and `official` is true.
That label is how you know the data is from your own broker and fit for orders. Without `account=` the Bridge uses your first connected account.

## What the Dhan adapter does

| Area | What it does today |
|---|---|
| Instruments | Loads Dhan's instrument list (shares, indices, futures, options) and uses it for every symbol, expiry, strike and lot size |
| Prices | Last price and full quotes (up to 1,000 instruments in a request) and market depth |
| History | Candles at `1m`, `5m`, `15m`, `60m` and `1d`. For intraday Dhan allows **90 days per call**; the Bridge chunks longer ranges, so a download of a year is a handful of calls ([downloads.md](downloads.md)) |
| Option chains | Dhan's own chain call, with Greeks from Dhan and IV in percent, for the six index underlyings the adapter has ids for: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, BANKEX. `GET /v1/expiries?underlying=NIFTY` lists the expiries |
| Live feed | Dhan's binary WebSocket feed, shared by every tool you run: up to 5 connections of 5,000 instruments, 100 per subscribe message ([streaming.md](streaming.md)) |
| Portfolio | Positions, holdings, funds, order book and trade book, as they are at Dhan. Dhan's positions and holdings carry no last price, so those fields are empty |
| Orders | Place, modify and cancel, live, on NSE, BSE, NFO, BFO, MCX and CDS, with products `CNC`, `INTRADAY`, `MARGIN` and `MTF`; order types `LIMIT`, `MARKET`, `SL`, `SL-M`; validity `DAY` or `IOC`. A market order is sent as a protected limit, because the adapter has no native market protection. Dhan allows 25 modifications per order |
| Errors | Dhan's codes are mapped: an invalid or expired token (DH-901, 807 to 810) becomes `UPSTREAM_AUTH`, rate limits (DH-904, 805, HTTP 429) `UPSTREAM_RATE_LIMIT`, bad input `UPSTREAM_INPUT`, a missing data subscription (DH-902, 806) `UPSTREAM_NOT_SUBSCRIBED` |

Things it does not do: it does not log in for you, create tokens or handle Dhan's two-factor steps; it does not place Dhan's cover or bracket
orders (the products above are what it sends); and it never retries an order that timed out ([orders.md](orders.md#outcome_unknown-the-broker-did-not-say)).

## Limits, and how the Bridge keeps inside them

These are Dhan's documented limits as recorded in the Bridge's policy table (checked against Dhan's documentation, November 2026; `GET /v1/limits`
shows what your running Bridge uses). You can lower them, never raise them ([rate-limits.md](rate-limits.md)).

| Kind of request | Limit |
|---|---|
| Orders | 10 a second, 250 a minute, 1,000 an hour, 7,000 a day (the Bridge's own cap is lower: 5 a second per account, `safety.orderRatePerSecond`) |
| Market quote and depth | 1 request a second, up to 1,000 instruments each |
| Option chain | one unique request every 3 seconds |
| History | 5 a second, 100,000 a day |
| Account reads (positions, funds, order book) and other calls | 20 a second |

Because quotes are 1 a second per account, several tools asking at once share that one request through the Bridge's batching and the stream
instead of each spending it. For many symbols use the stream ([streaming.md](streaming.md)).

## The daily routine

1. Make a new access token on Dhan's site and log in again (dashboard **Accounts**, or `accounts connect`). A broker session is not extended by
   restarting the Bridge.
2. The Bridge is not told when your token ends. It finds out when Dhan rejects a call; the account then shows **expired**, reads that need it answer
   `SESSION_EXPIRED`, and the morning reminder (`account.login_needed`, 08:45 IST on trading days, [accounts.md](accounts.md#3-sessions)) lists it.
3. The readiness check on the **Safety** page tells you, before an order fails, whether the session and (with the lookup turned on) the registered address are right
   ([deployment.md](deployment.md#5-the-daily-routine-and-what-the-badge-means)).

## Going live

Live orders on Dhan need every opt-in in [orders.md](orders.md#live-orders): `safety.liveTrading`, the account's `live.enabled`, a `live` key made on this computer,
`"mode": "live"` and an idempotency key, plus a registered static IP and a logged-in session. Put the registered address in the account's
`live.registeredIp` (and a second one in `live.backupIp` if you registered one):

```json
{ "id": "dhan-main", "broker": "dhan", "live": { "enabled": true, "allowedSources": ["rest"], "registeredIp": "203.0.113.10" } }
```

(`203.0.113.10` is a documentation address; use yours.) Start with one small order, and check it in Dhan's own order book. The kill switch
([safety.md](safety.md)) stops new orders at once.

## When it does not work

| You see | Cause and fix |
|---|---|
| `Dhan token works, but the Data API plan is not active` | Buy or activate Dhan's Data API plan; prices, history and chains need it |
| `SESSION_EXPIRED` or `UPSTREAM_AUTH` | The token ended or is wrong. Make a new one and log in again |
| `UPSTREAM_NOT_SUBSCRIBED` | The Data API plan is missing for this account |
| `UPSTREAM_RATE_LIMIT` or `RATE_LIMITED` | A limit above was reached. Wait for `Retry-After`; use the stream instead of polling |
| A live order is refused by Dhan with an address message | The Bridge's computer is not on the address registered with Dhan. [deployment.md](deployment.md) |
| `PAPER_ONLY` on a live order | One of the live opt-ins is missing: [orders.md](orders.md#live-orders) |
| A sixth feed connection drops the first | Dhan allows 5 connections per account. Run one Bridge per account and share it |

More: [troubleshooting.md](troubleshooting.md), [accounts.md](accounts.md), [BROKERS.md](../BROKERS.md).
