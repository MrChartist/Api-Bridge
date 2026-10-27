# Backup data: Yahoo Finance and the NSE website

Brokers end API sessions every morning, go down, and ration requests. With backup data on, a read that **no broker
account can answer** is served from free public sources instead of failing, and is clearly labelled as such.

```json
"backup": { "enabled": true }
```

`mc-bridge init` writes this for new installs. It is off when the section is missing, and always off in demo mode.

## Sources

| Provider | What it gives | Notes |
|---|---|---|
| `yahoo`: Yahoo Finance chart API | Quotes and candles for NSE (`RELIANCE.NS`) and BSE (`RELIANCE.BO`) stocks and the main indices (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTY NEXT 50, INDIA VIX, SENSEX, BANKEX) | No account needed. Unofficial: may change or block without notice. Indian prices may be delayed. Intraday history is limited to about 30 days (1m), 60 days (5m-30m) and 2 years (60m); longer requests come back with `partial: true`. No futures or options. |
| `nse`: NSE India website JSON | Index quotes (`allIndices`), stock quotes, option expiries and option chains (`option-chain-v3`) | Best effort. The site blocks many datacenter, cloud and VPN addresses (HTTP 403) and throttles bursts. Works best from a home connection in India. |

The order they are tried is configurable (`order.equity`, default Yahoo then NSE; `order.index`, default NSE then
Yahoo).

## When it is used

- Only **unpinned** reads (no `account=`): `/v1/ltp`, `/v1/quotes`, `/v1/history`, `/v1/expiries`, `/v1/optionchain`,
  spreadsheet endpoints (`/xl/*`), the [compat API](compat-api.md) and the [scanner](scanner.md).
- Only after the broker path failed: no account connected, session expired, broker unreachable or erroring, rate
  budget gone with no cached value, or the broker cannot price that symbol.
- `?backup=false` on a request turns it off for that read; `?backup=true` turns it on when `autoFallback` is off.
- **Never for orders.** Order checks (price band, market protection), paper fills and safety limits never see backup
  prices, so a delayed public price can never move a real or paper order.

## How you can tell

Every item served from a backup source carries:

```json
"freshness": { "source": "backup", "provider": "yahoo", "asOf": "2026-10-26T15:29:59.000+05:30", "ageMs": 4211, "stale": true, "accountId": null, "broker": null }
```

`asOf` is the provider's own timestamp, so `ageMs` is the real age of the price. Backup values are not put in the
shared cache, so a later read can never pass one off as broker data.

## Direct access and health

```bash
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/backup/status"
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/backup/quotes?symbols=NSE:RELIANCE,NSE:NIFTY"
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/backup/history?symbol=NSE:INFY&interval=1d&countback=250"
```

`/v1/backup/history` is handy for big end-of-day work that should not spend any broker budget at all.

## Being a good citizen

These are free public pages, not paid APIs. The Bridge keeps to its own ceiling per provider (`perSecond`: Yahoo 4,
NSE 2 by default, calls spaced evenly), caches quotes for `cacheMs` (15 s), and after `breaker.failures` (5)
failures in a row leaves a provider alone for `breaker.cooldownMs` (60 s). `/v1/backup/status` shows each provider's
calls, errors and whether it is paused.

## All settings

```json
"backup": {
  "enabled": true,
  "autoFallback": true,
  "providers": { "yahoo": { "enabled": true, "perSecond": 4 }, "nse": { "enabled": true, "perSecond": 2 } },
  "order": { "equity": ["yahoo", "nse"], "index": ["nse", "yahoo"] },
  "cacheMs": 15000,
  "timeoutMs": 8000,
  "breaker": { "failures": 5, "cooldownMs": 60000 }
}
```

Use of these sites is subject to their own terms. The data is for your personal use on your own computer.
