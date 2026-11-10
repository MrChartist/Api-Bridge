# How the Bridge handles broker rate limits

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

Every broker API has request limits, and most are tight: often one quote request a second, sometimes one instrument
per call. Ten tools each polling on their own break those limits within seconds. The Bridge sits between your tools
and your brokers and makes the broker see one careful client. It also shares what it has fairly between your tools, and
says plainly why a request was held back. Reads can come from other sources than your brokers too; see
[sources.md](sources.md).

## The read path

For every market-data request, in order:

1. **Live stream.** If any client is streaming the symbol, the latest tick answers the request with
   `freshness.source = "stream"` and no broker call. One broker subscription is shared by every client (ten tools on
   one symbol cost one subscription). Feeds are opened per account, with each broker's subscription caps enforced
   (`SUBSCRIPTION_LIMIT` goes only to the client that crossed the cap).
   An **option chain** whose whole strike window (`strikes=N` around ATM) is live on the stream is built from those
   ticks over the day's broker chain, which supplies the previous-day OI behind OI change (`source = "stream"`, no
   broker call). Every reader of the same window (a dashboard page, your scripts) costs the broker nothing while the stream is up.
   A **quiet strike** (an illiquid far leg that has not traded) does not force a broker read: on a live subscription
   no tick means no trade, so its last tick is used while the feed is ticking now, the tick came on the current
   connection and it is at most `market.quietLegMaxAgeMs` old (60 s by default, 0 turns it off). Such legs carry
   `tickAgeMs`, and `freshness.quiet` counts them (`asOf` stays that of the live legs and the spot).
2. **Freshness cache.** A value younger than its freshness target is reused (`source = "cache"`). Defaults: LTP 1 s,
   quote 2 s, depth 1 s, option chain 3 s, expiries 5 min, history 1 min. Tighten them freely in `market.freshness`;
   they can be loosened only up to documented maximums. A caller may ask for fresher data with `maxAgeMs`.
3. **Coalescing.** Requests for the same thing that arrive while a broker call is in flight join that call instead
   of making their own. Twenty clients asking for the same price at the same moment make **one** broker call.
4. **Batching.** Symbols requested within a short window (25 ms by default) are combined into one call, up to the
   broker's documented batch size (for example 500 instruments per Kite quote call). A batch belongs to one API key (or
   tool): two keys asking for different symbols in the same moment make two calls, not one. That costs a few calls
   and keeps a light reader from waiting in a heavy reader's place in the queue. The same symbol asked by both
   still shares one call (step 3).
5. **Scheduling.** The call waits for budget in the account's token bucket for that endpoint class, in a fair queue
   (below).

When a read can also be answered by a source other than your own broker accounts (a free data source you switched on),
the Bridge's router decides which one, and a trace can show why. Streams and the cache always come first, and a
source never answers an order, risk check, paper fill or alert. See [sources.md](sources.md).

## Token buckets and priorities

- One bucket per **(account, endpoint class)**: `order`, `quote`, `depth`, `history`, `chain`, `portfolio`, `master`,
  `other`, with per-second, per-minute and per-IST-day windows as the broker documents them. Some brokers share one
  budget across several classes; that is modelled as a group bucket.
- Numbers come from the policy table, [server/bridge/ratelimit/brokerPolicies.mjs](../../server/bridge/ratelimit/brokerPolicies.mjs):
  one entry per broker, each figure with the URL of the broker's documentation and a `verified` flag. Anything not
  documented gets conservative defaults.
- Config (`ratelimit.brokers`, `ratelimit.accounts`) may only **lower** limits. A broker override above the table
  is a config error, so a typo cannot quietly raise a limit.
- Priority: `order` > `live` > `interactive` > `background`, with ageing so background work (instrument masters)
  still finishes under load. An order is never stuck behind reads.
- When a broker answers "too many requests", that account's budget pool backs off (below); other accounts carry on.

## Sharing fairly between your tools

Inside each priority, the queue shares the budget between **consumers**, one per API key (background jobs count as one
consumer each), instead of serving requests in arrival order. Each consumer has a **weight**, taken from the kind of
key (`ui` 4, `mcp` 2, `excel` 1, `script` 1, `other` 1, changeable under `ratelimit.client.kindWeights` or per key).
When two consumers compete, they get shares in proportion to their weights; when only one is asking, it gets everything.
So a spreadsheet that fires 500 requests waits behind an AI assistant's single question rather than in front of it.
Orders still go first: they are in a lane of their own.

Limits on one consumer: at most `queue.maxQueuedPerConsumer` (200) requests waiting, and while others also wait, half
the account's in-flight calls. When the queue is full the newest request of the biggest consumer is dropped, not
everyone's.

## When a broker says "too many requests"

A 429 from a broker pauses the whole **pool** that shares that budget (the classes of one account that share one
bucket), for the time the broker asks (`Retry-After`), else 1 s, 2 s, 4 s and so on up to `backoff.maxMs`, plus up to
250 ms of random jitter so tools do not return together. The Bridge never retries a throttled call itself.

After a throttle the Bridge also trusts its own table less. Each pool has a **scale** below the documented ceiling. A
throttle halves it (never below a quarter), and every clean minute with traffic gives back 5 percent. If the same pool
is throttled three times in an hour, it stays 20 percent below where it was for a day, and a warning says the table
figure is probably too high. The scale only lowers limits, never raises them above the policy, and lives in memory only.

## When the budget runs out

The Bridge never bursts past a limit. Instead:

- a cached value older than its target may be served, **labelled** `"stale": true` (up to `market.stale.maxStaleMs`,
  60 s by default; depth never older than 5 s);
- a symbol that could not be fetched in time is reported in `errors[]` with `UPSTREAM_RATE_LIMITED` and
  `retryAfterMs`, while the other symbols in the request are still answered;
- a request that cannot start before its deadline gets `429` with `Retry-After`.

**A refusal says whose limit it was.** Every 429 carries `scope`, `retryAfterMs` (the real wait) and `limit`
(`{ name, remaining, resetMs }`, the budget that said no):

| `scope` | Code | Meaning | What to do |
|---|---|---|---|
| `client` | `RATE_LIMITED` | This API key used up its own rate, its daily cap or its requests in flight | Slow this tool down, or raise its quota |
| `consumer-cap` | `RATE_LIMITED` | This key already has too many requests waiting for the broker | Send fewer at once |
| `queue` | `UPSTREAM_RATE_LIMITED` | The shared queue for that account is full | Try again shortly |
| `upstream` | `UPSTREAM_RATE_LIMITED` | The broker's budget cannot serve the request in time | Wait `retryAfterMs`, or use a cache or stream |

`Retry-After` is the same wait in whole seconds, rounded up with 0 to 25 percent added so waiting clients do not all
return in the same second. Clients should read the fields, not the text.

## Spreading reads across your own accounts (pooling)

If you have several accounts (at one broker or several), unpinned read-only market data can use the budgets of all of
them. This is called pooling. It is **off by default**, and turning it on is a decision you make, with your eyes open.

**What pooling is and is not.** It spreads quotes, option chains and history calls over your own accounts, so each
account's rate limit is used. It never moves an order: orders always go through the account they belong to, from that
account's own registered static IP. It never shares credentials, and it never mixes accounts of different people.

**Where the brokers stand.** No broker's published terms clearly allow pooling, and none clearly forbids it. Some say
things that could matter: Kotak and Shoonya say credentials are for the client's own use, Fyers bars use of its APIs
"by any third party", Motilal forbids using several keys to get around its order limit (a rule about orders, not
reads). The per-broker findings are in [BROKERS.md](../BROKERS.md#what-the-brokers-terms-say-about-pooling) and in
`poolingNote` on each entry of the policy table. You are responsible for following your brokers' terms. **A legal read
is recommended before you turn pooling on.**

An account takes part only when **all** of these hold:

1. it opts in: `"marketData": { "pooling": true }`;
2. it names its `holder` (`"self"`, `"spouse"` ...). Only accounts of **one** holder are ever pooled together;
3. the broker's policy entry says `pooling: "allowed"`, **or** the entry is `"unknown"` and the account also sets
   `"poolingWhenTermsUnknown": true`. A broker whose entry says `"not-allowed"` is never pooled;
4. **you have accepted the pooling notice for that account.** The notice is returned by
   `GET /v1/pooling` (the dashboard shows the same text). Accepting records `{ acceptedAt, version, accounts }` in `pooling/consent.json` in your data
   folder. A consent covers only the accounts you named, and it stops counting if the notice text changes (its version
   changes) until you accept the new text.

Today every broker's entry is `"unknown"`, so pooling needs both flags in the config file **and** your consent:

```json
{ "id": "upstox-main", "broker": "upstox",  "holder": "self", "marketData": { "pooling": true, "poolingWhenTermsUnknown": true } },
{ "id": "angel-main",  "broker": "angelone", "holder": "self", "marketData": { "pooling": true, "poolingWhenTermsUnknown": true } }
```

```bash
# read the notice and see which accounts could pool
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:4300/v1/pooling
# accept it for two accounts of one holder (admin key, from this computer)
curl -X PUT -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{ "acknowledge": "pooling-1", "accounts": ["upstox-main", "angel-main"] }' \
  http://127.0.0.1:4300/v1/pooling/consent
# turn it off again; pooling ends on the next read
curl -X DELETE -H "Authorization: Bearer $ADMIN_KEY" http://127.0.0.1:4300/v1/pooling/consent
```

The notice you accept says, in plain words: pooling spreads read-only market-data calls across your own accounts; no
broker's published terms clearly allow or forbid it; you are responsible for your brokers' terms; orders always go
through the account they belong to from its own registered IP; where a broker needs a paid data plan every pooled
account needs one; and you can turn it off at any time. Consent is refused for accounts of different holders, unknown
accounts, paper accounts and brokers marked `not-allowed`. Accepting and revoking are written to the audit log.

The consent is one record for the whole Bridge. An admin key **limited to some accounts** can only change its own part of it:
accepting adds the accounts it names to the record (the others stay), and revoking removes only the accounts it may use and
deletes the record only when none are left. An unrestricted admin key (or this computer's control token) replaces or removes
the whole record. A limited key is never shown the other accounts.

**Paid data plans.** Some brokers charge for live data: Zerodha (Connect, Rs 500 a month per app), Dhan (Data API,
Rs 499 plus tax a month) and Groww (paid plan, Rs 499 plus tax a month). A pooled account without the plan cannot
serve live reads, and every pooled account needs its own plan. The policy table records this as `dataEntitlement`
(`free`, `paid`, `paid-for-live` or `unknown`, with a note and a source), and `mc-bridge doctor` warns about it.

What pooling does once it is on:

- **Many-symbol quote reads are split.** A request for 200 symbols is cut into each broker's batch size and every
  chunk goes to the pooled account with the most spare quote budget, so two accounts answer roughly twice as fast.
  An account in broker back-off gets no share.
- **Single reads** go to the pooled account with the most headroom.

`GET /v1/accounts` shows the effective `pooling` value per account (false until the consent covers it). `GET
/v1/pooling` shows, per holder, each account's broker policy, whether it opted in, whether the consent lists it and
whether it is pooled right now. Revoking the consent ends pooling on the very next read. Orders and portfolio reads are
never pooled, credentials are never shared, and accounts of different people are never pooled.

`mc-bridge doctor` checks the setup: it warns when an account is set to pool but has no consent (or only a consent for
an older notice), when a pooled account needs a paid data plan, when pooled accounts have different holders or none,
and when a broker's terms are unknown and `poolingWhenTermsUnknown` is not set.

## Broker plans (Fyers)

Some brokers have plans with different limits. Fyers has Standard (free: data calls 5 a second, 50 a minute and 5,000
a day, a live feed of 100 symbols) and Prime (paid: 10 a second, 500 a minute, 5,00,000 a day, 5,000 symbols), in
force since 16 October 2026. The Bridge assumes the lower plan. If you have Prime, say so per account:

```json
"ratelimit": { "accounts": { "fyers-main": { "tier": "prime" } } }
```

or for every account of the broker with `"brokers": { "fyers": { "tier": "prime" } }`. This is a choice among the
broker's documented plans, not an override that may only lower limits: pick Prime only if you have it, because the
Bridge cannot check your plan. An unknown plan name is refused for a broker entry, and for an account it falls back to
the lower plan. Limits you set under `brokers` or `accounts` still can only lower the figures of the plan you chose.

## Your own budget: quotas per key

Every API key has its own quota, so one runaway script cannot starve the others:

- `perSecond` and `burst`: a token bucket (default 50 a second);
- `perDay`: an optional cap on requests per IST day (no cap by default);
- `weight`: its share of a busy broker queue (see above);
- a cap on requests in flight at once (`ratelimit.client.maxConcurrent`, 64).

Set defaults for all keys under `ratelimit.client`, and per key under `ratelimit.client.keys.<keyId>`. You can also
change one key while the Bridge runs, from the dashboard (Sources, Quotas) or with an admin key from this computer:

```bash
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:4300/v1/quotas            # every key: its numbers, usage and where they come from
curl -X PUT -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{ "perSecond": 5, "burst": 10, "perDay": 20000, "weight": 2 }' http://127.0.0.1:4300/v1/quotas/<keyId>
curl -X DELETE -H "Authorization: Bearer $ADMIN_KEY" http://127.0.0.1:4300/v1/quotas/<keyId>   # back to config or default
```

An override is kept in `quotas.json` in the data folder and sits above the config. Unlike broker limits, which a config
may only lower, a key's quota may be raised or lowered by you: it protects the Bridge from its own callers, not a
broker from the Bridge. Every response carries `RateLimit` and `RateLimit-Policy` headers (IETF draft format).

**Bounds.** A quota (in the config, or set through the API) takes finite numbers from 0.01 to 10,000 requests a second (one
request every 100 seconds at the least), a burst of 1 to 100,000 (a whole number), 1 to 100,000,000 requests a day (or `null`
for no daily cap) and a weight of 1 to 16. Anything else, including `NaN`, a negative number, a string or a rate like `1e-7`
that would lock a key out for months, is refused. The **only active admin key** may not be given less than 1 request a second
and 1,000 a day: a quota applies to the key, so one that is too small could lock you out of the API. **If a key is ever locked
out**, this computer's control token is not subject to any quota: run `mc-bridge` on this computer (the dashboard opened with
`mc-bridge open` works too) and delete the override (`DELETE /v1/quotas/<keyId>` as a local caller), or edit or remove
`quotas.json` in the data folder while the Bridge is stopped.

## Asking for less: stale-while-revalidate and prefetch priority

- `?swr=true` on `/v1/ltp`, `/v1/quotes` and `/v1/optionchain`: when only an older cached value exists (inside
  `market.stale.maxStaleMs`), it answers at once with `freshness.stale: true` and `freshness.revalidating: true`, and one
  refresh runs behind it (however many readers ask). The next read gets the fresh value from the cache.
- `?priority=background`: a prefetch. It waits behind every interactive read; a person's click on the same thing joins
  it and raises its priority. The dashboard prefetches this way when you hover a menu item or an expiry chip.

## Seeing it work

```bash
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:4300/v1/limits                 # effective policy per broker, your key's budget
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/limits?explain=1"     # + the shared pools and who is waiting
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:4300/v1/usage                  # per account and class: used, queued, back-off; savings
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/usage?series=1"       # + calls per second over the last two minutes
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/usage?view=budget"    # the dashboard's budget summary
```

`savings` counts the broker calls avoided today: served from stream, served from cache, coalesced and batched. Each
class lists every window (`windows`: this second, this minute, today) with what it holds now. Admin keys also get
`consumers`: today's broker calls and saved calls per dashboard page, API key (by label), MCP, Excel / compat and
background jobs.

`explain=1` adds, in numbers instead of log lines, why a request may have been slow or refused: `pools` (each budget
pool's accounts, spare room, ceiling, current scale and back-off, throttles in the last hour) and `consumers` (who is
queued or in flight and each one's share), plus `you`, your own key's quota and use. Other keys appear only to admin keys.

The dashboard shows the same figures. The **API** capsule in the top bar shows this second and this minute against the
limit, the stream and the calls saved today (fed by `budget` messages on the stream, op `subscribe_budget`). The
**Sources** page has the rest: **Overview** (how each source and account is doing, recent requests with what answered
each one, and a "Why this source?" check), **Providers** (switch sources on and off, keys, notices) and **Quotas** (each
key's share, with presets and usage). Recent requests are also `GET /v1/requests` on this computer; a market read there
carries `route`, a short record of what answered it (stream, cache, a shared call, a live call, or a stale value, with the
source, its data class and delay).
