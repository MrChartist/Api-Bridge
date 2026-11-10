# TradingView alerts in ten minutes

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)). On Windows `curl` in PowerShell is something else: see [windows.md](windows.md).

This is the short path from nothing to a TradingView alert that places a **paper** order, with the exact messages to paste and the checks that tell
you it works. The full reference (every field, every protection, going live, all the ways it can fail) is [webhooks.md](webhooks.md); the part about
reaching the Bridge from the internet is [expose-alerts.md](expose-alerts.md).

An alert never decides anything by itself: it is a request to the Bridge, which applies the same safety checks, rate limits, idempotency and audit log
as an order sent from a script. A TradingView hook is paper unless you make it live with every opt-in ([orders.md](orders.md#live-orders)). An alert
cannot approve an order: approval stays on this computer.

## What TradingView needs

From TradingView's own help pages (read on 2026-11-09 and listed with their addresses in [webhooks.md](webhooks.md#what-tradingview-does-checked-against-tradingviews-own-pages)):
webhook alerts need two-step sign-in on your TradingView account and a plan that includes webhook notifications (check TradingView's pricing page for
yours), the address must use port 80 or 443, the Bridge must answer within three seconds (it answers in milliseconds), and TradingView cannot add a
header or sign a request. That is why a TradingView hook uses a secret address **and** a passphrase inside the message.

## 1. Make a paper hook, and test it without TradingView

You need an admin key from this computer in `MCB_ADMIN_KEY` ([quickstart.md](quickstart.md)). This makes the hook, then sends it a test alert through the
real pipeline. The test always places a **paper** order and needs no internet address:

<!-- runs against a demo Bridge in scripts/guide-recipes.test.mjs -->
```sh
HOOK=$(curl -s -X POST http://127.0.0.1:4300/v1/hooks \
  -H "Authorization: Bearer $MCB_ADMIN_KEY" -H "Idempotency-Key: tv-hook-0001" -H "Content-Type: application/json" \
  -d '{"source":"tradingview","label":"TradingView paper","account":"demo-paper","orderType":"MARKET","product":"INTRADAY","sourceIpPreset":"tradingview"}')
HOOK_ID=$(echo "$HOOK" | grep -o '"id":"hk_[a-z0-9]*"' | head -1 | cut -d'"' -f4)
echo "hook: $HOOK_ID"
curl -s -X POST "http://127.0.0.1:4300/v1/hooks/$HOOK_ID/test" \
  -H "Authorization: Bearer $MCB_ADMIN_KEY" -H "Content-Type: application/json" -d '{}'
```

Use your own account id instead of `demo-paper`. The answer to the first call holds, **shown once**, the hook's `url` (the secret address), its `passphrase` and
ready-to-paste `templates`; copy them now, because the Bridge keeps only a fingerprint of each. The answer to the second says
`"outcome": "placed"` and `Placed a paper order: BUY 1 lot NSE:RELIANCE at ...` when the hook works. A test does not prove that TradingView can reach the hook.

The dashboard does the same: **Integrations, Webhooks, Create webhook, TradingView** (in the Simple view press Ctrl K and type the page name, or choose
Advanced in the account menu: [connect.md](connect.md#simple-and-advanced-view)), then **Alerts, Send a test alert**.

The settings of a hook (all fixed on the hook; an alert cannot change them): `account`, `allowedSymbols` (empty means any), `maxLotsPerSignal` (1 by default;
a bigger alert is refused, never trimmed), `product`, `orderType` (`LIMIT` or `MARKET`), `side`, `maxAgeSec` (120 by default), `sourceIpPreset`,
`requireConfirmation` and `mode` (paper by default).

## 2. Let TradingView reach it

`http://127.0.0.1:4300/...` works only on this computer. Follow [expose-alerts.md](expose-alerts.md): `mc-bridge expose alerts` sets up a second, narrow
listener that serves **only** alert routes (never the dashboard or the API), and you end with an address such as
`https://alerts.example.com/hooks/tradingview/<token>`. `mc-bridge expose check` tests that only the intended routes answer. Do not put a tunnel in front
of the main port.

### TradingView's sender addresses

`"sourceIpPreset": "tradingview"` makes the hook accept only requests from the addresses TradingView says it sends webhooks from. These are built into the Bridge,
with the date they were read and where from, and you can see them in `GET /v1/hooks/presets`:

- `52.89.214.238`
- `34.212.75.30`
- `54.218.53.128`
- `52.32.178.7`

Read on 2026-11-09 from <https://www.tradingview.com/support/solutions/43000529348-about-webhooks/>. IPv6 is not used for webhooks. TradingView can change the list at
any time. Check that page now and then; when it differs, put the new list in `bridge.config.json` and restart ([config.md](config.md#hooks)):

```json
{ "hooks": { "presets": { "tradingview": { "ips": ["52.89.214.238", "34.212.75.30", "54.218.53.128", "52.32.178.7"], "verifiedAt": "2026-11-09", "source": "https://www.tradingview.com/support/solutions/43000529348-about-webhooks/" } } } }
```

**Behind a tunnel** the Bridge sees the tunnel's address, not TradingView's, and would refuse every alert. Set `hooks.clientIpHeader` (`cf-connecting-ip` for a
Cloudflare Tunnel); it is trusted only when the connection itself comes from this computer.

## 3. The alert in TradingView

Open a chart, then the alarm-clock icon (or Alt+A). Choose the condition. On the **Notifications** tab tick **Webhook URL** and paste the hook's address. On the
**Settings** tab replace the whole **Message** box with one of these, with `YOUR_PASSPHRASE` replaced by the passphrase from step 1. The dashboard prints them with
your real passphrase, your hook's order type and product already filled in.

**Indicator or price alert** (JSON; numbers such as `{{close}}` have no quotes):

```text
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

```text
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

**Plain text** (TradingView then sends `text/plain`): one order, side first, then the symbol and size, then the rest in any order:

```text
BUY {{exchange}}:{{ticker}} 1 @ {{close}} MIS mode=paper id=my-alert time={{timenow}} passphrase=YOUR_PASSPHRASE
```

Things that matter in the message:

- **`time` is `{{timenow}}`**, the moment the alert fires. `{{time}}` is the start of the candle and can be hours old, and the Bridge refuses an alert older than
  `maxAgeSec`. An alert more than a minute in the future is refused too: check this computer's clock.
- **`symbol` is `{{exchange}}:{{ticker}}`.** A name with no exchange is refused, because the same name can exist on two exchanges. `NSE:M_M` is read as `NSE:M&M`;
  `NSE:NIFTY1!` is the nearest NIFTY future (send `lots`, the quantity must be a multiple of the lot size). An index cannot be traded. [symbols.md](symbols.md).
- **`lots` or `quantity`, not both.** For shares 1 lot is 1 share.
- **`id`** should be unique per alert. The same `id`, `time`, `symbol` and `side` seen again is acknowledged as a duplicate and places nothing, so a resend never
  doubles an order.
- **`mode`** `"paper"` (or left out) on a paper hook. A paper hook refuses an alert that says `"live"`.
- **Pine's `alert()`** sends plain text you build with `str.tostring()`; the placeholders above work in the alert dialog's Message box, not inside `alert()` or a
  strategy's `alert_message`.

## 4. Is it working?

| Look at | What it tells you |
|---|---|
| The hook's **Alerts** list (dashboard), or `GET /v1/hooks/{hookId}/signals` | Every alert the Bridge received, with its outcome: `placed`, `duplicate`, `stale`, `rejected`, `refused`, `queued` (held for a free slot), `awaiting_confirmation`, `outcome_unknown`, and the reason in words |
| TradingView's alert log, "Webhook status" column | Whether TradingView sent it and what answer it got. TradingView does not document retries: assume it does not resend |
| `GET /v1/orders` | The paper order. Its `source` is `webhook` and its `clientOrderId` has the form `mcb-<hook>-<hash>` |
| `mc-bridge expose check` | That the narrow listener serves only the alert routes |

| An alert is refused because | The fix |
|---|---|
| `401`: a wrong or missing passphrase | Paste the passphrase from step 1. 30 wrong ones a minute from one address answer `429` |
| "from an address that is not allowed" | The sender-address list is on and the Bridge sees another address: set `hooks.clientIpHeader` behind a tunnel, or update `hooks.presets.tradingview` |
| Too old (stale) or ahead of the clock | Use `{{timenow}}`; check this computer's clock; raise `maxAgeSec` only if you know why |
| Unreadable | An unfilled `{{placeholder}}` (a strategy placeholder in a plain alert), invalid JSON (quote text, leave numbers bare), an unknown field, a missing exchange |
| Symbol not found | The ticker is not in your broker's list. It is rejected after the `202`, so it shows in the Alerts list, not in TradingView |
| Over the hook's limits | More lots than `maxLotsPerSignal`, a symbol not in `allowedSymbols`, a product or order type the hook does not allow: refused, never trimmed |
| `429` | More than `hooks.maxSignalsPerMinute` good alerts a minute: they are held up to `hooks.rateWaitSec` and handled; past that, refused |

Every outcome is in the audit log ([safety.md](safety.md#audit-log)). A held or refused alert is not lost silently: it is listed with its reason.

## 5. Live

A live TradingView hook needs everything in [orders.md](orders.md#live-orders) and [webhooks.md](webhooks.md#what-protects-a-tradingview-hook): a key with the `live`
scope, live enabled for the account, `"webhook"` in the account's `live.allowedSources`, one of the sender-address list, `requireConfirmation` or an explicit
`acknowledgeUnsignedLive`, a `maxAgeSec`, and `"mode": "live"` plus `time` in every alert. With `requireConfirmation` the alert only opens a ticket that you confirm
on this computer. Automated live orders are also refused while the readiness check says the account cannot trade ([deployment.md](deployment.md)). A test alert is always paper.
