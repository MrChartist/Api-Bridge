# Design spec: Positions and Risk, round 2 (`#/positions`)

Status: ready to build · Unit: Positions · File: `server/bridge/dashboard/positions.js` (plus its `app.css` section `12e · POSITIONS AND RISK`, and pure maths in `options.js` + `options.test.mjs`)
Builds on: PRD 04 (`docs/prd/04-positions.md`, all behaviour kept unless this spec says otherwise), `docs/design/foundation.md` (tokens, motion, `viz.js`, top bar, one demo indicator), `docs/design/strategy.md` §4 (payoff anatomy; Positions must look like the same chart).

Evidence: screenshots at 390×844, 820×1180 and 1440×900, in dark and light, with the seeded demo book (iron condor on 3 Nov plus a short 26300 PE on 10 Nov, and a BANKNIFTY leg). They are in
`/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/shots2/positions/<device>-<theme>[-full|-risk|-book|-legs|-hover|-scen].png`. The script is `scratchpad/posd.cjs`. None of the six shots scrolls sideways.

Reference bar: the cleanliness of Sahi Terminal; the risk depth of Sensibull "Positions → Analyse", the OptionStrat P&L heatmap, tastytrade's "Analysis" curve and BP bar, and thinkorswim's Risk Profile.

---

## 1. What is wrong today (specific, from the screenshots)

### 1.1 Chrome and space
1. **Three bands before any risk number.** The toolbar (Positions pill, a "Demo data" pill, an IST clock, search and refresh) sits above the `.desk-top` panel ("NIFTY ▾", "Demo paper account ▾", a "Paper" badge, "● as of 09:18:38", a green "Live" button).
   - On desktop the book starts at y = 152. On phone it starts at y = 226, and the `.desk-top` panel alone is 150 px tall.
   - Fix: the foundation top bar (§5). On this page the capsule shows **Underlying │ Account │ Spot ±chg**, with no expiry, because the page covers every expiry.
2. **The keyboard hint row** (`J K row · Space select · I include …`) is always shown under the table. It takes 1 row on desktop and 2 rows on tablet, and it is the noisiest thing in the panel. It belongs behind `?`.
3. **The phone book strip is 377 px tall.** It is five stacked tiles of big numbers, so the first leg card starts at y = 680, below the fold. Text in a 2×3 grid is not a summary.

### 1.2 Colour and visual encoding
4. **The book is six text tiles with no visual.**
   - Margin reads "₹9.22L used · 92.3 % of funds" in plain ink. This is the most dangerous number on the page, and nothing marks it.
   - The Net Δ tile ("+16 ≈ +0.2 lots") gives no sense of whether +16 is small or large.
   - The Γ tile label "Γ · Δ per 1%" with the value "−17" can't be read without the title.
5. **Leg P&L is text only.** You cannot see at a glance that the 26600 CE (−₹5 668) wipes out every other leg. No bars, and no breakdown of winners against losers.
6. **The Distance column is only text.** "0.0σ ↑" is amber text, the only cue that a short strike is at the money. There is no gauge.
7. **The include checkboxes are browser blue** (foundation §1.4). The B/S tags are blue and red tints that do not match any token. CE and PE are not coloured anywhere.
8. **Payoff chart** (desktop `-risk.png`):
   - The "At expiry" curve is a thin grey line with flat green/red slabs under it. The "Now" curve is the only coloured line.
   - The ±1σ/±2σ band is drawn as a **dashed rectangle** the full chart height, which reads as a selection box.
   - The spot label "26555" is blue on that dashed edge. The breakeven label "26558" sits on the curves.
   - There are only 2 x-ticks (26000, 27000).
   - The chart **stretches to 595 px** to match the scenario column. The deep loss tail (−₹60K at 25 700) takes 70 % of the height, which flattens the profitable region to a 40 px hump.
   - The readout "At 26555: now −₹45" is plain text above the chart. It does not say that it is *unrealised* P&L, so it seems to contradict the Net P&L tile (−₹1 541, which includes −₹1 492 realised).
   - No strike markers. You cannot see where your legs are.
9. **Scenario matrix**:
   - The tints are flat alpha washes (0.06–0.28) of one red and one green. In dark mode the −₹74K cells and the −₹7K cells look almost the same muddy maroon.
   - There is no legend for the scale.
   - The current cell is outlined in accent blue, not in the contrast colour.
   - The sliders are native blue. The selected chips "0" and "Today" are a blue tint, not the contrast state.
   - The footer reads "Max profit at expiry --" and "Max loss at expiry --" for any book with two expiries, which is almost every real book.
10. **No stress summary.** A seller has to find the ±1σ row in an 11-row matrix to answer "what if NIFTY moves one sigma?".
11. **The dark theme is warm charcoal** (#1C1A19-ish panels on #121110), not near-black (foundation §1.3).

### 1.3 Motion
12. Nothing moves. Values swap without a flash. Bars do not exist. The payoff path jumps on every slider change (that part is correct) and on a leg change (that part is not). The matrix rebuilds cells without a transition. There is no first-draw reveal.

### 1.4 Feature gaps (vs Sensibull, OptionStrat, tastytrade, thinkorswim)
13. No **P&L by leg** visual and no winners/losers split.
14. No **Greek gauges**: no delta band and no Θ:ν balance.
15. No **margin/funds bar**, and no estimate of this book's share of the margin.
16. No **±1σ/±2σ stress chips**.
17. No **book POP** and no sampled **max profit/loss at the first expiry** for multi-expiry books.
18. No **"Net if closed now"** (P&L after exit charges).
19. No **Greeks across spot** (how Δ changes as spot moves: thinkorswim's Risk Profile greeks mode).
20. No **per-group mini payoff glyph** that shows the shape of each structure.

---

## 2. Colour roles (foundation tokens only; no new hues)

| Role | Token (foundation §4) | Used on this page for |
|---|---|---|
| gain / loss | `--pos`/`--pos-ink`, `--neg`/`--neg-ink` | P&L values, leg P&L bars, payoff profit/loss fills and the expiry curve split by sign, Θ value (₹ per day is money), stress chips, the heatmap via `--div-*` |
| buy / sell tag | `--pos-ink` / `--neg-ink` on a 12 % (light) / 16 % (dark) tint | the `B` / `S` square. The letter carries the meaning; colour is secondary |
| call / put | `--dv-call-ink`, `--dv-put-ink`; fills `--dv-call`, `--dv-put` | "CE"/"PE" suffix text in contract cells, strike markers on the payoff x-axis |
| neutral risk | `--foreground` at `--a-label` | Δ, Γ, vega bars, margin used segment (**never red unless over a threshold**) |
| vol | `--dv-iv` / `--dv-iv-ink` | vega gauge bar, IV column |
| warning | `--warn` / `--warn-ink` | tested shorts (< 0.5σ), Δ outside band, margin 70–90 %, hedge-early, stale |
| spot / now | `--dv-spot` + contrast pill `--sel-bg`/`--sel-fg` | spot line and pill on the payoff, the "now" row in the heatmap |
| today curve | `--dv-today` | "Now" (T+0) curve on the payoff, the target-days slider fill |
| σ bands | `--dv-band` (±1σ), `--dv-band` at 0.5 alpha (±2σ) | payoff background bands, σ ticks in the distance gauge |
| heat | `--div-n3 … --div-p3` + `--div-ink-*` | scenario heatmap, stress chips |
| selection | `--sel-bg` / `--sel-fg` | every segmented, chip, tab, the include checkbox, the current heatmap cell ring, the pinned tooltip ring |
| grid / axis | `--dv-grid`, `--dv-axis` | payoff and gauge ticks |

Rules:
- **Green/red mean money only.** Δ, Γ and margin are neutral ink until they cross a threshold, and then they turn **warn**, never red. The exception is margin at 90 % or more, which turns `--neg`, because a margin call is money.
- **Vega is not coloured by sign.** A long-vega book is not "good". Its bar is `--dv-iv`, and its value text is fg with an explicit sign.
- **Calls and puts are never green/red.** They are blue/orange, and only on the CE/PE text and the strike markers.
- The `--ios-*` references in today's `12e` CSS (`--ios-green-ink`, `--ios-orange`, `--ios-red`) are replaced by the role tokens above.

---

## 3. Layout per device

Breakpoints as in PRD 04: phone < 720, tablet 720–1099, desktop ≥ 1100. Panel padding 12, gap 12, radius 16 (foundation §8). The panels stay movable (`arrangePanels`): `book`, `positions`, `risk`, `hedge`, `chartslot`.

### 3.1 Desktop 1440×900 (content ≈ 1116 px wide)
```
┌ toolbar 52px: [Positions] [NIFTY▾ │ Paper account▾ PAPER │ 26 555.10 +41.2 (+0.16%)]  ···  [● 09:18:41] [● Demo] [⌕] ┐
├ book (≈148px) ─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Also open: [BANKNIFTY · 1 leg · −₹1 755]                                                                            │
│ ┌ HERO 300px ─────────────────┐┌ GREEKS 1fr ──────────────────────────────────┐┌ CAPITAL 300px ──────────────────┐ │
│ │ NET P&L                     ││ Δ   +16   ≈ +0.2 lots  ─────────┼▌──────  band ±75 ││ Margin  ₹9.22L of ₹9.97L        │ │
│ │ −₹1 541          22px       ││ Γ   −17 Δ/1%          ──────▐▌┼─────────         ││ ████████████████████████░  92%  │ │
│ │ ▕██████▏▕█████████████▏▕██▏ ││ Θ   +₹966/day         ─────────┼████▌──── (pos)  ││ ≈ this book ₹1.38L · free ₹76.6K │ │
│ │ won +₹4 940 lost −₹5 668 R −₹1 492││ ν   −₹1 591/pt        ──▐█████┼───────── (iv)    ││ Stress  −2σ −₹19K −1σ −₹6.9K     │ │
│ │ Credit kept ▕██▏···|50·|80  0%││                                               ││         +1σ +₹2.4K +2σ +₹2.0K    │ │
│ │ Net if closed −₹1 712        ││  POP ≈ 41% at 3 Nov · Θ/ν 0.61                ││                                  │ │
│ └─────────────────────────────┘└──────────────────────────────────────────────┘└──────────────────────────────────┘ │
│ ⚠ Short 26600 CE tested (0.0σ)   ⚠ Hedge 3 Nov expires before 10 Nov shorts                                         │
├ positions ──────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ NIFTY positions · 5 legs                                                       [Exit all] [Customise]                │
│ ☑ Contract        Lots  Avg → Mark      P&L                 P&L %    Δ          Θ ₹/d   Vega ₹  IV   Distance      │
│ ▾ 3 Nov · 5d · Iron condor [glyph] P&L −₹1 089 · Δ −7 · Θ +₹396 · kept ▕▏−17%                  Analyse  Exit group  │
│ ☑ B 26000 PE      +1   25.05 → 30.83  +₹433  ──┼▌        +23.1%   −9 ─▐┼   −₹688   +₹484  15.9  ●──|──── 1.3σ ↓ │
│ ☑ S 26600 CE      −1   86.50 → 162.08 −₹5 668 ███┼        −87.4%   −36 ██┼  +₹1 395 −₹953  13.5  ●|─────── 0.0σ ↑ │
│ …                                                                                                                    │
├ risk ───────────────────────────────────────────────────────┬──────────────────────────────────────────────────────┤
│ PAYOFF 1.25fr (360px fixed)                                 │ SCENARIO 1fr                                         │
│ ━ Now  ━ ━ Target  ━ At 3 Nov expiry  ▒ ±1σ ▒ ±2σ   [Curves]│ Spot  ──●──  −1.50% · 26 157   [−2σ −1σ 0 +1σ +2σ]   │
│ [contrast spot pill]  strike markers ▲△ on the axis          │ IV    ──●──  +0.0 pts                                │
│ BE pills under the axis · Max/min guides · tooltip card      │ Days  ●────  Today            [Today +1 +3 Expiry]   │
│                                                              │ At scenario −₹45 (vs now ₹0) · Δ +16 · Θ +₹1 048    │
│                                                              │ [Spot × IV | Spot × Days | Greeks]       Reset      │
│                                                              │ HEATMAP 11 rows × 5 cols, 28px rows, div scale      │
│                                                              │ legend ▕−76K ▇▇▇▇▇▇▇ +7.8K▏                         │
├ hedge (collapsed 44px) ────────────────────────────────────────────────────────────────────────────────────────────┤
```
- **Book grid**: `grid-template-columns: 300px minmax(0,1fr) 300px`, with 1 px `--mat-separator` dividers between the three cells (no nested cards). Height ≈ 148 px. That is 14 px less than today, and it carries far more.
- **Positions table**: the P&L cell gets an inline diverging bar (§4.4) and the Distance cell a σ gauge (§4.6). The Δ cell gets a small diverging bar. The rest is as today.
- **Risk**: `grid-template-columns: minmax(0,1.25fr) minmax(0,1fr)`. **The payoff height is fixed at 360 px** and no longer stretches to the scenario column (`fill()` is removed). When the scenario column is taller, the payoff column holds the "Greeks across spot" strip (§4.9) under the chart.
- Data starts at y ≈ 64 (book) instead of 152.

### 3.2 Tablet 820×1180 (portrait, coarse pointer)
- Toolbar: `[icon] [NIFTY▾ │ Paper▾ │ 26 555 +0.16%]  ···  [● time] [⋯]`.
- **Book**: two columns. The left column holds the hero above capital (margin bar + stress). The right column holds the 4 greek gauges. About 230 px.
- **Positions table**: hide IV, Vega and P&L % (PRD 04 §4.2). The P&L bar and the σ gauge stay; the σ gauge shrinks to 36 px.
- **Risk**: a contrast segmented control `[Payoff | Scenario | Greeks]` in the panel head. Payoff 300 px. The heatmap shows 5 columns at full width (cell min-width 96).
- The key hint row is removed; `?` shows it.

### 3.3 Phone 390×844
- Toolbar per foundation §5.2: two-line `NIFTY ▾ / 26 555 +0.16%` and `Paper ▾ / PAPER`, live dot and ⋯.
- **Book (target ≤ 220 px, was 377)**:
  ```
  NET P&L                              Credit kept 0%
  −₹1 541                     22px     ▕▏····|50 |80
  ▕██████▏▕██████████▏▕█▏  won +4.9K · lost −5.7K · R −1.5K
  ┌──────────────┬──────────────┐
  │ Δ +16   ──┼▌─ │ Θ +₹966 ─┼█─ │   gauges 2×2, 44px each
  │ Γ −17   ─▐┼── │ ν −₹1.6K ▐█┼ │
  └──────────────┴──────────────┘
  Margin 92% ███████████████████░   free ₹76.6K
  ⚠ 2 warnings ›
  ```
  - Stress chips go into the Scenario tab (below the sliders), not the book.
  - "Also open" becomes one scrolling chip row above the hero, only when present.
- **Positions**: cards as today. Line 1 is `[S] 26600 CE −1` with the P&L right-aligned. Under the P&L sits a **56×4 px diverging micro-bar** (§4.4). Line 2 is `86.50 → 162.08 · Δ −36 · Θ +₹1 395` plus the **σ gauge** (36 px) at the right end.
  - The group header shows a 40×16 payoff glyph (§4.8) and P&L. The group's "Analyse / Exit group" button row stays.
- **Risk**: segmented control `[Payoff | Scenario]`. Payoff 240 px (was 200). The tooltip docks at the top of the plot. The Scenario tab holds the stacked sliders, the stress chips (4 in one row) and a 3-column heatmap: `IV −5 | now | +5`, or `Today | +3 | Exp` for days. Row labels stay on one line: `−5% 25 227` at 11 px, never wrapped (today they wrap).
- **Hedge**: collapsed one-liner as today.
- Leave 88 px of bottom padding for the floating tab bar. On tablet the bar today covers the payoff x-axis (`tablet-light-full.png`).

---

## 4. Visuals (what each encodes, scales, legends)

All visuals use `viz.js` helpers from foundation §10.2 (`hbar`, `legend`, `heatCell`, `spotPill`, `svgEl`, `scrubber`), plus bar sizes set through `el.style.setProperty("--v", …)`. No `style=""` attributes. No chart library.

### 4.1 Hero: Net P&L with a composition bar
- **Value**: `formatSignedRupee(U + R, 0)`, 650 22px `--font-display`, tabular, in `--pos-ink`/`--neg-ink`. Label "NET P&L" 11px 600, 0.06em, `--a-quiet`.
- **Composition bar** (full cell width, 8 px, radius 4, gap 2 px between segments). It answers "where did the P&L come from":
  - `W = Σ max(0, U_i)` (winning legs, unrealised), `Lo = Σ min(0, U_i)` (losing legs), `R = Σ R_i` (realised today, signed).
  - The segment widths are proportional to `|W|`, `|Lo|` and `|R|` over `|W| + |Lo| + |R|`.
  - Colours: W = `--pos`, Lo = `--neg`. R = `--pos` or `--neg` at 0.55 with the hatch pattern (`#dv-hatch-*`), so that realised reads as "locked in" and differs from open P&L.
  - Order: W, Lo, R. A segment under 2 % width is dropped from the bar but kept in the caption.
  - Caption, 11.5px: `won +₹4 940 · lost −₹5 668 · realised −₹1 492`. Each number is in its ink; the words are `--a-label`.
  - Tap or hover a segment → the legs table highlights the contributing rows (fill `--mat-fill-2`) for 1.2 s.
- **Credit kept meter** (only when book credit > 0, PRD 04 §5.1 formula):
  - a 120×6 track `--mat-fill-2`, fill = `clamp(kept, 0, 100) %` in `--pos`;
  - when kept < 0, the fill grows **leftwards** from the track start in `--neg`, clamped at −100 % with a `◂` cap;
  - ticks at 50 % and 80 % (1×10 px `fg/0.35`), labelled "50" and "80" at 9.5 px: the usual book-profit targets;
  - text `Credit kept 0% of ₹17.0K`.
- **Net if closed now** (new, §7.3): `Net if closed −₹1 712`, 12.5px, with an ⓘ title for the charge breakdown.

### 4.2 Greek gauges (4 diverging bullet bars)
One row per Greek: label (24 px) · value (tabular, 92 px, right-aligned) · sub (lots/units, `--a-quiet`) · bar (flex 1, min 96 px).

| Greek | Value | Bar encodes | Scale `M` (half-width) | Bar colour | Threshold cue |
|---|---|---|---|---|---|
| Δ | `formatSigned(Δ,0)` + sub `≈ {Δ/L_fut} lots · ₹{|Δ|·S}` | Δ units | `M = max(2·B, 1.15·|Δ|)`, where `B` = **delta band** (`cfg.deltaBand`, default `L_fut`, one futures lot) | fg at `--a-label` | a `--dv-band` zone ±B behind the bar. Outside the band the bar and value turn `--warn` and the sub reads `outside ±75 band` |
| Γ | `formatSigned(Γ·S·0.01, 0)` "Δ per 1%" + sub `Γ −0.07/pt` | Δ change per 1 % move | same `M` as Δ, so you can see whether a 1 % move pushes you out of the band | fg at `--a-label` | short Γ with `|Γ·S·0.01| > B/2` → `--warn` |
| Θ | `formatSignedRupee(Θ,0)/day` + sub `5.7% of option value` | ₹/day | `M_tv = 1.15·max(|Θ|, |ν|)`, shared with ν | `--pos` if > 0, else `--neg` | none |
| ν | `formatSignedRupee(ν,0)/pt` + sub `IV −1 → +₹1 591` | ₹ per vol point | `M_tv` (shared) | `--dv-iv` | none |

- The bar track is `--mat-fill-1`, 6 px tall, radius 3, with a 1×12 px `fg/0.35` zero tick in the centre. The fill grows from the centre (`transform: scaleX(var(--v))`, origin centre-left or centre-right). Minimum 2 px when non-zero.
- Footer line in the greeks cell, 11.5px `--a-label`: `POP ≈ 41% at 3 Nov · Θ/ν 0.61` (§7.2; Θ/ν = |Θ|/|ν|, the "days of decay per vol point" a seller watches).
- Partial books (excluded or unpriced legs) keep the "partial" chip in the label (exists).
- Click a gauge → on desktop it opens the Scenario column's **Greeks** tab (§4.9); on phone, the Scenario tab.
- **Setting**: `deltaBand` (units, or null for one futures lot) is added to `positionsConfig` and edited in Customise as "Delta band ±".

### 4.3 Capital: margin and funds bar, stress chips
- **Bar** (full cell width, 10 px, radius 5, track `--mat-fill-2`):
  - `used = usedMargin`, `free = availableCash`, `total = used + free` (else `totalBalance`).
  - Segment 1 is **this book's estimated margin** `m_b` (§7.4), hatched in `fg/0.55`.
  - Segment 2 is `used − m_b` (other underlyings) in solid `fg/0.55`.
  - The rest is free.
  - When `util = used/total` reaches 0.70, both used segments turn `--warn`; at 0.90 or more they turn `--neg`. The `util` value text follows the same colour.
  - Value line: `Margin ₹9.22L of ₹9.97L` (left), `92%` (right, 650).
  - Sub: `≈ this book ₹1.38L · free ₹76.6K`. Title: "Account-wide margin from your broker. 'This book' is an estimate without hedge benefit from the broker."
  - Funds unavailable: the track is shown empty with the text "Funds unavailable" in `--a-quiet`.
- **Stress chips** (4, one row, gap 6):
  - `−2σ −₹19K` · `−1σ −₹6.9K` · `+1σ +₹2.4K` · `+2σ +₹2.0K`.
  - Value = `O.scenarioPnl(inc, { dS: e^{kσ√T₁} − 1 })` at now (days 0, dIv 0), where σ√T₁ = `sigmaPct()/100` of the nearest expiry.
  - Each chip uses the heatmap's diverging step (`divStep(v, m_heat)`, the same `m` as the heatmap, §4.7), so the chips and the grid agree.
  - Chip: 26 px tall, radius 999, 11.5px 600 tabular. Label `−1σ` in `--a-label`, value in the step ink.
  - Click → the scenario sliders jump to that σ (exists as chips; this makes them visible from the book).
  - Title: `NIFTY at 26 024 (−2.0%) now: −₹6.9K unrealised`.

### 4.4 P&L by leg (inline diverging bars)
- **Table cell** (desktop and tablet): the P&L column becomes `value + 64 px bar`. The bar is centred at 0, scaled by `M_pnl = max_i |U_i|` over the open legs of **the whole book** (not per group, so bars compare across groups). Fill is `--pos` or `--neg`, 6 px tall, radius 2 at the far end only. The value text sits left of the bar, right-aligned.
- **Realised** for a leg (R_i ≠ 0) shows as a second hatched 3 px bar under the first, at the same scale, with the title `Realised −₹1 492 today`.
- **Group header**: the group P&L shows the same bar at 48 px, scaled by `max |group P&L|`.
- **Phone card**: a 56×4 bar under the right-aligned P&L, same scale.
- The **Δ column** gets a 40 px diverging bar scaled by `max_i |q_i·δ_i|` in fg at `--a-label` (the per-unit δ sub-line stays).
- **Sort cue**: the leg with the largest |U_i| in each group gets its P&L value in 650 weight. No reordering (PRD 04 keeps strike order).

### 4.5 Contract cell
- `[B|S]` tag 20×20, radius 5: B = `--pos-ink` on a `--pos` tint, S = `--neg-ink` on a `--neg` tint.
- The strike is 600 13.5px. The right `CE`/`PE` is 600 11.5px in `--dv-call-ink`/`--dv-put-ink`, so "26600 **CE**" carries the side colour. Futures `FUT` are in fg at `--a-label`.
- Sub-line `3 Nov · Carry` at 11.5px `--a-quiet`.
- Include checkbox: the foundation contrast checkbox (§3.3), 18 px, with a 44 px label hit area on coarse pointers.

### 4.6 Distance-to-strike σ gauge
- Track 48×4 px (36 on tablet/phone), `--mat-fill-2`, representing 0…3σ. Ticks at 1σ and 2σ in `fg/0.25`. The marker is a 6 px circle at `x = min(d,3)/3`, where `d = |K − F_e|/σ_e` (PRD 04 §5.3).
- Colour of the marker:
  - short and ITM on the forward → `--neg`, with the text "ITM" in `--neg-ink`;
  - short and d < 0.5 → `--warn`, with the text `0.3σ` in `--warn-ink`;
  - long, or short with d ≥ 0.5 → `fg/0.55`.
- Text `1.3σ ↓` (the arrow shows whether the strike is above or below the forward) stays to the right of the gauge.

### 4.7 Scenario heatmap
- **Cells**: `heatCell(td, divStep(v, m), "div")`, where `m` = the 95th percentile of |cell| across the visible grid and the stress chips. The 7 `--div-*` steps give the background and `--div-ink-*` the text. Text is 12px 600 tabular, compact ₹ (`−₹74.5K`).
- **Row heads**: `−5%` 600 12px plus the price at 11px `--a-quiet` on **one line** (`white-space: nowrap`). The **spot row (0 %)** gets a 2 px `--sel-bg` leading bar and 650 weight.
- **Current cell** (nearest the sliders): an **inset 2 px `--sel-bg` ring** (replacing the blue outline), `aria-current="true"`. The ring is one absolutely positioned overlay that slides between cells (§5).
- **Loss limit** (`cfg.lossLimit`): cells worse than −limit get the `--neg` hatch overlay at 0.35 plus `aria-description` (exists). The legend shows `▨ beyond −₹50K limit`.
- **Columns**:
  - Spot × IV: `IV −10 · −5 · now · +5 · +10` on desktop (5 columns); `−5 · now · +5` on tablet and phone.
  - Spot × Days: `Today · +1 · +2 · +3 · Exp (+5)` on desktop; `Today · +3 · Exp` on phone. Days beyond first expiry are clamped.
  - This needs `scenarioGrid({ cols })` in options.js (§7.6).
- **Legend** (under the table): a 7-swatch strip, 14×8 each, from `−₹{m}` to `+₹{m}` (compact), with the label "Unrealised P&L vs now". Ends are labelled; the 0 tick is in the centre.
- Row height 28 px (fine pointer) / 36 (coarse). Columns are equal width. The table never scrolls sideways at 390 (3 columns).
- **Footer** (3 rows, as today) gains values for multi-expiry books from the sampled first-expiry curve (§7.1): `Max profit at 3 Nov ≈ +₹7.9K at 26 600`, `Max loss at 3 Nov ≈ −₹60.2K below 25 700 (sampled)`. "Unlimited ↗/↘" shows when the slope at the range edge is non-zero (§7.1).

### 4.8 Payoff of the book (same anatomy as the Strategy Builder)
Reuse `payoff.js` `drawPayoff` (strategy.md §4.1) and retire `createBookPayoff`, if payoff.js accepts the book model below. If not, port the same layers into `createBookPayoff`. Either way the two charts must look identical.

| # | Layer | Encodes | Style |
|---|---|---|---|
| 1 | ±2σ, ±1σ bands | `F₁·e^{±kσ√T₁}` of the nearest expiry (exists: `b1`, `b2`) | full-height fills `--dv-band` at 0.5 / 1.0. **No dashed outline.** Labels `−1σ 26 024` at the bottom inside the band edges, 10px `--a-quiet` |
| 2 | Grid, zero | y ticks | `--dv-grid`; zero line `fg/0.35` |
| 3 | Profit / loss areas | the **expiry** curve | vertical gradients (strategy.md §4.1 rows 6–7): `--pos` 0.34→0.04 / `--neg` 0.30→0.04 in dark; 0.24→0.03 / 0.20→0.03 in light |
| 4 | Expiry curve "At 3 Nov expiry" | legs of T₁ at intrinsic, later legs Black-76 (exists: `exp`) | 2.25 px, **split by sign** (`--pos` above zero, `--neg` below) via the two clips that exist |
| 5 | Target curve | `scenarioPnl` at slider days and IV (exists) | `--dv-today` at 0.6, 1.5 px, dash 4 3; only when days > 0 or dIv ≠ 0 |
| 6 | Now curve (T+0) | `scenarioPnl` at now (exists) | `--dv-today` 2 px solid |
| 7 | After hedge | now with the hedge legs (exists) | `--dv-iv` 1.5 px, dash 1 3, round caps |
| 8 | Strike markers | each included OPT leg | on the x baseline, 7 px triangle, `--dv-call`/`--dv-put`; filled = long, 1.5 px outline = short; stacked 8 px when strikes coincide. FUT: a 6 px fg/0.55 square at the avg price. Title `Short 1 × 26 600 CE @ 86.50` |
| 9 | Spot | spot now | 1 px `--dv-spot` at 0.55; **contrast pill** at the top, `spotPill(svg, x, "26 555")` |
| 10 | You-are-here dot | `now(spot)` = unrealised P&L now | 6 px `--dv-today` dot with a 2 px `--card` ring at (spot, now(spot)). On each live tick it **eases** to the new position (§5) |
| 11 | Breakevens | roots of the **Now** curve (exists: `bes`) | 7 px ring on the zero line. Pills **below the x-axis**: `BE 26 141 (−1.6%)`, merged on collision with `placeLabels`. Never on the curve |
| 12 | Max/min guides | max and min of the expiry curve within the range | dashed 1 px `--pos`/`--neg` at 0.5, with right-edge pills `Max +₹7.9K` / `Min −₹60.2K` |
| 13 | Y clamp | when `|yMin| > 4·|yMax|` or the reverse | clamp the dominant side to 4×, and draw an arrow cap `▼ −₹60K at 25 700` at the clipped edge. Tooltip values are not clamped. This fixes the flattened hump |
| 14 | Crosshair and tooltip | pointer price | the strategy.md §4.3 tooltip card: `26 157 −1.5% · −0.6σ` / `Now −₹6.9K` / `Target …` / `At 3 Nov −₹2.1K` / `Hedged …` / `P(close below) 31%`. Pin on click or tap, Esc unpins. Coarse pointer: the card docks at the top |

- Chart head: a `legend()` row: `━ Now · ┅ Target (+3d) · ━ At 3 Nov expiry (green/red swatch pair) · ▒ ±1σ ▒ ±2σ · ┄ After hedge`. On the right, `Curves [Now | +Exp | +Target]` (contrast segmented; default "Now + Exp"), persisted as `cfg.curves`.
- The head no longer prints "At 26555: now −₹45". The tooltip owns the readout. When idle, the head shows `Unrealised now −₹45 at 26 555`, so that the hero −₹1 541 (which includes realised) cannot be mistaken for it.
- **Margins** L 56, R 12, T 26 (spot pill), B 56 (ticks, strike markers, BE row). X ticks `niceTicks` with 5–8 ticks by width (today there are 2–3).
- **Heights**: desktop 360, tablet 300, phone 240. No `fill()` stretching.
- **`aria-label`** as today, plus `max loss in range` and `POP`.

### 4.9 Greeks across spot (P1, Scenario column tab "Greeks")
- A table with the heatmap's spot ladder as rows and `Δ (lots) · Γ/1% · Θ ₹/d · ν ₹/pt` as columns, at the slider days and IV, from `O.scenarioGreeks(inc, {dS, dIv, days})`.
- Each cell has a 40 px diverging micro-bar per column (colours as in §4.2). The spot row has the `--sel-bg` leading bar.
- On desktop, when the payoff column has spare height (the scenario column is taller than 360 + 24), a compact 64 px **Δ-across-spot strip** under the payoff draws Δ(x) at T+0 over the same x-range. It is a 1.5 px fg line, with the ±B band in `--dv-band` and a dot at spot. It shows where the book goes outside its delta band.

### 4.10 Group payoff glyph
A 40×16 SVG in each group header (desktop, tablet and phone): the group's expiry curve over `F ± 2.6σ`, 1.25 px, split by sign, with no axes and a 1 px fg/0.35 zero line. Same sampler as §4.8, 41 points. Title `Iron condor · max +₹2.1K · min −₹11.9K`. It gives each structure a recognisable shape (OptionStrat does this in its strategy list).

---

## 5. Motion (foundation §6 primitives only)

| What moves | How | Duration / easing | Reduced motion |
|---|---|---|---|
| Page open / underlying or account change | `pageEnter` on book, positions, risk (stagger 40 ms) | `--dur-3` `--ease-out` | none |
| Hero P&L, Δ, Θ, ν values, first paint | `countUp` through `formatSignedRupee`/`formatSigned` (pass `finalText`) | `--dur-4` | final text at once |
| The same values on a live tick | `flashValue(el, dir)` when the displayed text changes (dir = sign of the change in P&L; for Δ by sign of the Δ change). Max once per element per tick | `--dur-flash` | 2 px leading-edge marker for 3 s |
| Composition bar, gauges, margin bar, leg P&L bars, Δ bars | `.dv-bar` with `transform: scaleX(var(--v))`. On first draw `barsEnter(root)` grows them from 0 (stagger 12 ms, cap 240 ms); on a tick they **resize from the old value** | grow `--dur-3` `--ease-out`; resize `--dur-3` `--ease-std` | final size at once |
| Margin bar crossing 70 % / 90 % | segment colour transition | `--dur-2` | instant |
| σ gauge marker | `transform: translateX()` transition | `--dur-3` `--ease-std` | instant |
| Payoff first draw | `lineReveal` on the expiry and now curves; areas fade in after 120 ms; strike markers pop `scale .6→1`, stagger 30 ms | 600 / 320 ms | fade 120 ms only |
| Payoff when legs change (include toggled, leg added or closed, hedge overlay toggled) | morph: resample the old curves onto the new xs and tween the y values in one rAF loop (strategy.md §4.5 `tween`; share the function); BE and max/min pills tween x | 360 ms `--ease-out` | instant |
| Payoff on a live tick | paths patch in place; the **you-are-here dot** eases from the old (spot, P&L) to the new one | dot 320 ms `--ease-std` | jump |
| Slider drag | direct rAF redraw, no tween (exists) | — | — |
| Heatmap cell values on a tick or slider change | `background-color` transition only | `--dur-2` | instant |
| Heatmap axis or ladder switch | rebuild, then the rows fade in with a 15 ms stagger (cap 160 ms) | `--dur-2` | instant |
| Current-cell ring | one overlay element; `transform: translate()` to the new cell | `--dur-2` `--ease-std` | jump |
| Stress chips, warnings appearing | opacity 0→1 and translateY 4→0 | 180 ms | instant |
| Risk tab switch (tablet/phone) | cross-fade 160 ms; the segmented thumb slides (foundation) | `--dur-2` | instant |
| Group collapse (phone) | height via `grid-template-rows: 0fr→1fr` | `--dur-3` `--ease-std` | instant |
| Leg closed (disappears) | the row fades out and its height collapses | 200 ms `--ease-in` | removed at once |
| Leg opened (new row) | 1 s `--mat-fill-2` background pulse | `--dur-flash` | none |

Performance: only `transform`, `opacity` and `background-color` animate. The 3 s tick patches ≤ 200 elements. Payoff sampling stays at 141 points plus strikes. The morph frame must take ≤ 4 ms with 20 legs.

---

## 6. Typography and spacing
- Hero value 650 22px `--font-display`. Gauge values 650 15px tabular. Labels 600 11px uppercase 0.06em at `--a-quiet` (the hero and gauge labels only; other labels are sentence case 12px 600 at `--a-label`).
- Table 13.5px, sub-lines 11.5px, heatmap 12px, axis 10.5px, pills 10.5px 650.
- Book cell padding 12. The gauge rows are 30 px apart on desktop and 44 px tall per cell on coarse pointers.
- Numbers right-aligned and tabular. Every change carries a sign; colour is never the only carrier.

---

## 7. Feature gaps: prioritised, with exact behaviour and formulas
Pure maths goes in `options.js` with tests in `options.test.mjs`. UI goes in `positions.js`.

### 7.1 `bookCurveStats(f, xs, { slopeEps })` (P0)
- Input: a sampled curve function (the expiry curve `fExp`) and xs over `[F₁·e^{−4σ√T₁}, F₁·e^{+4σ√T₁}]`, with 241 points plus strikes.
- Output `{ max, maxAt, min, minAt, unlimitedUp, unlimitedDown, roots, profitIntervals, approx: true }`.
- `unlimitedUp` is true when the slope over the last 5 % of xs exceeds 0.5 % of `|max − min|` per point. Down is the mirror.
- Used for the heatmap footer (§4.7), the payoff max/min guides (§4.8) and POP.
- Tests: an iron condor's max and min match `strategyStats` within ₹1; a short call is unlimited down on the right side; a calendar gives finite sampled values.

### 7.2 Book POP at the first expiry (P0)
- `pop = Σ over profitIntervals [a,b] of N(z(b)) − N(z(a))`, where `z(x) = (ln(x/F₁) + σ²T₁/2)/(σ√T₁)`, σ = ATM IV₁/100 and T₁ = years to the first included expiry. Open-ended intervals use ±∞.
- Shown as `POP ≈ 41% at 3 Nov` (greeks cell footer) and in the payoff `aria-label`. `--` when the curve has no roots and no profit, or when σ is unknown.
- Title: "Probability that the book is in profit at the first expiry, lognormal at the ATM IV. Later-expiry legs are valued by the model."
- Test: a long ATM call's POP < 50 %; a short strangle's POP > 50 %; the probabilities sum to 1 over the complement intervals.

### 7.3 Net if closed now (after exit charges) (P0)
- `exitLegs = open.map(l => ({ kind:l.kind, right:l.right, strike:l.strike, side: l.q>0 ? "SELL" : "BUY", price: l.mark, units: |l.q| }))`
- `closeCharges = O.charges(exitLegs).total`
- `netIfClosed = U + R − closeCharges − (positions' broker charges already booked, if present: Σ charges_i)`
- Shown in the hero. The title gives the breakdown (brokerage, STT, exchange, SEBI, stamp, GST) as in strategy.md §5.3. "Charges are estimates; check your broker's contract note."
- Test: a short leg's exit is a BUY (no STT on a buy in options); totals are non-negative.

### 7.4 This book's margin estimate (P0, labelled ≈)
- For each expiry group: `m_g = O.marginEstimate(groupLegsAsStrategy, 1, { forward: F_g, years: T_g, expiryToday })`, where the legs map to `{ side, right, strike, kind, lots: |q|, price: avg }` with lotSize 1.
- `m_b = Σ m_g`. This ignores cross-expiry hedge benefit, so it is an over-estimate. The title says so. Clamp: `m_b ≤ usedMargin`. If the estimate exceeds it, show `≈ this book ≥ ₹x` only in the title and draw segment 1 = used.
- Missing F or T → no hatch segment.

### 7.5 Greek gauges with a delta band (P0)
- §4.2 scales.
- New config key `deltaBand: number|null` (null = one futures lot). `positionsConfig` validates it as finite and > 0, else null. Unit test the config.
- The warn when |Δ| > B joins `bookWarnings` as `id: "band"`, text `Δ +312 outside ±75 band`, level `warn`.

### 7.6 Heatmap upgrade (P0)
- `scenarioGrid(legs, { …, cols })` accepts an explicit column list: `ivCols` (default `[-5,0,5]`; desktop passes `[-10,-5,0,5,10]`) and `dayCols` (default `[0,1,3,fd]`; desktop `[0,1,2,3,fd]`, deduped and clamped to ≤ fd).
- Return `m95 = percentile95(|cells|)` for the colour scale.
- Tests: the shape per column list; dedup when fd ≤ 3; `m95` ignores a single outlier.

### 7.7 Stress chips (P0)
§4.3. `O.stressPnl(inc, sigmaFrac, ks = [-2,-1,1,2])` → `[{k, pct, price, v}]`. Tested against `scenarioPnl` directly.

### 7.8 P&L by leg bars + composition bar (P0, UI only)
§4.1 and §4.4, with `O.pnlComposition(legs)` → `{ won, lost, realised }` (pure, tested: sums to `bookPnl().total`).

### 7.9 Payoff anatomy parity with the Strategy Builder (P0)
§4.8: σ bands without an outline, sign-split expiry curve with gradients, strike markers, spot contrast pill, BE pills under the axis, max/min guides, y clamp, tooltip card, you-are-here dot, fixed heights.

### 7.10 Greeks across spot (P1)
§4.9. Uses the existing `scenarioGreeks`, with no new maths.

### 7.11 Group payoff glyph (P1)
§4.10. Reuses the expiry sampler on the group's legs.

### 7.12 Roll / adjust shortcuts (P2; PRD 04 lists them as LATER, this spec makes them concrete for the next round)
In the leg `⋯` menu:
- **Roll to next expiry**: a pre-filled builder basket that closes this leg and opens the same strike on the next listed expiry at the same quantity. It opens in `#/strategy` with both legs; nothing is sent from Positions.
- **Roll strike ±1 step**: same, with the strike moved one listed step away from spot for a short, or toward spot for a long.
- **Add wing**: buy the strike `n` steps further OTM (n = 2 by default) at the same quantity, which turns a naked short into a spread.
Each shows the before → after Δ/Θ and max loss as a preview line, computed with `scenarioPnl` and `bookCurveStats` on the modified leg set, before it opens the builder.

### 7.13 LATER (unchanged from PRD 04, listed for completeness)
- A broker basket margin endpoint (it would replace §7.4).
- The Day P&L time chart (it goes in the "Chart engine slot" placeholder; we draw no time series).
- Alerts on book P&L or spot.
- Beta-weighted Δ across underlyings.
- Swipe actions on phone.

---

## 8. Interactions (additions to PRD 04 §8)
- **Hover or tap a leg row** → its strike marker on the payoff gets a 2 px `--sel-bg` ring and its contribution bar is outlined. **Hover a strike marker** → the row gets the `--mat-fill-2` highlight. This is a two-way link.
- **Composition bar segment** → highlights the contributing rows (§4.1).
- **Gauge click** → the Greeks tab (§4.2). **Stress chip click** → sets the spot slider (§4.3).
- **Heatmap cell click or Enter** → sets the sliders (exists) and pins the payoff tooltip at that price.
- **Payoff click** → pins the tooltip; **Esc** unpins; **←/→** step by `(hi−lo)/70`, Shift ×10 (exists).
- **Keys** (added to `POSITION_KEYS`; the hint row is now shown only by `?`):
  - `g` cycles the risk tab (Payoff → Scenario → Greeks);
  - `c` cycles Curves;
  - `b` focuses the Δ gauge (and announces Δ and the band).
- **Customise** popover gains: Delta band ± (number, blank = 1 futures lot), Heatmap columns (3 · 5), Curves default, Show P&L bars (on), Show σ gauge (on).

---

## 9. States
| State | Look |
|---|---|
| Loading (first) | Hero, gauges and capital show skeleton bars (`dv-shimmer`) at their final sizes. The table shows 3 skeleton rows at 44 px. The payoff shows a skeleton plot rect with a 1 px `--dv-grid` zero line. `aria-busy` on each panel |
| No account | as PRD 04 §10 (book hidden; "Choose an account that can place orders" + Accounts link) |
| Empty | compact `emptyState`: "No open NIFTY options or futures on Paper account." · "Open elsewhere: [BANKNIFTY · 1]" chips · actions `Option Chain` · `Strategy Builder`. Risk and hedge are not rendered |
| All legs excluded | gauges show `--` with the chip "all legs excluded"; the payoff shows "Include a leg to see its payoff" + an `Include all` button; the hero P&L still shows (P&L is fact) |
| Unpriced legs | gauges keep the "partial" chip; the unpriced leg's row shows `--` P&L with no bar, and a warn dot in the contract cell |
| Funds unavailable | the margin bar is an empty track with "Funds unavailable"; the hatch segment is hidden |
| Error, data kept | `err-bar` at the top of the book panel: "Couldn't refresh positions. Showing 09:18:38." Values at 0.7 opacity, bars frozen (no transition) |
| Stale | the live control turns warn (foundation); the `stale` warning chip; σ gauges and the payoff dot at 0.7 opacity |
| Paused | nothing animates except user-driven slider redraws |
| Expiry day | a warn "Expires today" pill in the group header (replacing the DTE); ELM/STT warnings as PRD 04 §7 |
| Phone, one group | the group header stays (it carries the glyph and P&L) |

Demo: **no** demo pill, banner or "demo" text anywhere on this page. The account label is "Paper account" with the single `PAPER` mode badge in the top bar (foundation §7). The positions panel title is "NIFTY positions · 5 legs" with no "paper" suffix.

---

## 10. Acceptance checks
Static checks (add to `polish.test.mjs` or `options.test.mjs`):
- No `--ios-green-ink`, `--ios-red`, `--ios-orange` or `accent-color` in the `12e` CSS section. The payoff classes use `--pos`/`--neg`/`--dv-today`/`--dv-band`/`--dv-call`/`--dv-put`.
- `positions.js` has no `style="` attribute strings and no `toFixed(`/`toLocaleString(` (format.test already enforces this).
- `positionsConfig` accepts and validates `deltaBand`, `curves` and `heatCols`.
- Unit tests §7.1–7.8 pass.

Playwright (`scratchpad/posd.cjs` extended): 3 devices × 2 themes, with the seeded book.
- `scrollWidth === innerWidth`.
- The book panel top ≤ 72 px on desktop and ≤ 120 px on phone. The book height ≤ 160 px on desktop and ≤ 230 px on phone.
- The payoff `svg` height is 360 / 300 / 240.
- The heatmap's spot-row cells have distinct background colours for at least 3 steps (read `getComputedStyle`).
- The selected segment background is rgb(255,255,255) in dark and rgb(10,10,11) in light.
- The margin bar's used segment is the warn or neg colour at 92 % utilisation.
- No element with text matching /demo/i inside `#content`.
- Every visible button ≥ 44 px tall on touch devices.
- No console errors.
- Emulate `prefers-reduced-motion: reduce` once: no running CSS animations after 50 ms (`document.getAnimations().length === 0` after load settles).
- Read every screenshot.

---

## 11. MUST-DO (ordered by value)

1. **Payoff parity with the builder.** σ bands without the dashed box. Expiry curve split by sign with gradient fills. Now curve in `--dv-today`. Spot contrast pill. Call/put strike markers (filled long, outline short). BE pills below the axis. Max/min guides. Y clamp with an arrow cap, so the profit hump is readable. Tooltip card with pin. You-are-here dot. Fixed heights 360/300/240 (remove `fill()` stretching). The idle head reads "Unrealised now ₹x at spot".
2. **Scenario heatmap on the diverging scale.** `heatCell` + `divStep(v, m95)`. One-line row heads. Spot row leading bar. A sliding `--sel-bg` current-cell ring. A 7-swatch legend. Loss-limit hatch. 5 columns on desktop (`scenarioGrid` `cols`). Sampled first-expiry max profit/loss in the footer via `bookCurveStats`, instead of `--` for multi-expiry books.
3. **Book strip rebuilt as Hero · Greeks · Capital.**
   - Net P&L hero with a won/lost/realised composition bar and the credit-kept meter (50/80 ticks).
   - Four diverging greek gauges with a delta band (`deltaBand` setting, warn outside the band) and a shared Θ/ν scale.
   - Margin/funds bar with warn at 70 % and neg at 90 %, and the "≈ this book" hatch.
   - The phone book fits in ≤ 230 px.
4. **P&L by leg bars.** Inline diverging P&L bars in table rows, group headers and phone cards, all on one book-wide scale. Hatched realised bars. Δ micro-bars.
5. **Stress chips** at −2σ/−1σ/+1σ/+2σ (`O.stressPnl`), on the same colour scale as the heatmap and clickable to set the spot slider. In the book on desktop/tablet, and in the Scenario tab on phone.
6. **Clean, contrast-correct controls.** Contrast include checkboxes. Contrast chips, segmented controls and selected slider chips. B/S tags on pos/neg tints. CE/PE text in call/put ink. `--ios-*` references replaced by role tokens. Key hint row only on `?`. Bottom padding for the floating tab bar.
7. **σ distance gauges** per leg (48/36 px), with warn under 0.5σ and neg for an ITM short.
8. **Motion.**
   - `countUp` on first paint, then `flashValue` on changes.
   - `.dv-bar` grow and resize-from-old for every bar.
   - `lineReveal` on the payoff's first draw.
   - Morph on leg/include/hedge changes (share the builder's `tween`).
   - The you-are-here dot eases on ticks. The heatmap colours transition and the current-cell ring slides.
   - Every item has a reduced-motion fallback.
9. **Book POP and Net if closed now.** `bookCurveStats` → POP at the first expiry. `O.charges` on the exit legs → "Net if closed" in the hero, with a breakdown title.
10. **Compact top bar integration** (foundation §5): Underlying │ Account │ Spot on this page, no expiry, no `.desk-top` panel, no demo text on the page. "Paper account" plus a single PAPER badge.
11. **Greeks across spot** tab (Δ, Γ/1 %, Θ, ν per spot row with micro-bars), and the Δ-across-spot strip under the payoff on desktop.
12. **Group payoff glyph** (40×16, sign-split) in every group header.
13. **Two-way hover linking** between rows and strike markers, and from composition-bar segments to rows. New keys `g`, `c`, `b`. New Customise options (delta band, heatmap columns, curves, bars, gauges).
14. **Tests and audit.** Unit tests for `bookCurveStats`, POP, `stressPnl`, `pnlComposition`, `scenarioGrid` cols, `positionsConfig` keys. The Playwright checks in §10 at 390/820/1440 × dark/light, plus reduced motion. Read every screenshot.
15. **P2: roll/adjust shortcuts** (roll to next expiry, roll strike ±1, add wing), each with a before → after preview line, handed to the builder. Nothing is sent from Positions.
