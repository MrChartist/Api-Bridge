# Alerts: TradingView, signed generic hooks, ChartInk and GoCharting

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

An alert from your own code or a charting site becomes an order through a **hook**: a URL with a secret token, tied
to one account and a set of limits. Every signal goes through the same safety checks, rate limits, idempotency and
audit log as an order sent from a script. Hooks are **paper** by default.

Four sources are supported:

| Source | Sender | Credential |
|---|---|---|
| `tradingview` | TradingView alerts | URL token **plus** a passphrase inside the alert message (TradingView cannot sign) |
| `generic` | Your own scripts, bots and services | URL token **plus** an HMAC signature on every request |
| `tradingview` | TradingView strategy, indicator and price alerts | URL token only (TradingView cannot sign) |
| `chartink` | ChartInk scan alerts | URL token only (ChartInk cannot sign) |
| `gocharting` | GoCharting alerts | URL token only (GoCharting cannot sign) |

The dashboard does the same as the API below: **Integrations → Webhooks → Create webhook** (choose the source there;
it defaults to TradingView). For TradingView alerts go to [TradingView](#tradingview); the rest of this page covers
every source.

## TradingView

A TradingView alert can place a **paper** order through a `tradingview` hook. TradingView cannot sign a request, so the
hook is protected by three things together: the secret address, a **passphrase** written inside the alert message, and
(optionally) TradingView's published sender addresses. Alerts older than a limit you set are refused, a repeat of an
alert is never placed twice, and nothing the alert says can make the Bridge do more than the hook allows.

### What TradingView does (checked against TradingView's own pages)

Checked on **2026-11-09**. TradingView can change any of this; the Bridge does not depend on the items marked "not
documented".

| Fact | What TradingView says | Source |
|---|---|---|
| Two-step sign-in | Webhook alerts are only allowed when 2-factor authentication is enabled on your TradingView account | [About webhooks](https://www.tradingview.com/support/solutions/43000529348-about-webhooks/) |
| Plan | The help page does not name a plan. TradingView's pricing page lists webhook notifications as a feature of its paid plans (not verified here which plan from which tier: check the pricing page for your account) | [Pricing](https://www.tradingview.com/pricing/) |
| Ports | Only ports 80 and 443 are accepted; other ports are rejected | About webhooks |
| Time allowed | If the server takes longer than **three seconds**, the request is cancelled | About webhooks |
| Retries | **Not documented.** The page says a webhook may occasionally fail to arrive and points to the alert log's "Webhook status" column. Assume TradingView does not resend: the Bridge answers at once and never relies on a resend | About webhooks |
| Message and content type | The alert message is the request body. If it is valid JSON, TradingView sends `Content-Type: application/json`; otherwise `text/plain` | About webhooks |
| Headers and signing | The help page describes no way to add a header or sign the request. The Bridge therefore uses a passphrase inside the message | About webhooks |
| Sender addresses | 52.89.214.238, 34.212.75.30, 54.218.53.128, 52.32.178.7 | About webhooks |
| IPv6 | Not supported for webhooks | About webhooks |
| Time placeholders | `{{timenow}}` is the moment the alert fires, `{{time}}` the start of the bar; both are UTC, written like `2019-08-27T09:56:00Z`, to the nearest second | [Variables in alerts](https://www.tradingview.com/support/solutions/43000531021-how-to-use-a-variable-value-in-alert/) |
| Other placeholders | `{{ticker}}`, `{{exchange}}`, `{{close}}`, `{{interval}}`; for strategies `{{strategy.order.action}}` (buy or sell), `{{strategy.order.contracts}}`, `{{strategy.order.price}}`, `{{strategy.order.id}}`, `{{strategy.market_position}}` (long, flat or short), `{{strategy.market_position_size}}` (never negative) | Variables in alerts |
| Placeholders in Pine | In Pine's `alert()` the message is plain text you build yourself with `str.tostring()`; placeholders work in the alert dialog's Message box, not inside `alert()` or a strategy's `alert_message` | [Pine alerts](https://www.tradingview.com/pine-script-docs/concepts/alerts/) |
| Not documented | Message size limit, whether redirects are followed, the User-Agent, how the reply body is used | |

What the Bridge does about the gaps: it accepts a body of up to 16 KB, answers `202` within milliseconds (well inside
three seconds), and treats an identical alert it has already seen as a duplicate, so a resend, if TradingView ever
sends one, cannot place a second order.

### Set it up

1. **Make the hook.** Dashboard: API, Integrations, Webhooks (in the Simple view the API page is not in the menu: press Ctrl K and type its name, or choose Advanced in the account menu ([details](connect.md#simple-and-advanced-view)).), choose **TradingView**, then **Create webhook**. Copy the
   **webhook address** and the **passphrase** now; the Bridge keeps only a fingerprint of each and cannot show them
   again. (The same from the API: `POST /v1/hooks` with `"source": "tradingview"`.)
2. **Give TradingView an address on the internet.** `http://127.0.0.1:4300/...` only works on this computer. Follow
   [Exposing alerts safely](expose-alerts.md); you end with an address like `https://alerts.example.com`. Type it into
   the dashboard form (or the box under the new hook) and it shows the final address to paste. The final address is
   that address followed by the hook's path: `https://alerts.example.com/hooks/tradingview/<token>`. It must use port
   80 or 443.
3. **Create the alert in TradingView.** Open a chart, then the alarm-clock icon (or Alt+A).
   - Choose the condition (an indicator, a strategy, or a price level).
   - Notifications tab: tick **Webhook URL** and paste the address.
   - Settings tab: replace the whole **Message** box with one of the messages below, with your passphrase in it.
   - Create the alert.
4. **Check it.** In the dashboard, open **Alerts** on the hook and choose **Send a test alert**: the Bridge runs a
   realistic alert through the same checks and places a paper order. A test proves the hook works; it does not prove that
   TradingView can reach it. When a real alert fires, it appears in the same list within seconds. Hooks that have never
   heard anything, or have been quiet for days, say so there.

### The alert message

JSON is easiest. Numbers such as `{{close}}` stay **without quotes**; text placeholders have quotes. TradingView fills
the placeholders in, then sends the result as JSON.

**Indicator or price alert:**

```
{
  "symbol": "{{exchange}}:{{ticker}}",
  "side": "buy",
  "lots": 1,
  "orderType": "limit",
  "price": {{close}},
  "product": "MIS",
  "mode": "paper",
  "id": "my-alert",
  "time": "{{timenow}}",
  "passphrase": "YOUR_PASSPHRASE"
}
```

**Strategy alert** (every order fill; TradingView fills in the action, size, price and position):

```
{
  "symbol": "{{exchange}}:{{ticker}}",
  "side": "{{strategy.order.action}}",
  "lots": {{strategy.order.contracts}},
  "orderType": "limit",
  "price": {{strategy.order.price}},
  "product": "MIS",
  "mode": "paper",
  "marketPosition": "{{strategy.market_position}}",
  "positionSize": {{strategy.market_position_size}},
  "id": "{{strategy.order.id}}",
  "time": "{{timenow}}",
  "passphrase": "YOUR_PASSPHRASE"
}
```

**Plain text** also works (TradingView then sends `text/plain`): one order, side first, then the symbol and size, then
the rest in any order:

```
BUY {{exchange}}:{{ticker}} 1 @ {{close}} MIS mode=paper id=my-alert time={{timenow}} passphrase=YOUR_PASSPHRASE
```

The dashboard prints these with your real passphrase and your hook's order type and product already filled in
(`MARKET` hooks leave out `price`; a hook that fixes the product leaves out `product`).

| Field | Meaning |
|---|---|
| `symbol` | The chart ticker with its exchange, `{{exchange}}:{{ticker}}`. A name with no exchange is refused: the same name can exist on two exchanges, and the Bridge never guesses |
| `side` | `buy` or `sell` (not `long`, `short` or `exit`). Left out only when the hook fixes the side |
| `lots` or `quantity` | Not both. For futures and options `{{strategy.order.contracts}}` counts lots, so send it as `lots`. For shares, 1 lot is 1 share. If both are left out the order is one lot |
| `orderType` | `limit` or `market`; must match the hook. A LIMIT hook needs `price` |
| `product` | `CNC`, `INTRADAY`, `MARGIN`, or the broker words `MIS` (INTRADAY), `NRML` (MARGIN), `DELIVERY`, `CARRYFORWARD`. If the hook fixes a product, a different one is refused |
| `account` | Optional. Must be the hook's own account |
| `mode` | `paper` (the default when left out) or `live`. Must equal the hook's mode |
| `marketPosition`, `positionSize` | Strategy alerts. Recorded with the alert and shown in the list; the order is the buy or sell TradingView sent. The Bridge does not net positions in this version |
| `time` | `{{timenow}}`. Used for the age limit and as part of the alert's identity. Required on a live hook |
| `id` | Your alert's name or `{{strategy.order.id}}`. With `time`, `symbol` and `side` it is the alert's identity |
| `passphrase` | The hook's passphrase, in the message. Never shown again, never logged |

Any other field refuses the alert (`quantiy` is refused, not read as a one-lot order). So does an unfilled
`{{placeholder}}`, a bad number, or JSON that is not valid JSON (the reply names what is wrong).

**Pine `alert()` (indicator).** Placeholders do not work inside `alert()`: build the text yourself with
`str.tostring()`, as below. Test the time format in the Pine Editor before relying on it.

```pine
//@version=6
indicator("Breakout alert", overlay = true)
breakout = ta.crossover(close, ta.sma(close, 20))
nowUtc = str.format_time(timenow, "yyyy-MM-dd'T'HH:mm:ss", "UTC") + "Z"
if breakout
    alert('{"symbol": "' + syminfo.prefix + ':' + syminfo.ticker + '", "side": "buy", "lots": 1, "orderType": "limit", "price": ' + str.tostring(close) + ', "product": "MIS", "mode": "paper", "id": "breakout", "time": "' + nowUtc + '", "passphrase": "YOUR_PASSPHRASE"}', alert.freq_once_per_bar_close)
```

**Pine strategy.** The simplest way is the strategy template above in the alert's Message box (placeholders work there).
To send different text per order, give the order an `alert_message` and put `{{strategy.order.alert_message}}` in the
Message box; the text in `alert_message` is built in Pine like the indicator example, and an order without one sends an
empty message (which the Bridge refuses with a clear reason).

### Names: chart tickers, products

The Bridge reads the alert's symbol the way a chart writes it (the `from=chart` mapping) and refuses anything it cannot
map to exactly one instrument.

| In TradingView | Bridge symbol | Notes |
|---|---|---|
| `NSE:RELIANCE` | `NSE:RELIANCE` | cash |
| `NSE:M_M`, `NSE:BAJAJ_AUTO` | `NSE:M&M`, `NSE:BAJAJ-AUTO` | charts write `_` where the exchange writes `&` or `-` |
| `NSE:NIFTY1!`, `NSE:NIFTY2!` | the nearest and the next NIFTY future (`NFO:NIFTY-...-FUT`) | resolved from the instrument master when the alert arrives; quantity must be a multiple of the lot size, so send `lots` |
| `NSE:NIFTY261027C25000` | `NFO:NIFTY-2026-10-27-25000-CE` | option written as YYMMDD, C or P, strike (the Bridge's reading of the chart form; check it with a test alert on your symbol) |
| `NFO:NIFTY-2026-10-27-FUT` | unchanged | a full Bridge symbol is accepted as is |
| `RELIANCE` (no exchange) | refused | send `{{exchange}}:{{ticker}}` |
| `NSE:NIFTY` | refused when the order is placed | an index cannot be traded |

Products: `MIS` = `INTRADAY`, `NRML` = `MARGIN`, `CNC` = delivery. An unknown ticker is accepted by the receiver and then
**rejected after the 202** (`SYMBOL_NOT_FOUND`); it shows in the hook's Alerts list with the reason.

A continuous future (`NIFTY1!`) rolls to a new contract at expiry; a hook with `allowedSymbols` lists exact contracts and
must be updated at each roll (the create response warns 7 days ahead).

### What protects a TradingView hook

| Protection | What it does |
|---|---|
| Secret address | A 256-bit token in the URL; only its hash is stored |
| Passphrase | In the message; 128 random bits, shown once, stored hashed, compared in constant time. A wrong one is `401`; 30 wrong ones a minute from one address answer `429` |
| Sender addresses | `"sourceIpPreset": "tradingview"` accepts only the four TradingView addresses above, plus any in `allowSourceIps` and the global `hooks.allowSourceIps`. Behind a tunnel the Bridge sees the tunnel, not TradingView: set `hooks.clientIpHeader` (`cf-connecting-ip` for Cloudflare Tunnel; trusted only when the connection comes from this computer) or every alert is refused |
| Age limit | `maxAgeSec` (default 120): an alert whose `time` is older is refused as stale. One more than a minute in the future is refused too, but listed as `refused` with `cause: "future"` and the summary "Its time is ahead of this computer's clock" (not "too old"). If fresh alerts are refused, check this computer's clock |
| No double orders | An alert is identified by `id` + `time` + `symbol` + `side`: a resend is acknowledged as a duplicate and places nothing. The memory is a small file in your data folder (`hooks-seen.json`, bounded, hashes only), so a restart does not forget. The order itself carries a derived `clientOrderId` (`mcb-<hook>-<hash>`) and a stable Idempotency-Key, so even a lost memory cannot place the same alert twice that day |
| Alerts a minute | `hooks.maxSignalsPerMinute` (30) counts only alerts that passed every check, so unreadable, refused or repeated alerts never use it up. A good alert over the limit is held (queued, up to `hooks.rateWaitSec`, 60 by default) and handled when a slot frees up: TradingView does not resend a refused alert, so a `429` would lose it. The reply is `202` with `heldSeconds`, and the Alerts list shows it as queued with the reason. A held alert is still refused as too old if it is older than `maxAgeSec` by the time it runs. Past the wait, or with `rateWaitSec: 0`, the answer is `429`. A **live** hook holds only an alert it can age-check (the hook has `maxAgeSec` and the alert carries its time); a live alert without that is refused with `429` at once, because a held one would run late as a real order |
| Burst of alerts | Orders are paced by the account's order-rate cap. An alert that meets it waits (queued, up to `hooks.burstWaitSec`, 30 by default) and is placed when a slot frees up, instead of being refused; past that wait, or when the queue (`hooks.queueSize`) is full, it is refused with a clear reason and nothing is placed |
| The hook's own limits | Account, allowed symbols, lots cap, product, order type and side are fixed on the hook; everything else is refused, never trimmed |
| Paper first | Alerts are paper unless the hook is live. A paper hook refuses an alert that says `"mode": "live"` |

**Live TradingView hooks.** Everything above, plus: creating one needs the `live` scope, live enabled for the account in
the config, and one of `sourceIpPreset`/`allowSourceIps`, `requireConfirmation` or `acknowledgeUnsignedLive`; it must
have `maxAgeSec`; every alert must say `"mode": "live"` and carry its `time`; and the key that created it must still
exist. An alert without `"mode": "live"` means paper, so a live hook refuses it. With `requireConfirmation` the alert
only opens a ticket that you confirm on this computer. A test alert is always a paper order.

### Where to look when it does not work

Dashboard: **API, Integrations, Webhooks, Alerts** on the hook. Every alert that reached the hook is there with what
happened to it; wrong passphrases and refused addresses are counted at the top. The same from the API:
`GET /v1/hooks/{hookId}/signals`. The audit log (`hook.signal`, `hook.refused`) keeps the permanent record.

| What you see | Likely cause and what to do |
|---|---|
| Nothing in Alerts, and TradingView's alert log says it fired | The alert never reached the Bridge. Check the address in the alert's Webhook URL box (the path must include `/hooks/tradingview/`), that the tunnel is running and `server.publicIngress.allowedHosts` has its host, that the port is 80 or 443, and TradingView's own "Webhook status" in its alert log. Try the test alert, then `curl` the address from another network |
| "1 wrong passphrase" counted | The message has no passphrase or the wrong one. Copy the message again from the dashboard |
| "from an address that is not allowed" counted | You turned on the TradingView address list and the Bridge sees another address. Behind a tunnel set `hooks.clientIpHeader`; if TradingView changed its addresses, edit `hooks.presets.tradingview` |
| Unreadable | The reason says what: an unfilled `{{placeholder}}` (the placeholder is in a place TradingView does not fill, for example a strategy placeholder in a plain alert), invalid JSON (quote text placeholders, leave numbers bare), an unknown field, a missing exchange |
| Too old | The alert's `time` is older than `maxAgeSec`. Use `{{timenow}}`, not `{{time}}` (the bar's start). If every alert is too old, check this computer's clock |
| Not placed, reason shown | The alert arrived and the order was refused: an unknown symbol, over the lots cap, the product or order type differs from the hook, a limit price too far from the market, the kill switch, a closed market, the account cannot trade. Nothing was placed |
| Placed but you expected a live order | The hook is paper. Alerts on a paper hook never place live orders |
| Needs you | The hook requires confirmation: confirm the ticket in the dashboard (Orders, Pending confirmations) within a minute |
| TradingView says the alert timed out | The Bridge answers in milliseconds, so the delay is the tunnel or the network. Do not resend by hand: check the Alerts list first; if it arrived, it is there |

A rejected order after the `202` is announced on the Bridge's event bus as `hook.rejected` (a notifier such as Telegram
can deliver it), and is in the audit log. Wrong passphrases and refused addresses are counted and audited (at most
once a minute per hook), never announced.

### Settings for TradingView hooks

Per hook (`POST /v1/hooks`): `source: "tradingview"`, `maxAgeSec` (5 to 3600, default 120), `sourceIpPreset`
(`"tradingview"`). In the config file, section `hooks`:

| Setting | Default | Meaning |
|---|---|---|
| `clientIpHeader` | `null` | Header that carries the real sender address behind a local tunnel |
| `presets.tradingview` | built in | `{ "ips": [...], "verifiedAt": "2026-11-09", "source": "https://..." }`: the address list, shown in the dashboard and by `GET /v1/hooks/presets`; edit it when TradingView's page changes |
| `burstWaitSec` | `30` | How long an alert may wait for an order-rate slot; `0` turns waiting off |
| `rateWaitSec` | `60` | How long an alert over `maxSignalsPerMinute` is held (queued) and then handled, instead of refused; `0` refuses at once |
| `signalsKept` | `100` | Alerts remembered per hook for the Alerts list (memory only) |
| `dedupeWindowMs`, `queueSize`, `maxSignalsPerMinute` | as in the config reference | |


## 1. Create a hook

Admin key, from this computer:

```bash
curl -X POST http://127.0.0.1:4300/v1/hooks -H "Authorization: Bearer $MCB_ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "source": "generic",
  "label": "NIFTY breakout",
  "account": "paper",
  "mode": "paper",
  "product": "CNC",
  "orderType": "LIMIT",
  "maxLotsPerSignal": 2,
  "allowedSymbols": ["NSE:RELIANCE"],
  "requireConfirmation": false
}'
```

The reply holds `url` and `path` (with the token; **shown once**, only a hash is kept), for `generic` hooks a
`signingSecret` and for `tradingview` hooks a `passphrase` (also shown once), ready-to-paste `templates` for the alert message, and any `warnings`. `GET /v1/hooks` lists hooks without tokens; `DELETE /v1/hooks/{hookId}`
stops a URL at once.

| Field | Meaning |
|---|---|
| `source` | `tradingview`, `generic`, `chartink` or `gocharting` |
| `account` | The account orders go to |
| `mode` | `paper` (default) or `live`. Creating a live hook is refused unless the creating key has the `live` scope as well as `admin`, the account has `live.enabled` and `"webhook"` in its `live.allowedSources`, `safety.liveTrading` is on, and (for unsigned sources, see below) one of `allowSourceIps`, `requireConfirmation` or `acknowledgeUnsignedLive` is set |
| `side` | Fix the side (`BUY`/`SELL`). Required for ChartInk, whose alerts carry none; otherwise an alert asking for the other side is refused |
| `product`, `orderType` | Fixed per hook. `orderType` is `LIMIT`, `MARKET`, `SL` or `SL-M`. `LIMIT` and `SL` alerts must carry a `price`; `SL` and `SL-M` (stop-loss) alerts must carry a `triggerPrice`. ChartInk hooks take `LIMIT` or `MARKET` only |
| `maxLotsPerSignal` | Larger signals are refused, never trimmed |
| `allowedSymbols` | Only these canonical symbols (recommended for derivatives). Exact contracts: a dated future stops matching on expiry, so the create response warns 7 days ahead; update the hook at each roll-over |
| `requireConfirmation` | Every signal waits on the dashboard (Pending confirmations); confirming places exactly that order, once; declining ends the signal as `rejected` (`TICKET_REJECTED`) and nothing is sent |
| `allowSourceIps` | Optional allowlist of sender IP addresses or IPv4 CIDR blocks (for example the addresses your alert service publishes) |
| `sourceIpPreset` | `"tradingview"`: also accept alerts only from TradingView's published addresses (the editable list in the config, see [TradingView](#tradingview)) |
| `maxAgeSec` | Refuse an alert whose own `time` is older than this many seconds (5 to 3600). TradingView hooks default to 120 and a live one must have it; for other sources it applies when the alert carries a `time` written like `2026-11-09T09:56:00Z` |
| `acknowledgeUnsignedLive` | `true` to accept that a live ChartInk, GoCharting or TradingView hook is protected by its URL (and passphrase) alone (audited and shown on the hook) |

**Unsigned live hooks: the trade-off.** ChartInk, GoCharting and TradingView cannot sign their alerts, so the URL
token is the only credential, and that URL lives in your charting account, browser history and tunnel logs. Replay
protection is only the dedupe window. For `"mode": "live"` the Bridge therefore insists on at least one extra guard:
`allowSourceIps` or `sourceIpPreset` (best, when the service publishes its sending addresses), `requireConfirmation: true` (you approve each
order), or an explicit `acknowledgeUnsignedLive: true`. Signed `generic` hooks (HMAC with a timestamp) need none of
these. The key that created a live hook is recorded on it; revoke that key and the hook stops accepting alerts.

## 2. Make the URL reachable

TradingView, ChartInk and GoCharting post from the internet (TradingView only to port 80 or 443), and so does any script running
elsewhere. The full walk-through, with a safe tunnel, is [Exposing alerts safely](expose-alerts.md); in short: Turn on the **public ingress** listener, which serves `/hooks/*` and nothing else, and run your own tunnel
to it:

```json
"server": { "publicIngress": { "enabled": true, "host": "127.0.0.1", "port": 4301, "allowedHosts": ["hooks.example.com"] } }
```

```bash
cloudflared tunnel --url http://127.0.0.1:4301     # or a named tunnel with your own host name
```

`mc-bridge expose alerts` does this (and the host list, the client-address header and a TradingView sender allowlist) in one
step and checks the result: see [expose-alerts.md](expose-alerts.md).

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
`price` (required for `LIMIT` and `SL` hooks), `triggerPrice` (required for `SL` and `SL-M` stop-loss hooks), `orderType`, `product`, and `id` (+ optional `time`). Reusing an `id` the same
day never creates a second order. When the body also carries `time`, the identity is `id` **and** `time`: a sender that
reuses one id every day (a strategy order id such as `Long`) still gets a new order for each new time.

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
full queue answers `429` with a message that says so (never unbounded); each hook is limited to
`hooks.maxSignalsPerMinute`, which counts only alerts that passed every check (a malformed, refused or repeated alert
does not use it up); an alert over it is held for up to `hooks.rateWaitSec` (60 s) and then handled, because TradingView
does not resend a refused alert. The kill switch refuses every signal. An order that meets the account's order-rate cap
waits for a free slot (`hooks.burstWaitSec`) instead of being refused.

`GET /v1/hooks/{hookId}/signals` lists the recent alerts of a hook (newest first, at most `hooks.signalsKept`, memory
only) with an `outcome` (`placed`, `queued`, `awaiting_confirmation`, `duplicate`, `stale`, `rejected`, `refused`,
`failed`, `outcome_unknown`, `dropped`), a plain-words `summary` (a placed alert says how much and at what price: "Placed a paper order: BUY 2 lots NSE:M&M at 2900"), the reason and the order id. A `refused` entry has `cause`: `future` (its time is ahead of this computer's clock), `policy` (against the hook's own rules, such as a live alert on a paper hook) or none (it could not be read). Counts also
include wrong passphrases and refused addresses (counted, never listed, never with a body).
`POST /v1/hooks/{hookId}/test` sends a realistic (or your own pasted) alert through the real pipeline as a **paper** order
and answers with the outcome. Alerts refused at the door (unreadable, stale, queue full) and rejected orders are announced on the event bus as
`hook.rejected` for notifiers, and refusals are audited as `hook.refused` (without the body, at most once a minute per hook and kind).
