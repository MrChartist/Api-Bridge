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
Accounts, API (Keys) and API › Rate limits. Chromium at 1440 x 900, dark.

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
   without a fresh tick, or no spot tick, falls back to the cache and the broker.
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
9. The scheduler never exceeds a broker's published per-second, per-minute and per-day limits, and backs off a
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
  chip warms that chain (background priority).
- **Page modules on demand**: the Options desk, screeners, calendar, recorder and live events load on first visit
  (`import()`, no build step).
- **One live connection per tab** (`dashboard/live.js`): pages watch symbols; a symbol watched by several pages is
  subscribed once and kept 15 s after the last page leaves. Ticks are delivered once per animation frame. The chain,
  OI and Strategy pages watch their legs, the index and its futures; their refreshes are then stream-built on the
  Bridge.
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
