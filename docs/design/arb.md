# Design spec: Arbitrage, round 2 (`#/arb`)

Status: ready to build · Files: `server/bridge/dashboard/arbitrage.js` (most of the work), `app.css` §12f (ARBITRAGE), `options.js` + `options.test.mjs` (small pure helpers, §10), `viz.js` (shared helpers from the foundation, used here and not redefined) · Builds on `docs/prd/06-arbitrage.md` (round 1). Every PRD 06 behaviour stays (maths, charges, order flow, safety gates, settings, keyboard) unless this spec changes it. Colours, selection, motion, the top bar and the single demo indicator come from `docs/design/foundation.md` (cited as **F§n**). This page must not invent colours: every colour below is a foundation token.

Reference bar: Sahi Terminal for calm and cleanliness. Sensibull / Opstra / boxtrades.com / IBKR's box-spread rate view / thinkorswim for depth. The page should answer one question in under a second: **"Is there an edge after every rupee of cost, where, how big and can I fill it?"** Today it answers this only after reading a grey table cell by cell.

Evidence: dark and light, phone 390×844, tablet 820×1180, desktop 1440×900, on the default weekly expiry (no future) and on 24 Nov (has a future), with Parity, Boxes and Futures tabs and a selected row / open sheet:
`/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/shots2/arb/` (drivers: `scratchpad/arbdesign.cjs`, `scratchpad/arbdesign2.cjs`). None of the shots scrolls sideways at page level. These shots predate the foundation (warm theme), so the theme itself is covered by F§3. This spec covers what is specific to the arbitrage page.

---

## 1. What is wrong today (specific, from the screenshots and code)

### 1.1 Colour: edge has no colour (the owner's complaint)
- **Net ₹ after charges is colourless.** `app.css` `table.arb-table td.neg .two strong` sets negatives to `--a-quiet` grey, positives to plain foreground bold (`app.css:2671-2672`). On 24 Nov every Conversion/Reversal cell (−₹435 … −₹1452) is the same grey. A positive edge would only be *bolder*. Edge, the one thing this page exists for, is not encoded by colour at all.
- **Waterfall is a plain `<dl>` of numbers** (`arbitrage.js` `createDetail` → `.arb-wf`). Charges, financing and net are text in two colours (fg and `--a-label`). "= Net −₹497" is greyed (`.arb-wf-net.neg`), so a loss reads as *quieter*, the opposite of what it should do.
- **Box rates** (−38.62 %/yr, −4462 bp vs hurdle) are plain white/black. 120 rows in desktop, 30 cards on phone, with no visual ranking: the eye has to read every number.
- **Liquidity dots** (`.liq i.on` = `fg / 0.62`) are all-on white for almost every row; 4/5 and 5/5 look the same at a glance and 1–2 are not flagged.
- **Dev column** is plain text; "Calls rich / Puts rich" is indigo sub-text. There is no heat by strike, so a cluster of mispriced strikes is invisible.
- **Blue means five things** on this page: ATM tag (solid blue), sort arrow, opportunity row tint (`tr.opp` blue 8 %), selected row (blue top/bottom lines, `tr.sel`), Edge tag outline. The kind pill is indigo. None of this follows F§3.3 or F§4.

### 1.2 Hierarchy and information architecture
- The figures strip (6 tiles) spends a full tile on **Spot**, which the foundation bar now carries (F§5), and on **Best conv / rev = "--"** with "Needs a same-expiry future" on the default weekly expiry. Two of six tiles say nothing useful on first load.
- The default expiry is weekly with no future, so on first load **Parity shows 21 rows of "0.0 / 0 bp"** behind a 3-line callout with two buttons (desktop 72 px, phone 120 px). The first impression is "nothing here".
- **Net %/yr is "--" on every row** on 24 Nov because `bestAnnual()` drops non-positive values (`arbitrage.js:382`). On tablet the compact column set keeps this empty column and drops the useful synthetic.
- There is no **single "best opportunity"** card. Best items sit in two small tiles whose subtitle wraps ("Closest: Lend 26150/26650 · −4547 bp").
- **Risk notes** are open by default on desktop and tablet: 10 numbered paragraphs, about 450 px. The **chart engine slot** beside them is a 450 px dashed box. Together they take more height than the scanner.
- The **keyboard hints** row shows on tablet (touch, no keyboard) and wraps to two lines.

### 1.3 Layout per device
- **Tablet 820**: the 340 px detail pane leaves the table about 440 px. In Futures, "Cheaper short" is clipped inside the table. The pane's `max-height` cuts the waterfall mid-line ("Excess over hurdle" half under the floating tab bar), and the tab bar covers two table rows.
- **Phone 390**: cards are two dense text lines ("Syn 26602.6 · Dev −0.2 · ●●●●●" / "−₹497" / "--"). The right sub-line is "--" for most rows. 21 near-identical cards, no visual ranking, no colour. The detail sheet is a list of numbers; the net is the 12th line.
- Phone Boxes: 30 cards of "−38.62 % … −50.14 %", all the same weight. The "Lend / Borrow" capsule and the lots stepper take two separate rows.

### 1.4 Demo repetition (F§7)
- On this page "demo" shows up four times: the toolbar pill "Demo data", "Demo paper account" plus the "Paper" badge, and risk note 10 "**Demo prices:** …". The foundation removes the first three. This page removes the "Demo prices:" lead-in (`DEMO_NOTE`, `arbitrage.js:60`).

### 1.5 Motion
- Nothing animates except the tile skeleton (`arb-shimmer`, its own keyframe). Values change without a flash. Rows re-sort by jumping. A new edge appearing is announced only to screen readers.

---

## 2. Target information architecture

Top to bottom (every device):
1. **Foundation top bar** (F§5): underlying, expiry, spot, lot, account, live. Nothing arbitrage-specific.
2. **Rates ladder strip** (§5): one line that puts every rate on one axis against the hurdle. It replaces the 6 tiles.
3. **Opportunity rail** (§4): up to 3 cards. Best parity, best box, best calendar or carry, each with its edge after charges. It replaces the "Best conv / rev" and "Best box" tiles.
4. **Scanner panel**: head (tabs, lots, hold, opportunities switch, Costs & filters), then **the tab's visual** (§6: parity heat strip / box matrix / term mini-chart), then the table or cards, then the detail pane (desktop) or sheet (tablet portrait, phone).
5. **Footer row**: Risk notes (collapsed, one line) and the chart engine slot (160 px), side by side on desktop, stacked on narrower screens.

Rule: **colour encodes edge after charges**. Green ink/fill = clears every cost (net > 0). Red ink = does not. Strength comes from fill intensity, not from more hues. Calls/puts colours are used only for "which side is rich" (§6.1), never for money.

---

## 3. Layout per device

### 3.1 Desktop ≥ 1280 (content ≈ 1120 px at 1440)
```
[ foundation bar 52 ]
[ rates ladder strip 60 (full width) ]
[ opp card 1 ][ opp card 2 ][ opp card 3 ]         ← 104 px, 3 equal columns, gap 12
[ scanner panel ─────────────────────────────────────────────── ]
[ head 48: (Parity|Boxes|Futures) chips …  − 1 lots +  (Expiry|Close)  Opps ◯  ⚙ Costs & filters ]
[ tab visual: parity heat strip 64 / box matrix (toggle) / term chart 140 ]
[ table (min 0, 1fr) ─────────────────────────────── ][ detail pane 360 ]
[ foot: 21 strikes · ATM ±10 … · keys (fine pointer only) ]
[ risk notes (1fr, collapsed 44) ][ chart engine slot (1fr, 160) ]
```
- Panel padding 12, gap 12, radius 16 (F§8).
- The table and the pane scroll inside the panel: `max-height: calc(100dvh - 52px - 24px)` with a sticky table head. Both share the one panel edge. Pane separator is `--mat-separator` 1 px.
- The detail pane is 360 px (was 340), so the waterfall bars (§7.2) get 160 px of track.

### 3.2 Desktop 1024–1279 / tablet landscape
- As 3.1, with the pane 320 px. The parity table uses the compact column set (§8.1) plus Net %/yr.

### 3.3 Tablet portrait 820×1180 (content ≈ 788 px)
- Rates ladder: full width, 60 px.
- Opportunity rail: horizontal scroll-snap row, cards 300 px wide (2.5 visible), 16 px edge fade mask.
- Scanner head: one row. `[Parity|Boxes|Futures]` on the left, `[− 1 lots +] [⚙]` on the right. Hold and Opportunities move into the Costs & filters sheet; the ⚙ button shows a dot when either is non-default.
- **No side pane.** The table gets the full 788 px. A row tap opens the detail as a bottom sheet (`sheetPopover`, max 80dvh, the same component as phone). This fixes the clipped "Cheaper short" column and the cut waterfall.
- Keyboard hints hidden (`@media (pointer: coarse)`).
- Bottom padding of the page = tab bar height + 16 + safe area, so the last row and the notes clear the floating tab bar.

### 3.4 Phone 390×844 (content 358 px)
```
[ foundation bar 52 + safe area ]
[ rates ladder 52 (scaled, labels on two lines) ]
[ opp rail: cards 300×112 scroll-snap, 16 px fades ]
[ Parity | Boxes | Futures ]            ← full-width capsule, 44 high
[ − 1 lots +            Lend|Borrow (boxes only)    ⚙ Filters ]   ← one row
[ heat strip 56 (parity) / matrix toggle (boxes) / term chart 120 (futures) ]
[ cards (§8.4) ]
[ Risk notes · 9 — tap to read ]
[ chart engine slot 120 ]
```
- First screen (844 − 52 bar − 84 tab bar): ladder, rail and the tab capsule are visible, plus the start of the heat strip. The first card is reached with one short scroll. That is fine: the rail already shows the best three items.
- The detail opens in the existing bottom sheet, reordered for phone (§7.4).

### 3.5 Light and dark
- All values are tokens. Dark: canvas `--background` near-black and panels `--card` (F§3.1). Light: white panels on #F4F4F5.
- Heat cells use the F§4.3 / F§4.4 tables with their ink tokens, so text on any heat step meets 4.5:1 in both themes.

---

## 4. Opportunity rail (new; the "clear opportunity cards")

### 4.1 Which cards
Up to 3 cards. Each is the best item of its kind under the current lots, hold and rates:
1. **Parity**: the parity row with the highest `best.net`, among rows with `best` (same-expiry future quoted). If the expiry has no future, the card is **"Parity · switch expiry"** (see 4.4).
2. **Box**: the lend box with the highest `vsHurdleBp`, excluding `crossed`. When Borrow is the selected mode, the borrow box with the highest `vsHurdleBp`.
3. **Carry**: the future with the largest |`carryVsBp`|, or the calendar with the largest |`vsFair`| in ₹/lot (whichever has the larger absolute ₹ per lot after charges).

Items that are stale (`m.stale`) are not shown as cards. Their slot shows the stale state (4.4).

### 4.2 Card anatomy (desktop 104 px tall; phone 300×112)
```
┌───────────────────────────────────────────────┐
│ CONVERSION · 26600  [ATM]             ●●●●○   │  row 1: kind 11px 700 caps --a-label · strike 650 13px · tags · liq meter
│ +₹1,240           +3.8 %/yr over hurdle       │  row 2: net 650 22px tabular (pos/neg ink) · return 12.5px
│ ███████████████████▌────│── covers 1.4×        │  row 3: cost-cover bar (§4.3) 6 px, label 11.5px
│ 3 legs · ₹2.4L capital · 2 s old   [Preview →] │  row 4: 11.5px --a-quiet · small button
└───────────────────────────────────────────────┘
```
- Background `--card`. Edge: an inset 3 px leading bar in `--pos` when net > 0 and the row passes the filters (`isOpp`), `--neg` at 0.6 when net ≤ 0, `--warn` when stale.
- **Net** text: `--pos-ink` if net > 0, `--neg-ink` if net < 0, `--neutral-ink` if it rounds to ₹0. Always signed (`rupeeSigned`).
- Return line: parity `annual` (signed, see §8.2 fix), box `rate` with "vs hurdle ±N bp", carry `carryVsBp` bp. Coloured by the same sign rule, 500 weight.
- The whole card is a button. Click: select that item (switch tab if needed, scroll the row into view, open the sheet on phone/tablet portrait). The **Preview** button opens the order preview directly (PRD 06 §8), with the same gates.
- Hover (fine pointer): `--mat-fill-1` background. Focus-visible: 2 px `--sel-ring`.

### 4.3 Cost-cover bar (the shared "edge after charges" glyph)
It encodes "how much of the total cost the gross edge pays for". It is used on cards, in the parity table (§8.1) and in phone list cards.
- `cost = breakEvenPts` (= (charges + financing) / U for parity; charges / U for boxes, PRD 06 §7).
- `gross = grossPts` (parity) or `(width − debit)` for a lend box / `(credit − width)` for borrow, in points per unit.
- `cover = gross / cost` when cost > 0; null otherwise. Pure helper `coverRatio(s)` in `options.js` (§10).
- Track: full width, 6 px (cards) / 4 px (table), radius 3, `--mat-fill-2`.
- **Cost marker** at a fixed 70 % of the track: a 2 px tall tick in `fg / 0.55` with the label "cost" (cards only, 10.5 px `--a-quiet`). So the track's scale is `x = clamp(0, 1, cover / (1/0.7)) · width`, which maps cover 1.0 to the marker and caps at cover ≈ 1.43.
- Fill from 0 to x: if cover ≥ 1, `--pos` with the part beyond the marker at full alpha and the part before it at 0.45. If 0 < cover < 1, `--neg` at 0.55 (it covers only part of the cost). If gross ≤ 0, no fill and the label says "gross negative".
- Label: "covers 1.4×" (`formatFixed(cover,1)` + "×") or "needs 1.52 pts more" when cover < 1 (`cost − gross`).
- Width animates via `--v` (F§6.2 bar resize).

### 4.4 Rail states
- **Loading**: three skeleton cards at the final size (`dv-shimmer`).
- **No edge anywhere** (all nets ≤ 0, the normal case): the cards still show (honest: the best is still negative), in red ink. A single line sits above the rail, 12.5 px `--a-label`: "No structure clears costs right now. Closest: Conversion 26600, needs 1.52 pts more." There is no banner or tint.
- **No future for this expiry** (parity card): the card shows "No future on 3 Nov", the largest |dev| strike ("Largest deviation 26800 · +0.1 pts · calls rich"), and one button **"Use 24 Nov"** (the nearest expiry with a future, from `m.nearestFut`). This replaces the 3-line callout in the scanner. In the scanner itself, the callout becomes one slim line (§8.1).
- **Stale**: the card is dimmed to 0.55 with a `--warn` leading bar and "Stale · 7 s old" in `--warn-ink` in row 4. Preview is disabled.
- **Error** (chain failed): the rail collapses to one `err-bar` line (F§9).

---

## 5. Rates ladder strip (replaces the 6 tiles)

One purpose-built SVG, full width, 60 px (phone 52), inside a `.desk-panel`. It answers "what does money cost here?" by putting every rate on one %/yr axis:

| Mark | What | Token |
|---|---|---|
| **Hurdle** | `cfg().hurdle` | vertical 2 px line `--dv-spot` with a contrast pill "Hurdle 6.00 %" (`--sel-bg`/`--sel-fg`) |
| Futures carry | `(Fm/S − 1)·365/d` of the same-expiry future, else the nearest | 10 px diamond in `--dv-iv` (violet = a derived rate; carry is not a call/put quantity, so no side colour) |
| Options-implied rate | `m.optRate` | 10 px ring, 2 px stroke `--dv-iv` |
| Best lend box (net) | `lendBoxes[0].rate` | 10 px square: `--pos` if ≥ hurdle else `--neg` |
| Best borrow box (net) | the best borrow rate | 10 px square outline in the same rule (borrowing cheaper than hurdle = `--pos`) |

- Axis: domain = `niceTicks` over [min, max] of the marks and the hurdle, padded 10 %, clamped to [−20 %, +30 %]. A value outside the clamp sits at the edge with a "◂" / "▸" glyph and its value in the label. (Demo lend boxes at −39 % would otherwise squash everything.)
- Gridlines: none. Only the baseline, 1 px `--dv-grid`, and 3–5 ticks, 10.5 px `--dv-axis`.
- Labels: each mark has a 11.5 px label above (alternating above/below when two marks are < 56 px apart): "Carry 6.52 %", "Options 6.28 %", "Lend box −4.79 %". Values in the series ink: `--dv-iv-ink` for the rates, `--pos-ink`/`--neg-ink` for the boxes.
- Text to the right of the plot (desktop ≥ 1280 only, 280 px): two compact figures, **Future** "26603.90 · 26609.20" (sub: "basis +124.10 · 0.47 %") and **Implied fwd** "26606.48" (sub: "band ±0.1 · 11 strikes"). On tablet and phone these two figures move into a 2-cell row under the plot (phone: inside the strip as a second line, 11.5 px).
- Hover/tap a mark: tooltip (F§4.5) with the definition and formula from PRD 06 (e.g. "Carry = (Fm/S − 1)·365/d. 26 days."). Click a box mark: select that box (switch to Boxes).
- `role="img"`, `aria-label` "Rates against hurdle 6.00 %: futures carry 6.52 %, options-implied 6.28 %, best lend box −4.79 %, best borrow box …".
- Motion: marks slide on change (`transform: translateX`, `--dur-3` `--ease-std`); labels cross-fade. Reduced motion: jump.

---

## 6. Heat by strike: one visual per tab, between the head and the table

### 6.1 Parity: deviation heat strip (`arb-heat`, 64 px desktop, 56 phone)
One cell per strike in the window (21 by default), left to right by strike, equal width (`(W − 2·12) / n`, min 12 px; on phone with n > 26 it scrolls sideways inside the panel).
- **Cell colour = which side is rich, and by how much**. Rich vs reference outside the touch:
  - `dev > 0` (synthetic above reference, calls rich → reversal side): `--dv-call` at alpha by step.
  - `dev < 0` (puts rich → conversion side): `--dv-put` at alpha by step.
  - step = `seqStep(|devBp|, 0, m)` where `m = max(5 bp, p95 |devBp|)`; alpha by step 1–5 = 0.12, 0.25, 0.45, 0.70, 0.95.
  - |devBp| < 1 bp → `--mat-fill-1` (neutral), so a fair chain reads calm and grey.
  - One-sided or indicative rows: hatched (`dv-hatch-call/put`, F§4.2) instead of solid.
- **Edge marker** (only when a same-expiry future exists): a 6 px dot centred above the cell. It is `--pos` if `best.net > 0`, hollow `--neg` ring if `best.net ≤ 0` and `cover ≥ 0.8` (close to an edge), otherwise no dot. So green dots are the strikes to look at.
- **ATM**: the strike label under the ATM cell is a contrast pill (`--sel-bg`/`--sel-fg`). Other labels: every 5th strike, 10.5 px `--dv-axis`.
- **Selected row**: the cell gets a 2 px `--dv-spot` outline (radius 3) and moves with the selection.
- Legend (F§4.5), inline above the strip, 12 px: `■ Calls rich (reversal)` `■ Puts rich (conversion)` `● Clears costs` `○ Close (≥ 80 % covered)`, plus a 5-step alpha ramp with "0 → 12 bp" (the actual m).
- Interaction: hover → tooltip "26800 · dev +0.1 pts (+1 bp) · calls rich · best Reversal −₹1416"; click/tap → select that row (scroll into view; on phone also open the sheet). Keyboard: the strip is one tab stop; ← → move, Enter selects.
- Motion: cell `background-color` / `opacity` transitions over `--dur-3`. A cell whose step rises by ≥ 2 pulses its outline once (`--dur-flash`). Reduced motion: instant.

### 6.2 Boxes: List | Matrix toggle and the K1×K2 heat matrix (PRD 06 LATER, promoted)
- A small capsule `[List | Matrix]` sits in the tab head next to Lend|Borrow (F§3.3 contrast selection). It is persisted as `cfg().boxView`.
- **Matrix**: rows = K1 (lower strike), columns = K2 (higher strike); only K2 > K1 within `boxMaxSteps`. The upper triangle is drawn; the rest is empty. Cell 22×22 desktop (min 16), 18×18 phone (the matrix scrolls sideways inside its container, sticky K1 labels on the left).
- **Cell colour = `vsHurdleBp`** on the diverging scale (F§4.4) with **fixed trader thresholds** (not a percentile, so colours mean the same thing every day): step 0 for |bp| < 10; ±1 for < 50; ±2 for < 150; ±3 beyond. Positive (beats hurdle) = green steps, negative = red steps. Pure helper `bpStep(bp)` (§10).
- Crossed quotes: `--warn` hatched cell with a "×". Not two-sided: empty with a 1 px `--mat-hairline` outline.
- Cells that pass `isOpp.box` get a 1.5 px `--dv-spot` inner ring.
- ATM column and row headers: contrast pill.
- Legend: 7 swatches "≤ −150 · −50 · −10 · 0 · +10 · +50 · ≥ +150 bp vs hurdle".
- Hover: tooltip "26300 / 26800 · width 500 · lend 4.79 %/yr net · −121 bp vs hurdle · ₹37.6k". Click: select the box (list row + detail).
- **List view** (default on phone) keeps the ranked table/cards with the heat applied to the "vs hurdle" cell (§8.2).

### 6.3 Futures: term mini-chart (140 desktop / 120 phone)
Purpose-built SVG (a term structure, not a price/time chart, so it is allowed):
- x = days to expiry (0 → last future + 10 %), ticks at each future's expiry with "24 Nov" / "29 Dec" labels.
- y = %/yr. Series:
  - **futures carry** per expiry: `--dv-iv` 2 px line with 6 px dots;
  - **options-implied rate** per expiry (where a chain is loaded): `--dv-iv` 1.5 px dashed with ring dots;
  - **forward rate between expiries** (`cal.fwdRate`): a short horizontal segment over each [d1, d2] interval in `fg / 0.55`, with its value label;
  - **hurdle**: a horizontal `--dv-spot` 1 px line with the contrast pill.
- The selected toolbar expiry's dot is larger (9 px) with a contrast pill label.
- Calendar rich/cheap: the forward segment is coloured `--neg` when the spread is rich for a long roll (you pay more than fair), `--pos` when cheap. Label "rich +12.8" / "cheap −4.1".
- Legend: `— Futures carry` `- - Options-implied` `— Forward (rich/cheap for a long roll)` `— Hurdle`.

---

## 7. Detail pane / sheet

### 7.1 Header
- Eyebrow "Best on this tab" / "Selected", 10.5 px caps `--a-quiet`.
- Title 15 px 700 (unchanged).
- **Net hero** under the title (new): net ₹ 650 26px tabular in pos/neg ink, then "+3.8 %/yr over hurdle · covers 1.4×" 12.5 px, then the cost-cover bar (§4.3) at full pane width with the cost marker labelled.
- Conversion | Reversal: the F§3.3 contrast capsule (the selected segment is white-on-black in dark, black-on-white in light). The indigo `.arb-kind` pill becomes a neutral outline chip (`inset 0 0 0 1px --mat-separator`, `--a-label` text).

### 7.2 Cost waterfall (visual; replaces the `<dl>` list)
A horizontal waterfall drawn in HTML (one row per line of `O.waterfall(s)`), so it reflows and stays accessible:
```
Gross locked          ██████████████████████████▏          +₹1,620
Financing at hurdle                       ▕███▏            −₹164
Brokerage                              ▕██▏                −₹80
STT                                  ▕██▏                  −₹75
Exchange txn                       ▕█▏                     −₹56
SEBI · Stamp · GST                ▕▌▏                      −₹67   (grouped when each < 2 % of gross; expand on tap)
Exercise STT                     ▕▏                         ₹0
───────────────────────────────────────────────────────────────
= Net                 ███████████████████████▏              +₹1,178
```
- Columns: label (max-content, 12.5 px `--a-label`), track (1fr, min 120 px), value (right, 12.5 px tabular, signed).
- Scale: `S = max(|gross|, max |running total|, |net|)`; x(v) = `v / S · trackWidth`. **Zero line** at the left when gross ≥ 0; when gross < 0 the zero line sits at `|min running| / (span)` so bars can go left (2-sided domain). Zero line is 1 px `fg / 0.35` spanning all rows.
- **Gross bar**: from 0 to gross, `--pos` at 0.85 if gross > 0, `--neg` at 0.85 if < 0.
- **Each cost**: a floating segment from the running total before it to the running total after it, `--neg` at 0.55, with a 1 px `--neg` outline (3:1 via the outline, F§4.2). **Financing earned** (positive value, reversal) is `--pos` at 0.55.
- Thin 1 px `fg / 0.25` connectors from the end of one segment to the start of the next (the classic waterfall step).
- **Net bar**: from 0 to net, solid `--pos` or `--neg`, 8 px tall (others 6 px), with the value in pos/neg ink 700 13.5 px.
- Values stay whole rupees that add up exactly (`roundToSum`, unchanged). `title` keeps the 2-dp figure.
- Toggle `[₹ | pts]` (contrast capsule, 24 px) in the section head: pts = value / U, 2 dp.
- For a calendar: rows "Spread paid" and "Charges", then "= Roll cost", same drawing.
- Accessibility: the rows are a `<dl>` still (the bars are `aria-hidden` spans), so screen readers read "Gross locked +₹1,620 … Net +₹1,178".
- Motion: on selecting a new structure, segments grow left-to-right in order, `--dur-3` `--ease-out`, stagger 40 ms (max 9 rows → 360 ms). On a refresh, segments move/resize from their old place (`--v` transitions), never regrow. Reduced motion: final at once.

### 7.3 Below the waterfall
- **Locked payoff mini-chart** (new, 64 px): x = settlement price over ±3 % of the forward; y = P&L ₹. One flat line at `net` (pos/neg colour 2 px), the zero line at `fg / 0.35`, and a dashed vertical at the forward with a contrast pill "F 26606". Caption: "Flat: +₹1,178 at every settlement price". It shows "locked" visually; it replaces the `arb-d-pay` text line. With hold = Close, the line becomes a 2 px band (±exit-spread uncertainty, `--dv-band`), caption "if closed at today's spreads".
- **Legs** table: B/S side tags in `--pos-fill` / `--neg-fill` with F§4.1 text colour; "Top qty" below the leg's units in `--warn-ink` with a ⚠ when top qty < units. Max lots at the touch row: a 5-step meter (§8.3) next to the number.
- **Break-even and return**: as now, with signs coloured (pos/neg ink) and the "vs hurdle" bp as a diverging chip (F§4.4 step via `bpStep`).
- **Box target-rate calculator**: unchanged behaviour; the result line "Max debit 499.10 per unit" is 13.5 px 700 and shows the gap to the current touch in `--pos-ink` / `--neg-ink` ("touch 499.55: 0.45 above").
- **Flags**: dots use `--warn` (warn), `--neg` (bad), `fg/0.5` (info). No blue.
- **Actions**: Copy legs (secondary), Preview orders (primary blue, F§3.3: actions stay blue). Preview disabled (F§3.3 disabled style) when stale or not executable, with the reason in a `title` and a 12 px line above the buttons.

### 7.4 Phone / tablet-portrait sheet order
Title → Conversion|Reversal capsule → **Net hero + cover bar** → **waterfall** → locked payoff → legs → max lots → break-even/return → box calculator → flags → sticky actions. (Today the net is the 12th line.) Sheet max-height 88dvh; the backdrop keeps the F§6.2 popover motion.

---

## 8. Tables and cards

### 8.1 Parity table
- **No-future mode**: the callout becomes one slim line (32 px), 12.5 px `--a-label`: "No future on 3 Nov: deviations vs the implied forward only. [Use 24 Nov]" (a small secondary button). "Boxes tab" button removed (the tabs are right there).
- **Columns, default (desktop)**: Strike · Call bid·ask · Put bid·ask · Synthetic · Dev · **Edge** (new) · Conversion · Reversal · Net %/yr · Liq.
  - **Dev**: heat cell with the §6.1 colour (call/put by side), text in fg. In the table the cell alpha is capped at 0.45 (steps 4–5 use 0.45) so fg text keeps ≥ 7:1 in both themes. Sub-line "+1 bp · calls rich" with "calls rich" in `--dv-call-ink`, "puts rich" in `--dv-put-ink`.
  - **Edge** (new, 96 px): the cost-cover bar (4 px) with the label "1.4×" or "−1.52 pts" under it (10.5 px, pos/neg ink). Sortable by cover.
  - **Conversion / Reversal**: the better of the two in a row (`r.best`) is in pos/neg ink (500 when negative, 700 when positive). The other side is signed text in `fg / --a-label`, so each row has exactly one coloured money value and the table stays calm. Sub-line gross pts `--a-quiet`.
  - **A positive best net** also gets a `--pos` 12 % (dark 16 %) tint on that cell. That is the only cell fill in the table besides Dev, so a real edge pops out.
  - **Net %/yr**: show the better side's `annual` **signed** (also when negative), pos/neg ink, with "conv"/"rev" sub-line. Fix: `bestAnnual()` must not drop non-positive values (pick the max of conv/rev annual among non-null).
- **Compact set** (720–1279 and tablet): Strike · Dev · Edge · Conversion · Reversal · Net %/yr · Liq.
- **Row states**:
  - ATM: strike as contrast pill (`--sel-bg`/`--sel-fg`, F§4.6), plus top/bottom rules `fg / 0.25`. Remove the blue `arb-tag atm`.
  - Opportunity (`isOpp`): 3 px `--pos` leading bar, no row tint. "Edge" tag: `--pos-ink` on 12 % tint.
  - Selected: F§3.3 table selection (`--mat-fill-2` + 2 px `--sel-bg` leading bar). It wins over the opportunity bar (the opportunity bar moves to 3 px inside it, i.e. `inset 2px 0 0 --sel-bg, inset 5px 0 0 --pos`).
  - Stale: 0.55 opacity (unchanged) and a `--warn` "Stale" tag.
  - Sort indicator: `fg` arrow, header text fg 650 (no blue).
- Row height 40 (coarse 44).

### 8.2 Boxes list
- Columns unchanged (Strikes · Debit/Credit · Charges · Locked ₹ · Rate %/yr · vs hurdle · Capital · Liq).
- **vs hurdle**: a diverging heat chip (`bpStep`, F§4.4 bg + ink), 64 px, radius 6, text "−121 bp".
- **Rate %/yr**: pos/neg ink by comparison with the hurdle (≥ hurdle `--pos-ink` for lend; ≤ hurdle for borrow), sub "gross 6.25 %" `--a-quiet`.
- **Locked ₹**: signed, pos/neg ink.
- Width groups: a 1 px `--mat-separator` rule and a 22 px group label row ("500 pts wide") between widths when sorted by rate, so 120 rows read as a few groups.

### 8.3 Liquidity meter (replaces the dots everywhere)
- A 5-segment meter, 24×6 px (segments 4×6, gap 1, radius 1).
- On segments: liq 4–5 `fg / 0.80`; liq 3 `fg / 0.55`; liq 1–2 `--warn`. Off segments `fg / 0.12`.
- `aria-label` "Liquidity 2 of 5 (thin)". The words "thin" (1–2), "fair" (3), "good" (4–5) appear in the tooltip.
- "No quote" text stays `--neg-ink`.

### 8.4 Phone cards (all tabs)
```
┌▌──────────────────────────────────────┐   ▌ = 3 px leading bar: --pos (net > 0 & opp), --neg/0.6 (net ≤ 0), --warn (stale), none (no future)
│ 26600 [ATM]  Conversion        −₹435  │   row 1: strike 650 15px (ATM = contrast pill) · kind 12.5 --a-label · net 650 16px pos/neg ink
│ ▆ dev +0.1 · calls rich   −2.88 %/yr  │   row 2: 8×8 dev heat swatch · dev 12px · return 12px pos/neg ink
│ ████████▌──────│─  needs 1.52 pts ▮▮▮▮▯│   row 3: cost-cover bar (4 px, 1fr) · label 11px · liq meter
└───────────────────────────────────────┘
```
- Min height 72, padding 10 12, gap 4. The whole card is the 44 px+ touch target.
- No-future rows: row 1 right shows dev "+0.1 pts" in fg, row 3 has no cover bar.
- Boxes: row 1 "26300 / 26800 · Lend" and the rate; row 2 debit · capital; row 3 the vs-hurdle chip + liq meter.
- Futures: row 1 "24 Nov · 26 d" and carry %/yr; row 2 basis; row 3 carry vs hurdle chip. Calendar cards keep their indented look, with rich/cheap as a pos/neg-ink chip.
- Selected (sheet open): `--mat-fill-2` + 2 px `--sel-bg` leading bar.

### 8.5 Futures table
- Basis: a small horizontal bar (`hbar`, 48 px) in `--dv-iv` at 0.6, scaled to the largest basis in the list.
- Carry %/yr: pos/neg ink against the hurdle; sub "+52 bp" as a diverging chip.
- Cheaper long / short: "Future" or "Synthetic" with "by 3.2 pts · ₹240/lot" in `--pos-ink` (the saving).
- Current expiry: contrast pill on the date instead of the blue "Selected" tag.

---

## 9. Motion (F§6 primitives; every item has a reduced-motion fallback)

| What moves | How | Duration / easing | Reduced motion |
|---|---|---|---|
| Section enter (route or underlying change only) | `pageEnter`: ladder, rail, scanner, footer | `--dur-3`, stagger 40 ms | none |
| Opportunity card change of item | old content fades out 120 ms (`--ease-in`), new fades/slides in 6 px (`--dur-2`, `--ease-out`) | 320 ms total | instant swap |
| **New edge** (an item's net goes from ≤ 0 to > 0) | card leading bar grows from 0 to full height (scaleY), then one ring pulse `0 0 0 0 → 0 0 0 6px` in `--pos` at 0.5 → 0; row/card gets `dv-flash-up` | 200 ms + 900 ms | bar shown at once; 2 px marker for 3 s (F§6.2) |
| Edge lost | leading bar fades to `--neg` 0.6 over `--dur-3` | 320 ms | instant |
| Net ₹ / rate / bp values | `flashValue(el, dir)` when the shown text changes | `--dur-flash` | 2 px marker |
| Cost-cover bars, liq meter, basis bars | `--v` transform transition from the old value | `--dur-3` `--ease-std` | instant |
| Heat cells (strip, matrix, Dev/vs-hurdle chips) | `background-color` transition | `--dur-3` | instant |
| Row re-order on re-sort or rank change | FLIP: measure old `top`, apply `translateY(old − new)`, transition to 0 | `--dur-3` `--ease-std`; skipped if > 30 rows move or the list changed tab | instant |
| Waterfall | first draw: segments grow in sequence (stagger 40 ms); refresh: resize | `--dur-3` | instant |
| Rates ladder marks | `translateX` slide | `--dur-3` `--ease-std` | jump |
| Term chart | first draw `lineReveal`; refresh: points move (`cx/cy` via transform) | `--dur-4` / `--dur-3` | none |
| Tab switch | the tab visual and the table cross-fade (opacity 0 → 1, 160 ms) | `--dur-2` | instant |
| Stale on/off | dims to 0.55 over `--dur-3` | | instant |
| Skeletons | one `dv-shimmer` (delete `arb-shimmer` and `.sh`) | 1.4 s | static fill |

Budget: per 3 s tick, at most 200 elements patched (PRD 06 §14). Only `transform`, `opacity` and `background-color` animate.

---

## 10. Maths additions (pure, `options.js`, tested in `options.test.mjs`)

1. `coverRatio(s)` → `{ cover, gross, cost, short }`, where `gross` = `s.grossPts` (parity), `s.width − s.price` (lend box) or `s.price − s.width` (borrow box); `cost = s.breakEvenPts`; `cover = cost > 0 ? gross / cost : null`; `short = max(0, cost − gross)`. Null-safe (missing → all null). Tests: conv with gross 3.0, cost 2.0 → 1.5, short 0; gross −1 → cover −0.5, short 3.0; cost 0 → cover null.
2. `bpStep(bp)` → integer −3…3 with thresholds |bp| < 10 → 0, < 50 → ±1, < 150 → ±2, else ±3; null for non-finite. Tests at the boundaries 9.99/10/49.99/50/149.99/150 and negatives.
3. `devHeat(rows)` → per row `{ side: "call"|"put"|null, step: 0..5 }`, using `seqStep(|devBp|, 0, max(5, p95|devBp|))` from the foundation and `side` from the sign of `dev`, null when |devBp| < 1. Tests: a flat chain → all step 0; one outlier does not wash the rest out (p95).
4. `bestAnnualSigned(r)` replaces the page's `bestAnnual` filter: the larger of `r.conv?.annual` and `r.rev?.annual` among non-null, any sign → `{ k, v }`. Hidden on expiry day (unchanged).
5. `waterfallSteps(lines)` → `[{ key, from, to }]` running totals plus `{ min, max }` for the domain, so the drawing has no maths in it. Tests: steps chain (`to[i] = from[i+1]`), the final `to` equals `net`.

Numbers become text only through `format.js` (`formatFixed`, `formatSigned`, `rupeeSigned`, …); none of the new code uses `toFixed`/`toLocaleString`.

---

## 11. States

| State | Rail | Scanner | Detail |
|---|---|---|---|
| First load | 3 skeleton cards | ladder skeleton + 8 skeleton rows at the final height, `aria-busy` | "Loading…" skeleton lines |
| No future for expiry | parity card "No future on 3 Nov · Use 24 Nov" | one slim line; heat strip still works (vs implied forward); Conversion/Reversal/Edge/Net %/yr columns hidden (unchanged rule) | deviation-only key-values (unchanged), with the dev heat swatch |
| Nothing clears costs (normal) | cards in red ink + one line "No structure clears costs right now. Closest: …" | the table shows everything; Opportunities-only switch on → compact empty state "No row clears your filters. Closest: Conversion 26600, needs 1.52 pts more. [Show all rows]" | — |
| Opportunity present | green card(s), new-edge motion | green leading bars, green dots on the strip | net hero green |
| Stale (> `staleSec`) | dimmed cards, Preview disabled | rows at 0.55, "Stale" chip in the head (warn tint), Best excludes stale (unchanged) | Preview disabled with "Quotes are 7 s old" |
| Futures quotes failed | parity card "Futures quotes unavailable" | `err-bar` (F§9) at the top of the scanner; conv/rev hidden | message (unchanged) |
| Chain failed | `err-bar` line | `errorState` card with Retry | "No data" |
| Lot mismatch | card text "Lot sizes differ: no conversions" | unchanged rule | `--neg-ink` message (unchanged) |
| Expiry day | annual figures "--" (unchanged); a `--warn` chip "Expiry day" in the scanner head | | |
| Demo | nothing on this page (F§7). Risk note keeps "Calls and puts use different volatility smiles here, so parity breaks are artificial." without the "Demo prices:" lead-in, only while demo | | |

---

## 12. Risk notes and chart slot (footer)
- Risk notes: collapsed by default on **every** device (the persisted user choice still wins). The summary line: "Risk notes · 9" plus the first note's bold lead-in as a teaser ("Executable only if every leg fills…"), 12.5 px `--a-label`. Open: the list as now, in two columns at ≥ 1280.
- The chevron rotates 90° on open (`--dur-2`).
- Chart engine slot: 160 px desktop / 120 phone, the same `chartSlot()` text. On desktop it sits beside the notes, aligned to the notes' collapsed height (`align-items: start`), so the footer is no longer 450 px of mostly empty space.

---

## 13. Interactions and keyboard (additions to PRD 06 §11)
- `B` jumps to the best opportunity card's item (select + scroll; opens the sheet on coarse pointers).
- `M` toggles List/Matrix on the Boxes tab.
- `E` sorts the parity table by Edge (cover), descending.
- Heat strip and matrix: arrow keys inside, Enter selects, Esc returns focus to the table.
- Tooltips pin on click/tap (F§4.5); Esc unpins.
- On touch, long-press a phone card → the order preview (same gates) with a confirm sheet; a normal tap opens the detail sheet.

---

## 14. Accessibility
- Colour is never the only carrier: signs on every money value, "calls rich / puts rich" words, Edge tag text, the cover label "1.4×" / "needs 1.52 pts", liq meter words in the tooltip, hatch for one-sided.
- Every SVG (`arb-ladder`, `arb-heat`, `arb-matrix`, `arb-term`, locked payoff) has `role="img"` and a summary `aria-label`; the heat strip and matrix have a "Show as table" disclosure (PRD 08).
- New edge announcements via the existing polite live region, throttled to one per 10 s per item (unchanged mechanism).
- Touch targets ≥ 44 px on coarse pointers: rail cards, strip cells (the strip height 56 with cells min 16 wide is a scrubber: tap selects the nearest cell, drag scrubs), matrix cells via scrub plus tap, segmented controls 44 high.

---

## 15. Feature gaps (prioritised, with behaviour)

1. **Edge colour everywhere** (§4.3, §8): pos/neg inks on net ₹, %/yr, bp and locked ₹; the cost-cover bar; positive-edge cell tint; leading bars. Directly answers "colours are missing".
2. **Opportunity rail** (§4): the 3 best structures as clear cards with net, return, cover, liquidity, age and Preview; honest "nothing clears costs" line; the no-future card with "Use 24 Nov".
3. **Cost waterfall visual** (§7.2) with the net hero (§7.1) and the ₹/pts toggle.
4. **Heat by strike** (§6.1) on Parity and the **K1×K2 box matrix** (§6.2) with fixed bp thresholds.
5. **Animated updates** (§9): flashes, bar/heat transitions, FLIP re-sort, new-edge pulse, waterfall grow.
6. **Phone and tablet layouts** (§3.3, §3.4, §8.4): 3-row cards with cover bars, tablet without a side pane, one-row heads, notes collapsed, tab-bar clearance.
7. **Rates ladder** (§5) replacing the six tiles.
8. **Futures term mini-chart** (§6.3) and futures table bars/chips (§8.5).
9. **Signed Net %/yr** (`bestAnnualSigned`) so the column is never all "--".
10. **Locked payoff mini-chart** (§7.3) and the box calculator gap-to-touch line.
11. LATER: opportunity history log (first seen, lifetime, best net) as a small table under the rail; alerts via `/v1/hooks` when cover crosses 1.0 or a box beats the hurdle by N bp; multi-underlying rail (best per index); a "CE/PE colours: NSE style" swap inherited from F§10.

---

## 16. Acceptance checks
- **Static** (`polish.test.mjs` block or `arbitrage` block): §12f in `app.css` contains no `--ios-blue`, `--ios-indigo` or `--ios-orange` (the only blue left is the primary Preview button via the shared `.primary` rule); it references `--pos`, `--neg`, `--warn`, `--dv-call`, `--dv-put`, `--dv-iv`, `--dv-spot`, `--sel-bg`. `arb-shimmer` and `.sh` are gone. Every `@keyframes` in §12f has a reduced-motion rule. `arbitrage.js` does not contain "Demo prices:" and contains no `toFixed(`.
- **Unit**: §10 helpers with the listed cases.
- **Playwright** (`scratchpad/arbdesign.cjs` extended), phone/tablet/desktop × dark/light, on 3 Nov (no future) and 24 Nov:
  - no horizontal page scroll; no page errors;
  - the opportunity rail has 3 `.arb-opp` cards (24 Nov) and the no-future card with a "Use 24 Nov" button (3 Nov);
  - a negative Conversion cell's computed `color` equals the `--neg-ink` value; force a positive edge (Costs & filters: brokerage 0, hurdle 0, all statutory rates 0) and check the `--pos-ink` colour, the `--pos` leading bar and a green strip dot;
  - the ATM strike pill background is rgb(255,255,255) in dark and rgb(10,10,11) in light;
  - the heat strip has one cell per parity row; the box matrix has ≥ 50 filled cells;
  - the waterfall's last bar (`.arb-wf-bar.net`) width is > 0 and its row text equals the net in the rail card when the same item is selected;
  - tablet portrait: no `.arb-pane` visible; a row tap opens the sheet; the last table row is not under the tab bar (`getBoundingClientRect().bottom ≤ innerHeight − tabBarHeight` after scrolling to the end);
  - phone: the rail and the tab capsule are within the first 844 − 84 px;
  - with `reducedMotion: 'reduce'`, no element has a running animation after 50 ms (`document.getAnimations().length === 0` except the live dot).
  - Read every screenshot.
- **Gates**: `npx vitest run server/bridge/dashboard`, then `npx vitest run` and `npm run -s check:mjs`.

---

## 17. MUST-DO (ordered by value)

1. **Edge colour across the page**: net ₹, %/yr, locked ₹, bp in `--pos-ink`/`--neg-ink` (signed, never greyed for being negative); a `--pos` tint on positive best-net cells; `--pos`/`--neg` leading bars on opportunity rows and cards; vs-hurdle diverging chips with `bpStep`; remove every blue/indigo/orange arb rule (ATM → contrast pill, selection → F§3.3 row style, sort arrow → fg, kind pill → neutral, Conversion|Reversal → contrast capsule).
2. **Opportunity rail**: 3 cards (best parity, best box, best carry/calendar) with net hero, return vs hurdle, cost-cover bar, liquidity meter, age, Preview; "No structure clears costs. Closest: …" line; no-future card with "Use 24 Nov"; stale/loading/error states. It replaces the Best conv/rev and Best box tiles and the 3-line callout.
3. **Cost-cover bar** (`coverRatio` in options.js, tested) on cards, the new Edge column (sortable, `E`) and phone cards.
4. **Cost waterfall visual** in the pane/sheet: floating steps from gross to net with connectors, net bar in pos/neg, ₹/pts toggle, grouped small fees, `waterfallSteps` helper (tested); net hero + cover bar at the top of the detail; phone/tablet sheet reordered so net and waterfall come first.
5. **Heat by strike**: the parity deviation strip (call/put alpha by `devHeat`, green edge dots, ATM pill, legend, hover/tap select, keyboard) and the Dev heat cell; the Boxes List|Matrix toggle with the K1×K2 `bpStep` heat matrix (fixed thresholds, legend, tooltips, select).
6. **Animated updates**: `flashValue` on changed values, `--v` transitions on bars/meters, heat colour transitions, FLIP re-sort, the new-edge bar + pulse, waterfall grow on select, card cross-fade, `dv-shimmer` skeletons; all with reduced-motion fallbacks; ≤ 200 patched elements per tick.
7. **Phone and tablet layouts**: phone 3-row cards with leading bar, cover bar and liq meter; one-row head (lots + Lend|Borrow + Filters); tablet portrait without the side pane (sheet instead), Hold/Opps in the Costs & filters sheet, keyboard hints hidden on coarse pointers, bottom padding clears the tab bar; Futures columns no longer clip.
8. **Rates ladder strip** replacing the six tiles: hurdle contrast line, futures carry, options-implied rate, best lend/borrow box on one %/yr axis with clamped edges, Future and Implied fwd figures beside it.
9. **Liquidity meter** (5 segments, warn for 1–2) replacing the dots everywhere, and **signed Net %/yr** (`bestAnnualSigned`) so the column is never empty.
10. **Futures**: term mini-chart (carry, options-implied, forward segments coloured rich/cheap, hurdle line) and the futures table bars/chips; current expiry as a contrast pill.
11. **Footer and demo cleanup**: risk notes collapsed by default with a one-line teaser (two columns when open on desktop), chart slot 160/120 px beside the notes; drop the "Demo prices:" lead-in (note kept only while demo); no other demo markers on this page (F§7).
12. **Locked payoff mini-chart** and the box calculator's gap-to-touch line in the detail.
13. **Tests and audit**: §10 unit tests, §16 static and Playwright checks at 3 devices × 2 themes × 2 expiries (plus the forced-edge case and reduced motion); read every screenshot before committing.
