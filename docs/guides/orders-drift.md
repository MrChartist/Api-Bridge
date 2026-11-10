# Order-book check

The Bridge keeps its own record of the live orders it sent. Your broker keeps the real order book. They can disagree: you
cancel an order in the broker app, an order fills while the computer was asleep, or an order was placed outside the Bridge.
The order-book check compares the two now and then and tells you when they differ.

It is **read-only**. It never changes the Bridge's record, and it never places, modifies or cancels an order. What to do
about a difference is your decision, in the broker app.

## When it runs

Only when all of these hold:

- live trading is switched on (`safety.liveTrading`) and at least one account has live orders enabled;
- that account is logged in;
- the market is open or in pre-open (NSE hours from the shipped calendar), unless you set `marketHoursOnly` to `false`.

Paper accounts are never checked. It reads the broker's order book once per account, at most every 5 minutes, through the
rate-limit scheduler at the lowest priority, and only when the account's budget has room. A read for a price or an order
always goes first.

```json
"orders": {
  "drift": { "enabled": true, "intervalMinutes": 5, "marketHoursOnly": true }
}
```

`intervalMinutes` can be 1 to 240. Set `enabled` to `false` to turn the check off.

## What it reports

| Difference | Meaning |
|---|---|
| `closed_at_broker` | The Bridge has the order open; the broker shows it complete, cancelled, rejected or expired. The Bridge's record is behind. |
| `missing_at_broker` | The Bridge has the order open; the broker's order book has no such order. |
| `status_mismatch` | Both have the order, with different states. |
| `quantity_mismatch` | Both have the order, with a different quantity. |
| `fill_mismatch` | Same state, different filled quantity. |
| `unknown_at_broker` | An open order at the broker that the Bridge did not place (usually your broker app). |
| `outcome_unknown` | The Bridge does not know whether it placed the order. The broker's orders that fit it are listed in `brokerMatches`. |

Finished orders at the broker that the Bridge did not place are counted (`externalClosed`) but are not a difference, so
orders you place by hand are not nagged about.

An unknown outcome (`OUTCOME_UNKNOWN`) is matched by instrument, side, quantity, price and time. One match means the order
is probably the one in the list; confirm it in your broker app. No match means the broker shows nothing that fits: the order
may not have been placed. Several matches mean the Bridge cannot tell which is yours.

## Where you see it

- `GET /v1/orders/drift` (read scope): the last result. No broker call. `?account=` limits it to one account; a key sees only
  its own accounts.
- `GET /v1/readiness`: the `orderBook` item, a summary with a link to the route above.
- The event `orders.drift` (read scope) for event streams and webhooks: sent when the set of differences for an account
  changes, and once more when they are gone. See [events](events.md).
- A Telegram line when differences appear (switch it off under Notifications, "The Bridge and your broker disagree about an
  order").
- The Safety page: the "Order book" card.

```bash
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:4300/v1/orders/drift
```

`state` is one of `ok` (the books match), `drift`, `unavailable` (the order book could not be read), `idle` (not checking
now: `paused.reason` says why), `waiting` (no check yet) or `off`.

## What it does not do

It does not fix the Bridge's record, cancel an order, send an order or retry anything. The Bridge's own job for unknown
outcomes keeps working as before. If the check says an order is closed at the broker, the next time you read that order
through the API the Bridge updates it from the broker as it always did.
