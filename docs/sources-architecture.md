# Data sources, routing and quotas

The Bridge answers market-data reads from more than one place and says honestly where each answer came from.
This page is the design every part of that system follows. The code is the source of truth; this is the map.

## Goals

1. **Use every legitimate source a person has.** A trader often holds two to four broker accounts. Each broker API has
   tight limits. The Bridge can spread read-only market-data calls across one person's own accounts, add optional free
   sources, and keep every tool inside the limits.
2. **Never mislead.** A delayed or end-of-day value must never look real-time. Every answer carries its source, data
   class, delay and confidence. Orders, risk checks, paper fills and alerts accept only trusted real-time data.
3. **Stay fair.** One runaway spreadsheet must not starve an AI assistant. Each API key and tool gets its own quota.
4. **Be extendable.** A new source is a small, read-only module with a manifest. It never sees broker credentials and
   never touches order code.

## What a source is

A source answers read-only questions: `quotes`, `history`, `expiries`, `optionChain`. It is described by a descriptor
(see `server/bridge/sources/contract.mjs`): id, name, kind (`broker`, `free`, `plugin`), tier, data class, delay,
whether it is official, capabilities, documented limits and terms.

| Tier | Meaning | Default |
|---|---|---|
| `builtin` | The user's own broker accounts | on |
| `byok` | Bring your own key: the user holds the vendor account and accepts the vendor's terms | off until a key is set |
| `opt-in` | Works without a key but is unofficial or terms-sensitive | off until the user acknowledges a notice |
| `plugin` | Third-party code the owner explicitly granted | off until granted |

There is no free, official, redistributable real-time or option-chain source for Indian markets. Real-time data and
option chains come from the user's own broker. Free sources are for history, cross-checks and graceful fallback, and
they are labelled `delayed` or `eod`, never blended into a real-time answer.

## Data class on every answer

Every freshness record carries `class` (`realtime`, `delayed`, `eod`), `delaySec`, `official`, `confidence` and `flags`.
One item has one source and one timestamp. A composite answer (an option chain, a many-symbol quote) takes the least
current class of its parts. `stale` (older than its freshness target) and `delayed` (the source is slow by nature)
are different labels.

Reads made for `order`, `risk`, `paper` or `alert` purposes accept only `realtime` sources. A read that names no purpose
is a `display` read (right for the public market routes, which may show a labelled-stale cached value), so code inside the
Bridge states its purpose: the order service reads with `order`, the paper engine with `paper`, and both refuse to price
from anything labelled stale, delayed, end of day, unofficial or from a source. The compat API and the spreadsheet routes
never use backup sources at all: their answers have no field for the data class. A caller's `maxAgeMs` also
filters: a source whose delay exceeds it cannot answer.

## Routing

For an unpinned read the router builds a candidate list from the user's pooled broker accounts and the enabled sources,
then:

1. **Hard filters:** capability, data class against purpose and `maxAgeMs`, pooling consent, circuit breaker state,
   the caller's deadline.
2. **Score** the rest by spare budget, error rate and latency, and pick the best. At most two sources are tried per
   request, so failover is the retry.
3. **Budget:** each source has a pseudo account id so the existing scheduler budgets it like a broker account.

Order of preference inside a read is unchanged: live stream, then freshness cache, then coalesced and batched calls,
then the scheduled call. Sources only add candidates; they never skip the cache.

Health is tracked with time-decayed averages of latency and errors. A source is ejected after repeated hard failures,
retried after a cooldown that doubles up to five minutes, and a 429, an auth error or a not-found never trips it.

## Limits and quotas

- **Upstream:** a budget per account and per endpoint class from the policy table, with per-second, per-minute and
  per-day windows. The limiter backs off adaptively below the documented ceiling after a 429 and recovers slowly. A 429
  backs off the whole shared bucket group, with jitter.
- **Per client:** every API key has a token-bucket quota and a weight. The queue shares capacity fairly between keys
  inside each priority lane, so a flood from one key waits behind other keys' requests.
- **Refusals say why:** a refused request names the scope that tripped (`client`, `upstream`, `queue`,
  `consumer-cap`), the limit and when to retry.

## Pooling

Pooling spreads reads across one person's own accounts. It is off by default. Turning it on needs an explicit consent
that names the risk: no broker's published terms clearly allow it, and none clearly forbids it. Only accounts of one
holder are ever pooled, only read-only market data is pooled, and orders always go through the account they belong to,
from its own registered static IP. A broker whose policy says `not-allowed` is never pooled.

## Plugins

A plugin is a read-only data source in its own process, speaking JSON lines to the Bridge. The Bridge brokers all of
its network access against a host allow-list from its manifest, passes it no credentials and no environment, pins its
files by hash, enforces call timeouts and restarts it a limited number of times. Order code never imports a plugin.
Node's permission flags are an extra layer, not the boundary.

## Terms and licensing

Each source states the vendor's terms in its descriptor and the dashboard shows them before a source is enabled.
Opt-in sources need the user to acknowledge a versioned notice. The Bridge does not redistribute fallback data and the
dashboard says so. Anyone shipping this to others should get a legal read on exchange data rules.
