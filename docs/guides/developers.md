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

Instead of polling, react to Bridge events: `GET /v1/events/stream` (server-sent events, with `since=<cursor>` to catch up
after a reconnect) and signed outbound webhooks under `/v1/subscriptions`. Each webhook carries

```text
X-MCB-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>." + the exact raw body)>
```

Verify it before you trust the body: sign the raw bytes (never re-serialised JSON), compare in constant time, reject a
timestamp more than five minutes off, and remember event ids so a retry is handled once. In Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, header, raw, now = Date.now()) {
  const p = Object.fromEntries(header.split(",").map((x) => x.split("=")));
  if (Math.abs(now / 1000 - Number(p.t)) > 300) return false;
  const want = createHmac("sha256", secret).update(`${p.t}.`).update(raw).digest();
  const got = Buffer.from(p.v1 ?? "", "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}
```

and in Python:

```python
import hashlib, hmac, time
def verify(secret: bytes, header: str, raw: bytes, tolerance=300) -> bool:
    p = dict(x.split("=", 1) for x in header.split(","))
    if abs(time.time() - int(p["t"])) > tolerance:
        return False
    want = hmac.new(secret, p["t"].encode() + b"." + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, p.get("v1", ""))
```

With curl and openssl you can sign a test body: `printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac "$SECRET"`.
The `webhook-receiver` starter is a complete receiver that does all of this. Creating a subscription needs an admin key and works
from this computer only, because the target is an address the Bridge will call; by default only `https` targets are allowed.

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
