# Design spec: OI Analysis, round 2 (`#/oi`)

Status: ready to build · Files: `server/bridge/dashboard/oi.js` (page, ladder, blocks), `oi-store.js` (snapshot recorder, read-only changes), `app.css` (the `.oi-*` / `table.oi-ladder` block, about lines 1877–2128), shared helpers from `viz.js` / `motion.js` / `options.js` as defined in `docs/design/foundation.md` · Builds on `docs/prd/03-oi.md` (round 1). Every PRD 03 behaviour still applies unless this spec changes it.

Reference bar: Sahi Terminal for calm and clean; Sensibull, Opstra and thinkorswim for depth. The OI page has to answer three questions in under two seconds: **where are the walls, which side is adding, and where is spot inside that range.** Colour is how the eye finds those answers. Today the page has none.

Colour tokens: every colour below is a token from `docs/design/foundation.md` §3–§4 (`--dv-call`, `--dv-put`, `--pos`, `--neg`, `--warn`, `--dv-spot`, `--dv-iv`, `--dv-band`, `--dv-grid`, `--dv-axis`, `--seq-*`, `--div-*`, `--sel-bg/--sel-fg`, `--mat-*`). Where this spec says "call", "put", "pos", "neg", it means those tokens. **Do not add new colours on this page.** The round-1 chain spec's `--c-call` (sky) and `--c-put` (violet) are superseded by the foundation's blue/orange pair.

Screenshots this spec is based on (dark and light; phone 390×844, tablet 820×1180, desktop 1440×900, plus "OI chg" metric and the detail row):
`/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/shots2/oi/` (script `scratchpad/oi-r2.cjs`). No shot scrolls sideways.

---

## 1. What is wrong today (specific, from the screenshots and the code)

### 1.1 Colour: there is none
1. **Every OI bar is grey.** `table.oi-ladder .now` is `hsl(var(--foreground) / 0.2)` on both sides (computed `rgba(247,245,243,0.2)` in dark, `rgba(11,10,9,0.2)` in light). Calls and puts look the same. The rank-1 wall is only `0.36` grey, and that is barely visible (`desktop-dark.png`, the 26500 row).
2. **OI added and OI removed look the same.** In the "OI chg" metric, additions are grey solid and removals are grey hatched at 0.2 (`desktop-dark-chg.png`). On black the hatching reads as dirt, not as "unwinding".
3. **The OI chg figures are not coloured.** "+108", "−61", "+1.5K" and "−736" are all plain foreground in both Δ columns, the Walls Δ column, Movers and the tile sub-lines. The eye cannot scan for the red rows.
4. **Build-up tags (LB/SB/SC/LU/CH) are grey outlined boxes** of 8.5 px. They are unreadable on a phone and carry no direction.
5. **The ref "mark"** (a 1.5 px fg/0.55 tick at the window-start OI) appears at the end of almost every bar. It looks like a rendering glitch, because nothing explains it (there is no legend).
6. **ATM uses a blue tint and blue strike text** (`--ios-blue`). Once calls are blue (foundation §4.1), this reads as "call". The spot line, spot pill, ±1σ edge, held badge and "Filter" link are also blue: five different meanings for one hue.
7. **Max pain tag (MP)** is orange-outlined. Orange is the put colour from now on.
8. **Build-up matrix**: the dominant cell is `--mat-fill-2` grey. "SB dominant → capping" is text only. The direction ("↔ Writers on both sides") has no colour or meter.
9. **Walls** are two plain mini tables. Share (16 %, 13 %, 10 %) and strength are numbers with no bar. "fresh" and "unwinding" are grey words.
10. **Movers** have no bars and no side colour. "26500 CE +1.5K (+11 %)" and "26400 PE −736 (−5 %)" look the same weight.
11. **PCR** is a bare number with a white ▼. Nothing shows where 1.05 sits between call-heavy and put-heavy, or which way it moved.
12. **Light theme**: grey bars at 0.2 alpha on white make the ladder look empty (`desktop-light.png`).

### 1.2 Space and repetition
1. **Three bands before the data** (same as every Options page): toolbar with "Demo data" pill and IST clock, the `.desk-top` band (NIFTY ▾, expiry ▾, "as of 09:02:58", "Live"), then the verdict + tiles panel. On desktop the first ladder row starts at y≈299. On phone it starts at y≈735, below the fold: a phone user sees **no OI bar at all** on the first screen (`phone-dark.png`).
2. **Spot is shown three times**: the Spot tile, the spot pill in the ladder and (after the foundation work) the toolbar. **The window is shown three times**: the Window tile ("Prev close / vs previous close"), the window capsule and the Build-up/Walls/Movers sub-heads.
3. **"Demo data" repeats**: the toolbar pill and the timeline coverage line ("Demo data: snapshots recorded off-hours…", `oi.js` `coverage()`).
4. **Tablet**: the summary panel has an empty 70 px movable-panel header row (only the `:::` drag handle and the expand icon) above the verdict (`tablet-dark.png`).
5. **Phone**: the verdict wraps to 3 lines, and the 6 tiles take 2×3 cells (≈480 px). The controls take 2 rows of 44 px. The ladder is limited to `60vh` *inside* a scrolling page, and the floating tab bar covers its bottom 2 rows (`tablet-dark.png`, `phone-light-full.png`), so the page has two nested scrolls.

### 1.3 Cleanliness and small defects
1. **Row heights jump**: the row under the spot line gets `padding-top: 14px` for the spot pill (`th.k[data-spot]`). That row is 42 px instead of 40, and the pill sits on top of the strike text ("Spot 26417.35" above "26450", touching the MP/R2 tags).
2. **The first visible row is clipped** under the sticky head at load ("−16 / 25950" cut in half), because `centre()` uses `offsetTop` without the head height.
3. **"OI chg" metric repeats the numbers**: the outer Δ column and the bar cell both show ΔOI, so the bars carry no new information, and the OI itself disappears (`desktop-dark-chg.png`).
4. **Selection** is a 1.5 px blue line above and below the row. Foundation §3.3 says the row gets a fill plus a leading `--sel-bg` bar.
5. **Header text** "Calls OI (lots)" / "Puts OI (lots)" is 11.5 px quiet grey. The side is not marked in its colour, and no legend explains bar, ghost, tick, hatch, MP, R1/S1, ±1σ or the held badge.
6. **Tag pile-ups in the strike cell**: "−1σ +1L", "MP R2", "R3 −1L" at 8.5 px under a 13.5 px strike. On phone the third tag is hidden by CSS with no hint that it exists.
7. **Max pain curve** (`O.maxPainCurve().curve`) is computed on every draw and never shown.
8. **Expiries** table is mostly "Not included / -- -- --" rows. The include checkbox is the native blue `accent-color`.
9. **The timeline slot** is 240 px of hatched placeholder with "1 point ready". It is the biggest element on the page and carries the least information.
10. **Keys legend** wraps to two lines at 1440 ("? how to read" alone on the second line).

---

## 2. Design principles for this page

1. **Side = hue, change = green/red, everything else = neutral.** Calls are always `--dv-call` (blue) and puts always `--dv-put` (orange), on every bar, chip, header and legend. OI added is `--pos` and OI cut is `--neg`, on every Δ figure and change mark. Spot and ATM use the contrast colour (`--dv-spot`, `--sel-*`). The expected move uses violet (`--dv-iv` / `--dv-band`), because it is derived from IV.
2. **Never colour alone.** Calls are left and puts right (ladder), or calls first in each pair (chart). Cuts are also hatched. Δ figures carry a sign. Build-up keeps its letters. Each tone pill has a glyph (▲ ▼ ↔).
3. **One shared scale per visual.** Call and put bars share one max, so walls compare honestly (PRD 03 §6.3 rule kept).
4. **Show each fact once.** Spot lives in the toolbar and on the chart/ladder spot line, not in a tile. The window lives in the window capsule and in one sub-head per panel, not in a tile.
5. **The first screen on every device shows coloured bars.**

---

## 3. Information architecture (new order)

| # | Panel | Contents | Change |
|---|---|---|---|
| 0 | Toolbar (foundation §5) | U ▾ · Exp ▾ · spot ±chg · lot · live control · the one demo dot | replaces `.desk-top` |
| 1 | `oi-summary` | **Verdict row** (tone pill + one line) and **6 tiles with micro-visuals**: PCR OI, PCR OI chg, PCR Vol, Max Pain, Call wall, Put wall | Spot and Window tiles removed |
| 2 | `oi-main` | Panel head (title, coverage, controls) · **legend row** · **OI profile chart** (new SVG) · **OI ladder** · side column: **Walls**, **Build-up**, **Movers**, **Max pain curve** (new) | |
| 3 | `oi-expiries` | per-expiry rows with a **CE/PE split bar** | |
| 4 | `oi-timeline` | chart-engine slot (smaller until data exists) + **"Show as table"** of snapshots | |

---

## 4. Layout per device

Spacing follows foundation §8: 4 px grid, panel padding 12, panel gap 12, radius 16. Row heights: ladder 36 desktop (fine pointer), 44 coarse.

### 4.1 Desktop 1440×900 (content ≈1120 px with sidebar open)
```
[toolbar 52: OI Analysis │ NIFTY ▾ │ 3 Nov · 5d · W ▾ │ 26417.35 +1.85 │ Lot 75 ······ ● 09:02:58  ● Demo  ⌕]
┌ oi-summary ───────────────────────────────────────────────────────────────────────────────┐
│ [↔ Range 26400–26500] Writers on both sides · PCR 1.05 balanced · Max Pain 26450   (36 px) │
│ PCR OI ▮▮gauge │ PCR OI chg ▮split │ PCR Vol │ Max Pain │ Call wall ▮ │ Put wall ▮  (72 px)   │
└───────────────────────────────────────────────────────────────────────────────────────────┘
┌ oi-main ───────────────────────────────────────────────────────────────────────────────────┐
│ OI by strike  61 strikes · 24900–27900 · lots     [Prev close|5m|15m|30m|1h|Since open]      │
│                                                   [OI|OI chg|Volume] [±10▾] [Lots|Qty] [?]   │
│ legend: ■ Calls (CE) ■ Puts (PE) ▬ added ▨ cut ┆ window start │ Spot ◆ Max pain ▒ ±1σ        │
│ ┌ OI profile chart (full width, 200 px) ─────────────────────────────────────────────────┐  │
│ └────────────────────────────────────────────────────────────────────────────────────────┘  │
│ ┌ ladder 7fr (fills to 100dvh − 120) ─────────┐ ┌ side 5fr (min 340) ───────────────────┐  │
│ │ Δ │ Calls OI ◀━━│Strike│━━▶ Puts OI │ Δ    │ │ Walls · Build-up · Movers · Max pain  │  │
│ └──────────────────────────────────────────────┘ └──────────────────────────────────────┘  │
│ keys row (one line, 28 px; hidden < 1280 and on coarse pointers)                            │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
┌ oi-expiries 6fr ─────────────────┐ ┌ oi-timeline 6fr ──────────────────────────┐   (≥1280)
```
- The summary is 108 px tall (was 129 + the 58 px `.desk-top`). The OI profile chart starts at y≈250 and the first ladder row at y≈480. The chart is coloured and visible above the fold.
- Controls: one row when the head is ≥ 1080 px wide, otherwise two right-aligned rows. Window capsule first, then Metric, Band select, Unit, `?`. "Back to ATM" appears inside the ladder (§6.6), not in the head.
- Below 1280: Expiries and Timeline stack at full width.

### 4.2 Tablet 820×1180 (portrait; landscape 1180 uses desktop rules)
- The summary panel has **no movable-panel chrome row**: set `data-panel-fixed` (or the views.js equivalent) on `oi-summary` so the `:::` / expand header is not rendered. That saves 70 px.
- Verdict 1 line (ellipsis, full text in `title`). Tiles 3×2, 64 px each.
- Head: title row, then one controls row (window capsule scrolls sideways inside a 16 px edge-fade mask if needed; Metric; Band; Unit; `?`).
- OI profile chart full width, 200 px.
- Ladder full width. Height `calc(100dvh - 52px - var(--tabbar-h, 72px) - 64px)` with its own scroll. Page scroll stops at the ladder's top through `scroll-snap`-free sticky behaviour: the head (controls) is `position: sticky; top: 52px` while the ladder is on screen.
- Side blocks under the ladder in a 2-column grid: Walls | Build-up, then Movers | Max pain.
- Bottom padding of the page = tab-bar height + 16 px, so the floating tab bar never covers ladder rows (today it covers 2).

### 4.3 Phone 390×844 (content 358 px)
- Toolbar per foundation §5.2 (two-line U▾ / Exp▾, dot live control, ⋯).
- **Verdict**: tone pill + text, clamp **2** lines, 13 px.
- **Tiles**: one horizontally scrolling row, tiles 132×64, scroll-snap, 16 px edge fade. Order: PCR OI, Call wall, Put wall, Max Pain, PCR OI chg, PCR Vol (the walls come right after PCR because they are what a phone user checks).
- **Controls: one row, 44 px**: `[Prev close ▾]` (native select, flexible) · `[OI | Δ | Vol]` capsule (labels shortened) · `[⚙]` 44×44. ⚙ opens a `sheetPopover` with Band (capsule ±10/±20/±30/All), Unit (Lots/Qty), Scope (This expiry / Combined), "Expiries…" (scrolls to the panel) and "How to read". Today's second 44 px row is gone.
- **OI profile chart**: 160 px, ±10 band only (21 strikes; 42 bars of ≥5 px). In ±20/±30/All the chart keeps ±10 around ATM and says "±10 shown" in its caption. The ladder shows the full band.
- **Ladder**: `max-height: calc(100dvh - 52px - env(safe-area-inset-top) - var(--tabbar-h) - 52px)`. When it is in view, the controls row is sticky above it. First screen (y≤844): toolbar 52 + verdict 56 + tiles 76 + controls 52 + chart 176 ≈ 412. The ladder head then starts at y≈420, so about 9 coloured ladder rows are visible on the first screen (today: none).
- Columns (358 px): `Δ 62 | Calls bar 87 | Strike 60 | Puts bar 87 | Δ 62`. The OI value sits **inside the track, on the strike side of the bar's far end** (§6.3), so no separate value column is needed.
- Side blocks stack: Walls, Build-up, Movers (Adds/Unwinds capsule), Max pain. Expiries as cards (exists). Timeline slot 120 px plus a table.

---

## 5. Summary panel

### 5.1 Verdict row (36 px desktop)
- `[tone pill] verdict text · "Context, not advice."` on one line (ellipsis; full text in `title`).
- **Tone pill** from `bu.tone`: `up` = "▲ Bullish tilt", `--pos-ink` on a `--pos` 12/16 % tint; `down` = "▼ Bearish tilt", `--neg-ink` on a tint; `range` = "↔ Range 26400–26500", `--foreground` text with a 1 px `--mat-separator` outline (no fill: a range is neutral); `mixed` = "· Mixed", `--neutral-ink` with an outline. 600 12.5 px, radius 999, padding 2 8, height 22.
- The verdict text drops the range (now in the pill): `O.oiVerdict(...)` output minus its leading "Range a–b · " when the tone is range. This is a string trim in `oi.js`, so `options.js` is not touched.
- Weight 600 14 px fg. The tail "Context, not advice." is 450 `--a-quiet`.

### 5.2 Tiles (6; values patched in place, never rebuilt)
Each tile: label 11.5 px `--a-quiet`, value 650 17 px tabular, a **micro-visual** of 6 px height and full tile width (8 px top margin), then a sub-line of 11.5 px `--a-label`, one line, ellipsis. Height 72 desktop, 64 tablet/phone (on phone the sub-line is hidden, it is in `title`).

| Tile | Value (colour) | Micro-visual | Sub-line |
|---|---|---|---|
| **PCR OI** | `pcrChain.oi`, 2 dp. Coloured by `O.pcrBand`: put-heavy and very put-heavy `--pos-ink`, call-heavy and very call-heavy `--neg-ink`, balanced fg. The trend arrow ▲/▼ (exists) takes the same ink as the direction of the move (PCR up = `--pos-ink`). | **PCR gauge** (§7.3) | `±10 1.05 · Vol 1.04 · balanced` |
| **PCR OI chg** | the ratio (2 dp), or the `PCR_CHANGE_TEXT` short form ("Puts added, calls cut"). Ratio coloured as PCR OI. | **ΔOI split** (§7.4): PE ΔOI vs CE ΔOI | `PE +1.4K · CE +2.6K` with each figure in `--pos-ink`/`--neg-ink` by its sign |
| **PCR Vol** | ratio, fg | **Volume split**: ΣPE vol vs ΣCE vol, the same component as the ΔOI split (no sign) | `Prev close window` (+ " · expiry-day noise") |
| **Max Pain** | strike, fg. With `mp.edge`, a `--warn` dot before it and the warn sub-line (exists). | **Distance bar**: a 6 px track = ±2 % of spot; a 2 px `--dv-spot` tick at the centre (spot) and an 8 px ◆ in fg at `(mp − spot) / spot` | `+33 (+0.12 %) · medium relevance` |
| **Call wall** | R1 strike in `--dv-call-ink` | **Wall share bar**: R1's share of all call OI in the band, bar in `--dv-call`, track `--mat-fill-2`; a 2 px `--pos`/`--neg` tick on the end if fresh/unwinding | `15.0K · +83 · 0.2σ · ▲ fresh`; fresh `--pos-ink`, unwinding `--neg-ink`, steady quiet |
| **Put wall** | S1 strike in `--dv-put-ink` | the same with `--dv-put` | the same |

- Clicking or tapping the Call wall / Put wall / Max Pain tile selects that strike in the ladder and scrolls it into view (§9). The cursor is a pointer, and each of these tiles is a `button` with an aria-label ("Show call wall 26500 in the ladder").
- Removed: the **Spot** tile (spot is in the toolbar and on the ladder/chart spot line; ATM moves to the ladder) and the **Window** tile (the window capsule shows it; coverage moves to the panel head sub-text, §6.1).

---

## 6. OI by strike panel

### 6.1 Head
- Title "OI by strike" 650 15 px. Coverage after it in 12 px `--a-quiet`: `61 strikes · 24900–27900 · lots · vs Prev close`. When the window is a snapshot it reads `vs 09:15 (14 snaps)`; while warming up, `Recording · 3 snaps since 09:15`. This takes over the Window tile's job.
- Controls use the foundation contrast capsule (`--sel-bg`/`--sel-fg` thumb with slide). An unavailable window (`aria-disabled`) is 0.38 opacity with a `not-allowed` cursor; its reason is the `title`, and a tap shows it as a toast (exists).

### 6.2 Legend row (new, `viz.legend`)
Height 28, 12 px, swatches 10×10 radius 2. Desktop/tablet show it on one line. On phone it collapses to "■ CE ■ PE ▬ added ▨ cut", and a `ⓘ` 44×44 button opens the full legend in a popover.

`■ Calls (CE)` `--dv-call` · `■ Puts (PE)` `--dv-put` · `▬ OI added` `--pos` · `▨ OI cut` (`--neg` hatch) · `┆ At window start` (1 px dashed fg/0.6) · `│ Spot` `--dv-spot` · `◆ Max pain` fg · `▒ ±1σ move` `--dv-band` · `R1 S1 walls`.

In the "Volume" metric the legend drops added/cut/window start. In "OI chg" it drops window start.

### 6.3 OI profile chart (new; purpose-built SVG, `oi.js` `createProfile()`)
What it is: Sensibull-style grouped vertical bars, one pair per strike: **call bar first (left, `--dv-call`), put bar second (right, `--dv-put`)**. It is the at-a-glance view, and the ladder is the numbers. It is **not** a price/time chart, so it does not wait for the chart engine.

- **Domain**: the strikes in the band (on phone, ±10 around ATM at most; on desktop, up to 41 strikes; with "All", the ±20 around ATM are shown and the caption says so).
- **Geometry**: `slot = plotW / n`; bar width `bw = clamp(3, slot × 0.36, 14)`; 1 px gap inside a pair. Plot padding: left 40 (y ticks), right 8, top 18 (wall labels), bottom 22 (strike ticks). Height 200 desktop/tablet, 160 phone.
- **Metric OI** (the default):
  - y from 0 to `niceTicks(0, max(all OI, all oiRef in the domain), 4)`, with horizontal grid lines at `--dv-grid` and tick labels at `--dv-axis` 10.5 px (`formatCompact`).
  - Bar height = OI. Fill: the side colour at 0.85; rank-1 walls (R1, S1) at 1.0 with a 1 px fg/0.5 top edge.
  - **Window start**: a 1 px dashed (3 2) fg/0.6 horizontal tick of width `bw + 4`, at `oiRef`.
  - **Cut since then**: when `oiRef > oi`, the segment from `oi` to `oiRef` is a hatched rect (`#dv-hatch-call` / `#dv-hatch-put`, foundation §4.2), so lost OI is visible as a ghost.
  - **Added since then**: when `oi > oiRef`, a 2 px `--pos` cap on the top of the bar.
- **Metric OI chg**:
  - y diverging over `±niceTicks(max |d|)`, zero line fg/0.35.
  - Bars go up for additions and down for cuts, keeping the **side colour** (the pair still reads CE/PE). Cut bars are hatched with a 1 px side-colour outline.
  - The tooltip and ladder carry the green/red figures.
- **Metric Volume**: like OI, with fill at 0.55 and no ref or cut marks.
- **Overlays** (drawn in this order, under the bars except the labels):
  1. **±1σ band**: a `--dv-band` rect from `em.lo` to `em.hi` (slot edges), full plot height, with the label "±1σ" 10.5 px `--dv-iv-ink` at its top-left.
  2. **Spot**: a 1 px `--dv-spot` vertical line at the interpolated x between the two strikes around spot: `x = xOf(k_i) + (spot − k_i) / (k_{i+1} − k_i) × slot`. A contrast pill (foundation §4.5) at the top reads "26417.35".
  3. **ATM tick label**: the strike label at the bottom is a contrast pill.
  4. **Max pain**: a ◆ 8 px fg marker on the x axis under the MP strike, with label "MP" 10 px 650 fg.
  5. **Wall labels**: "R1" / "R2" / "R3" above the call bar in `--dv-call-ink`, and "S1"… above the put bar in `--dv-put-ink`, 10 px 700. Labels run through `placeLabels` (options.js) so they do not overlap.
  6. **Held badge**: a 4 px fg dot under the strike tick when the user holds that strike (title gives lots).
- **Strike ticks**: every k-th strike, where `k = ceil(48 / slot)`, so labels are ≥ 48 px apart. Always label ATM, R1 and S1, and drop neighbours that collide.
- **Hover / scrub** (`viz.scrubber`): a column highlight `fg / 0.06` over the slot, plus a tooltip on `--surface-raised`:
  ```
  26500  ·  R1  ·  MP
  CE  OI 15.0K   Δ +1.5K (+11.1 %)  SB
  PE  OI  9.2K   Δ −63  (−0.7 %)    CH
  PCR 0.61
  ```
  CE/PE labels are in side ink, Δ in pos/neg ink, and build-up tags are coloured as in §6.5. ← → move one strike, Shift moves 5. Click/tap pins the tooltip and **selects the same strike in the ladder** (scrolls it into view). Esc unpins.
- **Text alternative**: `role="img"`, aria-label "OI by strike, ±10 around 26400. Largest call OI 26500 (15.0K lots), largest put OI 26400 (13.7K lots). Spot 26417.35." Below it, a "Show as table" disclosure toggles the ladder into focus. The ladder *is* the table, so this is a skip link: "Jump to the OI table".
- **Rescale hysteresis**: the y max changes only when the new max differs by > 10 % (the ladder's rule), so bars do not jitter on every 3 s tick.

### 6.4 The ladder: bars (rebuilt look; the DOM is kept)
Cell anatomy for `td.ob` (calls grow leftwards from the strike, puts rightwards; the existing `.trk` track):

```
 calls cell:   [ 15.0K ][▨▨ ghost ▨▨|████████ now ████████]│ strike
                                   └──── change micro-bar ──┘ (3 px, under the main bar)
```
- **Track**: height 18 px, vertically centred.
- **Main bar** `.now`: 12 px tall, top-aligned in the track, radius 2 at the far end only.
  - Fill `--dv-call` / `--dv-put` at **0.78** (light) / **0.72** (dark).
  - Rank-1 wall at **1.0**. Rank 2–3 at 0.9.
  - Bars **outside ±1σ** at 0.55, which makes the expected range pop without another colour.
- **Ghost** `.ghost` (OI cut since window start): the same 12 px, from `now` to `ref`, with side-colour hatch at 0.6 and a 1 px side-colour outline at 0.5. Shown only when `ref > now` (logic exists).
- **Change micro-bar** (new span `.chg` inside `.trk`): 3 px tall, 2 px below the main bar, grows from the strike side. Length `|d| / max` on the **same scale as OI**, so a +1.5K add on a 15K bar is honestly 10 % of the bar. Fill `--pos` for d > 0 and `--neg` for d < 0, with a minimum of 2 px when d ≠ 0. This replaces the ref `.mark` tick: **delete `.mark`** and its CSS.
- **Value** `.v` (OI figure): 600 12 px tabular fg at 0.92, placed at the outer end (exists). On phone (`--oi-vw: 32px`) the figure moves **inside the track at the far end of the bar** when the bar is ≥ 40 % of the track. It is then `#000` on dark-theme fills, and on light-theme fills `#FFF` on call bars and fg `#0A0A0B` on put bars (see §11 for the contrast figures). Otherwise it sits just outside the bar end in fg.
- **Metric OI chg**: the bar is the change itself.
  - `--pos` solid for added; `--neg` hatched with a 1 px `--neg` outline for cut.
  - **The bar cell's figure shows the OI** (`fq(leg.oi)`, 11.5 px `--a-label`), so the Δ column and the bars no longer repeat each other.
  - The column head becomes "Calls OI chg (lots) · OI".
- **Metric Volume**: side colour at 0.5, no ghost or change bar.
- **Δ column** `.d`: `.dv` in `--pos-ink` / `--neg-ink` / `--neutral-ink` (zero), 600 13 px. `.dp` (% of OI) 10.5 px `--a-quiet` (hidden on phone, exists). The build-up tag follows (§6.5).

### 6.5 Strike column, tags and markers
- **Strike** `.kv`: 650 13.5 px fg (phone 12.5). The strike column background is `--mat-fill-1`, with 1 px `--mat-separator` edges on both sides (exists).
- **ATM row**: per foundation §4.6. The strike becomes a **contrast pill** (`--sel-bg`/`--sel-fg`, radius 999, padding 1 8), with no blue tint on the row. Row top and bottom rules are fg/0.25.
- **Spot line**: **no longer a padded row.**
  - It is a 1 px `--dv-spot` line drawn as `box-shadow: inset 0 1px 0 hsl(var(--dv-spot))` on every cell of the first row above spot, across all 5 columns.
  - The pill "Spot 26417.35" (contrast pill, 10.5 px 650) is absolutely positioned **centred on that line in the strike column**, `transform: translate(-50%, -50%)`, `z-index: 2`.
  - The row height stays 36/44, so **no row grows** and the 14 px `padding-top` rule is deleted.
  - The pill overlaps the row border, not the strike text, because the strike text is centred and the pill is 16 px tall on a 36 px row: there is 10 px clearance.
- **±1σ**: strike cells inside the expected move get a `--dv-band` background (replacing the blue 2 px edge). The `+1σ`/`−1σ` tags become 10 px `--dv-iv-ink` text with no box.
- **Tags** (one line under the strike, max 2 visible; when more exist, the second slot shows "+2" quiet, and the full list is in `title` and the detail row):
  - priority order: wall, MP, held, σ;
  - **R1–R3**: 9.5 px 700 `--dv-call-ink` on a `--dv-call` 14 % tint, radius 3, padding 1 4;
  - **S1–S3**: the same in put colours;
  - **MP**: "◆ MP" 9.5 px 700 fg with a 1 px fg/0.4 outline (not orange);
  - **Held** "+2L"/"−1L": fg on `--mat-fill-3`, radius 999;
  - min font 9.5 px (was 8.5).
- **Build-up tag** in the Δ cell (`.obu`):
  - 10 px 700, radius 3, padding 1 4. Following foundation §4.6, LB and SC are `--pos-ink` on a 12/16 % `--pos` tint; SB and LU are `--neg-ink` on a `--neg` tint; CH is `--neutral-ink` with an outline.
  - This is the **option premium** direction, the same as the chain.
  - The underlying effect ("capping", "supportive") appears in the detail row, the tooltip and the Build-up block, each with its own ▲/▼ colour (§7.5).
  - The legend popover states both readings.

### 6.6 Rows, selection, scroll
- Row 36 px (fine pointer) / 44 (coarse). Hover (fine pointer): `--mat-fill-1`.
- **Selected**: `--mat-fill-2` plus `box-shadow: inset 2px 0 0 var(--sel-bg)` on the first cell (foundation §3.3), replacing the blue top/bottom lines. Focus-visible: a 2 px `--sel-ring` on the strike cell.
- **Centre on ATM** subtracts the sticky head height: `top = tr.offsetTop − headH − (wrap.clientHeight − headH) / 2 + tr.offsetHeight / 2`. This fixes the clipped first row.
- **Back to ATM**: a floating contrast pill "↕ ATM 26400" at the bottom centre of the ladder (`position: sticky; bottom: 8px`). It shows when the ATM row is out of view and points ↑ or ↓ toward ATM. 44 px tall on coarse pointers. It replaces the head button.
- **Detail row** (click selected row, tap on coarse, Enter):
  - becomes a two-column card (CE | PE), each side headed by a side-colour chip;
  - lines: `OI 13.7K → 15.0K` with the Δ in pos/neg ink and the %; `LTP 102.50 (−11.80)` with the change coloured; `Vol 1.2K`; the build-up tag plus "→ capping ▼" in the underlying-effect colour; held lots;
  - the footer has "Open in chain →" for **each** side (today it is CE only, a bug: `onOpenChain(k, "ce")`);
  - on phone the two sides stack.

---

## 7. Side blocks and secondary visuals

### 7.1 Walls (`drawWalls`)
Head "Walls" + `OI in lots · Δ vs Prev close`. Two groups, calls first.
- **Group caption**: "Call walls (resistance)" with a 10×10 `--dv-call` swatch, and "Put walls (support)" with `--dv-put`. On the right, the shift line "R1 ↑ from 26450" (fg, 600 11.5 px; the arrow is `--pos-ink` for up and `--neg-ink` for down; the meaning is in `title`).
- **Row** (32 px; grid `28px 64px 1fr 56px 64px`):
  - rank chip (R1/S1 tag style, §6.5);
  - strike (650 13 px, side ink for rank 1, fg otherwise);
  - **share bar**: track `--mat-fill-2` 6 px, fill = side colour, width `share / maxShare` where maxShare is the largest share across both sides, with the OI figure (`fq`) right of the bar, 12 px;
  - Δ in pos/neg ink;
  - distance `+83 · 0.2σ` (σ in `--dv-iv-ink`);
  - the freshness word under the strike at 10.5 px: "▲ fresh" `--pos-ink`, "▼ unwinding" `--neg-ink`, "steady" quiet;
  - "strong" becomes a bold weight on the strike plus "1.8×" in `title`.
- **Footers**: "Most added: 26500 CE +1.5K · 26250 PE +564", with the strike chips in side ink and Δ in pos ink. "Pin zone 26350–26450: 41 % of OI" appears only within 2 sessions of expiry, with a `--warn` dot.
- Phone: drop the Dist σ part, keep the points; the share bar is 40 px wide.

### 7.2 Max pain curve (new block, promoted from PRD 03 LATER; SVG, `createPainCurve()`)
- **Data**: `mp.curve`, limited to ±15 strikes around `mp.strike`.
- **y**: `(pain − minPain) / (maxPain − minPain)` in the domain, inverted so the minimum is at the **bottom**: the curve is a valley.
- **Size**: 120 px tall (100 on phone), full block width.
- **Marks**:
  - line 1.5 px fg/0.7; area below the line at fg/0.05;
  - the valley point: a ◆ 8 px fg marker and a contrast pill "MP 26450";
  - spot: a 1 px dashed fg/0.4 vertical line labelled "Spot";
  - the ±1σ band as a `--dv-band` rect behind.
- **Hover/scrub**: "26500 · writers pay +4.2 % more than at max pain", where `(pain − minPain) / minPain × 100`, formatted with `formatSigned`.
- **Caption**: "Total payout to option buyers if expiry settles at each strike; the lowest point is max pain. Matters mainly in the last 1–2 sessions." Relevance appears as a quiet chip (high/medium/low from `O.maxPainRelevance`).
- `aria-label`: "Max pain curve: lowest at 26450, 33 points above spot."
- `mp.edge`: the curve shows a `--warn` dot at the edge, and the caption adds "At the edge of the loaded range: the chain may be partial."

### 7.3 PCR gauge (tile micro-visual, HTML)
- **Scale**: log, from 0.4 to 2.5: `pos(p) = clamp(0, 1, (ln p − ln 0.4) / (ln 2.5 − ln 0.4))`.
- **Zones** (5 segments, 6 px tall, 1 px gaps), following `PCR_BANDS`, a single source:
  - `< 0.6` `--div-n2`;
  - `0.6–0.8` `--div-n1`;
  - `0.8–1.2` `--div-0`;
  - `1.2–1.5` `--div-p1`;
  - `≥ 1.5` `--div-p2`.
  - Writer view: put-heavy = supportive = green side.
- **Marker**: a 2×12 px `--dv-spot` bar at `pos(pcr)`, slid with `transform: translateX` (§8).
- **Window-start marker**: a 1×8 px fg/0.45 tick at `pos(pcrRef)`, only when `hasRef`.
- `title`: "PCR 1.05 (balanced). Writer view: higher = more put writing below spot. Was 1.08 at the window start."
- Note: foundation §5.3 says "> 1.2 pos, < 0.7 neg" for strip colour. This page uses `PCR_BANDS` (≥ 1.2, ≤ 0.8) because those are the bands the help sheet explains. Change foundation §5.3 to point at `PCR_BANDS`.

### 7.4 Split bars (PCR OI chg and PCR Vol tiles, totals)
- A 6 px bar, full tile width. Left segment = calls `--dv-call`, right = puts `--dv-put`.
- **Volume split**: widths in proportion to ΣCE vol and ΣPE vol.
- **ΔOI split** (signed): the bar is **diverging from the centre**, calls to the left and puts to the right.
  - Each half's length is `|Δ| / max(|ΣCE Δ|, |ΣPE Δ|) × 50 %`.
  - A positive Δ is solid side colour; a negative Δ is the side-colour hatch with outline.
  - So "puts added, calls cut" reads as orange solid on the right and blue hatched on the left.
- 1 px fg/0.35 centre tick.

### 7.5 Build-up (`drawBuildup`)
- **Direction meter** (new, top of the block): an 8 px track `--mat-fill-2`, centred, labelled "Bearish ◀ ▶ Bullish" at 10.5 px `--a-quiet` on each end.
  - Fill from the centre to `score × 50 %`: `--pos` if score > 0, `--neg` if < 0.
  - A 2×14 `--dv-spot` marker at the end.
  - The ±0.25 thresholds are 1 px fg/0.3 ticks, the "tilt" lines from `buildupSummary`.
  - The tone pill (§5.1) sits on the right of the meter row.
  - `score === null` → the track only, plus "No classified build-up".
- **Matrix** (2 rows × 5 cols, as today), each cell a **heat cell**:
  - The **underlying effect** for that side and class (`BUILDUP_READ[s][k][1]`): bullish or supportive → `pos`; bearish or capping → `neg`; churn → neutral.
  - The intensity step is `min(3, ceil(3 × lots / maxLots))` over the 10 cells. The background is `--div-p{step}` or `--div-n{step}` with its `--div-ink-*` text (foundation §4.4); churn uses `--mat-fill-{1..3}`.
  - A zero count gets no fill and a quiet "–".
  - **Dominant cell**: 1.5 px fg inner outline, weight 800 (replacing the grey fill).
  - Cell content: count 650 13 px; lots 10.5 px under it.
  - Column heads: "LB / SB / SC / LU / Churn". On desktop a second line names them ("Long bu · Short bu · Short cov · Long unw") at 10 px quiet. The full meaning stays in `title`.
- **Line under the matrix**: "Calls: SB dominant → capping ▼ · Puts: SB dominant → supportive ▲", where each effect word plus glyph is in its pos/neg ink.
- **Filter link**: a quiet `link-btn` with a filter glyph, "10 lots · 1 % OI · 0.5 % price". Foreground (not blue) with an underline on hover.

### 7.6 Movers (`drawMovers`)
- **Row** (40 px; grid `auto 1fr auto`):
  - left: the side chip "CE"/"PE" (10 px 700, side-ink on a side tint) + strike 650 13 px + wall tag (R1/S1 style) if any;
  - middle: a **bar**, 6 px tall, width `|d| / maxAbsD` where maxAbsD is over adds ∪ unwinds; adds `--pos` solid, unwinds `--neg` hatched with outline;
  - right: `+1.5K (+11 %)` in pos/neg ink;
  - sub-line (11 px `--a-label`): `LTP −11.8` (signed ink) · build-up tag (coloured) · "capping ▼" in effect ink.
- Desktop/tablet: two columns, Adds | Unwinds, with headers "Biggest additions ▲" (pos ink) and "Biggest unwinds ▼" (neg ink).
- Phone: the Adds/Unwinds capsule (exists, contrast selection).
- Click a mover → select that strike in the ladder (and the chart tooltip pins on it).

### 7.7 Expiries panel
- **Row**: Include (foundation checkbox), Expiry (+ "M" chip for monthly), DTE, Lot, a **CE/PE OI split bar** (new, 120 px desktop, 80 tablet), PCR (band ink, §5.2), Max Pain, Put wall (put ink), Call wall (call ink).
  - Split bar: total width `(ceOi + peOi) / maxTotal` over included expiries, so the monthly's larger OI shows. Calls in `--dv-call`, puts in `--dv-put`. It replaces the separate CE OI / PE OI columns on tablet; desktop keeps the two figures to the right of the bar.
- **Not-included rows**: one line, with all figure cells collapsed into a single quiet cell "Tick to compare". This replaces the 8 "--" dashes per row.
- Loading → a skeleton bar inside the split-bar cell. Error → `--neg-ink` "Not loaded" + a 44 px retry icon button.
- Phone cards (exist): the head line adds the split bar under the date.

### 7.8 OI over time panel
- Remove "Demo data:" from `coverage()` (foundation §7): it reads "Snapshots recorded off-hours · 1 snapshot since 09:02".
- **Slot height**: 120 px while `series().length < 10` (label "Chart engine slot · Call OI, Put OI, PCR, Max Pain and spot vs time · 3 points ready"), 240 px once ≥ 10.
- **"Show as table"** (`details`, new): the last 10 points of `series()`, newest first. Columns: Time, Spot, CE OI, PE OI, PCR (band ink), MP, R1 (call ink), S1 (put ink). A changed R1/S1 versus the row below gets a ↑/↓ glyph. This makes the recorded snapshots useful before the chart engine arrives.
- The wall-migration line (exists) gets side ink on the strikes.

---

## 8. Motion (foundation §6 primitives only; every item has a reduced-motion fallback)

| What moves | When | How | Duration / easing | Reduced motion |
|---|---|---|---|---|
| Ladder bars (`.now`, `.chg`, `.ghost`) | first draw of a (underlying, expiry, metric) key | `barsEnter`: scaleX 0→v; stagger **outward from ATM**, `12 ms × |i − atmIndex|`, capped at 240 ms | `--dur-3` `--ease-out` | final size at once |
| Ladder bars | every refresh | `transform: scaleX(var(--v))` transition from the old value (never from 0). `.ghost`/`.chg` widths become `scaleX` too (no `width` animation) | `--dur-3` `--ease-std` | none |
| Profile chart bars | first draw / metric change | scaleY from the baseline (`transform-box: fill-box; transform-origin: bottom`, top for negative chg bars), same outward stagger | `--dur-3` `--ease-out` | none |
| Profile chart bars | refresh | `scaleY(var(--v))` resize; each rect is drawn at full plot height and scaled | `--dur-3` `--ease-std` | none |
| Spot line + pill (chart and ladder) | spot moves | chart: `translateX`; ladder: when spot crosses a strike the line hops rows, and the pill cross-fades (opacity 0→1, `--dur-2`) | `--dur-2` `--ease-std` | instant |
| PCR gauge marker, meter marker, MP tile ◆ | value changes | `translateX` | `--dur-3` `--ease-std` | instant |
| Δ figures, tile values, wall OI | displayed text changes | `flashValue(el, dir)`: green up / red down background flash; at most once per element per refresh | `--dur-flash` | 2 px leading-edge marker for 3 s |
| Wall migration (R1 or S1 strike changes) | the strike changes | the new R1/S1 tag in the ladder and the chart label get a one-time ring pulse (`0 0 0 0` → `0 0 0 6px` side colour at 0.5 → 0); the tile value flashes | 900 ms `--ease-out` | static 2 px outline for 3 s |
| Max pain curve | first draw | `lineReveal` (dash offset), area fade after 120 ms | `--dur-4` | none |
| Detail row | open/close | inner wrapper `grid-template-rows: 0fr → 1fr` + opacity | 200 ms `--ease-std` / exit 160 ms `--ease-in` | instant |
| Tooltip | show/hide | opacity + scale 0.98→1 | `--dur-2` / 160 ms | opacity only |
| Panels | route or underlying change only | `pageEnter` stagger 40 ms, max 6 sections | `--dur-3` | none |
| Tiles | first paint | `countUp` on PCR OI, PCR OI chg, PCR Vol (formatted via `formatFixed`) | `--dur-4` | final text |

Performance: animate only `transform`, `opacity` and flash `background-color`. On a refresh, write `--v` only to cells whose value changed (the existing per-cell `sig` check). Budget: ≤ 200 element writes per 3 s tick (61 rows × 4 cells worst case is above that, so the chart patches only rects whose scaled value moved by ≥ 0.5 px). The ladder rescale keeps its 10 % hysteresis.

---

## 9. Interactions

- **Linking (new)**: one selected strike shared by the chart, ladder, walls, movers and tiles.
  - Selecting it anywhere selects the ladder row (`ladder.select(k, true)`).
  - It pins the chart tooltip on that strike.
  - It highlights the matching wall/mover row with `--mat-fill-2`.
  - Esc clears the selection.
- **Ladder**: J/K or ↑/↓ move, Enter opens details, G goes to ATM (exists). Clicking a strike cell on the desktop opens details directly (one click instead of two).
- **Chart**: hover scrubs, click pins, ← → move, Shift moves 5, Esc unpins.
- **Keyboard additions**:
  - `1`–`6` pick a window directly (Prev close … Since open);
  - `C` toggles the profile chart collapsed/expanded (persisted in `st.oi.chart`, default expanded; collapsed it is a 28 px summary line "OI profile · R1 26500 · S1 26400 · MP 26450").
  - The keys row and `?` help list them.
- **Touch**: every control is 44×44 on coarse pointers. A tap on the chart pins and selects, and the tooltip closes on a tap outside. A long-press on a ladder row opens details (same as a tap today).
- **Settings persisted** (`mcb.dashboard.desk` → `oi`): `chart` (bool) is added to `OI_DEFAULTS` and `oiConfig`, with a default of `true`. Everything else stays as PRD 03 §9.

---

## 10. States

| State | Look | Copy |
|---|---|---|
| First load | Verdict skeleton (1 line). 6 tile skeletons (value + 6 px bar). Chart: 21 grey bar-pair skeletons at random heights 20–80 %, with `dv-shimmer`. Ladder `loadingState` 12 rows at 36 px. `aria-busy` on the panels. | sr-only "Loading the NIFTY 3 Nov chain" |
| Refreshing | only flashes and transforms (§8) | — |
| Stale | live control in warn (foundation). Bars and figures at 0.7 opacity. The chart gets a quiet "Data 45 s old" caption on the right. | — |
| Error, no data | `errorState` in the ladder area. Chart and side blocks hidden. Tiles show `--`. | "Couldn't load the chain. The broker did not answer." + Retry |
| Error, data kept | `err-bar` at the top of `oi-main` | "Couldn't refresh: … Showing 09:02:58." |
| No OI (exists) | compact empty state; chart hidden | "No open interest yet. It usually appears after the first trades of the day." |
| Window warming up | window capsule: unavailable windows at 0.38 with reasons. Head sub-text "Recording · 3 snaps since 09:15". Change bars, ghosts and the window-start ticks are absent (no ref). | — |
| Combined scope | Build-up shows its message (exists). The chart shows summed OI across expiries; the window-start and ghost marks are hidden; the caption says "Combined · 3 expiries · lots". | — |
| Market closed | live control grey "Market closed · 15:29:59". Window = Prev close. | — |
| Demo | the toolbar dot only. **No "Demo data" text on this page.** | — |
| Partial chain (MP at range edge) | `--warn` dot on the Max Pain tile and curve | "At range edge: chain may be partial" |

---

## 11. Accessibility
- The chart and curve: `role="img"` + a summary `aria-label` (§6.3, §7.2), and they are focusable (`tabindex=0`) for scrubbing. The ladder remains the data table, with `caption` (exists).
- The tone pill, freshness words, build-up effects and movers use glyphs (▲ ▼ ↔) as well as colour. Cut marks are hatched.
- Contrast: the side inks and pos/neg inks are ≥ 4.5:1 (foundation §4.1). The OI figure drawn inside a bar uses #000 on dark fills and #FFF on light fills. Recheck: `--dv-put` light #E07800 with #FFF is only 3.1:1, so **inside-bar text on a light-theme put bar is fg #0A0A0B instead** (6.4:1). Add this pair to the polish contrast test.
- The polite live region (exists) speaks the verdict at most once a minute. A wall migration is announced at once: "Call wall moved up to 26550".
- `prefers-reduced-motion` follows §8.

---

## 12. Feature gaps (prioritised; exact behaviour)

1. **Coloured ladder** (§6.4–6.6): side-coloured bars, pos/neg change micro-bar, coloured Δ and tags, contrast ATM, no-padding spot line, selection per foundation. *Highest value: it is the owner's complaint.*
2. **OI profile chart** (§6.3) with spot, MP, ±1σ, walls, window-start ticks, cut hatching, scrub tooltip and linking.
3. **Legend row** (§6.2).
4. **Tiles with micro-visuals** (§5.2, §7.3, §7.4); Spot and Window tiles removed; wall/MP tiles jump to the strike.
5. **Build-up direction meter + heat matrix** (§7.5).
6. **Walls with share bars and freshness colour** (§7.1).
7. **Movers with diverging bars** (§7.6).
8. **Max pain curve** (§7.2). Formula: `pain(K) = Σ_k CE_OI(k)·max(0, K−k) + PE_OI(k)·max(0, k−K)` (exists in `maxPainCurve`); displayed as `(pain − min) / (max − min)`; tooltip `+((pain − min) / min) %`.
9. **Phone first screen** (§4.3): single controls row + ⚙ sheet, tile scroller, chart 160, ladder sized to the viewport with no tab-bar overlap.
10. **Linking + keyboard** (§9): shared selected strike, `1`–`6` windows, `C` chart toggle, both-sides "Open in chain".
11. **Expiries split bars** and the collapsed not-included rows (§7.7).
12. **Snapshot table** under the timeline slot (§7.8) and the shrinking slot.
13. **LATER** (not this round): premium added `ΔOI × LTP` in ₹ as a third metric ("₹ chg") with the same diverging bars; the classic NSE red/green palette option (foundation §10.7) — the ladder needs nothing extra beyond the token swap; replay/scrub across snapshots on the profile chart (a range slider over `series()` times, re-running `oiWindowRows` with that snapshot as ref); futures OI quadrant; per-index PCR percentile.

---

## 13. Build notes
- `oi.js`:
  - add `createProfile()` and `createPainCurve()` (SVG via `viz.svgEl`) and `legend` via `viz.legend`;
  - in `barCell()`, replace `mark` with `chg` and drive `--v` with `style.setProperty` (never a `style=""` attribute);
  - in `ladderModel()`, add `d` (signed), `outEm` and `rank` per side, and `spotLine` (row index + text) in place of `spotAbove`;
  - in `draw()`, compute `em`, `R/S` ranks and `mp` once and hand them to both the chart and the ladder.
- `oi-store.js`: no behaviour change. `series()` already feeds the table in §7.8.
- `options.js`: add a pure `pcrGaugePos(p, lo = 0.4, hi = 2.5)` and `buildupHeat(bu)` → `{ ce: {LB: {step, effect}}, … }`, both with tests in `options.test.mjs`. Spot interpolation `spotX(strikes, spot)` returns the fractional index, with a test.
- `app.css`:
  - replace the `.now` grey gradients, `.mark`, the `tr.atm` blue rules, `th.k[data-spot]` padding, the blue selection lines and the `.tag.mp/.em/.held` colours with the token-based rules above;
  - add `.oi-profile`, `.oi-pain`, `.oi-gauge`, `.oi-split`, `.oi-meter` and `.oi-heat[data-div]`;
  - add reduced-motion rules for each.
- Numbers only through `format.js` (`formatCompact`, `formatSigned`, `formatFixed`, `formatInt`). No `toFixed`.
- CSP: no inline `<style>` or `style=""`. SVG presentation attributes (`fill="..."` with `var()` is not allowed in attributes) → give the SVG elements classes, and colour them in CSS.

---

## 14. Acceptance checks
- **Static** (`polish.test.mjs` or a new `oi.test.mjs` file-read test):
  - the `table.oi-ladder` rules reference `--dv-call` and `--dv-put`;
  - no `--ios-blue` or `--ios-orange` remains in any `.oi-*` / `table.oi-ladder` rule;
  - `.mark` is gone;
  - `th.k[data-spot]` has no `padding-top`;
  - `coverage()` has no "Demo data".
- **Unit**: `pcrGaugePos`, `buildupHeat`, `spotX` (edges, null, out of range).
- **Playwright** (`scratchpad/oi-r2.cjs` extended), phone/tablet/desktop × dark/light:
  - `scrollWidth === innerWidth`;
  - computed `background-color` of a call `.now` ≈ `--dv-call` and of a put `.now` ≈ `--dv-put` (different hues);
  - a `.dv` with a "+" is green and with a "−" is red;
  - every ladder row in a band has the same height (±0.5 px);
  - phone: the first ladder data row's top is < 844;
  - desktop: the profile chart's top is < 300;
  - the tab bar does not overlap the last visible ladder row (bounding-box test);
  - the selected window segment is `rgb(255,255,255)` in dark and `rgb(10,10,11)` in light;
  - read every screenshot.

---

## 15. MUST-DO (ordered by value)

1. **Colour the ladder bars by side**:
   - calls `--dv-call` and puts `--dv-put` (0.72 dark / 0.78 light; R1/S1 at 1.0; outside ±1σ at 0.55);
   - "OI chg" metric bars `--pos` solid / `--neg` hatched with the bar cell showing OI (no duplicate Δ);
   - Volume bars at 0.5;
   - delete the grey gradients and the `.mark` tick.
2. **Add the pos/neg change micro-bar** under each OI bar (3 px, same scale as OI) and the side-hatched ghost for OI cut since the window start.
3. **Colour every ΔOI figure** with `--pos-ink`/`--neg-ink`: ladder Δ column, walls Δ, movers, tile sub-lines and the detail row. Colour build-up tags LB/SC pos and SB/LU neg (foundation §4.6) at 10 px.
4. **Build the OI profile chart** (grouped call/put bars per strike, SVG): spot line + contrast pill, ATM pill, ◆ max pain, ±1σ band, R/S wall labels, window-start ticks, cut hatching, OI/OI chg/Volume modes, scrub tooltip, click selects the ladder strike.
5. **Legend row** above the chart/ladder (calls, puts, added, cut, window start, spot, max pain, ±1σ, walls); a compact version plus an ⓘ popover on phone.
6. **Clean the strike column**:
   - ATM strike as a contrast pill (no blue tint);
   - the spot line as a row-border line with a centred contrast pill (no row padding; equal row heights);
   - the ±1σ `--dv-band` fill;
   - R/S tags in side tints, MP neutral ◆, held neutral, at most 2 tags plus "+n";
   - selection = fill + leading `--sel-bg` bar;
   - fix ATM centring to clear the sticky head.
7. **Tiles**: remove Spot and Window. Add the PCR gauge (log scale, PCR_BANDS zones, window-start tick), the ΔOI diverging split and volume split, the MP distance bar and the wall share bars. Colour values by meaning (PCR band, call/put ink for walls, freshness pos/neg). Wall and MP tiles jump to their strike. Add the verdict tone pill (▲ ▼ ↔).
8. **Animation**: bar grow from ATM outward on first draw and `scaleX/scaleY(var(--v))` resize on refresh (never regrow); spot/gauge/meter markers slide; `flashValue` on Δ and tile values; a ring pulse on wall migration; line reveal on the max pain curve; detail row expand; all with reduced-motion fallbacks and ≤ 200 writes per tick.
9. **Build-up**: direction meter (score −1…+1, ±0.25 ticks, tone pill) and heat-cell matrix coloured by underlying effect with `--div-*` steps and a dominant-cell outline; effect words with ▲/▼ in pos/neg ink.
10. **Walls**: share bars in side colour, rank chips, freshness ▲/▼ in pos/neg, shift arrow, σ in IV ink; pin zone with a warn dot.
11. **Movers**: CE/PE side chips, diverging magnitude bars (adds pos solid, unwinds neg hatched), coloured Δ and effect, click selects the strike.
12. **Phone and tablet layout**: single 44 px controls row + ⚙ sheet; tile scroller; chart 160; ladder sized to the viewport with no tab-bar overlap and a sticky "↕ ATM" pill; remove the empty movable-panel header on the tablet summary; verdict clamp 2.
13. **Max pain curve block** (valley SVG, spot line, ±1σ band, scrub "+x % vs max pain", edge warning).
14. **Expiries**: CE/PE split bars scaled across expiries, PCR band ink, wall inks, one-line not-included rows, foundation checkbox.
15. **Timeline**: drop "Demo data:" from `coverage()`; 120 px slot until 10 points; "Show as table" of the last 10 snapshots with coloured walls.
16. **Linking and keys**: one shared selected strike across chart/ladder/walls/movers/tiles; `1`–`6` windows; `C` chart toggle (persisted `oi.chart`); "Open in chain" for both CE and PE in the detail row.
17. **Tests and audit**: `pcrGaugePos`, `buildupHeat`, `spotX` unit tests; the static colour checks; the Playwright matrix in §14 with every screenshot read.
