# The data-source contract

For developers who write a data source for the Bridge: a built-in provider in this repository, or a plugin that someone
installs. The design and its reasons are in [sources-architecture.md](sources-architecture.md); traders read
[guides/sources.md](guides/sources.md). The code is the source of truth:

| Part | File |
|---|---|
| Descriptor, data classes, purposes, `validateDescriptor` | `server/bridge/sources/contract.mjs` |
| Conformance harness | `server/bridge/sources/conformance.mjs` |
| Plugin manifest | `server/bridge/sources/plugin/manifest.mjs` |
| Wire protocol | `server/bridge/sources/plugin/protocol.mjs` |
| Process host, restarts, limits | `server/bridge/sources/plugin/host.mjs` and `child.mjs` (the runner) |
| Brokered network | `server/bridge/sources/plugin/netbroker.mjs` and `netpolicy.mjs` |
| Loading, pinning | `server/bridge/sources/plugin/loader.mjs` |
| Offline plugin check | `server/bridge/sources/plugin/check.mjs` (`mc-bridge sources plugins check`) |
| A small working plugin | `examples/source-plugin/` |

## 1. What a source is

A source answers read-only market-data questions: `quotes`, `history`, `expiries`, `optionChain`. It never places
orders, never sees broker credentials, and never learns which account asked. Every answer carries a **data class** so a
delayed or end-of-day value cannot be taken for a real-time one.

There is no write path in the contract, and none will be added: broker adapters (anything that logs in, holds tokens or
sends orders) stay first-party, in-tree, and are written only from the broker's official documentation.

## 2. The descriptor

Every source has a descriptor. The router, the dashboard and `GET /v1/sources` read it.

```js
{
  id: "twelvedata",            // ^[a-z][a-z0-9-]{1,30}$, unique
  name: "Twelve Data",
  kind: "free",                // broker | free | plugin
  tier: "byok",                // builtin | byok | opt-in | plugin
  class: "eod",                // realtime | delayed | eod
  delaySec: null,              // required (and > 0) when class is "delayed"
  official: true,              // see below
  capabilities: ["quotes", "history"],
  limits: { perMinute: 8, perDay: 800 },   // the vendor's documented limits; at least one of perSecond, perMinute, perDay
  terms: { url: "https://twelvedata.com/terms", note: "One plain sentence about what the user accepts." },
  needsKey: true,
  noticeVersion: "..."         // opt-in sources only
}
```

`validateDescriptor(d)` returns every problem at once. Rules worth knowing:

- `delaySec` must be stated for `delayed`. For `realtime` the Bridge reports 0.
- `terms.url` (https) and `terms.note` are required unless the tier is `builtin`. The dashboard shows them before a source is
  turned on.
- An `opt-in` source needs a `noticeVersion` and may not claim `official: true`. A user turns it on by acknowledging exactly
  that version; changing the notice changes the version and asks again.
- **`official`** is true only for a documented API from the data's owner or the user's own broker. A scraped site, a
  reseller of exchange data or any plugin is `false`.
- `limits` are what the vendor documents, not what you hope to get away with. Where a vendor publishes nothing, state a
  conservative figure and say so in a comment. The Bridge never goes above them.

### Tiers and data classes in practice

| Tier | Switched on by |
|---|---|
| `builtin` | Nothing: your broker accounts |
| `byok` | Saving a key (`PUT /v1/sources/{id}/config`) and enabling |
| `opt-in` | Enabling with `acknowledge` equal to `noticeVersion` |
| `plugin` | The owner granting it in `sources.plugins` (with its sha256), and enabling |

Free and plugin sources never claim `realtime`: the conformance harness fails them if they do, and the plugin manifest does
not accept it. Real-time data comes from the user's broker.

**Purposes.** A read has a purpose: `display`, `analysis`, `alert`, `paper`, `risk`, `order`. `classAllowedFor(class, purpose)`
accepts only `realtime` for the last four. `meetsMaxAge(source, maxAgeMs)` also filters: a delayed source answers only a
caller whose `maxAgeMs` is at least its delay; an end-of-day source needs at least 24 hours. The router applies both as hard
filters before it scores anything. A plugin additionally refuses those four purposes itself.

## 3. The provider: methods and shapes

```js
{
  descriptor,
  hosts: ["api.vendor.example"],   // every host it contacts (the conformance harness checks requests against it)
  async quotes(symbols, ctx),
  async history({ symbol, interval, fromMs, toMs }, ctx),
  async expiries(underlying, ctx),
  async optionChain(underlying, expiry, ctx),
  async test(ctx)                  // optional: one small call for `mc-bridge sources test`
}
```

Implement only what the descriptor declares. `ctx` is `{ signal, now }`: `signal` aborts at the caller's deadline and
**must** stop work and make no further requests; `now` is the Bridge clock in epoch ms.

### quotes

```js
{ items: [ { symbol: "NSE:RELIANCE", at: 1792383300000, flags: ["unofficial", "delayed"],
             fields: { ltp: 2891.4, open: 2880, high: 2899.9, low: 2872.1, close: 2875.55, volume: 4182211,
                       oi: null, bid: null, ask: null, bidQty: null, askQty: null } } ] }
```

- `symbol` is the canonical Bridge symbol that was asked for (`EXCHANGE:UNDERLYING...`).
- `fields.ltp` is finite and positive. Other fields are finite numbers or `null`; never strings, never `NaN`.
- `at` is the **vendor's own timestamp** in epoch milliseconds. For a delayed or end-of-day source never use the time you
  received the answer: it would pass for live data. `at` is never in the future.
- One item has one source and one timestamp. Do not fill a field from another source.
- A crossed book (`bid > ask`) is dropped by the Bridge (both become `null`).

### history

```js
{ candles: [ { time: 1792300000, open: 10, high: 12, low: 9, close: 11, volume: 100 } ], partial: false, at: 1792383300000 }
```

`time` is integer epoch **seconds**, strictly ascending. Prices are positive, `high >= low`, `volume` is a number (0 if
unknown). `partial: true` says the vendor could not supply the whole range. Add the flag `last-bar-provisional` when the
newest bar is still forming.

### expiries and optionChain

```js
{ expiries: ["2026-10-29", "2026-11-26"], at: 1792383300000 }                 // ISO dates, ascending
{ underlyingLtp: 24500, at: 1792383300000,
  rows: [ { strike: 24500, ce: { ltp: 110, bid: 109.5, ask: 110.5, oi: 1200000, volume: 90000, iv: 14.2, delta: 0.5 }, pe: null } ] }
```

Leg fields are `ltp, bid, ask, oi, volume, bidQty, askQty, iv, delta, gamma, theta, vega`. Anything else is dropped. A source
that cannot supply Greeks leaves them `null`; the Bridge computes them itself and marks the basis.

### Labels the Bridge adds

Items carry `flags`. A built-in provider sets them itself (`unofficial` for `official: false`, `delayed`, `eod`,
`last-bar-provisional`); a plugin's answers are labelled by the Bridge as `["plugin", "unofficial", "<class>"]`. The Bridge then
builds the response's `freshness` (`class`, `delaySec`, `official`, `confidence`, `flags`) with `dataQuality()`.

## 4. Errors

Throw a `BridgeError` carrying `fields.kind`, so the router can tell "slow down" or "wrong symbol" (which must not trip a
circuit breaker) from a real fault.

| `fields.kind` | Bridge code | Meaning | Circuit breaker |
|---|---|---|---|
| `rate-limited` | `UPSTREAM_RATE_LIMITED` | The vendor, or your own limiter, said wait. Set `retryAfterMs`. | Never trips it; the Bridge backs off |
| `auth` | `UPSTREAM_ERROR` | The key is missing or rejected. | Never trips it |
| `not-found` | `SYMBOL_NOT_FOUND` | The vendor does not know the symbol. | Never trips it |
| `entitlement` | `CAPABILITY_UNSUPPORTED` | The user's plan does not include this data. | Not a fault of the source |
| `unsupported` | `CAPABILITY_UNSUPPORTED` | The source cannot do this at all. | Not a fault of the source |
| `blocked` | `UPSTREAM_ERROR` | The vendor now demands something the Bridge will not do (cookies, a login). | Counts as a failure |
| `upstream` | `UPSTREAM_ERROR` | The vendor failed, or sent something unreadable. | Counts as a failure |
| `timeout` | `UPSTREAM_TIMEOUT` | No answer in time. | Counts as a failure |
| `unavailable` | `BROKER_UNAVAILABLE` | The network call itself failed. | Counts as a failure |

A source is ejected by the circuit breaker after repeated failures, retried after a cooldown that doubles up to five minutes,
and a 429, an auth error or a not-found never trips it (see [sources-architecture.md](sources-architecture.md)).

Never throw a raw `Error`: its message may carry a URL or a key. Keep the message to one plain sentence, redact secrets,
and never echo the response body. A cancelled call throws an `AbortError` (name `AbortError`), not a `BridgeError`.

**Plugin error codes** (what a plugin sends, and what the Bridge turns it into):

| Plugin code | Bridge code | `fields.kind` |
|---|---|---|
| `RATE_LIMITED` (+ `retryAfterMs`) | `UPSTREAM_RATE_LIMITED` | `rate-limited` |
| `UNAVAILABLE` | `BROKER_UNAVAILABLE` | `unavailable` |
| `TIMEOUT` (also generated by the host) | `UPSTREAM_TIMEOUT` | `timeout` |
| `BAD_RESPONSE` | `UPSTREAM_ERROR` | `upstream` |
| `NOT_FOUND` | `SYMBOL_NOT_FOUND` | `not-found` |
| `UNSUPPORTED` | `CAPABILITY_UNSUPPORTED` | `unsupported` |
| `AUTH` | `UPSTREAM_ERROR` | `auth` |
| `CANCELLED` | an abort | |
| `INTERNAL`, a crash, or any other code | `UPSTREAM_ERROR` | `upstream` |

An answer that does not fit the shapes above, or a message that does not parse, is `UPSTREAM_ERROR`. After a
`RATE_LIMITED` with `retryAfterMs`, the host does not call the plugin again until that time has passed.

## 5. Limits

| Limit | Value |
|---|---|
| Vendor request limits | From the descriptor (`limits`); the Bridge budgets each source like a broker account |
| Plugin call timeout | 5 s by default. The manifest may lower it (`limits.callTimeoutMs`, at least 100 ms), never above **15 s** |
| Plugin concurrency | 1 call at a time by default; the manifest may allow up to 4 (`limits.maxInFlight`). Up to 20 more wait in a queue |
| Plugin message, plugin to host | At most **2 MB** per line |
| Brokered response | 2 MB by default; the manifest may set `limits.maxResponseBytes` up to **5 MB** |
| Brokered requests | In flight per plugin: 4. Per second, minute and day: the manifest's `perSecond`, `perMinute`, `perDay` |
| Answer sizes | Quotes up to 200 items, history up to 20,000 candles, option chains up to 2,000 rows, expiries up to 200 |
| Plugin heap | `--max-old-space-size=128` (megabytes). This bounds the JS heap, not all memory |
| Restarts | At most **3** restarts in 10 minutes, then the plugin is disabled |

A built-in provider keeps to its own limits with a sliding-window limiter and honours a 429 `Retry-After`. A plugin does not
throttle itself: the host enforces its declared limits on every brokered request and refuses the excess with `RATE_LIMITED`.

## 6. Plugins

A plugin is a read-only source in its own process. It is a folder with a manifest `mc-source.json` and one entry file.

### The manifest

Validated by the host with zod before any plugin code runs. Unknown keys are refused, so a typo cannot silently drop a
restriction.

```json
{
  "id": "example-delayed",
  "name": "Example delayed quotes",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "index.mjs",
  "capabilities": ["quotes"],
  "class": "delayed",
  "delaySec": 900,
  "network": { "allowHosts": ["quotes.example.com"] },
  "limits": { "perSecond": 1, "perMinute": 30, "perDay": 2000, "callTimeoutMs": 5000 },
  "terms": { "url": "https://example.com/terms", "note": "One plain sentence." },
  "configSchema": { "market": { "type": "string", "enum": ["NSE", "BSE"], "default": "NSE" } }
}
```

| Field | Rule |
|---|---|
| `id` | `^[a-z][a-z0-9-]{1,30}$`. Not one of the Bridge's own ids (`broker`, `demo`, `demo-delayed`, `demo-eod`, `yahoo`, `nse`, `alphavantage`, `twelvedata`, `backup`, `paper`) |
| `name`, `version`, `description` | A name up to 60 characters; semantic version; optional text up to 300 |
| `apiVersion` | Must be `1` |
| `entry` | A relative path to one `.mjs` or `.js` file inside the folder. No `..`, no absolute path |
| `capabilities` | A non-empty subset of `quotes`, `history`, `expiries`, `optionChain`. Any other name (orders, portfolio, accounts, funds) is rejected: there is nothing to ask for |
| `class`, `delaySec` | `delayed` (with `delaySec`, 1 to 604800) or `eod`. `realtime` is rejected: a plugin is never real-time |
| `official` | Optional; must be `false` |
| `network.allowHosts` | Up to 10 entries. `host.example.com` or `*.example.com` (one leading wildcard, at least two labels after it). No IP addresses, `localhost`, `.local` or `.internal` names, ports, paths, schemes or credentials, and **no broker domains** |
| `network.allowPost` | Optional; lets the plugin send POST requests. Default: GET and HEAD only |
| `limits` | At least one of `perSecond`, `perMinute`, `perDay`; optional `callTimeoutMs`, `maxInFlight`, `maxResponseBytes` within the caps in section 5 |
| `terms` | `url` (https) and `note`, required |
| `secrets` | Optional `["apiKey"]`: the plugin needs one key, which the owner stores with `mc-bridge sources set-key <id>` |
| `configSchema` | Owner settings as a small schema: each key has `type` (`string`, `number`, `integer`, `boolean`) and optional `enum`, `default`, `minimum`, `maximum`, `maxLength`, `required`. Unknown settings are refused. A key named like a secret (key, token, password...) is refused: use `secrets` |

The host builds the plugin's descriptor from the manifest with `tier: "plugin"`, `kind: "plugin"`, `official: false`, and
checks it with `validateDescriptor`. The manifest cannot choose any of those three.

### Granting a plugin

The owner lists it in `bridge.config.json`:

```json
"sources": { "plugins": [ { "path": "./my-plugin", "sha256": "<pin>", "granted": true, "config": { "market": "NSE" } } ] }
```

- Order of work for an owner: **read** `mc-source.json` and the entry file, **pin**, then (optionally) **check**. `check` starts
  the plugin and runs its code, so it comes after review, not before.
- `mc-bridge sources plugins pin <folder>` prints the **pin**: the sha256 of a fixed header and the digests of the manifest
  file and the entry file. It also prints what the owner is granting (hosts, capabilities, limits, terms) to review.
- A plugin loads only if `granted` is exactly `true`, the files match the pin, the folder holds **no symbolic link at any
  depth** (the pin covers two files, so a link could point at something nobody reviewed, such as the Bridge's data folder),
  the manifest and descriptor are valid, the
  id is unused, and `config` satisfies `configSchema`. Otherwise it is refused with the reason (shown in the logs). A
  changed file is refused until the owner updates the pin.
- The child process re-checks the entry bytes against the pin and imports exactly those bytes, so a file changed after the
  check is not run. The entry is imported from a `data:` URL: it is **one self-contained file** and cannot import local
  siblings (it may import Node built-ins).

### Writing the entry file (Node)

```js
export default {
  async quotes(symbols, ctx) { /* ... */ },
  async test(ctx) { /* optional */ },
};
```

`ctx` gives the plugin everything it is allowed to have:

| | |
|---|---|
| `ctx.fetch(url, init)` | A host-brokered request. Resolves to `{ ok, status, headers, text(), json() }`. `json()` throws `BAD_RESPONSE` if the body is not JSON. `init` may carry `method`, `headers`, `body` |
| `ctx.signal` | Aborted when the host cancels the call. Stop work |
| `ctx.now` | The Bridge clock, epoch ms |
| `ctx.config` | The owner's settings, validated against `configSchema` |
| `ctx.secrets` | `{ apiKey }` when the manifest declares it |
| `ctx.log(level, msg)` | Logged by the host (rate-limited, secrets redacted). `console.log` is also redirected to the log |
| `ctx.fail(code, message, retryAfterMs)` | Throws a plugin error (`RATE_LIMITED`, `UNAVAILABLE`, `NOT_FOUND`, ...) |

A plugin in another language can speak the wire protocol directly, but the Bridge runs only Node entries today.

### The wire protocol: `bridge-source/1`

Newline-delimited JSON over the child's stdin and stdout: one message per line, UTF-8, each an object with a `type`. Every
message from the child is size-capped (2 MB), parsed once, stripped of `__proto__`, `constructor` and `prototype` keys,
limited in nesting depth (12) and value count, and checked against a strict schema. **Any violation kills the process.**

Host to child:

| Message | Fields |
|---|---|
| `hello` | `protocol`, `apiVersion`, `hostVersion`, `features` |
| `init` | `config`, `secrets` (the only message that ever carries a secret) |
| `call` | `id`, `method` (`quotes`, `history`, `expiries`, `optionChain`, `test`), `params`, `deadlineMs`, `now` |
| `cancel` | `id` |
| `fetchResult` | `id`, then `ok: true` with `status`, `headers`, `body`, or `ok: false` with `code`, `message`, optional `retryAfterMs` |
| `ping` | `id` |
| `shutdown` | |

Child to host:

| Message | Fields |
|---|---|
| `ready` | `apiVersion`, `capabilities` (what the entry implements) |
| `result` | `id`, `data` |
| `error` | `id`, `code`, optional `message`, `retryAfterMs` |
| `fetch` | `id`, optional `call`, `url`, optional `init` (`method`, `headers`, `body`) |
| `log` | `level`, `msg` |
| `pong` | `id` |

Sequence: the host starts the process and sends `hello`. The child answers `ready`; the host checks `apiVersion` and that the
declared capabilities are implemented (a plugin that does not implement what its manifest declares is disabled), then sends
`init`, then `call`s. The child may send `fetch` while a call runs, with the call's id in `call`.

```
host  -> {"type":"hello","protocol":"bridge-source/1","apiVersion":1,"hostVersion":"2","features":["fetch","cancel","ping"]}
child -> {"type":"ready","apiVersion":1,"capabilities":["quotes"]}
host  -> {"type":"init","config":{"market":"NSE"},"secrets":{}}
host  -> {"type":"call","id":1,"method":"quotes","params":{"symbols":["NSE:RELIANCE"]},"deadlineMs":5000,"now":1792383900000}
child -> {"type":"fetch","id":1,"call":1,"url":"https://quotes.example.com/v1/quotes?symbols=NSE%3ARELIANCE"}
host  -> {"type":"fetchResult","id":1,"ok":true,"status":200,"headers":{"content-type":"application/json"},"body":"{...}"}
child -> {"type":"result","id":1,"data":{"items":[{"symbol":"NSE:RELIANCE","at":1792383300000,"fields":{"ltp":2891.4}}]}}
```

**Time and cancellation.** A call that has not answered in `callTimeoutMs` is rejected with `UPSTREAM_TIMEOUT` and the child
is sent `cancel`. The runner acknowledges a cancel by sending `error` with code `CANCELLED`; two cancels not acknowledged
within one second get the process killed. The host pings every 10 seconds and kills a child that misses two. A late answer
to a call that was cancelled, timed out or aborted is dropped; many answers to calls that never existed kill the process.
A child that sends more than 500 messages in a second is killed; log lines beyond 20 a second are dropped.

**Restarts.** A crash fails the call in flight with `BROKER_UNAVAILABLE` (`retryable: false`). The next call starts a fresh
process after a backoff of 1, 2, 4 and 8 seconds. A fourth crash within 10 minutes **disables** the plugin; the reason shows
in the source's `health` (`state: "disabled"`, `lastError`) on `GET /v1/sources`. A plugin whose entry does not load or does
not match its pin is disabled at once. Disabled stays disabled until the Bridge restarts with the plugin fixed or re-pinned.

### The brokered network

The plugin sends `fetch`; the host performs the request only if all of this holds, and otherwise answers `fetchResult` with
`ok: false` and a code:

- the URL is **https** on the standard port, with a host **name** (no IP address in any notation, no `user:pass@`) that matches
  `network.allowHosts` and is not a broker domain (`HOST_NOT_ALLOWED`);
- the method is GET or HEAD, or POST when `allowPost` is set; only POST may carry a body (`BAD_REQUEST`);
- the plugin is inside its own per-second, per-minute and per-day request limits (`RATE_LIMITED` with `retryAfterMs`);
- the name resolves, **at connection time**, only to public addresses: loopback, private, link-local, carrier-grade NAT,
  documentation, multicast and reserved ranges (and IPv4 inside IPv6) are refused, so a name that later resolves to a
  private address is refused too (`HOST_NOT_ALLOWED`);
- redirects are followed at most three times, and each hop is checked again with the same rules (`HOST_NOT_ALLOWED`);
- the response is no larger than the plugin's cap (`TOO_LARGE`) and arrives in time (`TIMEOUT`; the lesser of the call timeout
  and 10 s). Cancelling the call aborts its requests.

The request carries no cookies, no Bridge header and no credential. The host sets the User-Agent, asks for no compression, and
refuses `Cookie`, `Host`, hop-by-hop and `Proxy-*` headers from the plugin. Only `content-type`, `retry-after`, `etag`,
`last-modified`, `date`, `cache-control` and the rate-limit headers come back; never `Set-Cookie`. Response bodies are text.

### The sandbox model, and its honest limits

**What the Bridge enforces, by construction:**

1. **A process boundary.** The plugin runs in a child process with an **empty environment**, so no variable from the Bridge
   (including any master key) is visible. Its working directory is its own folder. Its API key, if it has one, arrives once in
   `init` over stdin, never in argv or the environment.
2. **No protocol for anything else.** There is no message to ask for accounts, sessions, orders, portfolio or funds. A
   plugin cannot influence which account serves a read, because calls carry symbols, intervals and underlyings, nothing else.
3. **Output is data.** Everything a plugin returns is parsed as JSON, deep-copied without prototype keys and validated; unknown
   fields are dropped. Nothing is evaluated or imported from a string the plugin sends.
4. **No trust in time or class.** The data class comes from the manifest, and `official: false` is forced. A plugin's data
   is `delayed` or `eod`, so it can never pass the real-time gate that orders, risk checks, paper fills and alerts need. The
   plugin provider also refuses those purposes itself.
5. **An import boundary.** Order, safety, paper, account, broker, risk and alert code never imports the plugin host, and the
   plugin host imports none of that code or the secrets store. A test (`plugin/isolation.test.mjs`) scans the source tree
   and fails the build if that changes.
6. **Supply chain.** The files are pinned by hash and the pinned bytes are the ones that run. Nothing is installed or updated
   at run time.
7. **Brokered network, with limits, timeouts and caps**, as above.

**Node permission flags, as an extra layer.** The child is started with
`--permission --allow-fs-read=<entry file> --allow-fs-read=<runner> --max-old-space-size=128 --disallow-code-generation-from-strings
--no-experimental-fetch --no-experimental-websocket` and no other `--allow-*` flag: it cannot write files, start processes,
create worker threads, load native addons or run WASI, it can read only its own entry file (not the folder, so not its manifest or fixtures either), `eval` is off, and the built-in
`fetch` and WebSocket are not defined. On Node versions before 22.13 the older `--experimental-permission` flag is used.

**What this does not stop.** Node's own documentation calls the permission model a *seat belt* for trusted code, not a
security boundary against malicious code. The honest limits:

- **Node 22 has no network permission.** A plugin can still open its own sockets with `node:net`, `node:https` or `node:dns`,
  and reach any host the computer can reach, including addresses on your local network and the Bridge's own port. The
  allow-list governs the requests that go through the host; it does not stop a plugin that bypasses it. A plugin has no key to
  the Bridge's API, and an admin route needs one, but a malicious plugin can still talk to local services or send data it can
  see (its own folder, its config, its API key, market data) to the internet.
- **A plugin can signal the Bridge.** Node's permission flags do not cover signals. A plugin that runs as the same user as the
  Bridge can call `process.kill(process.ppid, "SIGKILL")` (or `SIGSTOP`, which freezes it) and stop the Bridge, and nothing the
  Bridge can do prevents or catches that: `SIGKILL` and `SIGSTOP` cannot be handled by any process. The Bridge does not pretend
  otherwise. The mitigation is a **different user**: set `sources.pluginUser: { uid, gid }` and run the Bridge as root (or with
  `CAP_SETUID` and `CAP_SETGID`); the child is then started as that user and the kernel refuses its signals to the Bridge.
  If `pluginUser` is set but the Bridge may not switch user, plugins are not started (a clear message is logged), never silently
  started as the Bridge's user. Without it, the risk is the one stated in the notice shown by `plugins pin`, when a plugin is
  refused for not being granted, and when it loads.
- The plugin runs with **your user's privileges** apart from the file-system flags. File descriptors that already exist
  are not covered, and a bug in Node or V8 can defeat the flags.
- Memory and CPU are only loosely bounded: `--max-old-space-size` limits the JS heap, not buffers, and a busy loop is cut off
  only by the call timeout and the heartbeat, not by a CPU quota.
- A plugin can lie: wrong prices that are well-formed pass every shape check. The `delayed`/`unofficial` labels and the
  exclusion from orders limit the damage; they cannot make a bad vendor correct.

**Process lifetime.** The host kills every live plugin child when the Bridge exits (including `process.exit` after SIGINT or
SIGTERM). A forced kill of the Bridge cannot run that, and a plugin stuck in a busy loop never notices its stdin closing, so it
can be orphaned; the owner stops it by hand (`pgrep -af "plugin/child.mjs"`, see [guides/sources.md](guides/sources.md)).

**So:** a plugin is code you choose to run. Read it, pin it, and install only what you trust. If you need a real boundary, run
the Bridge, or only the plugins, inside a container or VM with an egress-filtering firewall: that is the supported way to get
one, and it is outside what this code does.

## 7. Conformance

`runProviderConformance(provider, fixtures)` (`server/bridge/sources/conformance.mjs`) runs against any provider, built in or a
plugin loaded through the host, with a fake clock and a scripted fetch: no network. Its checks: `descriptor`, `capabilities`,
`shape:<capability>`, `abort`, `limits`, `errors:<scenario>` (rate limit, not found, upstream failure, network failure,
unreadable answer, and auth when a key is needed), `secrets` and `network`.

`mc-bridge sources plugins check <folder>` does this for a plugin. **It runs the plugin's code**, so read the manifest and entry file
and `pin` first. It starts the plugin for real, through the same loader and host, with the same process and
flags as in production (read access to the entry file only, empty environment, no children or workers). It refuses a folder with a symbolic link, and a fixture
that resolves (by real path) outside the folder, answers every request it makes from `fixtures/conformance.json` (a request that matches no fixture
fails the check), and adds checks for loading, determinism and fixture coverage. See `examples/source-plugin/fixtures/` for the
format:

```json
{
  "inputs": { "quotes": ["NSE:RELIANCE", "NSE:TCS"] },
  "responses": [ { "urlContains": "/v1/quotes", "file": "quotes.json" } ],
  "config": { "market": "NSE" }
}
```

### The checklist, and where each item is checked

Every item must hold for a source to be listed. "Check" is `plugins check` (the harness plus the host's own validation);
"tests" are this repository's unit tests of the host.

| # | Requirement | Checked by |
|---|---|---|
| 1 | The manifest validates; no forbidden capability name | check (`manifest`); tests (`manifest.test.mjs`) |
| 2 | The `hello`/`ready` handshake works and the declared capabilities are implemented | check (`load`); tests (`host.test.mjs`) |
| 3 | Every declared capability returns the normalised shape (finite positive prices, ascending epoch-second candles, ISO expiries, bid not above ask) | check (`shape:*`, and the host re-validates every answer); tests (`results.test.mjs`) |
| 4 | Class, delay and timestamps are consistent: the provider's own `at`, never now for delayed data, never in the future | check (`shape:*` flags); host rejects future `at`; manifest refuses `realtime` |
| 5 | Declared limits are respected under a burst | check (`limits`); tests (`netbroker.test.mjs`) |
| 6 | A 429, with and without Retry-After, becomes `RATE_LIMITED` with the right `retryAfterMs` and is backed off from | check (`errors:rate-limited`); tests (`host.test.mjs`) |
| 7 | 5xx, a dropped connection, an empty body and HTML where JSON was expected each become a taxonomy error, not a crash | check (`errors:upstream`, `errors:network-error`, `errors:garbage`) |
| 8 | An unknown symbol is `NOT_FOUND`, an unsupported capability is `UNSUPPORTED`, neither is `UNAVAILABLE` | check (`errors:not-found`, `capabilities`) |
| 9 | A cancelled call stops within a second and the process stays usable | check (`abort`); tests (`host.test.mjs`, `host.process.test.mjs`) |
| 10 | A call slower than the timeout is abandoned with `TIMEOUT` | tests (`host.test.mjs`, `host.process.test.mjs`) |
| 11 | An oversized response (over the cap) and an oversized message (over 2 MB) are rejected | tests (`netbroker.test.mjs`, `protocol.test.mjs`, `host.test.mjs`) |
| 12 | Hostile payloads (`__proto__`, `constructor`, deep nesting, `NaN` or `Infinity` strings, zero or negative prices, string volume) are rejected or sanitised | tests (`protocol.test.mjs`, `results.test.mjs`, `host.test.mjs`) |
| 13 | A host outside the list, a redirect to one, `http://`, a private IP and a broker host are refused by the host | check (`network`); tests (`netpolicy.test.mjs`, `netbroker.test.mjs`, `host.test.mjs`) |
| 14 | A canary secret never appears in logs, errors, the environment, argv or any message other than `init` | check (`secrets`); tests (`host.test.mjs`) |
| 15 | No file access beyond the entry file (reading `/etc/hosts`, a sibling file, a symbolic link into the Bridge's data folder, fails with `ERR_ACCESS_DENIED`), a folder with a symbolic link is refused by the loader, and no process can be spawned | tests (`host.process.test.mjs`, real Node process) |
| 16 | A crash mid-call gives `BROKER_UNAVAILABLE` and a clean restart; more than 3 crashes in 10 minutes disables the plugin | tests (`host.test.mjs`) |
| 17 | The same fixture twice gives the same output | check (`deterministic`) |
| 18 | Invalid, missing and unknown config keys are refused before the process starts; defaults are applied | tests (`manifest.test.mjs`, `loader.test.mjs`) |
| 19 | A delayed plugin never claims `realtime`, and is refused for `order` reads | manifest schema; the provider refuses strict purposes; tests (`loader.test.mjs`); the router filters by class |
| 20 | A host fetch is never non-GET unless the manifest says so | tests (`netbroker.test.mjs`) |
| 21 | 1,000 calls without heap growth | **Not automated.** The heap is capped by `--max-old-space-size=128` |
| 22 | A host with another `apiVersion` refuses to load with a clear message | tests (`host.test.mjs`) |
| 23 | Paired broker and plugin fixtures show time-aligned drift under a threshold | **Not automated.** Recommended for any source used as a cross-check |

## 8. A worked example

`examples/source-plugin/` fetches delayed quotes from a placeholder vendor. The vendor answers:

```json
{ "quotes": [ { "symbol": "NSE:RELIANCE", "last": 2891.4, "open": 2880, "high": 2899.9, "low": 2872.1,
                "prevClose": 2875.55, "volume": 4182211, "asOf": "2026-10-19T09:45:00+05:30" } ] }
```

`index.mjs` maps it, passing the vendor's own `asOf` through, and maps failures to plugin codes:

```js
async quotes(symbols, ctx) {
  const res = await ctx.fetch(`https://quotes.example.com/v1/quotes?symbols=${encodeURIComponent(symbols.join(","))}&market=${ctx.config.market}`);
  if (res.status === 429) ctx.fail("RATE_LIMITED", "the vendor asked us to slow down", Number(res.headers["retry-after"] ?? 5) * 1000);
  if (res.status === 404) ctx.fail("NOT_FOUND", "the vendor does not know these symbols");
  if (res.status >= 500) ctx.fail("UNAVAILABLE", `the vendor answered ${res.status}`);
  const body = await res.json();
  return { items: body.quotes.map((q) => ({ symbol: q.symbol, at: Date.parse(q.asOf), fields: { ltp: q.last, open: q.open, high: q.high, low: q.low, close: q.prevClose, volume: q.volume } })) };
}
```

Steps:

```sh
# read examples/source-plugin/mc-source.json and index.mjs first
mc-bridge sources plugins pin   examples/source-plugin    # prints the pin and what you would grant
mc-bridge sources plugins check examples/source-plugin    # RUNS the plugin's code offline; all checks must say OK
# add { "path": "examples/source-plugin", "sha256": "<pin>", "granted": true } to sources.plugins, restart
mc-bridge sources enable example-delayed
mc-bridge sources trace --capability quotes --symbols NSE:RELIANCE
```

The answer then reaches a client as an item with `freshness: { source: "plugin", provider: "example-delayed", class: "delayed",
delaySec: 900, official: false, flags: ["plugin", "unofficial", "delayed"], ... }`.

## 9. Writing a built-in provider

Built-in providers live in `server/bridge/sources/providers/`. They take their `fetch` and clock as arguments so tests inject
fakes, declare `hosts`, build every request with `redirect: "error"` and no cookies, identify themselves honestly in the
User-Agent, and throw classified errors (`fields.kind`). Every one ships with fixtures recorded from the vendor's documented
responses and a test that runs `runProviderConformance`. Use only the vendor's official documentation.

## 10. Versioning

`apiVersion` is an integer major version of the plugin protocol. A breaking change bumps it; the host may speak the previous
major for one release. New optional fields and capabilities are additive. The plugin's own `version` is semantic and is shown
in `GET /v1/sources`.
