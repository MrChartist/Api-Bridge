# Speed and broker-budget measurements

How to measure the dashboard's speed and the broker calls it causes, and what the Bridge does to keep both low.
Results are in [baseline.md](baseline.md).

## 1. The harness

```bash
# Starts its own demo Bridge (its own home and port), measures, stops it (its own PID only).
node scripts/perf/run.mjs --home /path/to/scratch/home --port 4481 --latency 200 \
  --seconds 30 --busy 60 --idle 60 --out result.json [--shots dir] [--only chain,oi,busy]

# Or measure a Bridge that is already running:
node scripts/perf/run.mjs --base http://127.0.0.1:4480 --key mcb_... --seconds 30

# Server hot paths (no Bridge, no browser):
node scripts/perf/bench-server.mjs [--rounds 200] [--json]
```

Needs Playwright with Chromium (a global install is fine: the scripts fall back to `npm root -g`).

`--latency` sets `MCB_DEMO_LATENCY_MS` on the demo Bridge: every demo broker REST read answers after that many ms, as a
real broker over the internet does (100 to 400 ms is typical). It is off unless set, and only the demo adapter reads it
(`server/bridge/demo/demoMode.mjs`).

### What it records, per page

Pages: Home, Option Chain, Strategy, Positions, Orders, OI Analysis, Volatility, Screeners (Options), Live events,
Accounts, API (Keys) and API › Rate limits, and (round 4) Exposure, Flow, Futures, Risk, Strategy lab and Watchlists.
Chromium at 1440 x 900 (`--viewport WxH` to change), dark. Also per page: paint, layout and style ms per second from a
`--trace` second Chromium trace (6 by default), main-thread and script ms per second (CDP `Performance.getMetrics`) and
the JS heap after a forced GC at the start and end of the steady window. `--soak N` holds the main pages open for N
minutes (one browser each) plus a tab that changes page every 4 s, and reports the heap growth.

| Figure | How |
|---|---|
| First paint (FCP) | `first-contentful-paint` of a cold load in a fresh browser context (empty HTTP cache). |
| First data | Navigation start to the first frame where `#content` is drawn: not `aria-busy`, no skeleton (`.skel-state`), no "Loading…", at least 20 elements. |
| Page switch | From setting the hash to that same "first data" frame. `switchFirst`: Home to the page after hovering its menu item for 120 ms. `switchCached`: the page again after leaving it for another (the "from cache" case). |
| JS / CSS KB | Decoded bytes of the scripts and stylesheets the cold load fetched. |
| REST calls per minute | Requests to `/v1/*` the page made during the steady window. |
| Duplicates | A GET to a URL while an identical one is still in flight, or within 300 ms of it finishing. |
| Long tasks | `PerformanceObserver` long tasks (over 50 ms) during the steady window: count, total and largest. |
| Tick to cell | The data time of a price (`freshness.asOf` of a chain or quotes answer, `receivedAt` of a stream tick) to the frame after a table cell changed. Only data newer than anything already painted counts (a refresh that brings older data than the stream already showed is not a tick). |
| Broker calls per minute | The rate-limit engine's own counters: the sum of `callsToday` over every account and class in `GET /v1/usage`, before and after the window. `net` subtracts the idle rate (the same Bridge with no page open: the recorder and other background jobs). |

Then the **busiest scenario**: Option Chain, OI Analysis, Strategy and Live events open together in four tabs, all on
NIFTY, for `--busy` seconds; the broker calls in that window, by class.

### Noise

Numbers on one machine move between runs: the background recorder works in minute-long rounds, the demo prices move,
and the browser shares the CPU with the Bridge. Run before and after **interleaved** on the same machine (before,
after, before, after) and read the spread between rounds as the noise. Headless Chromium paints in software, so paint
and long-task figures are higher than in a desktop browser with a GPU; compare them only with each other.

## 2. What keeps broker calls down

Every market-data read, from any consumer (dashboard pages, Live events, the recorder, the scanner, Excel and compat,
MCP, your own scripts), goes through one path in `server/bridge/market/marketDataService.mjs`:

1. **Live stream.** A symbol someone streams is answered from its last tick (no broker call). One broker subscription
   per symbol serves every client.
2. **Stream-first option chains.** A chain read whose whole strike window is live on the stream is built from the
   ticks over the day's broker chain (which supplies the previous-day OI for OI change), with no broker call. Any leg
   without a fresh tick, or no spot tick, falls back to the cache and the broker. A **quiet strike** (a far leg that
   has not traded) does not: on a live subscription no tick means no trade, so its last tick is used while its feed is
   ticking now and the tick came on the current connection, up to `market.quietLegMaxAgeMs` (60 s). Such legs carry
   `tickAgeMs` and are counted in `freshness.quiet`; `asOf` stays that of the live legs.
3. **Freshness cache**, shared by every consumer, with honest labels (`freshness.source`, `asOf`, `ageMs`, `stale`).
4. **In-flight sharing.** A read that is already on its way to the broker is joined, not repeated (coalesce keys in
   the scheduler, plus the per-symbol in-flight map).
5. **Batching** to each broker's documented batch size (`maxQuoteBatch` in `ratelimit/brokerPolicies.mjs`).
6. **Stale-while-revalidate** (`?swr=true`, `staleWhileRevalidate`): an older cached value answers at once, labelled
   `stale: true` and `revalidating: true`, and one refresh runs behind it.
7. **Priority**: `order` > `live` > `interactive` > `background`. Prefetches ask with `?priority=background`, so a click
   always goes first; a click that asks for the same thing joins the prefetch and raises it.
8. **Scanner pre-warm** (`scanner/prewarm.mjs`): the daily bars of NIFTY50 and FNO (about 200 symbols) go into the
   scanner's own daily cache (`<home>/data/scanner/daily-<date>.json`) 30 s after start and again at 15:50 IST for the
   next weekday, one symbol at a time at background priority through the shared gate, paused while any
   non-background broker request happened in the last 10 s. The first scan of the day then makes no daily-bar calls
   (a cold 200-symbol scan was about 200 calls and 219 s). The budget popover shows "Preparing scans N/200" while it
   runs. Not in demo mode (the demo scanner reads no broker).
9. **Live events on real brokers** (`events/feed.mjs`): the universe rides the same hub subscriptions; REST only for
   symbols the hub refused, never ticked, or whose feed went silent. A symbol that is only quiet on a live feed is not
   polled (up to `events.quietMaxMs`, 5 min). Where the quote class allows 1 call a second (Dhan, Angel One,
   Firstock), the background share never fits a 1-call window; there a **guaranteed share** applies: one batched call
   (up to the broker's batch size, the symbols read longest ago first) at most every `events.restEverySeconds` (10 s),
   only while nobody has used the broker for 10 s, only in a second nobody else uses, with every longer window keeping
   its floor (`ratelimit/backgroundGate.mjs` `floorDecision`), at background priority. The budget popover lists it as
   the job "Live events by REST". `events/feedCalls.test.mjs` counts the broker calls, on Arrow's policy and on Dhan's.
10. **Start-up jobs leave headroom**: the demo book seed reads at background priority and paces each paper order
   through the shared background gate, so a person's first reads find the quote windows at least half free.
11. The scheduler never exceeds a broker's published per-second, per-minute and per-day limits, and backs off a
   throttled account and class (unchanged).

`server/bridge/market/sharedReads.test.mjs` counts real broker calls through the real scheduler (Dhan policy) for:
three pages and the events engine on NIFTY (one call per freshness window, not one per page), the stream-first chain
(one call in total), ten identical reads at once (one call) and stale-while-revalidate (one refresh however many
readers).

## 3. What makes the dashboard fast

- **One fetch layer** (`dashboard/app.js` `api()`): one request per URL at a time; answers shared for 1 s; on a page
  switch, the last answer (up to 30 s old) paints at once while a fresh one is fetched, and pages without their own
  refresh are drawn again once if it differs. Writes forget every remembered answer. Never from memory: stream
  tokens, sign-in, safety, tickets, order preview, audit, limits and usage.
- **Prefetch**: hovering or focusing a menu item loads the page's module and warms its reads; hovering an expiry
  chip warms that chain (background priority). After a chain loads, the next expiry's chain is warmed once (1.5 s
  later, idle time, background priority), and the first read of an expiry paints a warmed answer at once (`api(path,
  { paintOld: true })`, its freshness label says how old) while the fresh one is fetched. Reaching for the underlying
  picker warms the other underlyings' expiry lists (not their chains: a native select does not say which option is
  under the pointer).
- **Polled positions stream too**: a page that reads `/v1/positions` again within 15 s has the open positions watched
  on the live connection, so the Bridge marks paper and live positions from ticks (in demo this was the 20 quote calls
  a minute of the busiest scenario).
- **Page modules on demand**: the Options desk, screeners, calendar, recorder and live events load on first visit
  (`import()`, no build step).
- **One live connection per tab** (`dashboard/live.js`): pages watch symbols; a symbol watched by several pages is
  subscribed once and kept 15 s after the last page leaves. Ticks are delivered once per animation frame, and no
  sooner than 150 ms after a page's last delivery unless the page patches cells (the chain takes every frame, OI
  Analysis every 50 ms). The
  chain, OI and Strategy pages watch their legs, the index and its futures; their refreshes are then stream-built on
  the Bridge. Live events arrive on the same connection (`onMarketEvents`).
- **Per-cell chain patches**: a tick updates only the cells of the legs that ticked (text nodes and classes; IV and
  Greeks repriced on the chain's own Black-76 pricing block; the parity cells of that strike), and bar lengths snap
  instead of animating each hair of change. A full redraw only when the structure moves (ATM, the index crossing a
  strike, an OI window, expiry, columns) and on the 3 s refresh for chain-wide figures.
- **Chain work split across frames**: a tick or a 3 s refresh patches the rows nearest the focused strike (else spot)
  in its own task and leaves the rest to the next frames, about 5 ms of script a frame (`desk.js` `drainRows`); rows
  that come into the window are drawn at once, a new table in one go. Each cell still writes only what changed.
- **OI Analysis on ticks**: the ladder rows and the tiles follow each delivery (every cell signature-checked; bars
  snap); the panels below (walls, build-up, movers, expiries, max pain, timeline) are redrawn at most every 2 s on
  ticks, and always in a task of their own, never inside the tick's or the refresh's. Rows outside the band format
  nothing; a bar's tooltip is formatted when the pointer reaches it.
- **Animations on the compositor**: the signed-in dot breathes with a CSS opacity and transform animation on its own
  layer (Motion's JS `scale` loop repainted the whole page layer every frame), paused while the tab is hidden
  (`:root.tab-hidden`) and none under reduced motion. The live dot's ring, the chain's LTP flash and the OI ladder's
  change flash fade an overlay's opacity instead of animating box-shadow or background-color (which repainted the
  whole table on every frame of every flash); the top-line spot and KPI ink holds, then settles in one step.
  `perf.test.mjs` checks the keyframes.
- **Table labelling at most once a frame**: the page-wide observer that names tables and fits them (`views.js`) used
  to run, and read a table's width, on every cell change.
- **No `:has()` on page containers**: a `:has()` rule whose subject is `.content` or `.app-main` made every change
  inside the page a style recalculation of all ~2000 nodes under it (40 to 90 ms per chain tick in Chromium). Page
  layouts key off `:root[data-page]`; `perf.test.mjs` keeps it that way.
- **No layout thrash in the chain**: the width comes from a ResizeObserver, the fill height is measured once per
  window size, the top bar is fitted in the next frame and only when its text length changed, and a cell flashes at
  most once every 2.5 s.
- **Static files** are read once and served with `ETag` and `Cache-Control: no-cache`, so a reload costs 304s.
- **Greeks** need no Web Worker: Black-76 for a 91-strike chain (182 legs) takes about 0.7 ms
  (`bench-server.mjs`), and the Bridge prices each cached chain once for every reader.

## 4. The API budget, visible

- Top bar: `API 3/10 s · 41/400 min` (the fullest window of every broker account, tinted at 70 % and 90 %), a dot for
  the stream, and a popover per account with calls saved today. It is fed by `budget` messages on the shared live
  connection (`subscribe_budget`, docs/asyncapi.yaml), so it costs no polling.
- API › Rate limits: a live calls-per-second chart against the limit for the last two minutes, per account and
  endpoint class, and **Top consumers** today: broker calls and saved calls per dashboard page, API key, MCP, compat,
  the recorder and Live events (`GET /v1/usage?series=1`; consumers are shown to admin keys only).
