# Design spec: Option Chain, round 2 (`#/chain`)

Status: ready to build · Files: `server/bridge/dashboard/desk.js` (toolbar, `drawStats`, `createChain`, `CHAIN_COLUMNS`, `layout()`, `patch()`, `drawSpot()`, `openCustomise()`), `chain-sheet.js`, `app.css` §12b / §12y / §13, `views.js` (`segmented`) · Builds on `docs/prd/01-chain.md` (round 1). Every behaviour that PRD calls "keep" still applies unless this spec changes it.

Reference bar: Sahi Terminal for cleanliness, Sensibull / OptionStrat / thinkorswim for depth. The chain should look like one calm, black, precise instrument. Colour carries meaning, and only there.

Screenshots this spec is based on (dark and light; phone 390×844, tablet 820×1180, desktop 1440×900):
`/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/shots2/chain/`

---

## 1. What is wrong today (specific, from the screenshots)

### 1.1 Chrome and space
1. **Three stacked headers before the first strike.** On desktop, the app toolbar ("Option Chain", "Demo data", clock, search), then the desk bar ("NIFTY", "3 Nov · 5d · W", "Demo paper account", "Paper", "as of 08:52:03", "Live"), then 8 tiles. Together they take 228 px of 900. On a phone they take **345 px of 844**: the desk bar wraps to 3 lines (underlying + expiry, account + Paper, "as of" + a 44 px "Live" button). Only about 5 strikes show on a phone.
2. **The clock appears twice.** The app toolbar shows "08:52:04 IST" and the desk bar shows "as of 08:52:03". "Live" is a third freshness signal.
3. **Demo is repeated.** "Demo data" (toolbar pill), "Demo paper account" (select text), and "Paper" (badge) all say the same thing. The phone toolbar also shows an unlabeled orange dot.
4. **The spot tile is truncated:** "lot 75 · F 26452 (s…". It is also the most important number and it sits in a tile, not in the header.
5. **The account picker is on a read-only surface.** The chain only needs it when an order is placed, and the ticket and sheet already show it.

### 1.2 Cleanliness of the table
6. **Dark canvas is warm charcoal, not black.** `--background: 24 10% 5.5%` and `--card: 26 7% 12%` read as brown-grey. On that background, the ITM wash `hsl(--ios-yellow / 0.085)` turns **muddy olive**, the most visible colour on the page. In light mode it turns cream.
7. **Orange vertical rules beside the strike column** (`--itm-edge`, 2 px orange) run the whole height of the ITM block. They look like a selection or an error. Orange already means caution, max pain, and demo.
8. **Baselines jitter in every row.** Two-line cells (LTP + change, OI chg + %, OI + bar) are centred as a block. One-line cells (Bid, Ask, IV, Volume) are centred alone. The main figures therefore sit at three different heights in one row (see `dark-zoom.png`: "421.50" vs "421.45" vs "14.8").
9. **The first visible row is cut by the sticky header.** "+8.7K" shows half-hidden at the top on every device. The tfoot ("Total / PCR") is below the fold on desktop: `.chain-wrap { max-height: min(70vh, 860px) }` plus the panels above push it off-screen, so the sticky footer is never seen without page scroll.
10. **Horizontal overflow inside the table.** The Seller preset at 1440 px clips the puts' OI column ("10.14…", no "OI" header). Phone "Both" clips the put OI ("56.6K" cut at the edge). Columns are dropped by a fixed list (`PRESET_OPT_X`), not by the width actually available.
11. **The phone tab bar covers the last row.** No bottom padding equals `--tabbar-h`.
12. **The strike column is a different grey slab** (fill-1 over the card) with a hairline on one side only. In light mode the ATM strike is a lavender block and the ±1σ band a second lavender, which are hard to tell apart.

### 1.3 Colour
13. **OI bars are colourless or random.** OI = blue at 55%, the rank-1 wall = orange, rank 2–3 = orange at 50%, Volume = purple, OI chg = 1.5 px green/red hairline. Calls and puts get the **same** colours, so the eye cannot read "call resistance vs put support". Bars are 3–4 px tall at 30–55% alpha, almost invisible on black.
14. **Build-up chips are off-meaning.** LU (long unwinding) is orange, SC (short covering) is blue. The four states have no consistent bullish/bearish logic, and they sit at the outer edge where they are least read.
15. **Selection is low-contrast everywhere.** The segmented thumb is `hsl(26 5% 28%)` on a 9% fill in dark mode (grey on grey) and white on paper in light mode. "±10", "OI", "Calls", "Both" and the Customise "Both" all fail the owner's rule. The Customise preset chip "OI" uses blue text plus a blue ring, a third style.
16. **16Δ / 30Δ target cells** are an unexplained indigo block on a delta value ("0.30", "0.17", "-0.31"), with no label.
17. **Bid/Ask are plain grey text.** Nothing tells the user that Bid = sell here and Ask = buy here until hover.

### 1.4 Motion
18. Bars jump: `scaleX` changes with no transition. The spot divider jumps from strike to strike. Segmented thumbs jump. The LTP flash is a full-cell 0.28 alpha green/red block on black, which is loud.

---

## 2. Colour roles and tokens

`docs/design/foundation.md` did not exist when this was written. The names below are the **roles**. If foundation.md lands with different token names, map role → token 1:1 and keep the values. Define them on `:root`, redefine them in both dark blocks (`@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and `:root[data-theme="dark"]`), and keep the two dark blocks identical.

| Role (proposed token) | Meaning in the chain | Dark (H S L) | Light (H S L) |
|---|---|---|---|
| `--canvas` (page bg) | app background | `0 0% 1.6%` (#040404) | unchanged `36 28% 97%` |
| `--surface` (panel bg, `--mat-grouped-solid`) | chain panel, thead, tfoot | `0 0% 5%` (#0d0d0d) | `0 0% 100%` |
| `--surface-2` (strike column, raised) | strike column, sticky header row 2 | `0 0% 8%` | `30 10% 96.5%` |
| `--hairline` | row rules | `0 0% 100% / 0.07` | `0 0% 0% / 0.07` |
| `--separator` | group rules (strike edges, thead bottom) | `0 0% 100% / 0.12` | `0 0% 0% / 0.12` |
| `--sel-bg` / `--sel-fg` | **selected segment, chip, tab** | `0 0% 98%` / `0 0% 4%` | `0 0% 6%` / `0 0% 100%` |
| `--c-call` | call side: OI bars, side header, legend | `199 92% 58%` (sky) | `201 90% 38%` |
| `--c-put` | put side: OI bars, side header, legend | `266 85% 72%` (violet) | `266 60% 48%` |
| `--c-pos` | gain, OI added, price up | `142 70% 50%` | `142 72% 29%` |
| `--c-neg` | loss, OI cut, price down | `3 92% 63%` | `356 78% 42%` |
| `--c-neutral` | volume bars, empty states, quiet figures | `0 0% 100% / 0.42` | `0 0% 0% / 0.38` |
| `--c-warn` | expiry day, wide spread, IV over the smile, stale | `38 100% 56%` | `30 100% 36%` |
| `--c-atm` | ATM strike, spot divider, ATM pill | `211 100% 60%` | `211 100% 42%` |
| `--c-buy` / `--c-sell` | trade buttons (solid), sheet buttons | `211 100% 50%` / `3 82% 52%` | `211 100% 43%` / `3 82% 47%` |
| `--itm-wash` | in-the-money cells | `0 0% 100% / 0.035` | `36 40% 50% / 0.07` |
| `--em-wash` | ±1σ band on the strike column | `211 100% 60% / 0.07` | `211 100% 42% / 0.06` |
| heat scale `--heat-a(x)` | OI cell-fill mode (§5.3) | side colour at alpha `0.06 + 0.42·x^0.75` | side colour at `0.05 + 0.32·x^0.75` |

Rules:
- Green and red mean change only (price, OI added or cut, P&L). Calls and puts are **never** green or red, so the OI change colour can never be confused with the side.
- Orange (`--c-warn`) is caution only. It is removed from max pain, walls and the ITM edge.
- Text in a role colour uses the ink variant (light-mode values above already hold 4.5:1 on white. Dark values hold 4.5:1 on #0d0d0d).
- Optional classic palette (P2, §9): calls `--c-neg`-hued and puts `--c-pos`-hued for users trained on "call OI = resistance red, put OI = support green". When it is on, OI change uses up/down glyphs (▲ ▼) in neutral ink, not red/green, so meaning stays single.

### 2.1 Selection contrast (applies app-wide, the chain is the first consumer)
`.segmented button[aria-pressed="true"], .tabs button[aria-selected="true"], .chip[aria-pressed="true"], button.preset-chip.on`:
`background: hsl(var(--sel-bg)); color: hsl(var(--sel-fg)); box-shadow: none; font-weight: 650`.
- Track (unselected background): `--mat-fill-1` (dark: white 6%, light: black 5%). Unselected text: foreground at `--a-label`.
- Hover on an unselected segment: text to full foreground, background `--mat-fill-2`. Never a tint of the selection colour.
- `.segmented.custom` (no preset matches): no thumb, every segment unselected. The word "Custom" appears as a quiet suffix chip after the control.
- Focus ring stays `--focus-ring` (blue, 2 px, offset 2 px). It is not the selection colour.
- Customise preset chips, the phone Calls / Puts / Both control, the sheet CE / PE control and the strikes control all use exactly this one style.

---

## 3. Layout per device

### 3.1 The top line (replaces the desk bar and the 8 tiles' spot tile)
One line, 48 px tall on desktop and tablet, 44 px on phone, no wrap. Left to right:

`[NIFTY ▾] [3 Nov · 5d · W ▾] [Expiry today] │ 26 427.40  +7.50 (+0.03%) │ Fut 26 452.3 (+24.9) │ Lot 75 │ ATM IV 13.5% │ ……… ● 08:52:04`

- Underlying and expiry are compact selects (36 px; 44 px on coarse pointers), 15 / 14 px 650.
- Spot: 17 px 700 tabular, change in `--c-pos` / `--c-neg`. The figure ticks with the same flash rule as LTP (§6).
- Fut / F: same-expiry future and its basis, or `F 26 452 (syn)` with the title text. Lot: `Lot 75`. ATM IV: from `sm.atmIv`.
- **Freshness dot + time** at the far right replace "as of", the Live button and the duplicate clock. Dot colours: green = live, `--c-warn` = stale or paused, neutral = market closed, red = error. Click / tap / `p` toggles pause, and the label then reads "Paused 08:52". Title: "Refreshing every 3 s · P to pause".
- **Removed from this line:** account select, "Paper" badge, "Demo paper account". The account picker moves into the order ticket and the action sheet header ("Orders go to: Paper ▾"), which already exist. **Exception (safety):** when the chosen account is a live broker with live orders allowed, a solid red `LIVE orders` pill appears at the right of the line. Paper shows nothing.
- **Demo:** the app toolbar's "Demo data" pill is the one demo marker. The chain shows no other. The phone toolbar's bare orange dot gains its word ("Demo") so it is a readable indicator, not a mystery dot.
- Overflow order at narrow widths (dropped first → last): ATM IV, Lot, Fut/F basis in brackets, Fut/F, spot change absolute (keep %). Underlying, expiry, spot and freshness never drop.
- Phone (390): `[NIFTY ▾] [3 Nov·5d ▾]  26 427.4 +0.03%  ●`. Lot, F and IV move into the KPI strip.

### 3.2 KPI strip (the summary tiles)
- Seven compact tiles, no spot tile (it is in the top line): ATM IV, Expected move, Straddle, PCR, Max pain, Put wall, Call wall. Height 56 px (label 11 px, value 16 px 700, sub 11 px).
- Each tile gets a micro-visual (purpose-built SVG, 64×16, `aria-hidden`):
  - **Expected move:** a range bar from −1σ to +1σ with a tick at spot (`--c-atm`) and at max pain (neutral).
  - **PCR:** a centred diverging bar from 0.5 to 1.5. The fill goes left (`--c-call`) when below 1 and right (`--c-put`) when above 1.
  - **Put wall / Call wall:** the value in `--c-put` / `--c-call` ink, with a sub line "OI 10.22L · 1.1% below spot".
  - **Straddle:** sub "1.30% of spot · BE 26 085 – 26 770".
- Desktop: 7 equal columns in one row. Tablet: one row with horizontal scroll-snap (inner scroll, edge fade mask 16 px). Phone: horizontal scroll strip of tiles 128 px wide, snap-start, plus Lot and F in the first tile's sub line.
- Tiles are patched in place (existing `setTile`). Values never truncate: the sub line truncates with an ellipsis and the full text is in the title.

### 3.3 Chain head (one row)
`[🔍 Strike, +3, 1σ  /] [±10 | ±20 | All] [OI | Buyer | Seller | Hedger | Arb] ……… [⇆ Calls·Puts] [Customise]`
- 40 px tall on desktop (controls 30 px), 52 px on coarse pointers (controls 44 px).
- Phone: `[🔍] [Calls | Puts | Both] [±10 ▾] [⚙]` on one line. The strikes control becomes a compact select-like button that opens a 3-item menu. The Calls / Puts / Both control moves up into this line, which removes the separate second row (saves 52 px).

### 3.4 The table
**Desktop 1440 (sidebar open, about 1120 px of table):** default OI preset, Both sides:
`Build-up | OI | OI chg | Volume | IV | LTP | Bid | Ask ‖ Strike ‖ Bid | Ask | LTP | IV | Volume | OI chg | OI | Build-up`
- Column widths (min): Strike 96; LTP 76; Bid/Ask 64; IV 48; OI 84; OI chg 84; Volume 76; Build-up 40; greeks 56; ₹ columns 76; % columns 56. Padding 0 8 px. Outer cells padding 12 px.
- **Fit engine (replaces the fixed `PRESET_OPT_X` cut):** a `ResizeObserver` on the chain panel computes `avail = panel.clientWidth`. Drop columns, in each preset's drop order, until `Σ min-widths ≤ avail`. The default drop order is the preset's list from the outer edge inwards; LTP and the strike never drop. Each preset declares its order, for example `seller: ["thetaLot","oi","premLot","pops","dist","delta"]`. Dropped columns are listed as a quiet "+2 hidden" chip in the chain head that opens Customise. The layout signature includes the kept-column list, so a resize past a threshold relays out once (debounced 120 ms), never on every pixel. **Result: no inner horizontal scroll at any preset on any device.** Inner scroll only happens if a user hand-picks more columns than fit, and then the strike column stays sticky with 12 px edge shadows.
- **Tablet 820:** at most 5 columns a side. The fit engine decides; with the OI preset that is `OI | OI chg | IV | LTP` + Bid/Ask hidden on coarse pointers.
- **Phone 390, one side (default Calls):** `Strike 84 | LTP 92 | OI chg 96 | OI 96` (= 368 + 2×11 gutters). Swipe left / right switches the side (exists). The side shows as a 3 px top edge on the column header in `--c-call` / `--c-put`.
- **Phone, Both:** `OI 70 | LTP 74 | Strike 74 | LTP 74 | OI 70` = 362. The OI bars are the side colour, so calls and puts read apart at a glance.

**Row anatomy (every device):**
- Row height 40 px desktop (dense 30 px), 48 px coarse pointers. Every cell is a **2-line grid**: line 1 = main figure (13 px 500, tabular, slashed zero) at a fixed top offset of 7 px; line 2 = sub or bar, 10.5 px, in a fixed 12 px slot. One-line cells leave line 2 empty, so every main figure in a row sits on the **same baseline**. Implement as `.cell { display: grid; grid-template-rows: 16px 12px; align-content: center; }`, with `.two` / `.barred` / plain text all placed in row 1.
- Numbers align right on the call side and left on the put side (mirror around the strike). Headers follow their column.
- Row rule: `inset 0 -var(--hl) 0 var(--hairline)`. Group rules either side of the strike column: `--separator`.
- No vertical rules between ordinary columns.

**Strike column:** `--surface-2` fill, 96 px, strike 14 px 700, centred, tags below (§4.4). It is sticky left only when the table scrolls horizontally.

**Header:** two sticky rows. Row 1 (24 px) is the side label: `CALLS` / `PUTS`, 11 px 700 0.08em uppercase in the side's ink, with a 2 px underline in `--c-call` / `--c-put` spanning its column group. Row 2 (28 px) holds the column names (11.5 px 600, `--a-quiet`). The header's bottom has a 10 px gradient fade (`--surface` → transparent) over the first row, so a half-scrolled row never looks cut.

**Footer:** always visible. `.chain-wrap` height = `calc(100dvh - wrapTop - 16px - var(--tabbar-h, 0px) - var(--safe-b))`, computed once on layout and on resize (set from JS as `wrap.style.maxHeight`). Minimum 320 px. `padding-bottom: var(--tabbar-h)` on phones so the tab bar never hides the last row.

### 3.5 Desktop + key legend
The key legend row under the chain (`.desk-keys`) collapses to one line, 28 px, 11.5 px quiet. Hidden on coarse pointers (exists) and hidden when the panel is under 900 px wide.

---

## 4. Every visual: what it encodes, scale, legend

### 4.1 OI bar (column OI)
- Encodes open interest at the strike on that side.
- Scale: `frac = OI / maxOI`, where **maxOI is the largest OI on either side over the loaded rows** (one shared scale, so call and put walls compare honestly). Linear. Width = `frac × 100%` of the cell's inner width.
- Look: 5 px tall, radius 2.5, in **line 2 of the cell**, growing away from the strike (call bars anchor right, put bars anchor left). Fill `--c-call` / `--c-put` at 0.55. Rank-1 wall on that side: alpha 1.0 plus a 1 px outer ring in the side ink. Ranks 2–3: alpha 0.8. Track: `--mat-fill-1` full width.
- With "lots" on, the figure is in lots; the bar is unchanged.
- Legend: the side header underline colour is the legend. The column title text: "Open interest. Bar = share of the largest OI on the chain (both sides). Brightest = OI wall".

### 4.2 OI change bar (column OI chg)
- Encodes signed change in OI today. Scale: `frac = |ΔOI| / max|ΔOI|` over both sides and all loaded rows. Linear.
- Look: 5 px tall in line 2, grows away from the strike. `--c-pos` at 0.85 when ΔOI > 0 (OI added); `--c-neg` at 0.85 when ΔOI < 0 (OI cut). The figure (`+22.6K`) is in the same ink. The % of OI sub line is dropped from line 2 when bars are on and moves into the title (it collided with the bar). With bars off, line 2 shows the %.
- Legend: column title "OI added today (green) or cut (red). Bar = share of the largest change".

### 4.3 Volume bar
- `frac = volume / maxVolume` (both sides). Neutral `--c-neutral`, 3 px. Unusual volume ("hot"): figure 650 in `--c-warn` ink and a 4 px dot before it. The purple colour is removed.

### 4.4 Strike tags (priority ATM > Max pain > Walls > ±1σ > ±2σ; at most 2 per cell, the rest in the title)
| Tag | Look |
|---|---|
| ATM | solid `--c-atm`, white text, 10 px 700 |
| Max Pain | outline `--separator`, foreground `--a-label` text, a 4 px neutral diamond before the text |
| Call wall | outline and text in `--c-call` ink |
| Put wall | outline and text in `--c-put` ink |
| ±1σ / ±2σ | text only in `--c-atm` ink at 0.8 / 0.6, no box |
All tags are 16 px tall, radius 4, padding 0 5 px, gap 3 px. They pop in on first appearance (§6).

### 4.5 ATM row and spot divider
- ATM row: strike cell gets `--c-atm` at 0.12 fill and the strike figure in `--c-atm` ink. The ATM row has no other row-wide tint.
- **Spot divider:** a 1 px `--c-atm` line across the full row between the bracketing strikes, plus a centred pill. Pill: 22 px tall, `--surface` background, 1 px `--c-atm` ring, text `NIFTY 26 427.40  +0.03%  ·  F 26 452.3`. The spot is in the foreground ink at 700 (not blue on blue), the change is in pos/neg ink, and the F text is quiet. Phone: `26 427.4 · +0.03%` only.
- The divider row is 18 px (not a full row) and never pushes the baseline grid out of step (it has no cells, only the line).

### 4.6 ITM shading
`--itm-wash` on ITM cells, a neutral lift. **The orange `--itm-edge` rule is removed.** The ITM/OTM boundary is already shown by the spot divider. Toggle stays in Customise.

### 4.7 ±1σ band
`--em-wash` on the strike column for strikes inside `[F·e^(−σ√T), F·e^(σ√T)]`. A 2 px `--c-atm` at 0.5 left edge on the strike cell marks the band's first and last strike.

### 4.8 Delta target markers (16Δ / 30Δ)
The delta cell keeps its number, and a superscript chip `16Δ` or `30Δ` (9.5 px 700, `--c-atm` ink, no fill) follows it. The indigo block is removed. Selection: on each side, the strike whose |Δ| is nearest 0.16 and the one nearest 0.30.

### 4.9 Build-up chips
| Code | Name | Price | OI | Colour |
|---|---|---|---|---|
| LB | Long build-up | ↑ | ↑ | `--c-pos` fill 0.16, ink text |
| SC | Short covering | ↑ | ↓ | `--c-pos` outline only, ink text |
| SB | Short build-up | ↓ | ↑ | `--c-neg` fill 0.16, ink text |
| LU | Long unwinding | ↓ | ↓ | `--c-neg` outline only, ink text |
Filled = new positions, outline = positions closing. Green = price rising, red = price falling. Chip 26×16, 10 px 700. In the Both layout, Build-up sits **next to OI chg** (not at the outer edge), so the default OI preset order becomes `ltp, iv, vol, bu, chg, oi` (from the strike outwards). A one-line legend sits in the column title.

### 4.10 LTP cell
Line 1: LTP 13 px 600. Line 2: change % in pos/neg ink. Held position badge (`+1` / `−1`) sits to the left of the LTP: long `--c-buy` at 0.16 fill, short `--c-sell` at 0.16 fill, 16 px tall.

### 4.11 Bid / Ask (desktop, fine pointer)
- Bid text in `--c-sell` ink at 0.9 (you sell at the bid); Ask text in `--c-buy` ink at 0.9 (you buy at the ask). Hover or focus: a solid `--c-sell` / `--c-buy` capsule with white text and a 1-letter prefix `S` / `B`. 24 px tall.
- Spread health on line 2 under Ask (only when spread > 5%): `5.2%` in `--c-warn` ink; over 10% in `--c-neg` ink.
- Zero or one-sided quotes: `--` in quiet ink, button disabled.

### 4.12 Focused row
Full-row 1.5 px top and bottom rule in `--c-atm` (exists). The focused side's cells get a `--c-atm` at 0.07 fill. The focused cell itself (keyboard) gets the 2 px focus ring.

---

## 5. Customise panel
- Desktop / tablet: a right-anchored panel 360 px wide, full height of the chain panel. Phone: bottom sheet, max 85 vh, with a drag handle. It opens with a 220 ms slide (§6).
- Sections, top to bottom, each with an 11 px uppercase eyebrow:
  1. **Show:** Calls · Puts · Both (contrast segmented, full width).
  2. **Preset:** chips OI, Buyer, Seller, Hedger, Arb, Greeks, Value. The selected chip uses `--sel-bg` / `--sel-fg` (not a blue ring).
  3. **Columns:** checked list with drag handles (exists). Each row shows its width cost, and the list shows "Fits: 7 of 8 at this width" from the fit engine. Hidden-by-width columns show a quiet "hidden at this width" note instead of disappearing silently.
  4. **Bars:** OI, OI chg, Volume (switches) plus **Bar style:** `Under value` | `Cell fill` (§5.3).
  5. **Display:** % sub-line, Lots, ITM shading, Positions, Compact rows, Bid/Ask (switches, not checkboxes; 44 px rows on touch).
  6. **Tags:** Max pain, Walls, ±1σ band, ±2σ.
  7. **Colours (P2):** Standard (sky / violet) | Classic (red / green).
- A **Reset** button in the header (exists). It resets to OI preset, Both, default bars.
- Changes apply live, with no "Apply" button.

### 5.3 Cell-fill heat mode (P1)
With `Bar style = Cell fill`, the OI and OI chg cells are painted as heat. OI: side colour at alpha `0.06 + 0.42·frac^0.75` (dark) / `0.05 + 0.32·frac^0.75` (light). OI chg: pos/neg colour with the same curve on `|ΔOI| / max|ΔOI|`. The figure stays foreground ink (contrast is checked: the max alpha keeps ≥ 4.5:1 for 13 px text). This is the Sahi / Sensibull "OI heatmap" read.

---

## 6. Motion

| What moves | How | Duration | Easing | Reduced motion |
|---|---|---|---|---|
| OI / OI chg / Volume bars | `transform: scaleX()` transition on the inner span | 420 ms | `--ease-out` | none (instant) |
| Heat fill | `background-color` transition | 420 ms | `--ease-out` | instant |
| LTP and spot tick | text colour flashes to pos/neg ink and a 2 px underline in that colour fades | 700 ms | `--ease-out` | no flash; the line-2 % colour still shows direction |
| LTP cell tint (replaces the loud block) | background from role at **0.14** → transparent | 600 ms | `--ease-out` | none |
| Spot divider moves to a new strike gap | FLIP: measure old top, insert, `translateY(old−new)` → 0 | 280 ms | `--ease-spring` | jump |
| ATM moves | outgoing strike cell fill fades out 160 ms, incoming fades in 200 ms | 160 / 200 ms | linear / `--ease-out` | instant |
| Segmented control | one absolutely positioned thumb element slides to the selected button (`transform: translateX`, width transition) | 240 ms | `--ease-spring` | instant |
| Tags appear (wall shifts, max pain moves) | `scale(0.8)` + opacity 0 → 1 | 160 ms | `--ease-out` | instant |
| Strike jump (`/` search, Open in chain) | the existing blue tint fade, now `--c-atm` at 0.18 | 600 ms | `--ease-out` | none |
| Rows appear on window change (±10 → ±20) | new rows opacity 0 → 1 | 180 ms, stagger 8 ms per row, max 120 ms total | `--ease-out` | instant |
| Customise panel / action sheet | translateX(16 px) / translateY(100%) + fade | 220 / 260 ms | `--ease-out` / `--ease-spring` | fade only, 120 ms |
| Back-to-ATM pill | fade + translateY(6 px) | 160 ms | `--ease-out` | instant |
| Freshness dot (live) | soft pulse every 3 s on each successful refresh, not a continuous loop | 600 ms | `--ease-out` | static dot |

Performance rules: only `transform`, `opacity`, `background-color` and `color` animate. No layout-affecting transitions. All bar writes go through the existing `__sig` patch, so an unchanged value starts no transition. A patch tick stays ≤ 8 ms (PRD 01 §1.4).

---

## 7. Interactions
- **Row click (fine pointer):** focus the row and side (exists). **Double-click / Enter:** open the action sheet panel (exists).
- **Row hover (fine pointer):** a 2-button cluster appears at the outer edge of the hovered side's LTP cell: `B` (`--c-buy`) and `S` (`--c-sell`), 22 px round. B opens the ticket at the ask, S at the bid. Shift+click adds a leg to the builder (same as `B`/`S` keys). The cluster is keyboard-reachable through the existing Bid/Ask buttons, so it is `aria-hidden`.
- **Touch:** tap row → action sheet (exists). Long-press (500 ms) → add the row's tapped side to the builder basket, with a haptic-style 120 ms scale pulse on the row and an undo toast.
- **Action sheet (chain-sheet.js):** header line 1 = contract name + `CE | PE` contrast segmented; line 2 = LTP and change, plus **"Orders go to: Paper ▾"** (the account picker lives here now). Buttons: `Buy 546.70` solid `--c-buy`, `Sell 546.60` solid `--c-sell` (replaces pink). The metric grid gets 3 groups with eyebrows: **Price** (Bid, Ask, Spread, IV, IV−ATM), **Greeks** (Delta, Gamma, θ/lot, Vega), **Odds and size** (Breakeven, PoP buy, P(ITM), Prem/lot, Lot), **OI** (OI with a mini bar, OI chg pos/neg, Volume, Build-up chip). The "Chart" button is a disabled "Chart engine slot" placeholder until the engine ships.
- **Side headers:** click `‹ CALLS` / `PUTS ›` to show one side (exists). Keys `c` / `v` (exist).
- **Strike search:** `/`, Enter, Esc (exists). Invalid input: `aria-invalid` plus a 1 px `--c-neg` ring and a 1-line hint below ("Try 26400, +3, 1σ, atm, mp").
- **Back to ATM pill:** `--sel-bg` / `--sel-fg` contrast pill (not blue), bottom-centre, above the sticky footer.
- Touch targets: 44 px on `(pointer: coarse)` for every control (exists §12y); rows 48 px.

---

## 8. Empty, loading, error, stale
- **Loading (first load or expiry change):** skeleton matching the real layout: the strike column with 12 grey 40 px rows, bar placeholders in line 2, header and footer drawn. Shimmer: a 1.2 s linear gradient sweep at white 4% (dark) / black 4% (light); none under reduced motion. The top line shows the underlying and expiry instantly and `--` for spot.
- **Refreshing:** no spinner. The freshness dot pulses once on success.
- **Stale (no update for > 3 refreshes):** the table stays, at opacity 0.72. The freshness dot turns `--c-warn`, the label reads "Stale · 14 s", and a thin `--c-warn` bar (2 px) appears at the top of the chain panel.
- **Error with a last good chain:** the same as stale, plus a one-line note under the chain head: "Couldn't refresh: <reason> · Retry", with Retry as a text button. Dot red.
- **Error with no data:** the existing `errorState` card in the chain area, with Retry.
- **Market closed:** dot neutral, label "Closed · 15:30". Refresh drops to 30 s (exists). No warning colour.
- **No expiries / no strikes:** the existing `emptyState`, with "Pick another underlying" as the action.
- **One-sided or missing quote cells:** `--` in quiet ink. Bars are absent (no zero-width track noise).
- **Strike search miss:** see §7.

---

## 9. Feature gaps, prioritised (with behaviour and formulas)

| P | Feature | Behaviour | Formula / data |
|---|---|---|---|
| P0 | Fit engine | §3.4. No inner horizontal scroll at any preset. "+N hidden" chip | Σ min-width per kept column ≤ panel width |
| P0 | Coloured OI / OI chg bars, shared scale | §4.1–4.2 | frac = OI / max(OI over both sides); |ΔOI| / max|ΔOI| |
| P0 | Contrast selection | §2.1, app-wide | `--sel-bg` / `--sel-fg` |
| P1 | Cell-fill heat mode | §5.3 | alpha = 0.06 + 0.42·frac^0.75 |
| P1 | Strike PCR and straddle columns (row scope) | New `pcrK` "PCR" = PE OI ÷ CE OI at the strike (2 dp; > 1.2 in `--c-put` ink, < 0.8 in `--c-call` ink). New `strad` "Straddle" = mid(CE) + mid(PE), sub = % of spot. Both available in Customise; `pcrK` joins the OI preset on desktop when it fits | as stated |
| P1 | Multi-select to builder | `m` key or a "Select" toggle in the chain head shows a checkbox in each LTP cell; the selection bar at the bottom shows "3 legs · Net ₹−4 120 · Open in builder". Uses the existing basket (`addLeg`) | net = Σ side·mid·lot |
| P1 | Expiry strip | Under the top line on desktop / tablet: chips for the next 6 expiries `3 Nov 5d`, `10 Nov 12d`, `27 Nov 29d M`, selected chip in contrast. Phone: stays a select | DTE from `O.timeToExpiry` |
| P1 | OI-change window | Segmented `Day | 1h | 15m` in the chain head (OI preset only), from the OI store snapshots (`oi-store.js`). When fewer than 2 snapshots exist for the window, the segment is disabled with the title "Collecting: 3 of 4 snapshots" | ΔOI_w = OI_now − OI at the snapshot nearest now − w |
| P2 | Hover mini-card (fine pointer, 400 ms hover on LTP) | Floating 220 px card: Δ, Γ, θ/lot, Vega, PoP buy, BE and the % move needed | same formulas as `sheetMetrics` |
| P2 | Classic colour palette | §2, Customise → Colours | — |
| P2 | Column sort by OI / OI chg / Volume (desktop) | Click a header in those columns: a ranked "Top 10" overlay list (not a table re-sort, which would break the strike ladder); click a row to jump | rank by value on that side |
| P3 | IV smile sparkline in the ATM IV tile | 64×16 SVG of IV by strike, ATM dot | `row.ce.iv` / `row.pe.iv` (OTM side per strike) |

---

## 10. Acceptance checks (screenshots, 6 device-theme combinations)
1. Dark canvas samples at ≤ #0a0a0a; the chain panel at #0d0d0d ± 2.
2. Every selected segment: dark = white bg / black text, light = black bg / white text (computed style check on `[aria-pressed=true]`).
3. No `scrollWidth > clientWidth` on `.chain-wrap` for every toolbar preset at 390, 820, 1440 (sidebar open) and 1024.
4. tfoot visible without page scroll at 1440×900 and 820×1180. The last row is not under the phone tab bar.
5. Call OI bars computed colour = `--c-call`, put = `--c-put`; OI chg bars are green for +, red for −.
6. In any row, the main figures' `getBoundingClientRect().top` values differ by ≤ 1 px.
7. Phone: ≥ 9 strike rows visible on first paint at 390×844 (today: 5).
8. One demo marker on the page (the app toolbar pill). No "Demo paper account", no "Paper" badge, one clock.
9. Reduced motion: no running animations on a refresh (`document.getAnimations().length === 0` after a tick).
10. A patch tick ≤ 8 ms with 81 strikes, widest preset (exists in round 1).

---

## 11. MUST-DO list (ordered by value)
1. Deep-black dark theme for the chain: `--canvas` #040404, `--surface` #0d0d0d, `--surface-2` 8% for the strike column, neutral hairlines. Replace the yellow ITM wash with the neutral `--itm-wash`, and remove the orange `--itm-edge` rules.
2. Contrast selection on every segmented control, tab, preset chip and pill (`--sel-bg` / `--sel-fg`: white/black in dark, black/white in light). Same style in Customise, the phone side switch, the sheet CE/PE and the ATM pill.
3. Compact the top into one line: underlying, expiry, spot + change, Fut/F + basis, lot, ATM IV, freshness dot + time (tap = pause). Remove the account select, the "Paper" badge, the duplicate clock and the Live button from the chain. The account picker moves to the ticket/sheet. A red "LIVE orders" pill shows only for a live account. Phone header ≤ 44 px.
4. One demo marker only (the app toolbar pill, with the word "Demo" on phones). Remove the demo account wording from the chain.
5. Call/put colour roles: OI bars in `--c-call` (sky) / `--c-put` (violet) on one shared scale, 5 px, walls at full alpha with a ring. OI chg bars and figures in `--c-pos` / `--c-neg`. Volume bars neutral. Side headers underlined in the side colour.
6. Fit engine (ResizeObserver plus per-preset drop order) so no preset ever scrolls horizontally inside the chain on phone, tablet or desktop, with a "+N hidden" chip.
7. Baseline grid: every cell is a 2-row grid (16 + 12 px), so main figures align across a row. Row 40 px (48 px touch, 30 px dense).
8. Wrap height from the viewport so the sticky footer (totals + PCR) is always visible; phone bottom padding = tab bar height; a 10 px fade under the sticky header instead of a cut row.
9. Spot divider and ATM: a 1 px `--c-atm` line plus a neutral pill (spot in foreground ink, change in pos/neg); the ATM strike in `--c-atm` ink with a 12% fill; ±1σ band in `--em-wash`; tags restyled (ATM solid, walls in side colour, max pain neutral, σ text-only).
10. Motion: bar `scaleX` transitions (420 ms), a calmer LTP flash (0.14 alpha, 600 ms), FLIP spot-divider move (280 ms spring), a sliding segmented thumb (240 ms), tag pop-in, row fade on window change. All off under reduced motion.
11. Build-up chips recoloured by meaning (LB / SB filled green / red; SC / LU outlined green / red) and moved next to OI chg; delta targets shown as a `16Δ` / `30Δ` superscript instead of the indigo block.
12. Bid/Ask: sell-ink bid, buy-ink ask, solid capsule with an S/B prefix on hover; spread warning on line 2; a hover B/S cluster on the LTP cell.
13. Phone chain: one head row (search, Calls/Puts/Both, strikes menu, gear); Calls shows Strike | LTP | OI chg | OI; Both shows OI | LTP | Strike | LTP | OI fitting 362 px; ≥ 9 rows visible.
14. KPI strip: 7 tiles (spot moved to the top line), 56 px, micro-visuals for expected move and PCR, wall values in side colours, no truncated values; snap-scroll strip on phone and tablet.
15. Customise panel restructure: sections, switches, contrast preset chips, "fits N of M" from the fit engine, and the Bar style option.
16. Action sheet: Buy/Sell solid `--c-buy` / `--c-sell`, grouped metrics, account picker in its header, "Chart engine slot" placeholder.
17. States: layout-matched skeleton with shimmer, stale (dimmed table, warn dot, 2 px top bar), error with last good, closed.
18. P1 features: cell-fill heat mode, strike PCR and straddle columns, multi-select to builder, expiry chip strip, OI-change window (Day / 1h / 15m from the OI store).
