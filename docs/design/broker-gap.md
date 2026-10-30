# Broker gap audit: what an Indian F&O trader expects

Written 30 October 2026. The bar is a top broker terminal (Kite, Dhan, Upstox, Sahi) plus the options tools traders
pair with it (Sensibull, Opstra). Every row was checked in the code on `claude/happy-carson-2a6o3y`, not guessed.
"Have" names where it lives. "Partial" says what is there and what is not. "Missing" means no code path exists.

Paths are under `server/bridge/` unless they start with `docs/`.

## 1. Orders

| Feature | Have (where) | Partial | Missing |
|---|---|---|---|
| Limit and market | Server, paper and ticket (`orders/orderValidation.mjs ORDER_TYPES`, `dashboard/desk.js openTicket`) | | |
| SL and SL-M | Server and paper engine fully (`paper/paperEngine.mjs` trigger_pending, stop-crossed checks; market policy converts SL-M for live) | The ticket offers only Limit and Market (`desk.js typeSeg`); Modify cannot set a trigger | |
| AMO (after-market order) | | Paper accepts orders outside hours; live is refused with MARKET_CLOSED (`safety/safetyGuard.mjs`) | No AMO flag, no queue for the next open |
| GTT single | | | No GTT anywhere (`grep -ri gtt` finds nothing) |
| GTT OCO | | | Missing |
| Bracket-style target + stop | | | No attached exits on entry |
| Trailing stop | | | Missing (the guard spec `docs/spec/p1-12` plans a trailing lock; not built) |
| Iceberg / slicing | Basket slicer at min(freeze, per-order lots, per-order value) (`dashboard/basket-core.js`, `strategy-place.js`); exits slice too (`options.js exitPlan`); server freeze slicing for live (`orders/config.mjs`) | The single-order ticket does not slice (a large order is refused with the reason) | |
| Modify and cancel | Orders page Modify and Cancel (`dashboard/views.js orderActions`), every modify re-checked (`orderService.mjs modifyShape`); Undo for a cancelled paper order | Modify has no trigger price or order-type change in the UI | |
| Cancel all | `POST /v1/orders/cancel-all` (`orders/routes.mjs`) | No button in the dashboard | |
| Exit all | Positions › Exit all, Exit group, Exit selected (`positions.js`) | Not on the Orders page | |
| Convert MIS↔NRML | | | No route, no paper engine support, no UI |
| Order book with filters | Orders › Today's orders (`views.js renderOrders`) | No filter by status, side, account or mode; no search | |
| Trade book | `GET /v1/trades` (server and paper) | Journal groups fills into trades (`journal.js`); no plain trade book table in the UI | |
| Rejection reasons in plain words | Server messages are plain (`statusMessage`, check messages) and shown under the status pill | Error codes reach the toast as the server sentence; no "what to do" line per code | |

## 2. Positions

| Feature | Have (where) | Partial | Missing |
|---|---|---|---|
| Day vs net | | Hero splits realised today vs unrealised (`positions.js` hero); paper positions carry cumulative buy and sell quantities, not a day/overnight split | No Day / Net toggle |
| MTM | Live marks from the stream (`positions.js`, `paperEngine markPositions`) | | |
| Realised vs unrealised | Hero composition bar and title (`O.bookPnl`) | | |
| Square-off by group | Exit group, Exit selected, Square off expiring legs (`positions.js`, `expiry-core.js`) | | |
| Hedge suggestions | Hedge helper footer (`positions.js hd`), protective puts (`options.js`), "hedge this short" is a proposal | | |
| Position SL / target with auto exit | | Position alerts notify on P&L, spot, delta, premium multiple (`alerts/alertService.mjs`): notify only, never exit | No stop or target that exits |
| Expiry-day handling | Expiry desk: countdown, pin risk, assignment risk, square off expiring legs (`expiry-core.js`); expiry-day ELM in margin | | |
| Physical delivery warnings | Order-time check in the delivery window (`orderService.mjs physicalSettlementCheck`), expiry desk STT and delivery lines | | |
| Multi-account book | All accounts / Family scope (`book/`, `positions.js scopeNow`) | | |

## 3. Funds and margin

| Feature | Have (where) | Partial | Missing |
|---|---|---|---|
| Available, used | `GET /v1/funds`; Orders › Paper accounts card; Accounts › Today | Only paper accounts summarised on Orders; no funds view for a live account on one screen | |
| Collateral | | Field exists, paper returns `collateral: null` | No pledged collateral in paper |
| Pre-trade margin preview | Ticket margin and "With your positions: adds" (`desk.js` preview, `span-margin.js`, `POST /v1/paper/accounts/{id}/margin`); basket margin first | | |
| Charges calculator | Ticket round-trip charges, after-charges max loss and breakeven (`flows.js riskAfterCharges`, `options.js charges`) | No stand-alone calculator page (Strategy lab has Greeks and size only) | |
| P&L calendar | Orders › Journal heatmap (`journal-core.js`) | | |
| Tax P&L (STT, turnover) | | Charges per fill in the paper store | No F&O turnover, no tax P&L statement |
| Ledger | | | No ledger of cash movements (fills, charges, resets) |

## 4. Market

| Feature | Have (where) | Partial | Missing |
|---|---|---|---|
| Market depth, 5 levels | `GET /v1/depth` (`market/`), demo serves 5 levels | No depth in the ticket or contract sheet | |
| Market depth, 20 levels | | | Not in the contract or any adapter |
| OI and IV per strike over time | Recorder snapshots every minute (`recorder/`), OI change windows (OI Analysis) | No per-strike time chart | |
| Straddle / strangle premium charts | Exposure › Straddle (ATM straddle through the session) | Strangle not charted | |
| Futures basis and rollover | Futures › chain, basis history, synthetics (`analytics/futuresChain.mjs`) | | |
| FII / DII | Flow › FII and DII; Participants | | |
| Events and corporate actions calendar | Market calendar (`calendar.js`, `reference/corporateActions.mjs`); Flow › Filings | | |
| Ban list | Market calendar, scanner field, order check (`safetyGuard.mjs` ban rule) | | |
| Option chain greeks, IV, PCR, max pain | Option Chain, OI Analysis | | |

## 5. Tools

| Feature | Have (where) | Partial | Missing |
|---|---|---|---|
| Strategy builder, payoff, what-if | Strategy Builder, `whatif.js`, `payoff.js` | | |
| Option calculators | Strategy lab › Calculators (Greeks from price or IV) | | |
| Probability cones | | Vol stats expected move; POP on Strategy | No cone chart |
| Position sizing | Strategy lab › Calculators (lots for a risk budget) | Not linked from the ticket | |
| Trade journal | Orders › Journal | | |
| Alerts: price | Live events custom conditions (`events/conditions.mjs`), spot alerts on positions | No "alert on this contract's LTP" from the chain sheet | |
| Alerts: OI, IV, greeks | Market rules (PCR, ATM IV, IV rank, max pain, gamma regime, basis; `analytics/alertRules.mjs`); delta band on positions | No per-strike OI or IV, no theta or vega condition | |
| Watchlists, scanners | Screeners › Watchlists, Stocks, Options | | |

## 6. UX

| Feature | Have (where) | Partial | Missing |
|---|---|---|---|
| One-click and hotkey trading | Ctrl K trade intents (`trade-intent.js`); chain B/S and T keys; Positions keys (X, ⇧X, H, C) | | |
| Keyboard shortcuts everywhere | Chain, Positions, palette, `?` sheet | Orders and Safety have no keys | |
| Mobile bottom-sheet ticket | `dialog.sheet` is a bottom sheet under 1024 px (`app.css`); chain sheet (`chain-sheet.js`) | | |
| Confirmations | Live ack box, ticket confirmations, kill-switch confirm | | |
| Undo where safe | Paper cancel, paper reset, chain build-around | No undo after Modify | |
| Notification centre | The bell inbox (position and market alerts) | Order fills and rejections are toasts only | |
| Multi-account | Accounts, account picker, family book | | |

## 7. Priority: trader value against effort

Effort: S (hours), M (a day), L (more). Built in this order; each lands as its own commit.

| # | Gap | Value | Effort | Why this place |
|---|---|---|---|---|
| 1 | Server trigger engine with **GTT single and OCO** (paper first, live only through `orders.place`; survives restarts; shown in Orders) | Very high | L | Every broker has GTT; it is the base for 2, 3 and 4 |
| 2 | **Stop and target on the ticket** (bracket-style: attach an OCO GTT that arms when the entry fills) | Very high | M | The most-used Kite and Dhan habit; reuses 1 |
| 3 | **Position stop and target with auto exit** (Positions row and group, paper first) | Very high | M | Alerts only notify today; Sensibull and Dhan exit for you |
| 4 | **Trailing stop** (a GTT whose trigger follows the best price by points or %) | High | S on top of 1 | |
| 5 | **SL and SL-M in the ticket**, and trigger in Modify | High | S | Server already supports them |
| 6 | **Orders: filters, Cancel all, trade book tab** | High | S | Cancel all exists on the server only |
| 7 | **Convert MIS↔NRML** (paper engine, route, Positions row action) | Medium-high | M | Daily need near 15:20 |
| 8 | **Market depth (5 levels) in the ticket** | Medium | S | Route exists; no UI |
| 9 | **Rejection reasons in plain words with a fix** | Medium | S | A table from error code to "what to do" |
| 10 | **AMO**: accept outside hours, queue, send at the open (paper; live through the gated path) | Medium | M | Reuses 1 |
| 11 | **Tax P&L and turnover, ledger** from paper fills and charges | Medium | M | |
| 12 | **Funds card** for every account (available, used, collateral, utilisation) on Orders | Medium | S | |
| later | Per-strike OI and IV over time, strangle chart, probability cone, per-strike OI/IV alerts, theta/vega alerts, 20-level depth, Day / Net toggle | Medium | M–L | Markets and analytics pages belong to other teams; proposed to them |

## 8. Safety rules every new path keeps

- New orders go only through `orderService.place` (and so `safetyGuard.check`): per-order lots and value, daily
  count and loss, kill switch, price band, market hours, freeze, ban, readiness and every live opt-in.
- Triggers fire as source `guard` with a `guard` principal limited to the trigger's account and the creating key's
  scopes. A live trigger needs `guard` in the account's `live.allowedSources` (off by default), the key's `live`
  scope and every other live gate at fire time. A refusal is recorded on the trigger, never retried around a gate.
- Paper is the default for every new control.

## 9. Statement method (Orders › Statement)

An estimate for the trader's records, not tax advice; the broker's tax P&L and contract notes are final, and a CA
confirms how it is filed. Tax payable is not computed.

- **Realised P&L:** first in, first out per contract and product, from the Bridge's fills (`statement-core.js`).
- **F&O turnover:** the sum of the absolute profit or loss of each settled trade; for options the premium is part of
  that settled difference. Source: ICAI, *Guidance Note on Tax Audit under Section 44AB of the Income-tax Act, 1961*
  (revised 2023), the paragraphs on how turnover is computed for derivatives (futures and options); the ICAI site
  publishes the current edition.
- **Segments:** F&O as non-speculative business income (Income-tax Act s. 43(5) proviso (d) excludes eligible
  exchange-traded derivatives from speculation); equity intraday as speculative business income; equity delivery as
  short-term (held 12 months or less) or long-term capital gains.
- **Charges:** the ticket's model (`options.js charges`) with the reference table's rates: brokerage, STT, exchange
  and IPFT, SEBI fee, stamp duty, GST. The Trades tab uses the same model, so the totals agree for the same days.
- **Ledger:** paper accounts only (opening cash, realised P&L and charges by day, closing). For a live account the
  broker's ledger is the source of truth.

## 10. Built (30 to 31 October 2026)

Each row is one commit on `claude/happy-carson-2a6o3y`, with tests, checked on a demo Bridge at 1920 and 390 px.

| # | Feature | Where | Notes |
|---|---|---|---|
| 1 | Server trigger engine: GTT single and OCO | `server/bridge/triggers/`, `/v1/triggers*`, Orders › Triggers, ticket When: At a price | Every fire calls `orders.place` as source `guard` with the creator's scopes; live needs `guard` in `live.allowedSources`; AI keys cannot set triggers. Atomic store; restart resolves a firing trigger by its clientOrderId, one Idempotency-Key per trigger. |
| 2 | Stop and target on the ticket (bracket) | `desk.js` Stop and target, origin `bracket` | Arms on the entry's fill with the filled quantity; reduce-only; max loss at the stop, if it gaps, reward and reward to risk. |
| 3 | Position stop and target with auto exit | Positions › leg › Stop and target…, chips under the leg | Reduce-only, cancels itself when the position is flat. |
| 4 | Trailing stop | `trail: { points | pct }` on any stop leg | Only tightens. |
| 5 | SL and SL-M in the ticket; trigger in Modify | `desk.js`, `views.js orderActions`, `flows.js modifyChange` | |
| 6 | Order filters, Cancel all, trade book | `orders-book.js`, Orders › Trades | |
| 7 | Convert MIS↔NRML | `POST /v1/positions/convert`, Positions › leg | Paper only; live is refused with where to convert. |
| 7a | Day / Net on Positions | `orders-core.js dayRows`, paper `overnightQty`, `prevClose`, `dayPnl` | |
| 8 | Market depth in the ticket | `desk.js` depth panel, `orders-core.js depthView` | Five levels; twenty where the source sends them (no adapter does yet). |
| 9 | What to do, in plain words | `reasons-core.js`, ticket, Orders, Triggers | Follows the account's mode. |
| 10 | After-market orders | origin `amo` in the trigger engine | Held on this Bridge, sent at the session open; a market AMO is not sent past the price band. Native broker AMO (Dhan `afterMarketOrder`) is a follow-up for the adapter owner. |
| 11 | Statement: tax P&L, turnover, charges, ledger | Orders › Statement, `statement-core.js`, §9 above | Estimate, not tax advice. |
| 12 | Funds for every account | Orders › Funds, `orders-core.js fundsView` | |

Proposed to other teams (not built here): per-strike OI and IV over time, the strangle chart, a probability cone,
per-strike OI/IV and theta/vega alert conditions (the bell), Dhan's 20-level depth feed and native AMO in the adapter.
