# Alerts: TradingView, ChartInk, GoCharting and signed generic hooks

An alert from your own code or a charting site becomes an order through a **hook**: a URL with a secret token, tied
to one account and a set of limits. Every signal goes through the same safety checks, rate limits, idempotency and
audit log as an order sent from a script. Hooks are **paper** by default.

Four sources are supported:

| Source | Sender | Credential |
|---|---|---|
| `generic` | Your own scripts, bots and services | URL token **plus** an HMAC signature on every request |
| `tradingview` | TradingView strategy, indicator and price alerts | URL token only (TradingView cannot sign) |
| `chartink` | ChartInk scan alerts | URL token only (ChartInk cannot sign) |
| `gocharting` | GoCharting alerts | URL token only (GoCharting cannot sign) |

The dashboard does the same as the API below: **API → Integrations → TradingView and webhooks → Create webhook**
(choose the source there; it defaults to TradingView). Home shows every source on its map, and **Latest alerts** there
says what became of each alert: placed, or refused and why.

## 1. Create a hook

Admin key, from this computer:

```bash
curl -X POST http://127.0.0.1:4300/v1/hooks -H "Authorization: Bearer $MCB_ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "source": "generic",
  "label": "NIFTY breakout",
  "account": "paper",
  "mode": "paper",
  "product": "MARGIN",
  "orderType": "LIMIT",
  "maxLotsPerSignal": 2,
  "allowedSymbols": ["NFO:NIFTY-2026-10-27-FUT"],
  "requireConfirmation": false
}'
```

The reply holds `url` and `path` (with the token; **shown once**, only a hash is kept), for `generic` hooks a
`signingSecret` (also shown once), ready-to-paste `templates` for the alert message, and any `warnings`. `GET /v1/hooks` lists hooks without tokens; `DELETE /v1/hooks/{hookId}`
stops a URL at once.

| Field | Meaning |
|---|---|
| `source` | `tradingview`, `chartink`, `gocharting` or `generic` |
| `account` | The account orders go to |
| `mode` | `paper` (default) or `live`. Creating a live hook is refused unless the creating key has the `live` scope as well as `admin`, the account has `live.enabled` and `"webhook"` in its `live.allowedSources`, `safety.liveTrading` is on, and (for unsigned sources, see below) one of `allowSourceIps`, `requireConfirmation` or `acknowledgeUnsignedLive` is set |
| `side` | Fix the side (`BUY`/`SELL`). Required for ChartInk, whose alerts carry none; otherwise an alert asking for the other side is refused |
| `product`, `orderType` | Fixed per hook. `orderType` is `LIMIT`, `MARKET`, `SL` or `SL-M`. `LIMIT` and `SL` alerts must carry a `price`; `SL` and `SL-M` (stop-loss) alerts must carry a `triggerPrice`. ChartInk hooks take `LIMIT` or `MARKET` only |
| `maxLotsPerSignal` | Larger signals are refused, never trimmed |
| `allowedSymbols` | Only these canonical symbols (recommended for derivatives). Exact contracts: a dated future stops matching on expiry, so the create response warns 7 days ahead; update the hook at each roll-over |
| `requireConfirmation` | Every signal waits on the dashboard (Pending confirmations); confirming places exactly that order, once |
| `allowSourceIps` | Optional allowlist of sender IP addresses or IPv4 CIDR blocks (for example the addresses your alert service publishes) |
| `acknowledgeUnsignedLive` | `true` to accept that a live ChartInk or GoCharting hook is protected by its URL alone (audited and shown on the hook) |

**Unsigned live hooks: the trade-off.** ChartInk and GoCharting cannot sign their alerts, so the URL
token is the only credential, and that URL lives in your charting account, browser history and tunnel logs. Replay
protection is only the dedupe window. For `"mode": "live"` the Bridge therefore insists on at least one extra guard:
`allowSourceIps` (best, when the service publishes its sending addresses), `requireConfirmation: true` (you approve each
order), or an explicit `acknowledgeUnsignedLive: true`. Signed `generic` hooks (HMAC with a timestamp) need none of
these. The key that created a live hook is recorded on it; revoke that key and the hook stops accepting alerts.

## 2. Make the URL reachable

ChartInk and GoCharting post from the internet (usually only to HTTPS on port 443), and so does any script running
elsewhere. Turn on the **public ingress** listener, which serves `/hooks/*` and nothing else, and run your own tunnel
to it:

```json
"server": { "publicIngress": { "enabled": true, "host": "127.0.0.1", "port": 4301, "allowedHosts": ["hooks.example.com"] } }
```

```bash
cloudflared tunnel --url http://127.0.0.1:4301     # or a named tunnel with your own host name
```

Give the sender `https://<tunnel host>/hooks/<source>/<token>` (the `path` from step 1). If the tunnel runs on this
computer and adds a client-IP header, set `hooks.clientIpHeader` so IP allowlists see the real sender (trusted only from loopback).

## 3. Alert messages

### Signed generic hook (your own code)

The recommended source for anything you control.

`"source": "generic"` returns a `signingSecret` (shown once). Sign each request:

```python
import hmac, hashlib, json, time, urllib.request

body = json.dumps({"symbol": "NSE:RELIANCE", "side": "BUY", "quantity": 1, "orderType": "MARKET", "id": "sig-42"}).encode()
t = str(int(time.time()))
sig = hmac.new(SECRET.encode(), t.encode() + b"." + body, hashlib.sha256).hexdigest()
req = urllib.request.Request(HOOK_URL, data=body, method="POST",
                             headers={"Content-Type": "application/json", "X-MCB-Signature": f"t={t},v1={sig}"})
print(urllib.request.urlopen(req).read())
```

Requests older or newer than 5 minutes, or replayed inside that window, are refused with `401` before the body is
read. `{ "signals": [...], "id": "batch-7" }` sends several at once.

The body accepts `symbol` (any symbol the Bridge understands, canonical preferred), `side`, `quantity` or `lots`,
`price` (required for `LIMIT` and `SL` hooks), `triggerPrice` (required for `SL` and `SL-M` hooks), `orderType`, `product`, and `id` (+ optional `time`). Reusing an `id` the same
day never creates a second order.

### TradingView

Create the hook with `"source": "tradingview"`. In the TradingView alert, tick **Webhook URL** under Notifications,
paste the hook's public URL, and paste one of these into **Message** (the dashboard and `GET /v1/hooks` give you the
exact text for your hook under `templates`). TradingView fills in the `{{placeholders}}` when the alert fires.

A strategy alert (one order per strategy fill):

```json
{
  "symbol": "{{exchange}}:{{ticker}}",
  "side": "{{strategy.order.action}}",
  "quantity": "{{strategy.order.contracts}}",
  "price": "{{strategy.order.price}}",
  "id": "{{strategy.order.id}}",
  "time": "{{timenow}}"
}
```

An indicator or price alert has no order of its own, so write the side and quantity yourself, one alert per side:

```json
{ "symbol": "{{exchange}}:{{ticker}}", "side": "BUY", "quantity": 1, "price": "{{close}}" }
```

- Leave `price` out on a `MARKET` hook. Numbers may arrive as text (`"10"`); both are read.
- With `id` and `time` (the strategy template) a resend never places a second order that day. Without them,
  identical messages inside `hooks.dedupeWindowMs` count as one.
- A placeholder TradingView did not fill, or a side other than buy or sell, refuses the alert instead of guessing.
- A plain-text message works too, in the grammar GoCharting uses below: `BUY NSE:RELIANCE 10 @ 1402.5`.
- `{{exchange}}:{{ticker}}` gives the Bridge's symbol for cash (`NSE:RELIANCE`). Chart tickers are understood too:
  a chart on a continuous future (`NSE:NIFTY1!`) is resolved to the current front-month contract. For derivatives
  the quantity must be a multiple of the lot size (or send `lots`), and a hook with `allowedSymbols` lists the dated
  contract (`NFO:NIFTY-2026-11-24-FUT`), so update it after each expiry.
- TradingView posts from the internet, to HTTPS on port 443 only, and gives up on a slow answer, so it needs the
  public address of your tunnel or reverse proxy (section 2). It cannot sign, so the URL is the credential: for a
  live hook set `allowSourceIps` to the addresses TradingView publishes for its webhooks, or `requireConfirmation`.

### ChartInk

Create the hook with `"source": "chartink"` and a fixed `"side"`. Paste the URL into the scan's webhook box. ChartInk
sends its standard JSON (`stocks`, `trigger_prices`, `triggered_at`, `scan_name`); each stock becomes one signal of one
lot (one share for cash) at most, up to the per-alert cap.

### GoCharting

`"source": "gocharting"`; the alert text uses the plain-text grammar, for example `SELL NSE:SBIN 5 MKT INTRADAY` or
`BUY NSE:RELIANCE 10 @ 1402.5 id=L1 time=2026-10-19T04:00:00Z`. A JSON message works too. When the message carries
both `id` and `time`, a double delivery (or a re-delivery the same day) places **one** order; otherwise identical
messages inside `hooks.dedupeWindowMs` count as one. Words the Bridge does not understand, or an unfilled
`{{placeholder}}`, refuse the alert instead of guessing. Use `allowedSymbols` on derivative hooks.

## 4. What happens to a signal

`queued` → `processing` → `placed` | `duplicate` | `awaiting_confirmation` | `rejected` | `failed` |
`outcome_unknown`. Each step is in the audit log as `hook.signal` with the hook id, symbol, order id and reason. A
full queue answers `429` (never unbounded); each hook is limited to `hooks.maxSignalsPerMinute`. The kill switch
refuses every signal.
