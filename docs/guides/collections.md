# Collections: lists of instruments and option universes

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

A **collection** is a named, tagged list of instruments. Make it once; downloads, recordings, spreadsheets and the Python
library can then say `collection: "nifty-weekly"` instead of pasting the same symbols again.

There are two kinds:

| Kind | What it holds | When the symbols are fixed |
|---|---|---|
| `static` | A list of symbols you chose, such as `NSE:RELIANCE`, `NSE:INFY` | Always |
| `option-universe` | A rule: "NIFTY, the current weekly expiry, 10 strikes each side of the at-the-money strike, calls and puts" | Never. It is worked out **each time it is used**, so the expiry rolls on and the at-the-money strike moves with the price |

Collections live in `collections.json` in your data folder (written safely: a temporary file, then a rename). They are part
of `mc-bridge backup`. Nothing in them is secret.

**Watchlists.** This version of the Bridge never had a watchlist store or watchlist routes (a `watchlists` section in the
config is refused as removed), so there is nothing to migrate. The Watchlist sheet in the Excel workbook is a list that lives in
the sheet. To use a collection in a sheet, see [In Excel and Google Sheets](#in-excel-and-google-sheets).

## Five minutes

```sh
# a read key can make and change collections (the same scope as starting a download); only deleting one needs admin
mc-bridge keys create --label collections --scope read

export MCB_API_KEY=mcb_...                        # PowerShell: $env:MCB_API_KEY = "mcb_..."
mc-bridge collections create banks --symbols NSE:HDFCBANK,NSE:ICICIBANK,NSE:SBIN --tags cash,banks
mc-bridge collections universe nifty-weekly --underlying NIFTY --expiries current-weekly --strikes atm:10 --tags options
mc-bridge collections resolve nifty-weekly        # the 43 symbols it means right now, and why
mc-bridge collections estimate nifty-weekly --interval 5m --days 30
```

The same through the API:

```sh
curl -s -X POST http://127.0.0.1:4300/v1/collections \
  -H "Authorization: Bearer $MCB_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"nifty-weekly","tags":["options"],"kind":"option-universe",
       "universe":{"underlying":"NIFTY","expiries":"current-weekly","strikes":{"around":"atm","count":10},"sides":["CE","PE"],"includeUnderlying":true}}'

curl -s -H "Authorization: Bearer $MCB_API_KEY" http://127.0.0.1:4300/v1/collections/nifty-weekly/resolve
```

## The option universe

```json
{
  "name": "nifty-weekly",
  "kind": "option-universe",
  "universe": {
    "underlying": "NIFTY",
    "expiries": "current-weekly",
    "strikes": { "around": "atm", "count": 10 },
    "sides": ["CE", "PE"],
    "includeUnderlying": true,
    "includeFuture": false
  }
}
```

| Field | Meaning |
|---|---|
| `underlying` | An index or stock name without an exchange: `NIFTY`, `BANKNIFTY`, `SENSEX`, `RELIANCE` |
| `expiries` | `current-weekly`, `next-weekly`, `current-monthly`, `all-weekly`, or a list of dates such as `["2026-11-24","2026-12-01"]` |
| `strikes` | `{ "around": "atm", "count": 10 }`: that many **listed** strikes each side of the strike nearest the price. Or `{ "from": 24000, "to": 26000 }`: every listed strike between two prices (needs no price at all) |
| `sides` | `["CE","PE"]` (default), or just one |
| `includeUnderlying` | Add the index or stock itself (`NSE:NIFTY`). Default true |
| `includeFuture` | Add the future that expires in the month of each chosen expiry. Default false |

### How the expiry is chosen

The Bridge does not compute expiry dates. It reads the dates the exchange has **listed** (the instrument list) and chooses
among them, so a holiday shift is already in the date. The calendar is used only to explain what it sees.

| Rule | Means |
|---|---|
| `current-weekly` | The nearest listed expiry that has not closed. An expiry stops counting at its own close on its own day (15:40 IST for derivatives since 3 Aug 2026; from 7 Dec 2026 index contracts expiring that day stop at 15:30 and stock contracts at 15:45), so after the close the rule has already moved to the next one |
| `next-weekly` | The one after it |
| `current-monthly` | The nearest expiry that is the last of its calendar month |
| `all-weekly` | The nearest expiry and the weekly ones after it (about a week apart), at most `library.maxWeeklyExpiries` (5) |
| a list of dates | Exactly those. A date that is not listed, or has passed, is skipped with a warning that names the dates listed near it. If none is left, the answer is an error |

Weekly or monthly: an expiry is monthly when it is the last listed expiry of its month; the others are weekly. A stock, or an
index that has dropped its weeklies, has monthly expiries only. Asking such an underlying for `current-weekly` is an **error that says
so**; it never quietly uses a monthly date.

**Holiday shifts.** If the usual expiry day (say a Tuesday) is an exchange holiday, the exchange lists the day before. The
answer marks that expiry `shifted: true` with the reason (`2026-11-17 is a holiday`), and adds a warning. The listed date is used.

### How the strikes and the at-the-money strike are chosen

- The strikes are the ones the instrument list has for that underlying and expiry. `count` counts **listed** strikes, so a
  far strike listed at a wider step is still one strike, and the Bridge never invents a contract that does not exist.
- The at-the-money (ATM) strike is the listed strike nearest the price (the lower one on an exact tie). This is the rounding to
  the strike step: NIFTY lists every 50 points (25 026 gives 25 050), BANKNIFTY every 100 (52 340 gives 52 300), and a stock has
  its own step, usually 10 or 20 for a share near 1 400 (1 412 gives 1 420). The step of each expiry is in the answer (`step`).
- If no listed strikes are known at all (the instrument list has no options for it), an **index** gets a generated grid on
  its usual step (`library.strikeSteps`), the answer says `strikeSource: "grid"` and warns that some may not exist. A **stock** is never
  guessed: it is an error that tells you to refresh the list or set the step yourself.

### How honest it is about the price

An ATM needs the underlying's price. Every answer says where it came from in `atmSource`:

| `atmSource` | Meaning | When it is allowed |
|---|---|---|
| `not-needed` | The universe has explicit strikes (`from`, `to`) or is a static list | Always |
| `live` | A realtime price, not stale, market open | Always |
| `last-close` | Realtime class, but the market is closed or in pre-open, so the price is the last close and the ATM is yesterday's | Always, with a warning. A caller that needs a live ATM passes `requireLive` and gets an error instead |
| `supplied` | You passed `spot=<price>`: the ATM is worked out from it | Always, with a warning |
| `stale` | The Bridge itself marks the price stale (the feed fell behind) | Only with `allowStale=true`; otherwise an error (503) |
| `delayed`, `eod` | The price comes from a delayed or end-of-day source | Only with `allowStale=true`; otherwise an error (422). Such a price is never used for an ATM unless you say so |

With `allowStale` the answer is labelled and carries a plain warning. The dashboard's preview and the size estimate use it;
a download or a recording must not, so they call resolve at the moment they run, without it. Setting `library.allowStaleAtm`
to true makes labelled stale prices the default for callers that do not say (a spreadsheet request always says no).

## Using a collection

**Downloads and recordings** accept `collection: "<name>"` instead of `symbols`. They call `resolve` when the job runs, not
when it is made, so a nightly download of "NIFTY weekly, ATM +/- 10" means that night's expiry and that night's ATM.

**Size before you start**: `GET /v1/collections/{name}/estimate?intervals=5m,1d&days=30` gives rows, bytes (as CSV, about 70
a row) and broker calls (one per history chunk per symbol per interval: 60 days intraday, 2000 daily). It is an estimate: a
contract listed last week has less than 30 days, and a broker may keep less intraday history than you ask for.

**Usage**: `GET /v1/collections/{name}/usage` lists the downloads, recordings, auto-record rules and datasets that use the
collection. A kind marked `not-available` is kept by a part of the Bridge that is off, so it is not counted. Deleting a
collection that something **active** uses is refused (409) unless you add `force=true`.

### In Excel and Google Sheets

`/xl/quotes` takes `collection=` in place of `symbols=`:

```
http://127.0.0.1:4300/xl/quotes?collection=banks&fields=ltp,chg,pct&key=<your read-only key>
```

One request, one row per symbol, in the collection's order, with the usual freshness columns. An option universe is worked
out at the time of the request. For a sheet the price behind the ATM must be live, or the last close with the market shut; a
stale, delayed or end-of-day price answers a one-row table with the reason (the sheet shows it instead of old numbers). The
response headers `X-Collection-Resolved-At`, `X-Collection-Atm-Source`, `X-Collection-Rule` and `X-Collection-Warnings` say when and
how. A sheet request takes at most `integrations.xl.maxSymbols` symbols (100 by default): a universe that is bigger is
refused with the numbers. In Power Query or `IMPORTDATA` just use this address; in the workbook, replace the request's
`symbols=` part by `collection=<name>`.

### Tags

Tags are lower-case words (`weekly`, `nifty-options`; letters, digits and `_ . : -`, up to 32 characters, 20 per item). Filter
with `GET /v1/collections?tag=weekly,nifty` (a collection must have **every** tag). The datasets and downloaded files of the
downloads module use the same helper, so `GET /v1/datasets?tag=nifty` means the same thing.

## All the operations

| What | Request | Scope |
|---|---|---|
| List (filter by tag, kind, text) | `GET /v1/collections?tag=&kind=&q=` | read |
| One, with its symbols or universe | `GET /v1/collections/{name}` | read |
| Resolve now | `GET /v1/collections/{name}/resolve?allowStale=&requireLive=&spot=&priority=` | read |
| Size estimate | `GET /v1/collections/{name}/estimate?intervals=&days=` | read |
| Usage | `GET /v1/collections/{name}/usage` | read |
| Export (CSV or JSON) | `GET /v1/collections/{name}/export?format=csv\|json&resolved=` | read |
| Create | `POST /v1/collections` | read |
| Change, tag, or **rename** | `PATCH /v1/collections/{name}` with any of `name`, `description`, `tags`, `symbols`, `universe` | read |
| Copy | `POST /v1/collections/{name}/duplicate` with an optional `{ "name": "..." }` | read |
| Import (CSV or JSON) | `POST /v1/collections/import` (`replace=true` needs admin, this computer) | read |
| Delete | `DELETE /v1/collections/{name}?force=` | admin (this computer only) |

`{name}` may also be the collection's id (`col_...`). An **id never changes**. A **rename** keeps the id, and the old name keeps
finding the collection (the answer says `viaOldName`, with a warning), so a rule written with the old name does not break
the next morning. A new collection may take over an old name. **Scopes.** A collection is only a list of names on this computer: it places no order and moves no money, so making, changing,
copying and importing one needs the `read` scope, the same as starting a download. It used to need `paper`, which also lets a key
place paper orders; a script that only keeps a symbol list should not hold that. Deleting a collection, and an import with
`replace=true`, can destroy work, so they need an `admin` key used from this computer. A collection can feed a recording rule, which writes to your
disk, so the recorder's own limits (`recorder.maxSymbolsPerRecording`, the disk limits) still apply to whatever a collection
resolves to. (The scope list is in [safety.md](safety.md).)

**Export and import.** JSON is the definition (a universe stays a universe) and imports back. CSV is the symbols, with the
columns `symbol,exchange,kind,underlying,expiry,strike,right`; for an option universe it is the symbols as they resolve now
(`X-Resolved-At`). To import a CSV, send it as `text/plain` with `?name=` (or as JSON `{ "format": "csv", "csv": "...",
"name": "..." }`); the symbols are in a column called `symbol`, or in the first column when there is no header. A spreadsheet's
leading apostrophe is removed. Everything is checked first: one bad line imports nothing, and the error names the line;
`skipInvalid=true` imports the rest. An existing name answers 409 unless `replace=true`.

```sh
mc-bridge collections export banks --format csv --out banks.csv     # never overwrites a file
mc-bridge collections import my-list.csv --tags imported
```

## For other parts of the Bridge

Downloads, the recorder and the rest read collections through `deps.library` (a contract service, `core/contracts.mjs`):

```js
const r = await deps.library.resolve("nifty-weekly", { requireLive: true, priority: "background", signal });
// r.symbols, r.resolvedAt, r.rule, r.atmSource, r.expiries, r.warnings
const e = await deps.library.estimate("nifty-weekly", ["5m"], 30);
deps.library.list({ tag: "options" });     // summaries
deps.library.get("nifty-weekly");           // the whole collection; throws NOT_FOUND
```

- Call `resolve` **when the job runs** (and again when it rolls over), with `priority: "background"` for bulk work and
  `requireLive: true` when a non-live ATM is not acceptable. Store the `resolvedAt` and the `rule` in the job's manifest.
- To appear in the usage view and to protect a collection from deletion, register a provider:
  `deps.library.registerUsageProvider("downloads", ({ id, name, names }) => [{ id, label, status, active }])`. `names` holds
  the name and its earlier names. Kinds: `downloads`, `recordings`, `rules`, `datasets`.
- Tags and names: `server/bridge/library/tags.mjs` has `normaliseTags`, `parseTagFilter`, `matchesTags`, `filterByTags` and
  `validateName`. A dataset keeps `tags: string[]` and a changeable name next to its fixed id, calls `normaliseTags` on write, and
  serves `?tag=` with `filterByTags`.
- Every write emits the bus topic `collection.changed` with `{ action: "created"|"updated"|"renamed"|"deleted", id, name, kind, tags, from? }`
  (never the symbol list).

## Settings

```json
"library": { "enabled": true, "maxCollections": 200, "maxSymbols": 5000, "maxWeeklyExpiries": 5, "allowStaleAtm": false,
             "strikeSteps": { "NIFTY": 50 } }
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | true | false switches the library off: every use answers a plain error |
| `maxCollections` | 200 | How many collections the store holds |
| `maxSymbols` | 5000 | Most symbols a collection may hold or resolve to |
| `maxWeeklyExpiries` | 5 | What `all-weekly` stops at |
| `allowStaleAtm` | false | Let a labelled stale, delayed or end-of-day price be the default for callers that do not say |
| `strikeSteps` | usual index steps | The step of a generated grid, used only when no listed strikes are known. Built in: NIFTY 50, BANKNIFTY 100, FINNIFTY 50, MIDCPNIFTY 25, SENSEX 100, BANKEX 100. A stock's step is never guessed |

## Limits, and what is not done

- A symbol is checked for **form** when it is saved (`NSE:RELIANCE`, `NFO:NIFTY-2026-11-24-25000-CE`), not against the broker's
  list: those lists change every day. A contract that has expired is kept and flagged with a warning when the collection is resolved.
- Expiry dates, strikes and lot sizes come from the instrument list your connected brokers give the Bridge. When it has not been
  loaded (no broker connected), a universe cannot be resolved and says so.
- The size estimate counts calendar days with the Bridge's holiday list (see `GET /v1/calendar/holidays`); it is not a promise of how
  much history a broker keeps.
