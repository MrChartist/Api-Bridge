# PRD 04: Positions and Risk, page `#/positions`

Status: ready to build · Owner: Options desk · Round 1
Files:
- `server/bridge/dashboard/options.js` (+ `options.test.mjs`): pure book maths in a new section `// ── Book risk ──`.
- New `server/bridge/dashboard/positions.js`: the page UI (book strip, positions table and cards, payoff, scenario, hedge helper, exit plan). desk.js keeps only the wiring.
- `server/bridge/dashboard/desk.js`: `renderDesk("positions")` returns the new panels; `openTicket` gains three options (§8.2); `analysePositions` is replaced (§8.5).
- `server/bridge/dashboard/app.css`: new section `12e · POSITIONS AND RISK`.
- `server/bridge/core/app.mjs` (DASHBOARD_FILES) and `format.test.mjs` (file list): add `positions.js`.
- No server change is required this round (§12).

Today `#/positions` is the shared toolbar plus one card. That card holds a table of option legs (Contract, Lots, Avg, LTP, P&L, Exit) for the selected underlying, with "Net Δ · θ a day" in the sub-title, an "Analyse" button and a MARKET-only "Exit all". This round turns the page into a risk desk:
- a **book strip** with the numbers a book is run on;
- **every leg priced and included**: all expiries, futures, and far strikes;
- per-leg Greeks;
- a **payoff of the current book** with three lines (now, the target date, expiry);
- a **scenario matrix** (spot × IV or spot × days);
- a **hedge helper** that shows before and after Greeks and an overlay, before anything is sent;
- a **safe exit plan** (limit at mid by default, shorts first, freeze-quantity slicing, partial exits);
- **expiry-day warnings**: exercise STT, extra ELM, MIS square-off, and lot-size mismatch.

---

## 1. Goals per persona

| Persona | Job on this page | Numbers they decide on (all on screen without sideways scrolling on desktop) | Mistakes the page must prevent |
|---|---|---|---|
| **Seller** (short strangle, iron condor, short straddle) | Keep theta coming in. Survive gamma. Adjust the tested side. Book profit at 50–80 % | Credit received, cost to close, **% of credit kept**, Θ ₹/day, Γ, Vega ₹ per vol point, distance of each short strike from spot (points and σ), breakevens now and at expiry, P&L at ±1σ/±2σ, margin used | Exit All buying back long wings before shorts (leaves naked shorts). Missing the expiry-day ELM jump. Short strike gone ITM unnoticed. MARKET orders on illiquid wings |
| **Hedger** (futures or stock book, protective puts, collars) | Keep book delta inside a band. Neutralise with futures or ATM options. Roll the hedge | Net Δ **including futures**, in units, in **lots of futures**, and as ₹ exposure. P&L at −3/−5/−10 %. Lots needed to neutralise and the **residual Δ after rounding**. Hedge DTE against exposure DTE | Wrong sign or lot rounding. Forgetting positions in other expiries (today's bug). A hedge that expires before the exposure it covers |
| **Buyer** (directional, long volatility) | Track P&L against the thesis. Know the theta bleed. Exit before IV crush or expiry | P&L and **P&L %**, breakeven spot, Θ ₹/day and Θ as % of position value, IV now, P(ITM), max loss = premium paid | Holding a long ITM option into expiry and paying **STT on exercise**. Averaging down a decaying OTM option (no prompt; the Θ % makes it visible) |
| **Arbitrageur** (conversion, reversal, box, calendar, futures basis) | Confirm a locked structure is really locked. Watch leg risk while legging out | Net Δ and Γ ≈ 0 with the residual shown. **Flat expiry line with its locked value.** Structure detected (conversion, reversal, box). Pin risk: spot within ±0.5 % of a short strike on expiry day | Exit All leg by leg at MARKET breaking the lock. Counting a structure as hedged when the futures leg is not on the page (today futures are invisible) |

Success this round:
1. The header numbers include **every** open leg on the underlying: all option expiries and futures. A leg that cannot be priced is **named** in the header, never dropped silently.
2. A seller can read "% of credit kept", Θ ₹/day and the distance of the nearest short strike in under 2 seconds, on phone and on desktop.
3. A hedger can open the hedge helper, see "Sell 2 lots NIFTY Nov FUT → Δ +1 300 → +50 (residual)", see the dashed after-hedge payoff and open a pre-filled ticket, in three interactions.
4. Exit all on a 4-leg condor sends **4 LIMIT orders at mid, shorts first**, and the confirmation shows the order list, prices and estimated slippage. A quantity above the freeze limit is split into lot-multiple orders.
5. 390 / 820 / 1440 widths, light and dark: no horizontal page scroll; touch targets 44 px on coarse pointers.

---

## 2. Current implementation: keep, change, add, remove

Source: `desk.js` `drawPositions` / `exitPosition` / `exitAllPositions` / `analysePositions` / `sendOrders` (lines ~288–400), `options.js` `positionsFor`, `parseOptionSymbol`, `netGreeks`, `valueAt`, `payoffAt`, `strategyStats`, `black76`, `forwardPrice`, `sigmaMove`.

### Keep
- The shared toolbar (underlying, expiry, account, live/paused, clock). The 3 s refresh (`REFRESH_MS`).
- `GET /v1/positions` as the source of positions. Its `realisedPnl` / `unrealisedPnl` / `charges` are used where present.
- Exit all orders shorts before longs (extended in §8.3).
- `sendOrders` sends sequentially with one batch `clientOrderId` per order and stops at the first refusal. It is extended to report what is left open (§8.3).
- The row Exit opens `openTicket({ exit: true })`, with preview then place. Paper by default; live needs the existing acknowledgement. **Safety gates are untouched**: every order goes through `/v1/orders/preview` checks and the server's per-order limits.
- The `side-tag` B/S chip, the contract cell shape (strong strike + right, small expiry · product), `pnl()` colouring.

### Change
| # | What | From | To |
|---|---|---|---|
| C1 | Which positions | `positionsFor` keeps only `…-CE/PE` of the selected underlying | New `O.bookLegs(positions, underlying)` keeps **options and futures** (`NFO:NIFTY-2026-11-24-FUT`), with `kind: "OPT"|"FUT"`. Other underlyings are counted for the switch strip (§4.1) |
| C2 | Greeks | only legs in the selected expiry; others add 0 silently | Each leg is priced from **its own expiry's chain**. Missing quotes fall back to `/v1/quotes` with IV solved from the mid (`O.impliedVol`). Futures: Δ = qty, other Greeks 0. Unpriceable legs are listed as "Not in Greeks: …" |
| C3 | Header | sub-title "Net Δ x · θ ₹y a day" | Book strip panel with 6 tiles (§5.1) |
| C4 | Lots column | `formatFixed(q/lot, 0)` hides fractions; shows Qty when the chain has not loaded | Lots from **the contract's own lot size** (`/v1/instruments/{symbol}`, cached). 2 decimals when not whole, plus a "Not a lot multiple" warning (§7) |
| C5 | Live price | broker `p.ltp` / `p.pnl` | Mark = the chain leg's mid (else LTP), fresher than the position row. P&L is recomputed from the mark. If the broker figure differs by more than 1 tick × qty, its value is shown in the cell's `title`, so nothing is hidden |
| C6 | Exit all | MARKET, unsliced, current underlying only, no prices shown | Exit plan modal (§8.3): Limit at mid by default (Limit at touch and Market are options). Freeze slicing, partial %, scope (all / group / selected), estimated slippage, locked-structure warning |
| C7 | Analyse | current expiry only; `max(1, round(q/lot))` turns 0.5 lot into 1; drops product; toast for other expiries | Per-group "Analyse" sends that expiry's option legs with **exact units** and avg prices (§8.5). Calendars: an explicit message that the builder is single-expiry (LATER) |
| C8 | Table at < 720 px | 6 columns, Avg hidden; still tight | Card list per leg with a tap action sheet (§4.3) |
| C9 | Empty state | "No open NIFTY options. Click a bid or ask…" | Mentions futures and other underlyings with open legs, plus links to Chain and Strategy (§10) |

### Add (MUST, details below)
Book strip; groups by expiry with group P&L / Greeks / credit kept / structure name; per-leg Greeks, IV, distance in σ, DTE; include/exclude checkbox per leg; payoff of the book (SVG, three lines, hedge overlay); scenario panel (sliders + matrix); hedge helper (futures, ATM option, gamma-then-delta); exit plan with slicing and partial exits; warnings (exercise STT, expiry ELM, MIS square-off countdown, lot mismatch, short strike tested/ITM, hedge expires first, unpriced legs); underlying switch strip; keyboard; settings.

### Remove
- The `Net Δ … θ …` text in the card sub-title (replaced by the book strip; no duplicate numbers).
- The "Analyse" toast "Positions on other expiries: switch the expiry…".
- The hard dependency of the positions page on `st.chain` for lot size and Greeks.

---

## 3. Information architecture

Top-level panels (each a `section.desk-panel` with `data-panel`, movable via `arrangePanels`, in this default order):

1. `desk-top` (fixed): the shared toolbar. On this page the **Expiry select is hidden**, because the page covers all expiries. Its space goes to the account select.
2. `book`: the underlying switch strip (only when other underlyings have open legs) plus the book strip tiles plus the warning line.
3. `positions`: the groups and legs, with the bulk action bar.
4. `risk`: payoff and scenario. Desktop: side by side. Tablet and phone: a segmented control "Payoff · Scenario".
5. `hedge`: the hedge helper (collapsed to its one-line suggestion until opened).
6. `chartslot` (off by default, setting): "Chart engine slot: book P&L and spot through the day, with your strikes". A 160 px placeholder with a hairline dashed border and that label. No chart library.

When there are no open legs, only panels 1–3 render (3 holds the empty state).

---

## 4. Layout per device

Breakpoints match the chain: phone < 720 px, tablet 720–1099 px, desktop ≥ 1100 px. Coarse pointer → 44 px targets regardless of width.

### 4.1 Desktop (1440 × 900)
```
┌ toolbar: [NIFTY ▾]                         [Demo paper account ▾]      14:32:05 ● Live ┐
├ book ─────────────────────────────────────────────────────────────────────────────────┤
│ Also open: BANKNIFTY 2 legs +₹1 240 · SENSEX 1 leg −₹310                (chips)       │
│ Net P&L        Net Δ           Γ             Θ / day       Vega / pt     Margin         │
│ +₹12 480       −1 310          −2.4          +₹4 920       −₹6 110       ₹1.42L used   │
│ R ₹3 200·U ₹9 280  ≈ −20.2 lots · −₹3.46Cr  Δ per 1% −63  credit kept 62% of ₹18 400   9.1% of funds│
│ ⚠ Expires today: 26300 PE short, extra ELM ≈ ₹34K · MIS square-off in 0:48           │
├ positions ────────────────────────────────────────────────────────────────────────────┤
│ [☑] 3 Nov · 6 days · Iron condor · P&L +₹8 120 · Δ −410 Θ +₹3 100 · kept 64%  [Analyse][Exit group] │
│  ☑  S 26700 CE   −2.00  41.20 → 28.15  +₹1 958  +31.7%  Δ −0.21·−32  Θ +₹1 180  IV 11.9  1.2σ ↑  [Exit] │
│  …                                                                                    │
│ [☑] 24 Nov · 27 days · Future · …                                                     │
│ bulk bar (when ≥1 checked off or selected): 3 selected · [Exit selected] [Exit all]    │
├ risk ───────────────────────────────────┬─────────────────────────────────────────────┤
│ Payoff (SVG): now / target / expiry     │ Scenario: Spot ━━●━━  −1.5%  IV ━●━ +0  Days ━●━ +1 │
│ spot, ±1σ, ±2σ, breakevens, hover read  │ P&L at that point + Greeks there              │
│                                         │ Matrix 11 × 3 (spot × IV) or 11 × 4 (spot × days) │
├ hedge ─────────────────────────────────────────────────────────────────────────────────┤
│ Target Δ [0] · Use [Futures ▾ Nov] [ATM option] [Γ then Δ]                              │
│ Before / Change / After table · residual · premium · P&L ±1σ/±2σ · checks · [Show on payoff ☑] [Open ticket] │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
- Book tiles: one row of 6, each `tile()` with a value and one sub-line. Warning line below, wrapping.
- Positions table columns (default order; configurable §9): ☑ · Contract · Lots · Avg → Mark · P&L · P&L % · Δ · Θ ₹/day · Vega ₹ · IV · Distance · DTE (in the group header, not per row) · actions (Exit, ⋯ menu). Γ per row is in the column set but off by default.
- Risk panel: `grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr)`. Payoff height 280 px.

### 4.2 Tablet (820 × 1180)
- Book tiles: 3 × 2 grid. The underlying strip scrolls horizontally inside its own wrapper.
- Table: hide IV, Vega and P&L % (`opt-x`). The Δ cell shows position Δ only. The `⋯` menu holds Analyse group / Exit 50 % / Include.
- Risk panel: one column with a segmented control **Payoff · Scenario**. Payoff 240 px. The matrix fits 3 IV columns at full width.
- Hedge: one column; Before/Change/After table at full width.

### 4.3 Phone (390 × 844)
- Toolbar as today (it already wraps).
- Book: tiles in a 2 × 3 grid: Net P&L (large, spans 2 columns), Δ, Θ, Vega, Γ, Margin. Each sub-line is truncated to one line. The warning line collapses to "⚠ 2 warnings", which expands on tap.
- Positions: **cards**, one per leg, grouped under sticky group headers (expiry · DTE · group P&L; tap to collapse).
  - Line 1: `[S] 26700 CE` · lots `−2` · P&L `+₹1 958` (right-aligned).
  - Line 2 (small, muted): `41.20 → 28.15 · Δ −32 · Θ +₹1 180 · 1.2σ`.
  - Tap the card: an action sheet (Exit… · Exit 50 % · Include in risk ☑ · Analyse this expiry · Open in chain). No swipe gestures this round (LATER).
- Bulk: "Exit all" sits in the panel head. Selection mode is LATER on phone.
- Risk: segmented control Payoff · Scenario. Payoff 200 px tall, full width. Scenario sliders are stacked (label · value · slider). The matrix has 3 IV columns (≈ 330 px at 11 px tabular figures) and fits without scroll. The spot × days view also has 4 columns at 11 px. If the measured width still overflows, the matrix scrolls inside its own wrapper.
- Hedge: collapsed by default to one line, "Hedge: sell 2 lots FUT → Δ +50"; tap to open.

---

## 5. Every number: formula, format and edge cases

Notation:
- `q` = signed `netQty` in units (+ long, − short).
- `L` = the contract's lot size (from `/v1/instruments/{symbol}`; fallback the chain's `lotSize`; fallback 1 with a "lot size unknown" flag).
- `S` = underlying LTP (chain `underlyingLtp`).
- `F_e` = forward of expiry e (`O.forwardPrice(chain_e)`, else the future's LTP for that expiry, else S).
- `T_e` = `O.yearsToExpiry(e)`.
- Per-unit Greeks from the chain: Δ per unit, Γ per point per unit, Θ ₹ per calendar day per unit, Vega ₹ per 1 vol point per unit (server doc in `market/chain.mjs`; verified against the demo: ATM NIFTY 6 DTE Θ ≈ −16.5, vega ≈ 13.0 per unit).
- `fmt`: everything goes through `format.js`. Missing prints `--`.

### 5.1 Book strip (selected underlying, included legs only unless stated)
| Tile | Value | Sub-line | Formula / notes |
|---|---|---|---|
| **Net P&L** | `formatRupee(Σ U_i + Σ R_i, 0)`, gain/loss colour | `Realised ₹x · Unrealised ₹y` | Unrealised `U_i = (mark_i − avg_i) × q_i`. Realised `R_i = realisedPnl` (null → 0, and the tile gets the title "Broker sent no realised P&L"). **Includes excluded legs**: P&L is fact, not a scenario. Closed positions today (netQty 0, realised ≠ 0) count in R |
| **Net Δ** | `formatSigned(Δ_book, 0)` units | `≈ {formatSigned(Δ_book/L_fut,1)} lots · ₹{formatCompact(Δ_book × S)}` | `Δ_book = Σ_opt q·δ + Σ_fut q`. `L_fut` = the near-month future's lot size. ₹ exposure = futures-equivalent notional. Title: "Rupees gained for a 1-point rise = Δ" |
| **Γ** | `formatSigned(Γ_book × S × 0.01, 0)` labelled "Δ per 1%" | `Γ {formatSigned(Γ_book, 2)} per pt` | `Γ_book = Σ q·γ`. Showing Δ-change per 1 % move is readable; the raw per-point value is in the sub-line |
| **Θ / day** | `formatRupee(Θ_book, 0)` signed, gain/loss colour | `{formatPercent(Θ_book / |V_opt|)} of option value` | `Θ_book = Σ q·θ` (₹ per calendar day). `V_opt = Σ q·mark` over options. Over a weekend or holiday the next session's decay is larger. LATER: a holiday calendar |
| **Vega / pt** | `formatRupee(ν_book, 0)` signed | `IV −1 pt → {formatRupee(−ν_book,0)}` | `ν_book = Σ q·vega` |
| **Margin** | `formatCompact(usedMargin)` "used" | `{formatPercent(usedMargin/(usedMargin+availableCash))} of funds` | From `/v1/funds?account=` (account-wide, not per underlying; the title says so). `--` when funds are unavailable |
| (Seller extra, replaces the Net P&L sub-line when the book is a net credit) | | `credit kept {pct} of ₹{credit}` | `credit = −Σ_opt avg·q` (> 0 means received). `cost to close = −Σ_opt mark·q`. `kept = (credit − cost)/credit`. Shown only when credit > 0. Clamped display between −999 % and 100 % |

Edge cases:
- No legs: the strip is hidden.
- All legs unpriced: Greek tiles show `--` with the title "No Greeks: N legs not priced".
- An excluded leg is left out of Δ, Γ, Θ and Vega, and the tile label gains a "(partial)" chip with the title "2 legs excluded".

### 5.2 Groups (default grouping = expiry; futures go into the group of their expiry)
Header: `☑ {date} · {timeToExpiry label} · {structure} · P&L ₹ · Δ · Θ ₹ · kept % · [Analyse] [Exit group]`.
- Structure = `O.detectStructure(legs)` on the group's legs. Recognised: Long/Short call or put, Long/Short straddle, Long/Short strangle, Bull call / Bear call / Bull put / Bear put spread, Iron condor, Iron fly, Call/Put ratio spread (unequal qty), Long/Short future, Covered (future + short call), Protective put (long future + long put), **Conversion** (long future + short CE + long PE, same strike and qty), **Reversal** (the opposite), **Box** (bull call + bear put, same two strikes). Anything else: "Custom · N legs". Detection uses units, not lots.
- Locked structures (conversion, reversal, box) show the line "Locked at expiry: ₹x" = `O.bookPayoffAtExpiry` evaluated at any price, since it is flat; checked at 3 prices and must agree within ₹1. Otherwise the group is not marked locked.

### 5.3 Per-leg columns
| Key | Header | Value | Formula / edge cases |
|---|---|---|---|
| `inc` | ☑ | checkbox | Include in risk (Greeks, payoff, scenario, hedge). Persisted per account+symbol (§9). Not shown when the group has 1 leg on phone |
| `contract` | Contract | `[B/S] 26700 CE` + small `3 Nov · Carry` | Futures: `[B/S] FUT` + `24 Nov · Carry`. Product labels: INTRADAY → "Intraday", MARGIN → "Carry", CNC → "Delivery" |
| `lots` | Lots | `formatSigned(q/L, whole ? 0 : 2)` | Title `{formatInt(q)} qty · lot {L}`. Non-multiple → amber chip `≠ lot` (§7) |
| `px` | Avg → Mark | `41.20 → 28.15` (2 dp) | Mark = mid when both bid and ask > 0 and the spread ≤ 20 % of mid, else LTP. Title shows bid / ask / LTP and the age. Stale (freshness.stale or age > 10 s): the mark is muted with a ⏱ |
| `pnl` | P&L | `formatRupee(U_i, 0)` coloured | per §5.1 |
| `pnlPct` | P&L % | `formatPercent((mark − avg)/avg × sign(q))` | Long: change on premium paid. Short: premium decayed (+ = good). `--` when avg ≤ 0 |
| `delta` | Δ | `formatSigned(q·δ, 0)` with per-unit `δ` small | Futures: `q`, small "1.00" |
| `theta` | Θ ₹/d | `formatRupee(q·θ, 0)` signed | Futures: `--` |
| `vega` | Vega ₹ | `formatRupee(q·vega, 0)` signed | Futures: `--` |
| `gamma` | Γ | `formatSigned(q·γ, 2)` | off by default |
| `iv` | IV | `formatFixed(iv, 1)` | Solved IV shows a small "calc" superscript in the title |
| `dist` | Distance | `{formatFixed(|K−F|/σ_e,1)}σ ↑/↓` | `σ_e = O.sigmaMove(F_e, atmIv_e, T_e)`. Arrow = strike above or below the forward. Title gives the points and %. For **short** options: amber when < 0.5σ ("tested"), red text "ITM" when the short is ITM on the forward. Futures: `--` |
| `act` | — | `Exit` + `⋯` | `⋯` opens a menu: Exit 25/50/75 %, Analyse this expiry, Open in chain, Include/exclude |

Sorting inside a group: futures first, then by strike ascending, CE before PE at the same strike. Sorting is not user-changeable this round.

### 5.4 Pricing model (all in `options.js`)
- `O.priceLeg(leg, ctx, { dS = 0, dIv = 0, days = 0 })` returns the value per unit:
  - option: `black76(F_e·(1+dS), K, max(0, T_e − days/365), max(0.5, iv + dIv), right)`.
  - future: `F_fut·(1+dS)`; `F_fut` = the future's own mark. All forwards move by the same %; the basis is kept proportional.
  - T ≤ 0 → intrinsic on the shifted forward.
- **Calibration**: the model value at (0,0,0) can differ from the mark (stale IV, rounding). Each leg carries `adj = mark − model(0,0,0)`, added to every scenario value. Then the matrix centre cell **equals** the live unrealised P&L, which fixes the "target-date payoff disagrees with P&L" complaint. `adj` is forced to 0 when T after `days` ≤ 0 (expiry value is pure intrinsic).
- `O.scenarioPnl(legs, ctx, shift)` = `Σ q_i × (priceLeg_i(shift) + adj_i − avg_i)` over included legs. This is unrealised P&L at the scenario; the realised part is not added. The matrix header says "Unrealised P&L".
- `O.impliedVol(price, F, K, T, right)`: bisection on `black76` between 0.5 % and 300 %, 60 iterations or a tolerance of 0.005. Returns null when the price < intrinsic − 0.05 or T ≤ 0. Used only for legs with no chain IV.
- `O.legGreeks(leg, ctx)`: the chain Greeks when the leg is in the fetched chain; otherwise analytic Black-76 Greeks from the solved IV, in the same units as the server. Γ, Θ and Vega are added to `options.js` as `black76Greeks(F, K, T, iv, right)`, which returns `{delta, gamma, theta (per calendar day), vega (per vol pt)}` and is tested against the server's computed Greeks to within 2 % on the demo chain.

### 5.5 Payoff panel (SVG, extends `payoffChart`; built once, then paths updated)
- X range: the forward of the **nearest included expiry** ± max(2.6σ, 1.35 × farthest strike distance, 1.5 %).
- Lines:
  1. **Now**: `scenarioPnl(dS=x/F−1, dIv, days=0)`, solid accent.
  2. **Target**: the same with `days = scenario days` and `dIv = scenario IV`. Dashed. Hidden when days = 0 and dIv = 0.
  3. **At expiry** of the nearest expiry: legs of that expiry at intrinsic; later expiries' legs priced by Black-76 at their remaining time. Secondary colour. Legend label "At 3 Nov expiry".
  4. **After hedge** (only while the hedge helper has a proposal and "Show on payoff" is on): the Now line with the hedge legs added, dotted in the tint colour.
- Markers:
  - spot: vertical line with a label;
  - ±1σ and ±2σ bands: shaded, from `O.sigmaBand`, which shared PRD 01 adds; until it lands use `F·e^(±kσ√T)` inline in `options.js`;
  - breakevens of the Now and Target lines: root-finding on the sampled curve with linear interpolation, then one bisection refinement step. Small ticks with values.
- Hover or touch-drag shows a read-out: price, Now P&L, Target P&L, Expiry P&L.
- Y axis: compact ₹, zero line as a hairline. Fill above and below zero only on the expiry line (green/red at 12 % alpha). Calls/puts are not coloured.
- 141 samples plus every strike. Recomputed only when the legs, the scenario or the market sig change.

### 5.6 Scenario panel
Controls (state persisted in session memory only; reset with `0` or "Reset"):
- **Spot**: slider −10 %…+10 %, step 0.25 %, plus chips `−2σ −1σ 0 +1σ +2σ` (σ of the nearest expiry). Read-out: `−1.50 % · 26 016`.
- **IV**: slider −10…+10 vol points (absolute, applied to every leg so the skew is kept), step 0.5, floored per leg at 0.5 %.
- **Days**: slider 0…DTE of the **last** included expiry, step 1 calendar day, plus chips `Today +1 +3 First expiry`. Past a leg's expiry, that leg is at intrinsic.
- Output line: `P&L at scenario ₹x (Δ vs now ₹y) · Δ · Θ · Vega at scenario`. Greeks at the scenario are analytic Black-76.

Matrix (`O.scenarioGrid(legs, ctx, { rows, cols, axis, base })`):
- Rows (spot ladder, setting):
  - `tight`: −5…+5 % step 1, the default;
  - `wide`: −10, −5, −3, −2, −1, 0, +1, +2, +3, +5, +10;
  - `sigma`: −2, −1.5, −1, −0.5, 0, +0.5, +1, +1.5, +2 σ.
  - Each row label shows the % and the price.
- Columns (setting `axis`):
  - `iv`: −5, 0, +5 vol points at the slider's Days, the default;
  - `days`: Today, +1, +3, First expiry at the slider's IV.
- Cell: `formatCompact` ₹ (Indian K/L/Cr), signed. Background tint green/red with alpha ∝ |v|/max|v|, between 0.06 and 0.28. The cell nearest the slider position gets an outline. A cell worse than the **loss limit** setting gets a red hairline border and an `aria-description` "beyond your loss limit".
- Click a cell to set the sliders to that point.
- Below the matrix, three small rows, which every persona reads:
  - `Max loss in grid ₹x at −5 %, +5 IV`;
  - `Max profit at expiry ₹/unlimited`;
  - `Max loss at expiry ₹/unlimited`.
  - The expiry values come from `strategyStats` on the nearest-expiry legs when the book is single-expiry. For multi-expiry books, read "--" with the title "multi-expiry: see the grid".

### 5.7 Hedge helper
Inputs:
- **Target Δ**: number input, default 0, units.
- **Method** (segmented): Futures · ATM option · Γ then Δ.
- Futures: expiry select (futures expiries, §12; default the nearest month whose expiry ≥ the latest short option expiry, which avoids "hedge expires first").
- ATM option: expiry select (option expiries held, default nearest) plus a Buy/Sell toggle:
  - "Buy (adds Γ, Vega; costs Θ)" is the default for hedgers and buyers;
  - "Sell (collects Θ; adds short Γ)".
  - The right is chosen automatically: to reduce Δ, buy PE or sell CE; to raise Δ, buy CE or sell PE.

Maths (`O.hedgePlan(book, method, opts)`, pure):
- Need `n = target − Δ_book` units.
- **Futures**: lots `= round(n / L_fut)` (half away from zero). Hedge Δ = lots × L_fut. Residual = `Δ_book + hedge − target`. Γ, Θ and Vega change by 0.
- **ATM option**: ATM strike of the chosen expiry is `atmRow`. `δ_atm` = that leg's delta for the chosen right. Lots `= round(n / (δ_atm × L × sideSign))`. If `|δ_atm| < 0.05` → error "ATM delta unavailable". Changes = lots × L × sideSign × (δ, γ, θ, vega). Premium = lots × L × mark, shown as debit or credit.
- **Γ then Δ**: option lots `= round(−Γ_book / (γ_atm × L))` (buy ATM straddle-side legs: use the CE when it also moves Δ toward the target, else the PE), then futures for the remaining Δ as above. If |Γ_book| × S × 0.01 < 1 unit, say "Γ already ≈ 0" and fall back to futures.
- Lots = 0 → "Within one lot of target: no hedge needed (residual {x})".

Output:
- A table with rows Δ, Γ (per 1 %), Θ ₹/day and Vega ₹, and columns **Before · Change · After**, plus:
  - lots and contract;
  - residual Δ;
  - premium (₹, debit/credit) or "no premium (futures)";
  - P&L at −2σ / −1σ / +1σ / +2σ before → after (from `scenarioPnl` with the hedge legs at their mark, so the change is 0 at now);
  - notes: "Futures add no Γ, Θ or Vega", and "Hedge expires 3 Nov, before your 24 Nov exposure" when the hedge expiry is earlier than the latest included expiry.
- Preview checks: the proposal is sent to `POST /v1/orders/preview` (debounced 400 ms, only while the panel is open). Every `check` message is shown verbatim. Example in paper: "order value ₹19.9L is above the per-order limit of ₹2L", which blocks the futures hedge. **The page never works around a block**: the Open ticket button is disabled with the message.
- Buttons:
  - **Show on payoff** (checkbox, default on): draws the dotted line.
  - **Open ticket**: `openTicket` pre-filled with symbol, side, units, LIMIT at mid, and product equal to the dominant product of the book (else Carry).
  - Freeze slicing applies on send (§8.3).

### 5.8 Underlying switch strip
`O.bookLegs` on all positions gives the other underlyings with open legs. Each chip reads `BANKNIFTY · 2 legs · +₹1 240`, using the broker `pnl`, since we do not fetch their chains. Clicking a chip sets the toolbar underlying. The strip is hidden when there is no other underlying.

---

## 6. Data flow and refresh
- On load and every 3 s (live), in parallel:
  1. `GET /v1/positions?account=` once, used for all underlyings.
  2. For each **distinct option expiry** held on the selected underlying: `GET /v1/optionchain?underlying=&expiry=&strikes=40&greeks=true`. Use `st.chain` when it is that expiry. Cap: 4 expiries every tick; further expiries refresh every 5th tick (15 s).
  3. `GET /v1/quotes?symbols=` for held futures, the hedge future candidates, and any option leg not found in its chain (one call, comma-joined, ≤ 50 symbols).
  4. `GET /v1/funds?account=` every 5th tick (15 s).
- Lot size and freeze quantity: `GET /v1/instruments/{symbol}` once per symbol per page session, cached in a Map in `positions.js`. Missing → the chain lotSize, then 1, with a flag.
- The expiry select of the toolbar is hidden here, and `st.expiry` is left untouched, so other pages keep their expiry.
- A sequence guard (`st.seq`) drops late responses after the underlying or account changes.
- Partial failure: positions OK but a chain fails → the legs of that expiry are priced from quotes and solved IV. If that also fails they are "Not priced" and listed. The previous good values are kept for up to 30 s, marked stale.

---

## 7. Warnings (one line under the book strip; each is a chip with a title; ordered by severity)
| Id | When | Text |
|---|---|---|
| `unpriced` | any included leg has no mark or no IV | "Not in Greeks: 26900 CE 3 Nov (no quote)" |
| `stt` | long option, ITM on spot, expiring today | "Long 26300 CE ITM expires today: exercise STT ≈ ₹{0.0015 × intrinsic × q}. Exiting may cost less." The rate is `STT_EXERCISE = 0.0015` in options.js, labelled "approx; check current rates" |
| `elm` | short option expiring today | "Expiry day: extra ELM ≈ ₹{0.02 × S × |q|} on shorts" |
| `mis` | any INTRADAY leg and IST time between 14:50 and 15:20 | "Intraday legs square off at 15:20 · {mm:ss}" (countdown, updated by the clock tick). 15:20 is the paper default; the title says "your broker may square off earlier" |
| `lot` | `|q| % L ≠ 0` | "26400 CE: 100 qty is not a multiple of lot 65; exit may need an odd-lot order or hold to expiry" |
| `tested` | short option with distance < 0.5σ or ITM | "Short 26300 PE tested (0.3σ)" / "Short 26300 PE is ITM" |
| `hedge-early` | a long option or future whose expiry is earlier than the latest short expiry, and it reduces Δ | "Hedge 3 Nov expires before 24 Nov shorts" |
| `excluded` | any leg excluded | "2 legs excluded from risk" (click → include all) |
| `stale` | positions or chain freshness stale | "Prices {age} old" |

On phone the line collapses to "⚠ N" with the count. Warnings are never modal.

---

## 8. Interactions

### 8.1 Selection and include
- Row checkbox = include in risk (default on). The group checkbox toggles all its legs (tri-state).
- Selection for bulk exit is separate. Desktop: click the row (not a control) to select it, shift-click for a range, `Space` on the focused row. The bulk bar appears with "N selected · Exit selected · Clear".

### 8.2 Single exit (`openTicket` changes)
`openTicket({ …, exit: true, quote, units, lotSize })`:
- `quote`: a getter for the leg's live quote from its own chain or quotes, so other-expiry exits get prices.
- `units`: when `|q| % L ≠ 0`, the ticket switches to **quantity in units** (sends `quantity`, not `lots`) and shows "odd quantity".
- On exit the default order type is **LIMIT at mid**, rounded to tick toward a fill (buy rounds up, sell rounds down).
- Partial chips in the ticket: 25 % · 50 % · 75 % · 100 %, rounded to whole lots, minimum 1 lot. 100 % = the exact quantity.
- The product is taken from the position.

### 8.3 Exit plan (Exit all / Exit group / Exit selected)
- A modal titled "Exit 4 legs · NIFTY" holds:
  - **Order type** segmented control: Limit at mid (default), Limit at touch (bid to sell, ask to buy), Market. Choosing Market shows "Market orders are sent with protection; illiquid strikes may fill far from mid".
  - **Size**: 100 % (default) · 50 % · 25 %, rounded per leg to whole lots, min 1 lot. Odd quantities at 100 % only.
  - **Order list** in send order: side, qty, contract, price, est. slippage per line.
  - Totals: estimated slippage ₹ = Σ |price − mid| × qty (Market uses the touch as its estimate), and estimated P&L if filled.
- **Send order** (`O.exitPlan(legs, opts)`, pure and tested):
  1. Short options (buy back), largest |Δ| first.
  2. Long options.
  3. Futures, last, because the hedge stays on while options unwind.
- **Freeze slicing**: each order with qty > freezeQty is split into `perLeg = floor(freeze/L) × L` slices, the remainder last. Slices share a `clientOrderId` prefix. The list shows "3 orders (1 800 + 1 800 + 400)".
- **Locked-structure warning**: when a conversion, reversal or box is in scope: "This group is a locked conversion. Exiting leg by leg can break the lock; limit orders at mid are recommended". Market is not pre-selected.
- After sending, `sendOrders` returns `{done, total, failed}`. On a stop, the modal says what is still open, e.g. "Sent 2 of 4. Still open: long 26800 CE, long 26000 PE (hedges only; no naked shorts)". If a short is left open, it says that in red.
- Paper or live follows the account; a live account needs the existing acknowledgement checkbox inside the modal. **No change to server safety.**

### 8.4 Group actions
`[Analyse]` (§8.5) and `[Exit group]` (§8.3, scoped). The `⋯` menu adds "Exit 50 %".

### 8.5 Analyse in builder
- Sends that group's **option** legs to the builder for that expiry, keyed `{underlying}|{expiry}`:
  - leg = `{ right, strike, side, lots: |q|/L, units: |q|, entry: avg, product }`;
  - `legUnits` in options.js honours `units` when present, so 0.5 lot stays 0.5;
  - futures in the group are skipped, with the toast "Futures are not in the builder yet".
- It then sets `st.expiry` to that expiry, saves, and goes to `#/strategy`.
- Calendars (legs over several expiries) stay per group; the multi-expiry builder is LATER.

### 8.6 Keyboard (positions page; inactive while typing or a modal is open)
| Key | Action |
|---|---|
| `j` / `k`, ↓ / ↑ | move the focused row |
| `Space` | select or unselect the row |
| `i` | include or exclude the row in risk |
| `x` | exit the focused leg (ticket) |
| `X` | exit plan for all |
| `a` | analyse the focused row's group |
| `h` | open the hedge helper and focus Target Δ |
| `,` / `.` | spot −/+ 0.5 % |
| `;` / `'` | IV −/+ 1 pt |
| `[` / `]` | days −/+ 1 |
| `0` | reset the scenario |
| `p`, `r` | pause, refresh (as on the chain) |
| `?` | show this list (reuse the `desk-keys` hint row style) |

`bindKeys` currently routes only to the chain (`activeDesk = kind === "chain" ? desk : null`). Generalise it: `activeDesk` = the desk of the current kind, with an `onKey` per kind.

---

## 9. Settings (persisted in desk prefs under `pos`, through `positionsConfig(saved)` exported like `chainConfig` and unit-tested)
| Key | Values | Default |
|---|---|---|
| `cols` | ordered subset of `lots px pnl pnlPct delta theta vega gamma iv dist` | `lots px pnl pnlPct delta theta vega iv dist` |
| `group` | `expiry` · `none` | `expiry` |
| `closed` | show today's closed legs (netQty 0) muted at the bottom of the group | false |
| `ladder` | `tight` · `wide` · `sigma` | `tight` |
| `axis` | `iv` · `days` | `iv` |
| `lossLimit` | ₹ number or null | null |
| `exitType` | `mid` · `touch` · `market` | `mid` |
| `hedge` | `{ method: "fut"|"atm"|"gamma", side: "BUY"|"SELL" }` | `{ method: "fut", side: "BUY" }` |
| `excluded` | `{ [accountId]: string[] }` symbols; pruned when a symbol is no longer open | `{}` |
| `chartSlot` | boolean | false |

Edited from a "Customise" popover in the positions panel head. It reuses the chain's popover pattern: checkbox list with drag/arrow reorder, segmented controls, Reset. Panel order and maximise are handled by `arrangePanels` (`mcb.dashboard.layout.positions`).

---

## 10. States
- **No account** that can place orders: the book is hidden. Positions panel: "Choose an account that can place orders" plus a link to Accounts.
- **Loading** (first fetch): skeleton rows (3 hairline bars) and tiles showing `--`. No spinner overlays.
- **Empty**: "No open NIFTY options or futures on Demo paper account." Then, when other underlyings have legs: "Open elsewhere: BANKNIFTY (2)", as chips. Then "Trade from the Option Chain · Build a strategy". Risk and hedge panels are not rendered.
- **Error** on positions: `alertBox(err)` in the positions panel. The last good book stays visible underneath with "Last updated hh:mm:ss" (stale).
- **Partial**: per §6 and §7 `unpriced`.
- **Paused**: values frozen; the clock shows "Paused".
- **Expired legs** still reported by the broker (T ≤ 0): priced at intrinsic and labelled "Expired · settles at close".

---

## 11. Accessibility
- Tables keep `th scope="col"`. Group headers are `th scope="rowgroup"`. Cards on phone are `role="list"`/`listitem`, each with an `aria-label` like "Short 2 lots 26700 CE 3 Nov, P&L plus 1958 rupees".
- Numbers are tabular. Sign is never shown by colour alone: there is always a + or −.
- The matrix is a `table` with row and column headers. The active cell has `aria-current="true"`.
- The sliders are native `input type=range` with `aria-valuetext` ("minus 1.5 percent, 26016").
- The payoff SVG has a `role="img"` with a summary `aria-label`: "Payoff now: breakevens 25 980 and 26 850; max loss in range −₹42K". The hover read-out is mirrored in a polite live region on keyboard focus.
- Warnings live region: polite; only new warnings are announced.
- Focus is kept across refreshes (existing `keepFocus`). Rows are patched, not rebuilt (§13).
- `prefers-reduced-motion`: no flash animation on P&L changes.

---

## 12. Data and API (no server change this round)
| Need | Endpoint | Notes |
|---|---|---|
| Positions | `GET /v1/positions?account=` | Position schema: symbol, product, netQty, avgPrice, ltp, pnl, realisedPnl, unrealisedPnl, charges |
| Chains per expiry | `GET /v1/optionchain?…&strikes=40&greeks=true` | Greeks units per `market/chain.mjs` |
| Futures + unpriced legs | `GET /v1/quotes?symbols=` | verified: `NFO:NIFTY-2026-11-24-FUT` returns ltp/bid/ask |
| Futures expiries | `GET /v1/expiries` gives option expiries. Candidate monthly futures = the **last option expiry in each calendar month** (`O.monthlyExpiries`), validated by `GET /v1/instruments/{sym}` (404 → skip) | `NFO:NIFTY-2026-11-24-FUT` resolves in the demo |
| Lot size, freeze qty, tick | `GET /v1/instruments/{symbol}` | returns lotSize, tickSize, freezeQty |
| Funds | `GET /v1/funds?account=` | usedMargin, availableCash |
| Order checks | `POST /v1/orders/preview` | exit and hedge proposals; show checks verbatim |
| Orders | `POST /v1/orders` | `quantity` for units, `lots` for whole lots; products `INTRADAY` / `MARGIN` / `CNC` |

Known limits, shown to the user and not hidden:
- There is no margin calculator: `/api/v1/margin` is "not available yet". The hedge and exit views therefore show **no margin change**, and say "Margin effect: shown by your broker on the order".
- The paper per-order value limit (₹2L) blocks a 1-lot index future. The preview check is displayed.

LATER server additions, not this round:
- `POST /v1/margin/basket` (SPAN + exposure for a list of legs, including hedge benefit);
- `GET /v1/futures?underlying=` (futures expiries);
- realised P&L by day for Day P&L.

---

## 13. Performance
- Build the DOM once per (account, underlying, group set, column set). Each tick patches cells by signature (the same `__sig` pattern as `createChain`). A new or closed leg adds or removes only its row or card.
- Maths per tick for 20 legs:
  - matrix 11 × 4 = 44 scenarios × 20 legs = 880 `black76` calls;
  - payoff 3 lines × ~150 points × 20 = 9 000 calls;
  - the total stays below 4 ms on desktop.
- Payoff and matrix are recomputed only when legs/marks/IVs change by more than 0.01 or the scenario changes. Slider input is throttled to one rAF.
- Network per tick: 1 positions call, k chain calls (≤ 4), 1 quotes call. Funds and further expiries every 15 s. Instruments cached for the session.
- No timers when paused or when the page leaves (reuse `every`/`stopTimer`).

---

## 14. Test plan

### 14.1 Unit tests (`options.test.mjs`, pure)
1. `bookLegs`:
   - keeps CE/PE/FUT of the underlying;
   - skips netQty 0 unless `closed`;
   - rejects other underlyings (NIFTY vs NIFTYNXT50, BANKNIFTY vs NIFTY);
   - parses `BFO:SENSEX-…`.
2. `parseFutureSymbol`: valid and invalid strings.
3. `impliedVol`:
   - round-trips `black76` for CE and PE at 5 %, 12 %, 60 % IV and T of 1 day and 30 days, within 0.01 vol;
   - returns null below intrinsic.
4. `black76Greeks`:
   - put-call delta parity (δc − δp = 1 on the forward);
   - gamma and vega equal for CE and PE;
   - theta is negative for long options;
   - within 2 % of the server-computed demo Greeks for an ATM leg (fixture).
5. `bookGreeks`:
   - futures Δ = q;
   - excluded legs are left out;
   - legs of two expiries sum;
   - an unpriced leg is reported in `missing`.
6. `scenarioPnl`:
   - (0,0,0) equals the unrealised P&L from the marks exactly (calibration);
   - expiry days → equals `payoffAt` for a single-expiry book;
   - a long future is linear in dS;
   - IV +5 raises long-option value;
   - legs past expiry are at intrinsic.
7. `scenarioGrid`: shape, labels, and the max-loss cell.
8. `hedgePlan`:
   - futures rounding (−1 310 with L 65 → +20 lots, residual −10);
   - half rounds away from zero;
   - "within one lot" → 0 lots;
   - ATM sign logic (reduce Δ with a buy → PE; with a sell → CE);
   - Γ-then-Δ zeroes Γ within one lot and Δ within one futures lot;
   - |δ_atm| < 0.05 → error.
9. `exitPlan`:
   - order is shorts (largest |Δ| first), then longs, then futures;
   - freeze slicing 4 000 units with freeze 1 800 and L 75 → 1 800, 1 800, 400;
   - partial 50 % of 3 lots → 2 lots (rounding rule: round half up, min 1);
   - prices at mid, touch, market;
   - slippage sum.
10. `detectStructure`: each recognised name, including conversion, reversal, box and custom.
11. `monthlyExpiries`: the last option expiry per month.
12. `legUnits` honours `units`.
13. `positionsConfig`: defaults, unknown keys dropped, bad values replaced.

Also, `format.test.mjs` includes `positions.js` (no `toFixed` etc.).

### 14.2 Playwright (copy `desk.cjs`, place paper orders first through the API)
Seed books through `POST /v1/orders` on `demo-paper` (reset first with `POST /v1/paper/accounts/demo-paper/reset`):
- (a) short iron condor on the nearest NIFTY expiry;
- (b) (a) plus a long PE on the next expiry;
- (c) a long ITM CE only.
Futures cannot be seeded on paper because of the ₹2L per-order limit. Cover futures with a unit fixture.

Screenshots: `#/positions` at 390×844, 820×1180, 1440×900 × light/dark for books (a) and (b). Hedge helper open on desktop and phone. Exit plan modal on phone. Scenario tab on phone. Look at each one.

Checks in the script:
- `document.documentElement.scrollWidth <= innerWidth`;
- every visible button is ≥ 44 px high under `hasTouch`;
- book (b) Net Δ equals the sum of the row Δ cells;
- the Exit all modal lists BUY orders before SELL orders;
- no console errors.

### 14.3 Gates
`npx vitest run server/bridge/dashboard`, the full `npx vitest run`, and `npm run -s check:mjs`. All pass.

---

## 15. Priorities

### MUST (this round)
1. `options.js` book maths with tests:
   - `bookLegs` (options + futures, all expiries), `parseFutureSymbol`;
   - `impliedVol`, `black76Greeks`;
   - `priceLeg` / `scenarioPnl` with calibration, `bookGreeks`, `scenarioGrid`;
   - `hedgePlan` (futures, ATM option, Γ then Δ), `exitPlan` (ordering, slicing, partial, prices, slippage);
   - `detectStructure`, `monthlyExpiries`;
   - `legUnits` honouring `units`, `positionsConfig`.
2. Data layer: multi-expiry chain fetch, quotes fallback, instruments cache (lot, freeze, tick), funds, sequence guard, stale handling (§6).
3. Book strip with 6 tiles, the seller "credit kept" line and the warnings line (§5.1, §7).
4. Positions grouped by expiry (structure name, group P&L/Δ/Θ/kept, Analyse, Exit group). Per-leg columns §5.3 with include checkbox, patched in place. Phone cards with an action sheet.
5. Payoff SVG: Now / Target / At-expiry lines, spot, ±1σ/±2σ, breakevens, hover read-out, hedge overlay.
6. Scenario panel: three sliders with chips, an output line, an 11-row matrix with an IV or days axis, a loss-limit highlight, and click-to-set.
7. Hedge helper: three methods, Before/Change/After, residual, premium, ±σ P&L, preview checks shown verbatim, Show on payoff, Open ticket.
8. Exit: ticket with LIMIT at mid, partial chips and the `quote`/`units` options. The exit plan modal (mid/touch/market, size %, order list, slippage, slicing, locked warning, post-send state). Bulk selection on desktop and tablet.
9. Analyse with exact units and the product.
10. Underlying switch strip. Empty / loading / error / partial / paused states.
11. Keyboard map (§8.6) via a generalised `bindKeys`, plus the `?` help row.
12. Settings popover with `positionsConfig` persisted. Panels `book`, `positions`, `risk`, `hedge`, `chartslot` (placeholder, off by default).
13. Responsive layouts §4 at 390/820/1440, light and dark; tests §14.

### LATER
- Margin-aware views (basket SPAN + exposure, return on margin, margin change of a hedge or exit, expiry-day calendar-benefit loss) once a margin endpoint exists.
- Day P&L (needs overnight quantity or broker day P&L).
- Beta-weighted Δ across underlyings, a cross-underlying book, and futures-equivalent exposure against SEBI limits.
- User-named strategy groups and tags. Strategy grouping inside one expiry.
- A multi-expiry builder (calendars/diagonals) and futures in the builder. Roll actions (same strikes next expiry, strike up/down, add wings) as pre-filled baskets.
- Alerts and conditional exits (on combined P&L, spot level, or % of max profit) through `/v1/hooks`/notify.
- Swipe actions and selection mode on phone. A scenario bottom sheet.
- An exchange holiday calendar for Θ and DTE; weekend-decay warning.
- Charges per exit (statutory + brokerage), with configurable STT rates in settings.
- An atomic basket exit for locked structures.
- Price/time chart of book P&L and spot (in the owner's chart engine slot).
- Probability panels (POP for multi-expiry books, probability of touching the short strikes).

---

## 16. Out of scope
- Any chart library, or a price or time-series chart. The `chartslot` panel is a labelled placeholder only. The purpose-built payoff SVG and the matrix are in scope.
- Changing server safety: per-order limits, live acknowledgements, kill switch, freeze rules.
- Live auto-hedging or any automatic order without a click.
- Holdings, equity and commodity positions on this page.
- New server endpoints (margin, futures list) this round.

---

## 17. Suggested build split (three agents in parallel, minimal file overlap)
- **Agent A: maths** (`options.js`, `options.test.mjs`). MUST item 1, delivered first as an exported API with JSDoc. Signatures to agree up front:
  - `bookLegs(positions, underlying, { closed })` → `[{symbol, kind, underlying, expiry, strike, right, q, avg, product, realised}]`;
  - `priceLeg(leg, mkt, shift)` and `scenarioPnl(legs, mkts, shift)`, where `mkts[expiry] = { F, T, legs: Map(symbol → {mark, iv, greeks}) }` and `mkts.fut[symbol] = { mark }`;
  - `bookGreeks(legs, mkts)`;
  - `scenarioGrid(legs, mkts, { ladder, axis, days, dIv, sigma })`;
  - `hedgePlan(book, { method, target, side, fut, atm })`;
  - `exitPlan(legs, { type, pct, freeze, lot, tick, quotes })`;
  - `detectStructure(legs)`, `impliedVol`, `black76Greeks`, `monthlyExpiries`, `parseFutureSymbol`.
- **Agent B: page UI** (new `positions.js`, `app.css` 12e, the DASHBOARD_FILES and format.test entries, the `desk.js` wiring for panels and bindKeys). MUST items 2, 3, 4, 10, 11, 12, 13: book strip, groups, rows and cards, states, settings, keyboard, responsive.
- **Agent C: risk and actions** (payoff, scenario and hedge components exported from `positions.js` in their own section, plus the `desk.js` `openTicket` options, the exit plan modal and Analyse). MUST items 5, 6, 7, 8, 9, then the Playwright screenshots §14.2.
- Merge order: A, then B and C (C stubs A's functions until they land). The final full test gate and screenshot review is done together.
