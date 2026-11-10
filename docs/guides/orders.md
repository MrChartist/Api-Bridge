# Orders: paper, live, confirmation and what to do when the result is unknown

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)). On Windows, `curl` in PowerShell is something else: see [windows.md](windows.md).

This page is the whole story of an order in one place: how to send a paper order, what live trading needs, when a person has to approve
an order on this computer, how the words people type are read, how to ask for a position size instead of a quantity, how a retry
stays safe, and what `OUTCOME_UNKNOWN` means. The details of each piece are in [safety.md](safety.md), [alert-orders.md](alert-orders.md)
and the [API reference](../api/README.md); this page tells you which one to open and in what order.

The examples use the demo Bridge (`mc-bridge start --demo`), its practice account `demo-paper` and a key in `MCB_API_KEY`
([quickstart.md](quickstart.md) makes one). With your own config, use your own account id. Examples use `NSE:RELIANCE`, which
exists on every day; a futures symbol needs a live expiry date, and its value is often above the default per-order limit.

## Paper first

Every order is **paper** unless the request says `"mode": "live"` and every live opt-in below is in place. A paper order is filled
by a simulator on this computer, priced from the real market data (or the demo data in demo mode). It never reaches a broker.
Every order result says `"mode": "paper"` or `"mode": "live"`, and a request that asks for live and misses an opt-in is refused
with a clear code. It is never quietly turned into a paper order.

## Place a paper order

There is no default product and no default order type: you say both.

<!-- runs against a demo Bridge in scripts/guide-recipes.test.mjs -->
```sh
curl -s -X POST http://127.0.0.1:4300/v1/orders \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Idempotency-Key: first-order-0001" \
  -H "Content-Type: application/json" \
  -d '{"account":"demo-paper","symbol":"NSE:RELIANCE","side":"BUY","quantity":1,"product":"CNC","orderType":"MARKET"}'
```

The answer is `201` with the order: its `orderId` (`PAPER-...` for paper, `ord_...` for live), `status`, `filledQuantity`,
`avgPrice`, `mode` and a `warnings` list (for example that a market order is protected). `quantity` is in units and must be a
multiple of the lot size; or send `lots` instead (not both). A limit order also needs `price`, a stop order `triggerPrice`.

Read it back, and the list:

<!-- runs against a demo Bridge in scripts/guide-recipes.test.mjs -->
```sh
curl -s -H "Authorization: Bearer $MCB_API_KEY" "http://127.0.0.1:4300/v1/orders?limit=5"
curl -s -H "Authorization: Bearer $MCB_API_KEY" "http://127.0.0.1:4300/v1/positions?account=demo-paper"
```

An order that is still open is cancelled with `DELETE /v1/orders/{orderId}` (send an `Idempotency-Key` here too) and changed
with `PATCH /v1/orders/{orderId}` (`quantity`, `price`, `triggerPrice`, `orderType` or `validity`). A modify passes the same checks
as a new order, on the order as it would stand after the change. A cancel passes none of them except the order rate, so you can
always reduce risk, even with the kill switch on.

In Python the same is `bridge.orders.place(...)`: see [python.md](python.md). It generates the idempotency key and client order id for you.

### The words you can write

You may write the words people already use. The Bridge reads them, uses the canonical word and says so in `meta.normalised`.
Case does not matter.

| You write | The Bridge uses | Field |
|---|---|---|
| `MIS` | `INTRADAY` | `product` |
| `NRML`, `CARRYFORWARD` | `MARGIN` | `product` |
| `DELIVERY` | `CNC` | `product` |
| `CNC`, `MTF` | unchanged | `product` |
| `MKT` | `MARKET` | `orderType` |
| `SLM`, `SL_M`, `STOP_LOSS_MARKET` | `SL-M` | `orderType` |
| `STOPLOSS`, `STOP_LOSS` | `SL` | `orderType` |

`mode` is never rewritten: `"live"` must be written exactly like that. Symbols are read loosely too (`NSE:M_M` for `NSE:M&M`,
`NSE_EQ:RELIANCE`, `NSE:NIFTY1!`); [alert-orders.md](alert-orders.md#words-the-order-routes-understand) has the table, and
[symbols.md](symbols.md) explains how an instrument is written and why an expired contract is not found.

## Check an order before you send it

`POST /v1/orders/preview` takes the same body, runs every check and places nothing. It tells you the resolved symbol and lot size,
the last price, the estimated value, the margin estimate, every warning, and whether a person must confirm the order
(`requiresHumanConfirmation`, and the `ticketId` when one was opened). A refused order says why in `detail`: a price more than
3 percent from the last price, a value above the per-order limit, more lots than allowed. The limits are `safety.*` in
[config.md](config.md#safety) and the table in [safety.md](safety.md#checks-on-every-order-paper-and-live).

## Live orders

Live means a real order at a real broker, with real money. It needs **all** of these. Each one is a separate switch that only
you can turn on, from this computer:

1. `"safety": { "liveTrading": true }` in `bridge.config.json`. The environment can never turn this on.
2. The account's `"live": { "enabled": true }` in the same file. A paper account can never have it.
3. The request's source (`rest`, `webhook`, `mcp`, `cli`) listed in that account's `live.allowedSources` (`["rest"]` by default).
4. An API key with the `live` scope, made on this computer (`mc-bridge keys create --label live --scope live`).
5. `"mode": "live"` in the request.
6. A person's confirmation for orders from AI assistants and for hooks set to require it (next section).
7. An `Idempotency-Key` header or a `clientOrderId`. A live order without one is refused, so a retry cannot double it.
8. Every safety check: kill switch off, order rate, daily order count, daily loss, order value, lots, price band, market hours,
   freeze quantity.

A request that misses one is refused: `PAPER_ONLY` when the config or account is not enabled, `SCOPE_REQUIRED` when the key has no
`live` scope, `CONFIRMATION_REQUIRED` when a person has not approved it, `KILL_SWITCH_ACTIVE`, `MARKET_CLOSED`, `INVALID_ORDER` for a
failed check. [troubleshooting.md](troubleshooting.md) has the fix for each.

What else live needs, outside the Bridge:

- **A registered static IP.** Brokers accept API orders only from an address you registered with them. Data calls work from anywhere.
  [deployment.md](deployment.md) explains the options, and the readiness check on the dashboard tells you before an order fails.
- **A logged-in broker session** for the day ([accounts.md](accounts.md)).
- **A broker whose live orders the Bridge supports.** Live order mapping exists for Dhan (the only broker checked end to end with a
  live account), Zerodha and Upstox (checked against recorded samples only, with a warning on every live order). For every other
  broker a live order is refused with `CAPABILITY_UNSUPPORTED` before anything is sent (paper orders work for every broker). [BROKERS.md](../BROKERS.md) has the current table.

A sensible order of work: run the same flow on paper for as long as you like, then add the opt-ins one at a time, then send one small
live order and check it in your broker's own app. Nothing in the Bridge advises on what to trade.

## Tickets: approval stays on this computer

Some orders are not sent until a person approves them **on the computer that runs the Bridge**:

- orders from an **AI assistant**: any key made with `--client mcp`, on every route (REST included), not only on the MCP endpoint;
- orders from an alert **hook** set to require confirmation;
- paper orders from an assistant too, unless `orders.confirmPaperFromMcp` is `false`.

The steps:

1. The assistant (or hook) **previews** the order. The Bridge opens a **ticket** holding the exact order and its checks, and answers
   with a `ticketId` and `requiresHumanConfirmation: true`. Sending the order without a confirmation is refused with
   `CONFIRMATION_REQUIRED`.
2. You see it on the dashboard: **Orders, Pending confirmations**. Check the symbol, side, size, price and the checks.
3. You **confirm** (or **decline**, with an optional short reason). Confirming gives a single-use `confirmToken`, valid for
   `orders.confirmTokenTtlMs` (60 seconds), tied to that exact order, that account and the key that prepared it.
4. The assistant sends the order again with the `confirmToken`. The token is used up as the order leaves.

A ticket expires after `orders.ticketTtlMs` (60 seconds). The client that prepared a ticket can never confirm it. Confirming and
declining need an admin key **used from this computer** (the dashboard does this for you). They are not available to an AI
assistant, a webhook or any other automation, so there is no call in the Python or Node library that confirms a ticket. See
[safety.md](safety.md#declining-a-pending-confirmation) for the exact rules (what a declined ticket looks like, the audit trail) and
[mcp.md](mcp.md) for the assistant's side, including the two settings (`mcp.toolsets` with `orders`, and `mcp.orderAccounts`) that
must be in the config before an assistant has order tools at all.

## Be at a size, or send several orders

A strategy alert says "be long 3 lots", not "buy 1". `POST /v1/orders/to-target` reads the position for that symbol and product,
works out the difference and places only that. A target of `7` long, `0` flat, `-50` short. If the position cannot be read the
answer is `POSITION_UNKNOWN` and **nothing is sent**: unknown is never treated as flat.

<!-- runs against a demo Bridge in scripts/guide-recipes.test.mjs -->
```sh
curl -s -X POST http://127.0.0.1:4300/v1/orders/to-target \
  -H "Authorization: Bearer $MCB_API_KEY" -H "Idempotency-Key: target-0001" -H "Content-Type: application/json" \
  -d '{"account":"demo-paper","symbol":"NSE:INFY","targetQuantity":3,"product":"INTRADAY","orderType":"MARKET","dryRun":true}'
```

`"dryRun": true` works everything out and runs the checks without placing anything. Leave it out to place the order. Asking again
with the same key returns the first answer, even if the position has changed.

`POST /v1/orders/batch` sends up to 20 orders in one request, one after the other (a hedge and a main order). The legs do not know
about each other and nothing is rolled back. **Read `data.ok` and each leg's `status`**: the HTTP code is `201` only when every leg
was placed, `207` when some went out and some did not, `422` when none did. `POST /v1/margin/basket` estimates the margin of a basket
without placing anything. All three, with their rules, are in [alert-orders.md](alert-orders.md).

## Idempotency: a retry must not place a second order

A network can fail after the order left. Retrying then would place it twice, unless every attempt carries the same name.

- Send an **`Idempotency-Key`** header (8 to 255 letters, digits and `_ . : -`; a UUID works) on every write. The SDKs do it for you.
- The same key with the **same body** returns the first answer with the header `Idempotency-Replayed: true`. It never reaches
  the broker twice.
- The same key with a **different body** is `409 IDEMPOTENCY_KEY_REUSED`. Use a new key for a new order.
- A `clientOrderId` (your own id, letters, digits, `_` and `-`, up to 64) names the order for you: `GET /v1/orders/by-client-id/{id}`
  finds it later. It is unique per account per day.
- A live order needs the key or a `clientOrderId`. Without one it is refused.

<!-- runs against a demo Bridge in scripts/guide-recipes.test.mjs -->
```sh
curl -si -X POST http://127.0.0.1:4300/v1/orders -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Idempotency-Key: first-order-0001" -H "Content-Type: application/json" \
  -d '{"account":"demo-paper","symbol":"NSE:RELIANCE","side":"BUY","quantity":1,"product":"CNC","orderType":"MARKET"}' | grep -i "^HTTP\|^idempotency-replayed"
```

The same request as the first example, sent again, answers `Idempotency-Replayed: true`, and the paper book has one order, not two.

## Statuses

| `status` | Meaning |
|---|---|
| `pending` | Accepted by the Bridge, no answer from the broker or the simulator yet |
| `open` | Working at the broker (or resting in the paper book) |
| `trigger_pending` | A stop order waiting for its trigger price |
| `partially_filled` | Some of the quantity has traded |
| `filled` | All traded |
| `cancelled` | Cancelled |
| `rejected` | Refused by the broker, the simulator or a Bridge check; `statusMessage` says why |
| `expired` | A day order that ended with the session |
| `outcome_unknown` | The Bridge sent it and does not know whether the broker took it. See below |

A sliced order (when `orders.sliceAboveFreeze` splits an order above the exchange's freeze quantity) shows one entry per part in
`legs`. `GET /v1/orders/{orderId}` refreshes a live order from the broker. The stream sends `order.updated` events as an order changes
([streaming.md](streaming.md), [events.md](events.md)).

## OUTCOME_UNKNOWN: the broker did not say

A live order is one call to the broker. If the call times out (after `orders.liveCallTimeoutMs`, 15 seconds) or fails without a clear
answer, the Bridge cannot know whether the order exists. It answers `504 OUTCOME_UNKNOWN`, marks the order `outcome_unknown`, sends the
event `order.outcome_unknown` and **never sends it again by itself**. A Bridge that stops while an order is on its way marks it the same way
on the next start.

What the Bridge does: every `orders.reconcileIntervalMs` (3 seconds) it looks in the broker's order book for exactly one order that
matches what it sent (same instrument, side and quantity, not placed earlier than it sent it, and the same price for a priced order).
One match: the order is updated and the problem is over. None, or more than one: it keeps looking, up to `orders.reconcileGiveUpMs`
(10 minutes), and then leaves the order as `outcome_unknown`, so that nobody is told it failed when it may not have.

What you do:

1. **Do not send it again.** Not with the same key and not with a new one, until you know.
2. Look at the Bridge's record: `GET /v1/orders/{orderId}` (the `504` names the `orderId`), or `GET /v1/orders/by-client-id/{clientOrderId}`.
   It may already have moved to `open` or `filled`.
3. Open your **broker's own order book** (its app or web page). That is the truth. Check by symbol, side, quantity and time.
4. Found: nothing to do; the Bridge's record catches up. Not found after the broker's page is current: the order does not exist, and you
   may send a new order with a **new** `Idempotency-Key`. If you cannot tell, leave it, and check again after the reconcile window.

In a batch, a leg in this state shows `"status": "outcome_unknown"`; an alert shows the signal as `outcome_unknown`. The same rule
applies to both. Paper orders never have this state: the simulator answers at once.

## If something goes wrong

- **Stop everything:** the kill switch (dashboard, Safety, or `mc-bridge kill`) stops every new order at once, including orders waiting
  in the queue. Cancels still work.
- **A refusal you do not understand:** [troubleshooting.md](troubleshooting.md) lists every code with its fix.
- **What was sent:** every order step is in the audit log ([safety.md](safety.md#audit-log)), and `GET /v1/trades` lists the fills.
