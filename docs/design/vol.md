# Design spec: Volatility, round 2 (`#/vol`)

Status: ready to build · Files: `server/bridge/dashboard/vol-curves.js` (most of the work), `vol.js` (panel layout, KPI strip, tables, wiring), `app.css` §12v (VOLATILITY), `options.js` + `options.test.mjs` (two small pure helpers, §9) · Builds on `docs/prd/05-volatility.md` (round 1). Every PRD 05 behaviour stays unless this spec changes it. Colours, selection, motion, the top bar and the single demo indicator come from `docs/design/foundation.md` (cited as **F§n**). This page must not invent colours: every colour below is a foundation token.

Reference bar: Sahi Terminal for calm and cleanliness; Opstra / Sensibull IV charts, tastytrade and thinkorswim for depth. The page should read as one black, precise instrument: **the smile is the hero, the term curve is its companion, numbers sit next to the curve that explains them.**

Evidence (dark and light; phone 390×844, tablet 820×1180, desktop 1440×900, plus desktop close-ups with hover, with every series on, and the tables):
`/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/shots2/vol/` (driver: `scratchpad/volr2.cjs`). None of the 6 page shots scrolls sideways; no page errors.

---

## 1. What is wrong today (specific, from the screenshots and code)

### 1.1 Colour (the owner's complaint: "in volatility, the colours are missing")
1. **Everything is one blue.** In `app.css` §12v the OTM line, CE line, PE line, every dot, the ±1σ band, the selected term ring, the "25Δ P / C" toggle and the ATM chip are all `--ios-blue`. CE and PE differ only by dash pattern, at 0.55 alpha. Nothing on the page uses the call/put colours, the IV violet, or a heat scale.
2. **CE and PE disappear.** With "Series" all on (`curves-all-dark.png`), CE and PE sit exactly under the OTM line (demo parity holds), so the user sees one line and three stacked end labels "OTM / CE / PE" in the same blue. There is no way to tell that the curves agree rather than are missing.
3. **The ±1σ band is a muddy slab.** `hsl(--ios-blue / 0.07)` on the warm charcoal renders navy-grey and covers the middle 40 % of the plot full height; on light it is a pale blue sheet. It dominates the curve it should frame.
4. **The term 25Δ wing lines are grey dotted** (`--a-label`) and labelled "25Δ P / 25Δ C" in grey: the put wing and call wing cannot be told apart without reading the gutter.
5. **Selected states are not the contrast rule.** The "25Δ P / C" toggle on is a blue tint (`curves-all-dark.png`); the selected expiry bar in the table is blue; the ATM strike chip is blue outline; the strike row highlight is pale blue (`strikes-light.png`).
6. **Tables are colourless grids of numbers.** The term table (ATM IV 13.5 / 12.5 / 12.2 / 12.1 %) and the strikes table (OTM IV, vs ATM) carry no heat, so the shape of the smile and the term structure cannot be read from the tables at a glance. The "Flag" column is empty and wastes 80 px.
7. **KPI tiles are flat text.** "25Δ RR +0.8 pts · Puts richer" does not use the put colour; "IV − HV −10.5" (IV well under realised: a key signal) is a grey sub-line; the 1σ range is text, not a picture.

### 1.2 Markers and axes
8. **No spot or ATM marker in the contrast language.** F is a grey hairline with a tiny 10 px "F 26519" at the bottom; spot is shown only when |F − S| ≥ half a step, as an unlabelled dotted line ("Spot" label at 10 px, `--a-quiet`). There is no ATM pill. 
9. **The x-axis is sparse.** Strike axis: 3 ticks (26000, 26500, 27000) across 640 px; no 25Δ / 10Δ positions on the strike or moneyness axes, though the table has them.
10. **No y-axis title** and no unit hint; IV ticks "18% 16% 14%" are fine but the plot has no top padding, so the left wing's first point touches the top edge.
11. **Term axis**: x labels are dates only; DTE (the √ scale reason) is not shown. The single "M" tag is 9 px grey.
12. **The ±1σ label "±1σ"** sits in the top-right corner of the band, 10 px, and collides with the end labels when the band reaches the right edge.

### 1.3 Hover, readouts, interaction
13. **The readout is far from the pointer.** It is a text line above the plot ("26150 · Mny −1.3% · OTM 14.8% · CE 14.8 · PE 14.8 · |Δ| 0.22"); on phone it is clipped with an ellipsis. The hover itself is a small dark ring and a dashed line (`curves-hover-light.png`); there is no tooltip, no crosshair value on the y-axis, no compare-curve value at the same x.
14. **Touch has no scrub.** `pointermove` is mouse-only; a phone user can only tap a point (no drag along the curve).
15. **Term structure has no hover readout**, only an SVG `<title>`; the readout line above it repeats the KPI tiles.
16. **No bid/ask IV visual.** `smilePoints` already returns `bidIv`/`askIv` per leg, but the smile never shows the spread, so a user cannot see where IV is reliable.

### 1.4 Motion
17. **Nothing moves.** Every change rebuilds the `<svg>` (`smileHost.replaceChildren(smileSvg(...))`): switching Strike → Mny % → Delta, changing the range, toggling a series or selecting an expiry snaps. PRD 05 §7.3 said "No animation"; the owner now asks for animation.

### 1.5 Layout and chrome
18. **Phone first screen shows no curve.** Toolbar (70 px) + desk bar (2 rows, ≈ 120 px) + KPI 2×4 grid (≈ 330 px) + Smile/Term capsule + "Smile 3 Nov" title + Strike/Mny/Delta capsule + 3 selects: the plot starts at y ≈ 770, under the tab bar (`phone-light.png`). Two full-width capsule bars are stacked.
19. **"Compare: none" is clipped** on phone ("Compare: none" → "Compare: non"); the readout ellipsis loses the |Δ|.
20. **Tablet**: the panel has an empty 44 px header row (only the drag and maximise icons) above "Smile", and the term chart is a 770 × 280 plot with 4 points: mostly empty.
21. **Desktop**: smile and term heights are equal (280) but the term head carries a lone toggle; the grid `3fr 2fr` leaves the term chart's right gutter empty when wings are off.
22. **Top bar and demo**: the desk bar repeats "as of …" and "Live"; the toolbar says "Demo data". Both are fixed by the foundation (F§5, F§7); this page must not add its own markers (it does not today; keep it that way).

---

## 2. Target information architecture

Panels (`data-panel`), default order. New items **bold**.

| # | Panel | Content |
|---|---|---|
| 1 | `vol-kpi` | 8 tiles, restyled with micro-visuals (§5) |
| 2 | `vol-curves` | Smile (hero) + term structure, one shared legend row each, tooltips, **±1σ/±2σ bands, ATM/F/spot pills, 25Δ/10Δ ticks, bid/ask IV ribbon, OI strip** (§4) |
| 3 | **`vol-surface`** | **IV heat grid: expiries × moneyness/delta buckets** (§6) |
| 4 | `vol-term` | Per-expiry table with **heat cells** and a **term sparkline column** (§7.1) |
| 5 | `vol-strikes` | Strikes table with **heat cells, signed vs-ATM micro bars, bid/ask IV range bar** (§7.2) |
| 6 | `vol-read` | Read + arbitrage checks (unchanged content, colour-coded persona heads §7.3) |
| 7 | `vol-history` | Chart engine slot (unchanged: "ATM IV and HV20 over time · Chart engine slot") |
| 8 | `vol-method` | Methodology (unchanged) |

Phone default order: kpi, curves, surface, term, read, strikes, history, method.

---

## 3. Layout per device

Spacing from F§8: 4 px grid, panel padding 12, panel gap 12, panel radius 16. Top bar is the foundation's compact bar (F§5): this page adds nothing to it. No horizontal page scroll at any width; tables scroll only inside `.table-wrap`.

### 3.1 Desktop ≥ 1280 (content ≈ 1170 px)
- KPI strip: one row of 8 tiles, 64 px tall (value 650 17 px, label 11.5 px `--a-quiet`, sub 11.5 px `--a-label`; micro-visual 4 px tall under the value, §5).
- `vol-curves`: grid `minmax(0, 3fr) minmax(0, 2fr)`, 1 px `--mat-separator` divider between halves, no inner padding change.
  - **One head row per half, 32 px**: title (650 15 px) + sub (12 px `--a-label`: "3 Nov · 5d · 41 strikes") on the left; controls right-aligned.
  - Smile controls: `[Strike | Mny % | Δ]` capsule · `Series ▾` · `ATM ±20 ▾` · `Compare ▾`. The compare select's closed label is "Compare" when none, and "vs 10 Nov" when set (never "Compare: none").
  - **Legend row under the head, 20 px** (F§4.5): swatches for each drawn series + band + markers (§4.1). Legend items toggle series (replaces the readout line, which is removed; the readout moves into the tooltip).
  - Smile plot height **320** (was 280); term plot height 320 (same baseline as the smile so the y-axes read across).
  - Term controls: `25Δ wings` toggle chip, `HV20` toggle chip (both F§3.3 chip rule: off = outline, on = `--sel-bg`/`--sel-fg` with a check glyph).
- `vol-surface`: full width, heat grid (§6) 6 rows × 11 columns, cell 32 px tall.
- `vol-term`, `vol-strikes`, `vol-read`: as PRD 05 §4.1, with §7 visuals.

### 3.2 Desktop 1024–1279 and tablet landscape
- Same as desktop; KPI auto-fits 4×2; curves stay side by side down to 1100 px, stacked below.

### 3.3 Tablet portrait 820×1180 (content ≈ 770 px)
- **Remove the empty panel header row** on `vol-curves`: the drag grip and maximise buttons sit inside the smile head row, right end (they do today on desktop). Same for `vol-kpi`: the KPI panel has no head; its grip appears on hover/focus only at the panel's top-right corner, overlaying nothing (position absolute, 28 px).
- KPI: 4×2, 60 px tiles.
- `vol-curves`: stacked. Smile 770 × 300; term **770 × 200** (4–8 points do not need 280 px).
- Smile controls wrap at most to a second row; legend row always one line (it scrolls sideways inside itself with an edge fade if needed).
- `vol-surface`: full width, columns 9 (10ΔP … 10ΔC + ATM, drop 5Δ buckets).

### 3.4 Phone 390×844 (content 358 px)
Goal: **the top of the smile is visible on the first screen** (PRD 05 success 1, currently failed).
- Top bar: foundation phone bar (52 px + safe area, F§5.2).
- **KPI: one horizontally scrolling row** (F§5.3: scroll-snap, 132 × 56 px tiles, 16 px edge fade), order: ATM IV, 1σ move, IV − HV (HV20 tile), 25Δ RR, Straddle, 25Δ fly, Forward, IV rank. This replaces the 2×4 grid (saves ≈ 270 px).
- `vol-curves` head: **one row**: `[Smile | Term | Surface]` capsule (44 px, full width minus the 44 px `⋯` button). The `⋯` button opens a `sheetPopover` "Chart options" with: x-axis capsule (Strike / Mny % / Δ), Series checkboxes, Range capsule (±10 / ±20 / All), Compare capsule (None / Next / Monthly), 25Δ wings and HV20 switches. Only one capsule bar is ever visible in the head.
- Under the head: sub line "3 Nov · 5d · ATM 13.5 %" (12 px) and the legend row (one line, scrolls sideways).
- Plot: 358 × 220 (smile), 358 × 200 (term). Plot starts at y ≈ 300 on a 844 screen.
- Tooltip on phone is a **fixed readout card docked under the plot** (56 px, two lines, no layout jump), not a floating box, because a finger hides a floating box.
- Surface tab: the heat grid at 358 px with 5 columns `10ΔP 25ΔP ATM 25ΔC 10ΔC`, cell 40 px tall, rows = expiries.
- Tab bar overlap: every panel has `scroll-margin-bottom` and the page has bottom padding = tab bar height + 16 px, so the last panel is never under the tab bar.

---

## 4. The curves (`vol-curves.js`)

### 4.0 Architecture change (needed for animation)
Replace "rebuild `<svg>` on change" with persistent charts:
- `smileChart(host, opts) → { update(data, opts), mark(strike), destroy() }`
- `termChart(host, opts) → { update(rows, opts), destroy() }`
- Static layers (defs, grid group, band, markers, series paths, dots, overlay) are created once; `update` patches attributes. `vol.js` keeps its signature memo (`smileSig`/`termSig`) and calls `update` only when the signature changes; width/height changes rebuild the scales but keep the nodes.
- Keep `smileSvg`/`termSvg` as thin wrappers (`create + update` once) so existing tests keep working.
- Use the foundation's `viz.js` helpers when present (`legend`, `spotPill`, `scrubber`, `svgEl`). If `viz.js` has not landed, implement the same signatures privately in `vol-curves.js` and switch later; do not fork the look.

### 4.1 Smile: what each mark encodes and its colour

| Layer (bottom → top) | Encodes | Look (light / dark via tokens) |
|---|---|---|
| Plot background | — | transparent (card) |
| ±2σ band | F·e^(±2σ√T) | `--dv-band` at 50 % alpha, x-range only, plot-height, no outline |
| ±1σ band | `lo`–`hi` from `termRow` | `--dv-band`, plus 1 px vertical edges at `hsl(var(--dv-iv) / 0.35)`. Label "±1σ 26092–26953" in a 10.5 px `--dv-axis` text at the band's **top-left inside**, so it never meets the right gutter |
| Gridlines | IV ticks | horizontal only, `--dv-grid` (F§4.5) |
| **Area under OTM composite** | IV level | vertical linear gradient `<linearGradient id="vol-iv-fill">`: `--dv-iv` at 0.22 at the curve's min-y to 0 at the plot bottom. Gives the "gradient where useful" and makes the smile read as a shape |
| **Bid/ask IV ribbon** (Series item "Bid/ask band", off by default; on automatically when "Bid/ask IV" is on in the strikes panel) | `[otmLeg.bidIv, otmLeg.askIv]` per strike | area between the two, `hsl(var(--dv-iv) / 0.14)`; gaps where either side is null. Shows where IV is tradable |
| Compare curve | OTM composite of the compare expiry | `--dv-hv` (fg 0.55, dashed 4 3), 1.5 px |
| CE IV line | `p.ce.iv` | `--dv-call`, 1.5 px, dashed 6 4 |
| PE IV line | `p.pe.iv` | `--dv-put`, 1.5 px, dotted 1.5 3.5 |
| **OTM composite line** | `p.otm.iv` | `--dv-iv`, 2 px, round joins, `vector-effect: non-scaling-stroke` |
| Dots on OTM | data points | r 2.5 (3.5 coarse). **Fill by source side**: put-priced points (left of F) `--dv-put`, call-priced (right of F) `--dv-call`. `q !== "mid"` → hollow: card fill, 1.5 px side-colour stroke. Out points not drawn. (So the one violet curve shows where puts vs calls price it, without a second line) |
| Dots on CE / PE lines | only when that series is on | r 2, side colour |
| **25Δ / 10Δ ticks** | strikes at `ivAtDelta` 0.10/0.25 put and call | 6 px ticks hanging from the x-axis in the side colour, with 10 px 650 labels "25ΔP", "10ΔC" in the side ink; drawn on Strike and Mny axes (Delta axis already has them as ticks) |
| **F line + ATM pill** | forward / ATM strike | 1 px `--dv-spot` full height; at the top a contrast pill (`--sel-bg`/`--sel-fg`, 11 px 650, radius 999, padding 2 6): "ATM 26500 · 13.5%". Bottom label "F 26518.7" 10.5 px `--dv-axis` |
| **Spot line + pill** | spot | 1 px `--dv-spot` dashed 2 3 at 0.6; pill on `--surface-raised` with fg text: "Spot 26493.8" (only when |F − S| ≥ half a step; else the ATM pill reads "ATM 26500 · F≈S") |
| Highlight | hovered/keyboard strike | crosshair 1 px `fg / 0.35` vertical **and** horizontal; ring r+3, 1.5 px `--dv-spot`; y-axis value chip at the left edge (contrast pill, "14.8%") |
| **OI strip** (Series item "OI", off by default, LATER L8 promoted) | CE/PE open interest per strike | a 28 px strip below the x-axis: call OI bars up from a midline in `--dv-call` at 0.85, put OI bars down in `--dv-put` at 0.85, scaled to max OI in range; max strike at full opacity, others 0.6 (F§4.6) |

Pill collision: if the ATM pill and the spot pill overlap horizontally, the spot pill drops one row (top + 20 px). Pills are clamped inside the plot.

When CE and PE lines are on and their IV equals the OTM composite within 0.1 pt at every drawn strike, the legend shows a quiet note after CE/PE: "CE ≈ PE (parity holds)". This explains the overlap instead of looking broken (§1.1 #2).

Direct end labels stay (gutter, `gutterLabels`), coloured in each series' **ink** token: OTM `--dv-iv-ink`, CE `--dv-call-ink`, PE `--dv-put-ink`, compare `--a-label`. When labels would stack within 11 px of each other they collapse into one label "OTM · CE · PE" in fg.

### 4.2 Smile: scales and axes
- y: IV %, `niceTicks` 4–6 ticks, padding = max(1 vol pt, 8 % of span) above and below (fixes the first point touching the top). Tick labels 10.5 px tabular `--dv-axis`, left. Axis title "IV %" 10.5 px at the top-left above the first tick.
- x Strike: `niceTicks` with count `floor(plotW / 70)` clamped 4–9 (desktop 640 px → 8 ticks). Mny %: same, signed labels "−2%", "0%", "+2%" (U+2212 minus). Delta: 10ΔP 25ΔP 50Δ 25ΔC 10ΔC (unchanged); the 50Δ tick is the ATM pill position.
- Zero/ATM vertical: the F line already marks it; no extra zero line.
- Plot margins: L 40, R 14 (44 with labels), T 26 (room for the pills), B 24 (+ 30 with OI strip).

### 4.3 Term structure

| Layer | Encodes | Look |
|---|---|---|
| Area under ATM line | level | same violet gradient as the smile |
| **HV20 reference** (chip "HV20", on by default when HV20 is known) | realised vol | horizontal 1.5 px `--dv-hv` dashed 4 3 across the plot, right label "HV20 24.0%" in `--a-label`. The gap between the curve and this line is the variance risk premium, visible at a glance |
| 25Δ put wing | `skew.put25.iv` per expiry | `--dv-put`, 1.5 px dotted, dots r 2.5 side colour |
| 25Δ call wing | `skew.call25.iv` | `--dv-call`, 1.5 px dotted |
| ATM IV line | `atmIv` | `--dv-iv`, 2 px, dots r 3.5 (4.5 coarse) filled `--dv-iv`; `dim` rows hollow |
| **Forward-vol segments** | `forwardVol(a, b)` between consecutive expiries | label at each segment's midpoint, 10 px `--a-label` "fv 11.7"; an inverted pair (`forwardVol` null / negative variance) draws the segment in `--warn` with label "inv" |
| Selected expiry | `st.expiry` | ring r+4, 1.5 px `--dv-spot` + a contrast pill above it with "13.5%" |
| Monthly tag | `monthly` | "M" 10 px 700 `--a-label` under the date tick (not above the point, so it never meets the ring) |
| x axis | √DTE | date label "3 Nov" 10.5 px + second line "5d" 10 px `--a-quiet` |

Shape label in the head is coloured by kind: "Inverted · front richer" in `--warn-ink`; "Contango" in `--a-label`; "Flat" neutral. (Inversion is the alert state; contango is normal, so it stays quiet.)

### 4.4 Hover readouts (tooltip, F§4.5)
Smile tooltip (`--surface-raised`, radius 10, padding 8 10, 12.5 px, values tabular, max-width 220):
```
26150  ·  Mny −1.3%  ·  25ΔP           (650, fg)
OTM IV   14.8%    vs ATM +1.3          (OTM in --dv-iv-ink; vs ATM signed)
CE 14.8 · PE 14.8                      (side inks)
Bid/ask IV 14.5 – 15.1                 (only when two-sided)
|Δ| 0.22 · Prem 38.40 (PE)             (side ink for the leg)
10 Nov  13.9%  (−0.9)                  (compare row, only with compare on)
```
- `vs ATM` = `otm.iv − atmIv` in pts. Compare value = OTM IV of the compare expiry interpolated linearly in the current x unit (moneyness or delta) at the hovered x; omitted when outside its range.
- Position: right of the crosshair by 12 px, flips left when it would cross the plot's right edge; vertically centred on the point, clamped inside the plot.
- Term tooltip: "10 Nov · 12d · M" / "ATM IV 12.5%" / "25ΔP 13.3 · 25ΔC 12.7" / "Fwd vol 11.7%" / "1σ ±608 (2.29%)". Hover snaps to the nearest expiry by x.
- Pointer: mouse moves update; **touch drag scrubs** (pointerdown on the plot captures; `touch-action: pan-y` stays so vertical page scroll works; a horizontal drag of > 8 px starts the scrub). Tap pins; tap outside or Esc unpins. Keyboard on the focused SVG: ← → one strike, Shift ×10, Home/End ends, Enter pins (uses the existing `J/K` handlers in `vol.js` for the shared highlight).
- Phone: the tooltip content renders into the docked readout card (§3.4) instead of floating.
- The highlight is shared with the strikes table (existing `setHl`/`paintHighlight`); the table row highlight uses F§3.3 row selection (fill-2 + 2 px `--sel-bg` leading bar), not blue.

### 4.5 Legends (F§4.5)
- Smile legend: `— OTM IV` (violet line), `- - CE` (blue), `··· PE` (orange), `- - 10 Nov` (compare, when on), `▮ ±1σ / ±2σ` (band swatch), `● put-priced  ● call-priced` (only when dots are side-coloured, i.e. always: two small dots), `▮ Bid/ask` (when on), `▮ OI CE / PE` (when on). Items with a series toggle act as chips (off = 35 % opacity).
- Term legend: `— ATM IV`, `··· 25ΔP`, `··· 25ΔC`, `- - HV20`.

---

## 5. KPI strip (patched in place, never rebuilt)

Same 8 tiles and maths as PRD 05 §5.1; added micro-visuals (each 4 px tall, full tile width minus padding, under the value; `aria-hidden`, the tile's aria-label already says it):

| Tile | Value colour | Micro-visual |
|---|---|---|
| Forward | fg | none; sub "Spot 26493.8 · basis +24.9" with basis signed in `--a-label` |
| ATM IV | `--dv-iv-ink` | **position bar**: ATM IV placed on the term curve's min–max across loaded expiries (track `--mat-fill-2`, a 2×8 px `--dv-iv` marker). Sub "CE 13.5 · PE 13.5" with side inks |
| 1σ move | fg | **range bar**: track = the strikes in range, filled segment `lo`–`hi` in `--dv-band` with a 1 px `--dv-spot` tick at F |
| Straddle | fg | none; sub "₹25725 a lot · ÷1σ 0.80" |
| 25Δ RR (P−C) | **`--dv-put-ink` when ≥ +0.5 ("Puts richer"), `--dv-call-ink` when ≤ −0.5 ("Calls richer")**, fg when balanced | **centre-zero bar**: track ±3 pts, bar from centre to RR, toward left in put colour / right in call colour |
| 25Δ fly | fg | none |
| HV20 → retitle **"IV − HV20"** | value = `atmIv − hv20` signed, coloured with the diverging ink for its step (F§4.4, m = 10 pts) | **two-marker bar**: HV20 tick (`--dv-hv`) and ATM IV tick (`--dv-iv`) on a shared 0–(max+5) % track; the segment between is filled at 0.3 of the leading colour. Sub "HV20 24.0% · pctl 76" |
| IV rank | `--a-quiet` "Unavailable" (unchanged, honest) | none |

Count-up on first paint only, then F§6.2 flash on change (ATM IV, 1σ, straddle, RR, IV − HV).

---

## 6. New: IV surface heat grid (`vol-surface`)

What it answers: "where along strike *and* time is vol rich?" in one look (Opstra/Sensibull "IV chart" across expiries, without 3D).

- Rows: loaded expiries in order (selected row gets the F§3.3 row-selection bar; click selects the expiry). Row head "3 Nov · 5d" (+ M tag).
- Columns (desktop 11): `10ΔP 15ΔP 20ΔP 25ΔP 35ΔP ATM 35ΔC 25ΔC 20ΔC 15ΔC 10ΔC`. Tablet 9 (drop 15Δ), phone 5 (`10ΔP 25ΔP ATM 25ΔC 10ΔC`). Toggle `Δ | Mny %` in the panel head (capsule); Mny % columns: −6 −4 −2 −1 0 +1 +2 +4 +6 % (phone −4 −2 0 +2 +4).
- Cell value: Δ columns: `ivAtDelta(points, δ, side)` (exists). Mny columns: `ivAtMny(points, m)` (new, §9). ATM: `atmIv`. Shown as "14.8" (1 dp), 12.5 px tabular, centred.
- Colour: **sequential violet** `seqStep(v, lo, hi)` (F§4.3) with lo/hi = 5th/95th percentile across **all** cells in the grid; text uses the step's ink token. Null → no fill, "--" in `--a-quiet`, `title` "Chain too narrow for 10Δ".
- Toggle "vs ATM" (chip): cell shows `iv − row atmIv` signed and uses the **diverging** scale (`divStep`, m = p95 of |v|) — positive (richer than ATM) on the + side. Header sub "pts over ATM".
- Legend under the grid: a 5-step swatch ramp with the lo and hi values ("12.1% … 18.4%"), or the 7-step diverging ramp with "−2.0 … +4.9 pts".
- Hover a cell: crosshair-style highlight of its row and column headers (`--mat-fill-2`), tooltip "17 Nov · 25ΔP · 13.6% (+1.4 vs ATM) · K 25950".
- Loading rows: skeleton cells (`dv-shimmer`); error rows: one spanning cell "Couldn't load · Retry" (same as the term table).
- Accessible: it is a real `<table>` with `<th scope>`; colour is never the only carrier (numbers are always printed).

---

## 7. Tables

### 7.1 Term table (`vol-term`)
- **ATM IV cell**: sequential heat (`seqStep` across loaded rows), ink per step.
- **RR (P−C)** text: put ink when ≥ +0.5, call ink when ≤ −0.5, else fg.
- **Fwd vol**: "Inverted" in `--warn-ink` with a warn dot.
- **New default column "Curve"** after ATM IV, 64 px: a 64×18 inline SVG sparkline of the expiry's OTM smile (violet line, F tick in fg), same y scale across rows so steeper smiles look steeper. Removable via Customise. Hidden on phone (detail row shows it at 160×40).
- Selected row: F§3.3 row selection (fill-2 + `--sel-bg` leading bar) instead of the blue `vol-bar`.
- 1σ range column: text plus a 3 px range bar under it (same as the KPI micro-bar), widths comparable across rows (shared track = min lo to max hi).

### 7.2 Strikes table (`vol-strikes`)
- ATM row: strike as a **contrast pill** (F§4.6), row rules `fg / 0.25`; no blue fill.
- 25Δ / 10Δ tags: side-coloured tint chips (`--dv-put-ink` on 12/16 % put tint for P tags, call for C tags).
- **OTM IV cell**: sequential heat across the shown range.
- **vs ATM**: signed text plus a centre-zero micro bar (max ±p95) in `--dv-iv` at 0.6 — the smile's shape becomes visible down the column.
- CE IV / PE IV text in side inks (0.85 alpha to stay calm) — the user learns the colour language from the table.
- **Bid/ask IV mode**: the cell becomes a 60 px range bar: track = row min bidIv to max askIv across the range, segment `bidIv–askIv` in the side colour at 0.5, mid tick in fg; numbers in the `title` and the tooltip. Spread % > 10 % → warn dot.
- **Flag column**: drop when no row has a flag in range (today it is always empty in demo); when present, flags are warn dots + text ("Wide", "LTP", "Gap") in `--warn-ink`, and a "Gap" (CE/PE parity gap) row gets a 2 px `--warn` leading edge.

### 7.3 Read panel
- Persona heads get a 3 px neutral leading bar (`fg / 0.25`) and a small icon each (existing `icon()` set). They are not coloured green/red per persona, because red/green mean money (F§4). Text stays neutral ink (PRD 05 §5.10). The only colour in this panel: arbitrage hits use `--warn` dots; "No executable violations" uses a `--pos` check icon (an OK state, F§4.1 allows green for OK).

---

## 8. Motion (F§6 primitives; every item has a reduced-motion fallback)

| What moves | When | How | Duration / easing | Reduced motion |
|---|---|---|---|---|
| **Smile path morph** | refresh with the same strike set; range change (shared strikes); series toggle on | Interpolate each point's y from the previous to the new value in a rAF tween; points that appear fade in (opacity 0→1), points that leave fade out; path `d` rebuilt per frame from the tweened array (≤ 120 points: cheap) | `--dur-3` (320 ms) `--ease-std` | set final `d` at once |
| **Axis change** (Strike ↔ Mny ↔ Δ) | x unit change | Tween each point's x from old to new pixel position (same strikes, new mapping) while x tick labels cross-fade (old out 120 ms, new in 200 ms) | 320 ms `--ease-std` | instant |
| **y-scale change** | min/max IV moves a tick | gridlines and tick labels slide to new y with the same tween; labels whose value disappears fade out | 320 ms | instant |
| **Expiry change** | new selected expiry | cross-fade: old path to 0 opacity while the new one draws with **line reveal** (F§6.2 #7: dashoffset L→0) | reveal `--dur-4` 600 ms `--ease-out`; fade 200 ms | instant |
| **First draw** | page enter / underlying change | line reveal on OTM and term ATM line; area fades in after 120 ms; dots pop (scale 0.6→1, opacity) staggered 8 ms, capped at 240 ms | 600 / 320 ms | none |
| Bands, markers, pills | F/spot/lo/hi move | `transform: translateX()` transition on the marker group | `--dur-2` 200 ms `--ease-std` | instant |
| Term points | refresh | dots and line tween with the same y tween as the smile | 320 ms | instant |
| Term selection ring | expiry select | ring moves (translate) to the new point, scale 1.15→1 settle | 200 ms `--ease-out` | instant |
| Tooltip | show/hide | opacity + translateY 4→0 | 120 ms in, 120 ms `--ease-in` out | opacity only |
| Crosshair | pointer | follows the pointer at frame rate, snapped to the nearest strike (no easing: easing on a crosshair feels laggy) | — | same |
| Heat cells | value step change | `background-color` transition | `--dur-1` 120 ms | instant |
| KPI micro-bars | value change | `transform: scaleX(var(--v))` transition (F§6.2 #1) | 320 ms `--ease-std` | instant |
| Smile/Term/Surface tab (phone) | tab change | outgoing fades 120 ms, incoming fades + translateY 6→0 200 ms; capsule thumb slides (F§6.2 #6) | — | instant swap |

Rules: animate only `transform`, `opacity`, `stroke-dashoffset`, `d` (via rAF) and heat `background-color`. A refresh tick that changes nothing visible must not start a tween (keep the signature memo). Cancel a running tween when a new update arrives and start from the current interpolated state (no jumps). Tween code lives in `vol-curves.js` (`tweenPoints(from, to, ms, onFrame)`); it checks `matchMedia("(prefers-reduced-motion: reduce)")` and the `Motion` availability once per update.

---

## 9. Maths additions (pure, `options.js`, tested in `options.test.mjs`)

1. `ivAtMny(points, m)` → number|null: OTM composite IV at moneyness `m` % by linear interpolation between the two bracketing points with non-null `otm.iv` (in `m`); null outside the loaded range or when the bracket spans more than 2 strike steps of missing data.
2. `smileSpark(points, { n = 24 })` → `[{ m, iv }]`: down-sampled OTM points for the term-table sparkline (evenly spaced in `m` across the ±1σ·2 window, each from `ivAtMny`).
3. `twoSigma(F, atmIv, years)` → `{ lo, hi }`: `F·exp(∓2·σ·√T)` with σ = atmIv/100 (mirrors the existing 1σ maths; same T floor).
4. `seqStep` / `divStep` come from the foundation (F§4.3/4.4). If they have not landed, add them here as specified there.
5. Tests: monotone interpolation; null outside range; `twoSigma` symmetric in log space; sparkline length and order; a 1-point chain returns `[]`.

---

## 10. States

| State | Smile / term | Surface | Tables |
|---|---|---|---|
| Loading (first) | skeleton plot: 4 shimmer gridlines + a shimmer curve placeholder at final height (no jump); legend items as 40 px skeleton pills | skeleton cells, final row height | existing skeleton rows |
| Loading more expiries | term shows loaded points; pending expiries as hollow `--a-quiet` ticks on the x-axis labelled with their dates | pending rows shimmer | existing "Loading…" rows |
| Refreshing | only tweens and flashes (§8) | heat transitions | value flashes |
| No live bid/ask | dots hollow; a slim `--warn` 8 % banner "No live bid/ask: IVs from last traded prices" inside the plot top (one line, not above the plot); Bid/ask ribbon item disabled with title | normal | Bid/ask IV button disabled with reason |
| Expiry day | banner "Expiry day: IV is unstable in the final hours" (warn); term point hollow | row dimmed `--a-quiet` | as PRD |
| Chain too narrow for 25Δ | 25Δ ticks omitted; legend note "25Δ outside loaded strikes" | "--" cells with title | "n/a" |
| One expiry only | term: single point + "Needs 2 expiries for a curve" centred 12.5 px `--a-quiet` | one row | — |
| Error, no data | `errorState` in place of the plots (exists) | same | same |
| Error, data kept | `err-bar` at the panel top: "Couldn't refresh: … Showing 09:06:40" | same | same |
| Market closed | normal, last values; nothing animates | — | — |
| Demo | **nothing on this page** (single toolbar indicator, F§7) | — | — |

---

## 11. Accessibility
- SVGs: `role="img"` + the existing aria-label sentences (keep `smileLabel`), plus `tabindex="0"` for keyboard scrub; the live tooltip text mirrors into a visually hidden `aria-live="polite"` region, throttled to once per 500 ms.
- Colour never alone: CE/PE also differ by dash; put/call dots also by position relative to the F line; heat cells print the number; RR prints "Puts richer"; shape label prints its word.
- Contrast: all text uses ink tokens ≥ 4.5:1 or `--a-quiet` floor (F§3.2); marks use fill tokens ≥ 3:1.
- Touch targets: legend chips, `⋯`, toggles 44 px on coarse pointers; term points keep their 22 px hit radius.

---

## 12. Feature gaps (prioritised, with behaviour)

1. **Colour system on both curves** (§4.1, §4.3): violet IV, side-coloured dots and wings, contrast ATM pill, spot pill, gradient area, ±1σ/±2σ bands. Highest value: it is the owner's direct complaint.
2. **Hover tooltip + touch scrub + y value chip** (§4.4): replaces the far-away readout line; compare value at the same x.
3. **Animated transitions** (§8) via persistent charts (§4.0).
4. **Phone first screen shows the smile** (§3.4): KPI scroll row, one capsule head + Chart options sheet, docked readout.
5. **IV surface heat grid** (§6) with Δ/Mny and "vs ATM" modes.
6. **Heat + micro-visuals in tables and KPIs** (§5, §7): ATM IV heat, OTM IV heat, vs-ATM bars, term sparkline column, RR side colour, IV − HV tile with diverging colour.
7. **HV20 reference line and forward-vol segments on the term curve** (§4.3).
8. **25Δ / 10Δ ticks on strike and moneyness axes** (§4.1).
9. **Bid/ask IV ribbon** on the smile and range bars in the strikes table (§4.1, §7.2).
10. **OI strip under the smile** (§4.1; PRD 05 LATER L8 promoted), off by default.
11. LATER: positions overlay on the smile (held strikes as contrast ticks with lots, L6); constant-maturity 30d IV marker on the term curve (L3); IV history series into the chart engine slot (L1/L2).

---

## 13. Acceptance checks
- Static (`polish.test.mjs` or a new block in an existing vol test): §12v in `app.css` references no `--ios-blue` for `.vol-svg` series, dots, band or rings; it references `--dv-iv`, `--dv-call`, `--dv-put`, `--dv-band`, `--dv-spot`, `--sel-bg`. Every `@keyframes` in §12v has a reduced-motion rule. `vol-curves.js` exports `smileChart` and `termChart`; `vol.js` no longer calls `smileHost.replaceChildren(smileSvg(` on refresh.
- Unit: §9 maths; `smileChart.update` with identical data does not change any attribute (spy on `setAttribute`); with reduced motion, `update` sets the final `d` synchronously.
- Playwright (`scratchpad/volr2.cjs` extended), phone/tablet/desktop × dark/light: no horizontal scroll; on phone the smile `<svg>` top < 844 − tab bar height on first screen; the OTM path's computed stroke equals the `--dv-iv` value; the ATM pill's background is rgb(255,255,255) in dark and rgb(10,10,11) in light; hovering the smile shows `.vol-tip` with "OTM IV"; touch-drag on phone changes the docked readout; the surface table has ≥ 4 rows × 5 columns of filled cells in demo; zero page errors. Look at every screenshot (curves default, all series + compare + wings, hover, surface Δ and vs ATM, tables).
- Gates: `npx vitest run server/bridge/dashboard`, then `npx vitest run` and `npm run -s check:mjs`.

---

## 14. MUST-DO (ordered by value)

1. **Recolour the curves with foundation tokens**: OTM composite `--dv-iv` 2 px with a violet gradient area; OTM dots filled by source side (`--dv-put` left of F, `--dv-call` right); CE line `--dv-call` dashed, PE `--dv-put` dotted; compare `--dv-hv`; ±1σ band `--dv-band` with violet edges and ±2σ at half alpha; term ATM line violet, 25Δ put/call wings in side colours; end labels in series inks; remove every `--ios-blue` from §12v.
2. **Contrast markers**: F line in `--dv-spot` with the "ATM 26500 · 13.5%" contrast pill, spot pill on `--surface-raised`, selected term point ring in `--dv-spot` with an IV pill; all selected toggles/chips (25Δ wings, HV20, series chips) use `--sel-bg`/`--sel-fg`; strikes ATM row as a contrast pill and F§3.3 row selection instead of blue.
3. **Hover tooltip, crosshair, y-value chip and touch scrub** on the smile and the term curve (with compare value at the same x); docked readout card on phone; remove the readout lines above the plots; keyboard ← → / Shift / Enter.
4. **Persistent `smileChart`/`termChart` with animated transitions**: point-wise y morph on refresh/range/series, x morph on axis change, cross-fade + line reveal on expiry change, first-draw reveal, marker slides, ring move; reduced-motion = instant.
5. **Phone layout**: KPI as one scroll-snap row (ATM IV, 1σ, IV − HV, RR first), curves head = one `[Smile | Term | Surface]` capsule + `⋯` Chart options sheet, compare label "Compare"/"vs 10 Nov" (never clipped), plot visible on the first screen, bottom padding clears the tab bar; tablet: remove the empty panel header rows, term plot 200 px.
6. **Legends** for smile and term (F§4.5) as toggle chips, including the "CE ≈ PE (parity holds)" note when the lines coincide.
7. **IV surface heat grid** (`vol-surface`): expiries × delta buckets (or moneyness), sequential violet heat, "vs ATM" diverging mode, legend ramp, hover tooltip, select row → expiry; add `ivAtMny` and `twoSigma` to options.js with tests.
8. **Table and KPI colour**: ATM IV and OTM IV heat cells, vs-ATM micro bars, term-table smile sparkline column, RR in put/call ink, "IV − HV20" tile with diverging ink and the HV/IV two-marker bar, 1σ range bars, ATM IV position bar, 25Δ/10Δ tags side-tinted, empty Flag column hidden.
9. **Term extras**: HV20 dashed reference line (on by default), forward-vol labels per segment with `--warn` inverted segments, DTE second line on the x-axis, shape label coloured (`--warn-ink` when inverted), M tag under the date.
10. **Axes and markers polish**: y padding + "IV %" title, 4–9 x ticks by width, 25Δ/10Δ ticks on Strike/Mny axes, ±1σ label inside top-left with the range values.
11. **Bid/ask IV ribbon** on the smile (Series item, auto-on with Bid/ask IV) and bid–ask range bars in the strikes table.
12. **OI strip** under the smile (Series item "OI", off by default) in call/put colours.
13. **States**: shimmer skeleton plot and legend at final height, pending expiries as hollow axis ticks, in-plot warn banners for no bid/ask and expiry day; no demo markers on this page.
14. **Tests and audit**: §13 static, unit and Playwright checks at 3 devices × 2 themes; read every screenshot before committing.
