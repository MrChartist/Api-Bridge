# BRD: A world-class Options platform, India first

Status: draft for owner review (rev 2, after critique) · Owner: Head of Product, Options desk · Date: 29 Oct 2026

Scope: the Options group of the Mr. Chartist Bridge dashboard (`server/bridge/dashboard/`). Today that group has Option Chain, Strategy Builder, OI Analysis, Volatility, Option Screener, Arbitrage and Positions. Server work under `server/bridge/` is in scope where it gives those pages data, and so is the `/v1/options/*` API that serves the same numbers to programs. The per-page PRDs (`docs/prd/01`–`08`) stay valid. This BRD sits above them: it says what to build next and why. Each Phase 1 item later gets its own PRD.

**In and out of scope.**
- **In:** NSE and BSE equity derivatives (index and stock options and futures) for Indian residents trading through the Indian brokers in `server/bridge/ratelimit/brokerPolicies.mjs`.
- **Later (Phase 3, §3.M):** MCX commodity options and NSE/BSE currency options. Their sessions, expiry rules, lot units and pricing differ (§3.M). Until then the recorder, calendar and maths assume the 09:15–15:30 IST equity-derivatives session.
- **Out:** US (and other non-Indian) underlyings, brokers and data. Comparisons with thinkorswim, SpotGamma or OPRA-based flow tools are about product ideas, not parity. Indian feeds have no trade-print tape, so flow tools here are approximations (§3.D).

Sources: five research briefs (US retail, US flow and volatility, India, professional/institutional, and feature families) plus a gap audit of our own code, all dated October 2026, and a review critique (rev 2). Claims about competitors come from vendor pages, reviews and forums. Many Indian comparisons were written by AlgoTest, a competitor, so read them as slanted. Prices change often and are approximate. Every regulatory number in this document is **needs verification** against the primary circular before it becomes a rule in code.

> **Open question: what is "Vail"?** The request asks us to "look at the Vail option". No options product with that name turned up in four searches. The only hits were Vail Resorts (MTN) and Vale (VALE) option chains, and two crypto projects. Our working assumption is **Volland (vol.land)**, the vanna and charm dealer-exposure tool. Spoken aloud it sounds like "Vail". We also cover vol-surface tools such as Velo, Genesis Volatility and Laevitas. If the owner meant something else, §4 and the "dealer positioning" rows of §3 are the parts to revisit.

---

## Contents

1. Vision and positioning
2. Personas and their jobs
3. Feature catalogue
4. Signature differentiators
5. Data strategy (stores, broker feasibility, cost)
6. Roadmap: Phase 1 (with acceptance criteria), Phase 2, Phase 3
7. Non-functional requirements (including API contract and security)
8. Risks and compliance
9. Metrics
10. Appendix: chart policy, glossary, sources

---

## 1. Vision and positioning

### 1.1 Vision

**One desk where an Indian options trader can see the market, test an idea, size and place it safely, and manage it until expiry, with every number explained and replayable.**

Today an Indian trader uses five tools for one trade:
- Sensibull or the broker for the chain and the payoff.
- Opstra for IV history.
- iCharts or TrueData for straddle and OI charts.
- AlgoTest for backtests.
- Kite for the basket and its margin.

None of them shows its working, and none lets the trader rewind. Our job is to be the one tool, and to be the most honest one.

### 1.2 Positioning statement

For Indian F&O traders who take options seriously, from a ₹50,000 NIFTY buyer to a ₹5 crore index seller, and for the developers who build on their data, the Options desk is a self-hosted, multi-broker options platform with an open API. It joins the following in one place, on your own machine and your own broker accounts:
- Sensibull's ease of use.
- thinkorswim's analysis depth.
- SpotGamma and Volland's positioning ideas, adapted to Indian data.
- AlgoTest's replay and testing.

Unlike Sensibull it is not tied to one broker session. Where the broker has a basket-margin API, it shows **the broker's own margin figure at the time of the call** rather than our estimate. That figure can still differ from what is later blocked (§3.G G2). Unlike US tools it understands Indian contracts:
- Tuesday (NSE) and Thursday (BSE) expiries, from data.
- Lot revisions, freeze quantities and corporate-action adjustments.
- Expiry-day ELM, physical delivery of stock options and the index settlement average.
- Participant OI, MWPL and the ban list.

### 1.3 Positioning against the field

Every competitor cell below is **[K]**: taken from the research briefs and user reports, not independently verified, as of Oct 2026. Several of these products ship changes every quarter, and many India comparisons came from AlgoTest. **This table is for internal planning only.** No cell goes into marketing until it carries a [V] tag and a verification date.

| Axis | Sensibull | Opstra | Quantsapp | AlgoTest | thinkorswim | OptionStrat | SpotGamma/Volland | **Us (target)** |
|---|---|---|---|---|---|---|---|---|
| Chain and builder UX | Best in India | Dated | Dense | Basic | Deep, slow | Best visual | n/a | Sensibull-clean, ToS-deep |
| Time dimension (OI/IV/straddle over time) | Many live charts | IV history | Yes | Replay | thinkBack | Hist. prices | Intraday | Every metric recorded, replayable |
| Backtest / replay / forward test | Not core (verify) | Simulator | Limited | Best | thinkBack, OnDemand | None seen | None seen | Replay + paper + forward in one ledger |
| Dealer positioning | None seen | None seen | Writers' levels | None seen | None seen | None seen | Best (opaque) | Transparent, with stated assumptions |
| Margin | Estimate (user complaints of mismatch) | n/a | Yes | n/a | Broker | None | n/a | Broker basket-margin API at call time + rule-aware preview |
| Alerts → action | P&L alerts | None seen | Strategy alerts | Algo | thinkScript | Flow alerts | None | Unified engine over IV, Greeks, OI, P&L and spot |
| Multi-broker | Per broker | Definedge | Some | 50+ for execution | Schwab only | None | n/a | Native: every connected account in one book |
| Openness | Closed | Closed | Closed | Closed | thinkScript | URL share | No public API seen | Versioned REST, export, Excel/Sheets, MCP |

### 1.4 Design principles (in addition to PRD 08 P1–P8)

- **D1. Show the working.** Every derived number has a method note: the formula, its inputs, the model (Black-76 on the parity forward), the vol-time clock, the rate, the time of the data and its source. No black-box scores and no proprietary levels we cannot explain. (SpotGamma's top complaint is that its levels are opaque.)
- **D2. Time is a first-class axis.** Anything shown "now" can also be shown "at 10:15 today", "at yesterday's close" and "N days ago".
- **D3. Paper and live use the same ticket, the same margin call and the same ledger.** Only the mode flag differs.
- **D4. Fast before fancy.** A feature that makes the chain lag does not ship. Lag is the top complaint about every Indian incumbent.
- **D5. Honest unavailability.** If data is missing, the UI says "Unavailable", with the reason and when it will be ready (for example "IVR: 34 of 252 days collected"). It never fakes a value.
- **D6. India-correct by data, not by code.** Expiry days, sessions, lot sizes, freeze quantities, holidays, the ban list, F&O membership, corporate actions, margin rules, the risk-free rate and brokerage plans come from data sources and config, never from constants. Existing constants that break this (`RISK_FREE`/`RATE` 0.065, `brokeragePerOrder` 20, the 09:15–15:30 session in `options.js`) are Phase 1 debt (P1-2, P1-3).
- **D7. The user decides; the platform calculates.** Optimizers, scores and AI rank and explain. They never "recommend" a trade, and names and labels stay neutral (see §8, RA rules).
- **D8. Calibrated or labelled.** A probability (PoP, expected-move band, level) is shown with its measured calibration once enough recorded outcomes exist, and as "uncalibrated" until then (K6).

---

## 2. Personas and their jobs

Persona codes used in the catalogue: **B** Buyer, **S** Seller, **H** Hedger/investor, **A** Arbitrageur, **P** Pro/vol trader, **X** Expiry-day scalper, **L** Learner, **Q** Developer/quant API user, **M** Multi-account (family) operator, **T** Tax-aware trader, **C** Commodity and currency trader.

| Code | Persona | Profile | Jobs to be done | What they hate today |
|---|---|---|---|---|
| B | **Directional buyer** | ₹50k–₹5L capital. Buys NIFTY/SENSEX/stock CE/PE, holds minutes to days. Largest group, highest loss rate. | Pick a strike and expiry that pays if the view is right. Know the theta cost. Set SL and target. See whether OI, breadth and heavyweights agree with the view. Exit fast. | Buying expensive IV before events. Theta surprises. Not knowing the expected move. Slow, laggy chains. |
| S | **Premium seller** | ₹5L–₹5Cr. Short strangles, iron condors and ratio spreads on indices. Runs weekly or monthly cycles. | Sell rich IV at chosen strikes. Size within margin and cut margin with cheap hedges. Manage tested sides with rolls and adjustments. Watch decay. Protect against gap risk using overnight cues. | Margin estimates that don't match the broker. Sell legs rejected after buy legs fill. Short-margin penalties on exits. No IV rank. Adjustments not tracked as one trade. No automatic max-loss exit. |
| H | **Hedger / investor** | Holds stocks or a mutual-fund-like portfolio. Uses puts, collars and covered calls. | Protect a portfolio cheaply. Beta-weight holdings to NIFTY. Choose a covered-call strike. Roll before expiry. Avoid physical delivery of stock options. | No tool joins holdings with options. Delivery margin and STT surprises at expiry. Jargon. |
| A | **Arbitrageur** | Conversions and reversals, boxes, calendar basis, cash-futures. Low margin of error. | Find edge after all charges, using their own brokerage plan and a market rate. Know fillable size at the touch. Execute all legs near-atomically. Track carry versus funding. | Stale quotes. Legging risk. Freeze limits. Charges eating the edge. |
| P | **Pro / vol trader** | Prop desk, HNI or ex-sell-side. Trades skew, term structure, events and positioning. | Read the surface and how it moved, on a trading-time clock. Compare a fitted smile. Stress the book in rupee Greeks. Attribute P&L to Greeks. Cross-check skew against Bloomberg or Laevitas conventions. | Retail tools with no fitted surface, no smile history and no stress grid. Calendar-time theta that is wrong around weekends. Bloomberg costs about $25k a seat. |
| X | **Expiry-day scalper** | NIFTY on Tuesday and SENSEX on Thursday, 0DTE. Seconds-to-minutes holds. | One screen with index, CE and PE charts and the chain. One-tap entry and exit. Drag SL and target on the chart. See gamma pressure, pin zones and the running settlement estimate in the last 30 minutes. | Execution lag. Too many clicks. Freeze-quantity rejections. Greeks that blow up after 14:00. |
| L | **Learner** | New to options, often on paper. | Understand every metric. Try strategies with no risk. See why a trade made or lost money. | Jargon. Payoffs that don't explain themselves. Paper trading that doesn't feel like the real thing. |
| Q | **Developer / quant API user** | Writes Python, Excel or AI-agent code against the Bridge. Often also one of the above. | Pull recorded chains, IV history, exposure, levels, participant OI and basket margin by REST, MCP or Sheets, on a schedule, without breaking when we ship. | Undocumented fields, silent unit changes, no history API, scraping. |
| M | **Multi-account (family) operator** | Runs own, spouse's and dependent parents' or children's accounts, or an HUF account, often across two brokers. | See each account and the family total. Place orders per account under the right holder. Stay inside the algo "family" definition and never manage money for anyone outside it. | Logging in and out of accounts. Tools that mix holders or pool data across people. |
| T | **Tax- and compliance-aware trader** | Any F&O trader at return-filing time (June–July), or one near the tax-audit threshold. | Know F&O turnover, realised P&L by financial year and whether a tax audit applies. Reconcile charges against contract notes. Export for the CA. | Broker P&L reports that disagree with contract notes. Working out turnover by hand. |
| C | **Commodity and currency trader** (Phase 3) | Trades MCX crude oil and natural gas options in the evening session, or NSE/BSE currency options. | Same chain, payoff and margin jobs as S and B, on options on futures with units in barrels or mmBtu and sessions to 23:30/23:55. | Equity-only tools that stop at 15:30. |

**Primary personas for Phase 1:** S, B and X, because they make up most of Indian index-option volume. Q is served in Phase 1 by the API contract in §7.8, because every Phase 1 item ships an endpoint. P and A get the most product depth per feature. M is served by account-tagged books and guardrails (P1-13). T is Phase 2 (F10). H and L are served mainly through defaults and explainers. C is Phase 3.

---

## 3. Feature catalogue

How to read the table:
- **Have**: whether we have it today, according to the code audit. `yes`, `partial` or `no`. `yes` rows show `—` for effort and `done` for phase, even when follow-up work is tracked in another row.
- **Data**: whether we can get the data it needs. `yes` means available now. `derivable` means we can compute it from data we have, or record it ourselves (often needing the §5 recorder). `no` means it needs a new external source or is not obtainable.
- **Effort**: S is up to 1 week, M is 2–4 weeks and L is over 4 weeks, for one engineer, including tests.
- **Value**: 1–5, weighted by persona reach, competitive gap and how often it is used.
- **Best today**: who does it best now ([K], §1.3).
- **Phase**: the phase we plan it for (P1, P2, P3). "P1 (with X)" means it is built inside the item that builds X.

### 3.A Option chain

| # | Feature | What it does exactly | Personas | Best today | Have | Data needed | Data | Effort | Value | Phase |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | Core chain with presets | Calls and puts by strike: LTP, bid/ask, OI, ΔOI, volume, IV and Greeks. 7 persona presets with customisable columns. Greeks use calendar ACT/365 time today, so they are not valid for 0DTE after about 14:00 until A15 lands. | All | Sensibull, Fyers, Groww | yes | `/v1/optionchain` | yes | — | 5 | done |
| A2 | Stock options coverage | Every F&O stock (about 180) on chain, OI, vol, screener, builder and positions. The underlying list comes from the point-in-time F&O universe (J9), not the hard-coded 6 indices. Lots and freeze quantity come from data. | All | Sensibull, Dhan, NSE | **no** | instrument master, chain per stock | yes | M | 5 | P1 |
| A3 | Streaming chain | Ticks over `/v1/stream` patch cells live; REST is only the fallback. Per-cell flash, with a freshness pill per row. | All, esp. X | Dhan, Sahi | no (3 s polling) | WS ticks for the chain's instruments | yes | M | 5 | P1 |
| A4 | Bid IV / ask IV / mid IV | Separate bid, ask and mid IV columns next to price, all Black-76 on the parity forward. | P, S, A | Bloomberg OMON, Deribit | partial (one IV) | bid, ask, forward | derivable | S | 4 | P2 |
| A5 | Fitted theo and edge column | Theoretical value from a fitted smile (SVI or spline per expiry). "Edge" = market mid minus theo, in ₹ and in vol points. Flags read "premium above fit" or "below fit", never "rich/cheap" or "sell/buy". | P, S | OptionVue, Bloomberg | no | chain + fit | derivable | M | 4 | P2 |
| A6 | Strike axis modes | Show strikes as price, delta, moneyness %, or σ from forward. Centre on ATM or on a chosen delta. | P, S | Bloomberg, Deribit | partial (σ distance column) | Greeks, forward | derivable | S | 3 | P2 |
| A7 | Expected move and σ bands | Two labelled quantities. **σ bands**: F·exp(±k·σ_ATM·√T) for k = 1, 2, from ATM IV on the forward with T from the vol-time clock (A15). **Expected absolute move**: the ATM straddle (≈ √(2/π)·σ·F·√T ≈ 0.8σ move), shown as a range around the forward. The tastytrade "0.85 × straddle" heuristic is not used. | B, S, L | tastytrade | partial (±1σ band) | ATM IV, straddle, forward | yes | S | 4 | P1 (with B2) |
| A8 | POP / P50 / Prob-touch columns | Probability ITM, of touching, of profit for a short at that strike, and P50 (chance of reaching 50% of max profit). Calibration shown per K6. | S, B | thinkorswim, tastytrade | partial (PoP) | Greeks, IV | derivable | S | 4 | P2 |
| A9 | Straddle chain view | One row per strike: straddle price, its change, straddle IV, and breakevens. | S, X | Dhan | no | chain | yes | S | 4 | P1 (with D4) |
| A10 | Volume vs average / Sizzle | Volume of each strike and of the underlying against its 5-day (and 20-day) average, separately for calls and puts. "IV sizzle" = IV against its 5-day average. | B, P | thinkorswim Sizzle | no | recorded daily volume and IV | derivable (needs §5 store) | S | 3 | P2 |
| A11 | Illiquid-strike dimming | Dims strikes with a wide spread, zero volume or a stale quote, and explains why on hover. | All, L | Groww | partial (liquidity score) | bid/ask, ts | yes (ts needs `ChainLeg.ts`) | S | 3 | P1 (with A3) |
| A12 | Multi-expiry chain | Several expiries side by side or stacked, with the same strikes aligned. | P, S | Bloomberg, ToS | no | chain × N | yes | M | 3 | P2 |
| A13 | Click-to-pricer | Any row opens the pricer (G7) with that contract loaded. | P | Bloomberg OVME | no | — | — | S | 3 | P3 |
| A14 | Bid/ask quantity and depth | Quantity at the touch in the chain, plus a 5-level depth pop-over. | A, X | Dhan, NSE | partial (depth endpoint, not in the chain) | `bidQty`/`askQty` on `ChainLeg`, `/v1/depth` | derivable (needs schema add) | S | 3 | P1 (with A3) |
| A15 | Vol-time clock | One configurable time model for all pricing, IV, Greeks, expected move and theta: calendar ACT/365; trading days/252 from the S5 holiday calendar; or weighted (weekend, holiday and event-day weights, intraday by minutes to the settlement window). Default: weighted, with the choice and weights in every method note. Replaces `d/365`, `theta/365` and `T_FLOOR` in `options.js`. | P, S, X, all | ORATS, Bloomberg, Volland | no | S5 calendar, events (optional) | derivable | M | 5 | P1 |
| A16 | Running settlement estimate | On expiry day from 15:00, the running average of the index over the settlement window (the last 30 minutes per exchange method; **needs verification**), with the remaining-minutes weight. The payoff and P&L at expiry are evaluated at it as well as at spot. | X, S | nobody seen | no | index ticks | yes | S | 4 | P1 (with B2) |

### 3.B Strategy builder and trade analysis

| # | Feature | What it does exactly | Personas | Best today | Have | Data needed | Data | Effort | Value | Phase |
|---|---|---|---|---|---|---|---|---|---|---|
| B1 | Payoff with today/target/expiry lines | P&L against spot at T+0, at a target date and at expiry. Shows max P/L, breakevens, POP, Greeks, charges and expected value. | All | Sensibull, ToS | yes | chain | yes | — | 5 | done |
| B2 | Multi-expiry builder | Legs in different expiries: calendars, diagonals, double calendars, plus futures legs from different months. At each expiry, the payoff values the remaining legs with Black-76 at a modelled IV. | S, P | ToS, OptionStrat, Fyers | **no** (single expiry) | chains for each expiry | yes | M | 5 | P1 |
| B3 | P&L heatmap table | Grid of price rows × date columns (to the minute on expiry day), with cells in ₹ or % of risk and a colour scale. Clicking a cell sets the scenario. | All | OptionStrat | partial (scenario table) | — | derivable | S | 5 | P1 |
| B4 | Price-slice grid | Rows at spot offsets (%, ₹, σ, at breakevens, at walls) showing position P&L, Δ, Γ, Θ and Vega at each. User-editable. | S, P | thinkorswim | partial | — | derivable | S | 4 | P1 |
| B5 | IV and skew sliders, per-leg vol override | A whole-position IV shift, a per-expiry shift, a skew tilt, and a "sticky strike / sticky delta" model toggle. | P, S | ToS, SpotGamma calc | partial (IV shift) | — | derivable | S | 4 | P2 |
| B6 | Probability cone and distribution overlay | The implied lognormal (or smile-implied, Breeden-Litzenberger) distribution at expiry overlaid on the payoff. 1σ/2σ cones over time. | B, S, L | ToS, tastytrade Curve | no | chain smile | derivable | M | 4 | P2 |
| B7 | Strategy optimizer | Inputs: target price (or "bullish" = +1σ), target date, budget or margin, and a slider from max return to max chance. Searches structures (singles, verticals, butterflies, condors, calendars, ratios) and ranks cards with mini payoff, profit at target, max risk, margin, POP and return/risk. Shows its ranking formula. "Ranked by your inputs", never "best". | B, S, L | OptionStrat, Fyers Finder, Quantsapp | no | chains, margin | derivable | L | 5 | P2 |
| B8 | Editable probability distribution | Starts from the market-implied distribution, shown as bars. The user drags the bars to their own view, and the optimizer re-ranks by expected P&L under that view against the market's, with the method shown. | P, B | IBKR Probability Lab | no | chain | derivable | M | 4 | P3 |
| B9 | Load live positions + hypothetical legs | Builder opens with the current book (read-only legs) plus draft legs, showing before/after P&L, Greeks and margin. Prevents unexpected netting. | S, P, H | Deribit, OptionNet | partial (positions hedge helper) | `/v1/positions` | yes | M | 5 | P2 |
| B10 | Compare two strategies | Overlays two payoffs and a delta table of metrics. | All | Hoadley | no | — | derivable | S | 3 | P2 |
| B11 | Drag-to-adjust strikes | Drag a leg's strike marker on the payoff or ladder; everything recomputes live. | All | tastytrade, E*TRADE | no | — | derivable | M | 3 | P2 |
| B12 | Leg dissection | Shows each leg's payoff stacked under the total. | L, P | Hoadley | no | — | derivable | S | 2 | P3 |
| B13 | Shareable strategy link and image card | A URL encoding legs (no prices, no account data) opens read-only in the builder. A PNG/SVG card shows payoff, Greeks and breakevens. | All | OptionStrat, Sensibull | partial (local named saves) | — | derivable | S | 3 | P2 |
| B14 | Event-aware builder | Flags any event (RBI, Budget, results, holiday) inside the target window and adds the event's implied move to the scenario grid. | B, S | Market Chameleon | no | events calendar (J4) | no → J4 | S | 4 | P2 |
| B15 | Margin-benefit hedge finder | For a short position or basket, ranks far-OTM buy legs by margin saved (from G2) per rupee of premium, and shows the new margin, max loss and payoff. Calls the broker margin API within the rate budget (cached, small candidate set). Neutral copy: "reduces margin by ₹X for ₹Y premium". | S, A | nobody seen | no | G2, chain | derivable | M | 5 | P2 |

### 3.C Volatility

| # | Feature | What it does exactly | Personas | Best today | Have | Data needed | Data | Effort | Value | Phase |
|---|---|---|---|---|---|---|---|---|---|---|
| C1 | IV Rank and IV Percentile | 52-week (and 30/90-day) IVR and IVP of 30-day constant-maturity ATM IV, plus the same for each listed expiry. Shown on chain, vol page, screener and ticket. | All | tastytrade, Opstra, Sensibull | **no** ("Unavailable") | daily IV store | derivable (start recording + backfill) | M | 5 | P1 |
| C2 | IV history chart | ATM IV, VIX, HV20 and IV−HV over time, rolling to the next expiry on expiry day. Backfilled segments shown as lower-quality. | S, P, B | Opstra, Sensibull | no | daily IV store; intraday from recorder | derivable | S | 5 | P1 |
| C3 | Smile, RR25, fly, term structure, forward vol | Already on `#/vol`. RR25 sign changes to the market convention with C4. | P, S | Opstra | yes | chain × expiries | yes | — | 4 | done |
| C4 | Constant-maturity IV and skew | 7/30/60/90-day ATM IV, RR25 and BF25 interpolated in total variance on the vol-time clock, with history. RR25 = call 25Δ IV − put 25Δ IV (market convention; negative for equity indices). A separate "put skew" (put − call) may be shown under that name. | P | Laevitas, Amberdata, ORATS | no | IV store | derivable | S | 4 | P2 |
| C5 | Skew shadow | Today's smile overlaid on 1d/1w/1m-ago smiles and on a 1-year 10–90 percentile band. | P, S | Amberdata, Bloomberg SKEW | no | stored smiles (daily, 9 delta points) | derivable | S | 4 | P2 |
| C6 | Fixed-strike matrix | Strike × expiry grid of IV, coloured by change since previous close (or since N minutes ago). | P, S | SpotGamma Vol Dashboard | no | chain × expiries + recorder | derivable | S | 4 | P2 |
| C7 | Fitted surface (SVI) with fit quality | A per-expiry SVI fit with arbitrage checks. RMSE and the strikes excluded are shown. Graceful fallback for thin stock-option wings. A 3D or delta-table view. | P | LSEG, Bloomberg OVDV | no | chain × expiries | derivable | L | 3 | P3 |
| C8 | Realized vol estimators | Close-to-close, Parkinson and Yang-Zhang at 10/20/60 days, with IV−RV spread and its z-score. | P, S | ORATS, Laevitas | partial (HV20) | daily OHLC | yes | S | 4 | P2 |
| C9 | Event implied move vs history | Event-day implied move (from the straddle term structure: forward-variance jump) compared with the actual moves of the last 4/8/12 events of the same type. Covers results for stocks; RBI, Budget and US CPI for indices. | B, S, P | Market Chameleon, ORATS | no | events calendar, IV store, daily candles | derivable after J4 | M | 4 | P2 |
| C10 | Ex-event IV | IV with the event variance removed, to compare expiries fairly. | P | ORATS | no | as C9 | derivable | S | 3 | P3 |
| C11 | VIX panel | INDIA VIX, its percentile, and VIX vs NIFTY 30-day IV. (India VIX futures were listed in 2014 but never traded meaningfully; they are not a data source.) | All | Sensibull | partial | NSE allIndices, Yahoo `^INDIAVIX` | yes | S | 3 | P1 (with C1) |

### 3.D OI, positioning and flow

| # | Feature | What it does exactly | Personas | Best today | Have | Data needed | Data | Effort | Value | Phase |
|---|---|---|---|---|---|---|---|---|---|---|
| D1 | Server-side chain recorder | A server job snapshots every tracked chain each minute (indices) and every 5 minutes (opted-in stocks), so all time windows work with the browser closed. Replaces the browser-only `oi-store`. Coverage per broker follows the §5.3 feasibility table. | All | Sensibull, Quantsapp (their back end) | **no** (browser only) | chain | yes | M | 5 | P1 |
| D2 | Multi-strike OI and ΔOI charts | Pick up to 10 strikes or a strike range. Shows CE/PE OI, ΔOI and premium over time at 1-minute resolution, with an interval selector (5m … since open, vs prev close). | S, B, X | Sensibull, TrueData, Fyers | partial (windows from browser only) | recorder | derivable | M | 5 | P1 |
| D3 | PCR, max pain and cumulative OI timelines | PCR (OI and volume, by strike range) and max pain over the day and over days. | S, B | Sensibull, NiftyTrader | partial (now only) | recorder + daily store | derivable | S | 4 | P1 |
| D4 | Multi straddle/strangle charts | Combined premium of up to 6 strike pairs over time, with VWAP and an "ATM rolling" straddle. | S, X | Sensibull, iCharts, Fyers | no | recorder; `/v1/history` 1m for live contracts | derivable | M | 5 | P1 |
| D5 | Build-up classification over time | Long build-up, short build-up, short covering and long unwinding per strike and for futures, per interval, with a timeline. | B, S | Quantsapp | partial (now vs window) | recorder | derivable | S | 4 | P1 (with D2) |
| D6 | Modelled exposure profile (GEX/DEX/vanna/charm by strike) | Exposure per strike from OI in units (§5.2), Black-76 Greeks w.r.t. the forward, and a sign model the user can switch: **"US-style"** (writers short calls, long puts: SpotGamma's US customer assumption, labelled as such), **"all OI short"** (sellers' view: every contract's writer is the hedger), and **"naive"** (calls +, puts −). An optional **participant scale** multiplies the whole profile by a global weight from S4 (net index CE/PE long-short of Client vs FII/Pro). It cannot set a sign per strike, because S4 is aggregated across all strikes and expiries, and India has no designated delta-hedging dealers. Formula and assumption shown. | P, X, S | SpotGamma, Volland, Unusual Whales | no | chain + Greeks | derivable | M | 4 | P1 |
| D7 | Key levels: Call Wall, Put Wall, zero-gamma, HVL | Derived from D6 under the selected sign model. Drawn on the chain, payoff and price chart. Shows each level's history over 10 days. | S, X, B | SpotGamma, MenthorQ | partial (OI walls) | D6 + recorder | derivable | S | 5 | P1 |
| D8 | Expiry-day pressure heatmap (TRACE-style) | Strike × time-of-day heatmap of modelled gamma or charm for the 0DTE expiry, updated every minute, with the spot path drawn over it. NIFTY (Tuesday) and SENSEX (Thursday) weekly only. Monthly-only indices get it once a month and are not part of the claim. | X, P | SpotGamma TRACE | no | recorder + D6 | derivable | M | 4 | P2 |
| D9 | Hedging-pressure line (HIRO-style) | Classifies volume increments by side (snapshot LTP vs prevailing bid/ask), then sums delta × qty cumulatively against spot. Indian broker feeds are ~1/s conflated snapshots (LTP, last qty, cumulative volume, best bid/ask), not trade prints, so one increment can hold trades on both sides. **Research spike only**: ship only if a measured classification benchmark (against exchange tick data or a paid tick vendor) meets a stated accuracy bar; otherwise do not ship. | P, X | SpotGamma HIRO | no | tick stream with bid/ask | derivable (low accuracy, unmeasured) | L | 2 | P3 (gated) |
| D10 | Net premium tide | Net call premium bought minus sold vs net put premium, cumulative intraday. Same classifier and same gate as D9. | B, P | Unusual Whales Market Tide | no | as D9 | derivable (low accuracy) | M | 2 | P3 (gated) |
| D11 | Unusual activity list with spread inference | Lists contract-minutes with volume or ΔOI far above normal and groups simultaneous same-expiry spikes into likely spreads. No aggressor or opening/closing label per trade: OI changes are net and batched by brokers, so that cannot be attributed. Saved filters feed alerts. | B, P | OptionStrat Flow, Unusual Whales | partial (screener "unusual" from the median) | recorder | derivable | M | 3 | P2 |
| D12 | Strike × expiry OI heatmap | OI or ΔOI over the whole strike-by-expiry grid. | P, S | Laevitas | no | chain × expiries | yes | S | 3 | P2 |
| D13 | Futures OI, basis and rollover | Futures OI and its change, basis against fair value (rate from S5), cost of carry, and rollover % and cost during expiry week, with history. | A, P, B | Sensibull, NSE | partial (arb page term) | `/v1/history` FUT with OI; recorder | yes/derivable | S | 3 | P2 |

### 3.E Screening and discovery

| # | Feature | What it does exactly | Personas | Best today | Have | Data needed | Data | Effort | Value | Phase |
|---|---|---|---|---|---|---|---|---|---|---|
| E1 | Option screener (8 tabs) | Unusual, build-up, IV outliers, hedge and arb scans across underlyings. The tabs now named "Sell" and "Buy" are renamed to neutral descriptions ("High IV vs history", "Low IV vs history") in P1-6. | All | Quantsapp, Sensibull | yes (indices only) | chains | yes | — | 4 | done |
| E2 | Screener on stock universe + IVR/IVP filters | E1 over the point-in-time F&O stock universe, with IVR, IVP, IV−HV, event-in-window and ban-list filters. Saved screens. | S, B | Market Chameleon, Opstra | no | A2, C1, J4, J9 | derivable | M | 5 | P1 (stocks) / P2 (IVR filters after 60 days) |
| E3 | 2-D scatter scanner (Compass) | Plots underlyings on user-picked axes (for example IVR vs 5-day return, VRP vs skew), with click-through to the chain. | P, S | SpotGamma Compass | no | E2 metrics | derivable | S | 4 | P2 |
| E4 | Strategy-level scans | Covered calls for each holding, credit spreads at ≥X POP, protective puts by cost per % protection. Each ranked transparently by the user's inputs. | H, S, L | OptionsPlay, Strategy Center | no | holdings, chains | derivable | M | 3 | P3 |

### 3.F Positions and risk

| # | Feature | What it does exactly | Personas | Best today | Have | Data needed | Data | Effort | Value | Phase |
|---|---|---|---|---|---|---|---|---|---|---|
| F1 | Book strip, structure detection, payoff, scenario grid, hedge helper, exit plan | Already on `#/positions`. | S, P, H | Sensibull Positions | yes | positions | yes | — | 5 | done |
| F2 | Cross-broker unified book | Positions from every connected account and broker in one book, each tagged by account and holder. Combined Greeks, margin and P&L per holder and (for M) per family, never pooled across holders for orders or data. | S, P, A, M | nobody in India (Sensibull is per broker) | partial (per account) | `/v1/positions` per account | yes | S | 5 | P1 |
| F3 | Rupee Greeks and beta-weighting | Δ₹, Γ₹ per 1%, Vega₹ per vol point, Θ₹ per vol-time day. The whole book, including stock holdings and futures, beta-weighted to NIFTY (or any index). | P, H, S | ToS, Bloomberg OSA, Hoadley | partial (Δ lots and ₹) | holdings, positions, betas from daily candles | derivable | M | 4 | P2 |
| F4 | Stress test grid | Spot ±x% × IV ±y vol points × date; uniform across the book or per underlying with beta. Margin estimate per scenario. Preset stresses (gap −3%, VIX +5, budget day), with the gap preset seeded from overnight cues (J7). | P, S | IBKR Risk Navigator, Bloomberg OSA | partial (spot × IV per page) | — | derivable | M | 4 | P2 |
| F5 | P&L attribution | Daily and intraday P&L split into Δ, Γ, Θ, Vega and residual per position, using recorded marks. | P, S | Bloomberg | no | recorder + positions history | derivable | M | 3 | P3 |
| F6 | Position-limit and MWPL awareness | Shows the user's FutEq (delta-based) exposure per underlying and the MWPL % and ban status from S5. Entity-level index limits (values **needs verification**) are config and matter to very few users, so they show only when the user sets them. | P (large), A | nobody | no | positions + Greeks; S5 MWPL; limits as config | derivable | S | 2 | P2 |
| F7 | Expiry resolution, physical delivery and STT | Past legs settle as exercised or expired. For stock options from E-4 to E: the escalating delivery-margin schedule (values from S5/broker, **needs verification**), close-to-money handling, and the exercise-STT vs square-off cost on intrinsic (rate from `CHARGE_RATES`, currently 0.15% for both; **needs verification** after Budget 2026). Long-weekend theta warning uses the vol-time clock. | S, H, L | Sensibull Advanced Warnings, Robinhood | partial (book warnings; stale STT copy at `options.js:826`) | positions, holidays, delivery-margin schedule | derivable | S | 4 | P1 (with A2) |
| F8 | Roll assistant | One-click roll ladder (same strike next expiry, up/down N strikes, to a target delta) with the net credit or debit and the new payoff, sent as one hedge-first basket and margin-checked at every step (G3). | S, H | tastytrade, Robinhood | no | chains | yes | M | 4 | P2 |
| F9 | Peak / intraday margin-shortfall check | For any multi-leg action (entry, exit, roll, guard exit, partial fill), simulates the margin after each leg in send order and flags a short-margin penalty risk when available margin falls below the post-leg requirement. Picks an order that keeps margin covered (for exits: buy-backs of shorts before selling hedges). | S, A | nobody seen | no | G2, positions, funds | derivable | M | 5 | P1 (with G3) |
| F10 | Tax and turnover report | Realised P&L by financial year and by segment, F&O turnover (for options, the sum of absolute profit per trade per current ICAI guidance; **needs verification**), tax-audit threshold tracker, charges reconciled against imported contract notes, CSV for the CA. Calculates, never advises. | T, all | nobody in one place | no | `/v1/trades`, contract notes (import), S8 | derivable | M | 4 | P2 |
| F11 | Family / HUF account groups | Group accounts by holder and family, with relationship tags limited to the algo framework's family definition (self, spouse, dependent children, dependent parents; **needs verification**). Per-holder limits and guards; a warning when an account outside the family is added to automation. | M | nobody seen | partial (`holder` in account config) | account config | yes | S | 3 | P1 (with F2) |

### 3.G Execution

| # | Feature | What it does exactly | Personas | Best today | Have | Data needed | Data | Effort | Value | Phase |
|---|---|---|---|---|---|---|---|---|---|---|
| G1 | Ticket with preview, paper default, warnings | Existing. | All | — | yes | — | yes | — | 5 | done |
| G2 | Broker basket margin | `POST /v1/margin/basket` wraps each broker's basket-margin API (Kite, Dhan, Upstox …). Shows required, final (after hedge benefit) and available, labelled "broker figure at HH:MM:SS". Blocked margin can later differ (SPAN file updates during the day, expiry-day ELM, premium and MTM, peak snapshots). Shows our SPAN estimate only when the broker can't answer, labelled "estimate". | S, A, all | Zerodha basket | **no** (`null` for broker accounts) | broker margin APIs | derivable per broker | M | 5 | P1 |
| G3 | Rule-aware pre-trade checks | Before sending any entry, exit, roll or guard exit, explains likely rejections: freeze quantity, price band, far-OTM OI/price-range rule, expiry-day calendar-spread benefit removed, extra ELM on short index options on expiry day, margin after each leg (F9), ban-list stock, static-IP and session state (H5). | S, A, B | nobody | partial (safety checks; static-IP warning) | S5, G2, H5 | derivable | M | 5 | P1 |
| G4 | Hedge-first basket with legging panel and rollback | Sends buys first, then sells (entries) and the reverse for exits. A live legging panel shows per-leg status. Limit at mid ± ticks with bounded chase. On partial failure, offers one-click rollback (exit filled legs, F9-checked) or retry. All-or-none intent is simulated in the bridge, never claimed as exchange-atomic. | S, A, P | nobody fully (Zerodha has hedge-first only) | partial (buys-first plan + unwind) | orders, ticks | yes | M | 5 | P2 |
| G5 | One-screen scalper | Index chart + CE chart + PE chart + compact chain + positions. One-tap buy/sell at a preset quantity, drag SL/target on the chart, exit-all, hotkeys. | X | Sahi Scalper 2.0, Dhan | partial (hotkeys, chain ticket) | streams; chart engine (owner) | yes | L | 4 | P2 |
| G6 | Super order / OCO per leg and per strategy | Entry + target + SL + trail held bridge-side (or native where the broker supports it). Also for whole strategies, by net premium or net P&L. | B, X, S | Dhan Super Order | no | ticks, orders | yes | M | 4 | P2 (inside H1/H3) |
| G7 | Pricer (OVME-style) | Price any option or structure with overrides for vol, rate, dividend, vol-time model and per-leg IV. Solve for premium↔IV, strike for zero cost, ratio for zero delta. Spot × vol × date matrix. | P, A | Bloomberg OVME | partial (maths in options.js) | — | derivable | M | 3 | P3 |
| G8 | Freeze-quantity slicing per broker | Above the freeze quantity, uses the exchange iceberg order or the broker's native auto-slice where the adapter supports it (per-broker capability flag), else bridge-side slices. Bridge slices are paced so every order action stays under the account's order-rate cap (default 5/s, never above the 10/s unregistered-algo threshold). | S, A | Kite (autoslice) | no | broker capabilities | yes | M | 4 | P1 (check) / P2 (send) |
| G9 | Per-account brokerage plans | Brokerage per account from config: flat per order (₹0, ₹10, ₹20), % of turnover with a cap, or per lot; defaults per broker shipped as **needs verification** and editable. Replaces `brokeragePerOrder: 20` in `CHARGE_RATES` for charges, arbitrage edge and paper fills. | A, S, all | nobody | no (₹20 constant) | config | yes | S | 4 | P1 (cross-cutting) |

### 3.H Alerts, guards and automation

| # | Feature | What it does exactly | Personas | Best today | Have | Data needed | Data | Effort | Value | Phase |
|---|---|---|---|---|---|---|---|---|---|---|
| H1 | Unified option alerts engine | Conditions on any of: price/LTP of contract or spot, IV, IVR/IVP, ΔOI over a window, PCR cross, wall shift, Greek threshold, straddle premium, strategy P&L, short strike tested, breakeven breach, time. Combine with AND/OR. Server-evaluated, so it works with the browser closed. Delivered by the existing notify module (Telegram, Discord, Slack, webhook) and in-app. | All | Kite ATO, Quantsapp, ToS (none unified) | **no** (only `scan.alert`) | recorder/stream, positions | yes/derivable | M | 5 | P1 |
| H2 | Strategy guard (max loss / target / trailing lock) | Per strategy and per account per day: exit at net-P&L loss, at target, or with a trailing profit lock; optionally on spot level. Default action is **notify + one-tap prepared exit**. Auto-exit is opt-in, live mode only with all safety gates (§8), and only while H5 says the account can trade. | S, B, X | Dhan P&L Exit (account-level only) | partial (daily loss limit on safety) | positions, ticks | yes | M | 5 | P1 |
| H3 | Alert → action | An alert can prepare (default) or send (opt-in) a saved basket, exit a strategy, or engage the kill switch. Every send counts toward order rate and safety limits and is logged with the alert ID. | S, X, P | Kite ATO | no | H1, G4 | yes | M | 4 | P2 |
| H4 | No-code rule automations | White-box "recipes" built by the user from visible conditions → actions. Runs paper first. The vendor ships no pre-built strategies and no hidden logic (§8.1 algo-provider row). | S | Option Alpha, Tradetron, AlgoTest | no | H1, K2 | derivable | L | 4 | P3 (after legal review) |
| H5 | Trading-readiness check | Per live account: broker session valid and its expiry time; outbound IP vs `live.registeredIp`; order-rate headroom; kill switch state. Runs at pre-open (09:00 IST), on every guard/alert arm and every 5 minutes in market hours. Any failure puts guards and alert actions into **"cannot trade"** with the reason and notifies. Builds on the existing per-order static-IP warning (`safety/safetyGuard.mjs`). | S, X, all | nobody | partial (per-order IP warning) | session state, egress IP | yes | S | 5 | P1 |

### 3.I Paper, replay, backtest, journal

| # | Feature | What it does exactly | Personas | Best today | Have | Data needed | Data | Effort | Value | Phase |
|---|---|---|---|---|---|---|---|---|---|---|
| I1 | Paper mode with real margin | Paper uses the same ticket, the same G2 broker margin (when an account is connected), user-set capital, realistic fills (opposite side + slippage), and the account's brokerage plan. | L, all | ToS paperMoney | partial (paper engine with approximate margin) | G2 | derivable | S | 4 | P2 |
| I2 | Replay simulator | Pick a past date and time. The whole desk (chain, OI, vol, builder, positions) loads from recorded snapshots. Play, pause, step 1m/5m/15m, at 1×–60× speed. Trade on paper during replay and carry positions forward. | L, S, B | AlgoTest Simulator, Opstra, ToS OnDemand | no | recorder history (from Phase 1 start); bhavcopy for EOD | derivable | L | 5 | P2 |
| I3 | Forward test | A saved strategy or recipe runs on live data in paper and is tracked in the same ledger as live trades. | S | AlgoTest | no | H4, I1 | derivable | M | 4 | P3 |
| I4 | Backtester | Leg rules (strike by ATM offset, delta or premium; entry/exit times; per-leg and overall SL/target; re-entry; trailing). Output: equity curve, drawdown, win %, expectancy, DTE and weekday splits, slippage model, trade log export. EOD from bhavcopy history (both formats, corporate-action adjusted, point-in-time universe); intraday from our own recorded snapshots as they accumulate. | S, P | AlgoTest, StockMock, ORATS | no | historical chains, J8, J9 | partial: EOD via bhavcopy; intraday only from what we record | L | 5 | P3 |
| I5 | Strategy journal with roll chains | Every multi-leg trade is one journal entry. Adjustments and rolls chain to it with cumulative P&L and credit. Notes and tags at entry. Analytics by strategy, DTE, IVR at entry, weekday and tag. | S, P, all | tastytrade Order Chains, OptionNet, TradeZella | no | `/v1/trades`, `/v1/orders` | yes | M | 4 | P2 |

### 3.J Market context and reference data

| # | Feature | What it does exactly | Personas | Best today | Have | Data needed | Data | Effort | Value | Phase |
|---|---|---|---|---|---|---|---|---|---|---|
| J1 | Participant-wise OI (FII/DII/Pro/Client) | Daily long and short by participant for index futures, index CE/PE and stock futures/options (NSE only; no BSE equivalent located, **needs verification**). FII index-futures long % (formula stated), net calls and puts, day-on-day change, and history charts. | B, S, P | Sensibull FII/DII, Quantsapp | **no** | NSE `fao_participant_oi` daily CSV | derivable (new fetcher) | M | 5 | P1 |
| J2 | FII/DII cash flows | Daily cash-market buy and sell values. | B, H | Sensibull | no | NSE FII/DII report | derivable (new fetcher) | S | 3 | P2 |
| J3 | Contract calendar and reference data | Expiries (from exchange data, never hard-coded), sessions, lot sizes with effective dates, freeze quantities, holidays, F&O ban list, MWPL %, risk-free rate. Drives every other page. | All | NSE | partial (`/v1/expiries`) | NSE/BSE archives, instrument master, RBI/FBIL | derivable | M | 5 | P1 |
| J4 | Events calendar tied to positions | RBI MPC, Budget, results dates for F&O stocks, US CPI/FOMC, GDP/inflation, holidays. Each position shows the events inside its DTE. ICS export. | All | Sensibull Events | no | results calendar (NSE corporate announcements), macro list (curated config) | partial (NSE results derivable; macro curated) | M | 4 | P2 |
| J5 | Daily levels note (local only) | Pre-open and post-close note per index: walls, zero-gamma, σ range, IVR, participant changes and the events this week, generated on the user's own Bridge from their own numbers for their own use. The vendor never publishes, emails or shares it. An optional LLM rewrite always shows the source numbers. | All | SpotGamma Founder's Notes | no | D6, C1, J1, J4 | derivable | S | 3 | P2 |
| J6 | Index heavyweights and breadth | For NIFTY, BANKNIFTY and SENSEX: each constituent's points contribution (weight × % change, scaled to index points), top movers, and advance/decline, live. Weights from the index factsheet in S5 (monthly; **needs verification** of source and licence). | B, X | iCharts, Sensibull, broker terminals | no | constituent quotes, index weights | derivable | S | 4 | P2 |
| J7 | Overnight cues and gap risk | GIFT Nifty (NSE IX), major US and Asia index moves and USD/INR at pre-open, with an "expected open" derived from GIFT Nifty and a seller's weekend gap stress for F4. | S, B | broker apps | no | GIFT Nifty quote (broker or NSE IX; **needs verification** of an allowed source), global indices | no (new source) | S | 3 | P2 |
| J8 | Corporate actions | Splits, bonuses, rights and extraordinary dividends for F&O stocks with ex-dates, the exchange's strike and lot adjustment factors, and non-standard contracts flagged. Applied to S6 backfill, S2 history and I4 so adjustments do not show as IV or price jumps. | P, S, H | NSE | no | NSE corporate actions and F&O adjustment circulars | derivable (new fetcher) | M | 4 | P1 (with J3) |
| J9 | Point-in-time F&O universe | Membership of each stock in F&O by date (entries, exits after SEBI's Dec 2024 eligibility rules and periodic reviews). Used by the picker, E2, IVR history and backtests to avoid survivorship bias. | P, S | nobody seen | no | NSE F&O inclusion/exclusion circulars, bhavcopy | derivable | S | 3 | P1 (with J3) |

### 3.K Intelligence, education, sharing, API

| # | Feature | What it does exactly | Personas | Best today | Have | Data needed | Data | Effort | Value | Phase |
|---|---|---|---|---|---|---|---|---|---|---|
| K1 | Explain this (AI, grounded) | "Explain this chain/position/what if NIFTY −2% and IV +3" through the existing MCP/AI path. The answer lists every number it used, with links to the panels. Read-only. It may prepare a ticket only through the normal ticket flow, which a human confirms. Chain, news and other text is treated as untrusted (§7.9). | L, B, all | Fyers FIA (screeners only) | partial (MCP read tools exist) | all of the above | yes | M | 4 | P2 |
| K2 | Natural-language screener | "NIFTY 50 stocks with IVR above 60 and results in the next 10 days" is turned into an E2 filter that the user can see and edit. | B, S | Fyers FIA | no | E2 | derivable | S | 3 | P3 |
| K3 | Glossary hovers and Beginner/Pro toggle | Every metric has a one-line meaning plus the formula. Beginner mode hides pro columns and shows explanations; Pro mode is dense. | L | tastylive, Sensibull | partial (tooltips) | — | — | S | 4 | P1 (cross-cutting) |
| K4 | Outlook → strategy wizard | Asks for direction, conviction, time and risk appetite. Shows 3 candidate structures from the optimizer, with plain-English trade-offs, ranked by the user's inputs. | L, B | Sensibull Easy Options, Samco B.R.O. | no | B7 | derivable | S | 3 | P2 |
| K5 | Open data and export | Every panel exports to CSV. Every derived series has a REST endpoint (and Excel/Sheets/MCP via the existing compat layers). | P, A, Q | nobody (SpotGamma has no public API seen) | partial | — | yes | S | 4 | P1 (cross-cutting) |
| K6 | Model calibration report | Logs every shown probability and band (PoP, σ bands, expected absolute move, levels) with its inputs, then scores it against realised outcomes from the recorder: reliability diagram, Brier score, hit rate of σ bands, and level-touch rates vs a random-strike baseline. Shown on each probability's method note once there are ≥ 60 expiries (indices). | P, S, B, L | nobody seen | no | recorder, S2 | derivable | M | 4 | P1 (logging) / P2 (report) |
| K7 | Developer API contract | `/v1/options/*` endpoints with semantic versioning, schema stability rules, per-key quotas, pagination and latency targets (§7.8). Python and TypeScript examples in `docs/guides`. | Q | nobody in India | partial (OpenAPI, key scopes) | — | yes | S | 4 | P1 (cross-cutting) |

### 3.M Commodity and currency options (Phase 3)

| # | Feature | What it does exactly | Personas | Best today | Have | Data needed | Data | Effort | Value | Phase |
|---|---|---|---|---|---|---|---|---|---|---|
| M1 | MCX options on futures | Crude oil, natural gas and other MCX options: chain, builder, OI and IV. Priced with Black-76 on the **listed MCX future** the option exercises into (not a parity forward). Sessions from S5 (to 23:30/23:55 IST, varying with US daylight saving). Expiry rules per contract from MCX data. Lot units in barrels, mmBtu and so on, shown with units. Devolvement into futures at expiry explained. | C | Sensibull (MCX), broker apps | no | MCX instruments, chain, sessions | derivable where the broker covers MCX | L | 3 | P3 |
| M2 | Currency options | USD/INR and other NSE/BSE currency options with their sessions, lot units and RBI reference-rate settlement. | C | broker apps | no | currency instruments | derivable | M | 2 | P3 |

### 3.N Count by status

Generated from the tables above by counting the **Have** column (`yes`, `partial`/`partial …`, `no`/`**no**`). Re-run the count whenever a row changes.

| Have | Count |
|---|---|
| yes (done) | 6 |
| partial | 36 |
| no | 65 |
| **total** | **107** |

---

## 4. Signature differentiators (things nobody in India does well)

These ten are the core of the pitch. Each has its own catalogue rows; this section explains why it wins.

1. **Margin you can trust before you click (G2, G3, F9).** The broker's own basket-margin figure at the time of the call, plus a rule-aware explanation of why an order would be rejected or penalised: freeze quantity, price band, far-OTM rule, expiry-day ELM, no calendar benefit on expiry day, and margin after each leg on entries, exits, rolls and guard exits. Sensibull's top complaints are "margin estimate ₹12.8L vs ₹16.9L blocked" and "enough funds but sells rejected". We address both and show the working. We do not promise what will be blocked later.
2. **A time machine for the whole desk (D1 → I2).** Every chain is recorded server-side, so every chart has history and every past minute can be replayed. Replay, paper and forward test share one ledger. Sensibull has charts and no replay. AlgoTest has replay and no live desk. We join them.
3. **Transparent modelled positioning for NIFTY and SENSEX (D6, D7, D8).** GEX, vanna and charm profiles with Call Wall, Put Wall and zero-gamma, and an expiry-day pressure heatmap for the two weekly 0DTE indices. The formula is shown and the sign assumption is a switch, because Indian index options have no designated hedging dealers and retail is net long both calls and puts. Participant OI can scale the whole profile but cannot set strike-level signs, and we say so. This is the Volland/SpotGamma idea, done openly and honestly for India.
4. **One alert engine over everything (H1, H2, H5).** IV, IVR, Greeks, ΔOI, PCR, walls, strategy P&L, spot level. The engine runs on the server and reaches Telegram, Discord or Slack. It can prepare an exit or basket for one-tap confirmation, and it tells you before the open if it cannot trade (session expired, IP changed).
5. **Strategy guard, broker-agnostic (H2).** Max-loss, target and trailing locks per strategy and per day, with spot-based stop-loss for option strategies. These are among the most requested features in Indian forums, and they work on every broker, including ones with no native P&L exit.
6. **One book across brokers and family accounts (F2, F11).** Many serious Indian traders split capital across Zerodha, Dhan and Upstox, or run family accounts. We show one book per holder and per family, with combined Greeks and margin, without ever pooling orders or data across holders.
7. **India's contract reality built in (J3, J8, J9, F7, A15, A16).** The calendar, sessions, lots, corporate actions and F&O membership come from data. Time is measured on a trading-time clock. Stock-option delivery margin and exercise STT are explained. On expiry day the payoff is shown at the running settlement average, not just the last print.
8. **Calibrated numbers (K6).** Every probability we show is scored against what actually happened on the recorder's data, and the reliability diagram is one click away. No Indian tool does this.
9. **Lag-free by architecture (A3).** A streaming chain over the existing WebSocket hub, patched cell by cell. Lag is the top complaint across Sensibull, Dhan and Tradetron.
10. **Open and private (K5, K7).** Self-hosted, with every number available by versioned REST, CSV, Excel/Sheets and MCP. There is no third-party server holding the user's positions. We have not seen an Indian or US retail options tool that offers this.

---

## 5. Data strategy

### 5.1 Principles

- Record what we cannot buy. Historical intraday option chains are the moat and nobody sells them cheaply. Every day we don't record is lost for good.
- Compute on the server; render on the client. Derived series (IV, GEX, PCR, build-up) are computed once per snapshot and stored, so any page and any API client reads the same numbers.
- Respect personal-use data terms: stores are local to the user's Bridge, never pooled or redistributed (§8.3).
- Every series carries `source`, `method`, `asOf` and, where relevant, `quality` (`live`, `backfill-eod`, `inferred`).
- **One unit for OI:** `oi` in every store and every `/v1` response is in **units** (shares or index units), not contracts, because units stay comparable across lot revisions. `server/bridge/market/normalise.mjs` converts each broker's OI using a per-broker, per-endpoint unit flag. A contract test per broker fixture asserts the unit. Exposure formulas use units directly, with no extra × lot.

### 5.2 Stores

All stores live under the Bridge `dataDir`. They use the scheduler (`deps.scheduler`) and follow the scanner's `everyMinutes` pattern (`scanner/scanService.mjs`). Engine: SQLite (one file per store) or append-only JSONL with daily gzip, decided in the D1 PRD. Retention is configurable.

| Store | What is recorded | Cadence | Key | Rough size | Unlocks |
|---|---|---|---|---|---|
| **S1 Chain snapshots** (intraday) | Per leg: strike, type, ltp, bid, ask, bidQty, askQty, oi (units), volume, iv (Black-76 mid), delta, gamma, ts. Per chain: spot, forward, ATM, straddle, rate, vol-time T. | Indices: every 1 min, nearest 3 expiries, ±40 strikes. Opted-in stocks: every 5 min, nearest expiry, ±15 strikes. During the session from S5 (09:15–15:30 IST for equity derivatives). | (underlying, expiry, ts) | Indices about 1M leg-rows a day; all stocks about 0.8M. About 15–25 MB a day compressed. 1 year ≈ 5 GB. | D2–D5, D8, D11, C6, I2, I4 intraday, F5, K6 |
| **S2 Daily vol store** | Per underlying and expiry at 15:25 IST: ATM IV, 25Δ and 10Δ IV both sides, RR25 (call − put), BF25, straddle, forward, 9-point smile by delta, HV10/20/60 (CC, Parkinson, YZ), VIX close. 30-day constant-maturity values. Each row has `quality`. | Daily 15:25 IST and re-check at 15:35 | (underlying, date, expiry) | Small (KB a day) | C1, C2, C4, C5, C8, C9, E2 |
| **S3 Daily derived** | PCR (OI, volume), max pain, walls, zero-gamma (per sign model), GEX total, futures OI/basis/rollover, top ΔOI strikes. | Daily close | (underlying, date) | Small | D3, D7 history, J5 |
| **S4 Participant OI and FII/DII** | NSE `fao_participant_oi` (aggregated across all strikes and expiries) and the FII/DII cash file, parsed into rows. NSE only. | Daily about 19:00 IST, retry to 22:00 | (date, participant, instrument) | Small | J1, J2, D6 participant scale |
| **S5 Reference data** | Expiries; sessions per segment; lot sizes and freeze quantity with effective dates; holidays; ban list; MWPL %; F&O membership by date (J9); corporate actions and adjustment factors (J8); stock-option delivery-margin schedule; risk-free rate (91-day T-bill or MIBOR/repo, source chosen in the J3 PRD, **needs verification** of an allowed free source; dated, with a config override); index weights for J6; results dates. | Daily pre-open and on change | (symbol or series, effectiveFrom) | Small | J3, J4, J6, J8, J9, G3, F7, A15, all pricing |
| **S6 EOD bhavcopy** | NSE F&O bhavcopy in both formats: legacy (before July 2024) and UDiFF (from July 2024), each with its own parser and a fixture test. BSE derivatives bhavcopy (SENSEX, BANKEX, stock derivatives) from BSE's separate archive. OHLC, close, settle, OI (units), ΔOI, contracts traded. | Daily, plus a one-time backfill (years) | (exchange, date, contract) | About 2 MB a day compressed | IVR backfill, I4 EOD backtest, J8, J9 |
| **S7 Alerts and guards** | Rule definitions, state (including H5 "cannot trade"), last-fired, audit of actions taken. | On change / on fire | rule ID | Small | H1–H5 |
| **S8 Journal** | Strategy groups, leg links, roll chains, notes and tags, entry context (IVR, DTE, spot), realised P&L by FY. | On fill / on edit | strategy ID | Small | I5, F5, F10 |
| **S9 Prediction log** | Every shown probability and band with inputs and model version, later joined to outcomes. | On compute (sampled per minute) | (metric, underlying, ts) | Small | K6 |

### 5.3 How the recorder gets data (rate budget and broker feasibility)

- **Preferred:** a stream-fed in-memory book. The recorder subscribes the tracked instruments on the broker WebSocket through `streamHub`, keeps last bid/ask/ltp/oi/volume in memory, and writes a snapshot each minute. This costs no REST calls.
- **Fallback:** REST `/v1/optionchain`, inside the broker policy table in `server/bridge/ratelimit` and capped at 50% of it, yielding to user-facing calls.
- **NSE website backup: off by default.** NSE's terms of use prohibit automated access and the site blocks it, so this is a compliance risk as well as a reliability one. It is available only as an explicit user opt-in with a warning, and nothing depends on it.
- **Account choice:** the recorder uses one data account chosen in config. It never pools across holders (compliance §8.3).

**Instrument load.** Indices: 6 underlyings × 3 expiries × 81 strikes × 2 ≈ 2,900 legs (plus spot and futures). All F&O stocks: 180 × 31 × 2 ≈ 11,200 legs. Total ≈ 14,000. REST need: 18 index chains/min plus 180 stock chains per 5 min (36/min) = 54 chain calls/min.

**Feasibility by broker** (limits from `brokerPolicies.mjs`; stream caps and chain endpoints **need verification** per broker before any number becomes an acceptance criterion):

| Broker | Chain endpoint (policy) | 50% background budget | REST: indices (18/min) | REST: all stocks (+36/min) | Stream capacity | Result |
|---|---|---|---|---|---|---|
| Dhan | yes, 1/s and 20/min (unverified) | 10 chains/min | **no** | no | 5 connections × 5,000 (per policy notes) | Stream-only for the recorder. REST fallback covers user calls only. |
| Zerodha | **none**; quotes shared 1/s, up to 500 instruments per call (**needs verification**) | ~30 quote calls/min ≈ 15,000 instruments/min | yes (via quotes, ≈ 6 calls/min) | marginal | ~3,000 per connection, few connections (**needs verification**) | Indices by stream or quotes; stocks only a small opted-in set. |
| Upstox | shared "standard" 50/s, 500/min | 250/min | yes | yes | **needs verification** | Indices and all stocks by REST. |
| Others | per policy table | — | per PRD | per PRD | per PRD | Filled in the P1-1 PRD from the policy table. |

Consequences: indices are recorded by default; stocks are opt-in and capped at what the chosen data account can carry (shown in the recorder status panel). The "full stock sweep in ≤ 10 minutes" in P1-6 applies only where this table says "yes".

### 5.4 Back-filling (so IVR is useful before 252 days)

1. VIX history from Yahoo `^INDIAVIX` and the NSE archive gives an immediate VIX percentile.
2. Bhavcopy history (S6) gives a **proxy** daily ATM IV. Bhavcopy option close is the last traded price, often hours stale for OTM or illiquid strikes, with no bid or ask, while the futures close is an end-of-day average. So the backfill uses only near-ATM strikes with volume above a threshold (set in the PRD), the near-month future for the forward, and the S5 rate, with corporate actions applied (J8). It is stored with `quality: backfill-eod`, drawn in a lighter style and labelled "EOD proxy, lower quality" until S2 has enough live days. Index backfill is usable. Stock backfill is much noisier and shown with a warning; stock IVR stays "partial" until live history covers the lookback.
3. `/v1/history` 1-minute candles with OI for live contracts back-fill today's intraday S1 when the recorder starts mid-session (where the broker supports it).

### 5.5 Compute services (server)

| Service | Inputs | Outputs | Notes |
|---|---|---|---|
| Vol engine | S1, S2, S5 | IV by Black-76 on the per-expiry parity forward from mids; smile fit; constant-maturity interpolation | Forward = median over the 5 strikes nearest ATM with two-sided quotes of K + e^{rT}(C_mid − P_mid), r from S5, T from the vol-time clock (A15). One model across server and client (closes PRD 05 V4). |
| Exposure engine | S1, S4 | GEX/DEX/vanna/charm per strike, levels, pressure grid | Greeks w.r.t. the forward; OI in units; sign model and participant scale are parameters. Every output carries `assumption`. |
| Alert evaluator | stream/S1, positions, S2, H5 state | `option.alert`, `strategy.guard`, `trading.readiness` bus events | New TOPICS entries are a core change. Delivery reuses `notify/notifier.mjs`. |
| Margin service | broker APIs | Basket margin with hedge benefit; per-leg sequence margin (F9) | Cached per basket hash for 5 s. Each response carries the broker call time. |
| Reference sync | NSE/BSE archives, instrument master, rate source | S5 | Raises a visible warning if a lot-size change or corporate action is effective within 7 days. |
| Readiness monitor | accounts, sessions, egress IP, rate limiter | H5 state | Egress IP from a configurable lookup (off by default for privacy; the user picks the service or enters the IP). |
| Calibration job | S9, S1, S2 | K6 scores | Nightly. |

### 5.6 New API surface (indicative; the OpenAPI spec is authoritative once built)

`GET /v1/options/snapshots`, `GET /v1/vol/history`, `GET /v1/vol/surface`, `GET /v1/options/exposure`, `GET /v1/options/levels`, `GET /v1/options/settlement-estimate`, `GET /v1/participants/oi`, `GET /v1/reference/{expiries|sessions|lots|holidays|ban|corporate-actions|fno-universe|rate}`, `POST /v1/margin/basket`, `GET|POST|DELETE /v1/alerts`, `GET|POST /v1/guards`, `GET /v1/readiness`, `GET /v1/journal`, `GET /v1/calibration`. All are `read` scope except alerts, guards and journal writes, which need `paper` scope for paper rules and `live` scope for any rule that can send a live order. Nothing here can enable live trading. The contract rules for these endpoints are in §7.8.

### 5.7 Data and API cost

The recorder needs a continuously connected data account, and some brokers charge separately for API or market-data access. The per-broker matrix below is filled and verified in the P1-1 PRD; it drives every "Data: yes" cell in §3 for that broker.

| Broker | API/data fee | Option chain | Stream (cap) | OI history in candles | Basket margin API | Notes |
|---|---|---|---|---|---|---|
| Zerodha (Kite Connect) | paid subscription (**needs verification** of current price and whether historical data is extra) | no (quotes) | yes (**verify cap**) | **verify** | yes | — |
| Dhan | **verify** (data APIs may need a plan) | yes | yes (5 × 5,000) | **verify** | **verify** | — |
| Upstox | **verify** | yes | yes (**verify cap**) | **verify** | yes | — |
| Others | **verify** | per adapter | per adapter | per adapter | per adapter | from `docs/BROKERS.md` |

The status panel shows which account feeds the recorder and that account's known costs. Docs state plainly that recording stocks may need a paid data plan.

---

## 6. Roadmap

### 6.0 How we chose Phase 1

The score is value × reach ÷ effort, plus a dependency bonus (recording, reference data and the pricing core feed everything else). Recording must start as early as possible, because history can't be bought later. Readiness and security come before any feature that can send an order without a click. The order inside Phase 1 is the build order:
- **1a, foundations:** P1-1 to P1-5.
- **1b, the visible wins they enable:** P1-6 to P1-13.

Phase 1 is now 13 builds, about one quarter for 3 engineers. If capacity is 2, P1-13 moves to the start of Phase 2.

### 6.1 Phase 1: the next 13 builds

**P1-1 Server chain recorder (D1 + S1, S3).**
Acceptance criteria:
- With the browser closed, snapshots are written for every configured index chain each minute (nearest 3 expiries, ±40 strikes) and for opted-in stocks every 5 minutes, during the S5 session on trading days only.
- Before this item is accepted, the §5.3 feasibility table is filled for every wired broker from the policy table and verified docs. The recorder refuses a configuration its data account cannot carry and says what it can carry.
- Each snapshot carries `ts`, `source` (`stream`, `rest` or `nse-backup`) and the account used. Gaps are recorded as gaps, never filled by interpolation. The NSE backup is off unless the user opts in.
- `oi` is in units for every wired broker, enforced by a contract test per broker fixture.
- Recorder REST usage never exceeds 50% of the broker's policy budget. A user-initiated chain request is never delayed by more than 200 ms by recorder traffic (measured in a test with a fake broker).
- `GET /v1/options/snapshots?underlying=&expiry=&from=&to=&fields=` returns the series. The OI page's 5m/15m/30m/1h/since-open windows read from it, and `oi-store` becomes a cache.
- Restarting the Bridge mid-session resumes recording within 1 minute. Disk usage, row counts, the feeding account and its coverage appear on a status panel. Retention is configurable (default 365 days).

**P1-2 Reference data, contract calendar, corporate actions and F&O universe (J3, J8, J9, S5).**
Acceptance criteria:
- Expiries, sessions, lot sizes (with effective dates), freeze quantities, holidays, the ban list, MWPL %, F&O membership by date, corporate actions with adjustment factors, the stock-option delivery-margin schedule and the risk-free rate are loaded daily from exchange or official sources, each with `source` and `asOf`.
- No page or server module has hard-coded lot sizes, expiry weekdays, session times, the risk-free rate or brokerage; a static test greps for `RISK_FREE`, `RATE = 0.065`, `brokeragePerOrder`, `09:15`/`15:30` literals outside S5 defaults, and lot constants.
- A lot-size change or corporate action effective within 7 days shows a banner on affected pages and on positions in those underlyings.
- If the data is stale (over 1 trading day), pages show a warning and the order ticket blocks for quantity in lots until the user confirms the lot size.
- A fixture split or bonus produces adjusted strikes and lots that match the exchange circular.

**P1-3 Pricing core, daily vol store, IV Rank/Percentile and IV chart (A15, C1, C2, C11, S2, S6 backfill).**
Acceptance criteria:
- One vol-time clock (calendar, trading-days/252, weighted; intraday minutes to the settlement window) is used by IV, Greeks, theta, expected move and the payoff on server and client. Default and weights appear in every method note. Reference-value tests cover a Friday→Monday pair, a long weekend and expiry day at 14:00, 15:00 and 15:20 (no blow-up, no floor artefact).
- The parity forward is the near-ATM median of K + e^{rT}(C_mid − P_mid) with r from S5. IV on server and dashboard comes from one function; a test asserts they agree within 0.05 vol points on the demo chain.
- At 15:25 IST the store writes the S2 row for every tracked underlying and expiry. A missed run is retried at 15:35 and flagged.
- A one-time backfill from both bhavcopy formats (NSE) and BSE derivatives bhavcopy computes the §5.4 proxy ATM IV, stored as `backfill-eod` and drawn as lower-quality. The VIX history is loaded.
- IVR and IVP (lookback 30/90/252 days; definitions shown) replace "Unavailable" on the vol page, chain summary strip, screener and ticket. When fewer than the lookback days exist, the tile says "n of N days" and is labelled "partial".
- The IV chart shows ATM IV, VIX and HV20, with expiry roll marked, using the owner's chart engine (§10.1). `GET /v1/vol/history` ships regardless.
- K6 logging (S9) starts for every probability shown.

**P1-4 Streaming chain and positions (A3, A11, A14).**
Acceptance criteria:
- Chain and positions pages subscribe through `/v1/stream` and patch cells on tick. REST polling becomes the fallback, used only after 5 s without stream data, and the switch is visible in the freshness pill.
- Tick-to-paint p95 ≤ 250 ms with 160 legs streaming on a mid-range laptop. 60 fps scroll is held (no long task above 50 ms).
- `ChainLeg` gains `bidQty`, `askQty` and `ts` (OpenAPI updated). Rows older than 10 s in market hours are dimmed with an age tooltip. Illiquid strikes are dimmed with the reason.
- Leaving the page unsubscribes within 1 s (verified on `/v1/stream/stats`).

**P1-5 Trading readiness and security baseline (H5, §7.9).**
Acceptance criteria:
- `GET /v1/readiness` and a header badge show, per live account: session valid and expiry time, egress IP vs `live.registeredIp`, order-rate headroom and kill-switch state.
- At 09:00 IST on trading days, any failing account notifies through the notify targets ("Dhan session expired: guards on this account cannot trade").
- In a fake-broker test, expiring the session or changing the egress IP moves every armed guard and alert action on that account to "cannot trade" within 5 minutes, and no order is attempted.
- `docs/guides` gains a deployment page: static-IP VPS or static home IP, tunnels and why a dynamic IP cannot place live orders.
- The §7.9 checks pass: CSRF test on every dashboard write route, scope test on every new write endpoint, and the MCP write tools refuse without the right scope.

**P1-6 Stock options everywhere (A2, E2 stock part, F7, E1 renames).**
Acceptance criteria:
- The underlying picker lists the current F&O universe from S5 with search. The chain, OI, vol, builder, positions and screener work for stocks, with the right lot sizes and tick sizes.
- Where §5.3 says "yes" for the data account, a full stock sweep finishes in ≤ 10 minutes with progress shown. Elsewhere, the screener covers the opted-in set and states the limit.
- Ban-list stocks show a "ban: no fresh positions" badge, and the ticket refuses opening orders in them (closing is allowed).
- From E-4 to E, ITM and close-to-money stock options show the delivery-margin schedule and the exercise-STT vs square-off cost, both computed from S5 and `CHARGE_RATES` (a test fails if any rupee warning uses a literal rate; this removes the stale 0.125%/0.1% copy at `options.js:826`).
- Screener tabs use neutral names.

**P1-7 Live OI and straddle charts pack (D2, D3, D4, D5, A9).**
Acceptance criteria:
- Multi-strike OI / ΔOI / premium for up to 10 strikes or a strike range at 1-minute resolution, with an interval selector (1m, 5m, 15m, 30m, 1h, since open, vs prev close).
- Multi straddle/strangle for up to 6 pairs, including a rolling-ATM straddle, with VWAP.
- PCR (OI and volume) and max pain intraday timelines, and their daily history from S3.
- Build-up class per strike per interval, with a timeline strip.
- A straddle-chain view on the chain page.
- Time-series panels use the owner's chart engine through `chartSlot`. Until it lands they render a compact purpose-built SVG sparkline per series plus a data table, and export to CSV. A chart for a full day loads in ≤ 800 ms from S1.

**P1-8 Modelled exposure and key levels (D6, D7).**
Acceptance criteria:
- GEX, DEX, vanna and charm per strike for NIFTY and SENSEX (0DTE weekly and all expiries) and for BANKNIFTY, FINNIFTY, MIDCPNIFTY and BANKEX (nearest monthly and all expiries). Purpose-built SVG mirrored bars.
- GEX per strike = Σ OI_units × Γ_F × F² × 0.01 × sign, in ₹ crore per 1% move of the forward, with Γ from Black-76 on the forward. The method note shows this.
- The sign model is a visible switch (US-style; all OI short; naive) plus an optional participant scale. The method note states that S4 is aggregated across strikes and expiries and only scales the profile, and that the participant scale is unavailable for SENSEX and BANKEX (no BSE participant file).
- Zero-gamma = the forward level at which total modelled GEX changes sign when every Γ is recomputed at that level with IV held sticky-strike and T fixed. Found by root search on a grid of ±5% with 0.05% steps, then refined. Call Wall, Put Wall and HVL definitions are in the method note.
- Levels are drawn on the chain (row markers), the payoff chart (vertical rules) and the summary strip, with 10-day history from S3.
- A unit test reproduces per-strike GEX to within 0.5% and zero-gamma to within 0.1% of the forward from a hand-computed fixture.
- Copy is descriptive only ("largest modelled call gamma at 25,500"), never advice.

**P1-9 Multi-expiry builder, P&L heatmap, price slices, σ bands and settlement estimate (B2, B3, B4, A7, A16).**
Acceptance criteria:
- Legs can be in any listed expiry plus futures. Calendars, diagonals and double calendars build from presets. At the first expiry, the payoff values remaining legs with Black-76 at their IV (sticky-strike default, shown).
- The P&L heatmap table has price rows (default ±2σ in 25 rows) × date columns (today to last expiry; hourly on expiry day, on the vol-time clock). Cells show ₹ or % of max risk on a colour scale that is safe for colour-blind users, with the sign always shown. Clicking a cell sets the target date and spot.
- The price-slice grid has editable rows (%, ₹, σ, breakevens, walls) with P&L, Δ, Γ, Θ and Vega at each.
- σ bands from ATM IV·√T on the forward and the straddle-based "expected absolute move" are drawn and labelled separately on the payoff and chain.
- On NIFTY and SENSEX expiry days from 15:00, the running settlement estimate is shown and the expiry payoff is evaluated at it. A fixture of recorded index ticks reproduces the exchange's published settlement price within the tolerance set in the PRD.
- Recompute for 10 legs × 25×20 grid ≤ 30 ms (measured in the test).

**P1-10 Broker basket margin, rule-aware checks and slicing (G2, G3, F9, G8 check, G9).**
Acceptance criteria:
- `POST /v1/margin/basket` returns required, final (with hedge benefit), available and the broker call time for Dhan, Zerodha and Upstox where the broker API supports it. Otherwise it returns `null` with `reason`, and the UI shows our estimate labelled "estimate" with its known error band.
- The ticket and builder show broker margin within 1 s of the last leg change (debounced, cached 5 s). The copy says "broker figure at HH:MM:SS".
- The pre-trade check runs on entries, exits, rolls and guard exits, and lists every applicable rule: freeze slicing (native iceberg or broker autoslice if the adapter supports it, else paced bridge slices under the order-rate cap), price band, far-OTM range risk, ban list, expiry-day calendar-spread benefit removed and the extra ELM on short index options, margin after each leg in send order (F9, with a "short-margin penalty risk" flag and a safer order), lot multiple, and H5 readiness. Each line gives a plain-English explanation and the source rule date.
- On a fixture set of 20 historical rejection or penalty cases, the check flags at least 18 before sending.
- Charges everywhere use the account's brokerage plan (G9). A test covers ₹0, ₹20 flat and % with cap.

**P1-11 Option alerts engine (H1).**
Acceptance criteria:
- Users can create alerts from any chain cell, level, position or strategy ("alert me when…"), and in an Alerts manager. Supported conditions: contract or spot price, IV, IVR/IVP, ΔOI over a window, PCR cross, wall shift, Greek threshold, straddle premium, strategy P&L, short strike within X% or σ, breakeven breach, and time. AND/OR across up to 5 conditions.
- Evaluation happens on the server from the stream or S1 with the browser closed. Latency from condition true to notification is p95 ≤ 5 s on streamed instruments and ≤ 70 s on recorder-only ones.
- Delivered as an `option.alert` bus event to the existing notify targets (Telegram, Discord, Slack, webhook) and in-app. Each target can filter. Notification text carries no account identifiers or tokens.
- Repeat control: once, once per day, or every N minutes. Hysteresis stops flapping.
- A cap of 500 active alerts per installation (configurable). Every fire is written to S7.

**P1-12 Strategy guard (H2, initial).**
Acceptance criteria:
- Per strategy (a group of legs) and per account per day: max loss in ₹, target in ₹, trailing lock (lock X% of peak after Y ₹), and a spot-level stop for option strategies.
- Default action: notify with a prepared exit basket (shorts bought back first, then hedges sold, checked by F9) that one tap confirms.
- Auto-exit is opt-in per guard. It is allowed in paper. In live it needs every gate in `docs/guides/safety.md` plus a per-guard `live` confirmation typed by the user, and it counts toward order-rate and daily-order limits.
- The guard has three non-firing states, each notified: **blind** (no prices for over 30 s), **cannot trade** (H5: session expired, IP mismatch, order-rate cap reached, kill switch), and **disarmed** by the user. It never fires blind and never attempts an order while it cannot trade.
- A guard fire with auto-exit is logged in the audit log with the guard ID and conditions.

**P1-13 Participant OI + unified cross-broker and family book (J1, S4, F2, F11).**
Acceptance criteria:
- The NSE participant OI file is fetched daily (about 19:00 IST with retries) with a 2-year backfill where archives allow. The page shows Client/DII/FII/Pro long and short for index futures, index CE and PE, and stock futures/options, FII index-futures long % (formula shown) and net change, and states that the data is NSE-only and aggregated across strikes and expiries.
- Positions page "All accounts" view: one book per holder, plus a family view for accounts the user tags as family, with per-account tags, combined Greeks, P&L and broker-reported margin. Each leg keeps its account for exits. The view never sends one order across accounts and never pools data across holders.
- Relationship tags are limited to the family definition in config; automation (guards, alert actions) on an account outside it is refused with the reason.

**Phase 1 cross-cutting (inside each item's PRD):** K3 glossary hovers for every new metric; K5 CSV export on every new panel; K7 API contract (§7.8) for every new endpoint, with an OpenAPI diff check in CI; G9 brokerage plans in every charge; demo adapter realism for every new data path; reference-value tests for every pure function in `options.js` or the server equivalent, including a test that every rupee warning reads its rate from `CHARGE_RATES` or S5; K6 prediction logging for every new probability.

**Phase 1 exit criteria:**
- Every Options page has a working time axis.
- IVR and IVP are live (indices full, stocks partial where labelled).
- Stocks are covered within the data account's feasible set.
- Broker margin is shown for the 3 wired brokers, with per-leg sequence checks on exits and rolls.
- At least 10 alert conditions are working, and guards show "cannot trade" correctly in the readiness test.
- No pricing constant remains (rate, brokerage, session, 365-day clock).
- The dashboard does not poll on the chain or positions pages in market hours.

### 6.2 Phase 2: analysis depth and execution quality (next quarter)

| Item | Catalogue rows | Why now |
|---|---|---|
| Replay simulator + paper with real margin | I2, I1 | S1 will hold about 3 months of history by then. Paper can use G2. |
| Strategy optimizer + outlook wizard + hedge finder | B7, K4, B6, B15 | Needs multi-expiry (P1-9) and margin (P1-10). Highest-value missing builder features. |
| Expiry-day pressure heatmap and unusual-activity list | D8, D11 | Needs stream and recorder. NIFTY and SENSEX 0DTE only. |
| Vol depth | A4, A5, A6, C4, C5, C6, C8, C9, A10 | Needs S2 history. |
| Load live positions into builder, compare, drag-to-adjust, roll assistant | B9, B10, B11, F8 | Seller workflow completeness. |
| Hedge-first basket with legging panel, rollback and slice sending; super/OCO orders | G4, G6, G8 | Execution trust. |
| Alert → action | H3 | Builds on P1-11/12 and H5. |
| Book risk: rupee Greeks, beta-weighting, stress grid, limit awareness | F3, F4, F6 | Pro and hedger depth. |
| Tax and turnover report | F10 | Before the July filing season. |
| Calibration report | K6 | Enough recorded expiries by then. |
| Scalper one-screen | G5 | Needs the owner's chart engine and streaming. |
| Journal with roll chains | I5 | Retention and learning. |
| Events, FII/DII cash, local levels note, heavyweights and breadth, overnight cues | J2, J4, J5, J6, J7, B14 | Context. |
| Screener IVR filters, Compass scatter, multi-expiry chain, OI heatmap, futures OI | E2, E3, A12, D12, D13 | Discovery. |
| Grounded AI explainer, shareable links | K1, B13 | Reach and learning (after the §7.9 prompt-injection tests). |
| Flow classifier benchmark (spike) | D9, D10 | Decide go/no-go with measured accuracy. |

### 6.3 Phase 3: the pro and automation tier

- Backtester (I4): EOD from S6, intraday from S1 once there are 6 or more months.
- Forward test (I3).
- No-code recipes (H4), after the §8.1 algo-provider legal review.
- Hedging-pressure line and net premium tide (D9, D10), only if the Phase 2 benchmark passes.
- MCX and currency options (M1, M2).
- Editable probability distribution (B8).
- SVI surface (C7).
- Pricer with solve-for (G7, A13).
- P&L attribution (F5).
- Ex-event IV (C10).
- Natural-language screener (K2).
- Strategy-level scans (E4).
- Leg dissection (B12).

---

## 7. Non-functional requirements

### 7.1 Performance and latency

| Measure | Target (p95, mid-range laptop, Chrome; phone = 4-year-old Android mid-range) |
|---|---|
| Chain first paint (cached instrument master) | ≤ 1.2 s desktop, ≤ 2.0 s phone |
| Tick to painted cell (streaming) | ≤ 250 ms desktop, ≤ 400 ms phone |
| Main-thread long tasks during market hours | none above 50 ms; 60 fps scroll on the chain |
| Payoff / heatmap recompute (10 legs, 25×20) | ≤ 30 ms; drag interactions ≤ 16 ms per frame |
| Full-day OI/straddle series load | ≤ 800 ms from S1 |
| Alert condition → notification | ≤ 5 s streamed, ≤ 70 s recorder-only |
| Basket margin round trip | ≤ 1 s after the last edit (debounced) |
| Recorder write per minute (all chains) | ≤ 2 s CPU, never blocking the API event loop (worker or chunked) |

### 7.2 Rate limits and resource use

- Everything goes through the existing rate-limit policy table and scheduler. User-facing requests always have priority over recorder, screener and alert work.
- Background work uses at most 50% of each broker's budget by default (configurable), within the §5.3 feasibility table.
- With streaming, the dashboard makes zero REST polls per page in market hours (except the fallback).
- Screener sweeps are resumable and show progress. They never run a second concurrent sweep.

### 7.3 Mobile

- Every Options page works at 360 px wide, follows PRD 08 (P5: phone is a layout), and has a 16 px gutter with no horizontal page scroll.
- Wide tables (chain, heatmap, price slices) scroll inside their own panel with a sticky strike column.
- Phone-first flows: chain → action sheet → ticket. One-tap alert from any cell. Guard notifications deep-link to the prepared exit, which needs the Bridge to be reachable from the phone (§7.9 covers how).
- Touch targets ≥ 44 px. Drag interactions (strikes, SL/target) have a numeric alternative.

### 7.4 Accessibility

- WCAG 2.2 AA contrast in both themes, and support for `forced-colors`.
- Colour is never the only signal (PRD 08 P7): signs on every P&L, CE/PE text, shape cues on heatmaps, and patterns on ITM.
- Every SVG visual has a text alternative: a summary sentence plus a data table toggle.
- Full keyboard operation of chain, builder and ticket, with visible focus. Shortcut help on `?`.
- Live-updating numbers use `aria-live="off"` by default, with an opt-in "announce alerts" mode so screen readers are not flooded.
- Reduced-motion setting disables cell flashes and replay animation.

### 7.5 Order safety (extends `docs/guides/safety.md`; nothing here loosens it)

- Paper is the default everywhere, including replay, optimizer outputs, alert actions and guards.
- A live order from any new feature (basket, roll, guard, alert action) needs every gate in the safety model. Automated sends (guard auto-exit, alert → send) also need per-rule opt-in in live mode, an H5 "can trade" state, and count toward order rate, daily orders and daily loss.
- Every multi-leg send shows its effect on existing positions first (netting preview), uses hedge-first order on entry and shorts-first on exit, checks margin after each leg (F9), and has a legging panel with rollback. The UI never claims an atomic fill.
- Every automated action is idempotent (the rule-fire ID is the idempotency key) and written to the audit log.
- Kill switch: one tap from every Options page header. It stops guards and alert actions too.
- Stale-data guard: no order is prepared from data older than 10 s in market hours without an explicit "price is stale" confirmation.

### 7.6 Data honesty and correctness

- Every derived number has a method note and an `asOf`. Model choices (Black-76, parity forward, vol-time clock, rate, sticky-strike, sign model) are visible and switchable where it matters.
- All maths stays in pure, unit-tested functions. New maths needs a reference-value test (hand-computed or against a published example).
- Inferred data (spread grouping, any aggressor side) is always labelled "inferred". Backfilled data is labelled with its quality.
- Probabilities show their calibration status (K6).

### 7.7 Reliability and privacy

- The recorder and alert evaluator survive restarts and write atomically. A corrupted day file must not stop the next day.
- Everything stays local. There is no telemetry off the machine unless the owner opts in. Shared links carry legs only, never account data, prices or identifiers.
- **DPDP Act 2023:** if opt-in telemetry is ever collected by the vendor, it must be anonymous usage counts with no personal or trading data, with a notice, purpose limitation, a deletion path and a named contact, reviewed by counsel before release.

### 7.8 Developer API contract (persona Q, K7)

- **Versioning:** `/v1` is stable. Within `v1` changes are additive only: new endpoints, new optional fields, new enum values documented as open. Removing or renaming a field, changing a unit or changing a default needs `/v2` or a 6-month deprecation with a `Deprecation` header and a changelog entry.
- **Schema:** every endpoint is in `docs/openapi.yaml` (streams in `docs/asyncapi.yaml`) before it ships. CI fails on an undocumented field or a breaking diff. Units are part of the schema (OI in units, rates as decimals, IV in vol points or decimals as stated, money in ₹).
- **Quotas:** per API key, configurable requests/min and a separate history-row budget per minute, so one script cannot starve the dashboard or the recorder. Over-quota returns 429 with `Retry-After`. Defaults set in the PRD.
- **Latency (self-hosted, p95):** reads of the latest snapshot ≤ 100 ms; a full day of one chain from S1 ≤ 800 ms; history endpoints paginate with a cursor and a maximum page size.
- **Parity:** every REST read has an MCP tool and a Sheets/compat path with the same fields and units.
- **Scopes:** `read` for all data; `paper` and `live` for rule writes as in §5.6. MCP keys keep the existing restriction (no `admin`).

### 7.9 Security threat model

| Asset or path | Threat | Control |
|---|---|---|
| Broker tokens and API keys | Theft from disk or logs | Already AES-256-GCM at rest with HMAC integrity and log redaction (`auth/secretStore.mjs`). New stores (S7 rules, S8 journal) hold no secrets. A test asserts no token appears in any new store or log. |
| REST/MCP write endpoints (alerts, guards, journal) | A read key or an AI tool arming live automation | Scope checks per §5.6; `live` keys only from loopback; the MCP path can never set a rule to auto-send. |
| Dashboard | CSRF from another site in the same browser | Same-origin check and per-session token on every state-changing route; tested in P1-5. |
| K1 AI and any text from chains, news or notes | Prompt injection leading to a ticket or a rule | Text inputs are passed as quoted data; the AI has read tools only; a prepared ticket goes through the normal ticket with human confirmation; a red-team test set of injected strings must not produce a prepared order. |
| Phone deep links (§7.3) and Telegram | Exposing the Bridge to the internet | Default is no exposure. Recommended: a private VPN/tunnel with auth. A public tunnel must use a separate `read`/`paper` key and never `live`. The compliance tunnel caveats apply. |
| Notifications | Leaking positions or identifiers to chat services | Messages carry strategy names and P&L only by user choice; no account IDs or tokens. |
| Egress-IP lookup | Leaking the user's IP to a third party | Off by default; user picks the service or enters the IP. |

---

## 8. Risks and compliance

Not legal advice. Every row below is **needs verification** against primary SEBI, NSE, BSE and MCX circulars, the Income-tax rules and broker notices before launch. See also `docs/guides/compliance.md`.

### 8.1 Regulatory rules that shape features

| Rule (as researched, Oct 2026; all **needs verification**) | Feature impact |
|---|---|
| SEBI circular of 1 Oct 2024, effective 20 Nov 2024: one weekly index expiry per exchange (NIFTY on NSE, SENSEX on BSE), higher minimum contract size, and an extra 2% ELM on short index options on expiry day. Then from 1 Feb 2025: upfront premium collection and no calendar-spread benefit on expiry day. From 1 Apr 2025: intraday monitoring of position limits. NSE expiries moved to Tuesday and BSE to Thursday from 1 Sep 2025. | Data-driven calendar (P1-2). G3 checks and expiry-day margin preview. Margin preview includes premium for buys. 0DTE claims only for NIFTY and SENSEX. |
| Lot sizes revised twice a year (Jan 2026: NIFTY 65, BANKNIFTY 30, FINNIFTY 60, MIDCPNIFTY 120, SENSEX 20). | Lots from S5 with effective dates. Positions keep the lot size they opened with. |
| Delta/FutEq-based OI and position limits; intraday index limits; intraday MWPL monitoring; F&O pre-open. Entity-level index limits apply to very few users. | F6 limit and MWPL awareness; MWPL % and ban list in S5; pre-open state in the chain. Limit values as dated config. |
| SEBI F&O eligibility criteria for stocks (Dec 2024) and periodic exchange reviews. | Point-in-time universe (J9). |
| Index options settle on the average of the index over the last 30 minutes of expiry day (exchange method). | A16 running settlement estimate; payoff at settlement. |
| Physical settlement of stock derivatives; delivery margins step up in the days before expiry. | F7 schedule and warnings from E-4. |
| STT on options: 0.15% on sell premium and on exercise intrinsic (after Budget 2026, as in `CHARGE_RATES`). | All rupee warnings read the rate table; stale copy removed (P1-6). |
| Retail algo framework (SEBI CIR/2025/0000013 of 4 Feb 2025; NSE standards of 5 May 2025; fully mandatory from 1 Apr 2026). Unregistered algos ≤ 10 orders/s per segment; static IP for API orders; daily logout. Condition-triggered orders may count as algo. | Guards, alert → action and recipes stay under the Bridge's 5/s cap, use the broker's generic tag, need opt-in, and need H5 "can trade" (static IP, valid session). Slices are paced (G8). **Needs verification** per broker of whether a bridge-side conditional exit is "algo". |
| Family definition under the algo framework (self, spouse, dependent children, dependent parents). | F11 restricts relationship tags; automation on any other holder's account is refused. Managing money for anyone else needs PMS/IA/RA registration and is out of scope. |
| **Algo-provider empanelment.** Third-party algo providers must be empanelled with the exchanges through brokers; black-box algos need RA registration. If Mr. Chartist distributes software whose guards, alert actions or recipes place orders, the vendor itself may be an algo provider. | Before H2 auto-exit ships to users, legal review decides whether the vendor needs empanelment. Until then auto-exit stays opt-in, user-configured and white-box. H3 send and H4 recipes are gated on that review. Recipes must stay white-box: the user sees and owns every condition; the vendor ships no strategies, signals or hidden logic. |
| Research Analyst / Investment Adviser regulations, which apply once the software is distributed by a company. | No "recommend", "best", "buy", "sell", "rich" or "cheap" labels (E1 renamed, A5 "above/below fit", optimizer "ranked by your inputs"). J5 notes are generated locally for the user and never published, emailed or shared by the vendor. No curated strategy marketplace or signal-selling. Hosting for others needs legal review first. |
| SEBI rules on finfluencers and education (2024–25): education may not use recent live market data (reported look-back 3 months). | Public share cards and vendor marketing use old data or legs-only links. Shared links never embed live prices. |
| Mandatory F&O risk disclosure. | Shown on first use of live F&O orders and in the ticket footer (link). |
| F&O income is non-speculative business income; turnover rules and the tax-audit threshold apply. | F10 calculates and exports; it does not advise. Text points to a CA. |
| NSE website terms of use prohibit automated scraping. | NSE website backup off by default, explicit opt-in with a warning (§5.3). Public archive files fetched at a polite rate. |

### 8.2 Paper vs live

- Paper results, replay results and backtests are shown in a different visual mode (badge and tinted header) and are never mixed into live P&L or the journal without a "paper" tag.
- Backtest and replay outputs carry the fill model and slippage assumption on every result. AlgoTest's fill-at-candle-close complaint is the cautionary case. Default assumptions are conservative (cross the spread, plus slippage).
- Paper margin is labelled "broker margin" only when it actually came from the broker API (G2); otherwise it is labelled "estimate".

### 8.3 Market-data terms

- Broker data is for the account holder's personal use. The recorder stores data locally only and never pools across holders. Shares and exports carry no live data to third parties. The Sheets tunnel caveats in `compliance.md` apply to every new endpoint.
- NSE and BSE archives (bhavcopy, participant OI, corporate actions) are public files fetched at a polite rate. Index-weight and GIFT Nifty sources need a licence check before use.

### 8.4 Disclaimers (where they appear)

- Global footer: "For information and personal use. Not investment advice. Options trading carries high risk."
- Optimizer, wizard, hedge finder and levels: "Calculated from your inputs and market data. Not a recommendation."
- Modelled exposure: "Modelled from open interest under the selected assumption. Actual positions are unknown, and India has no designated hedging dealers."
- Probabilities: "Model probability; calibration: [status]."
- AI: "Generated from the numbers listed below. Check before acting."
- Backtest and replay: "Hypothetical results with the stated fill model. Past performance does not predict future results."
- Tax report: "Calculated from your trades. Not tax advice; confirm with your CA."

### 8.5 Product and delivery risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Recorder exceeds broker rate limits or gets the account throttled | Medium | High | Stream-first, §5.3 feasibility table as a gate, 50% budget cap, priority to user calls, a fake-broker load test. |
| Broker session expires or egress IP changes; automated exits silently rejected | High | High | H5 readiness check at pre-open and continuously, "cannot trade" guard state, notification, VPS guidance. |
| Vendor classed as an algo provider or RA | Medium | High | §8.1 legal review before auto-exit, alert-send and recipes reach users; white-box only; neutral copy. |
| Data/API subscription cost blocks recording | Medium | Medium | §5.7 matrix, indices by default, stocks opt-in. |
| OI unit mismatch inflates exposure | High (without the rule) | High | One unit in `normalise.mjs` with contract tests per broker. |
| Disk growth on user machines | Medium | Medium | Compressed day files, configurable retention, a size readout, and stocks tracked only when opted in. |
| Exposure levels misread as signals | High | Medium | Visible assumption switch, method notes, descriptive copy, and no "buy at put wall" language. |
| Miscalibrated probabilities trusted by users | Medium | High | K6 calibration, "uncalibrated" labels until measured. |
| Guard or alert auto-exit fires wrongly (bad tick, stale data) | Low | High | Blind and cannot-trade states, hysteresis, price sanity bands, paper default, per-rule live opt-in, and an audit log. |
| Exits or rolls trigger short-margin penalties | Medium | Medium | F9 per-leg margin sequence on every multi-leg action. |
| Prompt injection through K1 | Medium | High | §7.9 controls and red-team tests before K1 ships. |
| Broker margin APIs differ or are missing | High | Medium | Return `null` with a reason, show an estimate with its error band, per-broker adapters behind one endpoint. |
| Chart engine timing (owner-supplied) | Medium | Medium | Every time-series feature ships its data endpoint and an SVG sparkline/table fallback first. The engine plugs into `chartSlot`. |
| Regulatory change (weekly expiries, lot sizes, limits, STT) | High | Medium | Data-driven calendar, rates and limits; config tables with a source date. |
| Scope creep: building every catalogue row | High | High | Phase gates, per-item PRDs, exit criteria. |
| "Vail" meant a product we didn't research | Medium | Low | Confirm with owner (see top note). |

---

## 9. Metrics

The Bridge is self-hosted, so these are measured locally. Telemetry only leaves the machine on opt-in (§7.7). The dashboard shows them on a local "Desk health" panel.

### 9.1 North-star

**Weekly active trading days with a decision made on the desk:** days on which the user previews or places an order, or creates an alert or guard, from an Options page.

### 9.2 Product metrics

| Area | Metric | Target (end of Phase 1) |
|---|---|---|
| Adoption | Share of trading days on which each Options page is opened | Chain 90%, OI 60%, Vol 40%, Positions 80% |
| Time dimension | Share of OI/straddle chart views using a window over 15 minutes or history | ≥ 50% |
| Alerts | Active alerts per user; share of alerts that fired and were acted on within 5 minutes | ≥ 5; ≥ 30% |
| Guards | Strategies with a guard / all open strategies | ≥ 40% for sellers |
| Builder | Share of builds using multi-expiry or heatmap | ≥ 25% |
| API | Share of installations with at least one `/v1/options/*` or `/v1/vol/*` call from a non-dashboard key per week | tracked, no target |
| Paper → live | Users with ≥ 10 paper trades who go live within 30 days (not a growth goal; a health signal) | tracked, no target |

### 9.3 Quality metrics

| Metric | Target |
|---|---|
| Shown broker margin vs the broker API response at the same call | identical (0 difference) |
| Drift between shown broker margin and later blocked margin (live, sampled) | tracked and explained by cause (SPAN update, ELM, MTM, sequencing); no target |
| Our estimate vs broker API figure | median absolute error ≤ 10% |
| Pre-trade check recall on rejection and penalty fixtures | ≥ 90% |
| Multi-leg partial-fill incidents left un-rolled-back after 60 s | 0 |
| Guards that attempted an order while "cannot trade" | 0 |
| Recorder coverage (minutes recorded / market minutes) | ≥ 99% on index chains |
| IV agreement server vs client | ≤ 0.05 vol pts |
| σ-band calibration (share of expiries inside ±1σ, indices) | reported with its confidence interval; flagged if outside 60–76% |
| Tick-to-paint p95 | ≤ 250 ms |
| Stale-data orders prepared without confirmation | 0 |
| Breaking API changes inside `/v1` | 0 |
| Crash-free sessions | ≥ 99.5% |

### 9.4 Outcome metrics (for the user, shown in the journal, never gamified)

- Share of losing trades closed by a guard before reaching 2× the planned max loss.
- Average entry IVR for short-premium trades (are sellers selling rich vol?).
- Share of long-option trades opened with an event inside the window, against outcome.

---

## 10. Appendix

### 10.1 Chart policy

- **Owner-supplied chart engine** (placeholders via `chartSlot` until it lands): every price/time chart. This covers underlying candles, option premium, straddle over time, OI/ΔOI/PCR/IV/VIX timelines, participant OI history, settlement-estimate line, equity curves and the replay scrubber chart. Each ships its data endpoint and CSV export first, plus a minimal SVG sparkline and table fallback.
- **Purpose-built SVG (in scope now):** payoff curve (T+0, target, expiry, σ bands, levels, settlement estimate), P&L heatmap table, price-slice grid, smile and term curves (existing `vol-curves.js`), skew shadow band, fixed-strike matrix, OI ladder and mirrored exposure bars, strike × time pressure heatmap, strike × expiry OI heatmap, probability distribution bars (editable later), reliability diagram, Compass scatter, heavyweight contribution bars, limit and margin gauges, and the legging-status panel.

### 10.2 Glossary of terms used here

- **Black-76:** option model on the forward price, used for all IV. For MCX (Phase 3) the forward is the listed future.
- **Parity forward:** F = K + e^{rT}(C − P), from mids, taken as the median over the strikes nearest ATM with two-sided quotes; r from S5, T from the vol-time clock.
- **Vol-time clock:** the time-to-expiry model used for pricing: calendar ACT/365, trading days/252, or weighted (weekends, holidays and event days weighted; intraday by minutes to the settlement window).
- **σ band:** F·exp(±k·σ_ATM·√T).
- **Expected absolute move:** ≈ the ATM straddle ≈ √(2/π)·σ·F·√T, about 0.8 of a 1σ move.
- **IVR (IV Rank):** (current − 1-year low) / (1-year high − low).
- **IVP (IV Percentile):** the share of days in the lookback with IV below today.
- **RR25:** call 25Δ IV − put 25Δ IV (market convention; negative for equity indices). "Put skew" is the opposite sign, named as such.
- **BF25:** average of the 25Δ wing IVs − ATM IV.
- **GEX:** modelled gamma exposure, Σ OI_units × Γ_F × F² × 1% × sign, in ₹ per 1% move of the forward. OI in units, Γ w.r.t. the forward.
- **Zero-gamma:** the forward level at which total modelled GEX changes sign when every Γ is recomputed at that level, IV held sticky-strike.
- **Settlement price (index options):** the exchange's average of the index over the last 30 minutes of expiry day.
- **FutEq:** delta-equivalent futures exposure.
- **ELM:** extreme loss margin.
- **MWPL:** market-wide position limit.
- **Units (OI):** shares or index units, not contracts.

### 10.3 Research sources (summary)

- **US retail:** thinkorswim (Analyze, Price Slices, Probability Analysis, Sizzle), tastytrade (POP, IVR, expected move, order chains), IBKR (Probability Lab, Risk Navigator), Robinhood (Options Analyzer, Simulated Returns), OptionStrat (heatmap, Optimizer, Flow), Option Alpha (no-code bots), OptionsPlay, Market Chameleon, Barchart, E*TRADE, Webull, Moomoo.
- **Flow and vol:** SpotGamma (TRACE, HIRO, levels, Compass), Unusual Whales (Market Tide, flow alerts), Cheddar Flow, BlackBoxStocks, Tradytics, Volland, MenthorQ, SqueezeMetrics, ORATS, Cboe LiveVol/Hanweck, Velo, Genesis Volatility.
- **India:** Sensibull, Opstra, Quantsapp, Dhan, Sahi, AlgoTest, StockMock, Tradetron, iCharts, TrueData, Upstox, Fyers, Groww, Samco, Zerodha Kite, NSE and BSE tools; SEBI and exchange circulars 2024–26.
- **Pro:** Bloomberg (OMON, OVME, OVDV, SKEW, VCA, OSA), LSEG Workspace, OptionVue, OptionNet Explorer, Hoadley, Saxo/IG, Deribit, Greeks.live, Laevitas, Amberdata/GVOL.
- **Internal:** code audit of `server/bridge/dashboard/*` (including `options.js`: `RISK_FREE`/`RATE`, `T_FLOOR`, `CHARGE_RATES`, the STT copy at line 826, the session logic), `server/bridge/ratelimit/brokerPolicies.mjs`, `server/bridge/market/normalise.mjs`, `server/bridge/safety/safetyGuard.mjs`, `server/bridge/auth/secretStore.mjs`, `docs/openapi.yaml`, `docs/asyncapi.yaml`, `server/bridge/backup`, `server/bridge/notify`, `server/bridge/scanner`, and PRDs 01–08.

Full URLs are in the research briefs that fed this BRD. Each claim there is tagged as verified [V] or from knowledge [K].
