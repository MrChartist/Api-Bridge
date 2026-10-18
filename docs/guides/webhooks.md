# Alerts: TradingView, ChartInk, GoCharting and signed generic hooks

An alert from a charting site becomes an order through a **hook**: a URL with a secret token, tied to one account
and a set of limits. Every signal goes through the same safety checks, rate limits, idempotency and audit log as an
order sent from a script. Hooks are **paper** by default.

## 1. Create a hook

Admin key, from this computer:

```bash
curl -X POST http://127.0.0.1:4300/v1/hooks -H "Authorization: Bearer $MCB_ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "source": "tradingview",
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

The reply holds `url` and `path` (with the token; **shown once**, only a hash is kept), ready-to-paste `templates`
for the alert message, and any `warnings`. `GET /v1/hooks` lists hooks without tokens; `DELETE /v1/hooks/{hookId}`
stops a URL at once.

| Field | Meaning |
|---|---|
| `source` | `tradingview`, `chartink`, `gocharting` or `generic` |
| `account` | The account orders go to |
| `mode` | `paper` (default) or `live`. Creating a live hook is refused unless the creating key has the `live` scope as well as `admin`, the account has `live.enabled` and `"webhook"` in its `live.allowedSources`, `safety.liveTrading` is on, and (for unsigned sources, see below) one of `allowSourceIps`, `requireConfirmation` or `acknowledgeUnsignedLive` is set |
| `side` | Fix the side (`BUY`/`SELL`). Required for ChartInk, whose alerts carry none; otherwise an alert asking for the other side is refused |
| `product`, `orderType` | Fixed per hook (`LIMIT` alerts must carry a price) |
| `maxLotsPerSignal` | Larger signals are refused, never trimmed |
| `allowedSymbols` | Only these canonical symbols (recommended for derivatives). Exact contracts: a dated future stops matching on expiry, so the create response warns 7 days ahead; update the hook at each roll-over |
| `requireConfirmation` | Every signal waits on the dashboard (Pending confirmations); confirming places exactly that order, once |
| `allowSourceIps` | Optional allowlist (`"tradingview"` is a preset of TradingView's published addresses; needs verification each release) |
| `acknowledgeUnsignedLive` | `true` to accept that a live TradingView, ChartInk or GoCharting hook is protected by its URL alone (audited and shown on the hook) |

**Unsigned live hooks: the trade-off.** TradingView, ChartInk and GoCharting cannot sign their alerts, so the URL
token is the only credential, and that URL lives in your charting account, browser history and tunnel logs. Replay
protection is only the dedupe window. For `"mode": "live"` the Bridge therefore insists on at least one extra guard:
`allowSourceIps` (best, for TradingView use the `"tradingview"` preset), `requireConfirmation: true` (you approve each
order), or an explicit `acknowledgeUnsignedLive: true`. Signed `generic` hooks (HMAC with a timestamp) need none of
these. The key that created a live hook is recorded on it; revoke that key and the hook stops accepting alerts.

## 2. Make the URL reachable

TradingView, ChartInk and GoCharting post from the internet; TradingView only to ports 80 and 443. Turn on the
**public ingress** listener, which serves `/hooks/*` and nothing else, and run your own tunnel to it:

```json
"server": { "publicIngress": { "enabled": true, "host": "127.0.0.1", "port": 4301, "allowedHosts": ["hooks.example.com"] } }
```

```bash
cloudflared tunnel --url http://127.0.0.1:4301     # or a named tunnel with your own host name
```

Give TradingView `https://<tunnel host>/hooks/tradingview/<token>`. If the tunnel runs on this computer and adds a
client-IP header, set `hooks.clientIpHeader` so IP allowlists see the real sender (trusted only from loopback).

## 3. Alert messages

### TradingView strategy alert

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

### TradingView indicator alert

```json
{ "symbol": "{{exchange}}:{{ticker}}", "side": "BUY", "lots": 1, "price": "{{close}}", "time": "{{timenow}}" }
```

- `id` + `time` identify the signal, so a TradingView double-fire (or re-delivery the same day) places **one** order.
- Leave out `price` for `MARKET` hooks. Send `quantity` or `lots`, not both.
- `{{ticker}}` for Indian futures and options is TradingView's own naming; the Bridge converts it, but that needs
  verification for every contract type, so use `allowedSymbols` on derivative hooks.
- Plain text works too: `BUY NSE:RELIANCE 10 @ 1402.5 id=L1`.
- TradingView needs 2FA on your account to send webhooks and abandons a request after 3 seconds; the Bridge answers
  `202` in milliseconds and processes the order in the background.

### ChartInk

Create the hook with `"source": "chartink"` and a fixed `"side"`. Paste the URL into the scan's webhook box. ChartInk
sends its standard JSON (`stocks`, `trigger_prices`, `triggered_at`, `scan_name`); each stock becomes one signal of one
lot (one share for cash) at most, up to the per-alert cap.

### GoCharting

`"source": "gocharting"`; the alert text uses the plain-text grammar, for example `SELL NSE:SBIN 5 MKT INTRADAY`.

### Signed generic hook (your own code)

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

## 4. What happens to a signal

`queued` → `processing` → `placed` | `duplicate` | `awaiting_confirmation` | `rejected` | `failed` |
`outcome_unknown`. Each step is in the audit log as `hook.signal` with the hook id, symbol, order id and reason. A
full queue answers `429` (never unbounded); each hook is limited to `hooks.maxSignalsPerMinute`. The kill switch
refuses every signal.
