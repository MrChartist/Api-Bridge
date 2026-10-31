# PRD 01: Option Chain (core), page `#/chain`

Status: ready to build · Owner: Options desk · Round 1
Files: `server/bridge/dashboard/desk.js` (createChain, CHAIN_COLUMNS / CHAIN_PRESETS / chainConfig, onKey, openTicket, drawStats), `options.js` (+ `options.test.mjs`), `app.css` (12b · OPTION DESK), new `chain-sheet.js` (action sheet).

This round improves the chain that already exists. It is not a rebuild. The existing chain already does a lot: it builds the table once and patches cell by cell, has 15 columns, three presets, the Customise popover, the spot row, ±1σ, max pain, walls, keyboard trading and the ticket with preview. All of that stays. This round fixes one real bug (the table rebuilds when ATM moves). It then adds persona presets with the numbers each persona decides on, strike search, a phone layout that fits, a tap-to-act sheet, and the safety warnings that stop common mistakes.

---

## 1. Goals per persona

| Persona | Job on this page | Must see without scrolling sideways | Mistakes the page must prevent |
|---|---|---|---|
| **Buyer** (directional, expiry-day scalper) | Pick strike and expiry, enter fast, size by rupees at risk | LTP + change %, breakeven and the % move it needs, chance of profit, delta, theta ₹ per lot per day, IV against ATM IV, spread | Buying far-OTM strikes with wide spreads; ignoring theta at 0–1 DTE; market orders on illiquid strikes; buying an IV well above the smile |
| **Seller** (strangles, iron condors) | Find 16Δ/30Δ or 1σ strikes, collect credit | Distance from spot (% and σ), seller PoP, delta, premium ₹ per lot, theta ₹ per lot, OI and walls, OI change | Selling inside the expected move; selling an illiquid strike; naked shorts on expiry day (+2% ELM); exceeding freeze qty |
| **Hedger** (holds futures or stock, buys puts or collars) | Hedge N lots of delta, roll | Delta, lots needed to neutralise the current position delta, cost as % of spot, protection floor (breakeven), distance | Wrong lot count; a hedge that expires before the risk does (weekly vs monthly) |
| **Arbitrageur** (conversion, reversal, box, basis) | Find parity breaks per strike | Synthetic forward per strike (mid and executable), deviation vs the real future or the chain forward in points and ₹ per lot, executable edge, bid/ask both legs | Trading on one-sided or stale quotes; legging risk; forgetting STT on ITM exercise |

Success for this round:
1. Each persona gets its own preset, one click (or key `1`–`5`) from the toolbar, with their decision numbers in it.
2. A 390 px phone shows one side that fits the screen with no horizontal scroll. One tap on a row gives Buy and Sell.
3. No full table rebuild during a session on one underlying and expiry. Scroll position, focus and flashes survive every refresh.
4. A refresh tick costs 8 ms or less of main-thread time for 81 strikes with the widest preset on desktop.

---

## 2. Current implementation: keep, change, add, remove

### Keep (unchanged in behaviour)
- Build once, then patch per cell with `td.__sig`. LTP flash on change.
- `CHAIN_COLUMNS` and their `v`/`r` contract; `bid`/`ask` trade buttons that open `openTicket` (preview, then place; paper by default, with the live acknowledgement).
- Customise popover: column list, drag and arrow reordering, bars, % sub-line, lots, ITM, positions, compact rows, tags. Reset.
- Spot row inserted between the bracketing strikes. ITM shading. 16Δ/30Δ highlight. ±1σ band tint on the strike column. Unusual-volume "hot". Held lots beside the LTP. Build-up chips.
- Sticky thead and tfoot. Totals and PCR in the footer.
- Existing keys: `j`/`k`/↑/↓, `h`/`l`/←/→, `g`, `b`/`s`, `B`/`S`, `p`, `r`, `Esc`.
- The summary tiles (spot and synthetic future, ATM IV, expected move, straddle, PCR, max pain, put wall, call wall).
- `FETCH_STRIKES = 40` each side and `REFRESH_MS = 3000`.

### Change
| # | What | From | To |
|---|---|---|---|
| C1 | **Window bug.** The table key includes the windowed strike list, so the table rebuilds whenever ATM crosses a strike. That loses scrollTop and flashes, and `centred` stays true. | key = underlying\|expiry\|windowed strikes | Build **every fetched row** once. key = `underlying\|expiry\|allStrikes\|layoutSig`. The ±N window is applied by toggling `tr.hidden`, never by rebuilding (§7.1). |
| C2 | Strikes control | ±8 / ±12 / ±20 | **±10 / ±20 / All**. Migration: saved "8" or "12" becomes "10", "20" stays "20". Default "10". |
| C3 | Toolbar presets | OI / Greeks / Value | **OI · Buyer · Seller · Hedger · Arb**. Greeks and Value move to the preset row inside Customise ("More presets"). |
| C4 | Time value (`ext`) | intrinsic against **spot**, clamped at 0 | Intrinsic against the **forward F**, consistent with P(ITM) and expected move. Not clamped: a value below −1 tick prints in red, with the title "Below intrinsic on the forward: parity break or stale quote". |
| C5 | PCR on ΔOI | null whenever either side's ΔOI total ≤ 0 (common intraday) | Tile sub-line shows **net ΔOI = ΣPE ΔOI − ΣCE ΔOI** (signed, compact) instead of a ratio. The ratio is still shown when both totals are > 0. |
| C6 | "Whole chain" wording | footer and tile titles say "whole chain" | Say "over the N strikes loaded (±40 around ATM)". N = rows.length. |
| C7 | `drawStats`, `chainTitle` | `replaceChildren` on every tick | Built once and patched by signature (same pattern as cells). |
| C8 | Flash | `void td.offsetWidth` reflow per changed LTP | Collect changed cells during patch, then apply them in **one rAF**. Restart the animation by alternating two identical keyframe names (`flash-up`/`flash-up2`, `flash-down`/`flash-down2`), with no forced reflow. Respect `prefers-reduced-motion: reduce` (no animation). |
| C9 | Bars | `style.width = x%` | `style.transform = scaleX(f)` with a fixed-width track and `transform-origin` at the strike side. Bars are only rewritten when their value or the max changes (already guaranteed by the cell signature). |
| C10 | Below 720 px | `.opt-x` hidden, both sides still rendered → horizontal scroll | Phone layout §4.3: one side by default, ≤ 3 data columns, no quote buttons, row tap opens the action sheet. |
| C11 | 720–1099 px | desktop table overflows | Tablet layout §4.2: `.opt-x` hidden, dense rows on fine pointers, 44 px rows on coarse pointers, quote buttons replaced by the sheet on coarse pointers. |
| C12 | Expected-move tags | ±1σ from `F ± sigmaMove` (symmetric approximation) | Log-normal band `F·e^(±k·σ√T)` for k = 1 and 2 (`O.sigmaBand`). Adds ±2σ tags. |
| C13 | OI wall | single largest OI strike per side | **Top 3 per side**: rank 1 gets the strong wall style and the Support/Resistance tag; ranks 2–3 get a lighter bar style, no tag. |
| C14 | Refresh when the tab returns | the interval only resumes on its next tick (up to 3 s) | On `visibilitychange` to visible, refresh immediately (desk-local listener, removed when the page leaves). |

### Add (MUST this round; details in later sections)
Persona presets and their computed columns (§5); row-level ("centre") parity columns; strike search and jump (§7.2); "Back to ATM" pill (§7.3); phone side switch, swipe, and the action sheet (§4.3, §8.2); sticky strike column (§4.4); trade warnings in the ticket (§8.4); expiry-day chip (§6.4); the real future and index change in the spot row (§6.1); new keys (§8.3) with a `?` help overlay; a roving tabindex and live region (§11).

### Remove
- The three-button side toggle in the table side-head (`‹ Calls` / `Puts ›`) **stays on desktop and tablet**. On phone it is replaced by the sticky segmented control, so it is not drawn there. No duplicate controls on any one viewport.
- The `void years;` dead line in `drawStats`.
- Nothing else is removed. Every existing column remains available in Customise.

---

## 3. Information architecture of the page

Order of panels (top-level children of `#content`; movable panels already work):

1. `desk-top` (fixed): underlying · expiry · account · clock · Live. No change.
2. `summary`: the stat tiles.
3. `chain`: the chain head, then the table wrap, then the keys legend.

Chain head, left to right on desktop:

`[NIFTY 3 Nov · 5d · lot 75 · EXPIRY TODAY?]  ......  [Go to strike ⌕ /] [±10 ±20 All] [OI Buyer Seller Hedger Arb] [⚙ Customise]`

- The expiry-day chip appears only on expiry day (§6.4).
- The search input is 120 px wide on desktop. The placeholder "Strike, +3, 1σ" shows a `/` kbd hint on fine pointers.

---

## 4. Layout per device

Breakpoints: phone ≤ 719 px, tablet 720–1099 px, desktop ≥ 1100 px. Pointer type is detected separately: `(pointer: coarse)` turns on 44 px targets at any width. Reference sizes: phone 390×844, tablet 820×1180, desktop 1440×900. **No horizontal page scroll at any size.** Only `.chain-wrap` may scroll sideways, and only on desktop with a custom column set wider than the viewport.

### 4.1 Desktop (1440×900)
- Both sides, mirrored around the strike, each with up to 7 preset columns plus Bid/Ask when `quotes` is on.
- Arb preset: a centre group (Synthetic, Dev, Edge) sits immediately right of the strike and shares the strike column's fill. It has its own side-head cell, "Parity".
- Row height `--desk-row` (34 px, 28 px compact). The `.chain-wrap` max height stays `min(70vh, 860px)`. Maximised panel: full height (exists).
- Tiles: one row, auto-fit (exists).
- Keys legend below the table (exists). Gains `/ search`, `1–5 view`, `? keys`.

### 4.2 Tablet (820×1180 portrait, 1180×820 landscape)
- Both sides. Columns marked `opt-x` are hidden at ≤ 1099 px, so each preset shows at most 5 inner columns per side in portrait.
- Fine pointer: quote buttons on, rows 34 px.
- Coarse pointer (iPad): quote buttons **off** (tap the row to open the sheet), rows 44 px, strike column 80 px.
- Tiles: a single horizontally scrollable row (`overflow-x: auto; scroll-snap-type: x proximity`), tile min-width 128 px. The page itself does not scroll sideways.
- Toolbar presets: the segmented control fits at 820. Customise label collapses to the icon (`aria-label` kept).

### 4.3 Phone (390×844)
- **Side**: setting `phoneSide` (separate from desktop `side`, so each device keeps its own), default `"ce"`. A segmented control **Calls | Puts | Both** is pinned (sticky top 0) directly above the table's header rows, inside the chain panel, 36 px tall.
- **Swipe**: on `.chain-wrap`, a horizontal touch swipe where |dx| ≥ 56 px and |dx| > 2|dy| switches Calls ↔ Puts (left swipe = Puts). It does nothing in Both. Implement with `touchstart`/`touchend` and passive listeners. Vertical scroll is unaffected.
- **Columns**: strike (sticky left, 76 px) plus the first **3** columns of the active preset that are not `opt-x` and not quote buttons. Arb preset on phone: strike plus the 3 centre columns, with sides hidden and the segmented control disabled ("Parity view").
- **Both on phone**: LTP + OI per side, mirrored (5 columns). OI bar on, % sub-lines kept.
- Rows 44 px. Tags under the strike limited to 2 (ATM first, then the highest-priority one: Max Pain > walls > σ).
- **Tap a row** opens the action sheet (§8.2) for that strike and the visible side (in Both, the tapped half decides the side).
- Tiles: horizontally scrollable single row as on tablet.
- Chain head: title on line 1. Line 2 holds the search icon button (expands to the input), the Strikes select, the Preset select (a `<select>` replaces the 5-segment control at ≤ 719 px), and the Customise icon.
- Keys legend hidden (exists on coarse pointers; also hide ≤ 719 px).
- Safe areas: the sheet pads its bottom by `env(safe-area-inset-bottom)`.

### 4.4 Sticky strike column (all sizes)
- One side: the strike column comes first, `position: sticky; left: 0; z-index: 2`, with an opaque `--mat-grouped-solid` fill over the tint layers.
- Both sides: the strike column gets `position: sticky; left: 0; right: 0`, so it stays inside the viewport whichever way the wrap scrolls. The thead and tfoot strike cells get z-index 4.
- Draw rules as inset box-shadows (house rule). No `border`.

---

## 5. Columns: every number, formula and edge case

Notation: K strike; S spot (`underlyingLtp`); F forward (`O.forwardPrice`, which falls back to S); T years to expiry (`O.yearsToExpiry`); σ_leg the leg's IV/100; σ_ATM the ATM IV/100 (`sm.atmIv`); lot = `chain.lotSize` (1 when null); P premium = `O.mid(leg)` (mid when two-sided, else LTP); "--" is `DASH` from format.js. **All text goes through format.js.** Signs are OTM-positive where noted.

### 5.1 Existing per-side columns (unchanged unless noted)
| key | Label | Formula / content | Format | Edge cases |
|---|---|---|---|---|
| ltp | LTP | ltp, sub-line `changePct` | formatFixed 2; formatSigned 1 | no close → empty sub-line |
| iv | IV | iv | formatFixed 1 | null → -- |
| oi | OI / OI (lots) | oi ÷ unit, bar = oi / maxOi | formatCompact | top-3 rank styles (C13) |
| chg | OI chg | oiChange ÷ unit, sub-line `oiChangePct`; bar = abs ÷ maxOiChange | formatCompact signed | prev OI 0 → no % |
| vol | Volume | volume ÷ unit; "hot" when unusual | formatCompact | |
| bu | Build-up | `O.buildup` | LB/SB/SC/LU chip | zero change → -- |
| delta, gamma, theta, vega | as is | per unit | 2 / 4 / 1 / 1 dp | |
| pitm | P(ITM) | `O.probItm(F, K, T, iv, right)` | formatPercent 0 | T ≤ 0 or iv null → -- |
| ext | Time value | **P − max(0, ±(F − K))** (C4) | formatFixed 2; red if < −0.05 | P null → -- |
| spread | Spread | `O.spreadPct` | formatPercent 1; warn > 5, bad > 10 | one-sided → -- |
| liq | Liquidity | `O.liquidityScore` | 5 dots | |
| prem | Traded | volume × lot × LTP | ₹ + formatCompact | |
| bid / ask | Bid / Ask | trade buttons (Sell at bid, Buy at ask) | formatFixed 2 | null → -- disabled |

### 5.2 New per-side columns (MUST)
| key | Label (header) | Formula | Display | Edge cases |
|---|---|---|---|---|
| be | Breakeven | CE: K + P; PE: K − P. Sub-line: move needed = (BE − S)/S × 100 (signed: + means up) | formatInt(BE) when lot step ≥ 1 else formatFixed 1; sub formatSigned 1 + "%" | P null or S null → --; PE BE ≤ 0 → -- |
| pop | PoP buy | Buyer's chance of profit at expiry = `O.probItm(F, BE, T, iv_leg, right)` (P(S_T > BE) for CE, < BE for PE) | formatPercent 0 | iv null → use σ_ATM; T ≤ 0 → intrinsic test: 100 if S beyond BE else 0 |
| pops | PoP sell | 1 − pop (the seller keeps the premium unless S_T passes BE) | formatPercent 0 | as pop |
| potm | P(OTM) | 1 − pitm | formatPercent 0 | as pitm |
| dist | Distance | pts = CE: K − S, PE: S − K (OTM positive). Main: pts/S × 100. Sub: σ count = CE ln(K/F), PE ln(F/K), divided by σ_ATM·√T | main formatSigned 1 + "%"; sub formatSigned 1 + "σ" | σ_ATM or T null → sub empty; ITM shows negative |
| premLot | Prem/lot | P × lot (₹) | formatRupee 0 (≥ 1 L uses ₹ + formatCompact) | lot null → per unit, header "Prem" |
| thetaLot | θ/lot | theta × lot (₹ per day, negative for longs as quoted) | formatRupee 0, signed | theta null → -- |
| ivx | IV−ATM | iv − atmIv (vol points). Sub: none | formatSigned 1; text `warn-ink` when > +2 on the buyer preset | either null → -- |
| hedge | Hedge lots | `O.hedgeLots(netDelta, delta, lot)`: lots = ceil(abs(netDelta) / (abs(delta)·lot)), only when the leg's delta sign is **opposite** to netDelta. netDelta = Σ(netQty × delta) over held options of this underlying and expiry, plus netQty × 1 for held futures of this underlying. With no position, netDelta = +lot (hedge one long futures lot) and the header becomes "Lots / fut lot". | formatInt | delta null or abs(delta) < 0.02 → --; same-sign side → -- |
| costPct | Cost % | P / S × 100 | formatPercent 2 | S null → -- |

### 5.3 New row-level ("centre") columns (MUST): arbitrage
Reference price **R** = the LTP of the future whose expiry equals the chain expiry, when one exists (monthly). Otherwise R = F (the chain's median synthetic) and the header shows "vs F". Two-sided means bid > 0 and ask ≥ bid on **both** CE and PE.

| key | Label | Formula | Display | Edge cases |
|---|---|---|---|---|
| syn | Synthetic | K + mid(CE) − mid(PE). Sub: executable range: buy K + CE.ask − PE.bid, sell K + CE.bid − PE.ask, as "sell–buy" | formatFixed 1; sub "a – b" formatFixed 1 | sub only when two-sided, else main uses LTPs and the cell is quiet (muted) |
| dev | Dev | syn − R in points. Sub: (syn − R) × lot in ₹ | formatSigned 1; sub formatRupee 0 | R null → -- |
| edge | Edge | max(conv, rev): conv = syn_sell − R (sell synthetic, buy future: a conversion), rev = R − syn_buy (buy synthetic, sell future: a reversal). Positive only when executable at touch, gross of costs. Sub: "conv" or "rev". | formatSigned 2; positive values get the `pos` accent (not green: not a P&L) | not two-sided → --; R = F → title "vs chain forward: a relative break across strikes, not a futures arbitrage" |
| ivskew | IV P−C | PE.iv − CE.iv | formatSigned 1 | either null → -- |

All four live in `CHAIN_COLUMNS` with a new attribute `scope: "row"`. `layout()` returns `{ order, ce, mid, pe }`. Row cells are patched once per row (not per side).

### 5.4 Presets (from the strike outwards; `*` = `opt-x`, hidden ≤ 1099 px)
| id | Toolbar | Columns | Quotes default |
|---|---|---|---|
| oi | OI | ltp, iv, vol*, chg, oi, bu* | on |
| buyer | Buyer | ltp, be, pop, delta, thetaLot, ivx*, spread* | on |
| seller | Seller | ltp, dist, pops, delta, premLot, thetaLot*, oi* | on |
| hedger | Hedger | ltp, delta, hedge, costPct, be, dist*, vega* | on |
| arb | Arb | centre: syn, dev, edge, ivskew*; sides: ltp, iv* | **forced on** (bid/ask matter) |
| greeks | (Customise only) | ltp, iv, delta, gamma*, theta, vega*, pitm | on |
| value | (Customise only) | ltp, iv, ext, spread, liq*, prem* | on |

A preset sets `cols` (and for arb, `quotes: true`). Editing columns after picking a preset makes it "Custom": the segmented control shows no active segment, styled with the existing `.custom` class. Presets never change `side`.

---

## 6. Markers and totals

### 6.1 Spot row (existing, extended)
Content: `NIFTY 26370.10  −65.50 (−0.25%)  ·  Fut Nov 26479.55 (+109.45)`.
- Index change comes from `/v1/quotes` on the index symbol (§12). It is green or red as a gain or loss. When missing, it is left out.
- "Fut" shows only when the same-expiry future exists. Otherwise it shows "F 26401.2 (synthetic)". The bracket holds the basis to spot.
- Position: between the two strikes that bracket S (exists). It is not sticky in round 1.

### 6.2 Strike-column tags (priority order when space is short)
ATM > Max Pain > Support / Resistance (rank-1 walls) > ±1σ > ±2σ. ±2σ is new: the strikes nearest `F·e^(±2σ_ATM√T)`. Tag settings: `mp`, `walls`, `em` (±1σ and the band), `em2` (±2σ, default off).

### 6.3 Footer totals
Per side: Σ OI, Σ OI change (signed), Σ volume over the loaded rows (in lots when `lots` is on). Strike cell: `PCR 1.21`. Title: "Put OI ÷ call OI over the N strikes loaded". Centre arb columns: the footer shows median dev (points).

### 6.4 Expiry day
When `O.isExpiryDay(expiry, now)` is true (same IST date as the expiry and before 15:30 IST), the chain title shows an orange `Expiry today` chip with the title text: "Index option shorts carry +2% ELM today; no calendar-spread margin benefit; ITM longs left to exercise pay STT 0.125% of intrinsic. Square off to pay 0.1% of premium instead."

### 6.5 Tiles (patched, not rebuilt)
Unchanged set, except:
- The PCR tile sub becomes `Net ΔOI +1.2L · Vol 0.98`.
- The spot tile sub uses the real future when present: `Fut 26479.6 (+109.4)`. Otherwise it reads `F 26401 (syn)`.

---

## 7. Strike navigation

### 7.1 Window without rebuilds (fixes C1)
- Build every fetched row. Each tick, compute `visible = rowsAroundAtm(chain, N)` (N = 10, 20 or Infinity) and set `tr.hidden = !visible.has(strike)`.
- Before toggling, record the anchor: the focused row if it is visible in the viewport, else the first row whose bottom is below `wrap.scrollTop`. Record its `offsetTop − scrollTop`. After toggling, restore it, so rows appearing or disappearing above do not jump the view.
- The spot row's insertion logic only considers visible rows.
- Rebuild only when the strike set itself changes (new strikes listed) or the layout signature changes (columns, side, quotes, preset, device class). On rebuild, preserve scrollLeft (exists) **and** restore the anchor strike's offset as above.
- Device class changes (`matchMedia('(max-width: 719px)')` and `(pointer: coarse)` change events) call `chain.reset(true)` and redraw.

### 7.2 Strike search ("Go to strike")
An input in the chain head (`type=search`, `inputmode=decimal`, aria-label "Go to strike"). `/` focuses it; Enter jumps; Esc clears and blurs. Parsing is `O.strikeQuery(text, ctx)`, which is pure and tested. ctx = { strikes (sorted), atm, F, sigmaPts (σ_ATM·√T·F), maxPain }:

| Input | Meaning |
|---|---|
| `26400` | nearest listed strike to 26400 |
| `264` (fewer digits than the strikes and > 0) | nearest strike whose leading digits match, closest to ATM (264 → 26400) |
| `+3` / `-2` | 3 strikes above / 2 below ATM (by index) |
| `1s`, `-2σ`, `+1.5sd` | nearest strike to F·e^(k·σ√T) |
| `atm`, `mp`, `max pain` | ATM / max-pain strike |
| anything else | null → input shows `aria-invalid` and a red hairline; nothing moves |

On a hit:
1. If the strike is hidden by the window, switch the window to All for this view. This is not persisted: the Strikes control shows "All".
2. Scroll it to the centre of the wrap.
3. Set focus to { strike, side: current or "ce" }.
4. Add the class `jump` (a 600 ms blue tint fade; none under reduced motion).
5. Blur the input so keys work.

### 7.3 Back to ATM pill
An `IntersectionObserver` (root = wrap) watches the ATM row. When the row is not intersecting, a pill floats bottom-centre inside the wrap: `↑ ATM 26350` or `↓ ATM 26350` (the arrow shows direction). Click or `g` scrolls ATM to the centre. The pill is 32 px (44 px on coarse pointers), `--mat-thick` material, and is hidden from screen readers when not shown.

### 7.4 Expiry stepping
`[` / `]` select the previous or next expiry in `eSel` (wrapping is off). The expiry option text already carries DTE (`3 Nov · 5d`). It gains a ` · M` suffix for the monthly (last expiry in its calendar month).

---

## 8. Interactions

### 8.1 Desktop and fine pointer
- Click Bid → ticket SELL at bid. Click Ask → ticket BUY at ask (exists).
- Click a row → focus it (exists). **Double-click or Enter** on the focused row → open the action sheet as a right-anchored panel.
- Hover tints the row (exists).

### 8.2 Action sheet (`chain-sheet.js`, MUST)
Opened by a tap on a coarse pointer (any width), by Enter or a double-click on a fine pointer, and on phones always by a row tap. It is a native `<dialog class="sheet">` built with `h()`.
- On phones it is a bottom sheet: max-height 80vh, grab handle, swipe down 80 px or more to close, backdrop tap or Esc to close.
- On ≥ 720 px it is a 380 px panel fixed to the right.

Content, top to bottom:
1. Header: `NIFTY 3 Nov 26400 CE` (contractName), LTP with change %, and a **CE | PE** segmented control so the user can switch to the other side of the same strike.
2. Position line, when held: `Long 2 lots @ 148.20 · P&L ₹1,066` + **Exit** (opens `openTicket({exit:true})` via the existing `exitPosition`).
3. Primary buttons, 48 px, full width split: **Buy at 155.35** (ask) | **Sell at 155.30** (bid). Each opens the existing ticket prefilled. Disabled with a reason when there is no account or no quote.
4. Secondary row: **Add buy leg** · **Add sell leg** (call `addLeg` and toast "Added to strategy") · **Chart** (disabled; title "Chart engine slot: coming soon").
5. Metric grid, 3 columns, label over value: Bid, Ask, Spread %, IV, IV−ATM, Δ, Γ, θ/lot, Vega, OI, OI chg, Volume, Breakeven, PoP buy, P(ITM), Prem/lot, Lot, Build-up. Every value uses the §5 formula and format.
6. Warnings: the same list as the ticket (§8.4), when any apply.

Live: the sheet repaints from `st.chain` on every tick, patched by signature. Trading buttons show the latest touch. Focus is trapped by `<dialog>`. Closing returns focus to the row.

### 8.3 Keyboard (desktop; listener exists, extend `onKey`)
| Key | Action | Status |
|---|---|---|
| j / ↓, k / ↑ | next / previous visible strike | keep |
| h / ←, l / → | call / put side (both-sides view) | keep |
| g, Home | focus ATM and scroll to it | add Home |
| / | focus strike search | **add** |
| [ / ] | previous / next expiry | **add** |
| 1–5 | preset OI, Buyer, Seller, Hedger, Arb | **add** |
| c / v | calls only / puts only (press again → both) | **add** |
| Enter | open the action sheet for the focus | **add** |
| b / s | ticket buy at ask / sell at bid | keep |
| B / S | add buy / sell leg | keep |
| x | exit the held position on the focused contract (exit ticket); toast "No position" otherwise | **add** |
| p / r | pause / refresh | keep |
| ? | keys overlay (a `modal()` listing this table) | **add** |
| Esc | clear focus / close the sheet or search | keep |

Keys are ignored inside inputs (exists), except Esc and Enter in the search box, which are handled by the box itself.

### 8.4 Trade warnings (pure `O.tradeWarnings`, shown in the ticket above the server checks and in the sheet)
Input: `{ side, right, leg, lots, lot, freezeQty, liq, stale, isExpiryDay, itm, intrinsic, hasLongSameExpiry, orderType }`. Output: `[{ level: "warn" | "bad", code, text }]`. These are advisory. Server safety gates are unchanged and still decide.

| code | Condition | Level | Text |
|---|---|---|---|
| WIDE_SPREAD | spreadPct > 5 (bad > 10) | warn / bad | "Spread 7.4% of mid: use a limit order" |
| ILLIQUID | liq ≤ 2 | warn | "Thin strike: you may not get out at a fair price" |
| MARKET_ILLIQUID | orderType MARKET and spreadPct > 2 | bad | "Market order on a wide spread" |
| ONE_SIDED | bid or ask missing | warn | "One-sided quote" |
| STALE | freshness.stale | bad | "Quotes are stale: prices may have moved" |
| FREEZE | lots × lot > freezeQty | warn | "Above freeze qty 1800: the order will be split or rejected" (server decides) |
| NAKED_SHORT | side SELL and no long option of the same right and expiry is held or in the basket | warn | "Uncovered short: margin is blocked and losses are unlimited" (calls) or "…large" (puts) |
| EXPIRY_ELM | SELL on expiry day | warn | "Expiry day: +2% ELM on index option shorts" |
| EXPIRY_STT | BUY-held ITM on expiry day (exit flow) or BUY ITM on expiry day | warn | "ITM at expiry: exercise STT 0.125% of intrinsic (≈ ₹X) vs 0.1% of premium if you square off (≈ ₹Y)" with X = 0.00125 × intrinsic × qty and Y = 0.001 × P × qty |
| THETA_0DTE | BUY and T < 1 day and abs(thetaLot) > 15% of P × lot | warn | "Time decay ₹X per lot today" |

`freezeQty` comes from `GET /v1/instruments/{symbol}` (cached per symbol for the session).

---

## 9. Settings (persisted in `mcb.dashboard.desk` via `chainConfig`)

Shape (new keys in bold). `chainConfig` must accept every old saved shape and fill defaults:
```
{ cols: string[], preset: "oi"|"buyer"|"seller"|"hedger"|"arb"|"greeks"|"value"|"custom",
  side: "both"|"ce"|"pe", phoneSide: "ce"|"pe"|"both",
  quotes: bool, bars: {oi, chg, vol}, pct, lots, itm, positions, dense,
  tags: { mp, walls, em, em2 } }
st.strikes: "10" | "20" | "all"
```
- `preset` is derived from `cols` (`presetOf()` exists). It is stored only for the arb `quotes` coupling.
- Unknown column keys are dropped (exists). New column keys are added to `known`.
- Customise gains: the new columns in its list (with titles holding each formula in one line); "On phones show: Calls / Puts / Both"; "±2σ" under tags; "More presets: Greeks, Value".
- Reorder: drag and arrows already exist. The centre (row-scope) columns reorder among themselves only.
- Persisted per browser (localStorage, wrapped in try/catch through `app.local`).

---

## 10. States

| State | Behaviour |
|---|---|
| First load | The chain panel keeps its height (`min-height: min(70vh, 860px)` on the desktop wrap, 64vh on phone) and shows "Loading the chain…" centred. Tiles show labels with `--`. |
| Error before any data | `alertBox(err)` plus a **Retry** button that calls `reloadAll`. |
| Error after data | Keep the last table. The clock shows "Not updating" (exists). A one-line note above the table reads "Last update 10:32:15 · retrying every 3 s", with `role=status`. |
| Stale freshness | Clock "Stale" (exists). STALE warning in ticket and sheet. |
| No expiries / no strikes | Existing messages. |
| One-sided leg / null leg | Cells `--`. Trade buttons disabled with a reason in the title. Arb columns `--`. |
| No account can trade | Bid/Ask disabled (exists). Sheet primary buttons disabled with "Choose an account that can place orders". |
| Paused | The Live button reads "Paused" (exists). Patches stop, and the sheet stops updating with the label "Paused". |
| Tab hidden | No fetch (exists in `every`). Immediate refresh on return (C14). |

---

## 11. Accessibility
- Table `<caption class="sr-only">NIFTY 3 Nov option chain, calls left, puts right</caption>`.
- Rows get a roving `tabindex` (the focused row 0, the others −1) and `aria-selected`. Focus moves by keys or click also call `tr.focus({ preventScroll: true })` after the scroll logic.
- A polite live region (`.sr-only`, throttled to one message per 600 ms) announces the focused contract: "26400 call, LTP 155.30, delta 0.50, OI 8.8 L".
- Trade buttons keep their full aria-labels (exist). Sheet buttons say e.g. "Buy 26400 CE at 155.35".
- Colour is never the only signal: changes carry signs, build-up has text, walls have tags, warnings have text.
- Targets are 44 px on coarse pointers (rows, sheet buttons, segmented control, search, pill).
- `prefers-reduced-motion` disables flashes, the jump tint and sheet slide transitions.

---

## 12. Data and API (no server changes this round)

| Need | Source | Frequency |
|---|---|---|
| Chain | `GET /v1/optionchain?underlying&expiry&strikes=40&greeks=true` (exists) | every 3 s |
| Index change and real future | `GET /v1/quotes?symbols=<index>,<future>`, fired in parallel with the chain, wrapped in `optional()` (failure is non-fatal) | every 3 s |
| Index symbol | NIFTY → NSE:NIFTY, BANKNIFTY → NSE:BANKNIFTY, FINNIFTY → NSE:FINNIFTY, MIDCPNIFTY → NSE:MIDCPNIFTY, SENSEX → BSE:SENSEX, BANKEX → BSE:BANKEX (verified in demo: NSE:NIFTY, NSE:BANKNIFTY, BSE:SENSEX return quotes) | static map |
| Futures list | `GET /v1/instruments/search?q=<U>&kind=FUT&underlying=<U>`. Pick the one with `expiry === chain.expiry` (for R) and the nearest expiry ≥ chain expiry (for the spot-row label) | once per underlying |
| Freeze qty, tick | `GET /v1/instruments/{symbol}` (`freezeQty`, `tickSize`) | once per symbol opened in the ticket or sheet |
| Positions | `GET /v1/positions?account=` (exists) | every 3 s |

LATER server additions (not this round): `bidQty`/`askQty` and a per-leg `ts` in `ChainLeg` (needed for depth-aware arb and per-row staleness); a margin estimate endpoint; stored IV history for IV rank and percentile.

---

## 13. Performance
- Budget: ≤ 8 ms of main-thread time per tick for `context()` + `patch()` on 81 rows, Arb or Buyer preset, desktop. Measure `st.patchMs` with `performance.now()` around context and patch, and expose it in the clock's title ("render 3 ms").
- `context()` runs once per tick. Add `topOi` and `sigmaBand` there. maxPain O(n²) at n = 81 is fine.
- Cell signatures: keep `JSON.stringify` for array signatures. For scalar `v`, use `String(v)` (avoids allocation).
- Hidden rows (`tr.hidden`) are **still patched**, so values are right when the window moves. The cost is acceptable at 81 rows. If the budget fails, skip patching hidden rows and mark them dirty instead.
- `.chain-wrap { contain: content; }` and rows a fixed height. No `content-visibility` (it breaks sticky cells and measurement).
- Flash and other class changes happen in one rAF per tick (C8). The sheet patches in the same rAF.
- No layout reads inside the patch loop. The anchor measurement (§7.1) reads once before the writes and writes once after.

---

## 14. Test plan

### 14.1 Unit tests (`options.test.mjs`): new pure functions in `options.js`
| Function | Cases |
|---|---|
| `breakeven(K, right, P)` | CE 26400 + 155.35 = 26555.35; PE 26400 − 158.9; P null → null; PE result ≤ 0 → null |
| `chanceOfProfit(F, K, T, iv, right, P)` | equals `probItm(F, BE, …)`; CE PoP < P(ITM); T = 0 uses intrinsic; iv null → null |
| `distance(K, right, S)` | CE OTM positive, PE OTM positive, ITM negative; pct = pts/S·100 |
| `sigmaDistance(K, right, F, atmIv, T)` | strike at F·e^(σ√T) → +1.0 for CE; PE mirror; null inputs |
| `sigmaBand(F, iv, T, k)` | lo·hi = F² (log symmetry); k = 2 is wider than k = 1 |
| `extrinsic(K, right, P, F)` | ITM call below intrinsic → negative; OTM = P |
| `synthetic(row)` | mid, buy = K + C.ask − P.bid, sell = K + C.bid − P.ask; one-sided → buy/sell null |
| `parityEdge(row, R)` | conversion positive when syn_sell > R; reversal when R > syn_buy; both ≤ 0 normally |
| `topOi(rows, side, 3)` | ranks 1..3 by OI, ties keep the lower strike, OI 0 excluded |
| `hedgeLots(netDelta, delta, lot)` | 150 long units, put Δ −0.5, lot 75 → 4; same sign → null; abs(Δ) < 0.02 → null |
| `strikeQuery(text, ctx)` | "26400", "264", "+3", "-2", "1s", "-2σ", "atm", "mp", "abc" → null; off-grid snaps to the nearest strike |
| `tradeWarnings(input)` | one case per code in §8.4 plus a clean case returning [] |
| `isExpiryDay(expiry, now)` | 09:15 IST on the expiry date → true; 15:31 → false; the day before → false |
| `chainSummary` | new `netOiChange` = ΣPE − ΣCE; `pcrChange` unchanged |
| `chainConfig` (desk.js export) | old saved shapes migrate; unknown cols dropped; `phoneSide` default "ce"; strikes migration 8/12 → 10 (tested via the exported helper `strikesPref`) |

Plus: `npx vitest run server/bridge/dashboard` and the full `npx vitest run` + `npm run -s check:mjs` pass. `format.test.mjs` house rules (no `toFixed(` etc.) cover any new file. **`chain-sheet.js` must be added to `DASHBOARD_FILES` in `server/bridge/core/app.mjs` and to the file list in `format.test.mjs`.**

### 14.2 Playwright (copy `scratchpad/desk.cjs`, save to `scratchpad/shots/`, and look at every PNG)
1. Matrix: 390×844, 820×1180, 1440×900 × light, dark × presets OI, Buyer, Seller, Hedger, Arb → `chain-<w>-<theme>-<preset>.png`.
2. Assert at each size: `document.scrollingElement.scrollWidth <= innerWidth`. On phone, also assert `.chain-wrap.scrollWidth <= .chain-wrap.clientWidth + 1`.
3. No rebuild: tag the table (`table.__id = 1`), wait 15 s (5 ticks) with spot moving, and assert the same element and an unchanged `wrap.scrollTop` (±2 px).
4. Phone: tap a row → the sheet is visible → screenshot. Swipe left → header reads Puts. Buy button opens the ticket.
5. Desktop keys: `/` then `26600` Enter → the focused row strike is 26600 and visible. `]` → expiry changes. `3` → Seller preset active. `?` → overlay.
6. Back-to-ATM: scroll to the top → the pill is visible. Click → ATM row in view.
7. Perf: read `st.patchMs` from the clock title over 5 ticks and assert the median ≤ 8 ms (desktop, Arb).
8. Touch targets: on a coarse-pointer emulated tablet, every `button` in the chain head and sheet has a bounding height ≥ 44.

---

## 15. Priorities

### MUST (this round)
1. **C1 window fix**: build all rows, hide by window, preserve scrollTop through an anchor; strikes ±10/±20/All with migration.
2. **Phone layout**: `phoneSide` and the sticky Calls|Puts|Both control, swipe, ≤ 3 columns, 44 px rows, no quote buttons, no horizontal scroll; preset `<select>`.
3. **Sticky strike column** (one side: left; both: left and right).
4. **Action sheet** (`chain-sheet.js`): bottom sheet on phone, right panel on desktop/tablet; Buy/Sell at touch, CE/PE switch, legs, Exit when held, metrics, warnings, live patching; Chart button as a disabled placeholder.
5. **Persona presets** Buyer, Seller, Hedger, Arb on the toolbar (Greeks and Value under Customise) with columns `be, pop, pops, potm, dist, premLot, thetaLot, ivx, hedge, costPct` and row columns `syn, dev, edge, ivskew`; the maths in `options.js` with tests.
6. **Strike search** (`/`, `strikeQuery`) and the **Back-to-ATM pill**.
7. **Trade warnings** (`tradeWarnings`) in the ticket and the sheet; freeze qty from `/v1/instruments/{symbol}`; **expiry-day chip**.
8. **Keys**: `/`, `[ ]`, `1–5`, `c`/`v`, Enter, `x`, Home, `?` overlay; legend updated.
9. **Tablet layout**: opt-x hidden ≤ 1099, coarse-pointer 44 px rows and quote buttons off, scrollable tiles row.
10. **Correctness fixes**: C4 time value on F, C5 net ΔOI, C6 wording, C12 log-normal σ bands + ±2σ tag, C13 top-3 OI.
11. **Perf**: C7 patched tiles and title, C8 rAF flash without reflow, C9 scaleX bars, C14 refresh on return, `patchMs` budget.
12. **Spot row**: index change and the real future via `/v1/quotes` (non-fatal).
13. **A11y**: caption, roving tabindex, aria-selected, live region.

### LATER
- Net-of-costs arbitrage edge (STT, exchange charges, stamp, GST, brokerage; configurable constants); box-spread implied rate.
- Bid/ask quantities and per-leg quote age (server `ChainLeg` addition); depth-aware edge.
- Margin estimate per short row and return on margin (needs a broker margin API).
- IV rank and percentile (needs stored history); an IV smile sparkline in the chain head.
- TrendSpider-style OI minimap; straddle-breakeven tags; a sticky spot line.
- Basket mode toggle ("Instant vs Basket", the Groww pattern) with combined margin; one-click (no ticket) scalper mode behind an explicit opt-in.
- Multi-expiry comparison, calendar view, IV term structure.
- Alerts from a row; market depth panel; long-press for full row detail.
- Shift+number quantity presets; default lots per underlying.
- Streaming (`/v1/stream`) in place of 3 s polling.

---

## 16. Out of scope
- **Charts**: no chart library. The sheet's "Chart" button and any chart area are labelled placeholders ("Chart engine slot"). The owner will supply the engine.
- Any weakening of order safety: preview, paper default and the live acknowledgement stay exactly as they are. Warnings here are advisory only.
- Server-side changes (none needed this round).
- A Strategy Builder, OI page or Positions page redesign beyond what shared code changes imply. Those pages must keep working: run their screenshots too.
- Virtualised rendering (81 rows does not need it).

---

## 17. Suggested build split (three agents in parallel, minimal file overlap)
- **Agent A: maths** (`options.js`, `options.test.mjs` only). It adds every pure function in §14.1 first, with tests, then commits. The other agents import them. Signatures as in §14.1.
- **Agent B: table** (`desk.js` createChain / chainConfig / onKey / drawStats, plus `app.css` 12b table rules). Owns MUST 1, 3, 5 (wiring), 6, 8, 10, 11, 12 and 13.
- **Agent C: touch** (new `chain-sheet.js`, `app.css` sheet, phone and tablet rules, `openTicket` warnings block, `core/app.mjs` and `format.test.mjs` file lists). Owns MUST 2, 4, 7 and 9. It agrees with B on one hook: `createChain({ …, onRowOpen(strike, side) })`.

Merge order: A, then B and C. Final pass: the full Playwright matrix (§14.2).
