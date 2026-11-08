# Data sources: where prices come from, and how the Bridge labels them

Your broker accounts are the Bridge's main source of market data. They give real-time prices and option chains, and they
are the only sources that orders, risk checks, paper fills and alerts use. The Bridge can also read from optional free
sources and from plugins you add. Those are slower or less certain, so every answer from them says so.

This guide is for people who use the Bridge. If you are writing a source, read [source-contract.md](../source-contract.md).

## What you get from each kind of source

| Kind | What it is | Is it on? |
|---|---|---|
| **Your broker accounts** (`builtin`) | Real-time prices, option chains, history, from your own login | Always on |
| **Bring your own key** (`byok`) | A data vendor where you hold the account and paste its API key | Off until you save a key and turn it on |
| **Opt-in** (`opt-in`) | Works without a key, but is unofficial or has strict terms | Off until you read a notice and say yes |
| **Plugin** (`plugin`) | Code someone else wrote, that you reviewed and approved | Off until you approve it |

There is no free, official source of real-time Indian market data that you may redistribute. Real-time prices and option
chains come from your broker. The other sources are for history, for a second opinion on a price, and for filling in
when no broker account can answer. They are labelled `delayed` or `eod` and are never mixed into a real-time answer.

## What the labels mean

Every price, candle and option chain the Bridge returns says where it came from. In the API this is the `freshness`
object; the dashboard shows the same words on a badge.

```json
"freshness": {
  "source": "backup",
  "provider": "yahoo",
  "asOf": "2026-10-19T09:45:00+05:30",
  "ageMs": 61000,
  "stale": false,
  "class": "delayed",
  "delaySec": 900,
  "official": false,
  "confidence": "low",
  "flags": ["unofficial", "delayed"]
}
```

| Label | What it means for you |
|---|---|
| `class: "realtime"` | From your own broker, or its live feed. Safe to act on. |
| `class: "delayed"` | The source is slow by nature, usually about 15 minutes. `delaySec` says how many seconds. The price is a real price from the past. |
| `class: "eod"` | End of day. You get yesterday's close, not today's price. |
| `official: false` | Not a documented API from the data's owner. It may change or stop without notice, and its terms may not allow what you do with it. |
| `confidence` | `high` for broker data. Lower for delayed, end-of-day, unofficial or flagged data. |
| `flags` | Extra warnings, for example `unofficial`, `delayed`, `eod`, `plugin`, `last-bar-provisional` (the newest candle is still forming). |
| `stale: true` | The value is older than the freshness target for that read. This is separate from delayed. |

**Delayed is not the same as stale.** A quote from a 15-minute source is `delayed`. It is not `stale` if you asked for
data that old. A broker quote that is two minutes old when you wanted two seconds is `stale` but still `realtime`.

**One value comes from one source, with one timestamp.** The Bridge never fills a missing bid from another source or
averages two sources. An option chain or a many-symbol quote takes the least current class of its parts, so one delayed
leg makes the whole chain `delayed`.

Excel and Google Sheets formulas see only the body of the answer, not headers, so the label is always in the body.

## Turning a source on

You need an admin key, or the dashboard.

**On the dashboard:** open Sources, then Providers. Each source shows what it gives, its limits, its terms and its
health. Turn it on there. For a source that needs a key, paste the key first. For an opt-in source, read the notice; saying
yes records the notice version and the time.

**From the command line:**

```sh
mc-bridge sources list                       # what exists, what is on, how each is labelled
mc-bridge sources set-key twelvedata         # asks for the key with hidden input (or reads it from stdin)
mc-bridge sources test twelvedata            # one small call to check the key and the vendor
mc-bridge sources enable twelvedata          # byok: needs the key first
mc-bridge sources enable yahoo               # opt-in: prints the notice and does nothing yet
mc-bridge sources enable yahoo --acknowledge yahoo-1   # after you read it: the version printed above
mc-bridge sources disable yahoo
```

`set-key` takes only the source id. A key typed after it (`set-key twelvedata MYKEY`) is refused, because it would sit in your
shell history. Commands that need an admin key read `MCB_ADMIN_KEY` (or `MCB_API_KEY`) from the environment; `--key <key>` still
works but prints a warning for the same reason.

Keys are never taken from the command line, so they do not end up in your shell history. They are stored encrypted on this
computer, never written to `bridge.config.json`, and never shown again, not even by the API.

If the notice changes, its version changes and you are asked again.

## The built-in sources

| Source | Kind | Gives | Limits the Bridge keeps to | Read this first |
|---|---|---|---|---|
| Yahoo Finance | opt-in | Delayed quotes and history | 1 a second, 60 a minute | Unofficial. Yahoo's terms restrict automated access, so use it only for your own cross-checks. |
| Alpha Vantage | byok | End-of-day history and quotes | 5 a minute, 25 a day on the free key | Daily data only; intraday needs a paid plan. |
| Twelve Data | byok | End-of-day history and quotes | 8 a minute, 800 a day | Indian exchange data needs a paid plan; a free key is refused for Indian symbols. |

The numbers are the vendors' documented limits (or conservative figures where a vendor publishes none). The Bridge never
asks for more. Each notice shows the vendor's terms link and what you accept; the dashboard shows it before you turn a
source on. You are responsible for having the right to use a vendor's data.

In demo mode the Bridge also offers `demo-delayed` and `demo-eod` with sample data, so you can see every label without
a real source.

## When the Bridge uses a source

For a read that is not pinned to one account, the Bridge looks at the candidates and picks one:

1. It drops sources that cannot do the job: wrong capability, data too old for what you asked (`maxAgeMs`), not allowed for
   the purpose, circuit breaker open.
2. It prefers the candidate with the most spare budget, the lowest error rate and the lowest latency. It tries at most two
   candidates per request, so a failover is the retry.
3. Your live stream and the freshness cache are always tried first. Sources only add candidates; they never skip the cache.

**Purposes.** A read may say what it is for with `purpose`: `display` (default), `analysis`, `alert`, `paper`, `risk` or
`order`. The last four accept only real-time data from your own broker. A delayed or end-of-day source is never used for
them, whatever you configured, and neither is a cached value that has gone stale. Orders go through the account they belong to;
no source ever influences that.

The default, `display`, is for the public market routes: a `display` read may be answered from a cached value that is older
than its freshness target (labelled `stale: true`) when your broker's budget is used up, and from a backup source if the read
allows one. So code inside the Bridge never relies on the default. The order service (price band, market protection, strike
choice) reads with `purpose: "order"`, the paper engine with `"paper"`, and both check the label on what comes back: a value
that is stale, delayed, end of day, unofficial, from a source or unlabelled is not used as a price. A test scans the order,
paper, safety and compat code and fails if a market-data call there does not state its purpose.

**`maxAgeMs`.** If you ask for data no older than 2 seconds, a 15-minute source cannot answer, and you get your broker's
answer or an error, not a delayed price pretending to be fresh.

**Fallback.** When no broker account can answer (all logged out, all at their limit), the Bridge can answer from an
enabled source instead, but only if you allow it: `"sources": { "autoFallback": true }` in the config, or `backup=true` on
one request. It is off by default. The answer carries the labels above, so you can tell.

A source that keeps failing is paused for a while (the Sources page says "Paused" and when it will be tried again),
and tried again after a cooldown that grows up to five minutes. A rate-limit answer, a bad key or an unknown symbol does
not pause it. A plugin that crashes is shown with its own reason.

To see why a source was or was not used, ask for a trace. It is a dry run: nothing is fetched.

```sh
mc-bridge sources trace --capability quotes --symbols NSE:RELIANCE --purpose display
```

```
Request: quotes NSE:RELIANCE, purpose display

CHOSEN    dhan-main              best spare budget (score 0.91, spare 0.8)
SKIPPED   yahoo                  delayed data cannot meet maxAgeMs 2000

Class of the answer: realtime. Served by your broker.
This was a dry run: no source was called.
```

## Seeing what answered a request

On the Sources page, **Overview** lists recent requests with a line for each: "answered from Dhan", "served from cache",
"used Yahoo, delayed 15 min". The same record is on `GET /v1/requests` (this computer only) as `route`:
`from` (`stream`, `cache`, `shared`, `live` or `stale`), the source and its name, the data class and the delay. For a
read of many symbols it is a summary, the least current verdict, never a list per symbol. The answer to the request
itself carries the full `freshness` label.

## How pooling and quotas fit

- **Pooling** spreads read-only market-data calls over your own accounts of one holder. It is separate from sources, off by
  default, and needs your consent (`GET /v1/pooling`, or the Sources page) because no broker's published terms clearly
  allow it. It never touches orders. See [rate-limits.md](rate-limits.md).
- **Source budgets.** Each source has its own budget from its documented limits, kept apart from your broker budgets. A
  free source never uses up your broker's request allowance, and a broker 429 does not slow a source.
- **Quotas.** Each API key has its own request quota and a weight in the queue, so one runaway spreadsheet cannot starve an
  AI assistant. A refusal says which limit tripped (`scope`: `client`, `upstream`, `queue` or `consumer-cap`) and when to
  try again. The dashboard (Sources, Quotas) and `GET /v1/quotas` show every key's share. `GET /v1/limits?explain=1` shows
  the shared pools and who is waiting.

## Plugins

A plugin is a read-only data source written by someone else, for example a vendor the Bridge has no built-in support for.
A plugin can answer quote, history, expiry and option-chain questions. It cannot place orders, log in, or see your
accounts, balances, positions or keys. Its data is always labelled `delayed` or `eod`, `official: false`, with the flag
`plugin`.

Treat a plugin as code you run on your computer, because it is. The Bridge limits what it can do:

- it runs in its own process with an empty environment, so it sees none of the Bridge's settings or secrets;
- all of its network access goes through the Bridge, and only to the https hosts its manifest lists and you approved;
- its files are pinned by hash, and a changed file is refused until you approve the change;
- it has call timeouts and request limits, and is stopped if it misbehaves.

These limits are real but not a complete sandbox. Node.js cannot stop a determined plugin from opening its own network
connection, and **a plugin runs as your user, so it can also send signals to the Bridge, for example kill it** (no setting
inside the Bridge can block that). Only use plugins whose code you have read or whose author you trust. If you must run one you
trust less, run it as another user (see "Running plugins as another user" below) or inside a container. [source-contract.md](../source-contract.md)
explains exactly what is and is not enforced.

To add one, in this order:

1. **Read** `mc-source.json` and the entry file (`index.mjs`). The folder may not contain symbolic links; the Bridge refuses it if it does.
2. **Pin** it: `mc-bridge sources plugins pin ./my-plugin` prints what you would grant (the hosts it may reach, its limits, its
   terms, the two files to read) and the pin.
3. Optionally **check** it: `mc-bridge sources plugins check ./my-plugin` runs its conformance checks offline. **`check` runs the
   plugin's code** on your computer (in the same restricted process and with a scripted network, but it is still its code), which
   is why it comes after you have read the files and pinned them, not before.

Then add it to the config:

```json
"sources": {
  "plugins": [
    { "path": "./my-plugin", "sha256": "<the pin>", "granted": true }
  ]
}
```

**Running plugins as another user.** If the Bridge runs as root on Linux or macOS (for example in a container or a service), you
can start every plugin as an unprivileged user so it cannot signal or kill the Bridge:

```json
"sources": { "pluginUser": { "uid": 1500, "gid": 1500 } }
```

The user must be able to read the plugin's folder. It is optional and never required. If it is set and the Bridge may not switch
user (it does not run as root, or the system is Windows), the plugins are **not started** and the log says why; they are never
quietly started with the Bridge's own privileges. A plugin is also never run as root. A plain desktop install runs as your own
user and cannot do this.

**If the Bridge was killed.** When the Bridge stops normally, on Ctrl+C or on a termination signal, it stops its plugin processes.
A forced kill of the Bridge (`kill -9`, the task manager's "end task", the out-of-memory killer) cannot clean up, and a plugin
stuck in a busy loop does not notice its connection closing, so it can keep running and using CPU. Find and stop it:

```sh
pgrep -af "plugin/child.mjs"      # Linux and macOS: lists the plugin processes
kill <pid>                        # then kill -9 <pid> if it stays
```

On Windows, look in Task Manager for `node.exe` processes whose command line contains `plugin\child.mjs`.

A plugin may have settings of its own; put them in a `config` object on its entry (the plugin's manifest says which keys
it takes, and a bad value stops it from loading). Never put a key there: a plugin's API key is saved from the Providers
tab like any other.

Restart the Bridge, then turn the plugin on like any other source. A plugin you granted but did not switch on is listed
as off. If you or anyone edits the plugin later, the Bridge
refuses it until you run `pin` again and update the line. A plugin that crashes four times in ten minutes is switched off,
and the reason shows in its health on the Sources page.

## Configuration

```json
"sources": {
  "autoFallback": false,
  "timeoutMs": 5000,
  "pluginUser": { "uid": 1500, "gid": 1500 },
  "providers": { "yahoo": { "enabled": false } },
  "plugins": [{ "path": "./my-plugin", "sha256": "<the pin>", "granted": true, "config": {} }]
}
```

`pluginUser` is optional (see above). `autoFallback` is off unless you set it. `timeoutMs` is how long one call to a source may take (100 to 15000, 5000 by
default). `"enabled": false` under `providers` keeps a source off whatever the dashboard says. Whether a source is on, and the notices you acknowledged, are kept by the Bridge in
its data folder; use the dashboard or `mc-bridge sources` to change them. Keys are not config.

## Questions

**Why is a price 15 minutes old?** It came from a delayed source and the label says so (`class: "delayed"`). Real-time
prices come only from your broker. Log in to your broker account on the Accounts page.

**Can I use a delayed or end-of-day price for an order or an alert?** No. Orders, risk checks, paper fills and alerts accept
only real-time data from your own broker. This is enforced where the Bridge picks a source, and again by plugins refusing
those reads.

**Can I average a broker price and a free source to be safe?** The Bridge does not, and you should not. They are prices
from different moments. The Bridge keeps one value, one source, one timestamp.

**Why is Yahoo off by default?** It is unofficial and its terms restrict automated use. The Bridge makes you read that
before it is turned on. Treat what it returns as a cross-check, not as a price to trade on.

**Does a source use my broker's request limit?** No. Each source has its own budget.

**Is there a free real-time source?** Not one the Bridge can offer. Official real-time Indian market data is licensed. Use
your broker's.

**Where is my API key stored?** In the Bridge's encrypted secrets store on this computer, under the source's name. It is
never in the config file, never in logs, and never returned by the API.

**Can a plugin see my broker password or place an order?** No. It runs without the Bridge's environment or files, and its
protocol has no way to ask for accounts or orders. Order code never imports plugin code, and a test checks that.

**Can I pass this data to other people?** The Bridge is for your own use. Broker and vendor terms generally forbid passing
market data on, and the Bridge does not redistribute it. If you plan to share anything built on this data, get advice on
exchange data rules first.

**How do I see what a source did?** `mc-bridge sources list` shows health and last error; `mc-bridge sources test <id>` makes
one call; `mc-bridge sources trace` explains a routing decision.
