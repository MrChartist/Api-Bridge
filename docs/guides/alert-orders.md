# Orders for alerts, sheets and scripts

Strategy alerts, spreadsheets and Telegram bots do not say "buy 1 share". They say "be long 3 lots", "send these two
orders together", "is the market open?" and "can I afford this?". This guide covers the routes that answer those, and
the small conveniences that let people type what they are used to. Every route here is in
[openapi.yaml](../openapi.yaml). Examples use the demo Bridge on port 4300 and a key in `$KEY`.

Everything below keeps the rules of [safety.md](safety.md): paper unless you ask for live, every order passes the same
checks as `POST /v1/orders`, and an AI assistant's order still needs a person to confirm it on this computer.

## Words the order routes understand

On `POST /v1/orders`, `/v1/orders/preview`, `/v1/orders/to-target`, `/v1/orders/batch` and `/v1/margin/basket` you can write
the words people already use. The Bridge reads them, uses the canonical word and tells you in `meta.normalised`.

| You write | The Bridge uses | Field |
|---|---|---|
| `MIS` | `INTRADAY` | `product` |
| `NRML`, `CARRYFORWARD` | `MARGIN` | `product` |
| `DELIVERY` | `CNC` | `product` |
| `CNC`, `MTF` | unchanged | `product` |
| `MKT` | `MARKET` | `orderType` |
| `SLM`, `SL_M`, `STOP_LOSS_MARKET` | `SL-M` | `orderType` |
| `STOPLOSS`, `STOP_LOSS` | `SL` | `orderType` |
| `buy`, `sell`, `limit`, `day`, `ioc` | upper case | `side`, `orderType`, `validity` |

Case does not matter. A word that is not on this list is refused as before. `mode` is never rewritten: `"live"` must be
written exactly like that.

```bash
curl -X POST http://127.0.0.1:4300/v1/orders -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"account":"demo-paper","symbol":"NSE:M_M","side":"BUY","quantity":1,"product":"MIS","orderType":"MARKET"}'
# 201  "symbol":"NSE:M&M"  "product":"INTRADAY"  meta: "normalised":[{"field":"product","from":"MIS","to":"INTRADAY"}]
```

Symbols are read more loosely too. These all resolve in every route that takes a symbol:

| You write | The Bridge uses |
|---|---|
| `NSE:M_M`, `NSE:BAJAJ_AUTO` (chart tools spell `M&M` and `BAJAJ-AUTO` this way) | `NSE:M&M`, `NSE:BAJAJ-AUTO` |
| `NSE_INDEX:NIFTY 50`, `NSE:NIFTY BANK` | `NSE:NIFTY`, `NSE:BANKNIFTY` |
| `NSE_EQ:RELIANCE`, `NSE:RELIANCE-EQ` | `NSE:RELIANCE` |
| `NSE_FO:NIFTY-2026-11-24-FUT` | `NFO:NIFTY-2026-11-24-FUT` |
| `NSE:NIFTY1!` (chart continuous future) | the nearest `NFO:NIFTY-<expiry>-FUT` |

A `_` is turned into `&` or `-` only when the result is a real instrument in your broker's list. If two different
instruments could be meant, the answer is `AMBIGUOUS_SYMBOL`, not a guess.

## Check a symbol: `/v1/symbols/validate` and `/v1/symbols/resolve`

For a sheet or an alert author who wants to see what the Bridge will do with what they typed.

```bash
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/symbols/validate?symbol=NSE:BAJAJ_AUTO"
```
```json
{"data":{"input":"NSE:BAJAJ_AUTO","valid":true,"symbol":"NSE:BAJAJ-AUTO","exchange":"NSE","kind":"EQ","lotSize":1,"tickSize":0.1,
 "tradable":true,"normalised":true,"rules":["chart name NSE:BAJAJ_AUTO read as NSE:BAJAJ-AUTO"],"confidence":"exact"}}
```

`validate` never fails for a bad symbol. It answers `"valid": false` with `code` (`SYMBOL_NOT_FOUND`,
`AMBIGUOUS_SYMBOL`) and the closest `candidates`. `POST /v1/symbols/validate` with `{"items":[{"symbol":"..."}, ...]}`
checks up to 200 in one call. An index shows `"tradable": false`.

`GET /v1/symbols/resolve?q=...&exchange=...&explain=1` answers one instrument for free text such as `Reliance`,
`NSE:M_M` or `NIFTY BANK`, with the rule it used and ranked `candidates`, each with the reason it matched. It never guesses:

- a bare name resolves to the cash or index instrument when exactly one has that name;
- two with the same name (the same share on NSE and BSE) is **409 `AMBIGUOUS_SYMBOL`** with the candidates in the
  problem body. Send `exchange=NSE` or the full symbol;
- a name that is only a prefix is **404 `SYMBOL_NOT_FOUND`** with the closest names;
- a future or option is never picked from a bare name; send its full symbol.

```bash
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/symbols/resolve?q=RELIANCE&kind=FUT&limit=3"
# 409  {"code":"AMBIGUOUS_SYMBOL","candidates":[{"symbol":"NFO:RELIANCE-2026-11-23-FUT","lotSize":525,"reason":"exact name match, future on NFO"}, ...],
#       "rule":"3 contracts carry this name; send the full contract symbol"}
```

## Be at a target size: `POST /v1/orders/to-target`

A strategy alert says "be long 3 lots", not "buy 1". This route reads the position, works out the difference and
places only that.

```bash
curl -X POST http://127.0.0.1:4300/v1/orders/to-target -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: alert-0001" -H "content-type: application/json" \
  -d '{"account":"demo-paper","symbol":"NSE:INFY","targetQuantity":7,"product":"MIS","orderType":"MARKET"}'
```

| Field | Meaning |
|---|---|
| `targetQuantity` or `targetLots` | The size to end at, signed: `7` long, `0` flat, `-50` short. Send one of them. |
| `account`, `symbol`, `product`, `orderType`, `price`, `triggerPrice`, `validity`, `tag`, `clientOrderId`, `mode` | As on `POST /v1/orders`. Paper unless `"mode": "live"`. |
| `dryRun` | `true`: work it out and run every check, place nothing. The reply has the `preview`. |
| `openOrders` | `"refuse"` (default) or `"ignore"`, see below. |

The reply: `currentQuantity`, `targetQuantity`, `delta`, `action` (`BUY`, `SELL` or `NONE`), `placed`, the `order` (or
`null`) and, for a dry run, the `preview`. `201` when an order was placed, `200` when nothing was needed.

```json
{"data":{"account":"demo-paper","symbol":"NSE:INFY","product":"INTRADAY","mode":"paper","currentQuantity":0,"targetQuantity":7,
 "delta":7,"action":"BUY","dryRun":false,"placed":true,"order":{"orderId":"PAPER-20261109-000002","side":"BUY","quantity":7,"status":"filled"}}}
```

Rules that keep it safe:

- **An unknown position places nothing.** If the positions cannot be read, or a row cannot be matched with certainty,
  the answer is `503 POSITION_UNKNOWN` ("retryable": no order was sent, so it is safe to send again). Unknown is never
  treated as flat. A live position row the Bridge cannot name but whose text contains your symbol also counts as unknown.
- **The position is for this symbol and this product.** An `INTRADAY` target is measured against the `INTRADAY` position.
  Positions in other products are listed in `otherProducts`, never added.
- **Live delivery** (`CNC`, `MTF`): shares can appear in both today's positions and the holdings. If both show the
  symbol, the answer is `POSITION_UNKNOWN`, because the Bridge cannot tell whether they are the same shares. If only one
  shows it, that one is used.
- **Open orders.** An order of the Bridge in the same symbol and product that is still open (a MARKET or LIMIT order, or
  a partly filled one) could change the position when it fills, so the request is refused with `409 STATE_CONFLICT`
  unless you send `"openOrders": "ignore"`. A resting stop (`SL`, `SL-M`) does not block. Only the Bridge's own orders
  are known; an order you placed in the broker's app is not.
- **Same gates as `POST /v1/orders`.** The delta order goes through the same order service: kill switch, safety limits,
  price and tick checks, live opt-ins, order-rate caps, market orders policy, and the human confirmation for AI assistants
  (use `dryRun` to open the ticket, then send again with the `confirmToken`). There is no other way in.
- **Idempotency.** The `Idempotency-Key` (or `clientOrderId`) covers the whole request. Sending it again with the same
  body returns the first answer (with `Idempotency-Replayed: true`), even if the position has changed since, including
  "nothing to do". The same key with another body is `409 IDEMPOTENCY_KEY_REUSED`. Two requests for the same account,
  symbol and product are handled one after the other. The record is kept in memory for 24 hours; after a restart the
  order inside is still protected by its own saved key. A live request needs the key or a `clientOrderId`.
- A move through zero (long 3 to short 2) is one order of 5.

## Several orders at once: `POST /v1/orders/batch`

A convenience for an alert that needs two legs (a hedge and a main order). It is not a strategy engine: the legs do not
know about each other, nothing is rolled back, and a leg that is refused does not undo the others.

```bash
curl -X POST http://127.0.0.1:4300/v1/orders/batch -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: batch-0001" -H "content-type: application/json" \
  -d '{"account":"demo-paper","orders":[
        {"symbol":"NSE:INFY","side":"BUY","quantity":1,"product":"MIS","orderType":"MARKET"},
        {"symbol":"NSE:NOPE","side":"BUY","quantity":1,"product":"MIS","orderType":"MARKET"}]}'
```
```json
{"data":{"ok":false,"summary":{"total":2,"placed":1,"rejected":1,"outcomeUnknown":0,"skipped":0},"results":[
  {"index":0,"ok":true,"status":"placed","orderId":"PAPER-20261109-000003","idempotencyKey":"batch-0001:0","order":{"...":"..."}},
  {"index":1,"ok":false,"status":"rejected","error":{"code":"SYMBOL_NOT_FOUND","status":404,"retryable":false,"message":"..."}}]}}
```

- Up to **20** orders. Each is an ordinary order body without `account` (the account is at the top; a leg may repeat it).
  A batch-level `mode` applies to legs that do not set their own.
- Legs run one after another in the order sent (`"legOrder": "buys-first"` sends the buys first). **`results` is always in
  the order sent**, one entry per leg, each with its own `status`: `placed`, `rejected`, `outcome_unknown` (check the order
  book before sending it again) or `skipped`.
- **Nothing is hidden in the status code.** `201` only when every leg was placed. `207` when at least one leg went out (or
  may have) and at least one did not. `422` when no leg went out. `data.ok` and `data.summary` say the same. A client that
  accepts any 2xx must read `data.ok`.
- `"stopOnError": true` stops after the first leg that did not go out; the rest show `skipped`.
- **Idempotency per leg:** leg `i` uses your `Idempotency-Key` plus `:i` (`batch-0001:1`), so a leg cannot be placed twice even
  if the whole request is retried. The same key and body returns the first answer. A batch where nothing went out can be
  retried with the same key; one where something went out is answered from the record, so to retry only the failed legs use a
  new key. A live leg needs the key (or its own `clientOrderId`).
- Every leg passes the same checks as a single order, including the kill switch and the live opt-ins, one leg at a time.
  More than 20 legs, no legs or a body that is not a list are refused before anything is sent.

## What will it cost: `POST /v1/margin/basket`

```bash
curl -X POST http://127.0.0.1:4300/v1/margin/basket -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"positions":[{"symbol":"NFO:NIFTY-2026-11-23-FUT","side":"BUY","lots":1,"product":"NRML"}]}'
```
```json
{"data":{"total":177192.01,"span":144975.28,"exposure":32216.73,"hedgeBenefit":0,"source":"paper-model","account":"demo-paper","legs":1,
 "note":"Paper model: approximate, not the exchange's SPAN."}}
```

Up to 50 positions; all figures are JSON numbers in rupees; a read-only key may call it; nothing is placed.
`source` says where the figure came from:

- `broker`: the broker's own calculator, used when the account's adapter has the optional `fetchBasketMargin(creds, legs)`.
  No shipped adapter has it yet, so this is for adapters to add (needs a check against each broker's own documentation).
- `paper-model`: the paper engine's approximate portfolio model ([paper-margin.md](paper-margin.md)), for the basket on its own with
  hedges between its legs counted. It is **not** the exchange's SPAN, and `note` says so. When the broker call failed, the
  note says that too.

`account` is optional: without it a paper account your key may use is taken. `hedgeBenefit` is what the legs would need
alone minus `total`. The compat `margin` call (`/api/v1/margin`) answers from the same calculation.

## Is the market open: `/v1/calendar/*`

Read-only answers from the holiday list shipped with the Bridge (NSE and BSE circulars). NFO follows NSE, BFO follows BSE.
MCX and CDS have their own hours that the list does not hold (`422`).

```bash
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/calendar/status?exchange=NSE"
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/calendar/sessions?exchange=NSE&date=2026-11-10"
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/calendar/holidays?exchange=NSE&year=2026"
```

- `status`: `open`, `pre-open` or `closed`, the reason (a holiday is named), when it closes or opens, and the next open
  (a special session such as Muhurat trading counts). `closedBecause` is `weekend`, `holiday`, `before-open` or `after-close`.
- `sessions`: whether a date is a trading day, why not, pre-open, open and close in IST, a special session if any, and the
  neighbouring trading days.
- `holidays`: every row with its own `verified` flag, and the special sessions of the year.

**Verified or not is said in every answer** (`calendar.verified`, `calendar.note`). The list is dated (`calendar.asOf`) and
covers the years in `calendar.coveredYears`. A date outside them is treated as an ordinary weekday and marked
`covered: false`, `verified: false` with a plain note: it is "no data", not "no holiday". The pre-open, open and close times
are the standard hours and are marked `sessionTimes.verified: false`. This is the calendar's answer, not the exchange's live
state: a halt or an unlisted closure is not in it. Check the exchange's circular before relying on a date.

### For spreadsheet authors

`server/bridge/market/calendarView.mjs` exports `createCalendarView({ now })`. Its `cell(exchange, field)` returns one plain
value for a cell: `status`, `reason`, `opensAt`, `closesAt`, `nextOpen`, `isTradingDay`, `holiday` or `verified`. Times are IST
text, and a value that does not exist is an empty string, never a guess. A spreadsheet route can call it and answer with
the value as `text/plain`, like the other `/xl` routes.
