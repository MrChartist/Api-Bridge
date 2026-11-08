# Supported brokers

The Bridge can read option chains, quotes, history and your portfolio from **41 Indian brokers**, and can hold several accounts per broker. Broker keys are saved encrypted on your own machine (`data/secrets.enc`, sealed with the master key) and go only from the Bridge to the broker over HTTPS. Passwords, PINs, MPINs and TOTP codes are never stored: a session login uses them once and keeps only the session token the broker returns.

**Verification status.** Only **Dhan** has been verified end to end with a live account. Every other broker is **beta: not yet verified with a live account**. Each adapter was written from the broker's official API documentation and is tested against recorded sample responses (`server/brokers/__fixtures__/`), with no network calls in tests. Please check figures against your broker before relying on them, and report what you find.

**Orders.** Every adapter except Axis Direct (read-only) has order methods, and each is wrapped in an order gate that refuses without a valid, single-use, broker-bound gate. In the Bridge, orders are **paper by default**. A live order needs every opt-in described in the README's safety model (live mode on in the config, the account marked live, an `orders:live` key, and the safety guard passing), and live order mapping is wired only for **Dhan** (verified), **Zerodha** and **Upstox** (beta, a warning on every live order). For every other broker the Bridge answers live orders with a clear "use paper mode" error. The "Orders" column below describes the adapter itself.

**Rate limits.** Each broker's documented limits are in `server/bridge/ratelimit/brokerPolicies.mjs`, with a source link and a `verified` flag per number (summary in [Limits, live feed and data plans](#limits-live-feed-and-data-plans) below). Where a broker publishes no limit (Goodwill, Bigul, Profitmart, Axis Direct and several older adapters), the Bridge uses conservative defaults: 1 request a second for quotes, depth, history and chains, 2 a second for portfolio calls, 5 a second for orders. `GET /v1/limits` shows the table the running Bridge uses.

## Capability table

The capability columns are generated from each adapter's declared `capabilities` (see `src/lib/brokerCapabilities.generated.ts`, rebuilt with `node scripts/generate-broker-capabilities.mjs`), the same source `GET /v1/brokers` and the dashboard use.

| Broker | id | Sign-in (auth kind) | Option chain | Quotes | Live feed | Portfolio | Orders | Official docs | Status |
|---|---|---|---|---|---|---|---|---|---|
| Dhan | `dhan` | API key / token (`apiKeyToken`) | Broker Greeks | Quotes + depth | Live | Full | Live (armed) | [docs](https://dhanhq.co/docs/v2/) | Verified with a live account |
| 5paisa | `fivepaisa` | Session login (`sessionLogin`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://xstream.5paisa.com/dev-docs/) | Beta: not yet verified with a live account |
| 5paisa (XTS) | `fivepaisaxts` | API key / token (`apiKeyToken`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://symphonyfintech.com/xts-trading-front-end-api/) | Beta: not yet verified with a live account |
| Alice Blue | `aliceblue` | One-time code (`requestTokenExchange`) | Computed Greeks | Quotes | — | Full | Blocked | [docs](https://ant.aliceblueonline.com/productdocumentation/) | Beta: not yet verified with a live account |
| Anand Rathi (Algozy, XTS) | `anandrathi` | API key / token (`apiKeyToken`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://algozy.rathi.com/doc/interactive/) | Beta: not yet verified with a live account |
| Angel One (SmartAPI) | `angelone` | Session login (`sessionLogin`) | Broker Greeks | Quotes + depth | — | Full | Blocked | [docs](https://smartapi.angelone.in/docs) | Beta: not yet verified with a live account |
| Arrow | `arrow` | One-time code (`requestTokenExchange`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://docs.arrow.trade/) | Beta: not yet verified with a live account |
| Axis Direct (RAPID APIs) | `axisdirect` | One-time code (`requestTokenExchange`) | Computed Greeks | Quotes | — | Partial | No | [docs](https://documenter.getpostman.com/view/33771924/2sA3BkasEf) | Beta: not yet verified with a live account |
| Bigul (Bigul Connect) | `bigul` | Session login (`sessionLogin`) | Computed Greeks | Quotes + depth | Live | Full | Blocked | [docs](https://connect.bigul.co/docs) | Beta: not yet verified with a live account |
| Composite Edge (XTS) | `compositedge` | One-time code (`requestTokenExchange`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://symphonyfintech.com/xts-trading-front-end-api/) | Beta: not yet verified with a live account |
| Definedge Securities (INTEGRATE) | `definedge` | Session login (`sessionLogin`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://www.definedgesecurities.com/api-documentation/) | Beta: not yet verified with a live account |
| Firstock | `firstock` | Session login (`sessionLogin`) | Broker Greeks | Quotes + depth | — | Full | Blocked | [docs](https://firstock.in/api/docs/) | Beta: not yet verified with a live account |
| Flattrade (Pi) | `flattrade` | One-time code (`requestTokenExchange`) | Computed Greeks | Quotes + depth | Live | Full | Blocked | [docs](https://pi.flattrade.in/docs) | Beta: not yet verified with a live account |
| Fyers | `fyers` | OAuth login (`oauthRedirect`) | Broker Greeks | Quotes + depth | — | Full | Blocked | [docs](https://fyers.in/api-docs/v3/) | Beta: not yet verified with a live account |
| Goodwill (GWC) | `goodwill` | One-time code (`requestTokenExchange`) | Computed Greeks | Quotes | Live | Full | Blocked | [docs](https://developer.gwcindia.in/api/) | Beta: not yet verified with a live account |
| Groww | `groww` | API key / token (`apiKeyToken`) | Broker Greeks | Quotes + depth | — | Full | Blocked | [docs](https://groww.in/trade-api/docs/curl) | Beta: not yet verified with a live account |
| HDFC Securities (InvestRight) | `hdfcsecurities` | API key / token (`apiKeyToken`) | Computed Greeks | Quotes + depth | Live | Full | Blocked | [docs](https://developer.hdfcsec.com) | Beta: not yet verified with a live account |
| HDFC Sky (HDFC Securities) | `hdfcsky` | API key / token (`apiKeyToken`) | Computed Greeks | Quotes + depth | Live | Full | Blocked | [docs](https://developer.hdfcsky.com/sky-docs/docs/intro) | Beta: not yet verified with a live account |
| ICICI Direct (Breeze) | `icicidirect` | One-time code (`requestTokenExchange`) | Computed Greeks | Quotes | — | Full | Blocked | [docs](https://api.icicidirect.com/breezeapi/documents/index.html) | Beta: not yet verified with a live account |
| IIFL Capital | `iiflcapital` | One-time code (`requestTokenExchange`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://developers.iiflcapital.com/apidocs/introduction) | Beta: not yet verified with a live account |
| IIFL Securities (XTS) | `iifl` | One-time code (`requestTokenExchange`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://ttblaze.iifl.com/doc/interactive/) | Beta: not yet verified with a live account |
| IndiaBulls Securities (XTS) | `ibulls` | API key / token (`apiKeyToken`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://symphonyfintech.com/xts-trading-front-end-api/) | Beta: not yet verified with a live account |
| IndMoney (INDstocks) | `indmoney` | Session login (`sessionLogin`) | Computed Greeks | Quotes + depth | Live | Full | Blocked | [docs](https://api-docs.indstocks.com/getting-started/) | Beta: not yet verified with a live account |
| Jainam (XTS) | `jainamxts` | API key / token (`apiKeyToken`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://symphonyfintech.com/xts-market-data-front-end-api/) | Beta: not yet verified with a live account |
| Kotak Securities (Neo) | `kotak` | Session login (`sessionLogin`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://github.com/Kotak-Neo/Kotak-neo-api-v2) | Beta: not yet verified with a live account |
| Motilal Oswal | `motilal` | Session login (`sessionLogin`) | Computed Greeks | Quotes | — | Full | Blocked | [docs](https://invest.motilaloswal.com/moAPI/APIDocumentation/Introduction) | Beta: not yet verified with a live account |
| mStock (Mirae Asset) | `mstock` | Session login (`sessionLogin`) | Computed Greeks | Quotes | — | Full | Blocked | [docs](https://tradingapi.mstock.com/docs/v1/typeB/User/) | Beta: not yet verified with a live account |
| Nuvama Nubra | `nubra` | Session login (`sessionLogin`) | Broker Greeks | Quotes + depth | — | Partial | Blocked | [docs](https://nubra.io/products/api/docs/rest-api-v3/index.html) | Beta: not yet verified with a live account |
| Paytm Money | `paytm` | API key / token (`apiKeyToken`) | Broker Greeks | Quotes + depth | — | Full | Blocked | [docs](https://developer.paytmmoney.com/) | Beta: not yet verified with a live account |
| Pocketful | `pocketful` | API key / token (`apiKeyToken`) | Computed Greeks | Quotes | Live | Full | Blocked | [docs](https://api.pocketful.in/docs/curl) | Beta: not yet verified with a live account |
| Profitmart (ProfitMax API) | `profitmart` | One-time code (`requestTokenExchange`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://profitmax.profitmart.in/ApiDocs/docs/intro) | Beta: not yet verified with a live account |
| RMoney (XTS) | `rmoney` | API key / token (`apiKeyToken`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://symphonyfintech.com/xts-trading-front-end-api-v2/) | Beta: not yet verified with a live account |
| Rupeezy (Vortex) | `rupeezy` | One-time code (`requestTokenExchange`) | Broker Greeks | Quotes + depth | Live | Full | Blocked | [docs](https://vortex.rupeezy.in/docs/latest/) | Beta: not yet verified with a live account |
| SAMCO Securities (StockNote) | `samco` | API key / token (`apiKeyToken`) | Broker Greeks | Quotes + depth | — | Full | Blocked | [docs](https://docs-tradeapi.samco.in/) | Beta: not yet verified with a live account |
| Shoonya (Finvasia) | `shoonya` | One-time code (`requestTokenExchange`) | Computed Greeks | Quotes + depth | Live | Full | Blocked | [docs](https://shoonya.com/api-documentation) | Beta: not yet verified with a live account |
| Tradejini (CubePlus) | `tradejini` | Session login (`sessionLogin`) | Broker Greeks | Quotes | Live | Full | Blocked | [docs](https://developer.tradejini.com/docs) | Beta: not yet verified with a live account |
| TradeSmart (Noren v2) | `tradesmart` | One-time code (`requestTokenExchange`) | Computed Greeks | Quotes + depth | Live | Full | Blocked | [docs](https://apidocs.tradesmartonline.in/v2/) | Beta: not yet verified with a live account |
| Upstox | `upstox` | OAuth login (`oauthRedirect`) | Broker Greeks | Quotes + depth | Live | Full | Blocked | [docs](https://upstox.com/developer/api-documentation/) | Beta: not yet verified with a live account |
| Wisdom Capital (XTS) | `wisdom` | API key / token (`apiKeyToken`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://symphonyfintech.com/xts-trading-front-end-api-v2/) | Beta: not yet verified with a live account |
| Zebu (Mynt) | `zebu` | One-time code (`requestTokenExchange`) | Computed Greeks | Quotes + depth | — | Full | Blocked | [docs](https://zebumyntapi.web.app/OAuth/Authentication/) | Beta: not yet verified with a live account |
| Zerodha (Kite) | `zerodha` | OAuth login (`oauthRedirect`) | Computed Greeks | Quotes + depth | Live | Full | Blocked | [docs](https://kite.trade/docs/connect/v3/) | Beta: not yet verified with a live account |

### Legend

- **Option chain**: *Broker Greeks* means IV and Greeks come from the broker's API; *Computed Greeks* means the chain's IV and Greeks are computed locally (Black-Scholes) from live prices.
- **Quotes**: *Quotes + depth* includes 5-level market depth; *Quotes* is quotes without depth.
- **Live feed**: *Live* means a streaming WebSocket feed is wired; *—* means data is polled over REST.
- **Portfolio**: *Full* is positions, holdings, funds, order book and trade book; *Partial* lacks at least one of them (Nubra has no trade-book endpoint in its REST V3 docs; Axis Direct's published collection has no usable order-book or trade-book rows).
- **Orders**: *Blocked* means the order code is built and gated, and in the Bridge only paper orders are available for it; *Armed* (Dhan) means live orders are verified (in the Bridge, behind the live opt-ins); *No* means the adapter has no order methods. Zerodha and Upstox show *Blocked* here but have beta live mapping in the Bridge (see Orders above).

## Limits, live feed and data plans

Taken from the policy table in `server/bridge/ratelimit/brokerPolicies.mjs`, last reviewed in November 2026. Figures change; the table is re-checked against the brokers' own pages and each figure there carries its source link and a `verified` flag. **A `*` means unverified**: the figure came from a forum post, a marketing page or a third party, or the broker's page could not be read. Where a broker publishes nothing, the Bridge uses conservative defaults (1 request a second for quotes, 5 for orders). `GET /v1/limits` shows what the running Bridge enforces.

- **Orders** is the broker's own order limit. The Bridge never sends more than 10 orders a second for one account, which is the exchange threshold for retail algos that are not registered.
- **Quotes and data** is the quote and market-data limit (several brokers share it with depth, history and option chains).
- **Live feed** is the most connections and instruments the broker's streaming feed allows. The Bridge keeps every feed inside it.
- **Live data plan** says whether live data costs extra. *Paid for live data* means trading calls are free but live quotes, history and the feed need a paid plan, for example Zerodha Connect (Rs 500 a month per app), a Dhan Data API plan (Rs 499 plus tax a month) or a Groww paid plan (Rs 499 plus tax a month). Every account you pool needs its own plan.
- **Plans of one broker.** Fyers has two plans with different limits. The table shows Standard (free), which the Bridge uses unless you say otherwise. If you have Fyers Prime, set `"ratelimit": { "accounts": { "fyers-main": { "tier": "prime" } } }` in your config file. Choose a higher plan only if you have it: the Bridge cannot check, and asking a broker for more than your plan allows can get your access restricted.

| Broker | id | Orders | Quotes and data | Live feed | Live data plan | Pooling terms |
|---|---|---|---|---|---|---|
| 5paisa | `fivepaisa` | 10/s, 600/min* | default | 200 instruments* | Free* | see below |
| 5paisa (XTS) | `fivepaisaxts` | 10/s* | 1/s* | not published | not checked | not reviewed |
| Alice Blue | `aliceblue` | 10/s | 5/s | not published | not checked | see below |
| Anand Rathi (Algozy, XTS) | `anandrathi` | 10/s* | 1/s* | not published | not checked | not reviewed |
| Angel One (SmartAPI) | `angelone` | 9/s | 1/s | 3 connections, 1,000 instruments* | Free | see below |
| Arrow | `arrow` | 10/s | 10/s | not published | not checked | not reviewed |
| Axis Direct (RAPID APIs) | `axisdirect` | default | default | not published | not checked | not reviewed |
| Bigul (Bigul Connect) | `bigul` | default | default | not published | not checked | not reviewed |
| Composite Edge (XTS) | `compositedge` | 10/s | 1/s* | not published | not checked | not reviewed |
| Definedge Securities (INTEGRATE) | `definedge` | default | 10/s* | not published | not checked | not reviewed |
| Dhan | `dhan` | 10/s, 250/min, 1,000/hour, 7,000/day | 1/s | 5 connections, 5,000 instruments | Paid for live data | see below |
| Firstock | `firstock` | 10/s | 1/s | not published | not checked | not reviewed |
| Flattrade (Pi) | `flattrade` | 10/s, 40/min | 40/s, 200/min | not published | Free* | see below |
| Fyers | `fyers` | 10/s, 200/min, 100,000/day | 5/s, 50/min, 5,000/day | 1 connection, 100 instruments | Free | see below |
| Goodwill (GWC) | `goodwill` | default | default | not published | not checked | not reviewed |
| Groww | `groww` | 10/s, 250/min | 10/s, 300/min | 1,000 instruments | Paid for live data | see below |
| HDFC Securities (InvestRight) | `hdfcsecurities` | default | default | not published | not checked | not reviewed |
| HDFC Sky (HDFC Securities) | `hdfcsky` | default | default | 3 connections, 300 instruments* | Free* | see below |
| ICICI Direct (Breeze) | `icicidirect` | 10/s | 100/min, 5,000/day | not published | Free | see below |
| IIFL Capital | `iiflcapital` | 10/s | 10/s | not published | not checked | not reviewed |
| IIFL Securities (XTS) | `iifl` | 10/s | 1/s* | not published | not checked | not reviewed |
| IndiaBulls Securities (XTS) | `ibulls` | 10/s* | 1/s* | not published | not checked | not reviewed |
| IndMoney (INDstocks) | `indmoney` | 10/s | 5/s, 100,000/day | not published | not checked | not reviewed |
| Jainam (XTS) | `jainamxts` | 10/s* | 1/s* | not published | not checked | not reviewed |
| Kotak Securities (Neo) | `kotak` | 10/s | default | 200 instruments* | Free | see below |
| Motilal Oswal | `motilal` | 10/s | default | not published | Not known* | see below |
| mStock (Mirae Asset) | `mstock` | 30/s | 20/s | not published | not checked | not reviewed |
| Nuvama Nubra | `nubra` | default | 60/min | not published | not checked | not reviewed |
| Paytm Money | `paytm` | default | default | not published | not checked | not reviewed |
| Pocketful | `pocketful` | 10/s | 10/s | 8 connections, 1,500 instruments* | not checked | not reviewed |
| Profitmart (ProfitMax API) | `profitmart` | default | default | not published | not checked | not reviewed |
| RMoney (XTS) | `rmoney` | 10/s* | 1/s* | not published | not checked | not reviewed |
| Rupeezy (Vortex) | `rupeezy` | 10/s | 1/s | not published | not checked | not reviewed |
| SAMCO Securities (StockNote) | `samco` | default | default | not published | not checked | not reviewed |
| Shoonya (Finvasia) | `shoonya` | 10/s* | 10/s* | 1 connection | Not known* | see below |
| Tradejini (CubePlus) | `tradejini` | 10/s | default | 5 connections, 3,000 instruments* | not checked | not reviewed |
| TradeSmart (Noren v2) | `tradesmart` | default | default | not published | not checked | not reviewed |
| Upstox | `upstox` | 10/s, 500/min, 2,000/30 min | 50/s, 500/min, 2,000/30 min | 2 connections, 2,000 instruments | Free | see below |
| Wisdom Capital (XTS) | `wisdom` | 10/s* | 1/s* | not published | not checked | not reviewed |
| Zebu (Mynt) | `zebu` | 10/s* | 10/s* | not published | not checked | not reviewed |
| Zerodha (Kite) | `zerodha` | 10/s | 1/s | 3 connections, 3,000 instruments | Paid for live data | see below |

### What the brokers' terms say about pooling

Pooling means spreading your read-only market-data calls over your own accounts (see [guides/rate-limits.md](guides/rate-limits.md)). **No broker's published terms clearly allow it and none clearly forbids it**, so every entry is `unknown` and pooling stays off until you accept a notice for named accounts. What the November 2026 review found, per broker (brokers not listed were not reviewed):

- **Alice Blue**: The documentation page could not be read, so nothing is known about spreading reads over several accounts.
- **Angel One (SmartAPI)**: Angel One's staff say the rate limit is based on User ID, but no official statement allows or forbids spreading reads over several accounts.
- **Dhan**: Dhan's terms are silent on several accounts, bar sharing credentials and bar 'data mining, data harvesting, data extracting' (written about the website), so get a legal read.
- **5paisa**: The terms page was not read and nothing found says anything about several accounts.
- **Flattrade (Pi)**: No API terms were found, so nothing is known about spreading reads over several accounts.
- **Fyers**: Fyers' terms bar permitting 'the use of the APIs by any third party' and sharing credentials with other clients, and say nothing about your own several accounts, so get a legal read.
- **Groww**: Groww's API terms could not be read, so nothing is known about several accounts, and every pooled account would need the paid data plan.
- **HDFC Sky (HDFC Securities)**: The developer documentation could not be read and no terms were found, so nothing is known about several accounts.
- **ICICI Direct (Breeze)**: No Breeze-specific terms were found; the 5,000 calls a day are shared by every endpoint, which makes pooling tempting and a legal read worthwhile.
- **Kotak Securities (Neo)**: Kotak says API access and credentials are 'meant exclusively for the client's own use' and bars third-party access to your account; it says nothing about several of your own accounts, so get a legal read.
- **Motilal Oswal**: Motilal's FAQ says 'Using multiple API keys to circumvent the OPS limit is not permitted'; that is about order limits, not reads, and the FAQ contradicts itself, so ask the broker in writing.
- **Shoonya (Finvasia)**: Shoonya's terms say credentials 'are intended to be used only by you' and bar sublicensing the APIs to a third party; they are silent on several of your own accounts.
- **Upstox**: Upstox's developer terms (accepted when you create an app) could not be read; limits are per user and no page read mentions several accounts.
- **Zerodha (Kite)**: Zerodha's documents are silent on several accounts; an API key is bound to one client id and its staff refer multi-user questions to the compliance team.

This is a reading of public pages, not legal advice. A legal read is recommended before you turn pooling on, and for any use beyond your own machine.

## Sign-in methods

| Method | Auth kind | What you do |
|---|---|---|
| API key / token | `apiKeyToken` | Paste API keys or a token from the broker's developer portal. Daily tokens need pasting again when they expire. |
| OAuth login | `oauthRedirect` | Log in on the broker's site, then paste the access token it issues (expires daily). |
| One-time code | `requestTokenExchange` | Log in on the broker's site and paste the one-time code from the redirect; the Bridge exchanges it once for a session. |
| Session login | `sessionLogin` | Save the non-secret keys, then use **Log in** each session with your PIN or password and the current 6-digit authenticator code. Only the session token the broker returns is kept. |

### Notes on the newer beta brokers

- **Rupeezy (Vortex)**: the access-token lifetime is not documented; it is cached until 05:00 IST and dropped on a 401. SENSEX/BANKEX use the `BSE_EQ`/`BSE_FO` segments found in Rupeezy's master but not in its docs.
- **ICICI Direct (Breeze)**: NSE only (Breeze offers no BSE or MCX). No live feed yet (Breeze streams over Socket.IO) and no market depth. Breeze allows only limit and stop-loss orders, from your registered static IP.
- **Goodwill (GWC)**: no SENSEX/BANKEX options (no BFO master is published) and no candles. OI in the REST chain is 0 because `getquote` carries no OI; the live feed does carry OI.
- **Bigul (Bigul Connect)**: quotes, depth and chains come from Bigul's market-data WebSocket, since there is no REST quote endpoint. No candles. Your machine's static IP must be whitelisted on the app.
- **Anand Rathi (Algozy, XTS)** and **5paisa (XTS)**: the shared Symphony XTS adapter on each broker's own host. 5paisa (XTS) is a second route to 5paisa, alongside the regular `fivepaisa` connection, and 5paisa must approve the XTS apps.
- **Profitmart (ProfitMax API)**: no live feed yet; the documented WebSocket handshake differs from the shared Noren feed.
- **Axis Direct (RAPID APIs)**: read-only (chains, quotes, positions, holdings, funds). The Bridge has no route yet that starts the Axis SSO login for you: run the SSO Initiate request from Axis's RAPID API collection, sign in, and paste the `ssoId`.

## Using a broker through the Bridge

Add an account under `accounts` in `bridge.config.json` (`mc-bridge init` can do this for you; see [guides/accounts.md](guides/accounts.md)), then sign in with `mc-bridge accounts connect <accountId>` or `POST /v1/accounts/{accountId}/session`. Every market-data, portfolio and order route takes an optional `account` parameter; without one the Bridge picks your default account. A capability the broker's adapter does not declare answers `422 CAPABILITY_UNSUPPORTED`; a missing or expired session answers `422 SESSION_EXPIRED` with a hint to sign in again. `GET /v1/brokers` lists what each adapter offers, without credentials. The full API is in [openapi.yaml](openapi.yaml); adapter internals are in [broker-contract.md](broker-contract.md).
