# Troubleshooting

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

Find what you see, then read the cause and the fix. The first part is by symptom, the second by the error `code` the Bridge
returns. Every error has a stable `code`, so switch on `code`, never on the wording of `detail`. The list of all codes is in
[the error codes](../api/errors.md) and in the dashboard (Developers, Errors). The same words are in the Bridge itself:
`GET /v1/errors`.

When you report a problem, include the `requestId` from the error, what `mc-bridge doctor` prints, and the Bridge version.
Never paste a key.

## By what you see

| You see | Likely cause | What to do |
|---|---|---|
| `mc-bridge: command not found` (or "is not recognized") | In a git checkout the command is not on your PATH | Use `npm run bridge -- <command>`, or `node bin/mc-bridge.mjs <command>`, in the repository folder ([why](README.md#running-mc-bridge)) |
| Running the project name through npx downloads something unexpected | The name `mc-bridge` on npm belongs to an unrelated package; this project is not published there | Do not run it through npx. Use the installed command or `npm run bridge --` |
| `curl: ... Invalid ... -s` or `Invoke-WebRequest : A parameter cannot be found` on Windows | `curl` is an alias of `Invoke-WebRequest` in Windows PowerShell 5.1 | Use `Invoke-RestMethod` or `curl.exe` ([windows.md](windows.md)) |
| "Port 4300 is already in use" | Another program, or a second Bridge, has the port | Close it, or use `MCB_PORT=4301` and set `MCB_BRIDGE_URL` to match ([quickstart](quickstart.md#port-already-in-use)) |
| "The Bridge is already running ..." | One Bridge per data folder | Use that one: `mc-bridge open` ([operations.md](operations.md#one-bridge-per-data-folder)) |
| Errors about Node or syntax at start | Node.js older than 22.12 | Check `node -v` and install a current Node.js ([quickstart](quickstart.md#node-version)) |
| The dashboard asks you to sign in | The sign-in link works once and a tab forgets its key when closed | `mc-bridge open` prints a fresh link ([quickstart](quickstart.md#the-dashboard-asks-you-to-sign-in)) |
| A guide says "API > Keys" and the dashboard has no API entry | The Simple view hides the API page | Press Ctrl K and type *Keys*, or choose Advanced in the account menu ([connect.md](connect.md#simple-and-advanced-view)) |
| The dashboard page is blank | The page needs the Bridge on this computer; a browser extension or an old cached page can interfere | Reload with Ctrl+F5, open the dashboard in a private window, and check `mc-bridge doctor` |
| "DEMO DATA" or `demo: true` everywhere | The Bridge is in demo mode: sample prices | Expected with `--demo`. Add a broker account to see real prices ([accounts.md](accounts.md)) |
| No prices, `SESSION_EXPIRED`, an account marked "needs login" | The broker login ended (most brokers need a fresh login every day) | Dashboard, Accounts, Log in, or `mc-bridge accounts connect <accountId>` ([accounts.md](accounts.md#2-log-in)) |
| A price is old, `stale: true`, or `class` is `delayed` or `eod` | The market is closed, the feed is silent, or the answer came from a free delayed source | Read `freshness` on the answer: `source`, `ageMs`, `class`. Delayed and end-of-day data is never used for orders ([sources.md](sources.md)) |
| An order is refused with `PAPER_ONLY` or `ORDER_GATE_CLOSED` | A live order is missing one of the live opt-ins | The list is in [safety.md](safety.md#live-orders-need-every-one-of-these). Paper orders need none of them |
| `MARKET_CLOSED` | The exchange is closed (weekend, holiday, outside hours) | `GET /v1/calendar/status` says when it opens next |
| `LOOPBACK_ONLY` through a tunnel | Admin actions never work from outside this computer | Do it on the computer running the Bridge ([expose-alerts.md](expose-alerts.md)) |
| An Excel cell shows `#NAME?` or a status `NO ANSWER` | An old workbook, a wrong address or key | [excel-sheets.md](excel-sheets.md#when-something-is-wrong) |
| `?key=` answers 401 "may not be sent in a web address" | The key was made without `--allow-query` | Make a read key with `keys create --scope read --allow-query --expires 90d` ([excel-sheets.md](excel-sheets.md#the-key)) |

## By error code

Each example below is a real answer from a demo Bridge, trimmed to the fields that matter. All error answers are
`application/problem+json` with `status`, `code`, `detail`, `retryable` and `requestId`.

### UNAUTHENTICATED (401)

No key, a wrong or expired key, or a revoked one.

```text
401  {"code":"UNAUTHENTICATED","detail":"Send your Bridge API key as 'Authorization: Bearer <key>'.","retryable":false}
401  {"code":"UNAUTHENTICATED","detail":"This API key is not valid, has expired or was revoked.","retryable":false}
```

- The first text means no key arrived in a header the Bridge reads (`Authorization: Bearer <key>` or `X-API-Key: <key>`). Check
  that your shell variable is not empty (`echo $MCB_API_KEY`; PowerShell `echo $env:MCB_API_KEY`).
- The second means the key did not match: mistyped, cut off, revoked or expired. A key is shown once; make a new one.
- If a fresh key is refused, it was made for another data folder than the running Bridge uses: compare the folder `keys create`
  printed with the Bridge's "Data folder" line.
- On `/xl/*` with `?key=` the text may say "may not be sent in a web address": the key is fine but was not made with
  `--allow-query`.

### SCOPE_REQUIRED (403)

The key is valid but may not do this.

```text
403  {"code":"SCOPE_REQUIRED","detail":"This API key needs the \"paper\" scope.","retryable":false}
```

A `read` key that places an order gets this. Make a key with the scope the route needs (`x-scope` in the OpenAPI file; the
dashboard's Developers, Scope finder answers it). Admin and live keys are made on this computer only.

### VALIDATION_FAILED (400): a missing or short Idempotency-Key

```text
400  {"code":"VALIDATION_FAILED","detail":"Idempotency-Key must be 8-255 letters, digits or _ . : - (a UUID works).",
      "errors":[{"path":"Idempotency-Key","message":"must be 8-255 letters, digits or _ . : -"}]}
```

Read `errors[].path` and `errors[].message`: each names a field or header. Retrying the same request fails the same way. A
live order must carry an `Idempotency-Key` or a `clientOrderId` ([safety.md](safety.md)).

### PAPER_ONLY (403)

```text
403  {"code":"PAPER_ONLY","detail":"demo-paper is a paper account; it cannot place live orders."}
```

You sent `"mode": "live"` to a paper account, or live trading is not switched on for it. Send `"mode": "paper"`, or complete the
live opt-ins on the computer running the Bridge ([safety.md](safety.md#live-orders-need-every-one-of-these)). Nothing in the API
can switch live trading on.

### SYMBOL_NOT_FOUND (404, or an entry in `errors[]`)

```text
GET /v1/ltp?symbols=NSE:NOPE      200  {"data":[],"errors":[{"symbol":"NSE:NOPE","code":"SYMBOL_NOT_FOUND",
                                         "message":"NSE:NOPE is not in any connected broker's instrument master. Try /v1/instruments/search."}]}
GET /v1/symbols/resolve?q=NSE:NOPE  404  {"code":"SYMBOL_NOT_FOUND","candidates":[]}
```

A list route (`/v1/ltp`, `/v1/quotes`) answers 200 with the symbols that worked in `data` and the ones that did not in `errors`.
A route that takes one symbol answers 404. Either way: use `EXCHANGE:SYMBOL` (`NSE:RELIANCE`), search with
`GET /v1/instruments/search?q=...`, or convert a name with `GET /v1/symbols/resolve?q=...`. A contract that has expired is also
`SYMBOL_NOT_FOUND`: use a live expiry from `GET /v1/expiries?underlying=NIFTY`.

### INVALID_ORDER (422): the order was too big, or failed another check

```text
422  {"code":"INVALID_ORDER","detail":"The order value ₹14,63,700 is above the per-order limit of ₹2,00,000."}
```

Nothing was sent. The default limits are in [safety.md](safety.md#checks-on-every-order-paper-and-live): ₹2,00,000 per order, 10
lots, 5 orders a second, 100 orders and ₹10,000 loss a day. `POST /v1/orders/preview` checks an order without placing it. Raising
a limit is done in `bridge.config.json` on the computer running the Bridge.

### MARKET_CLOSED (403)

```text
GET /v1/calendar/status  {"data":{"exchange":"NSE","status":"closed","reason":"Diwali-Balipratipada","closedBecause":"holiday",
                          "nextOpen":{"date":"2026-11-11","time":"09:15"}}}
```

`status`, `reason` and `nextOpen` say why and when. The calendar ships with the Bridge and is marked as needing verification
against the exchange's own circulars: when it matters, check the exchange.

### RATE_LIMITED (429)

```text
429  Retry-After: 2
     {"code":"RATE_LIMITED","retryable":true,"retryAfterMs":951,"scope":"client","limit":{"name":"perSecond","remaining":0}}
```

Wait `retryAfterMs`. `Retry-After` is the same wait rounded up to whole seconds with up to a quarter more, so many clients do not
return together. `scope` says whose limit: `client` is this key's own quota, `upstream` and `queue` are the shared broker budget.
Batch symbols into one call, use the stream instead of polling, or raise the key's quota
([rate-limits.md](rate-limits.md)). A refused order is not retried blindly: see `ORDER_RATE_LIMITED` and `OUTCOME_UNKNOWN` below.

### KILL_SWITCH_ACTIVE (423)

```text
423  {"code":"KILL_SWITCH_ACTIVE","detail":"... cancels still work ..."}
```

Someone (or a setting) engaged the kill switch. It stops new orders; cancels still work. Release it on the computer running the
Bridge: dashboard, Safety, or `mc-bridge kill release` ([safety.md](safety.md)). It cannot be released through a tunnel. If
`MCB_API_KEY` in your shell holds a read key, pass an admin key with `--key`, or unset the variable for that command.

### LOOPBACK_ONLY (403)

```text
403  {"code":"LOOPBACK_ONLY","detail":"This action is only available from this computer"}
```

Keys, quotas, settings and anything that could move money work only from the computer the Bridge runs on. A request that arrives
with a forwarding header (`X-Forwarded-For`), or from a host name on `server.allowedHosts`, is treated as coming from outside. Do
it from the dashboard or the terminal on that computer.

### CANNOT_TRADE (403)

The account is not ready for a live order: a session that ended, a missing static IP registration, or a limit reached. The
dashboard, Safety, Trading readiness names the exact reason ([deployment.md](deployment.md)). It never blocks a paper order.

### Other codes

Every other code, with its cause and the fix, is in [the error codes](../api/errors.md). The ones that matter most for orders:

| Code | What to do |
|---|---|
| `OUTCOME_UNKNOWN` (504) | The broker did not confirm. Do not send it again. Check `GET /v1/orders` and your broker's order book first |
| `IDEMPOTENCY_KEY_REUSED` (409) | The same `Idempotency-Key` was used with a different body. Use a new key for a new order |
| `CONFIRMATION_REQUIRED` (422) | A person must approve it on the computer running the Bridge: dashboard, Orders |
| `SESSION_EXPIRED` (422) | Log in to the broker again: dashboard, Accounts |
| `DISK_FULL` (507) | Free space; old downloads and recordings are the usual cause ([operations.md](operations.md#disk-space)) |
