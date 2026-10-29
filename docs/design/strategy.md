# Design spec: Strategy Builder, round 2 (`#/strategy`)

Status: ready to build · Files: `server/bridge/dashboard/strategy.js`, `strategy-place.js`, `payoff.js`, `options.js` (+ `options.test.mjs`, `strategy.test.mjs`), `desk.js` (only the `kind === "strategy"` panel list and the top line it shares with the chain), `app.css` §12d (STRATEGY BUILDER) · Builds on `docs/prd/02-strategy.md` (round 1). Every behaviour that PRD calls "keep" still applies unless this spec changes it. Colour roles and the selection rule come from `docs/design/chain.md` §2 (and `docs/design/foundation.md` when it lands).

Reference bar: Sahi Terminal for calm and cleanliness. Sensibull, Opstra, OptionStrat and tastytrade for depth. The builder should read as one black, precise instrument: **legs on the left, the answer (payoff + numbers) on the right, and nothing between the user and the payoff.**

Screenshots this spec is based on (dark and light; phone 390×844, tablet 820×1180, desktop 1440×900; empty and with an Iron condor):
`/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/shots2/strategy/` (driver: `scratchpad/strat2.cjs`).

---

## 1. What is wrong today (specific, from the screenshots)

### 1.1 Chrome and space
1. **Three headers and a chain summary before the builder.** Desktop: app toolbar (title, "Demo data", clock, search) → desk bar (NIFTY, expiry, "Demo paper account", "Paper", "as of 08:59:47", "Live") → 8 chain tiles (NIFTY, ATM IV, Expected move, Straddle, PCR, Max Pain, Put wall, Call wall). The builder starts at **y = 243 of 900**. The chain tiles (PCR, walls, max pain) do not help build a strategy.
2. **Phone: the payoff is 2.3 screens down.** Toolbar 70 px, desk bar 3 lines (≈ 150 px), tiles, strategy head, group tabs, chips, 4 leg cards, tools, sticky bar, metrics. The chart starts near y ≈ 1000 in the full-page capture. The user never sees the answer while building.
3. **Demo / paper is said four times:** toolbar "Demo data", "Demo paper account", the "Paper" badge, and the margin sub-line "paper · no hedge benefit". The phone toolbar shows a bare orange dot.
4. **Desktop dead zone.** The build column ends after the leg tools at y ≈ 645; from there to y ≈ 1300 the left 490 px is empty while the scenario table scrolls on the right.
5. **Toast collides with content.** "Iron condor applied · Undo" sits on the payoff's x-axis on desktop and on top of the sticky action bar on phone and tablet (it hides "Credit" and "Place").
6. **Tablet / phone: the collapsed "Scenarios" disclosure leaves ≈ 80 px of empty panel** below its summary row.

### 1.2 Cleanliness and colour
7. **Dark canvas is warm charcoal**, so the payoff loss fill (`--ios-red` at 0.13) renders **maroon-brown** and the profit fill **dark olive**. The loss slab spans the full chart width and dominates.
8. **Selection is low contrast.** The "Neutral" group thumb is grey on grey. The active preset chip "Iron condor" is blue text with a blue ring, a different style. The `% | σ` thumb is grey. None of them meet the owner's rule (dark → white with black text; light → black with white text).
9. **Leg rows are noisy and colourless where it matters.** Four system-blue checkboxes are the loudest marks in the table. B/S are 22 px pastel squares (sell is pink). CE / PE are identical grey chips, so calls and puts cannot be told apart at a glance. Strike arrows `‹ ›` are 24 px and very faint. Columns `Price IV Δ` float far right on tablet with an empty 200 px gap.
10. **Metric tiles have no hierarchy.** Eight equal tiles. "Margin ₹305483" is in **red** (margin is not a loss: red must mean loss). Six-digit rupees are not compacted. "Breakevens after charges" wraps to two lines. "At target −₹112 · now · IV 0.0" is unclear. POP is a bare "72%".
11. **Margin story is confusing.** "₹305483 · paper · no hedge benefit · hedged ≈ ₹11681" plus a red "Short of margin by ₹2.29L" line. The user cannot see required vs available at a glance.
12. **The Place button looks disabled** (blue at low alpha in both themes) even when it only carries a warning.

### 1.3 Payoff chart
13. **Breakeven labels sit on the curve** ("25957" is drawn through the rising expiry line; "26893" too).
14. **The ±2σ band is a dashed rectangle** the full chart height. It reads as a selection box, and the spot label "26409" sits on its top edge.
15. **No max profit / max loss marks.** The flat tops (+₹3 210 / −₹11 869) are not labelled on the chart; the user reads them from tiles.
16. **No strike marks.** Where the legs are (25 800 / 26 000 / 26 850 / 27 050) is not shown on the x-axis.
17. **Legend mismatch:** the "Target" swatch is purple-dashed in the head; the curve is blue-dashed.
18. **Readout is far from the pointer** (top-right of the head), and lacks σ distance and probability.
19. **Nothing animates.** Applying a preset, moving a strike or changing lots snaps the paths. Slider drags are already smooth (rAF), which is good and must stay.
20. **Empty state** is a large outlined box with one sentence; metrics show eight "--".

### 1.4 Feature gaps (vs Sensibull, Opstra, OptionStrat, tastytrade)
21. **Single expiry only.** No calendars or diagonals; every leg is forced to the toolbar expiry (`key = underlying|expiry`).
22. **P&L table** is nine fixed % levels. No table by strike-step spot, no price × date grid.
23. **No strategy suggestions** from a view ("NIFTY to 26 800 by Thursday").
24. **No adjustment tools:** roll a leg, add a wing to a naked short, delta-neutralise.
25. **No global lot multiplier** (only ÷2 / ×2). **No per-leg entry price or IV override.**
26. **Greeks are tiles only:** no breakdown per leg, no "greeks across price".
27. **No probability distribution on the chart**, and no probability of touch.

---

## 2. Colour roles and tokens

Use the roles from `docs/design/chain.md` §2 (map 1:1 to `foundation.md` names when it lands). Values repeated here only where the builder adds a role.

| Role | Used for in the builder | Dark | Light |
|---|---|---|---|
| `--canvas` | page bg | `0 0% 1.6%` | `36 28% 97%` |
| `--surface` | builder panel, chart plot bg | `0 0% 5%` | `0 0% 100%` |
| `--surface-2` | leg-table head, tooltip card, sticky bar base | `0 0% 8%` | `30 10% 96.5%` |
| `--hairline` / `--separator` | row and section rules | white 7% / 12% | black 7% / 12% |
| `--sel-bg` / `--sel-fg` | **every selected segment, chip, tab, the active preset card, the spot pill** | `0 0% 98%` / `0 0% 4%` | `0 0% 6%` / `0 0% 100%` |
| `--c-pos` | profit fill, profit line segment, P&L > 0 text, θ > 0 | `142 70% 50%` | `142 72% 29%` |
| `--c-neg` | loss fill, loss line segment, P&L < 0 text | `3 92% 63%` | `356 78% 42%` |
| `--c-call` | CE chips, call strike markers on the x-axis | `199 92% 58%` | `201 90% 38%` |
| `--c-put` | PE chips, put strike markers | `266 85% 72%` | `266 60% 48%` |
| `--c-buy` / `--c-sell` | B / S tags, leg side stripe, Buy/Sell in picker | `211 100% 50%` / `3 82% 52%` | `211 100% 43%` / `3 82% 47%` |
| `--c-atm` | **target (T+x) curve**, target dot, target-date slider fill | `211 100% 60%` | `211 100% 42%` |
| `--c-neutral` | σ bands, distribution ribbon, axis text, FUT chip | white 42% | black 38% |
| `--c-warn` | warnings, "Expiry today", wide spread, shortfall bar | `38 100% 56%` | `30 100% 36%` |
| **new** `--c-target2` | optional mid-date curve (§4.1 "Curves: 3") | `--c-atm` at 0.55 | `--c-atm` at 0.55 |
| **new** heat scale `--heat-pos(x)` / `--heat-neg(x)` | P&L grid cells (§5.3) | role colour at alpha `0.08 + 0.52·x^0.7` | role at `0.06 + 0.40·x^0.7` |

Rules for this page:
- **Green and red mean P&L only.** Margin, charges, capital and delta are neutral ink. Theta and vega show sign in green / red only because they are ₹ P&L per day / per point.
- Buy / sell is blue / red on the tag only (the tag is the only red that is not a loss; it is always a filled "S" glyph, never a number).
- Calls / puts are sky / violet, never green / red.
- Text in a role colour uses the ink value above (≥ 4.5:1 on `--surface`).
- Selection: exactly chain.md §2.1. Applies to the group segmented control, `% | ₹ | σ` toggles, the active preset chip/card, the P&L table tabs, the leg expiry pill when open, and `Curves: 1 | 2 | 3`.

---

## 3. Layout per device

### 3.1 Panels on `#/strategy`
`desk.js` (`kind === "strategy"`) returns `[top, builder.panel, builder.slot]`. **The chain summary panel is removed from this page** (it stays on `#/chain`). Expected move and ATM IV move into the top line; the rest of the chain stats are one click away in the chain.

**Top line** (shared with the chain, chain.md §3.1): one line, 48 px desktop/tablet, 44 px phone:
`[NIFTY ▾] [3 Nov · 5d ▾] │ 26 408.5 +0.03% │ Fut 26 433 │ Lot 75 │ ATM IV 13.5% │ ±1σ 430 ………… ● 08:59`
- No account select, no "Paper" badge, no "as of", no "Live" button: the freshness dot replaces all three (green live / `--c-warn` stale / red error; tap toggles pause; key `P`).
- **Demo indicator:** only the app toolbar's "Demo" pill. The margin tile drops "paper ·". The account the order goes to is chosen in the **confirm sheet** ("Orders go to: Paper ▾"), where it matters. A live broker account with live orders allowed shows a solid red `LIVE orders` pill in the top line (safety exception, as in the chain).
- Phone: `[NIFTY ▾] [3 Nov·5d ▾]  26 408.5 +0.03%  ●`.

### 3.2 Desktop (1440×900, content ≈ 1100 px)
```
┌ top line 48 ───────────────────────────────────────────────────────────────────────────┐
├ Strategy head 48: "Iron condor" (auto-named) · 4 legs · 3 Nov    [Saved 3] [Save] [⋯] [Place 4 legs] ┤
├ BUILD 420 px ─────────────────┬ ANALYSIS (fill) ─────────────────────────────────────────┤
│ [Bullish|Bearish|Neutral|Vol|Hedge]│ HERO STRIP (5 cells, 72 px)                             │
│ preset chips (wrap, 2 rows max)│  Net credit │ Max profit │ Max loss │ POP ◔ │ Breakevens  │
│ ───────────────────────────── │ ─────────────────────────────────────────────────────── │
│ LEGS table (rows 40)          │ PAYOFF 340 px  (legend + Curves toggle in its head)       │
│ leg tools row                 │ ─────────────────────────────────────────────────────── │
│ ───────────────────────────── │ WHAT-IF row: Target date ━━●━━  IV shift ━━●━━  [Reset]   │
│ RISK & CAPITAL card           │ model note (1 line)                                       │
│  margin vs funds bar          │ ─────────────────────────────────────────────────────── │
│  Greeks 4-up (Δ Γ Θ ν)        │ P&L TABLE  [By spot | Grid | Greeks]  (tabs, 10–13 rows)   │
│  charges · ROM · R:R · EV     │                                                            │
│ ───────────────────────────── │                                                            │
│ SUGGEST (collapsed 44 px)     │                                                            │
└───────────────────────────────┴──────────────────────────────────────────────────────────┘
```
- Grid: `grid-template-columns: 420px minmax(0, 1fr)`, no gap; a `--separator` rule between the columns. Build column is `position: sticky; top: 12px` (exists) and now holds **Risk & capital** and **Suggest**, which removes the dead zone (§1.1 #4).
- Payoff 340 px tall (was 300). Hero strip + payoff + what-if fit above the fold at 900 px: 48 (top) + 48 (head) + 72 (hero) + 36 (chart head) + 340 + 64 (what-if) = 608 + offsets ≈ 690.
- 1100–1279 px: build column 380 px, P&L table 9 rows.

### 3.3 Tablet (820×1180 portrait)
One column, order: hero strip (5 cells in one row, 64 px) → payoff 280 px → what-if (2 sliders side by side) → group segmented + chip row (horizontal scroll, 16 px edge fade) → legs table → leg tools → Risk & capital (2 columns: margin bar | greeks 4-up) → P&L table (open, 9 rows) → Suggest. Sticky action bar (§3.5).
Rationale: on a tablet you build with the chart in view; the payoff sits above the legs, so a strike tap shows its effect without scrolling.
Leg table on tablet: `on 40 | side 36 | strike ‹ › 132 | right 48 | expiry 72 | lots 124 | price 72 | IV 52 | Δ 52 | ⋯ 44` = 672 + gaps, fits 788. No empty middle gap.

### 3.4 Phone (390×844)
**When legs exist**, order:
1. Hero strip, 2 rows: `Net · Max profit · Max loss` (3 cells, 52 px) / `POP ◔ · Breakevens` (2 cells, 44 px).
2. Payoff 232 px (axis text 10.5 px real pixels; the old 19 px viewBox rule goes because the SVG now sizes in CSS px).
3. What-if: one row `[Target: Now ▾] [IV +0 ▾]` chips; tapping opens a bottom sheet with the slider (big thumb, 44 px), presets `Now · +1d · +2d · Mid · Expiry−1h`, and `Reset`.
4. Legs: cards (§4.3), 52 px each.
5. Leg tools: `+ Add leg` (primary-tinted) · `Strategies` (opens the preset sheet) · `⋯` (Shift, Size, Clear).
6. Risk & capital (collapsible, open state persisted).
7. P&L table (By spot only on phone; 3 columns Price · Target · Expiry, move % under the price).
8. Suggest (collapsed).

**When the draft is empty**: the preset gallery is the page (§6.1), the payoff slot shows the ghost.

Phone presets move out of the page flow into a **bottom sheet** ("Strategies", key-less): group segmented (contrast), then a 2-column grid of preset cards (glyph 64×28 + name + one-line hint + `Defined` / `Undefined risk` tag). This removes the two scrolling rows (group tabs + chips, ≈ 90 px) and the truncated "ort straddle" / "Hedge & a".

### 3.5 Sticky action bar (tablet and phone)
56 px, `bottom: calc(var(--tabbar-h) + 12px + var(--safe-b))`, `--mat-thick` + blur, top hairline, radius `--r-lg`.
Left: `Credit ₹3 319` (15 px 700) and under it `Max loss −₹11.9K · POP 72%` (12 px). Right: `Place 4` primary button, **solid `--c-buy`, white text, full opacity whenever placement is possible**; with a warning it keeps full colour and shows a `--c-warn` 8 px dot at its top-right; only a **block** greys it (`opacity .45`, title = the block reason).
**Toasts on this page are raised above the bar:** `--toast-bottom: calc(var(--tabbar-h) + 80px + var(--safe-b))` on ≤ 1023 px; on desktop toasts sit bottom-right of the analysis column, never over the chart.

---

## 4. The payoff chart (payoff.js)

### 4.1 Anatomy (back to front)
| # | Layer | Encodes | Style |
|---|---|---|---|
| 1 | Plot bg | — | `--surface`; no border; 8 px radius on the plot rect |
| 2 | ±2σ band | F·e^{±2σ√T_t} (T_t = time to the target-date curve's horizon; first expiry when Curves = expiry only) | full-height fill `--c-neutral` at 0.035 (dark) / 0.03 (light). **No dashed outline.** |
| 3 | ±1σ band | F·e^{±σ√T_t} | fill `--c-neutral` at 0.07 / 0.055 |
| 4 | Band labels | `−1σ 25 978` / `+1σ 26 838` | 10 px 600 `--c-neutral` ink, at the **bottom** of the plot, inside the band edges (left label right-aligned to the band's left edge + 4 px). Hidden if they collide with x ticks (use `placeLabels`). |
| 5 | Grid | y ticks | `--hairline`; 4–6 ticks; y labels `₹` + compact (`+₹5K`, `−₹10K`, `0`) |
| 6 | Profit area | expiry P&L ≥ 0 | **vertical gradient** from the curve to zero: `--c-pos` alpha 0.34 at the max-profit level → 0.04 at zero (dark); 0.24 → 0.03 (light). One `<linearGradient>` per sign, `gradientUnits="userSpaceOnUse"`, y1 = Y(yMax), y2 = Y(0). |
| 7 | Loss area | expiry P&L < 0 | same with `--c-neg`, 0.30 → 0.04 (dark) / 0.20 → 0.03 (light), y1 = Y(0), y2 = Y(yMin). The deep loss tails fade instead of a flat slab. |
| 8 | Distribution ribbon (P1, on by default from 720 px) | lognormal density of S at the curve horizon | filled path along the **bottom 18 %** of the plot, `--c-neutral` at 0.10; the part over profitable prices tinted `--c-pos` at 0.16 (clip by the profit intervals). Formula §4.4. |
| 9 | Zero line | P&L = 0 | 1 px `--foreground` at 0.35 |
| 10 | Max profit / max loss guides | finite max profit / loss within the y-range | 1 px dashed `--c-pos` / `--c-neg` at 0.5, full width; a right-aligned pill at the plot's right edge: `Max +₹3 210` / `Max −₹11 869` (10.5 px 650, role ink on role at 0.12). "Unlimited" shows the pill with "↗ Unlimited" at the side where the curve leaves the plot. |
| 11 | Target curve(s) | P&L at the target date with the IV shift (Black-76 per leg on its own remaining time) | `--c-atm`, 1.75 px solid (not dashed: dashes break at kinks and read as "estimate" twice). Mid-date curve (Curves = 3): `--c-target2`, 1.25 px, dash 4 3. |
| 12 | Expiry curve | P&L at the first expiry | 2.25 px; **stroke split by sign**: above zero `--c-pos`, below `--c-neg` (two `<path>`s clipped by the existing up/down clip rects). Round joins. |
| 13 | Strike markers | each active OPT leg | on the x-axis baseline: a 7 px triangle pointing up, colour `--c-call` / `--c-put`; **filled = buy, outline (1.5 px) = sell**. Stacked when two legs share a strike (second 8 px lower). FUT legs: a 6 px neutral square at the entry price. Title: "Sell 1 × 26 850 CE @ 42.50". |
| 14 | Spot marker | current spot | 1 px solid `--foreground` at 0.55 vertical; at the top a **contrast pill** (`--sel-bg` / `--sel-fg`, 18 px high, 10.5 px 700): `26 408.5`. Never dashed blue (blue is the target curve now). |
| 15 | Breakevens | roots of the expiry curve | 7 px ring (2 px stroke `--foreground`, fill `--surface`) on the zero line. **Labels go below the x-axis**, in a 16 px pill row: `BE 25 957 (−1.7%)`, 10.5 px 600, `--surface-2` fill. Collisions use `placeLabels` (merge to `BE 25 957 · 26 893`). Never on the curve (§1.3 #13). |
| 16 | Crosshair | pointer price | 1 px `--foreground` at 0.3; dots on each curve (expiry dot in the sign colour, target dot `--c-atm`), 4 px with a 2 px `--surface` ring |
| 17 | Tooltip | §4.3 | floating card |

x-axis: `niceTicks` (exists) at 10.5 px `--c-neutral`; the x baseline sits 24 px above the BE pill row. Plot margins: L 56, R 12, T 24 (spot pill), B 52 (ticks + strike markers + BE row).

Chart head (36 px): left the legend `━ Expiry (13 Nov)  ━ Target (T+2d)  ▒ ±1σ  ▒ ±2σ` (swatches drawn with the same classes as the chart, so they always match); right `Curves [1 | 2 | 3]` contrast segmented (1 = expiry; 2 = expiry + target; 3 = + mid-date) and a `⋯` menu: "Show distribution", "Show per-leg payoffs" (P2), "Y axis: ₹ | % of margin". Persist in `strategyConfig`.

### 4.2 Scales
- x: linear, `payoffRange` (exists) widened so ±2σ is always inside: `span = max(2.6·move, 1.35·max|K−S|, 1.5% S, 2.2·σ√T·F)`.
- y: linear, padded 12 % (exists). **Symmetric clamp:** if `|yMin| > 4·|yMax|` (or the reverse), clamp the dominant side to 4× and draw an arrow cap "▼ −₹42K at 24 000" at the clipped edge, so a far-away tail does not flatten the profitable part. The clipped value still appears in the tooltip and the table.
- Y axis mode `% of margin`: y = P&L / margin × 100, labels `+12%`.

### 4.3 Tooltip and readout
- Fine pointer: on hover a card follows the pointer (offset 12 px right / up; flips at the edges; 180 px wide; `--surface-2`, 1 px `--separator`, radius 10, shadow `0 8px 24px hsl(0 0% 0% / .35)` dark / `.12` light).
  ```
  26 618                 +0.8% · +0.5σ
  Target (T+2d)          −₹934
  Expiry                 +₹3 210
  P(close above)         38%
  ```
  P(close above x) = N(−d₂), d₂ = (ln(x/F) − σ²T/2)/(σ√T) at the curve horizon with the shifted ATM IV.
- Click pins (exists); a pinned card gets a 1 px `--sel-bg` ring and an × to unpin.
- Coarse pointer: tap/drag pins (exists); the card docks **at the top of the plot** (full width, 2 lines) instead of following the finger.
- The head no longer shows the readout text; it shows only the legend and controls. When nothing is hovered the tooltip is hidden and the hint "Hover to read P&L" appears once, in the empty plot corner, fading after the first hover (per session).
- Keyboard (exists): ← → step one strike, Shift ×5, Esc unpins. The tooltip shows for the keyboard price.

### 4.4 Formulas the chart needs (options.js, pure, tested)
- `payoffModel(legs, m)` extended (`options.test.mjs`):
  - `horizonYears` = years from now to the target date (`el`); curves list: `[{ id:"expiry", vals }, { id:"target", vals, el }, { id:"mid", vals, el: (el + T1)/2 }]` (mid only when requested and T1 − el > 1 day).
  - `maxProfitAt` / `maxLossAt`: argmax / argmin price of the expiry curve (for the clamp arrow and the guides).
  - `density`: `pdf(S) = φ(z) / (S·σ·√t)`, `z = (ln(S/F) + σ²t/2)/(σ√t)`, `t` = horizon (first expiry when Curves = 1), σ = (ATM IV + shift)/100. Normalised to max 1 for drawing.
  - `profitIntervals`: from the expiry roots (exists inside `strategyStats`), returned for the ribbon clip.
- Multi-expiry (§5.1): `T1` = earliest active leg expiry. "Expiry curve" = value at `el = T1`, where legs expiring at T1 use intrinsic and later legs use Black-76 with `T_i − T1` remaining and their own IV + shift. It is **not** piecewise linear; label it "At 13 Nov (first expiry)". Breakevens then come from `curveRoots(f, xs)` (exists) instead of the kink solver; max profit/loss from the sampled curve (flag `approx: true`, tile sub "sampled").

### 4.5 Motion
| What | How | Duration / easing | Reduced motion |
|---|---|---|---|
| Model change (preset, add/remove leg, strike step, lots, B/S, CE/PE, expiry) | **morph**: resample the old curves onto the new `xs` with the existing `at()` interpolator, then tween every y value old → new in one rAF loop; areas, guides, BE dots and markers tween positions; y-axis ticks cross-fade (old labels fade out 120 ms, new fade in 160 ms) | 360 ms, `--ease-out` (cubic-bezier(.22,1,.36,1)) | instant |
| x-range change (new strikes widen the range) | the old range tweens to the new one inside the same loop (X() reads the interpolated lo/hi) | 360 ms | instant |
| Slider drag (target date, IV) | **no tween**: direct rAF redraw per frame (exists). On release, nothing extra. | — | — |
| Live tick (3 s) | no tween; paths patch in place (exists) | — | — |
| First draw on page open / first leg | expiry path draws in (`stroke-dasharray` = length → 0), areas fade 0 → 1, markers pop (`scale .6 → 1`) staggered 30 ms | 520 ms path, 240 ms fade, `--ease-out` | fade 120 ms only |
| Max/min pills, BE pills | opacity + 4 px translate | 180 ms | instant |
| Tooltip | opacity 0 → 1, 4 px rise; follows the pointer with no transition | 120 ms | instant |
| Curves toggle | added curve draws in (dash trick), removed fades | 280 ms | instant |

Implementation: one `tween(fromModel, toModel, ms)` in payoff.js using `requestAnimationFrame`; cancel on a newer `update()`; skip when `reducedMotion()` (motion.js) or when only prices changed (signature of legs/strikes/lots/sides/expiries unchanged). Only `d`, `x/y`, `opacity` and `transform` change. A frame stays ≤ 4 ms at 260 samples.

---

## 5. Features to add, with exact behaviour and formulas

### 5.1 Multi-expiry legs (calendars, diagonals) — MUST
- **Data:** each leg already has `expiry`. Drafts key by underlying only: `st.baskets[underlying]` (migration: old `underlying|expiry` drafts merge into `underlying`, keeping their leg expiries; one-time, tested in `strategy.test.mjs`). The toolbar expiry becomes "the expiry new legs use".
- **Pricing:** `strategy.js` keeps a `chains: Map<expiry, chain>` for every distinct leg expiry (max 3 extra; a 4th distinct expiry is refused with a toast). Extra chains refresh every 3 s alongside the main one, `strikes=40`, `greeks=true`, using the existing `/v1/optionchain` call. A leg whose chain is loading shows `--` price with a shimmer and blocks Place (`NO_PRICE`).
- **UI:** an expiry pill per leg row (`3 Nov`, 11.5 px 600, `--surface-2`, 72 px); tap opens a menu of the next 6 expiries with DTE (`13 Nov · 15d · M`). Changing expiry keeps strike/side/lots, clears `entry`.
- **Presets added (group Neutral / Volatile):** Long calendar (call), Long calendar (put), Diagonal (call), Double calendar, Double diagonal. Back month = the next listed expiry ≥ 7 days after the front (else the next one).
- **Maths:** §4.4. `strategyStats` for multi-expiry: max profit/loss/breakevens sampled at T1 (`approx: true`); POP = ∫ 1[pnl(S) > 0]·pdf(S) dS by Simpson over the model's `xs` at horizon T1. Greeks: each leg on its own T_i − el.
- **Warnings:** `CAL_EXPIRY_DAY` (warn) "Front leg expires today: no calendar benefit left"; `BACK_IV_LOWER` (info) when back-month IV < front-month IV − 2 pts ("Back month IV below front: calendars lose on IV convergence").

### 5.2 P&L table by spot — MUST
Tabs in the table head: `[By spot | Grid | Greeks]` (contrast segmented; phone shows By spot only).
- **By spot** rows: every listed strike step from `S − 6·step` to `S + 6·step` (13 rows; 9 at 1100–1279; 9 on phone), plus the breakevens inserted as rows (italic, "BE"). Mode chip `[Strikes | % | σ]` (keeps the old % and σ modes, `scenarioLevels`).
- Columns (desktop): `Price · Move % · σ · Target ₹ · Expiry ₹ · Expiry bar`.
  - `σ` = ln(P/F)/(σ√T₁), 1 decimal.
  - **Expiry bar**: a diverging inline bar (120 px, centre = 0): width ∝ |P&L| / max|P&L over rows|, `--c-pos` right / `--c-neg` left at 0.55, 8 px tall, radius 2.
  - Spot row: `--sel-bg` 3 px left edge + bold; rows inside ±1σ get `--c-neutral` 0.04 wash (same as the chart band, so the eye connects them).
  - P&L text in pos/neg ink.
- **Grid** (price × date heatmap, P1): rows = the 13 price levels, columns = dates from now to T1: `now, +1d, +2d … T1` (max 8 columns; if DTE > 7, evenly spaced). Cell = P&L at (price, date) with the IV shift; text 11.5 px tabular, background `--heat-pos(x)` / `--heat-neg(x)` with x = |v| / max|v|. Cell 64×30. Header shows `Thu 30` style dates. The column matching the target slider gets a `--c-atm` 2 px top edge; the spot row a `--sel-bg` left edge. Tapping a cell sets the target date and pins the chart crosshair at that price.
- **Greeks** tab: rows = the same price levels, columns `Δ lots · Γ · Θ ₹/day · ν ₹/pt` at the target date (`netGreeksModel` at each S). Δ cell has a diverging mini bar.
- All P&L respects the net-of-charges toggle (exists).

### 5.3 Risk & capital card — MUST
Lives in the build column (desktop) / below the legs (tablet, phone). Sections divided by hairlines, no nested borders:
1. **Margin vs funds bar** (full width, 10 px, radius 5): track `--mat-fill-1`; filled part = required margin, `--foreground` at 0.75; a 2 px `--c-pos` tick at "free funds"; if required > free, the excess segment turns `--c-warn` and the line under reads `Short by ₹2.29L` (warn ink). Labels: left `Margin ₹3.05L` (neutral ink, **never red**), right `Free ₹76.6K`. Sub (11.5 px quiet): `Account figure` or `Estimate · hedged ≈ ₹11.7K` with an ⓘ title explaining that paper accounts charge each leg without hedge benefit. Formula for the estimate: `marginEstimate` (exists).
2. **Greeks 4-up**: Δ (lots, and ₹/pt), Γ (Δ change per 1 %), Θ (₹/day, pos/neg ink), ν (₹/vol pt). Each with a 40×12 sparkline of the greek across the By-spot price levels (neutral stroke, a dot at spot). Click a greek → opens the Greeks tab.
3. **Return line** (12.5 px): `ROM 1.1% · R:R 1 : 3.7 · EV +₹412 · Charges ₹186`. Charges opens a popover with the breakdown (brokerage, STT, exchange, GST, stamp, SEBI) from `O.charges` (exists).
4. **Probability line**: `POP 72% · P(max profit) 41% · P(touch 25 957) 58%` (P1). P(max profit) = P(S_T in the max-profit interval) from the lognormal. P(touch a BE) ≈ min(1, 2·P(close beyond BE)) (reflection approximation; title says so).

### 5.4 Hero strip (replaces the 8 equal tiles) — MUST
5 cells, desktop 72 px tall, value 20 px 700 tabular, label 11 px 600 uppercase 0.06em quiet, sub 11.5 px:
| Cell | Value | Sub |
|---|---|---|
| Net | `Credit ₹3 319` / `Debit ₹1 240` (neutral ink) | `4 lots · after charges ₹3 133` |
| Max profit | `+₹3 210` pos ink, or `Unlimited ↗` | `at 25 957–26 893` (the max interval) |
| Max loss | `−₹11 869` neg ink, or `Unlimited ↘` + stress sub | `below 25 800 / above 27 050` |
| POP | `72%` + a 28 px ring gauge (track `--mat-fill-2`, arc `--c-pos` if ≥ 50 % else `--c-warn`; arc animates 0 → value 420 ms on first draw) | `at expiry · IV model` |
| Breakevens | `25 957 · 26 893` (14 px when 2+; one per line on phone) | `−1.7% · +1.8%` |
The customisable metric strip (round 1) remains as **"More figures"** below the payoff on desktop: one 32 px quiet row of the user's extra metrics (`At target · Theta · ROM …`), editable via Customise. Long rupees (> 7 chars) use `₹` + `formatCompact` (`₹3.05L`). Values never truncate.
Value changes: the number cross-fades (opacity 0.4 → 1, 160 ms) and, on a live tick, its text flashes the sign colour for 600 ms (reduced motion: none).

### 5.5 Leg rows and per-leg quick edits — MUST
Desktop row (40 px): `[●] [B] 25 800 ‹ › [PE] [3 Nov] [− 1 +] 25.90 16.2 −0.10 [⋯]`
- **Include**: replace the system checkbox with a 10 px dot button (filled `--foreground` = on, ring = off; 28 px hit area, 44 px on coarse). Off rows fade to 0.4 and their strike marker on the chart disappears.
- **Side stripe**: 3 px left edge on the row in `--c-buy` / `--c-sell`. **B/S tag**: 24×22, solid `--c-buy` / `--c-sell` at 0.16 fill with role ink letter, 700; click toggles.
- **Right chip** `CE` / `PE`: ink `--c-call` / `--c-put`, fill same at 0.12; FUT neutral. Click toggles.
- **Strike** `‹ 25 800 ›`: arrows 28×28 (44 on coarse), full `--foreground` 0.7, hover fill-2. **Long-press / hold on an arrow repeats every 120 ms after 400 ms.** Alt+click jumps 5 strikes. Clicking the strike number opens the picker scrolled to it.
- **Expiry pill** (§5.1).
- **Lots stepper** (exists) + quantity in the title.
- **Price** cell: per-unit price, click to **override the entry price** (inline numeric input, tick-rounded; overridden prices show in `--c-atm` ink with a small "✎", and a "Reset to live" item in ⋯). Feeds every figure; Place still sends at the live limit unless the confirm sheet's limit is edited.
- **IV** cell: click to override the leg IV (P1; shown with ✎; feeds target curve/greeks/POP, not the expiry payoff).
- **⋯ menu**: Duplicate · Roll strike out / in (one step away from / towards spot) · Roll to next expiry (same strike, next listed expiry) · Add wing (for a sell leg: buy the same right `w` steps further OTM, `w` = the smallest step count whose premium ≤ 25 % of the short's premium, min 2) · Close leg (held legs) · Remove.
- Price change on a tick: the price text flashes pos/neg ink 600 ms (reduced motion: none).
- Phone leg card (52 px): left 3 px side stripe, `[B] 25 800 PE · 3 Nov` (strike 15 px 700, right chip, expiry 11 px quiet), `×1` and price right-aligned, `‹ ›` hidden; tap expands an inline second row (animated height 200 ms): `‹ strike ›  CE/PE  − lots +  expiry  ⋯`.

### 5.6 Leg tools and size multiplier — MUST
`[+ Add leg] [‹ Shift ›] [Size − 1× +] [⋯]` then `4 legs · 4 lots · ₹3 319` right-aligned.
- **Size multiplier**: `g = gcd(lots_i)`, `ratio_i = lots_i / g`, size shown = `g×`. − / + set `g' = g ∓ 1` (min 1, max `floor(100·freeze / max ratio)`); `lots_i ← ratio_i · g'`. Typing a number sets g' directly. Replaces the ÷2 / ×2 buttons (keys `-` / `=` when the builder has focus).
- **Shift** (exists): `[` `]`.
- `⋯`: Clear (with Undo), Flip all sides (B ↔ S: turns a credit structure into its debit mirror), Delta-neutralise (§5.8).

### 5.7 Strategy suggestions by view — MUST (P0 after the above)
A collapsible **Suggest** section (desktop: build column bottom; phone/tablet: below Risk & capital; also the empty-state CTA "Suggest from my view").
- **Inputs (one row each):** Target price (numeric with ‹ › strike steps and a slider S ± 2σ; defaults to spot; quick chips `−1σ · −½σ · Spot · +½σ · +1σ`), By date (expiry select, defaults to the toolbar expiry), Risk `[Defined | Any]` contrast segmented, Max capital (optional ₹).
- **View inferred**: `Pt > S + 0.25σ_move` → bullish; `< S − 0.25σ_move` → bearish; else neutral. A "Big move either way" chip forces the Volatile group.
- **Candidates:** every preset in the inferred group (+ calendars when the date is not the first expiry), each with strike variants: the anchor strike = the listed strike nearest `Pt` (directional) or nearest F (neutral); spread widths w ∈ {1, 2, 3, 4} steps; short-strike offsets ∈ {0, ±1, ±2} steps. Cap 400 candidates; evaluated in chunks of 50 with `requestIdleCallback` (fallback `setTimeout 0`), cancelled on input change.
- **Metrics per candidate** (pure `O.suggestStrategies(chain, view, opts)`, tested): `pnlT` = P&L at (Pt, date) via `valueAt` with ATM IV; `maxLoss`, `pop`, `margin` = `marginEstimate`; `capital` = max(margin, |maxLoss|, debit).
- **Score** = `pnlT / capital` (return on risk at the target), tie-break by POP. Filter out `pnlT ≤ 0`, `capital > maxCapital`, undefined risk when Risk = Defined.
- **Output:** top 6 cards (2-col grid desktop, 1-col phone): glyph 64×28 (the preset glyph with the target marked by a `--c-atm` tick), name + strikes (`Bull call 26 400 / 26 600`), `+₹4 120 at target` (pos ink, 15 px 700), `Max loss −₹6 300 · POP 46% · ₹6.3K capital`. **Click → loads the legs into the draft with Undo**; the chart morphs (§4.5) and the target-date slider jumps to the chosen date and the crosshair pins at Pt.
- Empty result: "Nothing makes money at 26 800 by 3 Nov within ₹50K. Try a later date or more capital."

### 5.8 Adjustments — SHOULD
- **Delta-neutralise** (⋯ in leg tools): with Δ_lots the net delta in lots, propose `round(−Δ_lots × lot / fut.lot)` FUT lots (if a future is loaded) or ATM options: n = round(−Δ_units / (δ_ATM × lot)), side by sign. Shows a preview line "Adds Sell 1 FUT 27 Nov · Δ −0.42 → +0.03" with Apply / Cancel.
- **Roll** (leg ⋯, §5.5) and **Add wing**.
- **Convert** (header ⋯ when the structure is detected, `detectStructure` exists): Short strangle → Iron condor (add wings at ±w), Short straddle → Iron fly, Naked short → credit spread.
Each adjustment is an `undoLabel` mutation, so the toast offers Undo and the chart morphs.

### 5.9 Saved strategies — SHOULD (improve what exists)
The Saved popover becomes a sheet list: each row has the mini glyph, name, `NIFTY 3 Nov · 4 legs`, "since saved" P&L (pos/neg ink, exists) and **Compare** (P2: draws the saved strategy's expiry curve as a 1 px `--c-neutral` dashed overlay on the chart, legend "Saved: <name>"). Auto-name a draft from `detectStructure` ("Iron condor 25 800/26 000/26 850/27 050"); the head shows the name and it is editable inline.

### 5.10 Per-leg payoff overlay — P2
Chart ⋯ "Show per-leg payoffs": each active leg's expiry P&L as a 1 px line in its right colour (`--c-call`/`--c-put`), dash 2 3 for sells, 0.6 opacity. Hover a leg row highlights its line (others fade to 0.2).

---

## 6. States

### 6.1 Empty (no legs)
- Analysis column: the payoff slot shows a **ghost**: a sample iron-condor curve drawn at `--c-neutral` 0.10 with the profit band at `--c-pos` 0.05, and centred text (14 px 600) "Pick a strategy or add a leg" + secondary "or Suggest from my view →" (link button that opens §5.7). No outlined box.
- Hero strip shows labels with `—` in quiet ink (not eight "--" tiles).
- Build column: group segmented + **preset cards** (desktop 2-col grid, glyph 64×28 + name + hint + risk tag) instead of chips; the leg table is hidden; `+ Add leg` primary-tinted.
- Phone: the preset sheet's content is inline on the page.

### 6.2 Loading
First load or underlying switch: skeleton matching the layout (hero 5 grey blocks, plot rect with 3 faint grid lines, 4 leg rows 40 px). Shimmer 1.2 s linear at white/black 4 %; none under reduced motion. Extra-expiry chains loading: only the affected legs shimmer.

### 6.3 Errors and stale
- Chain error with a draft: keep the last figures at opacity 0.72, a 2 px `--c-warn` bar on top of the panel, and a one-line note under the head "Prices are 14 s old · Retry". Place is blocked (`STALE`, new warning code: chain age > 15 s).
- A leg without a price: its price cell `—` with a `--c-warn` dot; hero values that depend on it show `—`; one warning line "26 800 CE has no price" (exists).
- Funds unavailable: margin bar shows required only, sub "Funds unavailable"; no shortfall check.
- Warnings list (exists) renders as a single 36 px row under the hero strip: severity dot (block red, warn `--c-warn`, info neutral) + first warning + "+2 more ▾". Never a full-width red sentence.

---

## 7. Typography and spacing
- Fonts: `--font-display` for the head title (16 px 700), `--font-body` labels, `--font-numeric` with `tabular-nums` and slashed zero for every figure.
- Sizes: hero value 20/700 (desktop), 17/700 (phone); table figures 13/500; leg strike 13.5/700; axis 10.5/500; chart pills 10.5/650; labels 11/600 uppercase 0.06em in hero, sentence case elsewhere.
- Spacing scale 4/8/12/16/20. Panel padding 16 desktop, 12 phone. Sections inside a panel divided by `--separator` hairlines (inset box-shadow, `--hl`), never boxes inside boxes. The leg table loses its outer ring (hairlines only).
- Touch: every control 44 px on `(pointer: coarse)` (exists in §12d; extend to the new dot toggle, expiry pill, size stepper, chart controls, suggestion cards).
- No horizontal page scroll on any device; inner scroll only for the chip row (tablet) and the Grid tab (≥ 8 columns on phone is not offered).

---

## 8. Interactions and keys (additions)
| Key | Action |
|---|---|
| `G` | Focus Suggest target price |
| `-` / `=` | Size multiplier down / up |
| `E` | Open the focused leg's expiry menu |
| `1` `2` `3` with chart focused | Curves 1 / 2 / 3 |
| `Alt` + ‹ › | Jump 5 strikes |
| existing | `A` add leg, `[` `]` shift, `⇧P` place, `Ctrl S` save, `Ctrl Z` undo, `T` target slider, `?` help |
Keys are ignored while typing (exists). The `?` overlay lists the new keys.

---

## 9. Acceptance checks (screenshots: 3 devices × 2 themes, empty + Iron condor + Calendar)
1. Dark canvas reads black (#040404); no brown/olive areas; profit fill fades green → transparent at zero; loss fill fades red.
2. Every selected segment / chip / tab is white-on-black (dark) or black-on-white (light), including the group control, the active preset, `Curves`, the table tabs and `Strikes | % | σ`.
3. Strategy page shows one top line; no "Demo paper account", no "Paper" badge, no "as of", no chain tiles; the only demo marker is the toolbar pill.
4. Desktop 1440×900 with an Iron condor: hero strip, full payoff and what-if visible without scrolling; the build column has no empty area below the legs.
5. Phone 390×844 with legs: hero + payoff start within the first 420 px.
6. Breakeven labels never overlap a curve; spot pill never overlaps a band label.
7. Applying a preset morphs the curves (record a 10-frame strip); with `reducedMotion: 'reduce'` it snaps.
8. Margin is never red; shortfall shows as the `--c-warn` segment.
9. A calendar (two expiries) draws a curved "At first expiry" line, shows sampled breakevens and a POP.
10. Toast never covers the chart or the sticky bar.
11. `npx vitest run` and `npm run -s check:mjs` pass; new pure functions (`payoffModel` extensions, density, `suggestStrategies`, multi-expiry stats, size multiplier `sizeLegs`, draft migration) have tests.

---

## 10. MUST-DO list (ordered by value)
1. **Contrast and colour pass**: near-black dark surfaces, `--sel-bg`/`--sel-fg` on every selected control, call/put chips, buy/sell tags and side stripe, dot toggle instead of checkboxes, margin never red, Place button full-strength (§2, §5.5).
2. **Payoff chart rebuild** in payoff.js: gradient profit/loss fills, expiry line split by sign, solid `--c-atm` target curve (+ optional mid-date), soft ±1σ/±2σ bands with bottom labels (no dashed box), spot contrast pill, strike markers by right and side, BE pills below the axis, max profit/loss guides and pills, y-clamp arrow, floating tooltip with σ and P(close above), Curves toggle (§4.1–4.3).
3. **Chart motion**: morph tween on model changes, draw-in on first legs, reduced-motion fallback, no tween while dragging (§4.5).
4. **Compact top + one demo marker**: shared top line, chain summary panel removed from `#/strategy`, account picker moved to the confirm sheet (§3.1).
5. **Layout per device**: desktop build column with Risk & capital (no dead zone); tablet payoff above legs; phone hero + payoff first, presets in a bottom sheet, what-if as chips + sheet; sticky bar and raised toasts (§3.2–3.5).
6. **Hero strip + Risk & capital card**: 5 hero cells with POP ring, margin-vs-funds bar, greeks 4-up with sparklines, ROM / R:R / EV / charges line (§5.3, §5.4).
7. **P&L table by spot**: strike-step rows with BEs, σ column, diverging expiry bars, spot and ±1σ marking; `Strikes | % | σ` modes (§5.2 By spot).
8. **Per-leg quick edits**: hold-to-repeat strike arrows, Alt jump, entry price override, ⋯ menu (duplicate, roll strike, roll expiry, add wing, close, remove), phone expanding card (§5.5).
9. **Size multiplier** replacing ÷2/×2, plus Flip all (§5.6).
10. **Multi-expiry legs**: per-leg expiry pill, extra-chain pricing, draft migration to per-underlying, calendar/diagonal presets, sampled stats and POP, new warnings (§5.1, §4.4).
11. **Strategy suggestions by view**: target price/date/risk/capital → ranked top-6 cards that load into the draft (§5.7).
12. **Price × date Grid and Greeks tabs** in the P&L table (§5.2).
13. **Empty / loading / stale states**: ghost payoff, preset cards, skeleton, stale bar and `STALE` block, single-line warnings row (§6).
14. **Adjustments**: delta-neutralise, convert structure (§5.8).
15. **Distribution ribbon + probability line** (P(max profit), P(touch)) (§4.1 #8, §5.3).
16. **Saved strategies sheet** with glyphs, auto-naming, Compare overlay; per-leg payoff overlay (§5.9, §5.10).
