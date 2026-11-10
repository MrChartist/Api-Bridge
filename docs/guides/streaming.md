# Live streaming: WebSocket and SSE

One port serves both. Messages are described in [asyncapi.yaml](../asyncapi.yaml) (a file in the repository; the Bridge serves `/openapi.yaml` but not this one). This page is about prices; for events (orders,
logins, downloads, the kill switch) with replay and signed webhooks, see [events.md](events.md).

## Authenticate without putting your key in a URL

```bash
curl -X POST -H "Authorization: Bearer $KEY" http://127.0.0.1:4300/v1/stream/token
# {"data":{"token":"...","expiresAt":"..."}}
```

The token is single use and must be used within 60 seconds; the connection then lives on with the key's scopes. A
client that can send headers may use `Authorization: Bearer` on the upgrade request instead. Revoking the key closes
its open connections at once.

## WebSocket

```js
const ws = new WebSocket(`ws://127.0.0.1:4300/v1/stream?token=${encodeURIComponent(token)}`);
ws.onopen = () => {
  ws.send(JSON.stringify({ op: "subscribe", symbols: ["NSE:NIFTY", "NSE:RELIANCE"], mode: "quote", id: "s1" }));
  ws.send(JSON.stringify({ op: "subscribe_orders", accounts: ["paper"] }));
};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "snapshot") console.log("latest known", m.ticks);
  if (m.type === "tick") console.log(m.seq, m.symbol, m.ltp);
  if (m.type === "order") console.log(m.order.orderId, m.order.status);
  if (m.type === "go_away") console.log("reconnect after", m.reconnectAfterMs, m.reason);
};
```

| Client op | Effect |
|---|---|
| `subscribe` `{ symbols, mode: "ltp"\|"quote"\|"depth", id? }` | Answered with a `snapshot`, then `tick`s |
| `unsubscribe` `{ symbols }` | Stops those symbols for this connection |
| `subscribe_orders` `{ accounts? }` / `unsubscribe_orders` | Order updates for accounts the key may use |
| `ping` | Answered with a `heartbeat` |

Server messages: `heartbeat` (first message and every 15 s), `snapshot`, `tick`, `order`, `status` (a broker feed went
`up`, `stale` or `down`), `error`, `go_away`.

## SSE

```
GET /v1/stream/sse?token=<token>&symbols=NSE:NIFTY,NSE:RELIANCE&mode=ltp&orders=1
```

Same messages as the WebSocket; each event's `id` is its `seq`.

**Reconnects.** A browser's `EventSource` reconnects to the same URL by itself after a network blip. The token that
opened the stream may reopen that exact URL (same `symbols`, `mode` and `orders`) for up to 5 minutes after the
connection dropped, one open connection at a time, while the key is still valid. After that, or if you change the
URL, fetch a new token:

```js
async function openStream(symbols) {
  const r = await fetch("http://127.0.0.1:4300/v1/stream/token", { method: "POST", headers: { Authorization: `Bearer ${KEY}` } });
  const { data } = await r.json();
  const es = new EventSource(`http://127.0.0.1:4300/v1/stream/sse?token=${encodeURIComponent(data.token)}&symbols=${symbols}`);
  es.addEventListener("tick", (e) => console.log(JSON.parse(e.data)));
  // readyState CLOSED means the browser gave up (for example the grace period ran out): start again with a fresh token.
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) setTimeout(() => openStream(symbols), 3000);
  };
  return es;
}
```

## Behaviour worth knowing

- **One broker subscription per symbol per account**, shared by every client; dropped when the last client leaves.
- **Caps:** per connection (`stream.maxSymbolsPerClient`, 500), per request (200), total connections (50), connections
  per API key (`stream.maxClientsPerKey`, 10), and each
  broker's feed limit. Crossing one returns `SUBSCRIPTION_LIMIT` naming exactly the refused symbols.
- **Slow clients:** ticks wait in one slot per symbol; a newer tick replaces an older one (a gap in `seq` shows that,
  and the heartbeat counts conflated ticks). Other messages queue up to `stream.maxQueuedMessages`; a client that
  overflows gets `go_away` `slow_consumer`. Memory per client is bounded.
- **Reconnects:** if a broker feed drops, the Bridge reconnects with jittered back-off and resubscribes everything.
- Streaming makes REST reads cheaper too: a streamed symbol is served from the stream with no broker call.
