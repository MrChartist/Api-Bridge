# Supported brokers

The Bridge can read option chains, quotes, history and your portfolio from **41 Indian brokers**, and can hold several accounts per broker. Broker keys are saved encrypted on your own machine (`data/secrets.enc`, sealed with the master key) and go only from the Bridge to the broker over HTTPS. Passwords, PINs, MPINs and TOTP codes are never stored: a session login uses them once and keeps only the session token the broker returns.

**Verification status.** Only **Dhan** has been verified end to end with a live account. Every other broker is **beta: not yet verified with a live account**. Each adapter was written from the broker's official API documentation and is tested against recorded sample responses (`server/brokers/__fixtures__/`), with no network calls in tests. Please check figures against your broker before relying on them, and report what you find.

**Orders.** Every adapter except Axis Direct (read-only) has order methods, and each is wrapped in an order gate that refuses without a valid, single-use, broker-bound gate. In the Bridge, orders are **paper by default**. A live order needs every opt-in described in the README's safety model (live mode on in the config, the account marked live, an `orders:live` key, and the safety guard passing), and live order mapping is wired only for **Dhan** (verified), **Zerodha** and **Upstox** (beta, a warning on every live order). For every other broker the Bridge answers live orders with a clear "use paper mode" error. The "Orders" column below describes the adapter itself.

**Rate limits.** Each broker's documented limits are in `server/bridge/ratelimit/brokerPolicies.mjs`, with a source link and a `verified` flag per number. Where a broker publishes no limit (Goodwill, Bigul, Profitmart, Axis Direct and several older adapters), the Bridge uses conservative defaults: 1 request a second for quotes, depth, history and chains, 2 a second for portfolio calls, 5 a second for orders. `GET /v1/limits` shows the table the running Bridge uses.

## Capability table

The capability columns are generated from each adapter's declared `capabilities` (see `src/lib/brokerCapabilities.generated.ts`, rebuilt with `node scripts/generate-broker-capabilities.mjs`), the same source `GET /v1/brokers` and the dashboard use.

| Broker | id | Sign-in (auth kind) | Option chain | Quotes | Live feed | Portfolio | Orders | Official docs | Status |
|---|---|---|---|---|---|---|---|---|---|
| Dhan | `dhan` | API key / token (`apiKeyToken`) | Broker Greeks | Quotes + depth | Live | Full | 1Cliq (armed) | [docs](https://dhanhq.co/docs/v2/) | Verified with a live account |
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
- **Orders**: *Blocked* means the order code is built and gated, and in the Bridge only paper orders are available for it; *1Cliq (armed)* (Dhan) means live orders are verified (in the Bridge, behind the live opt-ins); *No* means the adapter has no order methods. Zerodha and Upstox show *Blocked* here but have beta live mapping in the Bridge (see Orders above).

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

## Attribution

The broker API facts behind these adapters (endpoints, field names, error codes, instrument formats) were cross-checked against the open-source [OpenAlgo](https://github.com/marketcalls/openalgo) project (AGPL-3.0, github.com/marketcalls/openalgo) and each broker's official API documentation, linked above. Where the two disagreed, the official documentation was followed. No OpenAlgo code is included in this project: OpenAlgo was used only as a factual reference, and every adapter was written independently.
