# How the Bridge handles broker rate limits

Every broker API has request limits, and most are tight: often one quote request a second, sometimes one instrument
per call. Ten tools each polling on their own break those limits within seconds. The Bridge sits between your tools
and your brokers and makes the broker see one careful client.

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
4. **Batching.** Symbols requested by different clients within a short window (25 ms by default) are combined into
   one call, up to the broker's documented batch size (for example 500 instruments per Kite quote call).
5. **Scheduling.** The call waits for budget in the account's token bucket for that endpoint class, in a priority
   queue.

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
- When a broker answers "too many requests", only that account and class back off; the rest carry on.

## When the budget runs out

The Bridge never bursts past a limit. Instead:

- a cached value older than its target may be served, **labelled** `"stale": true` (up to `market.stale.maxStaleMs`,
  60 s by default; depth never older than 5 s);
- a symbol that could not be fetched in time is reported in `errors[]` with `UPSTREAM_RATE_LIMITED` and
  `retryAfterMs`, while the other symbols in the request are still answered;
- a request that cannot start before its deadline gets `429` with `Retry-After`.

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

## Your own budget

Each API key has its own request budget (`ratelimit.client.perSecond`, 50 by default, per key overrides allowed), so
one runaway script cannot starve the others. Every response carries `RateLimit` and `RateLimit-Policy` headers
(IETF draft format).

## Asking for less: stale-while-revalidate and prefetch priority

- `?swr=true` on `/v1/ltp`, `/v1/quotes` and `/v1/optionchain`: when only an older cached value exists (inside
  `market.stale.maxStaleMs`), it answers at once with `freshness.stale: true` and `freshness.revalidating: true`, and one
  refresh runs behind it (however many readers ask). The next read gets the fresh value from the cache.
- `?priority=background`: a prefetch. It waits behind every interactive read; a person's click on the same thing joins
  it and raises its priority. The dashboard prefetches this way when you hover a menu item or an expiry chip.

## Seeing it work

```bash
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:4300/v1/limits              # effective policy per broker, your key's budget
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:4300/v1/usage               # per account and class: used, queued, back-off; savings
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/usage?series=1"    # + calls per second over the last two minutes
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4300/v1/usage?view=budget" # the dashboard's budget summary
```

`savings` counts the broker calls avoided today: served from stream, served from cache, coalesced and batched. Each
class lists every window (`windows`: this second, this minute, today) with what it holds now. Admin keys also get
`consumers`: today's broker calls and saved calls per dashboard page, API key (by label), MCP, Excel / compat and
background jobs.

The dashboard shows the same figures: the **API** capsule in the top bar (this second and this minute against the
limit, the stream, calls saved today; fed by `budget` messages on the stream, op `subscribe_budget`), and
**API › Rate limits** (a live calls-per-second chart against the limit, and Top consumers).
