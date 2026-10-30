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
   broker call). The dashboard's chain, OI and Strategy pages subscribe their legs, so their refreshes, and every other
   reader of the same window (the recorder, your scripts), cost the broker nothing while the stream is up.
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

## Spreading reads across your own accounts

If you have several accounts (at one broker or several), unpinned read-only market data can use the budgets of all of
them. An account takes part only when:

1. it opts in: `"marketData": { "pooling": true }`;
2. it names its `holder` (`"self"`, `"spouse"` ...). Only accounts of **one** holder are ever pooled together;
3. the broker's policy entry says `pooling: "allowed"`, **or** the entry is `"unknown"` and you opt in to that as
   well with `"poolingWhenTermsUnknown": true`. A broker whose entry says `"not-allowed"` is never pooled.

Today every broker's entry is `"unknown"` (needs verification against each broker's terms), so pooling happens only
for accounts where you set both flags yourself:

```json
{ "id": "dhan-main",  "broker": "dhan",    "holder": "self", "marketData": { "pooling": true, "poolingWhenTermsUnknown": true } },
{ "id": "kite-main",  "broker": "zerodha", "holder": "self", "marketData": { "pooling": true, "poolingWhenTermsUnknown": true } }
```

What pooling does:

- **Many-symbol quote reads are split.** A request for 200 symbols is cut into each broker's batch size and every
  chunk goes to the pooled account with the most spare quote budget, so two accounts answer roughly twice as fast.
  An account in broker back-off gets no share.
- **Single reads** go to the pooled account with the most headroom.
- **Scans** ([scanner.md](scanner.md)) run one worker pool per pooled account, each pinned to its account and as
  wide as that account's history budget, all pulling from one queue.

`GET /v1/accounts` shows the effective `pooling` value per account. Orders and portfolio reads are never pooled,
credentials are never shared, and accounts of different people are never pooled. Read your brokers' API terms before
turning this on: it is your decision, made in the config file only.

## When no broker can answer: backup data

With `"backup": { "enabled": true }`, an unpinned read that no broker account can answer (none connected, session
expired, broker down, budget gone) is served from free public sources instead and labelled `source: "backup"`. See
[backup-data.md](backup-data.md).

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
`consumers`: today's broker calls and saved calls per dashboard page, API key (by label), MCP, Excel / compat, the
recorder and Live events.

The dashboard shows the same figures: the **API** capsule in the top bar (this second and this minute against the
limit, the stream, calls saved today; fed by `budget` messages on the stream, op `subscribe_budget`), and
**API › Rate limits** (a live calls-per-second chart against the limit, and Top consumers). Measurements of what this
saves are in [docs/perf/baseline.md](../perf/baseline.md).
