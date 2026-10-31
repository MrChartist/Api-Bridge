# Market data pro: movers, technicals, depth and headlines

Dhan's "Data APIs for Pro Traders" plan (₹799 a month in its own listing) sells 200-level market depth, technical
data, market movers, a "CAS live feed", news headlines and (coming) company fundamentals on top of its normal data
APIs. The Bridge offers the same kinds of data **for every broker it supports and in demo mode**, computed from data
every adapter already serves (quotes, daily candles, market depth) and from public news feeds. No feature depends on a
broker-specific API.

Everything here is read-only (scope `read`). Nothing places, changes or cancels an order.

## What the Bridge serves

| Feature | REST | MCP tool (opt-in `options` toolset) | Dashboard |
|---|---|---|---|
| Market movers | `GET /v1/analytics/markets/movers?universe=&by=&limit=` | `get_market_movers` | Screeners › Movers; Home card |
| Technical readouts | `GET /v1/analytics/technicals?symbols=` (≤ 25) | `get_technicals` | Screeners › Technicals; the symbol sheet |
| Market depth, 5/20/200 levels | `GET /v1/depth?symbol=&levels=5\|20\|200` | `get_depth` (existing, default depth) | Screeners › Depth ladder |
| Order-book profile | `GET /v1/analytics/depth-profile?symbol=&levels=` | `get_depth_profile` | Screeners › Depth ladder; the symbol sheet |
| Headlines | `GET /v1/analytics/news/headlines?symbols=&source=&days=&only=symbols&q=` | `get_headlines` | Flow › Headlines; Home card; the symbol sheet |

Every route is in `docs/openapi.yaml`.

### Market movers

One batched quote pass over a universe (`FNO` stocks from the instrument master, `NIFTY50`, `INDICES`, or any list
from config `scanner.universes`), ranked on the server by gainers, losers, volume, turnover or open interest, with
the advance/decline count. The pass is cached for 15 seconds and shared by every client and by all five lists, so the
Movers page costs at most two quote calls every 15 seconds whatever the number of viewers. Cash quotes carry no open
interest, so `by=oi` is empty for stock universes.

### Technical readouts

Per symbol, from up to 300 daily candles of the connected broker (`GET /v1/history`, background priority, cached for
the IST day and shared) plus one batched quote call so the latest session follows the live price:

- EMA and SMA 20 / 50 / 200 and where the price sits against each (distance in %)
- RSI 14 (Wilder), MACD 12/26/9 with its last cross, ADX 14 with +DI / −DI, Stochastic 14/3, ATR 14 (and % of price),
  Bollinger 20/2 with %B and width, Supertrend 10/3
- classic floor pivots (PP, R1–R3, S1–S3) from the previous session's high, low and close
- the 52-week range (250 sessions) and the price's position in it; volume against its 20-day average; 5/20/60/250
  session returns
- `facts`: plain statements of what the numbers show ("RSI 14 is above 70", "Close crossed above the 50-day EMA
  today", "New 52-week high"). They describe; they are not signals or advice.

Values come from the ChartistScript kernel (`server/vendor/chartist-core/kernel`), the same functions the dashboard's
charts draw with, so a readout and a chart study agree.

### Depth and the order-book profile

`/v1/depth` takes `levels=5|20|200`. It is a hint passed to the adapter (`fetchDepth(creds, ref, { levels })`): most
broker quote APIs answer five levels whatever is asked, so read the length of `bids` and `asks`. Each depth is cached
apart. The demo adapter answers 5, 20 or 200 levels.

`/v1/analytics/depth-profile` profiles one depth read: per level the running total, share of the side and of the
largest level, average order size and a `large` flag (at least 3× the median level); best bid and ask, mid, spread in
price and basis points, microprice, quantity imbalance over the whole book and the best five levels, and the three
largest levels per side.

### Headlines

One feed, newest first, deduplicated by id and link, from:

- the public markets RSS feeds of The Economic Times, Business Standard and Mint — **title and link
  only**; each article stays on its publisher's site
- NSE corporate announcements and SEBI / RBI RSS (the existing sources of `/v1/analytics/news/*`)

Each row is tagged with the asked `symbols` it names (the ticker in capitals, or the company name from the instrument
master) plus NIFTY, BANKNIFTY and SENSEX. `only=symbols` keeps rows that name one. A feed that fails is listed in
`meta.failedFeeds` and does not fail the call. RSS is cached 10 minutes, announcements 5. The ET and Mint markets feeds were
probed on 31 Oct 2026 and are marked `verified: true`; Business Standard's answered 403 to a non-browser client and
stays `verified: false`; Moneycontrol's RSS feeds stopped updating in April 2024, so it is no longer read. The other
URLs are assumed from knowledge of the sites (see `ENDPOINTS` in `server/bridge/analytics/newsFeeds.mjs`); personal,
local use only. Demo mode serves sample headlines with no network.

## Dashboard

- **Home**: a Market movers card (NIFTY 50 gainers or losers with bars and the advance/decline strip, every 30 s) and
  a Headlines card (rows naming the Home watchlist first, every 5 minutes).
- **Screeners › Movers**: five boards (gainers, losers, volume, turnover, OI) for the chosen universe, each row with a
  bar and where the price sits in the day's range; refreshes every 15 s.
- **Screeners › Technicals**: a watchlist, NIFTY 50 or typed symbols (up to 50) in one table: averages as six dots,
  an RSI gauge with the 30 / 70 bands, MACD, Supertrend, 52-week position, volume ratio and the most notable fact;
  filter chips (above or below all averages, RSI above 70 / below 30, near the 52-week high or low, MACD crossed,
  volume 2×) and sorting.
- **Screeners › Depth ladder** (`#/screeners/depth?symbol=NSE:RELIANCE`): the ladder with cumulative heat and
  per-level bars, large levels marked, the book statistics, the imbalance meter (whole book and best five), the
  cumulative depth curve and the largest levels; 5 / 20 / 200 levels, refreshed every 2 s while the page is open.
- **Flow › Headlines**: grouped by day, filtered by kind (news, filings, regulators), by your watchlist or what you
  hold (positions and holdings), and by search.
- **The symbol sheet**: tap any symbol in these views for its readouts, top of the book and headlines, with Chart,
  Depth ladder and Option chain (when the Bridge lists expiries for it) one tap away.

Direction is always coloured: gains, "up" readouts and the ask side in the gain colour; losses, "down" readouts and
the bid side in the loss colour.

## What Dhan offers natively (for reference)

Read from DhanHQ v2 docs (dhanhq.co/docs/v2) on 31 Oct 2026:

- **Full Market Depth** is documented: WebSockets `wss://depth-api-feed.dhan.co/twentydepth` (20 levels, up to 50
  instruments per connection) and `wss://full-depth-api.dhan.co/twohundreddepth` (200 levels, one instrument per
  connection), query `token`, `clientId`, `authType=2`; subscribe `{"RequestCode": 23, ...}`; binary packets with a
  12-byte header (length, response code 41 bid / 51 ask, segment, security id, sequence or row count) and 16 bytes per
  level (float64 price, uint32 quantity, uint32 orders); NSE equity and derivatives only; at most 5 sockets. Release
  2.3 (8 Sep 2025) added the 200-level feed. The docs do not say which plan it needs.
- **Technical Data, Market Movers, CAS Live Feed, News Headlines and Company Fundamentals** are not in the public
  DhanHQ v2 docs or release notes at the time of writing, so their endpoints, fields and limits are unknown. What "CAS
  live feed" is could not be confirmed from Dhan's documentation. Nothing in the Bridge guesses at them.
- Data API rate limit in the docs: 5 requests a second, 100,000 a day.

A Dhan account answers `levels=20|200` from these WebSockets (`server/brokers/dhanDepth.mjs`, wired into
`fetchDepth(…, { levels })` in `dhanMarket.mjs`) for NSE equity and F&O instruments. One pool per Dhan user keeps at
most 4 depth sockets (Dhan drops the user's first socket when a sixth opens, so one is left for the live market feed):
20-level instruments share sockets of up to 50, each 200-level instrument has its own, the least recently used quiet
socket gives up its slot when the pool is full, instruments not read for 60 s are unsubscribed and empty sockets
closed. Anything else (BSE or index symbols, a full pool, Dhan's disconnect codes 805-809, a refused handshake, no data
within 3 s) answers the 5-level REST quote instead, and refusals pause the sockets for that user for a while so a poll
does not retry them every 2 s. The packet parser is unit-tested on byte-built fixtures; it has not been run against
Dhan's live feed. When Dhan publishes the other Pro APIs they can sit behind the same Bridge endpoints as faster
providers, with the generic versions as the fallback.
