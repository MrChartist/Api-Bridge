# PRD 06: Arbitrage and Parity Scanner, page `#/arb`

Status: ready to build · Owner: Options desk · Round 1
Files:
- `server/bridge/dashboard/options.js` (+ `options.test.mjs`): pure maths in two new sections, `// ── Charges ──` and `// ── Arbitrage ──` (§6, §7).
- New `server/bridge/dashboard/arbitrage.js`: the page UI (figures strip, the scanner with three tabs, the detail pane/sheet, risk notes, chart slot). It exports `arbPanels(ctx)`. desk.js keeps only the wiring.
- `server/bridge/dashboard/desk.js`: a new kind `"arb"` in `renderDesk`. It adds a futures fetch to the refresh tick for this kind, exports `renderArbPage`, hands `sendOrders`/`openTicket`/`st` to `arbPanels`, and sets `activeDesk` for the keyboard (§11).
- `server/bridge/dashboard/views.js`: a PAGES entry (§3). `app.js`: a new `scale` icon in `ICONS`.
- `server/bridge/dashboard/app.css`: new section `12f · ARBITRAGE`. 12d and 12e are reserved by PRD 02 and PRD 04; take the next free letter if they have moved.
- `server/bridge/core/app.mjs` (`DASHBOARD_FILES`) and `format.test.mjs` (file list): add `arbitrage.js`.
- **No server change this round.** Existing endpoints cover everything; see §14 for the checks against the running demo.

### Shared with PRD 02 (Strategy Builder): one charges model, never two
PRD 02 §6.10 specifies `O.charges(legs, rates)` and `O.CHARGE_RATES`. This PRD defines the canonical, richer version (§6).
- If PRD 02's version has already landed, **extend it in place**.
- If it has not, build §6 and let PRD 02 call it: `O.charges(legs, rates)` = the sum of `O.orderCharges` per leg.
- There is exactly one rate table in the codebase.

---

## 0. The idea in one paragraph

Every Indian retail tool shows LTP or mid "synthetic futures" and ignores costs. This page shows only what is **executable at the touch**, priced through the bid and ask, **after every statutory charge and brokerage**, and **after the cost of money** at the user's hurdle rate. It covers three families of structure:
- per-strike put-call parity: conversion and reversal against the same-expiry future;
- box spreads, as lending or borrowing rates;
- the futures term structure: basis, carry, calendar and roll cost.

Each result says how big it is in ₹ for the user's lot count, as an annualised %, and how much capital it ties up. It also states plainly why the edge may not be real: legging, staleness, exercise STT, MTM on the future, and expiry-day margin. It is honest by default: when an edge is not executable, the row says so; the page never hides a cost to make a number look good.

---

## 1. Goals per persona

| Persona | Job on this page | Numbers they decide on | Mistakes the page must prevent |
|---|---|---|---|
| **Arbitrageur** (main user) | Rank strikes by net executable conversion and reversal edge. Find boxes that beat the hurdle. Size the trade and send the legs in a safe order | Net ₹ for N lots after charges and financing; net %/yr on capital; gross points and break-even points; liquidity (spread %, OI) and max lots at the touch from depth; quote age; freeze slices | Using LTP or mid. Phantom edges from stale or mismatched timestamps. Forgetting exercise STT on long ITM legs held to expiry. Pairing an option with a future of another expiry (weekly options have no future). Partial fills leaving a naked leg. Ignoring the freeze quantity and the Bridge's per-order limit |
| **Lender / borrower** (buyer or seller parking cash) | Compare a long box with an FD or T-bill. See whether a short box is cheap money | Box lending rate and borrowing rate %/yr net of charges, against the hurdle in bp. Capital blocked. Limit debit for a target rate | Thinking a short box is cheap leverage. In India it blocks margin about equal to its width (the opposite of the Robinhood 2019 story). Using a box rate on expiry day |
| **Hedger** (futures or portfolio) | Choose between a future and a synthetic, and when and at what cost to roll | Basis, carry %/yr for each future, options-implied forward per month, futures rich or cheap against the synthetic, calendar spread against fair value, roll cost ₹/lot for a long and a short | Rolling at a bad calendar spread. Comparing hedge costs without charges (futures STT 0.05% on sell against option legs). A synthetic on a weekly expiry that has no matching future |
| **Seller / buyer** (premium trader) | Check whether the side they are about to trade is rich or cheap against parity | Per-strike deviation in points and bp against the future (or the chain forward), with a "Calls rich" / "Puts rich" tag only when the deviation is **outside** the bid-ask band. The true ATM from the forward, not spot | Calling a side "rich" when the gap is inside the spread. Measuring moneyness against spot on weekly expiries |

Success this round:
1. On NIFTY 24 Nov (the demo monthly), the Parity tab shows conversion and reversal net ₹ per strike. A user can tell which strike is best, why, and what it costs, in **under 5 seconds** on desktop and phone.
2. Every ₹ figure on the page can be traced in the detail pane to a leg-level waterfall whose lines add up exactly.
3. On a weekly expiry, conversions and reversals are **not shown as futures arbitrage**. The page says "No listed future for 3 Nov" and offers the monthly expiry and the Boxes tab.
4. The page is 390 / 820 / 1440 wide, light and dark, with no horizontal page scroll. Tables scroll inside their own wrapper. Touch targets are 44 px on coarse pointers.
5. One refresh tick costs 6 ms or less of main-thread time on desktop for 81 strikes. That covers the parity rows plus up to 400 box pairs.

---

## 2. Current implementation: keep, change, add, remove

Sources read:
- desk.js: `renderDesk`, toolbar, `loadChain`, refresh, `sendOrders`, `openTicket`, `context()`, the panel return per kind.
- options.js: `mid`, `spreadPct`, `liquidityScore`, `volumeRanks`, `timeToExpiry`, `yearsToExpiry`, `forwardPrice`, `touchPrice`, `roundToTick`.
- views.js: PAGES, `arrangePanels`, `segmented`.
- app.css: 12b and 12c.

### Keep
- The shared desk toolbar: underlying, expiry, account, live/paused and clock. Also shared state in `mcb.dashboard.desk` and the 3 s refresh (`REFRESH_MS`).
- `GET /v1/optionchain` with `FETCH_STRIKES = 40` (81 strikes). It is the only option data source.
- Movable panels (`arrangePanels`, `data-panel`, `data-fixed` on the toolbar).
- `O.mid`, `O.spreadPct`, `O.liquidityScore`, `O.volumeRanks`, `O.timeToExpiry`, `O.touchPrice`, `O.roundToTick`: reused as they are.
- `O.forwardPrice` **stays unchanged** (the chain and the strategy pages use it). This page uses the new `O.impliedForward` (§7.2).
- `sendOrders`: sequential, stops at the first refusal. `openTicket` for single legs. **Safety gates are untouched**: every order is previewed and then placed through `/v1/orders`; paper by default; live needs the existing acknowledgements; the per-order value limit is respected and never bypassed.

### Change
| # | What | From | To |
|---|---|---|---|
| C1 | `renderDesk(kind)` | kinds chain / strategy / oi / positions | Adds `"arb"`. For it, the strikes segmented control, the column preset and Customise are not built, and the tick also fetches futures quotes (§13.2) |
| C2 | Desk keyboard | `activeDesk` only on the chain | Also on `arb`, with its own `onKey` (§11) |
| C3 | `sendOrders` | inner function | Passed to `arbPanels` through `ctx`, unchanged in behaviour |

### Add (MUST; details below)
- The page.
- The charges model with broker profiles and editable statutory rates.
- Parity per strike with conversion and reversal, after charges and financing.
- The implied forward and the options-implied rate.
- Ranked boxes (lend and borrow) with a target-rate limit calculator.
- The futures term: basis, carry, calendar, roll cost, futures against synthetic.
- The detail pane: leg list, depth, waterfall, break-even, capital, risk flags, copy legs, preview and place.
- The risk notes panel.
- The chart engine slot.
- Settings: costs, hurdle, filters, column chooser.
- Keyboard. Phone cards and a bottom sheet.

### Remove
Nothing on other pages. On this page the following do not appear:
- the chain's strikes segmented control (±8/±12/±20);
- the column preset and Customise (the page has its own settings);
- the OI/Greeks presets.

---

## 3. Navigation and information architecture

PAGES entry, placed between `oi` and `positions`:
```js
{ id: "arb", label: "Arbitrage", icon: "scale", tint: "indigo", group: "Options", layout: "desk",
  title: "Arbitrage scanner", sub: "Parity, boxes and futures basis at executable prices, after charges", render: renderArbPage }
```
- `scale` icon: a balance, 24×24 stroke, matching the set: `<path d="M12 4v16M5 20h14M4 8h16"/><path d="m4 8-2.5 6h5zM20 8l-2.5 6h5z"/>`.

Top-level panels (each `section.desk-panel`, movable, in this default order):
1. `desk-top` (`data-fixed`): the shared toolbar.
2. `arb-figures` (`data-panel="figures"`): the figures strip (§5.1).
3. `arb-scan` (`data-panel="scanner"`): the panel head plus the tab body. On desktop and tablet it is laid out beside the detail pane (§4).
4. `arb-notes` (`data-panel="risk-notes"`): risk notes (§9).
5. `arb-chart` (`data-panel="chart-slot"`): the **Chart engine slot** placeholder (§5.6).

The detail pane belongs to `arb-scan` (a grid column inside it), not a separate panel, so that moving panels never separates a list from its detail.

---

## 4. Layout per device

Content width = viewport − sidebar (264 px at ≥ 1024) − gutters.

### 4.1 Desktop (1440×900, content ≈ 1120)
- Figures strip: 6 tiles in one row (`desk-stats` grid).
- Scanner panel head, in one line:
  - left: the tab segmented control `Parity · Boxes · Futures`;
  - right: Lots stepper `− 1 +`, Hold segmented `Expiry · Close`, an "Opportunities only" switch, and a gear "Costs & filters".
- Body: a CSS grid `minmax(0,1fr) 360px`.
  - Left: the table, sticky header, `max-height: calc(100vh − 260px)`, scrolling inside.
  - Right: the detail pane, sticky at the top of the panel, with its own scroll.
  - With nothing selected, the pane shows the **best opportunity** of the current tab, so the column is never empty.
- Parity columns (default; the chooser can change them, §10.3):
  `Strike | Call bid·ask | Put bid·ask | Synthetic sell·buy | Dev | Conversion | Reversal | Net %/yr | Liq`
  - Two-line cells: main figure plus a small sub-line.
  - Width ≈ 760 px fits beside the 360 px pane without inner scroll.
- Risk notes and chart slot: side by side (`grid 1fr 1fr`) below the scanner.

### 4.2 Tablet (820×1180 portrait, content ≈ 780; 1180×820 landscape uses the desktop rules)
- Figures: 3×2 tiles.
- Panel head wraps to two lines: tabs on line 1; lots, hold, switch and gear on line 2.
- Body: two panes, `minmax(0,1fr) 320px`.
  - The table uses a **compact column set**: `Strike | Dev | Conversion | Reversal | Net %/yr | Liq` (Parity), with bid/ask moved to the pane.
  - The pane is the detail of the selected row.
- Risk notes and chart slot are stacked.

### 4.3 Phone (390×844, content ≈ 358)
- Figures: 2 columns × 3 rows. Values 17 px, subs 11.5 px.
- Panel head:
  - line 1: tabs (full width);
  - line 2: lots stepper plus a **"Filters" button** that opens a bottom sheet with hold, opportunities only, minimum net and minimum liquidity. The gear moves into that sheet.
  - The head is `position: sticky; top: 0` inside the panel, so the filters stay reachable while scrolling.
- The table becomes **a list of cards**: one 56 px row per item, hairline-separated, not boxed.
  - Parity: `26400 · Reversal` on the left. On the right, the net ₹ in bold plus a sub-line "18.2%/yr".
  - Line 2: `Syn 26628.3 · Dev +1.2 · ●●●○○`.
  - Sorting: by net ₹ descending when "Opportunities only" is on; otherwise by strike, with the ATM card scrolled into view.
- Tapping a card opens the detail as a **bottom sheet** (`dialog` with the sheet class used by the chain action sheet; max-height 88vh; drag handle; Esc or a backdrop tap closes it). It has the same content as the pane.
- Risk notes default to **collapsed** to 1 line ("7 risk notes · tap to read"). The chart slot is 160 px.

### 4.4 Light and dark
- Tokens only. Opportunity rows use the blue `--ios-blue` wash at 0.08 alpha (0.14 in dark) plus a 2 px inset left bar. This is not green: an edge is not yet P&L.
- Net ₹ figures are formatted with `formatSigned`. A negative net is muted grey text (not red): a negative net is "no trade", not a loss.
- Stale rows are 55% opacity with an orange `Stale` tag.

---

## 5. What is on screen

Notation:
- K is the strike.
- C and P are the CE and PE legs; b/a are bid/ask.
- F is the same-expiry future (Fb, Fa, Fm = mid).
- S is `chain.underlyingLtp`.
- u is units per lot (`chain.lotSize`); N is the lots setting; U = u·N.
- d is calendar days to 15:30 IST expiry (`O.timeToExpiry(expiry).days`, fractional), and T = d/365.
- h is the hurdle rate (decimal), and g = e^{h·T} is the carry factor.

**All annualisation is simple, ACT/365.** The help text says so.

"Two-sided" = bid > 0 and ask ≥ bid. Every formula below needs every leg it uses to be two-sided; otherwise the result is `null`, which displays `--`, **never 0**.

### 5.1 Figures strip (6 tiles; patched in place, not rebuilt)
| Tile | Value | Sub-line | Formula / rule | Edge cases |
|---|---|---|---|---|
| Spot | `formatFixed(S, 2)` | `Index · not tradable` | S | null → `--` |
| Future | `Fb – Fa` (formatFixed 2, en dash) | `24 Nov · 26 d · spread 5.30` | same-expiry FUT quote | No same-expiry future → value `No listed future`, sub `Nearest: 24 Nov`. The tile title explains weekly expiries |
| Implied forward | `formatFixed(Fimp, 2)` | `band 26626.2 – 26630.2 · 9 strikes` | `O.impliedForward` (§7.2) | fewer than 2 two-sided strikes → `--`, sub "Parity unreadable (one-sided quotes)" |
| Carry | `formatPercent(carryF, 2)` + `/yr` | `options 6.42% · hurdle 6.00%` | carryF = (Fm/S − 1)·365/d. "options" = `O.optionsImpliedRate` (§7.3) | no future → value = options rate, sub "from options · hurdle 6.00%". d < 1 → `--` with title "Annualised figures are not meaningful on expiry day" |
| Best conv/rev | `formatSigned(net, 0)` with ₹ prefix | `Reversal 26400 · 18.2%/yr` | the maximum net among non-stale, liquidity ≥ min parity rows | none positive → value = the best (negative) one, muted, sub "Closest: …". No future → `--`, sub "Needs a same-expiry future" |
| Best box | `formatPercent(rate, 2)/yr` | `Lend 26400/26500 · +412 bp vs hurdle` | the highest net long-box lending rate among eligible boxes | none → `--` |

- Tiles that hold a "best" are buttons: activating one selects that row on its tab.
- Tile values update at most once per tick. The aria-live region (§12) announces only when the identity of the best changes.

### 5.2 Parity tab (one row per strike in ATM ± `window` strikes; default 10)

Reference R:
- When a same-expiry future exists: Rb = Fb, Ra = Fa, Rm = Fm, and the header says "vs future".
- Otherwise: Rb = Ra = Rm = Fimp; the header says "vs implied fwd"; the Conversion and Reversal columns are **hidden**; and an inline note above the table reads: "No listed future for 3 Nov. Deviations are relative to the chain's implied forward: they show which strikes are out of line, not a futures arbitrage. Pick a monthly expiry for conversions and reversals."

| Column | Main | Sub | Formula | Format | Edge cases |
|---|---|---|---|---|---|
| Strike | K | ATM tag on the strike nearest Fimp (not spot) | | formatInt | |
| Call bid·ask | `Cb · Ca` | spread % | `O.spreadPct` | formatFixed 2; sub formatPercent 1 | one-sided → the side shows `--` |
| Put bid·ask | `Pb · Pa` | spread % | same | same | same |
| Synthetic sell·buy | `SynS · SynB` | mid SynM | SynB = K + (Ca − Pb)·g; SynS = K + (Cb − Pa)·g; SynM = K + (mid C − mid P)·g | formatFixed 1 | any leg one-sided → `--` |
| Dev | SynM − Rm in pts | bp = (SynM − Rm)/Rm·1e4 | Tag "Calls rich" when SynS > Ra (calls overpriced even after the spread); "Puts rich" when SynB < Rb. Otherwise no tag ("inside spread") | formatSigned 1; sub formatSigned 0 + " bp" | R null → `--` |
| Conversion | NetConv ₹ for U | gross pts | §7.4 | formatSigned 0 with ₹; sub formatSigned 2 + " pts" | not executable → `--` |
| Reversal | NetRev ₹ for U | gross pts | §7.4 | same | same |
| Net %/yr | the better positive of (conv, rev) annualised on capital | "conv" / "rev" | §7.6 | formatPercent 1 | neither positive, or d < 1 → `--` |
| Liq | 5 dots, filled = score | | min over the structure's option legs of `O.liquidityScore` (the future is assumed liquid) | `●●●○○`; `aria-label="Liquidity 3 of 5"` | dead leg → 0, red-ink "No quote" |

Rows and sorting:
- Opportunity row = the best net ≥ `minNet` (default ₹0), liquidity ≥ `minLiq` (default 2), and not stale.
- Sortable columns: Strike (default ascending), Dev (|value|), Conversion, Reversal, Net %/yr. Activating a header cycles descending, ascending, default. Sort state is persisted.
- "Opportunities only" filters to opportunity rows. When none qualify, it shows the empty state (§12).

### 5.3 Boxes tab (ranked list; matrix is LATER)

Pairs:
- Strike pairs K1 < K2, both within ATM ± `window`, with width ≤ `boxMaxSteps` strike steps (default 10).
- All four legs two-sided.
- That is at most about 210 pairs for window 10.

Mode segmented in the table head: `Lend (long box) · Borrow (short box)`; default Lend; persisted.

Long box, with W = K2 − K1:
- debit D = (C1a − C2b) + (P2a − P1b);
- pays W at expiry.

Short box:
- credit Cr = (C1b − C2a) + (P2b − P1a);
- owes W at expiry.

| Column | Main | Sub | Formula (§7.5) | Format |
|---|---|---|---|---|
| Strikes | `26400 / 26500` | width `100 pts` | | formatInt |
| Debit (Lend) / Credit (Borrow) | D or Cr per unit | ₹ for U | | formatFixed 2; sub formatRupee 0 |
| Charges | ₹ for U, all-in for the hold mode | in pts | §6 | formatRupee 0 |
| Locked ₹ | Lend: W·U − D·U − charges. Borrow: Cr·U − W·U − charges (a negative number: the interest you pay) | | | formatSigned 0 |
| Rate %/yr | Lend: net lending rate rL. Borrow: net borrowing rate rB | | rL = ((W·U − X)/(D·U + Cin) − 1)·365/d; rB = ((W·U + X)/(Cr·U − Cin) − 1)·365/d. Cin = entry charges; X = expiry or exit costs for the hold mode | formatPercent 2 |
| vs hurdle | Lend: (rL − h)·1e4 bp. Borrow: (h − rB)·1e4 bp (positive = cheaper than your hurdle) | | | formatSigned 0 + " bp" |
| Capital | Lend: D·U + Cin. Borrow ≈ W·U (approximate margin; title "SPAN plus exposure on a short box is close to its width; verify with your broker") | | | formatRupee 0 (≥ 1 L uses ₹ + formatCompact) |
| Liq | min of the four legs' scores | | | dots |

- Default sort: "vs hurdle" descending.
- Opportunity: vs hurdle ≥ `minBoxBp` (default 0), liquidity ≥ `minLiq`, not stale, d ≥ 1.
- Boxes with Cr − Cin ≤ 0 (borrow) or D ≤ 0 (lend) are invalid arbitrage quotes (free money or crossed quotes). They show with a red-ink "Crossed quotes" tag, are excluded from Best, and carry the title "Almost certainly a stale or bad quote".

### 5.4 Futures tab (ignores the expiry picker; lists every listed future of the underlying)

Futures rows, one per FUT expiry, nearest first. The row matching the selected expiry is highlighted.

| Column | Main | Sub | Formula | Format |
|---|---|---|---|---|
| Expiry | `24 Nov` | `26 d · Monthly` | | |
| Bid · Ask | `Fb · Fa` | spread | | formatFixed 2 |
| Basis | Fm − S pts | % = (Fm/S − 1)·100 | | formatSigned 2; sub formatPercent 2 |
| Carry %/yr | (Fm/S − 1)·365/d | vs hurdle bp | | formatPercent 2; sub formatSigned 0 + " bp" |
| Options fwd | Fimp for that expiry (§7.2) | Fm − Fimp pts: "Fut rich" if Fb > SynS_atm, "Fut cheap" if Fa < SynB_atm, else blank | needs that expiry's chain (§13.2) | formatFixed 2 |
| Cheaper long | `Future` or `Synthetic` | "by 2.4 pts · ₹180/lot" | §7.8 | |
| Cheaper short | same | same | §7.8 | |

Calendar rows sit between consecutive futures (indented, smaller, with the label `Nov → Dec`):

| Column | Value | Formula |
|---|---|---|
| Spread | buy-far exec `F2a − F1b`, sell-far exec `F2b − F1a` | formatFixed 2 |
| Fwd rate %/yr | (F2m/F1m − 1)·365/(d2 − d1) | formatPercent 2 |
| Fair spread | F1m·(e^{h·(d2−d1)/365} − 1) at the hurdle; sub: (spread mid − fair) pts, "rich" / "cheap" | formatFixed 2 |
| Roll long ₹/lot | (F2a − F1b)·u + charges(sell near at F1b, buy far at F2a) | formatRupee 0 |
| Roll short ₹/lot | (F1a − F2b)·u + charges(buy near at F1a, sell far at F2b), shown as the cost to roll a short | formatRupee 0 |

- "Roll ₹/lot" is the cash spread paid plus charges. The title explains that the spread itself is carry you pay or receive by holding the later contract; the comparison that matters is against the fair spread.
- Cash-and-carry against the index is **not offered**: the index is not tradable. The note says "Cash-and-carry needs a tradable underlying (stock or ETF): LATER".

### 5.5 Detail pane / sheet (any row on any tab)

Header:
- `Reversal · NIFTY 24 Nov 26400 · 2 lots`, with a type pill (`Conversion`, `Reversal`, `Long box`, `Short box`, `Calendar`, `Futures basis`).
- Hold mode note: "Held to expiry (cash-settled)" or "Closed before expiry at today's spreads".

1. **Legs** (table): Side tag (B/S), Contract, Price (the touch used), Qty (units), Top qty (depth, §13.3), Slices.
   - Slices = ceil(units / freezeQty) per leg, shown when > 1.
   - Order of rows = the **send order** (§8).
2. **Max lots at the touch**: floor(min_i(topQty_i)/u) from depth.
   - If < N: an orange warning "Only 1 lot available at these prices; the rest fills worse".
   - Depth unavailable → `--` with title "Depth not available from this broker".
3. **Waterfall** (two-column list, right-aligned, tabular figures; each line ₹ for U):
   - Gross locked
   - − Financing at hurdle
   - − Brokerage
   - − STT
   - − Exchange txn
   - − SEBI fee
   - − Stamp
   - − GST
   - − Exercise STT (hold) **or** − Exit charges − Exit spread (close)
   - **= Net**, bold, formatSigned 0
   - The lines **must add up exactly**. Each figure is rounded only at display, and the Net line is the sum of the displayed lines' unrounded values. A unit test checks the identity.
4. **Break-even**: in pts per unit = (all charges + financing)/U, shown as "needs 3.03 pts gross per unit".
5. **Return**:
   - Capital ≈ (§7.6) with its basis spelt out ("debit + charges", "premium + 12% futures margin (est.)", "≈ width (short box margin)");
   - Net %/yr;
   - Hurdle;
   - vs hurdle in bp.
6. **Target rate → limit** (box only): a number input "Target rate %/yr" (default = hurdle) gives "Max debit 98.92" (lend) or "Min credit 99.31" (borrow) per unit. Formula §7.5. The limit is rounded to tick in the safe direction (down for a debit, up for a credit).
7. **Payoff at expiry**: one line of text: "Flat: +₹624 at every settlement price". No SVG; the chart engine slot (§5.6) is where any visual goes later.
8. **Flags** (badges, §9), contextual to this structure.
9. **Actions**:
   - `Copy legs` (clipboard: one line per leg, `BUY NFO:NIFTY-2026-11-24-26400-CE 150 @ 469.90`, then a summary line);
   - `Preview orders` (primary; §8).
   - On phone, the actions are a sticky footer in the sheet.

### 5.6 Chart engine slot
- A panel with a dashed hairline inset border, `min-height: 220px` (160 px on phone), centred muted text "Chart engine slot", and the sub-line "Implied forward and box rate by strike, and the futures term structure, will draw here".
- It has `data-panel="chart-slot"` and `role="img"` with an aria-label saying the same.
- No chart library.

---

## 6. Charges model (`options.js`, `// ── Charges ──`)

### 6.1 Rates (one frozen object; cite "rates as of 1 Apr 2026, Finance Act 2026; verify")
```js
export const CHARGE_RATES = Object.freeze({
  asOf: "2026-04-01",
  sttOptSell: 0.0015,      // on premium, sell side
  sttOptExercise: 0.0015,  // on intrinsic value of exercised long ITM options (paid by the holder)
  sttFutSell: 0.0005,      // on futures value, sell side
  txn: { NSE: { opt: 0.0003503, fut: 0.0000173 }, BSE: { opt: 0.000325, fut: 0 } },
  sebiPerCrore: 10,
  ipftPerCrore: 0,         // editable; unverified, default 0
  stampOptBuy: 0.00003,
  stampFutBuy: 0.00002,
  gst: 0.18,               // on brokerage + txn + SEBI (+ IPFT)
});
```
- Sources disagree on NSE options txn (0.03503% vs 0.03553%). The default is the value PRD 02 uses, and the user can edit it (§10).
- The exchange comes from the symbol prefix: NFO → NSE, BFO → BSE.

### 6.2 Brokerage models (`profile.brokerage`)
| id | Label | Rule per executed order |
|---|---|---|
| `flat` (default) | Flat per order (most discount brokers) | `value` (default ₹20). For futures: min(value, `futPct`·turnover), with `futPct` default 0.0003 |
| `perLot` | Per lot | `value` × lots in the order |
| `pct` | % of turnover, capped | min(`pct`·turnover, `cap`) |
| `zero` | Zero brokerage | 0 |

- `exerciseBrokerage` (bool, default **true**, conservative): adds one order's brokerage for each option leg that is exercised or assigned at expiry (hold mode only).
- Broker names are **not** used as presets; the label explains "Most discount brokers charge ₹20 per order". This avoids shipping claims about named brokers.

### 6.3 Functions
- `orderCharges({ kind: "OPT"|"FUT", side: "BUY"|"SELL", price, units, exchange }, profile, rates = CHARGE_RATES)`:
  - returns `{ turnover, brokerage, stt, txn, sebi, ipft, stamp, gst, total }`;
  - turnover = price × units;
  - STT only on SELL (rate by kind); stamp only on BUY (rate by kind);
  - SEBI = turnover × perCrore / 1e7;
  - GST = gst × (brokerage + txn + sebi + ipft).
  - Missing price or units → `null`.
- `exerciseStt(legs, settle, rates)`: Σ over long option legs of sttOptExercise × intrinsic(settle) × units. Short legs pay none.
- `structureCharges(legs, profile, { hold: "expiry"|"close", settle, exitQuotes }, rates)`:
  - returns `{ entry: breakdown, exit: breakdown, exerciseStt, exitSpread, total }`, where breakdown is the summed `orderCharges` fields.
  - **hold = "expiry"**: exit = exercise STT at `settle`, plus `exerciseBrokerage` × (ITM option legs at settle). Futures settle at FSP with no charges.
  - **hold = "close"**: exit = `orderCharges` of the reverse orders at the opposite touch from `exitQuotes` (sell at bid, buy at ask). exitSpread = Σ (ask − bid) × units over all legs.
  - `settle` = Fimp when known, else Fm, else S. The waterfall line is labelled "est. at 26628".

### 6.4 Worked check (put in the tests; NIFTY demo-like, 1 lot u = 75, flat ₹20)
Conversion: buy FUT @ 26600.50, sell 26400 CE @ 450.15, buy 26400 PE @ 254.45.

| Component | Value |
|---|---|
| Turnover | FUT 1995037.50; CE 33761.25; PE 19083.75 |
| Brokerage | 20 + 20 + min(20, 598.51) = 60.00 |
| STT | 0.0015 × 33761.25 = 50.64 |
| Txn | 0.0000173 × 1995037.50 + 0.0003503 × 52845.00 = 53.03 |
| SEBI | 2.05 |
| Stamp | 0.00002 × 1995037.50 + 0.00003 × 19083.75 = 40.47 |
| GST | 0.18 × (60 + 53.03 + 2.05) = 20.71 |
| **Entry total** | **226.90** (3.03 pts per unit) |

Hold to expiry at settle 26628 > K: the long PE expires OTM → exercise STT 0; the short CE is assigned → +₹20 brokerage (exerciseBrokerage on). Total 246.90.

---

## 7. Arbitrage maths (`options.js`, `// ── Arbitrage ──`; all pure, all null-safe)

### 7.1 Basics
- `carryFactor(rate, days)` = e^{rate·days/365}. `twoSided(leg)`.
- `annualise(net, capital, days)` = net/capital·365/days; `null` when capital ≤ 0 or days < 1.

### 7.2 `impliedForward(chain, { rate, days, window = 5 })`
- Over two-sided strikes within ATM(spot) ± window: SynM_K = K + (mid C − mid P)·e^{rate·T}.
- Returns `{ forward: median, lo: min, hi: max, n, atm }`, where atm = the strike nearest the forward.
- n < 2 → `null`. **No silent fallback to spot.**

### 7.3 `optionsImpliedRate(chain, { days, window = 5 })`
- Over adjacent two-sided strike pairs within ATM ± window: box mid Bm = (mid C1 − mid C2) + (mid P2 − mid P1); r = (W/Bm − 1)·365/d.
- Returns the median, or `null` (n < 2 or d < 1).
- This is the rate the options price in, independent of dividends.

### 7.4 `parityRows(chain, { fut, rate, days, lots, profile, hold, window, rates })`
Per strike (a row is null-safe and every field may be `null`):
- `synBuy`, `synSell`, `synMid`, `dev`, `devBp`, `tag` ("callsRich" | "putsRich" | null) as in §5.2.
- **Reversal** (buy CE at Ca, sell PE at Pb, sell FUT at Fb):
  - grossPts = (Fb − K) − (Ca − Pb);
  - financingPts = (Ca − Pb)·(g − 1), which is negative when the option leg is a credit (you earn the interest);
  - netPts = grossPts − financingPts;
  - net ₹ = netPts·U − charges.
- **Conversion** (sell CE at Cb, buy PE at Pa, buy FUT at Fa):
  - grossPts = (Cb − Pa) − (Fa − K);
  - financingPts = −(Cb − Pa)·(g − 1);
  - netPts = grossPts − financingPts;
  - net ₹ = netPts·U − charges.
- charges = `structureCharges(...).total` for the three legs, with `hold` and settle = Fimp.
- Each structure returns `{ grossPts, financing, charges: breakdown, net, breakEvenPts, capital, annual, legs, flags }`.
- `fut` null → conv/rev are `null`, and dev uses Fimp.

### 7.5 `boxes(chain, { rate, days, lots, profile, hold, window, maxSteps, mode })`
Ranked boxes per §5.3, with `{ k1, k2, width, price, charges, locked, rate, vsHurdleBp, capital, liq, crossed, legs }`.
- **Limit for target rate** t:
  - lend: Dmax = ((W·U − X)/(1 + t·d/365) − Cin)/U;
  - borrow: Crmin = ((W·U + X)/(1 + t·d/365) + Cin)/U;
  - rounded to tick (down / up).
  - Cin and X are evaluated at the current quotes (an approximation; noted).
- Demo check: 26400/26500, D = 98.50, d = 27 → gross rate 20.59%/yr before charges (a test fixes this number).

### 7.6 Capital (`structureCapital`)
- Long box: D·U + Cin.
- Short box: ≈ W·U.
- Conversion / reversal: max(0, option net debit)·U + `futMarginPct`·Fm·U + Cin, with futMarginPct default **0.12** (editable). It is labelled "est.; hedge benefit ignored (conservative)".
- Annualised % = `annualise(net, capital, d)`. Its header title reads "Net after charges and financing at your hurdle, per year on capital: this is return **over** the hurdle".

### 7.7 `futuresTerm(spot, futs, { now, rate, profile, lot })`
Basis, carry and calendar rows per §5.4. Futures without two-sided quotes → that row's executable fields are `null`.

### 7.8 `cheaperExposure({ fut, chainAtm, rate, days, profile, lot })`
- Long via future: Fa + entry charges/u.
- Long via synthetic at the ATM-forward strike: K + (Ca − Pb)·g + entry charges/u + exercise STT at settle/u.
- Short is symmetric (Fb against K + (Cb − Pa)·g, with sell-side STT).
- Returns `{ long: { pick, diffPts, diffPerLot }, short: {…} }`.

### 7.9 `staleness({ chainAsOf, futAsOf, now, maxAgeMs })`
- `{ stale, ageMs, skewMs }`.
- stale when chain or future age > maxAgeMs (default 5000), or when |chainAsOf − futAsOf| > maxAgeMs.
- It uses `freshness.asOf` / `ageMs` / `stale` from the API.

### 7.10 `arbFlags(structure, ctx)`
Returns the badge codes in §9 that apply.

---

## 8. Order flow (Preview, then Place; safety gates unchanged)

1. `Preview orders` builds one order body per leg:
   - `orderType: "LIMIT"` at exactly the touch price used in the calculation, rounded to tick in the safe direction;
   - `product: "MARGIN"`;
   - quantity = units, split into freeze slices;
   - account = the toolbar account.
   - Send order: **least liquid option leg first** (highest spread %), then the other option legs by spread % descending, then **the future last**.
2. It calls `POST /v1/orders/preview` for **every** body first, in parallel, at most 4 at a time.
3. A modal lists the bodies in send order with each preview's checks.
   - **If any preview has a `block` check, nothing can be sent**: the Place button is disabled and the blocking messages are shown.
   - Example: the paper per-order limit of ₹2,00,000 blocks a NIFTY futures lot (₹20 L). The modal says so plainly and points to the limit setting on the Safety page.
4. Place sends through the existing `sendOrders` (sequential, stop at the first refusal). On a stop, the modal lists which legs **were** sent ("Open risk: you are now long 26400 CE without the hedge") and offers `Open Positions`.
5. The modal always carries the legging warning: "LIMIT orders at today's touch. Legs are separate orders, not an atomic spread. If a later leg does not fill, the earlier ones are an unhedged position."
6. Paper accounts show "Paper". Live accounts show the existing live acknowledgement UI from `openTicket`; the same gate is reused, not re-implemented.

---

## 9. Risk notes and flags

The risk notes panel (always present; collapsible, state persisted) holds these lines, in order:
1. **Executable only if every leg fills** at these prices; legs are separate orders (legging risk).
2. **Quotes can be stale.** Edges older than 5 s are hidden from "Best". Liquid NIFTY parity gaps are usually closed by algos within seconds; most visible edges are on illiquid strikes or stale quotes.
3. **Index options are European and cash-settled** at the final settlement price: there is no early assignment, and an index conversion has no basis mismatch at expiry.
4. **Futures are marked to market daily**: a locked structure still needs cash for MTM on the future.
5. **Exercise STT**: long ITM options held to expiry pay 0.15% of intrinsic value. Choose "Close" to compare.
6. **Expiry day**: +2% ELM on short index options and no calendar-spread margin benefit. Annualised figures are hidden on expiry day.
7. **A short box blocks margin close to its width** in India; it is not cheap leverage.
8. **Charges as of 1 Apr 2026** (STT 0.15% options sell, 0.05% futures sell); editable in Costs & filters; verify the current statutory rates.
9. **Tax**: F&O gains are business income in India; this page does not compute tax.
10. **Demo only**: "Demo prices: calls and puts use different volatility smiles, so parity breaks here are artificial." This line is shown when `app.state.demo`.

Flags are badges on a row's detail (and, on desktop, as tag icons in the Strike cell, at most 2, by priority):

| Code | When | Severity |
|---|---|---|
| STALE | `staleness().stale` | warn; row muted, excluded from Best |
| ONE_SIDED | any leg not two-sided | info; figures `--` |
| CROSSED | box price ≤ 0 or rate > 100%/yr | bad; excluded from Best |
| WIDE | any leg spread % > 5 | warn |
| THIN | top qty < 1 lot on any leg (from depth, detail only) | warn |
| FREEZE | slices > 1 on any leg | info: "Sent as 3 orders" |
| ORDER_LIMIT | a leg's value > the account's per-order limit, when known from preview | bad (detail only) |
| EXERCISE_STT | hold = expiry and a long leg is ITM at settle | info with ₹ |
| EXPIRY_DAY | `days < 1` | warn |
| NO_FUTURE | weekly expiry | info |
| LOT_MISMATCH | future lotSize ≠ chain.lotSize | bad; conv/rev disabled |
| NEAR_CLOSE | IST time 15:00–15:30 or before 09:15 | warn: "Pre-open / last 30 min: quotes thin" |

---

## 10. Settings (persisted in `mcb.dashboard.desk` under the key `arb`; wrap every read and write in try/catch)

### 10.1 Panel-head controls (persisted)
- `tab`: parity | boxes | futures.
- `lots`: 1–100, default 1.
- `hold`: expiry | close, default expiry.
- `onlyOpps`: default false.
- `boxMode`: lend | borrow.
- `sort`: per tab.

### 10.2 Costs & filters popover (gear; a bottom sheet on phone)
- **Hurdle rate %/yr**: default **6.00**, step 0.05. Help: "Your cost of money or alternative yield: 91-day T-bill, FD or MIBOR".
- **Brokerage model** (§6.2), with value, cap and futPct fields shown for the chosen model, plus the `Charge brokerage on exercise/assignment` checkbox.
- **Statutory rates** (collapsed `details`): every field of `CHARGE_RATES` as an editable % input, plus "Rates as of 1 Apr 2026" and `Reset to defaults`. User values are stored as overrides only.
- **Futures margin estimate %**: default 12.
- **Filters**:
  - Minimum net ₹: default 0.
  - Minimum box vs hurdle bp: default 0.
  - Minimum liquidity: 0–5, default 2.
  - Stale after: 2/5/10/30 s, default 5.
  - Strikes ATM ±: 5/10/20, default 10.
  - Box max width in steps: default 10.

### 10.3 Column chooser (Parity table only)
- The popover's column list reuses the chain Customise list code (checkbox, drag handle, ↑/↓ buttons).
- Strike and the net columns cannot be hidden.
- Optional extra columns: `Implied fwd at K` (SynM), `IV P−C` (PE.iv − CE.iv), `OI C·P` (formatCompact), `Gross pts`, `Charges ₹`, `Capital ₹`.
- `Reset` restores the defaults.

---

## 11. Interactions and keyboard (desktop; ignored in inputs or with a dialog open, via the existing `bindKeys`)

| Key | Action |
|---|---|
| 1 / 2 / 3 | Parity / Boxes / Futures |
| J / K or ↓ / ↑ | next / previous row (selection follows; the detail pane updates) |
| Enter | on phone-like widths, open the sheet; on desktop, focus the detail pane |
| Esc | close the sheet or popover; clear the selection |
| O | toggle Opportunities only |
| H | toggle the hold mode |
| + / − | lots |
| C | copy legs of the selected row |
| G | jump to the ATM row |
| P | pause or resume (existing) |

- A key-hint line (`desk-keys`, hidden on coarse pointers) sits under the table.
- Rows are `<tr tabindex="-1">` with roving focus; a click or tap selects the row.
- Header buttons sort (`aria-sort`).
- Selection is kept across ticks by its key: `p:26400`, `b:26400-26500:lend`, `f:2026-11-24` or `c:2026-11-24>2026-12-29`.

---

## 12. States

| State | What shows |
|---|---|
| First load | Figures strip with skeleton values; table body with 8 shimmer rows (no shimmer under reduced motion) |
| Chain error | `alertBox(err)` inside the scanner body with `Retry`; figures keep their last values, dimmed, with "as of 12:41:07" |
| Futures quote error | Parity works against Fimp, with the note "Could not load futures quotes: showing deviations against the implied forward" |
| No same-expiry future | §5.2 note; the Conversion and Reversal columns are hidden; the Boxes tab is unaffected |
| One-sided market (closed, pre-open) | Banner "Quotes are one-sided (market closed?). Nothing is executable; figures show `--`." Mid-based Dev still shows, muted, labelled "indicative (mid)" |
| Stale | Orange `Stale · 7 s` chip in the panel head; rows muted; Best tiles show "--, quotes stale" |
| Nothing clears the filters | Empty state in the table: "No structure clears ₹0 net after charges at 2 lots." Below it the **closest** candidate: "Closest: Reversal 26400, −₹74 (needs 1.0 pt more)", with a button `Show all strikes` |
| Expiry day | EXPIRY_DAY chip in the panel head; annualised columns `--` |
| Expired expiry selected | The existing desk behaviour (expiries list refresh) |
| Paused | The figures and table freeze; the Live toggle shows Paused (existing) |

---

## 13. Data and API (no server changes)

### 13.1 Endpoints used (all exist; checked against the running demo on 2026-10-29)
- `GET /v1/optionchain?underlying=&expiry=&strikes=40&greeks=true`: as today. Uses `underlyingLtp`, `lotSize`, legs' bid/ask/ltp/oi/volume/iv, and `freshness`.
- `GET /v1/instruments/search?q=<UNDERLYING> fut`: returns `kind: "FUT"` rows with `symbol`, `expiry`, `lotSize`, `tickSize`, `freezeQty`.
  - Filter to `underlying === U`.
  - Cache per underlying for the session (refetch on underlying change and when the nearest future expires).
- `GET /v1/quotes?symbols=<all FUT symbols>`: bid/ask/ltp/oi/freshness per future. One call per tick. (`bidQty`/`askQty` are null in the demo.)
- `GET /v1/depth?symbol=`: 5 levels with qty. Called **only for the selected structure's legs**, at most 4 calls per tick, only while the detail is visible.
- Option leg `freezeQty`: `GET /v1/instruments/{symbol}` for each leg of the selected structure, cached. All strikes of an underlying share the same freeze quantity, so one call per underlying is enough.
- `POST /v1/orders/preview` and `POST /v1/orders`: §8. Note: in the demo, a NIFTY futures lot (₹19.95 L) is blocked by the paper per-order limit (₹2 L). The preview modal must show this correctly; it is not a bug to work around.

### 13.2 Fetch schedule (kind "arb" only)
- Each tick (3 s, when live), in parallel: chain plus futures quotes. Both responses are timestamped; staleness uses the two `asOf` values.
- Futures tab only: every 15 s, for each FUT expiry other than the selected one, `optionchain?strikes=4` to compute its Fimp and ATM synthetic (at most 3 calls). The tab shows "updated 12 s ago" for that column.
- A sequence guard (`st.seq`) discards late responses after an underlying or expiry change, as the desk does today.

### 13.3 LATER server additions (not this round)
- `bidQty` / `askQty` per chain leg, so the table (not only the detail) can show size at the touch.
- Hedged margin from `/v1/orders/preview` for multi-leg baskets.
- Demo realism: option spreads that widen with moneyness and time to expiry.

---

## 14. Performance
- Build the table once per (tab, underlying, expiry, window, columns, mode), then **patch cells** each tick, as the chain does: compare a cell's value key and write only changed text.
- Rows are keyed; a sort change reorders the existing nodes (`append` in the new order), never rebuilds them.
- Maths per tick: parity O(n) for n ≤ 41 strikes in the window; boxes O(n²) ≤ 820 pairs at window 20 (≤ 210 at the default). Charges are computed per structure with leg-level memoisation keyed by (symbol, side, price, units).
- Budget: ≤ 6 ms main thread per tick at 1440 for the default settings. Measure with `performance.now()` around compute plus patch in a dev-only console line.
- The Boxes tab computes only when it is visible, or when the Best box tile needs it. The tile is computed every tick; it is cheap at the default window.
- Depth and extra chains are fetched only when needed (§13.2).
- No timers beyond the desk's `every()`. Clear everything on navigation (`stopTimer` exists).

---

## 15. Accessibility
- Real `<table>` with `<th scope="col">`, `aria-sort` on the sorted header, and a caption, visually hidden: "Put-call parity by strike, NIFTY 24 Nov, against the future".
- Two-line cells read as "450.15 bid, 450.25 ask" via `aria-label`. Liquidity dots have `aria-label`.
- Colour is never the only signal: an opportunity row has a text tag `Edge` in the strike cell (a visually small pill, readable by screen readers); signs (+/−) are always printed.
- An `aria-live="polite"` region announces only "Best reversal now 26350, plus ₹410" when the identity of the best changes, at most once per 10 s.
- The detail sheet is a `dialog` with focus moved to its heading, a focus trap, and Esc to close; focus returns to the row afterwards.
- 44 px targets on coarse pointers (cards, steppers, segmented buttons); `prefers-reduced-motion` removes shimmers and flash; `forced-colors` keeps hairlines via `outline`.

---

## 16. Test plan

### 16.1 Unit tests (`options.test.mjs`; hand-computed expectations)
- `orderCharges`:
  - the §6.4 conversion legs, line by line, to ±0.01, total 226.90;
  - a BFO option buy (BSE txn 0.0325%, futures txn 0);
  - the GST base excludes STT and stamp;
  - the `perLot`, `pct` (cap hit and not hit) and `zero` models;
  - a missing price → null.
- `exerciseStt`: long ITM CE at settle; short legs pay 0; OTM 0.
- `structureCharges`:
  - hold expiry with `exerciseBrokerage` on and off;
  - hold close uses opposite touches and adds exitSpread.
- `impliedForward`:
  - the median of carried synthetics on a fixture;
  - n < 2 → null (no spot fallback);
  - carry factor applied (deep ITM strike: the undiscounted value differs, the discounted value matches).
- `optionsImpliedRate`: a fixture box → the expected rate; d < 1 → null.
- `parityRows`:
  - conv and rev gross, financing sign (credit earns, debit pays), net;
  - fut null → conv/rev null and dev against Fimp;
  - a one-sided leg → null fields, not 0;
  - the callsRich / putsRich tag only outside the band.
- `boxes`:
  - D = 98.50, W = 100, d = 27 → gross 20.59%/yr;
  - net rate with charges;
  - the borrow formula;
  - the crossed flag for D ≤ 0;
  - the limit for a target rate round-trips: plugging Dmax back gives rate ≈ t.
- `futuresTerm`: basis, carry, the calendar forward rate, fair spread, roll long/short ₹ including charges.
- `cheaperExposure`: picks the cheaper side and the diff sign.
- `annualise`: capital ≤ 0 → null; d < 1 → null.
- `staleness`: by age and by skew.
- The waterfall identity: Σ lines = net (property test over 50 random structures).
- `format.test.mjs`: `arbitrage.js` in the file list (no `toFixed(` etc.).

### 16.2 Playwright (copy `scratchpad/desk.cjs`; navigate to `#/arb`; save under `scratchpad/shots/`; LOOK at every PNG)
- 3 tabs × {390×844, 820×1180, 1440×900} × {light, dark} = 18 shots.
- Plus: the detail open on each device (pane at 820/1440, sheet at 390), the Costs & filters popover/sheet, the preview modal showing the futures order-limit block, a weekly expiry (no-future note), and the empty "Opportunities only" state with lots = 50.
- An assertion in the script for each shot: `document.documentElement.scrollWidth <= innerWidth`.
- An assertion that the waterfall's Net equals the table's net for the selected row (text compare).
- Keyboard run at 1440: 2, J, J, Enter, Esc, O, H, 1, and screenshot.
- `npx vitest run server/bridge/dashboard`, then `npx vitest run` and `npm run -s check:mjs` before commit.

---

## 17. Priorities

### MUST (this round)
1. **M1 Page and wiring**: PAGES entry `arb` (Options group, between OI and Positions), `scale` icon, `renderDesk("arb")`, `arbitrage.js` registered in `DASHBOARD_FILES` and `format.test.mjs`, CSS section 12f.
2. **M2 Charges model**: `CHARGE_RATES` (as of 1 Apr 2026), brokerage models, `orderCharges`, `exerciseStt`, `structureCharges` with hold expiry and close (§6). One shared table with PRD 02.
3. **M3 Parity maths**: `impliedForward` (carried, median, no spot fallback), `optionsImpliedRate`, `parityRows` with conversion and reversal gross, financing at hurdle, charges, net, break-even, capital and annualised (§7.1–7.4, 7.6).
4. **M4 Box maths**: `boxes` (lend and borrow, net rates, vs hurdle, crossed flag), and the target rate → limit (§7.5).
5. **M5 Futures term**: futures discovery plus quotes per tick, `futuresTerm` (basis, carry, calendar fwd rate, fair spread, roll ₹/lot), and `cheaperExposure` (§7.7–7.8, §13.2).
6. **M6 Figures strip**: the six tiles with best-row links (§5.1).
7. **M7 Parity tab**: the table with all default columns, sorting, opportunities filter, ATM-from-forward tag, rich/cheap tags, and the weekly no-future mode (§5.2).
8. **M8 Boxes tab**: the ranked list with the Lend/Borrow mode (§5.3).
9. **M9 Futures tab**: futures and calendar rows, with options fwd from extra chains every 15 s (§5.4).
10. **M10 Detail pane and sheet**: legs in send order with slices, depth top qty and max lots, the exact waterfall, break-even, capital and return, the box limit calculator, flat payoff text, flags, copy legs (§5.5).
11. **M11 Order flow**: preview all legs first, all-or-nothing on blocks, send order (illiquid first, future last), `sendOrders`, the legging warning, open-risk report on a stop (§8).
12. **M12 Staleness and flags**: `staleness`, `arbFlags`, the Stale chip, Best exclusion (§7.9, §9).
13. **M13 Risk notes panel and chart engine slot** (§9, §5.6).
14. **M14 Settings**: panel-head controls, the Costs & filters popover with editable rates and Reset, and the parity column chooser (add, remove, reorder), all persisted (§10).
15. **M15 Layout**: desktop two-pane, tablet compact two-pane, phone cards with a bottom sheet and a sticky filter row; light and dark; no page horizontal scroll; 44 px targets (§4).
16. **M16 Keyboard, states and accessibility** (§11, §12, §15).
17. **M17 Tests**: all of §16.1, plus the §16.2 screenshots reviewed.

### LATER
- K1×K2 box **heatmap matrix** (rate against the hurdle).
- Stock F&O: physical settlement warnings, implied dividend column (S·e^{rT} − F), cash-and-carry against stock with delivery STT 0.1%, and a default hold of "close before expiry".
- Server: `bidQty`/`askQty` in the chain; hedged basket margin from preview; demo spreads that widen with moneyness.
- Atomic or exchange spread orders; auto-retry or chase on the unfilled leg; slicing scheduler.
- "Open in Strategy Builder" with futures legs (needs PRD 02 futures legs).
- Synthetic-vs-synthetic calendar across option expiries (term structure of the implied rate).
- History: a log of seen opportunities and their lifetime (boxtrades-style fill log); alerts via `/v1/hooks` when an edge or box rate crosses a threshold.
- Rate source auto-fetch (T-bill/MIBOR); named broker presets once verified; IPFT default.
- A multi-underlying scan (all indices at once).
- Charts in the chart engine slot.

---

## 18. Out of scope (this round)
- **Any chart or chart library.** The chart engine slot is a labelled placeholder only; the owner supplies the engine later.
- Tax computation (only the statutory transaction charges in §6).
- Automatic or unattended execution, and any change to safety gates, per-order limits or live-trading opt-ins.
- Stock options and futures (index underlyings only: the desk's existing `UNDERLYINGS` list).
- SPAN margin computation; capital figures are labelled estimates.
- Historical backtests of parity breaks.
- Exchange-level spread or combination orders.

---

## 19. Suggested build split (three agents in parallel, minimal file overlap)
- **Agent A: maths** (`options.js`, `options.test.mjs`): M2, M3, M4, the maths part of M5, M12 functions, and M17 unit tests. A fixed export list first (§6.3 and §7 names) so B and C can code against it on day one.
- **Agent B: page UI** (`arbitrage.js`, `app.css` 12f): M6–M10, M13–M15. It uses stubbed maths until A lands.
- **Agent C: wiring, flow and verification** (`desk.js`, `views.js`, `app.js` icon, `app.mjs`, `format.test.mjs`): M1, the fetch schedule (M5 data), M11, M16 keyboard, and the Playwright script plus screenshots (§16.2). C runs the full checks and is the only agent that commits.
