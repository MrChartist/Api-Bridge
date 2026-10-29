# The option-chain recorder

The Bridge can record your option chains every minute while the market is open, even with the dashboard closed. It
reads them from **one** of your own broker accounts, keeps them on this computer, and gives them back through the API,
MCP and the dashboard's Data recorder page and OI windows. Nothing is uploaded.

- **What:** each configured chain once a minute (indices) or every 5 minutes (stocks you opt in), during the
  equity-derivatives session from the reference calendar (holidays and Muhurat sessions included).
- **Fields per strike and side:** last price, bid, ask, bid and ask quantity, open interest (in units), volume, and
  IV, delta and gamma computed by the Bridge (Black-76 on the parity forward, vol-time clock, model `b76-vt1`). Raw
  prices, the forward and the rate are kept, so IV can be recomputed if the model changes.
- **Daily rows (S3):** at 15:31 IST the Bridge derives PCR (OI and volume), max pain, the strikes with the largest call
  and put OI, the top OI adds and cuts against the previous recorded day, and the near future's basis and rollover.
  These are over the recorded strikes (±40 for indices by default), not the whole chain.
- **Gaps stay gaps:** a minute that could not be recorded is written as a gap with its reason (feed down, budget,
  broker error, session expired, Bridge down …). Nothing is filled in.

## On the dashboard

- **Data recorder** (`#/recorder`, under Overview) shows what is being recorded: the state, the account feeding it,
  today's snapshots and gap minutes, disk use, and one row per chain with recorded / expected minutes, gaps and the
  last snapshot's age (a row opens its gap list and a link to the OI page). Chains the account cannot carry are listed
  below with the reason. The Budget card shows the recorder's share of the live feed and of the REST budget.
- **Settings** on the same page (from this computer, with an admin key; on phones in a sheet): the account, indices,
  expiries and strikes, opted-in stocks, the two shares, days kept and the NSE website backup. Every edit is checked
  at once ("This account can carry …"); Save refuses what the account cannot carry and offers "Use what fits".
- **OI Analysis**: when the recorder records the chain on screen, the 5m … 1h and Since open windows use its minutes
  ("Recorded by the Bridge every minute", with coverage and gaps). Otherwise the page says so and uses what it records
  itself while open.
- **Which brokers can record what** (collapsed at the foot of the page) is the table below, generated from the same
  code (`GET /v1/options/recorder?feasibility=true`).

## Turning it on or off

Index chains are recorded by default. To opt out, put this in `bridge.config.json`:

```json
{ "recorder": { "enabled": false } }
```

All settings (section `recorder`, every key optional):

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | |
| `account` | `null` | `null` = the first connected account that serves option chains ("auto"). One account only, never another person's. |
| `indices` | NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, BANKEX | Order = priority when capacity runs out. |
| `indexExpiries` | `3` | 1–4, nearest first. |
| `indexStrikes` | `40` | Strikes each side of ATM (1–60). |
| `stocks` | `[]` | Stock underlyings to record (up to 200). |
| `stockExpiries`, `stockStrikes`, `stockEveryMinutes` | `1`, `15`, `5` | |
| `sources` | stream on, REST on, NSE website off | The NSE website backup needs `acknowledgeNseTerms: true` in the same change. |
| `budgetShare` | `0.5` | At most half of every REST window (0.05–0.5). |
| `streamShare` | `0.6` | Share of the account's live-feed subscriptions the recorder may hold (0.1–0.9). |
| `allowSingleTokenRest` | `false` | Allows REST on classes limited to 1 request/s. Your own requests may then wait up to 1 s. |
| `retentionDays` | `365` | Day folders older than this are deleted (demo: 3 days). |
| `maxDiskMb` | `10240` | The recorder stops writing above this and says so; it never deletes inside the retention on its own. |
| `recordSpecialSessions` | `true` | Records special sessions (Muhurat) that the reference calendar lists with times. |
| `dailyAt` | `"15:31"` | Time of the daily S3 job (IST). |

Session times and holidays are not recorder settings: they come from the `reference` section.

## How it shares your broker limits

1. **Stream first.** Chains go on the account's live feed while the recorder holds at most `streamShare` (60 %) of the
   feed's subscription cap. A chain at ±40 strikes is 162 legs, plus the underlying's spot and futures. A stream
   chain costs no REST calls.
2. **The feed must be on the data account.** If the live feed runs on another account, the recorder uses REST only
   and says so.
3. **REST at most half of every window.** The recorder keeps its own limiter at `budgetShare` (50 %) of every
   per-second, per-minute, per-day and shared window, and the shared background gate checks everyone's use before
   each call. Each call runs at background priority and gives up after 1.5 s rather than wait behind your requests.
4. **Never the last token.** On classes limited to 1 request/s the recorder does not use REST at all (unless you allow
   it), so your own chain request is never delayed by more than 200 ms by recorder traffic.
5. **Throttle back-off.** If the broker throttles the account, the recorder halves its REST use for 10 minutes.

If you ask for more than the account can carry, the Bridge refuses the change and tells you what fits (HTTP 422
`CAPACITY_EXCEEDED` with `canCarry`). A config file that asks for too much records the part that fits, in priority
order, and lists the rest as refused.

## Which brokers can record what

Generated from the broker policy table and each adapter's feed (default settings: 6 indices × 3 expiries × ±40
strikes = 18 chains; stocks at ±15, one expiry, every 5 minutes). "(unverified)" marks limits not confirmed on the
broker's own documentation; the Bridge then uses conservative defaults. Figures are the recorder's share only.

<!-- feasibility:start (generated by scripts/recorder-feasibility.mjs; do not edit by hand) -->
| Broker | Live feed: recorder share | REST for the recorder | Index chains (18 at ±40) | Stocks at 5 min (±15) |
|---|---|---|---|---|
| 5paisa | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| 5paisa (XTS) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| Alice Blue | no feed in adapter | chain: 120 calls/min | 18 REST | about 510 by REST |
| Anand Rathi (Algozy, XTS) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| Angel One (SmartAPI) | no feed in adapter | off (chain 1/s) | 18 refused | 0 |
| Arrow | no feed in adapter | chain: 300 calls/min | 18 REST | about 1,410 by REST |
| Axis Direct (RAPID APIs) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| Bigul (Bigul Connect) | 1,500 × 0.6 = 900 (default cap) | off (chain 1/s (unverified)) | 5 stream, 13 refused | 0 |
| Composite Edge (XTS) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| Definedge Securities (INTEGRATE) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| Dhan | 5,000 × 0.6 = 3,000 | off (chain 1/s (unverified)) | 18 stream | about 1 by stream |
| Firstock | no feed in adapter | off (chain 1/s) | 18 refused | 0 |
| Flattrade (Pi) | 1,500 × 0.6 = 900 (default cap) | chain: 100 calls/min | 5 stream, 13 REST | about 435 by REST |
| Fyers | no feed in adapter | chain: 25 calls/min | 18 REST | about 35 by REST |
| Goodwill (GWC) | 1,500 × 0.6 = 900 (default cap) | off (chain 1/s (unverified)) | 5 stream, 13 refused | 0 |
| Groww | no feed in adapter | chain: 150 calls/min | 18 REST | about 660 by REST |
| HDFC Securities (InvestRight) | 1,500 × 0.6 = 900 (default cap) | off (chain 1/s (unverified)) | 5 stream, 13 refused | 0 |
| HDFC Sky (HDFC Securities) | 1,500 × 0.6 = 900 (default cap) | off (chain 1/s (unverified)) | 5 stream, 13 refused | 0 |
| ICICI Direct (Breeze) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| IIFL Capital | no feed in adapter | chain: 300 calls/min | 18 REST | about 1,410 by REST |
| IIFL Securities (XTS) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| IndiaBulls Securities (XTS) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| IndMoney (INDstocks) | 1,500 × 0.6 = 900 (default cap) | chain: 120 calls/min | 5 stream, 13 REST | about 535 by REST |
| Jainam (XTS) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| Kotak Securities (Neo) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| Motilal Oswal | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| mStock (Mirae Asset) | no feed in adapter | chain: 600 calls/min | 18 REST | about 2,910 by REST |
| Nuvama Nubra | no feed in adapter | chain: 30 calls/min | 18 REST | about 60 by REST |
| Paytm Money | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| Pocketful | 1,500 × 0.6 = 900 | chain: 300 calls/min | 5 stream, 13 REST | about 1,435 by REST |
| Profitmart (ProfitMax API) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| RMoney (XTS) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| Rupeezy (Vortex) | 1,500 × 0.6 = 900 (default cap) | off (chain 1/s) | 5 stream, 13 refused | 0 |
| SAMCO Securities (StockNote) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| Shoonya (Finvasia) | 1,500 × 0.6 = 900 (default cap) | off (chain 1/s (unverified)) | 5 stream, 13 refused | 0 |
| Tradejini (CubePlus) | 3,000 × 0.6 = 1,800 | off (chain 1/s (unverified)) | 11 stream, 7 refused | 0 |
| TradeSmart (Noren v2) | 1,500 × 0.6 = 900 (default cap) | off (chain 1/s (unverified)) | 5 stream, 13 refused | 0 |
| Upstox | 2,000 × 0.6 = 1,200 | chain: 33 calls/min | 7 stream, 11 REST | about 110 by REST |
| Wisdom Capital (XTS) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| Zebu (Mynt) | no feed in adapter | off (chain 1/s (unverified)) | 18 refused | 0 |
| Zerodha (Kite) | 3,000 × 0.6 = 1,800 | off (chain 1/s) | 11 stream, 7 refused | 0 |
| Demo (sample data) | 500 × 0.6 = 300 | chain: 120 calls/min | 1 stream, 17 REST | about 515 by REST |
<!-- feasibility:end -->

## Costs

Recording uses your broker's market-data APIs. Some brokers charge for data APIs or for live feeds (Dhan's data APIs
may need a paid plan; needs verification). Recording many stocks may need a paid data plan. The Bridge never buys or
enables a plan for you.

## OI units

Open interest is reported in **units** (contracts × lot size). A broker that sends lots is converted with the lot size
of each contract; when the lot size is unknown the OI is left empty rather than guessed. Snapshots from brokers whose
unit has not been verified against a recorded response carry `oiUnitVerified: false`, and the status warns.

## Where the files are

```
<dataDir>/recorder/            real data (folder mode 0700, files 0600)
  state.json                   recorder state
  s1/YYYY-MM-DD/NIFTY/2026-11-03.ndjson(.gz)   one line per minute per chain (gzipped after 15:40 IST)
  s1/YYYY-MM-DD/NIFTY/_und.ndjson(.gz)         spot and futures
  s1/YYYY-MM-DD/day.json       summary of the day
  s3/NIFTY/2026.ndjson         daily rows
<dataDir>/recorder-demo/       demo mode only (sample data, kept 3 days)
```

About 20 MB a day for the 18 default index chains after compression (about 5 GB a year).

## Reading it

- `GET /v1/options/snapshots?underlying=NIFTY&expiry=2026-11-03&from=2026-10-29&fields=oi,ltp&every=5` — snapshots,
  gaps and coverage for a range (JSON or `format=csv`; page with `cursor`).
- `GET /v1/options/snapshots/latest?underlying=NIFTY&expiry=2026-11-03` — the newest snapshot, from memory.
- `GET /v1/options/daily?underlying=NIFTY` — daily rows (last 30 days by default).
- `GET /v1/options/recorder` — state, feeding account, plan, budget, coverage and disk use.
- `POST /v1/options/recorder/plan` — what a configuration would record (no changes made).
- `PUT /v1/options/recorder/config` — save the settings (admin key, from this computer).
- MCP: `get_option_snapshots` (opt-in `options` toolset).

## Demo mode

`mc-bridge start --demo` records the demo chains into `<dataDir>/recorder-demo/` on an "always open" clock (every
minute 09:15–15:30 IST, every 5 minutes outside it) and synthesises today's earlier minutes and the previous two
weekdays at once, so every view has data within a minute. Demo recordings are sample data and are never mixed with
real data.
