# Events out: react to the Bridge without polling

The Bridge can tell your own programs when something happens: an order was filled, a broker login ended, a data download
finished, the kill switch was turned on. You can listen live (a stream), ask for what you missed (replay), or have the Bridge
call your program (a signed webhook).

Events are **notifications only**. They tell you what happened. Nothing you receive can place, change, confirm or reject an
order, and nothing that comes back from your program is read. An event never carries an API key, a signing secret or an
order-approval token. Approving an order stays on this computer, in the Bridge. Prices are not events: use the
[price stream](streaming.md) for those.

| You want | Use |
|---|---|
| A script or app that is running now | [SSE or WebSocket](#listen-live-sse-and-websocket) |
| A script that runs now and then and wants what it missed | [Replay with a cursor](#cursors-and-replay) |
| The Bridge to call your server | [A webhook](#webhooks-the-bridge-calls-you) |

## Listen live: SSE and WebSocket

Both give the same events. Credentials are the same as for the price stream: a single-use token from
`POST /v1/stream/token`, or an `Authorization: Bearer <key>` header from a script. A read key is enough.

```bash
# every event your key may see, as it happens (Ctrl+C to stop)
curl -N -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/events/stream"

# only orders and downloads, and everything kept since cursor 1000
curl -N -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/events/stream?topics=order.*,download.*&since=1000"
```

Each SSE event looks like this (`id` is the cursor, `event` is the topic, `data` is the envelope):

```
id: 1043
event: order.updated
data: {"id":"1043","topic":"order.updated","time":"2026-11-09T04:01:02.000Z","apiVersion":"v1","data":{"orderId":"PAPER-20261109-0003","accountId":"paper","mode":"paper","status":"filled","filledQuantity":65,"avgPrice":182.4,"source":"rest"}}
```

In a browser page (the page's address must be on `cors.allowedOrigins`):

```js
const { data } = await (await fetch("http://127.0.0.1:4300/v1/stream/token", { method: "POST", headers: { Authorization: `Bearer ${KEY}` } })).json();
const es = new EventSource(`http://127.0.0.1:4300/v1/events/stream?token=${encodeURIComponent(data.token)}&topics=order.*`);
es.addEventListener("ready", (e) => console.log("connected", JSON.parse(e.data)));
es.addEventListener("order.updated", (e) => console.log(JSON.parse(e.data).data));
```

`EventSource` reconnects by itself after a network blip and sends `Last-Event-ID`; the Bridge treats it as `since`, so
you get what you missed. The token that opened the stream may reopen that same URL for 5 minutes after the connection
dropped, one connection at a time.

WebSocket: `ws://127.0.0.1:4300/v1/events/ws?token=<token>&topics=order.*&since=<cursor>`. Frames are JSON:
`{"type":"ready",...}`, then `{"type":"event","id":"1043","topic":"order.updated","time":"...","apiVersion":"v1","data":{...}}`,
and `{"type":"go_away",...}` before a close. The only thing a client may send is `{"op":"ping"}`, answered with `{"type":"pong"}`.

Query parameters (both transports, and `GET /v1/events`):

| Parameter | Meaning |
|---|---|
| `topics` | Comma-separated filters: a topic (`order.updated`), a prefix (`order.*`) or `*` (the default) |
| `since` | A cursor. Replay the kept events after it, then go live. `0` is everything kept. Without it the stream is live only |
| `accounts` | Only events about these accounts. A key never sees more than its own accounts, whatever it asks for |

The first message is `ready`: `{ cursor, oldest, replayed, gap, gapReason, topics }`. `cursor` is the newest event now.

## Cursors and replay

Every event has a number, its **cursor**, counting up for as long as the Bridge's event file lives. Treat it as opaque and give
it back as `since` (or let `EventSource` do it).

- The last **5000** events (`events.retain`) are kept on disk in the data folder (`events/log.jsonl`) and survive a restart; the
  numbering continues, so a cursor from before the restart still works.
- If you ask for a cursor older than the oldest kept event, or newer than anything this Bridge has, you are told: `gap: true`
  with `gapReason` `retention` or `cursor_ahead`. You are still sent everything that is kept. Treat a gap as "read the current
  state from the API again" (orders, positions), then carry on from the new cursor.
- `GET /v1/events?since=1000&limit=100` is the same replay as one JSON answer, for a script that runs now and then.
  `meta.cursor` is what to ask with next time. Without `since` it returns the newest events.
- Noisy topics are thinned: `download.progress`, `stream.status` and `limits.throttled` keep at most one event per job or
  account per second.

```bash
cursor=0
while true; do
  r=$(curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/events?since=$cursor&topics=order.*")
  echo "$r" | jq -c '.data[]'
  cursor=$(echo "$r" | jq -r '.meta.cursor')
  sleep 5
done
```

## Which events, and who sees them

`GET /v1/events/topics` lists what your key may receive. A **read** key sees the topics marked read. **Admin-only** topics
(order tickets, webhook alert problems, backups, config warnings) need an admin key. A key limited to some accounts only
receives events about those accounts; events that name no account (the kill switch, downloads) go to every key.

| Topic | Who | When |
|---|---|---|
| `order.updated` | read | An order (paper or live) changed state: `orderId`, `accountId`, `mode`, `status`, `filledQuantity`, `avgPrice`, `source` |
| `order.outcome_unknown` | read | The broker did not confirm an order. Check the broker before sending it again |
| `position.converted` | read | A position was moved between products |
| `account.status` | read | A broker login changed: `connected`, `expired`, `missing`, `error` |
| `account.login_needed` | read | Morning reminder: an account needs a login before the open |
| `trading.readiness` | read | An account can trade now, or cannot any more |
| `stream.status` | read | A broker price feed went `up`, `stale` or `down` |
| `safety.kill_switch` | read | The kill switch was turned on or off |
| `safety.limit` | read | A daily safety limit was reached |
| `limits.throttled` | read | A request was slowed by a rate limit |
| `download.progress` | read | A data download moved forward (at most once a second per job) |
| `download.done` | read | A data download finished |
| `download.failed` | read | A data download stopped with an error |
| `collection.changed` | read | A named list of instruments or an option universe was created, changed or deleted |
| `recording.started` | read | A recording started writing |
| `recording.stopped` | read | A recording stopped |
| `recording.gap` | read | A recording missed data because the feed or the login was missing |
| `recording.disk_low` | read | A recording is close to its disk limit |
| `ticket.prepared` | admin | An order waits for a person to approve it on this computer. Carries no approval token |
| `ticket.confirmed` | admin | A person approved an order ticket |
| `ticket.rejected` | admin | A person declined an order ticket |
| `hook.rejected` | admin | A webhook alert was accepted but did not become an order |
| `hook.stale` | admin | A webhook alert was too old to trade on |
| `hook.failed` | admin | An accepted webhook alert's order could not be made |
| `backup.completed` | admin | A backup was written |
| `backup.failed` | admin | A backup could not be written |
| `config.warning` | admin | The Bridge found something in the config worth fixing |

Never offered: `tick` (use the price stream), key events and the audit log. Before an event leaves the Bridge, every field that
looks like a secret, a token, a key, a password or an approval is removed, and key-like text is masked.

## Webhooks: the Bridge calls you

A webhook subscription tells the Bridge: "POST these topics to this URL, signed". Creating one sends data to an outside
address, so it is **this-computer-only** and needs an admin key.

```bash
# the CLI makes a random signing secret and prints it once
mc-bridge subscriptions add https://example.com/bridge/events --topics order.*,download.* --label "my server"
mc-bridge subscriptions test sub_abcdefgh
```

Or with HTTP (the secret is yours to choose, 16 to 256 characters; it is stored encrypted and never returned):

```bash
curl -X POST http://127.0.0.1:4300/v1/subscriptions -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/bridge/events","topics":["order.*","download.*"],"secret":"'"$(openssl rand -hex 32)"'"}'
```

Other commands: `subscriptions list | show | pause | resume | remove | rotate-secret | deliveries | dead-letters | tail`
(`mc-bridge --help`), and `PATCH`, `DELETE /v1/subscriptions/{id}` over HTTP.

### What your server receives

A `POST` with a JSON body (the same envelope as the stream) and these headers:

| Header | Meaning |
|---|---|
| `X-Bridge-Signature` | `v1=<hex>`: HMAC-SHA256 of `<timestamp>.<raw body>` with your secret |
| `X-Bridge-Timestamp` | Whole seconds since 1970 when this attempt was signed |
| `X-Bridge-Event-Id` | The event's cursor (the same value as `id` in the body). **Not signed**: do not de-duplicate on it. Use the `id` in the body, which the signature covers |
| `X-Bridge-Event-Topic` | The topic |
| `X-Bridge-Delivery` | This delivery's id (the same on every retry) |
| `X-Bridge-Attempt` | 1 for the first try, 2 for the next, ... |

Answer with any `2xx` quickly. The answer's body is ignored. Anything else is a failure (see retries).

### Check the signature

Always check it, on the **raw** body (before JSON parsing), and refuse a timestamp more than 5 minutes (300 seconds, set by
`events.webhooks.replayWindowSec`) from your own clock. Inside that window a captured copy is still valid, so also
de-duplicate on the event `id` **from the verified body**: only the timestamp and the body are signed, never the headers.
Delivery is at least once, so you need this for retries anyway. These three
snippets are run by the Bridge's tests against the real signer, so they are checked, not just shown.

Node (no packages):

<!-- snippet:node -->
```js
// verify.js: check a Bridge webhook. Call verify() with the RAW body, not the parsed JSON.
const crypto = require("node:crypto");

function verify({ secret, timestamp, signature, rawBody, toleranceSec = 300 }) {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSec) return false; // too old, or from the future
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  const want = Buffer.from(expected, "hex");
  // the header may hold several signatures ("v1=aaa v1=bbb") while a secret is being replaced
  return signature.split(/[\s,]+/).some((part) => {
    const m = /^v1=([0-9a-f]{64})$/i.exec(part);
    return m !== null && crypto.timingSafeEqual(Buffer.from(m[1], "hex"), want);
  });
}

module.exports = { verify };
```

A complete receiver with the same check (plain `node:http`; give it the secret in the environment):

<!-- snippet:node-server -->
```js
// receiver.js: node receiver.js   (SECRET=... PORT=8080)
const http = require("node:http");
const { verify } = require("./verify");

const seen = new Map(); // event id -> time handled. Delivery is at least once, and a captured copy stays valid for 5 minutes
const SEEN_MS = 10 * 60_000; // longer than the 5-minute signature window
const MAX_SEEN = 10_000; // a bound, so a flood of events cannot grow it

function seenBefore(id) {
  const now = Date.now();
  for (const [k, at] of seen) {
    if (now - at > SEEN_MS) seen.delete(k);
    else break; // oldest first: the rest are newer
  }
  if (typeof id !== "string") return false; // no id to match: handle it
  if (seen.has(id)) return true;
  seen.set(id, now);
  while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
  return false;
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      const ok = verify({ secret: process.env.SECRET, timestamp: req.headers["x-bridge-timestamp"], signature: req.headers["x-bridge-signature"], rawBody });
      if (!ok) return res.writeHead(401).end();
      const event = JSON.parse(rawBody.toString("utf8"));
      // the id from the signed body, never the X-Bridge-Event-Id header (it is not signed: anyone can change it)
      if (!seenBefore(event.id === undefined ? undefined : String(event.id))) console.log(event.topic, event.data);
      res.writeHead(204).end();
    });
  })
  .listen(Number(process.env.PORT || 8080), () => console.log("listening"));
```

Python (standard library only):

<!-- snippet:python -->
```python
# verify.py: check a Bridge webhook. Pass the RAW body bytes, not parsed JSON.
import hashlib
import hmac
import re
import time


def verify(secret: str, timestamp: str, signature: str, raw_body: bytes, tolerance_sec: int = 300, now: float = None) -> bool:
    if not timestamp or not signature or not re.fullmatch(r"\d{1,12}", timestamp):
        return False
    if abs((time.time() if now is None else now) - int(timestamp)) > tolerance_sec:
        return False  # too old, or from the future
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    # the header may hold several signatures ("v1=aaa v1=bbb") while a secret is being replaced
    for part in re.split(r"[\s,]+", signature):
        m = re.fullmatch(r"v1=([0-9a-fA-F]{64})", part)
        if m and hmac.compare_digest(m.group(1).lower(), expected):
            return True
    return False
```

In a web framework, take the raw bytes the framework gives you (`request.get_data()` in Flask, `await request.body()` in
FastAPI), and the headers `X-Bridge-Timestamp` and `X-Bridge-Signature`.

Shell (needs `openssl`; good for scripts and for checking by hand):

<!-- snippet:shell -->
```bash
#!/usr/bin/env bash
# verify-bridge-signature.sh <secret> <timestamp> <signature header> <body file>
# exit 0: genuine, exit 1: not. The body file must hold the raw body exactly as received.
set -u
secret="$1"; timestamp="$2"; header="$3"; body_file="$4"
[[ "$timestamp" =~ ^[0-9]{1,12}$ ]] || exit 1
now=$(date +%s)
diff=$(( now - timestamp )); (( diff < 0 )) && diff=$(( -diff ))
(( diff <= ${TOLERANCE_SEC:-300} )) || exit 1
expected=$( { printf '%s.' "$timestamp"; cat "$body_file"; } | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/^.* //' )
for part in ${header//,/ }; do
  [[ "$part" == "v1=$expected" ]] && exit 0
done
exit 1
```

The shell version compares with `[[ == ]]`, which is not constant-time, and `openssl -hmac` puts the secret in the process
list while it runs: fine on your own computer, not for a shared server. Use the Node or Python version there.

### Retries, dead letters and the log

Each event is written to disk before the first attempt, so a restart does not lose it. An attempt that was running when
the Bridge stopped is sent again after the restart.

| Answer | What happens |
|---|---|
| `2xx` | Delivered |
| `5xx`, `408`, `425`, `429`, a timeout, no connection | Retried after 5 s, then 10 s, 20 s ... doubling up to 1 hour, with 20 % jitter; a `Retry-After` is honoured up to that hour. Up to 8 attempts or 24 hours, then a dead letter |
| Other `4xx`, a redirect, a refused target | A dead letter at once: sending it again cannot help |

- **Dead letters**: `GET /v1/subscriptions/{id}/dead-letters`, or `mc-bridge subscriptions dead-letters <id>`. Fix the cause,
  then send them again (`--retry-all`) or forget them (`--clear`). Each subscription keeps at most 500 waiting events; when
  the queue is full the oldest is set aside as a dead letter with the reason `overflow`.
- **Delivery log**: `GET /v1/subscriptions/{id}/deliveries` lists every attempt: time, outcome, HTTP status, a short code
  (`http_5xx`, `timeout`, `tls_failed`, `blocked_address` ...) and how long it took. It never holds your server's answer text,
  the URL's path or the secret.
- **Test**: `POST /v1/subscriptions/{id}/test` (or `subscriptions test <id>`) sends one signed `subscription.test` event now. It is
  not queued and not retried.
- **Order**: events can arrive out of order when a retry overtakes a newer one. Order by the event id.

### Where a webhook may point

The Bridge sits inside your home or office network, so a webhook target is checked hard. It is checked when you save it, and
again before every delivery on the addresses the name points to at that moment:

- `https://` only, no user name or password in the URL, no `localhost` or local-network names (`.local`, `.internal`, `.lan`).
- Every address the host resolves to must be public: never loopback, private (`10.x`, `172.16-31.x`, `192.168.x`),
  link-local (`169.254.x`, `fe80::`), carrier-grade NAT, multicast or reserved. One bad address in the answer refuses the
  delivery. The connection then goes to the address that was checked, not to a second lookup.
- Cloud metadata addresses (`169.254.169.254`, `100.100.100.200`, `168.63.129.16`, `fd00:ec2::254`) are refused **always**.
- The Bridge never follows a redirect, verifies the receiver's certificate every time, gives up after `timeoutMs` (10 s), reads
  at most 4 KB of the answer and throws it away.
- Sending to your own computer or network (a receiver on `127.0.0.1` or a LAN address, plain `http://`) needs
  `events.webhooks.allowPrivateTargets: true` in the config file. It cannot be switched on over HTTP. `allowedHosts` can limit
  targets to a list of hosts.

### The secret

The signing secret is write-only. It is stored encrypted (the secrets store, with your broker credentials) and not in any file of
the events folder, so a backup of the data folder carries no webhook secret. It is never returned by any route, never written to
the log, the delivery log or the audit log. To replace it: `mc-bridge subscriptions rotate-secret <id>` (or `PATCH` with a new
`secret`); update your receiver first, or accept both signatures for a short while (the header can carry several `v1=` values
and the snippets above check each one).

## Settings

`events` in `bridge.config.json` (all optional):

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Off: no event log, no streams, no webhooks |
| `retain` | `5000` | Events kept for replay, also across a restart |
| `maxEventBytes` | `16384` | An event's data above this is replaced by a short note |
| `heartbeatMs` | `15000` | Keep-alive for streams; also when a revoked key is noticed |
| `maxClients`, `maxClientsPerKey` | `50`, `5` | Open stream connections |
| `maxBufferedBytes` | `262144` | A reader this far behind is closed (`go_away` `slow_consumer`); it reconnects with its cursor |
| `webhooks.enabled` | `true` | |
| `webhooks.maxSubscriptions` | `20` | |
| `webhooks.allowPrivateTargets` | `false` | Let targets be `http://` or on this computer or network (metadata addresses stay refused) |
| `webhooks.allowedHosts` | `[]` | When not empty, targets must match one: `example.com` or `*.example.com` |
| `webhooks.timeoutMs`, `maxResponseBytes`, `concurrency` | `10000`, `4096`, `4` | |
| `webhooks.replayWindowSec` | `300` | What receivers should accept |
| `webhooks.retry` | `maxAttempts 8, baseMs 5000, maxMs 3600000, jitter 0.2, maxAgeSec 86400` | |
| `webhooks.maxPendingPerSubscription`, `deadLetterMax`, `deliveryLogMax` | `500`, `200`, `500` | |

## Troubleshooting

| You see | Do this |
|---|---|
| `401` on the stream | The token is single use and lasts 60 seconds: get a new one, or send an `Authorization` header |
| `gap: true` in `ready` | You were away longer than the Bridge keeps events: read orders and positions from the API, then continue from `cursor` |
| The webhook test says `blocked_address` | The host resolves to a private or metadata address. Use a public host, or `allowPrivateTargets` for a receiver of your own |
| `http_4xx` | Your server refused it: check the signature check, the URL and that you read the **raw** body |
| Signatures never match | The body was parsed and re-written before checking; the secret has a trailing newline; or the two clocks differ by more than 5 minutes |
| A subscription says `needs-secret` | Its stored URL and signing secret are gone (demo mode keeps secrets in memory only, so a restart loses them). Send both again with `PATCH /v1/subscriptions/{id}` (`url` and `secret`), then `subscriptions dead-letters <id> --retry-all`; or remove it and add it again |
| Events stopped for a subscription | `mc-bridge subscriptions list`: is it `paused` or `failing`? Look at `deliveries` and `dead-letters` |
