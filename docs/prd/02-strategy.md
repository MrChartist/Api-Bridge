# PRD 02: Strategy Builder, page `#/strategy`

Status: ready to build · Owner: Options desk · Round 1
Files: `server/bridge/dashboard/desk.js` (toolbar, shared state, `analysePositions`, `addLeg` entry point), new `strategy.js` (builder UI), new `strategy-place.js` (confirm + safe placement), new `payoff.js` (payoff drawing behind a swappable interface), `options.js` (+ `options.test.mjs`), `app.css` (12b · OPTION DESK, new sub-section "12d · STRATEGY BUILDER"), server: `orders/orderService.mjs` + `paper/*` (one additive field, §12.2), `docs/openapi.yaml`.

The builder already works: 8 presets, a legs table, credit/max P&L/breakevens/PoP/greeks tiles, an SVG payoff with expiry and "today" lines, Analyse positions, and buy-first sequential placement. This round turns it into a tool for every persona. The three trust gaps that competitors leave open get closed:
1. **Margin you can believe.** Show the account's own figure, the hedged estimate, funds and the shortfall before you place.
2. **Placement that cannot leave you naked.** Hedges fill before shorts go out. A partial basket gives you a one-click unwind.
3. **Honest what-if.** A target-date slider and an IV shift, with the model's inputs printed under the curve.

It also adds view-grouped presets (30, including futures-based hedges and arbitrage), a strike picker inside the builder, futures legs, charges and STT-aware P&L, a scenario table, and named saves.

---

## 1. Goals per persona

| Persona | Job on this page | Numbers they decide on (visible without scrolling on desktop; in the first screen plus the sticky bar on phone) | Mistakes the page must prevent |
|---|---|---|---|
| **Buyer** (directional, long vol) | Express a view cheaply. Pick strike and expiry. Know the bleed. | Debit (= max loss), breakevens as % and **σ distance**, PoP, P&L at a **target date**, P&L after an **IV crush** (IV shift −3 to −5), theta ₹/day, reward/risk | Breakeven outside ±1σ on a weekly; ignoring IV crush after events; holding a slightly-ITM long into expiry (the **exercise-STT trap**); wide-spread strikes; legs with no price |
| **Seller** (strangles, condors, credit spreads) | Collect theta with known risk and known margin | Credit, **margin** (account figure + hedged estimate), **return on margin**, max loss or **stress loss at +2σ** when unlimited, PoP, breakeven σ distance, net Δ (lots), Γ near expiry, vega ₹ per vol point, funds left | Shorts before hedges (margin spike or rejection); a hedge rejected while the shorts fill; naked shorts on expiry day (+2% ELM, gamma); exceeding funds |
| **Hedger** (holds futures or a portfolio) | Protect a futures position: protective put, collar, covered call; see the combined payoff of current positions plus the hedge | Combined Δ in lots, floor and cap levels (breakevens / kinks), hedge cost as % of notional, P&L at target with vs without the hedge (toggle the hedge legs off) | Wrong hedge ratio; forgetting the futures leg (today the builder cannot hold one); a hedge expiring before the exposure (warn when an option leg expires before the FUT leg) |
| **Arbitrageur** (conversion, reversal, box) | Lock a riskless P&L and check that it beats the cost of money after charges | **Locked P&L net of charges**, **implied rate %/yr**, executable prices at the touch per leg, margin, legging risk | LTP instead of the touch; ignoring STT and charges (they turn boxes negative); partial fills that leave naked risk |

Success for this round:
1. Any of the 30 presets is two clicks away (group, then preset) and shows its mini payoff before it is applied.
2. The confirm sheet shows legs in placement order, the net, max loss, margin, funds after, and every warning. No short leg is sent until every hedge leg reports `filled`, unless the user explicitly overrides.
3. Moving the target-date or IV slider redraws the chart, the tiles and the scenario table in 16 ms or less per frame on desktop. The page makes no network calls while a slider moves.
4. Phone (390), tablet (820) and desktop (1440) in light and dark: no horizontal page scroll, no truncated figures, 44 px touch targets on coarse pointers.

---

## 2. Current implementation: keep, change, add, remove

### Keep
- The shared toolbar (underlying, expiry, account, live) and the chain summary panel above the builder (movable and hideable, as now).
- The working draft per `underlying|expiry` in `mcb.dashboard.desk` (`st.baskets`), autosaved. The ⇧B / ⇧S hotkeys on the chain and "Add to strategy" in the ticket both add to it.
- `O.payoffAt`, `O.valueAt`, `O.netPremium`, `O.strategyStats` and `O.netGreeks` stay as exports, extended as described in §6. Existing tests keep passing.
- Prices default to the touch (ask to buy, bid to sell).
- The lognormal PoP integrated over profitable intervals between breakevens.
- Analyse positions: legs carry `entry` = the average price.
- Paper by default. The live toggle appears only when `liveAllowedByConfig` is set and needs its explicit acknowledgement checkbox. **Never weaken this.**
- Payoff visuals: green/red fill above and below zero, the ±1σ band, the spot marker, breakeven dots and the crosshair readout.

### Change
| # | What | From | To |
|---|---|---|---|
| C1 | Builder code location | ~120 lines inside `renderDesk` in desk.js | New `strategy.js` exporting `createBuilder({ st, save, account, refreshPositions })`, returning `{ el, draw(x), addLeg(leg) }`. desk.js keeps the toolbar and state. Placement goes to `strategy-place.js`, drawing to `payoff.js`. |
| C2 | Redraw on every 3 s tick | `builderEl.replaceChildren(card(...))`, which rebuilds everything (sliders would reset mid-drag) | Build the structure **once** per page visit. Ticks patch leg prices, tiles, chart paths and table cells by signature (the same pattern as the chain cells). Rebuild only when the legs list changes length or order. |
| C3 | Presets | 8 in a flat row | 30 in 5 view groups with mini payoff glyphs (§7). |
| C4 | Leg editing | Only B/S and lots | Per leg: on/off, B/S, strike step ‹ ›, CE/PE switch, lots stepper, remove. Basket-wide: shift strikes ±1 step, lots ×/÷ (§8.2). |
| C5 | Missing price | Falls back to `ltp`, then **0** (silently wrong P&L) | Fallback is basis → `ltp` (tagged "LTP") → **null**. A null price shows `--`. Figures that depend on it show `--` with the line "26800 CE has no price", and Place is blocked (§10). |
| C6 | IV fallback | Missing leg IV silently becomes ATM IV | Same fallback, but the leg's IV cell shows the value in muted italics with the title "No IV for this strike: ATM IV used". |
| C7 | Max loss below the lowest strike | `downSlope < 0` → "Unlimited" (wrong: S cannot go below 0) | Evaluate at **S = 0**. Only a non-zero slope above the top strike (calls + futures) is "Unlimited". A naked short put shows its true finite max loss. |
| C8 | Breakevens | `a === 0` pushes a strike, and the next segment can push it again | Roots de-duplicated within 0.5 points. A flat-at-zero segment reports its two ends once (§6.3). |
| C9 | Rupee precision | Credit `₹3169` next to max profit `+₹3168.75` | Every rupee figure in the builder uses 0 decimals (`formatRupee(v, 0)` / `pnl` with 0 decimals). Per-unit prices keep 2. |
| C10 | Greeks | Chain greeks; Δ in raw units; no Γ tile | Model greeks (Black-76) at the **target date with the IV shift**, so the what-if moves them. Δ in lots and ₹/point, Γ as Δ-change per 1% move in lots, θ ₹/day, ν ₹ per vol point (§6.8). |
| C11 | Payoff chart | Fixed 720×300, hover-only readout, odd x ticks (25371 25883 …), breakeven labels overlap the zero label | `payoff.js` with a data-model interface (§9). Tap or drag pins the readout on touch. `niceTicks` on x. Labels avoid collisions. Height is 300 on desktop, 260 on tablet, 220 on phone. |
| C12 | Placement | Buys first, but shorts are sent without waiting for fills; stops at the first refusal with no rollback | A state machine: pre-flight previews, then hedges, each **waited to `filled`**, then shorts. On failure, a partial state with **Cancel open / Unwind filled / Retry** (§11). |
| C13 | Confirm modal | Leg list and mode only | Summary (net, max loss, margin, funds after), editable limit per leg, slices, warnings, product choice (§11.1). |
| C14 | Product | Hard-coded `MARGIN` | Segmented Intraday / Carry (NRML), persisted. Default is Carry. |
| C15 | Applying a preset or Clear | Overwrites the draft silently | Overwrites with a toast "Iron condor applied · Undo" (and Ctrl+Z). Single-level undo. |
| C16 | Phone tiles | Values truncated ("+₹3168…", "25958 ·…") | Tiles never truncate. Values longer than 7 characters switch to `₹` + `formatCompact`. Breakevens wrap to two lines (§4.3). |

### Add (MUST this round; details below)
- Grouped presets with glyphs (§7).
- A strike picker inside the builder, with a FUT row (§8.1).
- FUT legs, using the nearest future expiring on or after the option expiry (§12.1).
- Target-date and IV-shift what-if (§8.3).
- Scenario table (§8.4).
- Metrics: margin and funds, ROI, reward/risk, σ distance, EV, stress loss, charges and the net-of-charges toggle, locked P&L with implied rate (§6).
- A customisable metric strip (§13).
- Named saves with a live vs saved-prices comparison, plus JSON export/import (§14).
- Strategy warnings (§10).
- The safe placement state machine (§11).
- Sticky bottom action bar on phone and tablet (§4).
- Keyboard shortcuts and a `?` help overlay (§15).
- A "Price chart · chart engine slot" placeholder panel (§9.3).
- Server: a `margin` field on the order preview for paper accounts (§12.2).

### Remove
- The flat `.preset-row` of 8 buttons. It is replaced by the group tabs and chips.
- The "Win chance" label. Use **"Chance of profit"** with the sub-line "at expiry · IV model". "Win" overstates it.
- The "Greeks" mega-tile that packs Δ, θ and ν into one tile. It is replaced by separate tiles that the user can show or hide.
- The `disabled` Place button for analysed positions. It is replaced by an explicit "Close these legs" action (exit plan, shorts first, §11.4).

---

## 3. Information architecture

Panels in order. Each is a top-level child of `#content`, so `arrangePanels` gives it the move and maximise pill. `data-panel` names it.
1. `desk-top`: toolbar (`data-fixed`, unchanged).
2. `summary`: chain summary tiles (unchanged; the user can hide it).
3. `strategy`: the builder.
   - Head: title `Strategy` + context line `NIFTY 3 Nov · lot 75 · prices at the touch`, followed by the actions **Saved (n) · Save · Clear · Place 4 legs**.
   - Body: **build column** (presets, legs, leg tools) and **analysis column** (metric strip, payoff, what-if row, model note, scenario table).
4. `price-chart`: the chart-engine slot (§9.3), collapsed by default.

The phone and tablet sticky action bar belongs to panel 3 (`position: sticky`). It is not a separate panel.

---

## 4. Layout per device

Spacing rules: hairline rules via inset box-shadows (`--hl`), tabular numerals, no card-in-card borders. The builder sits on one surface, and sections are divided by hairlines.

### 4.1 Desktop (1440×900; content width ≈ 1100)
- Builder grid: `grid-template-columns: minmax(360px, 420px) minmax(0, 1fr)`, gap 20.
- **Build column**:
  - Group segmented control (Bullish · Bearish · Neutral · Volatile · Hedge & arb), full width, 30 px.
  - Preset chips under it, wrapping. Each chip has a 32×16 glyph and a name, 30 px high.
  - Legs table with columns `[on] [B/S] Strike ‹ › | CE/PE | Lots −/+ | Price | IV | Δ | ×`, rows 36 px.
  - Leg tools row: `+ Add leg` (opens the picker), `‹ Shift ›`, `Lots ÷2 ×2`, and the text "4 legs · 4 lots".
- **Analysis column**:
  - Metric strip: 4 columns × 2 rows of tiles, 8 by default (§13).
  - Payoff (300 px) with the legend and readout in its head.
  - What-if row: target-date slider (flex 2), IV-shift slider (flex 1), `Reset`.
  - Model note (one muted line, 12 px).
  - Scenario table (9 rows), open by default from 1280 px up.
- At 1100–1279 px: the same two columns, with the scenario table collapsed behind a "Scenarios" disclosure.
- Place is in the panel head. There is no sticky bar on desktop.

### 4.2 Tablet (820×1180 portrait; 1180×820 landscape uses the 1100–1279 desktop rules)
- One column at 788 px wide, in this order:
  1. Group segmented + chips (single row, horizontal scroll inside its own wrapper).
  2. Legs table. IV and Δ stay visible because there is room.
  3. Leg tools.
  4. Metric strip: 4 × 2.
  5. Payoff at 260 px.
  6. What-if row.
  7. Model note.
  8. Scenario table, collapsed by default.
- On coarse pointers, rows and steppers are 44 px.
- Sticky action bar at the bottom of the panel: `bottom: calc(var(--tabbar-h) + 12px + var(--safe-b))`, holding Net · Margin · Place.

### 4.3 Phone (390×844)
- Order:
  1. Group tabs (scrolling segmented control).
  2. Chips (one scrolling row).
  3. **Leg cards**.
  4. Leg tools.
  5. Metrics 2×2 with the four primaries (Max profit, Max loss, Breakevens, Chance of profit) plus `More figures ▾`, which reveals the rest of the strip in 2 columns. The open/closed state is persisted.
  6. Payoff at 220 px.
  7. What-if: the two sliders stacked, full width.
  8. Model note.
  9. Scenario table, collapsed, with 3 columns: Price · Target · Expiry. The Move value goes under the price in small text.
- Leg card, one 44 px line: `[✓] [S] 26000 PE  ×1  28.95 [⋯]`. Tapping `⋯` or the card expands a second line: `‹ strike ›  CE/PE  − lots +  Remove`.
- Panel head on phone: the title only, plus an overflow `⋯` for Saved, Save and Clear. Place lives in the sticky bar.
- **Sticky action bar**:
  - 56 px high, `bottom: calc(var(--tabbar-h) + 12px + var(--safe-b))`. Material background (`--mat-*`) with a top hairline.
  - Left: `Credit ₹3169` with `Margin ₹42.1K · PoP 74%` under it.
  - Right: the primary button `Place 4`.
  - The bar never covers the last content: the panel gets matching `padding-bottom`.
- Tile values never truncate. Long rupee values use `formatCompact`. Breakevens show one per line.
- Payoff axis and label font sizes stay as now (the existing 19 px in viewBox units at this width).

### 4.4 Light and dark
Tokens only. Buy and sell tags use the existing `.side-tag` styles. Green and red appear only on P&L figures and the payoff areas. Glyphs, CE/PE and the target line use neutral or blue tokens.

---

## 5. Data model (draft, saves and placement all use it)

```
Leg = {
  id: string,                     // stable, for DOM keys and undo
  kind: "OPT" | "FUT",
  right: "CE" | "PE" | null,      // null for FUT
  strike: number | null,          // null for FUT
  expiry: "YYYY-MM-DD",           // this round: OPT legs = toolbar expiry; FUT = its own expiry
  symbol: string | null,          // filled from the chain / instrument search
  lotSize: number,                // per contract, never per underlying (from chain.lotSize or the FUT instrument)
  side: "BUY" | "SELL",
  lots: integer 1..freeze-aware max (see §10),
  on: boolean,                    // false = excluded from all figures and from placement
  entry?: number | null,          // fixed entry price (Analyse positions, or a save loaded "at saved prices")
}
Draft = { legs: Leg[] (max 12), presetId: string | null, target: epoch ms | null (null = now), ivShift: number (vol points) }
```
- Migration: existing basket legs `{ right, strike, side, lots, entry? }` gain `id`, `kind: "OPT"`, `expiry` (from the key), `lotSize` (from the chain on first draw) and `on: true`. Pure function `O.migrateLegs(legs, expiry)`, tested.
- `O.legUnits(l, fallbackLot) = floor(lots) × (l.lotSize || fallbackLot)`. Every maths function uses the per-leg lot size.
- Legs with `on === false` are filtered out **before** every calculation (`O.activeLegs`).

---

## 6. Every number: formula and edge cases

Notation:
- S = underlying (x-axis, spot terms).
- spot = `chain.underlyingLtp`.
- F = `O.forwardPrice(chain)`, the synthetic forward of the option expiry.
- u_i = units of leg i.
- s_i = +1 for BUY, −1 for SELL.
- p_i = entry price per unit.
- σ = (ATM IV + shift)/100.
- T = years from **now** to the first option expiry at 15:30 IST (`O.yearsToExpiry`).
- T_t = years from **target** to each leg's expiry.

All P&L is in ₹ for the whole strategy. All formatting goes through `format.js`.

### 6.1 Leg price p_i (the basis setting: Touch | Mid | LTP, default Touch)
- Touch: BUY → ask, SELL → bid, via `O.touchPrice`. Mid: `O.mid`. LTP: `ltp`.
- Fallback: basis → ltp (cell tag `LTP`, muted) → null.
- `entry` overrides the basis (shown with an `avg` or `saved` tag).
- FUT: the same rules on the `/v1/quotes` bid/ask/ltp.

### 6.2 Net premium (tile "Credit" / "Debit")
- N = Σ_options −s_i · p_i · u_i. FUT legs carry no premium.
- N > 0.5 → "Credit ₹N". N < −0.5 → "Debit ₹|N|". Otherwise "Even ₹0".
- Sub-line: `4 lots · lot 75`. With mixed lot sizes: `4 lots · 300 qty`.
- If any active leg has p = null, the tile shows `--` and the sub-line "1 leg has no price".

### 6.3 Expiry payoff, max profit and loss, breakevens (`O.strategyStats`, extended)
- OPT leg at expiry: s_i · u_i · (intrinsic_i(S) − p_i).
- FUT leg: s_i · u_i · (S + b_fut(T*) − p_i), where T* is the first option expiry.
  - Basis decays linearly in time: b_fut(t) = (futLtp − spot) · τ_fut(t)/τ_fut(now), with τ = time to the future's expiry.
- Evaluation points: {0, every strike, hi = 2 × max strike (or 2 × spot if no strikes)}. Between kinks the payoff is linear, so this is exact. FUT legs add slope only.
- **Unlimited**: upSlope = Σ_CE s·u + Σ_FUT s·u. upSlope > 0 → max profit = Unlimited. upSlope < 0 → max loss = Unlimited.
  - The downside is never unlimited: the value at S = 0 is used.
  - Floating-point guard: |slope| < 1e-9 counts as 0.
- **Stress loss** (shown only when max loss is Unlimited): the payoff at S = F·e^{2σ√T}. Tile sub-line: `−₹48.2K at +2σ (27512)`.
- **Breakevens**: sign changes between consecutive evaluation points, linear interpolation.
  - A zero at a kink counts once (de-duplicated within 0.5 points).
  - A segment identically 0 (|a| and |b| < ₹0.5) contributes its two ends, de-duplicated.
  - Display `formatInt(round(BE))`, at most 4. More than 4 → the first 3 + "+n".
  - Sub-lines per breakeven: `−1.7% · 1.1σ`, where % = (BE − spot)/spot·100 and σ-distance z = ln(BE/F)/(σ√T), shown as `formatFixed(|z|, 1)σ`.
- **Net of charges** (toggle, default on, persisted):
  - All three figures use payoff(S) − C_entry − C_exit(S).
  - C_entry is from §6.10.
  - C_exit(S) = exercise STT on long ITM options at S, plus estimated FUT sell-side charges on squaring off.
  - Tile titles say "after charges" when the toggle is on.
- **Locked strategy**: both extremes finite and maxProfit − maxLoss < max(₹1, 0.001·|N|).
  - The Max profit and Max loss tiles merge into one tile: **"Locked P&L ₹X"**, with sub-line `Implied 6.8%/yr`.
  - Implied rate = (X / K) / T, where K = |N| if debit, else the margin (§6.11) when known; otherwise `--`.
  - The tile title explains "Riskless at expiry if every leg fills at these prices".

### 6.4 Target-date curve (`O.valueAt`, extended)
- V(S, target) = Σ s_i · u_i · (price_i(S, target) − p_i).
- OPT leg: Black-76 with forward F_i(S) = S + (F − spot) · τ_opt(target)/τ_opt(now), strike K, time T_t, vol max(1, IV_i + shift)/100, r = 0.
  - If T_t ≤ 0, use intrinsic (the leg has expired by the target).
- FUT leg: S + b_fut(target) − p.
- Returns null if any OPT leg has no IV and no ATM fallback. The curve is then hidden and the note says why.

### 6.5 Chance of profit (tile "Chance of profit", sub "at expiry · IV model")
- The existing interval integration over `cuts = [0, …breakevens, ∞]` on the **net-of-charges** payoff when the toggle is on.
- Uses F, T (from now) and σ including the IV shift.
- Lognormal with drift 0 under the forward measure: P(S_T < x) = N((ln(x/F) + σ²T/2)/(σ√T)).
- `--` when F, σ or T ≤ 0. At T ≤ 0 (after 15:30 on expiry), it is 100% or 0% based on payoff(spot) > 0.

### 6.6 Expected value (tile "EV at IV", hidden by default)
- EV = Σ_{k} payoff(F·e^{−σ²T/2 + σ√T·z_k}) · φ(z_k) · Δz, with z from −6 to +6 in 481 steps.
- Title: "Close to −(spreads + charges) by construction: options are priced at IV. Shows what the touch and charges cost you."

### 6.7 Return on margin and reward/risk
- ROM = maxProfit / margin. Shown as a % with 1 decimal. `--` if max profit is unlimited or the margin is null or 0.
- Reward/risk = maxProfit / |maxLoss|, 2 decimals (`0.27`). `--` if either side is unlimited or max loss is 0.

### 6.8 Net greeks (model; `O.black76Greeks`, `O.netGreeksModel`)
- Per OPT unit at the target date and IV shift, forward measure, r = 0:
  - Δ = N(d1) for CE, N(d1) − 1 for PE.
  - Γ = φ(d1)/(F·σ√T_t).
  - θ per calendar day = −F·φ(d1)·σ/(2√T_t)/365.
  - ν per 1 vol point = F·φ(d1)·√T_t/100.
- FUT: Δ = 1, other greeks 0.
- T_t ≤ 0: Δ = 1 if ITM (0 if OTM, sign by right), other greeks 0.
- Net value = Σ s_i · u_i · greek_i.
- Tiles:
  - **Δ**: `+0.42 lot` (= netΔ / lotSize of the first leg), sub `₹31/pt`.
  - **Γ**: `+0.18 lot per 1%` (= netΓ · F · 0.01 / lot).
  - **θ**: `₹579/day`, sign-coloured: positive green, negative red.
  - **ν**: `₹−529 per vol pt`.
- Edge case: F null → `--`.
- `O.netGreeks` (chain greeks) stays for back-compat. A unit test checks model and chain within tolerance on demo-like inputs.

### 6.9 P&L at target (tile "At target", default visible)
- V(spot, target) from §6.4, net of entry charges when the toggle is on.
- Sub-line: `Thu 30 Oct 15:30 · IV +0`. When the target is now: `now · IV +0`. This shows the mark-to-model cost of entry.

### 6.10 Charges (`O.charges(legs, rates)`; rates in `O.CHARGE_RATES`, dated "rates as of Apr 2026, verify")
Per order: turnover t = p · u (options premium; futures price × units).

| Component | Options | Futures |
|---|---|---|
| Brokerage | ₹20 flat per order | ₹20 per order |
| STT | 0.15% of t on SELL | 0.05% of t on SELL |
| Exchange txn | NSE 0.03503% / BSE 0.0325% of t | NSE 0.00173% of t |
| SEBI fee | ₹10 per crore of t | same |
| Stamp | 0.003% of t on BUY | 0.002% of t on BUY |
| GST | 18% of (brokerage + txn + SEBI) | same |
| Exercise STT (expiry) | 0.15% of intrinsic × units on long ITM | n/a |

- Exchange comes from the symbol prefix (NFO → NSE, BFO → BSE).
- Tile "Charges" (hidden by default): entry total, with sub `+ exit ≈ ₹X at spot`.
- Rates live in one frozen object so the owner can correct them in one place. A comment cites the research date.

### 6.11 Margin and funds (tile "Margin", default visible)
- **Account figure**: the sum of `preview.margin.required` over the active legs in placement order (§12.2).
  - Paper accounts only this round. Broker accounts return null.
  - The tile shows it when every leg has a number.
- **Hedged estimate** (`O.marginEstimate`, always computed, labelled `≈`):
  - Defined risk (max loss finite): |maxLoss_gross|.
  - Undefined risk: scanLoss + 2% × short-option notional.
    - scanLoss = −min of the expiry payoff over S ∈ [F·0.91, F·1.09], floored at 0.
    - Short-option notional = Σ_short u·F.
  - Plus, on **expiry day** (the first expiry is today in IST): 2% × notional of shorts expiring today (ELM).
  - Plus the net debit when the strategy is a debit and the risk is undefined.
- Tile value: the account figure if present, else `≈ estimate`.
- Tile sub-line: `hedged ≈ ₹38.9K · ₹9.9L free`. Free = `funds.availableCash` (`GET /v1/funds?account=`, fetched on page entry and after placement, not on every tick).
- **Shortfall** = required − free > 0 → the tile value turns red, the sub-line reads `short by ₹12.4K`, and a warning appears (§10).
- Title text explains: "Paper accounts block margin per leg with no hedge benefit; exchanges give hedged baskets a large benefit. The estimate approximates SPAN + exposure; your broker's figure is final."
- States: previews loading → `…`; preview failed → estimate only, plus the title "Account margin unavailable".

### 6.12 Expected move band and scenario levels
The band is `O.sigmaBand(F, ivPct, T, k)` = [F·e^{−kσ√T}, F·e^{kσ√T}] for k = 1 (fill) and 2 (outline only). If PRD 01 has already added `sigmaBand`, reuse it.

---

## 7. Presets (`O.PRESETS` metadata + `O.presetLegs`)

Metadata: `{ id, name, group: "bull"|"bear"|"neutral"|"vol"|"hedge", risk: "defined"|"undefined", needsFut: boolean, hint }`. The chip tooltip reads `${hint} · ${credit|debit computed live} · ${Defined|Undefined} risk`.

Strike grid:
- step = the smallest strike gap.
- near(x) = the listed strike closest to x.
- K0 = ATM.
- m = 1σ move (`O.sigmaMove`; fallback 4·step).
- Kc1 = max(near(F+m), K0+step), Kp1 = min(near(F−m), K0−step).
- w = max(step, near-multiple of m/2).
- W = max(step, round(m/step)·step).
- Lots are 1 unless noted.

| Group | Preset | Legs |
|---|---|---|
| Bullish | Long call | B CE K0 |
| | Bull call spread | B CE K0, S CE Kc1 |
| | Bull put spread | S PE K0, B PE Kp1 |
| | Short put | S PE Kp1 |
| | Call ratio back spread | S 1 CE K0, B 2 CE Kc1 |
| | Long synthetic | B CE K0, S PE K0 |
| | Risk reversal | B CE Kc1, S PE Kp1 |
| Bearish | Long put | B PE K0 |
| | Bear put spread | B PE K0, S PE Kp1 |
| | Bear call spread | S CE K0, B CE Kc1 |
| | Short call | S CE Kc1 |
| | Put ratio back spread | S 1 PE K0, B 2 PE Kp1 |
| | Short synthetic | S CE K0, B PE K0 |
| | Bear risk reversal | B PE Kp1, S CE Kc1 |
| Neutral | Short straddle | S CE K0, S PE K0 |
| | Short strangle | S CE Kc1, S PE Kp1 |
| | Iron condor | B PE Kp1−w, S PE Kp1, S CE Kc1, B CE Kc1+w |
| | Iron fly | B PE K0−W, S PE K0, S CE K0, B CE K0+W |
| | Long call butterfly | B CE K0−W, S 2 CE K0, B CE K0+W |
| | Jade lizard | S PE Kp1, S CE Kc1, B CE Kc1+w |
| Volatile | Long straddle | B CE K0, B PE K0 |
| | Long strangle | B CE Kc1, B PE Kp1 |
| | Reverse iron condor | S PE Kp1−w, B PE Kp1, B CE Kc1, S CE Kc1+w |
| | Reverse iron fly | S PE K0−W, B PE K0, B CE K0, S CE K0+W |
| Hedge & arb | Protective put | B FUT, B PE near(F−m/2) |
| | Covered call | B FUT, S CE Kc1 |
| | Collar | B FUT, B PE Kp1, S CE Kc1 |
| | Conversion | B FUT, B PE K0, S CE K0 |
| | Reversal | S FUT, S PE K0, B CE K0 |
| | Box | B CE K0, S CE Kc1, B PE Kc1, S PE K0 |

Bullish 7 + Bearish 7 + Neutral 6 + Volatile 4 + Hedge & arb 6 = **30**.

Behaviour:
- Strikes that would fall outside the fetched rows are clamped to the outermost listed strike.
- If two strikes collapse onto one (a very narrow chain), the step-based fallbacks apply, as today.
- Presets with `needsFut` are disabled while no FUT instrument has been found. Title: "No future found for NIFTY."
- **Glyph**: `O.presetGlyph(legs, lotSize)` returns ≤ 8 normalised points (S at 0, kinks, hi → x 0..32; payoff → y 0..16, with the zero line at its true y). It is drawn as an SVG polyline in `currentColor`, plus a zero hairline. Glyphs are computed when the group changes and when ATM moves, not on every tick.
- **Active state**: a chip is `.on` while the draft's legs equal `presetLegs(id)` (same right, strike, side, lots). Editing a leg clears it.
- Applying a preset replaces the draft and resets `target` and `ivShift`, with the Undo toast (C15).

---

## 8. Building interactions

### 8.1 Strike picker (`+ Add leg`; key `A`)
- Desktop and tablet: a popover anchored to the button, 380 px wide, max height 60vh. Phone: a bottom sheet via `modal()`.
- Top row: `FUT 24 Nov  26522.95  [B] [S]`. The row is hidden when no FUT is available.
- Rows: ATM ±10 strikes from the current chain. Each row shows `CE ltp [B][S] | strike (Δ) | [B][S] PE ltp`.
- The ATM row is highlighted and scrolled into view. The spot line sits between the bracketing strikes.
- Each B/S button adds 1 lot and keeps the picker open so several legs can be added quickly. A live region says "Buy 26000 PE added".
- `Esc` closes. `↑/↓` moves between rows. `B` and `S` with ←/→ choose the side, matching the chain's keys.
- A strike filter input at the top accepts a number and jumps to the nearest strike.

### 8.2 Leg row controls (all re-evaluate instantly; no network)
- **On/off** checkbox: the label reads "Include 26000 PE".
- **B/S** toggle: clears `entry`.
- **Strike ‹ ›**: moves to the adjacent **listed** strike and clears `entry`. Disabled at either end of the chain.
- **CE/PE** switch: clears `entry`. Not shown for FUT.
- **Lots** stepper: − and + buttons around a numeric input, minimum 1. The maximum is 100 × freeze lots; a warning appears beyond freeze (§10). The quantity hint shows in the title.
- **Remove** (×): with an Undo toast.
- Basket tools:
  - `‹ Shift ›` moves every OPT leg one step down or up (`O.shiftLegs`). Keys `[` and `]`.
  - `÷2` and `×2` scale all lots: ÷2 floors each leg at 1 and is disabled when every leg is already at 1 lot.
- Adding the same contract and side again merges into the existing leg (existing behaviour).

### 8.3 What-if (target date + IV shift)
- **Target date**:
  - `<input type=range>` in minutes from now to the first expiry's 15:30 IST, step 15.
  - Label: `T+1d 4h · Thu 30 Oct 13:45 · 4d 2h left`, via `Intl.DateTimeFormat` in the Asia/Kolkata zone. `aria-valuetext` carries the same text.
  - At the maximum, the label reads `At expiry` and the target line is hidden (it equals the expiry line).
  - Keys when focused: ←/→ = ±15 min; PageUp/PageDown = ±1 day; Home = now; End = expiry.
  - "Now" is stored as `target: null`, so it follows the clock on every tick. Any other value is stored as an absolute epoch. If a stored absolute target has passed, it snaps back to now.
- **IV shift**: range −10 to +10 vol points, step 0.5, additive.
  - Label: `IV +2.0 pts · ATM 14.0%`.
  - Applies to every leg's IV (floored at 1%). It feeds the target curve, the greeks, PoP, EV, the stress loss and the σ distances. It does **not** change the expiry payoff or the entry prices.
- `Reset` sets both back to now and 0 and is shown only when either is non-default.
- Rendering: slider `input` events schedule one rAF draw (chart paths, tiles, table). They make no network calls and are not persisted until `change` (pointer up).
- **Model note** under the chart, one muted line:
  `Theoretical · Black-76 on forward 26422 · leg IVs +2.0 pts · r 0 · to 15:30 IST · skew and supply move real prices`

### 8.4 Scenario table
- Rows: S levels. Mode `%` (default) gives spot × (1 + k/100) for k ∈ {−3, −2, −1, −0.5, 0, +0.5, +1, +2, +3}. Mode `σ` gives F·e^{kσ√T} for k ∈ {−2, −1.5, −1, −0.5, 0, 0.5, 1, 1.5, 2}.
- Columns: Price · Move · At target · At expiry. All P&L follows the net-of-charges toggle.
- The 0 row is emphasised. Cells are coloured by sign (green/red text, no fill).
- A mode switch (`% | σ`) sits in the table head and is persisted.
- The table is also the accessible alternative to the chart (§16).

---

## 9. Payoff visual and chart-engine slot

### 9.1 Interface (`payoff.js`)
```
O.payoffModel(legs, ctx, { target, ivShift, net }) ->
  { xs[], expiry[], target[] | null, breakevens[], band1: [lo, hi] | null, band2: [lo, hi] | null,
    spot, forward, strikes[], yMin, yMax, lo, hi }
drawPayoff(host, model, { onPin(price) }) -> { update(model), destroy() }
```
- `payoffModel` is pure, lives in options.js and is tested.
- `drawPayoff` is the only code that knows SVG. When the owner's engine arrives, it replaces `drawPayoff` without touching the maths.
- `update` patches the existing path `d` attributes and markers and does not rebuild the SVG.
- x-range: same rule as today (the max of 2.6·move, 1.35·|K − spot| and 1.5% of spot each side), so it stays stable across ticks. Recompute only when the legs or ATM change.
- ≤ 241 sample points plus every strike.

### 9.2 Visual rules
- Expiry line: solid foreground. Target line: dashed blue. ±1σ band: fill. ±2σ: dashed outline only.
- Spot: blue dashed vertical with its label at the top.
- Breakevens: dots on zero, with labels under the zero line. Labels closer than 44 viewBox px are staggered.
- x ticks from `niceTicks`; y ticks `formatCompact`.
- Readout:
  - Fine pointer: hover.
  - Coarse pointer: tap pins the crosshair and dragging moves it (`touch-action: pan-y` stays so the page still scrolls vertically). Tap outside unpins.
  - Text: `26550 (+0.6%)  Target +₹1240  Expiry +₹3169`.
- Keyboard: the SVG has `tabindex=0`. ←/→ move the pinned price by one step, Shift+←/→ by 10 steps, Esc unpins.

### 9.3 Chart-engine slot (placeholder, MUST)
- Panel `data-panel="price-chart"`, collapsed by default into one 44 px row: `Price chart · chart engine slot` plus a muted "Your strikes, breakevens and ±σ will overlay here once the chart engine is connected."
- When expanded, an empty 240 px region with a hairline outline and the same text.
- It exposes `host.dataset.chartSlot = "strategy"` and a documented payload getter `window.__mcbStrategyOverlay?.()` returning `{ underlying, strikes, breakevens, band1, band2, spot }`. This is a no-op until the engine exists.
- No chart library is added.

---

## 10. Warnings (`O.strategyWarnings(ctx)` → `[{ code, severity: "block"|"warn"|"info", text }]`, pure and tested)

Shown under the metric strip (max 3, then "+n more") and in full in the confirm sheet.

| Code | Severity | When | Text |
|---|---|---|---|
| NO_PRICE | block | an active leg has p = null | `26800 CE has no price` |
| NOT_IN_CHAIN | block | a leg's strike is not in the fetched rows | `26800 CE is outside the loaded strikes` |
| NO_SYMBOL | block | a leg has no symbol | `Contract not found` |
| SHORTFALL | warn (block when live) | margin required > free funds | `Short of margin by ₹12.4K` |
| NAKED | warn | max loss Unlimited | `Unlimited loss above 27000: stress −₹48.2K at +2σ` |
| EXPIRY_DAY_SHORT | warn | short legs expiring today (IST) | `Expiry day: +2% ELM on shorts and fast gamma` |
| BE_OUTSIDE_1S | info | debit strategy with every breakeven beyond ±1σ | `Needs a move beyond 1σ to break even` |
| STT_TRAP | warn | a long ITM leg where 0 < intrinsic − premium < exercise STT, or exercise STT > 20% of intrinsic P&L, at spot | `26350 CE: exercise STT ≈ ₹X at expiry; square off before 15:30` |
| WIDE_SPREAD | warn | `spreadPct > 5` on any leg | `26800 CE spread 7.1%` |
| FREEZE | info | lots × lotSize > freezeQty | `26000 PE goes in 3 slices (freeze 1800)` |
| HEDGE_EXPIRES_FIRST | warn | an option leg expires before a FUT leg | `The hedge expires before the future (3 Nov vs 24 Nov)` |
| LEGS_CAP | info | 12 legs reached | `Up to 12 legs` |

`freezeQty` comes from `preview.resolved.freezeQty` (already returned).

---

## 11. Safe placement (`strategy-place.js`)

### 11.1 Confirm sheet (key `Shift+P` or the Place button; it never sends directly)
- Title: `Place Iron condor · NIFTY 3 Nov` (or `Place 4-leg strategy`).
- Summary row: Net · Max loss · Margin · Free after (= free − required).
- Legs table **in placement order**: `# · Side · Contract · Lots (qty, slices) · Limit [input] · Preview status dot`.
  - The limit input defaults to the basis price snapped to tick (`O.roundToTick` toward the passive side).
  - `Bid / Mid / Ask` quick buttons appear in a per-row overflow on phone and inline on desktop.
- Warnings list (§10). Any `block` warning disables Place.
- Product: Intraday | Carry. Mode: Paper | Live, only if allowed, with the live acknowledgement checkbox (unchanged gate).
- Hedge wait: `5 s | 15 s | 30 s` (persisted, default 15).
- **Re-quote**: while open, the touch is re-read on every tick. If any leg's touch moved more than max(2 ticks, 1%) away from its limit, a line reads `Prices moved on 2 legs · Use new prices`.
- Pre-flight: on open, `POST /v1/orders/preview` runs for every leg in parallel. A `block` check on any leg disables Place and shows the server's message on that row.
- Button: `Place 4 legs · hedges first` (`danger` style and `· LIVE` in live mode).

### 11.2 Order of legs (`O.placementPlan(legs, "entry" | "exit")`)
- Entry: BUY OPT (furthest from spot first, the cheapest hedges) → BUY FUT → SELL FUT → SELL OPT (nearest to spot last).
- Exit: the reverse risk order. BUY back short OPT → SELL long OPT → FUT legs.
- Pure and tested.

### 11.3 State machine (per leg: `queued → sending → open → filled | partial | rejected | cancelled | unknown | timeout`)
1. Each leg is sent as `POST /v1/orders` with `{ account, symbol, side, lots, product, orderType: "LIMIT", price, clientOrderId: "strat-<batch>-<i>", tag: "mcbstrat", mode? }`.
   - Freeze slicing is server-side (the order's `legs[]`). The UI shows slices only.
2. **Hedge phase** (every BUY leg, plus FUT legs):
   - After each POST, poll `GET /v1/orders/{orderId}` every 500 ms until `filledQuantity === quantity` (`filled`), a terminal state, or the hedge wait expires.
   - The next leg is sent only after the previous one is `filled`.
3. **Short phase**: SELL OPT legs are sent sequentially. Each waits only for acceptance (not `rejected`). The page then polls all of them for up to the hedge wait to report the final state.
4. **Timeout on a hedge**: progress pauses with three choices:
   - `Wait 15 s more`
   - `Cancel it and stop` (`DELETE /v1/orders/{id}`)
   - `Send the shorts anyway`: secondary danger style, requiring a second confirm click with the text "The short legs will be unhedged until this fills".
5. **Rejected, refused or failed POST**: stop. No further legs are sent.
6. `outcome_unknown`, or a network error after POST: look up `GET /v1/orders/by-client-id/{clientOrderId}` before deciding. Never resend blindly.

### 11.4 Progress, partial state and exit
- The confirm sheet turns into a progress view in place: per-leg status chip, filled/qty, average price. An `aria-live=polite` line reads "Leg 2 of 4 filled".
- **All filled**: "Strategy placed · net ₹3169 credit". Buttons: `Close` and `View positions`. Funds and positions are refreshed.
- **Partial**: "Placed 2 of 4 · hedges in, shorts not sent". Actions:
  - `Retry leg 3`
  - `Cancel open orders`
  - `Unwind filled legs`: an exit plan over the filled quantities, shorts first, as MARKET with `marketProtectionPct` from server defaults, or LIMIT at the touch when MARKET is refused. It shows its own confirm with the list.
  - `Keep as is`
  - None of these is automatic. Live mode still needs the same acknowledgement.
- **Analysed positions**: when the draft came from Analyse (every leg has `entry`), the Place button becomes `Close these legs`. It uses the exit plan, the same confirm and the same state machine.

---

## 12. Data and API

### 12.1 Existing endpoints used
| Need | Call | When |
|---|---|---|
| Chain, IV, greeks, lot size | `GET /v1/optionchain?...&greeks=true` (existing loader) | every 3 s, unchanged |
| Expiries | `GET /v1/expiries` | unchanged |
| Future instrument | `GET /v1/instruments/search?q=<U>&underlying=<U>&kind=FUT` → the first with expiry ≥ option expiry (gives lotSize, freezeQty) | on underlying or expiry change; cached per underlying |
| FUT quote | `GET /v1/quotes?symbols=<fut>` | each tick, **only while a FUT leg exists or the picker is open** |
| Funds | `GET /v1/funds?account=` (`availableCash`) | page entry, account change, after placement |
| Per-leg checks, freeze, margin | `POST /v1/orders/preview` | debounced 400 ms after the legs change (not on ticks), and on confirm open |
| Place / poll / cancel | `POST /v1/orders`, `GET /v1/orders/{id}`, `GET /v1/orders/by-client-id/{id}`, `DELETE /v1/orders/{id}` | placement only |
| Positions | `GET /v1/positions` (existing) | unchanged |

### 12.2 Server addition (MUST, small): margin on paper previews
- `PreviewResult` gains `margin: { required: number | null, source: "paper-model" | null } | null`.
- When the preview is answered for a paper account, `required` = the paper engine's margin for the exposure this order **adds** (the same `marginFor` plus closing-quantity logic used when it fills: `paperEngine` already has "margin for the part of an order that adds exposure"; export it as `estimateOrderMargin(accountId, order, price)`).
- For broker accounts: `null` (LATER: broker basket-margin adapters).
- Tests: `orders/routes.test.mjs` covers a SELL option preview with a number, a BUY with premium, a closing order with 0, and a broker account with null. Document it in `docs/openapi.yaml` under `PreviewResult`. Restart the demo Bridge after the change.

---

## 13. Settings (persisted in `mcb.dashboard.desk` under `strategy`, via `strategyConfig(saved)` with defaults and validation, like `chainConfig`)

| Key | Values | Default |
|---|---|---|
| `group` | bull, bear, neutral, vol, hedge | neutral |
| `basis` | touch, mid, ltp | touch |
| `net` | include charges | true |
| `metrics` | ordered list from {net, maxProfit, maxLoss, breakevens, pop, margin, atTarget, rom, rr, delta, gamma, theta, vega, ev, charges} | net, maxProfit, maxLoss, breakevens, pop, margin, atTarget, theta |
| `scenario` | pct, sigma | pct |
| `product` | MARGIN, INTRADAY | MARGIN |
| `hedgeWait` | 5, 15, 30 | 15 |
| `moreOpen` | phone "More figures" open | false |

- `Customise` (gear in the builder head, same popover pattern as the chain) has: a metric list with checkboxes, drag and ↑/↓ reorder (reuse the chain popover's list code), the price basis segmented control, the charges toggle, the hedge wait, and `Reset`.
- The default is at most 8 metrics; at least 1 must stay on.
- Unknown keys are dropped and invalid values fall back to defaults (tested).

---

## 14. Save and reload

- Storage: `localStorage` `mcb.dashboard.strategies` = `{ v: 1, items: Saved[] }`, max 50. Every read and write is in try/catch; the page works without storage. Saving the 51st asks the user to delete one.
- `Saved = { id, name ≤ 60, underlying, expiry, legs: Leg[] with entry = price at save, ivAtSave per leg, spotAtSave, forwardAtSave, target, ivShift, savedAt (ISO), notes ≤ 500 }`.
- **Save** (`Ctrl/Cmd+S`): a small dialog with the name (defaults to the preset name or `Custom 4-leg`) and notes. Saving with an existing name asks "Replace?"
- **Saved (n)** opens a list (popover on desktop, sheet on phone). Each row:
  - Name; `NIFTY 3 Nov · 4 legs · credit ₹3169 · saved 28 Oct 14:05`.
  - **Since saved**: `+₹820`, valued at the live touch to exit, available when the saved expiry is the loaded chain's expiry; otherwise `open to price`.
  - Actions: `Load`, `Rename`, `Delete` (with Undo).
- **Load**: switches the toolbar to the saved underlying and expiry (which triggers the normal reload), then sets the draft.
  - Toggle `Prices: Live | Saved`. Live drops `entry`; Saved keeps `entry` = the snapshot, so the payoff is the P&L from the saved entry.
  - Expired saves (expiry < today IST) show `Expired` and load at saved prices only, read-only, with Place disabled.
  - Legs whose strike is no longer listed trigger NOT_IN_CHAIN.
- **Export / Import** (in the list footer):
  - Export downloads `strategies.json` via a Blob link.
  - Import takes a file input. It is validated by `O.normaliseSaved(obj)`: enums, finite numbers, ≤ 12 legs, ≤ 50 items, strings trimmed and capped, unknown fields dropped, ids regenerated on clash.
  - The result toast reads `Imported 3 · skipped 1 (invalid)`.

---

## 15. Keyboard (strategy page; ignored while typing in an input, or while a dialog is open unless the dialog owns the key)

| Key | Action |
|---|---|
| `A` | open the strike picker |
| `[` / `]` | shift all strikes down / up one step |
| `Shift+P` | open the confirm sheet |
| `Ctrl/Cmd+S` | save |
| `Ctrl/Cmd+Z` | undo the last preset, clear, remove or load |
| `1`–`5` | choose the preset group |
| `T` | focus the target-date slider |
| `?` | shortcut help overlay |
| `P` | pause/resume live (existing) |

The chain-page keys stay as they are. The key hint strip under the builder lists `A [ ] ⇧P ? `, and is hidden on coarse pointers.

---

## 16. States, accessibility, performance

**States**
- **Loading chain**: the builder skeleton keeps its layout. Tiles show `…`, and the chart area shows "Loading the chain…".
- **Chain error**: `alertBox` in the builder. The legs stay visible; figures show `--`.
- **Empty draft**: presets plus the picker button, and one line: "Pick a strategy, add legs with + Add leg (A), or press ⇧B / ⇧S on the chain." The analysis column shows a muted outline of the chart area, not a blank gap.
- **All legs off**: "All legs are switched off."
- **No tradable account**: Place is disabled with the title "Choose an account that can place orders". Analysis still works.
- **Stale or paused data**: the existing clock state, plus the sub-line "prices paused" in the builder head.
- **Funds or preview failed**: the estimate only, with a title tooltip. This never blocks analysis.

**Accessibility**
- The metric strip is a `dl`; each tile is a `dt`/`dd`.
- Sliders are labelled with `aria-valuetext`. The B/S, CE/PE and on/off controls have explicit `aria-label`s naming the contract.
- The chart is `role="img"` with an `aria-label` summary ("Max profit ₹3169, max loss ₹11831, breakevens 25958 and 26842"). The scenario table is the data alternative.
- The placement progress is `aria-live`.
- The focus order is: presets → legs → tools → metrics → chart → what-if → table.
- `prefers-reduced-motion`: no transitions.
- Contrast uses the existing tokens in both themes.

**Performance budget**
- Full payoff model: ≤ 12 legs × ≤ 260 points × 2 curves, under 2 ms.
- Slider drag: one rAF per frame, ≤ 16 ms on desktop.
- Tick patch: ≤ 4 ms.
- Previews only on leg changes (debounced) and on confirm.
- FUT quotes only when needed.
- No DOM rebuild on ticks (C2).
- Glyphs are recomputed only on group change or ATM move.

---

## 17. Test plan

### 17.1 Unit (`options.test.mjs`): new or changed pure functions
- `legUnits` per-leg lot size; `migrateLegs`; `activeLegs`.
- `payoffAt` and `valueAt` with FUT legs and basis decay; `valueAt` with a target past a leg's expiry falls back to intrinsic; the IV shift raises the long-straddle value.
- `strategyStats`:
  - naked short put max loss is finite = (K − p)·u (C7);
  - short call is Unlimited;
  - long FUT + long put has a finite floor and unlimited profit;
  - butterfly breakevens are exactly 2 with no duplicates;
  - a breakeven at a strike counts once;
  - a box is locked (maxProfit ≈ maxLoss);
  - the net-of-charges shift moves the breakevens outward for a long straddle.
- `strategyStats` PoP: long call PoP equals 1 − N(d2(BE)) within 1e-6; a short strangle PoP lies between 0 and 1 and goes down as the IV shift goes up.
- `expectedValue`: a long call at fair Black-76 price gives EV ≈ 0 (|EV| < 0.5% of premium).
- `black76Greeks` against finite differences of `black76` (Δ, Γ, ν, θ within 1e-3 relative); put-call parity of deltas (Δc − Δp = 1). `netGreeksModel` sign conventions; FUT Δ = 1.
- `charges`: a hand-computed NSE 1-lot sell, a BSE buy, GST on the right base; exercise STT at an ITM price.
- `marginEstimate`: iron condor = |maxLoss|; short strangle = scanLoss + 2%; the expiry-day add-on applies only when the expiry is today.
- `presetLegs` for all 30: leg count, rights, sides and ratio lots on a synthetic chain; strikes are listed; needsFut presets return [] without a fut. `presetGlyph` gives ≤ 8 points within the box.
- `shiftLegs` at the chain edges; `placementPlan` entry and exit order; `strategyWarnings` for each code; `normaliseSaved` rejects bad enums, NaN and > 12 legs, and caps strings; `strategyConfig` defaults and validation; `sigmaBand`; `payoffModel` shape and its stable x-range.

### 17.2 Server
`orders/routes.test.mjs`: preview `margin` for paper SELL, BUY and closing orders, and null for a broker account. The openapi lint/contract test passes.

### 17.3 Playwright (copy `scratchpad/desk.cjs` → `scratchpad/strategy.cjs`; save to `scratchpad/shots/`; open every PNG)
For each size (390×844, 820×1180, 1440×900) × light and dark:
1. Empty draft.
2. Iron condor applied.
3. Hedge & arb → Collar (FUT leg present).
4. Target slider moved to the middle with IV −3. The tiles change and a dashed target line is visible.
5. Strike picker open.
6. Confirm sheet with warnings (short strangle on the paper account).
7. Placement progress finished (paper).
8. Saved list with 2 items.

Assertions in the script:
- `document.documentElement.scrollWidth <= innerWidth`.
- No tile `scrollWidth > clientWidth`.
- The sticky bar does not overlap the last scenario row (bounding boxes).
- Every button and input on a coarse pointer (phone emulation with `hasTouch`) is ≥ 44 px tall.
- No console errors.
- After placement, `GET /v1/orders?account=demo-paper` shows the BUY legs' `placedAt` earlier than the SELL legs'.

### 17.4 House rules
`npx vitest run server/bridge/dashboard` (format rules: no `toFixed(` etc.; new files added to `format.test.mjs` and `DASHBOARD_FILES`), then the full `npx vitest run` and `npm run -s check:mjs`.

---

## 18. Priorities

### MUST (this round)
1. **M1 Refactor**: `strategy.js`, `strategy-place.js` and `payoff.js` split out of desk.js. Build once, patch on ticks (C1, C2). Data model v2 with migration and per-leg lot size and on/off (§5).
2. **M2 Maths fixes**: finite downside max loss (C7), de-duplicated breakevens (C8), no zero-price fallback (C5), 0-decimal rupees (C9).
3. **M3 Presets**: 30 presets in 5 view groups with glyphs, active state and Undo (§7, C15).
4. **M4 Building**: strike picker with a FUT row; per-leg strike, right, side, lots and on/off controls; shift strikes; scale lots (§8.1, §8.2). FUT legs via instrument search plus quotes (§12.1).
5. **M5 What-if**: target-date slider and IV shift driving the target curve, greeks, PoP, EV and stress; model note (§8.3, §6.4, §6.8).
6. **M6 Figures**: net, max profit/loss (+ stress when unlimited), breakevens with % and σ, PoP, at target, Δ/Γ/θ/ν model greeks, ROM, R:R, EV, charges plus the net-of-charges toggle, locked P&L with implied rate (§6).
7. **M7 Margin and funds**: server `preview.margin` for paper (§12.2), hedged estimate, free funds, shortfall (§6.11).
8. **M8 Scenario table** with % and σ modes (§8.4).
9. **M9 Warnings** (§10).
10. **M10 Safe placement**: confirm sheet with editable limits and re-quote; hedges waited to filled; timeout choices; partial state with cancel, unwind and retry; exit plan for analysed positions (§11).
11. **M11 Save/reload**: named saves, live vs saved prices, since-saved P&L, expired handling, JSON export/import (§14).
12. **M12 Settings**: metric strip add/remove/reorder, basis, charges, scenario mode, product, hedge wait, all persisted (§13).
13. **M13 Responsive**: desktop, tablet and phone layouts, leg cards, sticky action bar, no truncation, touch pin and drag on the payoff, 44 px targets (§4, §9.2).
14. **M14 Chart-engine slot** placeholder panel (§9.3).
15. **M15 Keyboard + a11y + tests** (§15, §16, §17).

### LATER
- Multi-expiry legs: calendars and diagonals with a second chain fetch per extra expiry; a per-leg expiry picker; the expiry-day "no calendar benefit" warning.
- Per-leg IV override and per-leg custom entry price.
- Skew-aware PoP (IV at each breakeven); P(touch); Monte Carlo P50.
- Broker basket-margin adapters (e.g. a Kite `/margins/basket` "required vs final") behind a `basketMargin` capability; a `POST /v1/orders/preview/basket` endpoint.
- Share link (`#/strategy?s=<base64url>`); server-side saved strategies synced across devices; saved-strategy P&L tracking with adjustments.
- Strategy wizard / optimiser (view + target → ranked strategies); comparing two strategies side by side.
- Heatmap scenario grid (price × date); a P&L-vs-IV curve; Greek-vs-price curves.
- Strategy-level automation (entry trigger, SL/TP, trailing).
- Position-limit and OI warnings on very large quantities; an editable charge-rate table in settings; a duplicate-leg button; preset favourites.

---

## 19. Out of scope
- Any chart library, and any price or time chart. Only the labelled placeholder slot (§9.3). The owner supplies the engine.
- Atomic multi-leg (combo) orders: not available through these broker APIs. Sequential, confirmed legging is the design.
- Changing safety gates, live-mode opt-ins, rate limits or confirmation tickets.
- Backtesting, historical replay and simulators.
- Stock options with physical settlement (index underlyings only this round; the demo has NIFTY, BANKNIFTY and SENSEX).
- Real SPAN computation. Margin is the account's own figure (paper) or a labelled estimate.
- Tax computation beyond the statutory charges in §6.10.

---

## 20. Suggested build split (three agents in parallel, minimal file overlap)

| Agent | Owns | Delivers |
|---|---|---|
| **A: maths + server** | `options.js`, `options.test.mjs`, `orders/*`, `paper/*`, `docs/openapi.yaml` | Every pure function in §5–§8, §10, §11.2, §13 (`strategyConfig`) and §14 (`normaliseSaved`), with tests. M2. The server preview margin (§12.2) with tests and a restart. Agent A lands first, or publishes function signatures in the first commit so the others can code against them. |
| **B: builder UI** | `strategy.js`, desk.js wiring, the `12d` CSS for the builder | M1 (split), M3, M4, M5 UI, M6 tiles, M8, M11, M12, the warnings display, the phone, tablet and desktop layout. |
| **C: chart + placement** | `payoff.js`, `strategy-place.js`, the CSS for the payoff, confirm sheet and sticky bar | §9 (interface, touch pin, labels, slot panel), M7 display, M10, the sticky action bar, the Playwright script and screenshots for all sizes and themes. |

Integration order: A's signatures → B's skeleton (structure built once) → C plugs `drawPayoff` and `openPlacement(legs, ctx)` into B's slots → joint screenshot pass → full test run → commit.
