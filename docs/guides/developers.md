# Building on the Bridge: the developer guide

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

This is the short path for someone who writes code against the Bridge: a working call in five minutes, which key to
use, what to do when something fails, and what will not change under you. Everything here also lives in the dashboard
on the **Developers** page (`#/developers`): apps, a scope finder, your requests live and every error explained.

## Start in five minutes

1. Start the Bridge. For sample data and no broker: `mc-bridge start --demo`. Its address is `http://127.0.0.1:4300`
   unless you changed it. Check it answers (no key needed): `curl http://127.0.0.1:4300/v1/health`.
2. Make a project with the address and a key already in it:

   ```bash
   mc-bridge init node --with-key        # or: python, curl, sheets, webhook-receiver, mcp-client
   cd bridge-node && node index.mjs
   ```

   `mc-bridge init --list` shows the starters. Each one writes a new folder with a README that has three runnable steps.
   `--with-key` makes one key with only the `read` scope (or `--scope paper`), an expiry (90 days by default,
   `--expires 30d` to change it) and writes it **only** to `.env`, which `.gitignore` lists. The key is never printed.
   The key may use only the broker accounts that are **connected right now** (the command says which, and the README of the
   project lists them); `--accounts a,b` picks others and `--accounts all` allows every account, also ones added later. With
   no account connected the key may use all of them, so a starter is never harder to make. At a terminal with several
   connected accounts the command asks once; Enter accepts the default.
   Without `--with-key` no key is made and the README says how.
3. Or by hand: open the dashboard, **Developers > Create app**, pick what it is for, copy the key (it is shown once)
   and run the curl line.

Which `mc-bridge` commands need no key, which use this computer's control token and which need a read or admin key is in
[cli.md](cli.md).

The starters use nothing but Node 22, Python 3.9 or `curl`. They are tested against a demo Bridge, and the calls to newer
features (downloads, events) say plainly "this Bridge does not have it yet" on an older Bridge instead of failing.

## Auth and scopes

Every call except `GET /v1/health`, `GET /v1/ready` and `GET /openapi.yaml` needs a key, sent as `Authorization: Bearer mcb_<id>_<secret>` or as
`X-API-Key: mcb_<id>_<secret>` (both work, and the OpenAPI file says both). A bare key in some other header is not read.
Never put a key in a web address; the one exception is `?key=` on the read-only `/xl/*` routes for tools that cannot send
headers, and only for a key made with `--allow-query` ("Allow in URLs" in the dashboard).

| Scope | May | Use it for |
|---|---|---|
| `read` | prices, history, option chains, positions, funds | scripts, charts, spreadsheets, AI assistants |
| `paper` | everything `read` does, plus paper orders | a bot that tries ideas |
| `live` | real orders, when every live opt-in is on | made on purpose with `mc-bridge keys create` |
| `admin` | keys, quotas, settings; this computer only | tools you run yourself |

A route's scope is in the OpenAPI file (`x-scope`) and on its page under `docs/api/`. The dashboard's scope finder (Developers >
Apps) answers "which key does this call need?" from this Bridge's own routes. A key can never grant more than it holds, an
assistant key (`--client mcp`) can never be an admin key, and approving an order always stays on this computer.

An **app** is just a key with a name, its scope, expiry, quota and use (last used, requests today). The Apps view reads
`/v1/keys` and `/v1/quotas`; there is no separate store. Revoke an app and it stops on its very next request.

## Limits and retries

Every key has its own rate and daily cap, and all keys share each broker's real limits. A refusal is HTTP `429` with
`Retry-After` (whole seconds) and, in the body, `scope` (whose limit it was), `retryAfterMs` and `limit`. Wait that long, then
retry; do not retry in a tight loop. The starters do this for you: a read is retried up to three times, waiting as long as the
Bridge says. See [rate-limits.md](rate-limits.md) for how the budget is shared.

Retry only what is safe. A read can always be repeated. A write can be repeated only with an idempotency key (below), and
`OUTCOME_UNKNOWN` is never retried blindly: check the order book first. Every error has a `retryable` flag that says which is which.

## Errors

Every error is `application/problem+json` with a stable `code`, `status`, `detail`, `retryable` and `requestId`. Switch on
`code`, never on `detail`. The full list, with what each means and what to do, is in the dashboard (Developers > Errors),
at `GET /v1/errors` (the list of this Bridge's own codes) and in [the error codes page](../api/errors.md). A test fails when a
code has no entry there. When you report a problem, quote the `requestId`. The problem's `type` is a stable identifier of the form `https://bridge.mrchartist.local/errors/<code-in-lower-case-with-dashes>`;
it is a name, not an address you can open. A `401` also carries `WWW-Authenticate: Bearer`, and every answer carries `X-API-Version: v1`.

Ids come in a few styles, each stable once made: downloads `dl_...`, recordings `rec_...`, subscriptions `sub_...`, hooks `hk_...`,
collections `col_...` (the name also works), keys a short random id, recording rules the slug of their name, paper orders
`PAPER-<date>-<number>`. Treat every id as an opaque string.

## Pagination

List routes take `limit` and an opaque `cursor`; the answer's `meta.nextCursor` is the cursor for the next page and is `null`
on the last one. Do not build or read a cursor. Without `limit` you get the whole list (downloads: the newest 100), so a client
that never pages sees what it always saw.

Routes that page: instruments search, orders, trades, audit, downloads, datasets, collections, recordings and their rules,
subscriptions and their dead letters, keys, accounts and hooks. `GET /v1/events` pages with `since`; its `meta.nextCursor` is the
`since` for the next page. Other lists are short and always come back whole. Each page is a slice of the list sorted as the route
documents, and the cursor names the last item you got, so adding or removing items between two calls does not repeat or skip one.

### A parameter the Bridge does not know

Bodies are strict (an unknown field is a 400). On the price and history reads (`/v1/ltp`, `/quotes`, `/depth`, `/history`,
`/expiries`, `/optionchain`) a query parameter the route does not know, such as `maxAge` for `maxAgeMs`, is reported instead of
ignored: the answer still comes, with `X-MCB-Ignored-Params: maxAge` and `X-MCB-Param-Hint: maxAge: did you mean maxAgeMs`.
Add `strict=true` to get a 400 `VALIDATION_FAILED` for it instead. Other routes ignore what they do not read.

## Times and time zones

Every time the API returns is an ISO-8601 string, and its offset says the zone. There is one rule with two parts:

- **Market and trading data is IST, written with `+05:30`** (India has no daylight saving): `freshness.asOf`, orders, trades,
  positions, the audit log, readiness, the order-book check, the market calendar. For example `2026-11-10T09:30:00.000+05:30`.
- **Records about the Bridge itself are UTC, written with `Z`**: keys (`createdAt`, `lastUsedAt`, `revokedAt`), the request log
  (`at`), events (`time`), subscriptions, deliveries, backups, `health.startedAt`, and the `expiresAt` of a stream token. They
  describe the computer, not the exchange.

A string with `+05:30` and one with `Z` that mean the same moment are the same instant: parse them with a normal date parser
and compare instants, never the text. Inputs without an offset (`from=2026-10-12`) are read as IST.

**Candles** are the one place that uses epoch seconds. `time` is the bar's open, in epoch seconds. A daily bar opens at IST
midnight, which is 18:30 UTC the day before, so the UTC date of `time` is the wrong day. Use the extra fields:

- `date`: the IST trading date (`"2026-11-10"`), on daily (`1d`), weekly (`1w`) and monthly (`1M`) candles.
- `timeIso`: the same instant as an ISO string, on any candle, when you ask with `timeIso=true` or `tz=IST|UTC`
  (`"2026-11-10T00:00:00+05:30"`, or `"2026-11-09T18:30:00Z"` with `tz=UTC`).

```bash
curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/history?symbol=NSE:NIFTY&interval=1d&countback=2&timeIso=true"
```

Both are additions: `time` did not change, and a client that ignores them works as before. The CSV `time` column is already IST
(a date for daily bars). Where the API gives an epoch number next to a time, the ISO twin is named `<name>Iso`.

## Idempotency

Send an `Idempotency-Key` header (any unique string, for example a UUID) with every order write and every create listed below. A repeat with the same key and
the same body returns the first result (the answer has `Idempotency-Replayed: true`); the same key with a different body is
`IDEMPOTENCY_KEY_REUSED`; while the first is still running you get `IDEMPOTENCY_IN_PROGRESS`, which is safe to retry.

The same header works on the routes where a repeat would make a duplicate: `POST /v1/keys`, `/v1/accounts`, `/v1/hooks`,
`/v1/notify/targets`, `/v1/collections` (and `/import`, `/{name}/duplicate`), `/v1/downloads`, `/v1/datasets/{name}/update`,
`/v1/subscriptions`, `/v1/recordings`, `/v1/recordings/rules` and `/v1/recordings/presets/{id}/apply`. There the stored answer
is kept in memory for 24 hours (a restart forgets it, so look at the list route before you retry after a restart), and a request
that failed can be retried with the same key. A write route that does not take the header answers with `Idempotency-Ignored: true`
when you send one, so you know a retry is not protected.

## Events

Instead of polling, react to Bridge events. Everything stays on your computer: the Bridge keeps the last events on disk and
sends signed requests only to addresses you give it.

| Route | What it does |
|---|---|
| `GET /v1/events/stream` | Server-sent events. `?topics=order.*,download.done` filters (a topic, a prefix such as `order.*`, or `*`); `?since=<cursor>` or the `Last-Event-ID` header replays what you missed after a reconnect |
| `GET /v1/events`, `GET /v1/events/topics` | Recent events as a list, and the topics that exist |
| `/v1/subscriptions`, `/v1/subscriptions/{id}` | Signed outbound webhooks (create, list, change, delete) |
| `POST /v1/subscriptions/{id}/test`, `GET /v1/subscriptions/{id}/deliveries` | Send a test event; see the delivery log |

A webhook request carries the event as JSON and these headers: `X-Bridge-Signature`, `X-Bridge-Timestamp`, `X-Bridge-Event-Id`,
`X-Bridge-Delivery` and `X-Bridge-Attempt`. The signature is

```text
X-Bridge-Timestamp: <unix seconds>
X-Bridge-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>." + the exact raw body)>
```

Verify it before you trust the body: sign the raw bytes (never re-serialised JSON), compare in constant time, reject a timestamp
more than 300 seconds off, and remember the event `id` **from the verified body** so a retry or a captured copy is handled once (delivery is
at least once). Do not use the `X-Bridge-Event-Id` header for that: it is not signed, so anyone holding a copy can change it. In Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify({ secret, timestamp, signature, rawBody, toleranceSec = 300 }) {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSec) return false;
  const want = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  // the header may hold several signatures ("v1=aaa v1=bbb") while a secret is being replaced
  return signature.split(/[\s,]+/).some((part) => {
    const m = /^v1=([0-9a-f]{64})$/i.exec(part);
    return m !== null && timingSafeEqual(Buffer.from(m[1], "hex"), want);
  });
}
```

and in Python:

```python
import hashlib, hmac, re, time
def verify(secret: str, timestamp: str, signature: str, raw: bytes, tolerance=300) -> bool:
    if not timestamp or not signature or not re.fullmatch(r"\d{1,12}", timestamp):
        return False
    if abs(time.time() - int(timestamp)) > tolerance:
        return False
    want = hmac.new(secret.encode(), timestamp.encode() + b"." + raw, hashlib.sha256).hexdigest()
    return any(m and hmac.compare_digest(m.group(1).lower(), want) for m in (re.fullmatch(r"v1=([0-9a-fA-F]{64})", p) for p in re.split(r"[\s,]+", signature)))
```

With curl and openssl you can sign a test body: `printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac "$SECRET"`.
The `webhook-receiver` starter is a complete receiver that does all of this. Creating a subscription needs an admin key and works
from this computer only, because the target is an address the Bridge will call. By default only `https` targets are allowed; a
receiver on this computer (`http://127.0.0.1:...`) needs `events.webhooks.allowPrivateTargets: true` in the Bridge's config file
(`mc-bridge subscriptions allow-local` sets it, then restart), which cannot be switched on over HTTP. The signing secret must be 16 to 256 characters and is write-only: the Bridge never shows
it again.

## Data downloads

`POST /v1/downloads` saves history to files on the Bridge's computer (a job you can watch, pause and resume); `GET /v1/datasets`
lists the data sets that update only what is new. Every file says its data class (`realtime`, `delayed` or `eod`), its source and
its delay, and data that is not realtime never feeds orders, risk checks, paper fills or alerts. The Node, Python and curl starters
each have a `download` example that works when the Bridge has the feature and says so when it does not.

## The versioning promise

Routes under `/v1` only gain things. A field is not renamed or removed, a route is not removed, an error `code` is never renamed,
and a scope never grows silently. A change that would break a program gets a new version beside the old one (`/v2`), and the old
one keeps working for a long, announced time. New optional fields and new error codes can appear at any time, so ignore fields you
do not know and treat an unknown `code` by its `status` and `retryable`. The OpenAPI file served at `/openapi.yaml` is the contract.

## Where next

- [quickstart.md](quickstart.md): the same five minutes with a paper order and a stream.
- [python.md](python.md) and [typescript.md](typescript.md): the fuller clients in `sdk/`.
- [../api/README.md](../api/README.md): one page per call, with curl and Python.
- [../collections/README.md](../collections/README.md): Postman and Bruno collections.
- [mcp.md](mcp.md): AI assistants.
