# Building on the Bridge: the developer guide

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
   Without `--with-key` no key is made and the README says how.
3. Or by hand: open the dashboard, **Developers > Create app**, pick what it is for, copy the key (it is shown once)
   and run the curl line.

The starters use nothing but Node 22, Python 3.9 or `curl`. They are tested against a demo Bridge, and the calls to newer
features (downloads, events) say plainly "this Bridge does not have it yet" on an older Bridge instead of failing.

## Auth and scopes

Every call except `GET /v1/health` and `GET /openapi.yaml` needs `Authorization: Bearer mcb_<id>_<secret>`. Never put a
key in a web address; the one exception is `?key=` on the read-only `/xl/*` routes for tools that cannot send headers.

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
code has no entry there. When you report a problem, quote the `requestId`.

## Pagination

List routes take `limit` and an opaque `cursor`; the answer's `meta.nextCursor` is the cursor for the next page and is `null`
on the last one. Do not build or read a cursor.

## Idempotency

Send an `Idempotency-Key` header (any unique string, for example a UUID) with every order write. A repeat with the same key and
the same body returns the first result (the answer has `Idempotency-Replayed: true`); the same key with a different body is
`IDEMPOTENCY_KEY_REUSED`; while the first is still running you get `IDEMPOTENCY_IN_PROGRESS`, which is safe to retry.

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
receiver on this computer (`http://127.0.0.1:...`) needs `events.webhooks.allowPrivateTargets: true` in the Bridge's config file,
which cannot be switched on over HTTP. The signing secret must be 16 to 256 characters and is write-only: the Bridge never shows
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
