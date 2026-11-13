# Send order updates to another project

The Bridge can push each order update to a URL in your own project, the moment it happens, so the project does not
have to keep asking `GET /v1/orders`. This is the outbound side of webhooks: [webhooks.md](webhooks.md) covers alerts
coming in.

## Set it up

In the dashboard: **API → Integrations → Your project → Send updates to your project**. Type a name and the URL,
tick what you want sent, and choose **Add URL**. The signing secret is shown once; copy it into your project.
**Send a test** posts a `forward.test` event so you can check the wiring before any order exists.

The same from a script, on the computer the Bridge runs on (these routes are admin and local only):

```bash
curl -X POST http://127.0.0.1:4300/v1/forwards -H "Content-Type: application/json" \
  -d '{"label":"My project","url":"http://127.0.0.1:8000/bridge-events","events":["order.updated"]}'
```

| Route | What it does |
|---|---|
| `GET /v1/forwards` | List targets with their delivery counts and last result (never the secret) |
| `POST /v1/forwards` | Add a target; answers with `signingSecret`, shown once |
| `POST /v1/forwards/{id}/test` | Send one `forward.test` event now |
| `DELETE /v1/forwards/{id}` | Stop sending to a target |

**URL rule:** `https://` anywhere, or `http://` only to this computer (`127.0.0.1`, `localhost`). Order data never
leaves the computer in plain text. Up to 20 targets.

## What arrives

```http
POST /bridge-events
Content-Type: application/json
X-MCB-Event: order.updated
X-MCB-Delivery: dl_3f9c1a...
X-MCB-Signature: t=1763040000,v1=<hex HMAC-SHA256>
```

```json
{
  "id": "dl_3f9c1a...",
  "event": "order.updated",
  "at": "2026-11-13T09:20:00.123Z",
  "data": {
    "orderId": "PAPER-20261113-000008",
    "accountId": "paper",
    "mode": "paper",
    "status": "filled",
    "filledQuantity": 2,
    "avgPrice": 1504.9,
    "source": "rest",
    "order": { "symbol": "NSE:RELIANCE", "side": "BUY", "quantity": 2, "orderType": "MARKET", "product": "CNC" }
  }
}
```

| Event | Sent when |
|---|---|
| `order.updated` | An order is placed, fills (partly or fully), is cancelled or rejected. One order sends several |
| `order.outcome_unknown` | A live order was sent but the broker's answer never arrived |
| `safety.kill_switch` | The kill switch is engaged or released |
| `account.status` | A broker session connects, expires or fails |

- For **paper** orders `data.order` is the whole order, as `GET /v1/orders/{orderId}` shows it. For **live** orders
  only the event fields are sent; read the order yourself when you need more. (The Bridge does not ask your broker
  again just to forward an update.)
- An order sends one update per change of state (placed, partly filled, filled, cancelled, rejected); the same state
  is not sent twice in a row. A retry repeats a delivery with the same `id`, so use the delivery `id` to ignore what
  you have already handled.

## Check that it came from your Bridge

The signature is `HMAC-SHA256(signingSecret, "<t>." + raw body)` in hex, with `t` in Unix seconds. It is the same
scheme the Bridge accepts on its own signed hooks.

```python
import hashlib, hmac, time

SECRET = "mcbfw_..."

def from_bridge(raw_body: bytes, signature_header: str) -> bool:
    parts = dict(p.split("=", 1) for p in signature_header.split(","))
    if abs(time.time() - int(parts["t"])) > 300: return False   # too old: a replay
    want = hmac.new(SECRET.encode(), parts["t"].encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, parts["v1"])
```

Check the raw bytes you received, before parsing the JSON.

## Delivery rules

- Any `2xx` answer counts as delivered. Answer quickly and do slow work afterwards.
- Anything else (an error status, a redirect, no answer in 8 seconds) is retried after 1, 5 and 20 seconds, with the
  same delivery `id`, then dropped and counted under **Failed**. Redirects are never followed.
- Each target has its own queue, delivered in order, so a slow project does not delay another. A project that stops
  answering has its newest events dropped once 500 are waiting.
- Events that happen while the Bridge is not running are not sent later. On start, read `GET /v1/orders` once to
  catch up.
