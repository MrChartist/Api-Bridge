# FAQ

Short answers, each pointing at the guide that has the details.

## Is it free?

The Bridge is free, open-source software under the [MIT License](../../LICENSE). There is no hosted service and no account
with us: it runs on your computer. What can cost money is outside the Bridge. Some brokers charge for their API or for
live market data, and some data vendors have paid plans. For example, [BROKERS.md](../BROKERS.md#limits-live-feed-and-data-plans)
lists brokers whose live quotes need a paid plan, and the Twelve Data and Alpha Vantage sources in
[sources.md](sources.md) need your own vendor key (and a paid plan for Indian data on Twelve Data). Check your broker's
current pricing.

## Is my broker supported?

41 brokers are supported; the list, with how each logs in and what it can do, is in [BROKERS.md](../BROKERS.md) and on the
dashboard's Accounts page. Only **Dhan** has been verified end to end with a live account. The other 40 are **beta**:
written from the broker's official documentation and tested against recorded sample responses. Live order mapping exists
only for Dhan (verified) and for Zerodha and Upstox (beta, with a warning on every live order); for every other broker the
Bridge answers a live order with a "use paper mode" error. Reading data and paper trading work wherever the adapter says
they do.

If your broker is not on the list, open the "New broker request" issue form (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).
Adapters are written only from a broker's official documentation.

## Why is pooling off?

Pooling means using the request budgets of several of *your own* accounts to serve market-data reads, so busy tools get
more room. No broker's published terms clearly allow it, and none clearly forbids it; a few say things that could matter.
So the Bridge leaves it off until you accept a notice that names the risk, and then it only ever pools accounts of one
holder, only for reads, and never moves an order. Orders always go through the account they belong to. The details and
the per-broker findings are in [rate-limits.md](rate-limits.md#spreading-reads-across-your-own-accounts-pooling). You are
responsible for following your brokers' terms; get a legal read if you are unsure.

## Why can't I get real-time data from Yahoo?

Because Yahoo does not offer it, and the Bridge does not pretend it does. Yahoo Finance is an unofficial, delayed source
(about 15 minutes), and its terms restrict automated access. It is off by default; you turn it on by reading a notice, and
every answer from it is labelled `"class": "delayed"` and `"official": false`. It is meant for charts, history and your own
cross-checks. Real-time Indian market data is licensed by the exchanges, and no free official source of it exists that you
may redistribute, so real-time prices come from your own broker account. Orders, risk checks, paper fills and alerts accept
only real-time data from a broker; the Bridge refuses to use a delayed or end-of-day source for them. See
[sources.md](sources.md).

## Is paper trading safe?

For your money, yes: a paper order is simulated locally and never reaches a broker. Every order is paper unless a request
passes every live-trading opt-in ([safety.md](safety.md)), and a live request that misses one is refused, not quietly
downgraded. But paper results are not a forecast of live results. The simulator fills market orders at the opposite best
price or the last price plus slippage, has no queue position, partial fills or market impact, and approximates margin
rather than computing a broker's own. In demo mode the prices are sample data. Do not size a real strategy from paper
profits alone.

## Where is my data stored?

On your computer, in the Bridge's data folder, which is printed when the Bridge starts (`Data folder: ...`). By default it
is `~/.mc-bridge/data` on Mac and Linux and `%APPDATA%\MrChartist\Bridge\data` on Windows; `MCB_HOME` or `dataDir` in
`bridge.config.json` change it. In it you will find the API key list (fingerprints, not the keys), the encrypted store of broker
credentials and source keys (once you add any), the audit log, orders and paper accounts, safety counters and the
instrument cache. The Bridge listens on `127.0.0.1`, so other computers cannot reach it. The Bridge has no telemetry. It talks to your brokers and to any free
or key-based data source you turn on, and to the IP-lookup address only if you turn on that optional readiness check
([deployment.md](deployment.md)). `npm run doctor` also warns when the
encryption master key sits in the data folder next to the secrets, because a backup of the folder then carries both.

## How do I reset?

- **Paper account only:** on the dashboard's Accounts page, press Reset funds, or call
  `POST /v1/paper/accounts/{id}/reset` (a key with the `paper` scope; optional `{"startingCapital": 500000}`). It clears
  paper orders and positions. `POST /v1/paper/accounts/{id}/reset/undo` puts the old book back for 2 minutes, if no order
  has been placed since.
- **A key:** revoke it on the API page (Simple view: Ctrl K, then type *Keys*) or with `npm run bridge -- keys revoke <keyId>`, and make a new one.
- **Everything, starting fresh:** stop the Bridge (Ctrl+C), then move or delete the data folder. That removes keys, paper
  state, the audit log and any stored broker credentials. To try the Bridge without touching your real folder, point it at an
  empty one: `MCB_HOME=$(mktemp -d) npm run dev` (PowerShell: `$env:MCB_HOME = (New-Item -ItemType Directory (Join-Path $env:TEMP ([guid]::NewGuid()))).FullName; npm run dev`). If you installed with the one-line installer, `--purge` removes the data
  too ([install.md](install.md)).

## More questions

[Quickstart troubleshooting](quickstart.md#troubleshooting) covers a port in use, a key that is not accepted, the dashboard
asking you to sign in and 429 refusals. For anything else, search the
[issues](https://github.com/MrChartist/api-bridge-v2/issues) or open one.
