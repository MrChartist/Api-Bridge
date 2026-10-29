# Design spec: global theme foundation (round 2)

Status: ready to build · Unit: shared visual system for every page, with the Options pages first · Builds on PRDs 01–08 (`docs/prd/`)

This unit sets up the parts every Options page shares: the near-black dark theme, contrast colours for selected controls, one set of data-visualisation colours, motion primitives, the compact Options top bar and a single demo indicator. It also finishes and commits the PRD 08 polish work that an earlier run left uncommitted. The page units (chain, strategy, OI, vol, screener, arb, positions) build their page-specific visuals on these tokens and helpers. They must not invent new colours or motion.

Evidence: screenshots of all 7 Options pages at 390×844, 820×1180 and 1440×900, in dark and light, are at
`/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/shots2/f/<page>-<device>-<theme>[-full].png` (script: `scratchpad/fnd.cjs`). None of the 42 shots scrolls sideways. The contrast figures below come from `scratchpad/contrast.mjs` (WCAG 2.x relative luminance).

---

## 1. What is wrong today (specific)

### 1.1 Top of every Options page: three stacked bands before any data
- On desktop at 1440, the first chain row starts at y≈345. Above it are three bands:
  1. The app toolbar (56 px): page pill, a "Demo data" pill, an IST clock, a 260 px search pill and refresh.
  2. The `.desk-top` panel (58 px + 16 px gap): underlying, expiry, "Demo paper account" with a "Paper" badge, a separate freshness text "● as of 08:52:24" and a separate green "Live" button.
  3. The summary strip (76 px).
- The page clock and the freshness time show almost the same time in two places.
- Spot and lot size are missing from the top bar. They appear only in the first summary tile, and are truncated there ("lot 75 · F 26446 (s...").
- On phone (390), the band above the chain is about 360 px, 43 % of the screen. The toolbar sits on row 0. The panel then needs 3 rows: underlying + expiry, account + Paper, freshness + a 44 px "Live" pill. Then comes the strip. Only 6 chain rows fit (`chain-phone-dark.png`).
- On tablet (820), the same three rows as phone appear, but at desktop height.

### 1.2 The demo state is repeated
"Demo" appears up to 4 times on one screen:
- the toolbar pill "Demo data";
- the account name "**Demo** paper account" (server label in `server/bridge/demo/demoMode.mjs:28`) plus a "Paper" badge right after it;
- the `#demo-banner` (hidden on desk pages by CSS but still rendered and toggled, `app.js:988`);
- per-panel text such as "Demo data: snapshots recorded off-hours" (`oi.js:442`), "Demo prices: …" (`arbitrage.js:60`) and `demoPill()` card actions (`views.js:48,905`).

### 1.3 Dark theme is warm charcoal, not black, and surfaces are muddy
- `--background: 24 10% 5.5%` and cards `26 7% 12%` (#201E1C-ish) are brown-grey. Panels read as dark brown slabs, not as content on black.
- ITM cells use `hsl(var(--ios-yellow) / 0.085)` on that warm card, which shows olive/khaki on dark and cream on light (`chain-desktop-*.png`). This is the main reason the chain looks unclean.
- Hairlines: the desk uses `--mat-separator` (white 10 %) on a warm card. Card edges and row rules have the same weight, so the hierarchy is flat.

### 1.4 Selected state is inconsistent (8 different looks)
| Control | Today (selected) | Where |
|---|---|---|
| `.segmented` / `.tabs` | grey thumb `--seg-thumb` (dark `26 5% 28%`, light white): low contrast in dark (±10, OI, Neutral, Strike…) | app.css:847 |
| `.scr-tabs` | grey thumb on desktop, **blue tint + blue ring** on phone | app.css:2909, 3122 |
| `chip-btn`, `.pct-btns`, `vol-wings`, `vol-bidask` | blue text on blue 10–12 % tint | app.css:2275, 2343, 2417 |
| `button.preset.on`, `.preset-chip.on`, `.side-btn.on`, `.arb-filters-btn.on`, `.scr-uchip.on` | each its own tint | app.css:1193, 1545, 1217, 2646, 2928 |
| `.switch` on | iOS green track | app.css:1201 |
| Positions checkboxes | browser-default blue | positions.js |
| `.nav a[aria-current]`, `.tab[aria-current]` | blue text on fill / blue fill | app.css:467, 560 |
| `.palette-option[aria-selected]` | solid blue | palette.css:55 |
| `.chain-tools .segmented.custom` | rule duplicated (app.css:1175 and 1261) | |

### 1.5 No data-visualisation colours
- OI bars in the OI ladder and in the chain are **grey** (`hsl(var(--foreground) / 0.26)`). Calls and puts look the same, and so do OI added and OI removed (`oi-desktop-dark-full.png`, `oi-tablet-light.png`).
- Volatility: the smile, term structure and band are all the one blue; there is no call/put wing distinction. Arbitrage: the deviation and liquidity columns have no colour scale. Screener: IV/HV has only a grey column highlight, with no heat. Positions: the risk graph is two thin lines on an empty panel.
- Blue currently means four different things: interactive, selected, spot, and the payoff "today" line.

### 1.6 Motion
- `motion.js` has `countUp`, `listStagger` and `pageEnter`, but no Options module imports them. The only motion on Options pages is the CSS cell flash on the chain and the skeleton pulse.
- There are no bar transitions: bar widths jump on every 3 s refresh.
- There are three skeleton keyframes (`skel-pulse`, `arb-shimmer`, `.sh`) and three separate reduced-motion blocks.

### 1.7 Smaller issues seen in the screenshots
- Strategy builder, empty state: about 300 px of empty payoff box with one line of text. The Place button shows as a disabled blue slab.
- The phone strategy page has two sticky bars (actions plus tab bar) covering about 140 px.
- The OI ladder on tablet light: grey bars on a white card at about 1.6:1. Unreadable.
- Arbitrage: "Liq" dots are all white, and the dev column is plain text.
- The chain's strike column uses `--ios-orange` for the ITM edge plus a blue-tinted ATM row: two accent colours in the same column.

---

## 2. The uncommitted PRD 08 work: review verdict

`git diff --stat`: 15 files, +828 −303. `npx vitest run server/bridge/dashboard` passes (266 tests) and `npm run -s check:mjs` passes.

**Keep all of it.** It is correct and in line with this spec:
- `app.js`: compact `emptyState`, `loadingState`, `errorState`, `freshnessPill`, `chartSlot`, `sheetPopover`, `touchWord`/`keyHint`/`touchOnly`, table `caption`, modal `id`/`ref`;
- `format.js`: `formatSignedRupee`, `ageText` (tested);
- `options.js` additions (tested);
- `desk.js`: `TRADING` set, account badge, freshness pill, 30 s refresh when the market is closed, expiry option text "3 Nov · 5d · W", lot in the spot tile;
- the breakpoints normalised to 720/1024/1280;
- the border→box-shadow hairline changes;
- the PRD 08 `12y` CSS block.

**Finish before committing** (this unit):
1. `server/bridge/dashboard/polish.test.mjs`, required by PRD 08 §10.1, **does not exist**. Create it with the PRD 08 static checks plus the foundation checks in §11 of this doc. It reads files only, so it does not need adding to `DASHBOARD_FILES`. If the format test list enumerates test files, add it there as well.
2. Delete the duplicate `.chain-tools .segmented.custom button[aria-pressed="true"]` rule at app.css:1261.
3. `--itm-edge` (orange) is replaced by the neutral ITM cue in §4.6.
4. `#demo-banner` is removed, not just hidden on desk pages (§7).
5. `skel-pulse`, `arb-shimmer` and `.sh` become one `dv-shimmer` (§6).
6. Run the full checks (`npx vitest run`, `npm run -s check:mjs`). Commit together with this foundation and `docs/prd/08-responsive-polish.md`.

---

## 3. Tokens: surfaces, text and selection

Dark and light change from warm to **neutral** surfaces. The brand copper glow (`--wall-a`) stays on the light theme only and is set to `transparent` in dark: a coloured wash on black is what makes the current dark theme look muddy.

All values go in `app.css` §1 (light) and both dark blocks (§1b, kept identical). Existing names stay so that other pages keep working; their values change. New names are marked **new**.

### 3.1 Surfaces
| Token | Light | Dark | Used for |
|---|---|---|---|
| `--background` | `240 5% 96%` (#F4F4F5) | `240 9% 2%` (#050506) | page canvas, `html`, `body` |
| `--card` / `--mat-grouped-solid` | #FFFFFF | `240 7% 5.5%` (#0D0D0F) | every `.desk-panel`, card, table body |
| `--mat-grouped` | `hsl(0 0% 100% / 0.92)` | `hsl(240 7% 5.5% / 0.94)` | non-desk cards (keep the glass feel off on desk) |
| `--surface-raised` **new** | #FFFFFF + `--shadow-float` | #16161A | popovers, sheets, palette, tooltips |
| `--mat-thick` | `hsl(0 0% 100% / 0.96)` | `hsl(240 7% 9% / 0.96)` | glass chrome |
| `--mat-glass` | `hsl(0 0% 100% / 0.62)` | `hsl(240 6% 8% / 0.62)` | toolbar pills, tab bar |
| `--mat-glass-strong` | `hsl(0 0% 100% / 0.78)` | `hsl(240 6% 6% / 0.80)` | sidebar |
| `--mat-fill-1` | `hsl(240 6% 10% / 0.045)` → #F4F4F4 on card | `hsl(0 0% 100% / 0.045)` → #18181A | control track, ITM tint, hover |
| `--mat-fill-2` | `/ 0.075` → #ECECEC | `/ 0.075` → #1F1F21 | skeleton, input bg, segmented track |
| `--mat-fill-3` | `/ 0.12` → #E0E0E0 | `/ 0.12` → #2A2A2C | pressed, switch off track |
| `--mat-hairline` | `hsl(240 6% 10% / 0.07)` | `hsl(0 0% 100% / 0.07)` | row rules inside tables |
| `--mat-separator` | `hsl(240 6% 10% / 0.10)` (1.25:1) | `hsl(0 0% 100% / 0.11)` (1.32:1) | panel edges, section dividers, column groups |
| `--seg-track` **new** | `hsl(240 6% 10% / 0.06)` (≈#EDEDEF) | `hsl(0 0% 100% / 0.06)` (≈#1A1A1D) | capsule bar background |
| `--shadow-1` | unchanged | `0 0 0 var(--hl) hsl(0 0% 100% / 0.06)` (no drop shadow on black: it is invisible and only muddies) | panel |
| `--wall-a` | unchanged (copper glow) | `transparent` | wallpaper |
| `--seg-thumb`, `--seg-thumb-shadow` | **removed** (replaced by `--sel-*`) | | |

The page canvas and cards differ only slightly in dark (#050506 vs #0D0D0F). The panel edge `--mat-separator` keeps panels visible; avoid shadows.

### 3.2 Text ladder (on `--card`)
| Token | Light | Dark | Contrast on card |
|---|---|---|---|
| `--foreground` | `240 6% 4%` (#0A0A0B) | `240 11% 96%` (#F4F4F6) | 19.8 / 17.7 |
| `--a-label` (secondary) | 0.70 | 0.70 | 7.6 / 8.9 |
| `--a-quiet` (captions, axis ticks; the floor) | **0.60** | **0.54** | 5.3 / 5.6 (light on canvas 5.1) |
| disabled | 0.38 (not text that must be read) | 0.38 | n/a |

Rule: never go below `--a-quiet` for any text, including axis labels and table sub-lines.

### 3.3 Selection: the contrast state (**new**, the owner's rule)
| Token | Light | Dark |
|---|---|---|
| `--sel-bg` | #0A0A0B | #FFFFFF |
| `--sel-fg` | #FFFFFF | #000000 |
| `--sel-ring` (focus on a selected item) | `hsl(211 100% 45%)` 2 px, offset 2 px | `hsl(211 100% 62%)` 2 px, offset 2 px |

Contrast figures:
- selected label: dark 21:1, light 19.8:1;
- thumb against track: dark 17.4:1, light 16.9:1;
- unselected label (`--foreground / --a-label` on `--seg-track`): dark 8.3:1, light 7.1:1.

**One rule for every selectable control.** Replace each row of §1.4 with this selector list (app.css, a new block `3b · SELECTION`, after the base controls):

```
:is(.segmented button[aria-pressed="true"], .tabs button[aria-selected="true"], .scr-tabs button[aria-selected="true"],
    button.chip-btn[aria-pressed="true"], .pct-btns button[aria-pressed="true"], button.vol-wings[aria-pressed="true"],
    button.vol-bidask[aria-pressed="true"], button.preset.on, button.preset-chip.on, table.chain .side-btn.on,
    .arb-filters-btn.on, button.scr-uchip.on, [role="tab"][aria-selected="true"], [role="radio"][aria-checked="true"],
    .sel-on)
  { background: var(--sel-bg); color: var(--sel-fg); box-shadow: none; }
```
- Icons inside take `currentColor`. Coloured glyphs in `.preset-chip .glyph` switch to `currentColor` when selected.
- Unselected: `color: hsl(var(--foreground) / var(--a-label)); background: transparent`.
- Hover (fine pointer only): `color: hsl(var(--foreground)); background: var(--mat-fill-1)`.
- Pressed: `transform: scale(0.97)` for 120 ms.
- Disabled: opacity 0.38, no hover.
- `.chain-tools .segmented.custom` keeps "no thumb" (no preset is selected).

Control-by-control:
- **Segmented / capsule bars**:
  - The track is `--seg-track`, radius 999 px, padding 2 px.
  - The selected thumb is a single absolutely positioned `::before` on the `.segmented` that slides (§6.3). The background on the button itself is the reduced-motion fallback and the fallback before JS measures. Implement it by having `segmented()` in views.js set `--seg-x` and `--seg-w` on the container after `pick()`.
  - Heights: 32 px on desktop (fine pointer), 44 px on coarse pointers.
  - Font: 600 13px. Selected 650.
- **Tabs** (screener tabs, OI windows, arb tabs): the same capsule. On phone the tab row scrolls sideways with a 16 px fade mask at each edge (`mask-image`). The selected tab scrolls into view (`scrollIntoView({inline:"center", block:"nearest"})`).
- **Chips / filter pills** (underlying chips, preset chips, `chip-btn`):
  - Off: `background: transparent; box-shadow: inset 0 0 0 1px var(--mat-separator)`.
  - On: the `--sel` pair, no outline.
  - Multi-select chips show a 12 px check glyph before the label when on, so the meaning is not carried by colour alone.
- **Switch** (`.switch`):
  - Off: track `--mat-fill-3`, knob #FFF in light / #8E8E93 in dark.
  - On: track `--sel-bg`, knob `--sel-fg`.
  - Not green. Green means gain or OK and nothing else.
- **Checkbox and radio** (positions include, OI expiries include):
  - `accent-color` cannot do black-on-white in every engine, so draw them with `appearance: none`: an 18 px box with radius 5 and a 1.5 px `hsl(var(--foreground)/0.4)` border.
  - Checked: `--sel-bg` fill with an `--sel-fg` tick (an SVG mask in CSS, a `data:` URL, which CSP allows).
  - Hit area 44 px on coarse pointers via the padding of the label.
- **Live / pause toggle**: the one exception. Its "on" state is a status, not a selection. A green pulsing dot and the word "Live", on a transparent background (§5).
- **Sidebar nav current**: `background: var(--mat-fill-2); color: hsl(var(--foreground)); font-weight: 650`, plus a 3 px × 18 px `--sel-bg` bar at the left edge, radius 2.
  - It is not a full white slab: a 240 px white block would be the brightest thing on the page and pull the eye away from the data.
  - The icon keeps its tint.
- **Tab bar current (phone/tablet)**: a `--sel-bg` capsule behind the icon (56×32), with the icon in `--sel-fg` and the label in `--foreground` 650.
- **Palette selected row**: `--sel-bg` / `--sel-fg`. Its `.kbd` uses `hsl(var(--sel-fg) / 0.15)`.
- **Table row selection** (OI ladder `aria-selected`, chain focus row, arb selected row): **not** a white fill, which would hide the numbers. Instead `background: var(--mat-fill-2)` plus a 2 px `--sel-bg` bar on the leading edge (`box-shadow: inset 2px 0 0 var(--sel-bg)`).
- **Primary action buttons**:
  - Stay accent blue (`--ios-blue-fill`) with white text: Place, Add leg, Rescan. They are actions, not selections.
  - Buy is `--pos-fill` and Sell is `--neg-fill` (§4.2), each with the text colour in the table.
  - A disabled primary is `--mat-fill-2` with `--a-quiet` text, not a faded blue slab.
- **Status pills** (`.pill.ok/.bad/.warn/.info`) are not selectable. They keep tinted backgrounds but use the §4 inks.

---

## 4. Data-visualisation colour system (**new** tokens, app.css §1 + dark blocks)

Principles:
- **Red/green is reserved for direction and money**: gain/loss, up/down change, OI added/removed text, buy/sell.
- **Calls and puts get their own colour-blind-safe pair: blue (calls) and orange (puts).** The two hues differ in the protan/deutan axis.
- Spot/ATM is the foreground colour (white on dark, black on light), the same "contrast" language as selection.
- Volatility and intensity use one violet ramp.

Decision note for the owner: NSE, Sensibull and Opstra colour call OI red and put OI green. We do not, because those colours collide with OI-change and P&L colours on the same screen. Every legend says "Calls (CE)" / "Puts (PE)". The values are all tokens, so offering an alternative convention later (`--dv-call: red`) is a one-line swap (see §10, LATER).

### 4.1 Series
Text ("ink") values hold at least 4.5:1 on card. Fill values hold at least 3:1 on card, as non-text marks.

| Token | Light | Dark | Ink contrast (L / D) | Fill contrast (L / D) | Meaning |
|---|---|---|---|---|---|
| `--dv-call` (fill) / `--dv-call-ink` | #1C7BEA / #0A62C9 | #3A93F0 / #4AA8FF | 5.8 / 7.7 | 4.1 / 6.1 | calls (CE): OI bars, call wing, CE column headers |
| `--dv-put` / `--dv-put-ink` | #E07800 / #A65300 | #F28A1A / #FF9F2E | 5.4 / 9.5 | 3.1 / 7.8 | puts (PE) |
| `--pos` / `--pos-ink` | #1FA347 / #0A7A33 | #30D158 / #30D158 | 5.5 / 9.6 | 3.3 / 9.6 | gain, up-tick, OI added, buy |
| `--neg` / `--neg-ink` | #E2382E / #C9241C | #FF5A50 / #FF5A50 | 5.6 / 6.3 | 4.3 / 6.3 | loss, down-tick, OI removed, sell |
| `--neutral-ink` | fg / 0.70 | fg / 0.70 | 7.6 / 8.9 | n/a | unchanged, flat |
| `--warn` / `--warn-ink` | #F5B800 / #8A5A00 | #FFD60A / #FFD60A | 5.9 / 13.8 | (dot + icon) | stale data, tested strike, wide spread, expiry day |
| `--dv-spot` | #0A0A0B | #F4F4F6 | 19.8 / 17.7 | same | spot line, ATM marker, "now" cursor |
| `--dv-iv` / `--dv-iv-ink` | #7F55DB / #6E35D6 | #8A63D9 / #BF8CFF | 6.7 / 7.8 | 5.0 / 4.5 | IV series, vol accent |
| `--dv-hv` | fg / 0.55 dashed 4 3 | same | n/a | n/a | realised vol, comparison curves |
| `--dv-band` | #F2EEFB (violet 10 % on card) | #1E192B (violet 14 %) | n/a | area | ±1σ band. ±2σ is the same colour at half alpha |
| `--dv-today` | `--ios-blue` dashed 5 4 | same | n/a | 1.5 px line | payoff today / T+n curve (no call/put series on a payoff chart, so blue is free there) |
| `--dv-grid` | fg / 0.06 | fg / 0.07 | n/a | n/a | grid lines (horizontal only) |
| `--dv-axis` | fg / 0.60 | fg / 0.54 | text = `--a-quiet` | n/a | tick labels 10.5 px tabular |

Text on solid fills:
- Light: white on `--pos` is 3.3:1, so a white label on a green fill must be ≥ 14 px bold. Prefer the ink colour on a tint.
- Dark: black on `--pos` is 10.4:1 and black on `--neg` is 6.8:1. **Buy/Sell buttons in dark use black text.**

The call and put fills have similar luminance (1.3:1 against each other). Hue and **position** carry the difference: calls are always left of the strike, puts right; on charts, calls are the right wing above the forward. The phone one-sided chain shows a CE/PE capsule. Never rely on colour alone.

### 4.2 Fills and tints (derived; always `hsl(var(--x) / a)`)
- **Tint backgrounds** for chips and status: ink colour at 12 % (light) / 16 % (dark).
- **Areas**: payoff profit `--pos / 0.16`, loss `--neg / 0.14` (dark: #132C1B / #2F1818).
- **Decrease marks**, used for OI removed and OI unwinding:
  - the side colour at 35 % fill;
  - a 1 px full-colour outline, which meets the 3:1 non-text rule through the outline;
  - a 45° hatch.
  - Hatch pattern: one shared `<svg>` `<defs>` sprite in index.html with `#dv-hatch-call` and `#dv-hatch-put` (4 px spacing, 1 px stroke in the side colour at 0.6).
  - HTML bars use `background: repeating-linear-gradient(135deg, currentColor 0 1px, transparent 1px 4px)` on a `color: var(--dv-call)` element.

### 4.3 Sequential scale (intensity: IV/HV heat, rank, liquidity, OI concentration)
5 steps, violet, **new** `--seq-1` … `--seq-5`.

| Step | Light | Text on it | Dark | Text on it |
|---|---|---|---|---|
| 1 | #F3EEFE | fg 17.4 | #1E1631 | fg 15.7 |
| 2 | #DDCCFB | fg 13.3 | #33235A | fg 12.5 |
| 3 | #B898F2 | fg 8.3 | #553A93 | fg 7.9 |
| 4 | #7F55DB | **#FFF** 5.0 | #8A63D9 | **#000** 4.9 |
| 5 | #4E2AA6 | **#FFF** 9.5 | #C7A8FF | **#000** 10.5 |

`--seq-ink-4`/`-5` hold the text colour per theme. Mapping: `step = clamp(1, 5, 1 + floor(4 · (v − lo) / (hi − lo)))`. lo and hi are the 5th and 95th percentile of the visible values, so one outlier does not wash the rest out. Values must be finite; a missing value gets no fill and shows `--`.

### 4.4 Diverging scale (signed: P&L, Δ, OI chg %, parity deviation, IV vs HV spread)
7 steps, **new** `--div-n3 … --div-0 … --div-p3`.

| Step | Light | Text | Dark | Text |
|---|---|---|---|---|
| −3 | #C9241C | #FFF 5.6 | #FF5A50 | #000 6.8 |
| −2 | #F08A84 | #000 8.2 | #B8423C | #FFF 4.9 |
| −1 | #FBD9D6 | #000 15.1 | #5A2725 | #FFF 10.9 |
| 0 | #F2F2F3 | #000 17.7 | #1C1C20 | #FFF 15.5 |
| +1 | #CDEFD7 | #000 16.0 | #1E4D2C | #FFF 8.9 |
| +2 | #6FCB8B | #000 10.0 | #237F3F | #FFF 5.0 |
| +3 | #0A7A33 | #FFF 5.5 | #30D158 | #000 10.4 |

The `--div-ink-*` tokens carry the text colour per step. Mapping: `step = sign(v) · min(3, ceil(3 · |v| / m))`, where `m` is the 95th percentile of |v|. Within the dead-band `|v| < m/20` the step is 0. A pure helper `divStep(v, m)` and `seqStep(v, lo, hi)` goes in `options.js` (tested in `options.test.mjs`) so the page units share it.

### 4.5 Rules for every chart and visual
- **Legend**:
  - Every visual with more than one colour has a legend: an inline row above the plot, 12 px, swatch 10×10 radius 2, or a 14×2 line for line series.
  - Order: calls before puts, positive before negative.
  - A legend item is a toggle on charts with more than 2 series. It uses the §3.3 chip rule; off means 35 % opacity, with the selection kept when the item is hidden.
- **Axes**:
  - Only horizontal gridlines, at `--dv-grid`.
  - Tick labels `--dv-axis`, 10.5 px, tabular.
  - 4–6 ticks via `niceTicks` (already in options.js).
  - Zero line at `fg / 0.35`, 1 px.
- **Marks**:
  - Bars radius 2 (at the far end only).
  - Minimum bar length 2 px for a non-zero value. A zero value gets no bar.
  - Lines: 2 px for the primary series, 1.5 px secondary, with `vector-effect: non-scaling-stroke`.
- **Spot/ATM**: a 1 px `--dv-spot` line with a contrast pill label (`--sel-bg`/`--sel-fg`, 11 px 650, radius 999, padding 2 6), for example "Spot 26421.45".
- **Hover/scrub**:
  - Crosshair at `fg / 0.35`, 1 px.
  - Tooltip on `--surface-raised`, radius 10, padding 8 10, 12.5 px. Values are coloured by series ink.
  - Pinned with a click or tap. Esc unpins.
  - Keyboard: ← → move one step, Shift = 10 steps.
- **Text alternative**: each SVG has `role="img"` and an `aria-label` that summarises the chart, plus a "Show as table" disclosure (PRD 08).
- **Placeholders**: price/time charts stay as `chartSlot()` boxes. Purpose-built SVG (ladders, payoff, smile, term, heat cells, bullet bars) is drawn by us.

### 4.6 Chain-specific base colours (page units must use these)
- **ITM cells**: `background: var(--mat-fill-1)`, neutral (dark #151517, light #F7F7F7; fg on it 16.6:1). This replaces the yellow 8.5 %.
- **The ITM/OTM boundary**: a 2 px `fg / 0.22` inner edge on the strike column side. This replaces `--itm-edge` orange.
- **ATM row**:
  - strike rendered as a contrast pill (`--sel-bg` / `--sel-fg`);
  - row top and bottom rules in `fg / 0.25`;
  - no blue tint.
- **Spot row**: the contrast pill "NIFTY 26421.45 +1.85 (+0.01 %)", with the change in `--pos-ink`/`--neg-ink` **inside** a `--surface-raised` capsule. The capsule cannot be the contrast pill, because coloured change text on a white pill fails.
- **Column-group header**: "CALLS" in `--dv-call-ink`, "PUTS" in `--dv-put-ink`, 11 px 700, with a 2 px underline in the side colour.
- **OI bar in the chain**:
  - main bar 4 px in `--dv-call`/`--dv-put` at 0.85;
  - change micro-bar 1.5 px in `--pos`/`--neg`;
  - max-OI strike bar at full opacity, others at 0.6.
- **Build-up tags (LB/SB/SC/LU)**: LB and SC are `--pos-ink` on a 12 % tint; SB and LU are `--neg-ink` on a tint. This follows price direction: long build-up and short covering are bullish. The letters stay, so colour is not the only carrier.
- **Up/down tick flash**: §6.2.

---

## 5. The compact Options top bar (shared by all 6 desk pages; the screener uses the same bar without an expiry)

### 5.1 What it shows (in this order) and what is removed
Contents, left to right:
1. Page pill (icon + name; icon only below 1280).
2. **Underlying ▾**.
3. **Expiry ▾** "3 Nov · 5d · W".
4. **Spot** "26421.45" with change "+1.85 (+0.01 %)" in `--pos-ink`/`--neg-ink`.
5. **Lot 75**.
6. Expiry-today chip (`--warn`, only on expiry day).
7. Spacer.
8. **Account ▾ + mode** (trading pages only): "Paper account · PAPER", or "Zerodha main · **LIVE**", where LIVE is `--neg` fill with white/black text.
9. **Live control**: one button. "● 08:52:24" while live; "❚❚ Paused · 12 s old" when paused; "● Stale · 45 s old" in warn; "● Market closed · 15:29:59" with a grey dot. Click, or **P**, toggles. It merges today's `freshnessPill` and `liveBtn`.
10. **Demo indicator** (§7).
11. Search (icon only on desk pages; ⌘K still works).
12. ⋯ overflow (phone/tablet only).

Removed:
- the `.desk-top` panel (the whole band);
- the toolbar IST clock (`#clock`) on desk layout, because the live control shows data time;
- the separate Refresh button on desk layout (Live refreshes; a manual refresh is in ⋯ and **R**);
- the "Demo data" toolbar pill text duplicate;
- the "Paper" badge when the account label already says paper.

Implementation:
- Add `<div id="toolbar-ctx" class="toolbar-ctx" hidden></div>` to index.html, after `.toolbar-title`.
- `desk.js` builds `bar` exactly as now but mounts it into `#toolbar-ctx` (`replaceChildren`) instead of returning a `.desk-top` panel. `views.js` `show()` clears and hides `#toolbar-ctx` when the page is not `layout: "desk"`.
- The `:root[data-layout="desk"]` CSS hides `#clock` and the refresh icon-btn.
- **Spot** comes from `x.sm.spot` and the index quote (`st.quotes`); change = `ltp − prevClose` from the quote. Missing → `--`. It updates via text nodes only, with the §6.2 flash.
- On the screener, the expiry, spot and lot are absent; the bar shows the underlying chips' summary "3 underlyings · 7 chains".

### 5.2 Layout per device
| Device | Toolbar height | Row contents |
|---|---|---|
| Desktop ≥1280 | 52 px (was 56 + 74 for the panel) | `[pill: icon+name] [ctx capsule: U▾ │ Exp▾ │ 26421.45 +1.85 (+0.01%) │ Lot 75] ··· [Acct▾ PAPER] [● 08:52:24] [● Demo] [⌕]` |
| Desktop 1024–1279 | 52 px | page pill icon-only; the account label truncates at 180 px with an ellipsis (full name in `title`) |
| Tablet 720–1023 | 52 px | `[icon] [U▾ │ Exp▾ │ spot ±chg]` ··· `[● time] [⋯]`. Lot, account, demo text, search and refresh go into the ⋯ sheet. On Positions the account replaces the expiry in the capsule. |
| Phone < 720 | 52 px + safe-area | `[U▾ two-line: "NIFTY ▾" / "26421.45 +0.01%"] [Exp▾ two-line: "3 Nov ▾" / "5d · W · lot 75"]` ··· `[● 44×44 dot-only live control] [⋯ 44×44]`. No page pill (the tab bar shows the page). The demo dot sits on the ⋯ button as a 7 px badge. |

- **Capsule**:
  - one `--mat-glass` pill with radius 999 and height 40 (44 on coarse pointers);
  - internal dividers are 1 px × 18 px `--mat-separator`;
  - items have padding 0 12px;
  - selects use the transparent-native-select technique: the visible text spans sit under an `opacity:0` `<select>` stretched over the item. The native picker stays (good on iOS/Android) and the label can be two lines.
- **Type**:
  - underlying 700 15px `--font-display`;
  - expiry 600 13.5px;
  - spot 650 15px tabular;
  - change 600 12.5px;
  - phone second lines 500 11.5px at `--a-label`.
- **⋯ sheet** (phone/tablet; `sheetPopover`): Account select + mode, Refresh now, Pause/resume, Search, Theme (Light/Dark/Auto capsule), "Demo data: sample prices, paper orders only" (when demo).
- **Space saved**: desktop chain data starts at y≈270 instead of 345 (−75 px). Phone starts at y≈190 instead of 360. A one-line 52 px summary strip on phone (§5.3) lets about 12 chain rows fit instead of 6.

### 5.3 Summary strip (shared, below the bar; pages may hide it)
- **Desktop**:
  - one row of up to 8 tiles, 60 px tall (was 76);
  - label 11.5 px `--a-quiet`, value 650 17px tabular, sub 11.5 px `--a-label`;
  - no truncation of the value.
- **Tablet**: 4×2.
- **Phone**:
  - one horizontally scrolling row (scroll-snap, 16 px edge fade);
  - tiles 132 px wide, 52 px tall;
  - the spot tile is removed on phone because spot is in the bar.
- **Colours**: values coloured by meaning only (PCR > 1.2 `--pos-ink`, < 0.7 `--neg-ink`, else fg; net OI chg signed). The value cross-fades and flashes on change (§6.2).

---

## 6. Motion primitives (`motion.js` + CSS; all respect reduced motion)

### 6.1 Tokens (app.css §1)
| Token | Value | Use |
|---|---|---|
| `--dur-1` | 120ms | press, hover, colour |
| `--dur-2` | 200ms | thumb slide, popover, tooltip |
| `--dur-3` | 320ms | section enter, bar grow / resize |
| `--dur-4` | 600ms | count-up, first-draw line reveal |
| `--dur-flash` | 900ms | value flash fade |
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` (exists) | enters, grows |
| `--ease-std` **new** | `cubic-bezier(0.2, 0, 0, 1)` | slides, resizes |
| `--ease-in` **new** | `cubic-bezier(0.4, 0, 1, 1)` | exits (160ms) |

Keep `--dur-fast`/`--dur` as aliases (`--dur-1`, `--dur-3`).

### 6.2 Primitives
Each primitive is a CSS class (cheap, works on refresh) or a JS export in motion.js (no-op under reduced motion or without Motion).

1. **Bar grow** (`.dv-bar`, HTML and SVG):
   - On first draw the bars scale from 0 with `transform: scaleX(0)` → 1 (or scaleY for vertical). Origin is the baseline side (`transform-box: fill-box` for SVG).
   - Duration `--dur-3` `--ease-out`, staggered 12 ms per bar, capped at 240 ms total.
   - On a refresh the bars **resize from the old value** (CSS `transition: transform var(--dur-3) var(--ease-std)` on the `--v` custom property via `transform: scaleX(var(--v))`). They never regrow from zero.
   - JS: `barsEnter(root)` adds `.dv-enter` for one frame. Reduced motion: no transition, final size at once.
2. **Value flash** (`flashValue(el, dir)` + `.flash-up/.flash-down`):
   - Background `--pos`/`--neg` at 0.22 (dark 0.28) fading to transparent over `--dur-flash` `--ease-out`. The text colour does not change.
   - It fires only when the displayed text changes, and at most once per element per refresh.
   - The chain keeps its existing `flash-up/flash-down` keyframes, renamed to the shared ones (`dv-flash-up`, `dv-flash-down`; delete the `…2` duplicates and alternate with a data attribute instead).
   - Reduced motion: no animation. A 2 px leading-edge marker in `--pos`/`--neg` stays for 3 s via a class removed on the next tick.
3. **Section enter** (`pageEnter` exists): opacity 0→1 and translateY 6→0 px, `--dur-3`, stagger 40 ms, maximum 6 sections. **Only on route or underlying change**, never on a refresh. Desk pages call `animatePage` after their first `drawAll`. Reduced motion: none.
4. **Number count-up** (`countUp` exists):
   - on KPI tiles at first paint only (P&L, net Δ, max profit/loss, PCR);
   - `--dur-4`, ease-out;
   - formatted through the page's format.js function (pass `format` and `finalText`, so no `toFixed` in page code);
   - on later refreshes a changed value flashes instead;
   - reduced motion: the final text at once.
5. **Skeleton shimmer** (`.skel`, one keyframe `dv-shimmer`):
   - the background is `linear-gradient(90deg, var(--mat-fill-2) 0 40%, var(--mat-fill-3) 50%, var(--mat-fill-2) 60% 100%)` at `background-size: 300% 100%`, sliding over 1.4 s linear infinite;
   - it replaces `skel-pulse`, `arb-shimmer` and `.sh`;
   - reduced motion: static `--mat-fill-2`.
6. **Thumb slide** (segmented):
   - `::before` at `translateX(var(--seg-x))` with `width: var(--seg-w)`, `transition: transform var(--dur-2) var(--ease-std), width var(--dur-2) var(--ease-std)`;
   - set from `segmented()` with `offsetLeft`/`offsetWidth` on pick and on `ResizeObserver`;
   - reduced motion: no transition.
7. **Line reveal** (payoff, smile, term; first draw only):
   - `stroke-dasharray: L; stroke-dashoffset: L → 0` over `--dur-4`;
   - areas fade in 0→1 over `--dur-3` after a 120 ms delay;
   - on a refresh: no reveal, the path `d` is simply replaced;
   - reduced motion: none.
8. **Live dot**:
   - a 6 px green dot with a ring pulse (`0 0 0 0` → `0 0 0 6px` at alpha 0.5 → 0), 2 s, every refresh tick (triggered by the class re-add on each successful load, not an infinite loop);
   - paused: no pulse, grey;
   - reduced motion: no ring.
9. **Popover / sheet**: these exist (`sheetIn/sheetOut`). Popovers use scale 0.98→1 and opacity, `--dur-2`; exit `--ease-in` 160 ms.

Performance rule: animate only `transform` and `opacity`, plus `background-color` for flashes. Do not animate layout properties on the 3 s refresh path. Each refresh must patch no more than 200 elements (PRD 01's budget is unchanged).

---

## 7. Exactly one demo indicator

**Keep**:
- The toolbar indicator, `#toolbar-demo`:
  - desktop and tablet: an amber 8 px dot (`--warn`; in light it has a 1 px `--warn-ink` ring, because the bare dot is only 2.1:1 on white) and the word "Demo" (`--warn-ink`, 600 12.5px);
  - phone: the 7 px dot badge on the ⋯ button, with `aria-label="Demo data: sample prices, paper orders only"`;
  - click or tap opens a one-paragraph popover: "Sample prices generated on this computer. Not live market data. Orders are paper only."
- The sign-in screen's `#login-demo`, because it is a different screen with no toolbar.

**Remove**:
- `#demo-banner` in index.html, `app.js:988`, its CSS (`.demo-banner`, `#demo-banner` rules), and the `:root[data-layout="desk"] #demo-banner` rule.
- `demoPill()` on the Home card (`views.js:905`). Delete the export if it is unused.
- `oi.js:442`: "Demo data: snapshots recorded off-hours" becomes "Snapshots recorded off-hours · N since HH:MM".
- `arbitrage.js:60` `DEMO_NOTE`: drop the "Demo prices:" lead-in. Keep the sentence in the notes list only while demo ("Calls and puts use different volatility smiles here, so parity breaks are artificial.").
- `server/bridge/demo/demoMode.mjs:28`: label "Demo paper account" becomes "Paper account". Update any test that asserts the label (`grep -rn "Demo paper account" server test`).
- The `acct-badge` "Paper" when the selected account's label already contains "paper" (case-insensitive). "LIVE" always shows.
- Repeated "· paper" suffixes: `strategy-place.js:444` "`${a.label} · paper`" becomes the label plus the PAPER badge, once.

---

## 8. Typography and spacing for Options pages

- **Families**: unchanged. Inter for all figures (tabular), Plus Jakarta for panel titles.
- **Scale**:
  - panel title 650 15px;
  - section label 600 12px at `--a-label` (sentence case; uppercase only for the CALLS/PUTS group header);
  - table cell 13.5px (chain 13px);
  - sub-line 11.5px;
  - axis 10.5px;
  - KPI value 17px (strip) or 22px (hero P&L on positions).
- **Numbers**: `font-variant-numeric: tabular-nums` everywhere (body already has it), right-aligned, with the sign always shown for changes (`formatSigned`, `formatSignedRupee`).
- **Spacing**:
  - 4-px grid;
  - panel padding 12 px on every device;
  - gap between panels 12 px (was 16);
  - panel radius `--r-panel` = 16 px on desk (was 22: tighter reads cleaner at this density);
  - row heights: chain 32 / coarse 40 / phone 44, other tables 36.
- **Hairline hierarchy**:
  - panel edge `--mat-separator`;
  - table row rules `--mat-hairline`;
  - group dividers (between CALLS, Strike, PUTS) `--mat-separator` at 1 px, not `--hl`.

---

## 9. States (shared look; components exist from PRD 08)

| State | Look | Copy pattern |
|---|---|---|
| Loading (first) | `loadingState` skeleton rows at the final row height, with `dv-shimmer`, and `aria-busy` on the panel | sr-only "Loading the NIFTY 3 Nov chain" |
| Refreshing | nothing moves except the live dot pulse and value flashes | n/a |
| Stale (> 3 refresh periods) | live control turns warn with "Stale · 45 s old"; values at 0.7 opacity | n/a |
| Error, no data | `errorState` card: title, one line, Retry (secondary button), Accounts link for auth codes | "Couldn't load the chain. The broker did not answer." |
| Error, data kept | `err-bar` slim bar at the top of the panel (`--neg` 8 % tint, `--neg-ink` text) | "Couldn't refresh: … Showing 14:32:05." |
| Empty | compact `emptyState`: title + one line + action (no icon tile in panels) | "No positions in NIFTY. Open Strategy Builder" |
| Market closed | live control grey dot "Market closed · last 15:29:59", 30 s refresh | n/a |
| Demo | the toolbar indicator only (§7) | n/a |

---

## 10. Feature gaps the foundation owns (prioritised; page units build on these)

1. **`segmented()` contrast thumb with slide** (views.js): it sets `--seg-x/--seg-w` and adds `.has-thumb`. CSS draws `::before` in `--sel-bg`, and the selected button's text is `--sel-fg` (`position: relative; z-index: 1`). The fallback without `.has-thumb` is the button background.
2. **Shared viz helpers** in a new `server/bridge/dashboard/viz.js`, added to `DASHBOARD_FILES` in `server/bridge/core/app.mjs` and to the list in `format.test.mjs`:
   - `legend(items)`: `[{label, token, kind: "swatch"|"line"|"dash"|"hatch", toggle?}]` → `.dv-legend`.
   - `hbar({ value, max, side: "call"|"put"|"pos"|"neg", decrease })` → `<span class="dv-bar" style="--v:…">`. Set `--v` via `el.style.setProperty`, never a `style=""` attribute.
   - `heatCell(td, step, kind: "seq"|"div")`: sets `data-seq`/`data-div`, and the CSS maps that to the bg/ink tokens.
   - `svgEl(tag, attrs)`, and `spotPill(svg, x, label)`.
   - `scrubber(svg, {onMove, steps})`: pointer, touch and keyboard crosshair with a pinned tooltip.
   - Pure maths (`seqStep`, `divStep`, `niceTicks`) stays in `options.js` with tests.
3. **Hatch sprite** in index.html `<svg class="sprite"><defs>`: `#dv-hatch-call` and `#dv-hatch-put` patterns, colour from CSS via `currentColor`.
4. **`flashValue`, `barsEnter`, `lineReveal`** in motion.js. Export them, add unit-safe no-ops for Node, and give them reduced-motion fallbacks.
5. **Toolbar context slot** (`#toolbar-ctx`), the merged live control and the ⋯ context sheet (§5).
6. **The checkbox, radio and switch restyle** (§3.3), via a CSS `appearance:none` block that applies app-wide.
7. **LATER**: a theme setting "CE/PE colours: Blue/Orange (default) · Red/Green (NSE style)" that swaps `--dv-call`/`--dv-put` only; a high-contrast mode (`prefers-contrast: more` raises `--a-quiet` to 0.72 and `--mat-separator` to 0.2); payoff path morphing.

---

## 11. Acceptance checks (add to `polish.test.mjs`; static, file reads only)

- `app.css` defines every new token (`--sel-bg`, `--sel-fg`, `--seg-track`, `--dv-call`, `--dv-put`, `--pos`, `--neg`, `--warn`, `--dv-spot`, `--dv-iv`, `--dv-band`, `--seq-1..5`, `--div-n3..p3`, `--dur-1..4`, `--ease-std`) in the light block and in **both** dark blocks, and the two dark blocks are identical (string-compare their bodies).
- The dark `--background` lightness is ≤ 3 %.
- No `--seg-thumb` reference remains. No selected-state rule (`aria-pressed="true"`, `aria-selected="true"`, `.on`) outside the §3.3 block sets a `background` other than `var(--sel-bg)`. The table-row and live-toggle exceptions are listed by name.
- `index.html` has no `demo-banner`. Across `dashboard/*.js` (excluding tests), the literal "Demo data" appears only in the toolbar indicator code, and "Demo prices:" does not appear.
- No `ios-yellow` in `table.chain td.itm`. No `--itm-edge` with `ios-orange`.
- Every `@keyframes` used on Options pages has a matching `prefers-reduced-motion` rule (grep the names).
- Contrast: a small pure function in the test recomputes the §3.2, §3.3 and §4.1 pairs from the hex values in the doc table, which is mirrored as a JS object in the test. Inks must be ≥ 4.5 and fills ≥ 3.0.
- The format.test.mjs bans still pass (`viz.js` is in its list).
- Playwright audit (`scratchpad/fnd.cjs` extended):
  - 7 pages × 3 devices × 2 themes;
  - `scrollWidth === innerWidth`;
  - top-bar height ≤ 52 px plus the safe area;
  - one element matching `[data-demo-indicator]` visible per page;
  - the first chain data row has `getBoundingClientRect().top` ≤ 290 on desktop and ≤ 260 on phone;
  - computed `background-color` of a selected segment is rgb(255,255,255) in dark and rgb(10,10,11) in light;
  - read every screenshot.

---

## 12. MUST-DO (ordered by value)

1. **Near-black neutral dark theme and the clean light theme**: retune the §3.1 surface and §3.2 text tokens in app.css (light + both dark blocks, kept identical). Set `--wall-a` to transparent in dark, drop the drop-shadows on dark panels, set panel radius to 16 and panel gaps to 12.
2. **Contrast selected state everywhere**: add the `--sel-bg`/`--sel-fg`/`--seg-track` tokens and one §3.3 selector block covering segmented, tabs, scr-tabs, chips, presets, side buttons, filters, palette and the tab bar. Delete the 10 per-component selected rules and `--seg-thumb`. Restyle switch, checkbox and radio. Add the sliding thumb in `segmented()`. Table-row selection uses a fill plus a leading bar.
3. **Compact Options top bar**: add the `#toolbar-ctx` slot. desk.js mounts underlying, expiry, spot ±chg, lot, account+mode and the merged live/freshness control there. Remove the `.desk-top` panel, the toolbar clock and the refresh button on desk pages. Add the phone two-line selects and the ⋯ context sheet. Make the summary strip compact (60 px desktop, one scroll row on phone).
4. **Exactly one demo indicator**: keep the toolbar dot + "Demo" (dot badge on phone) with an explanation popover. Remove `#demo-banner`, `demoPill` on Home, the "Demo data:" prefix in OI and "Demo prices:" in arbitrage. Rename the server demo account to "Paper account". Hide the Paper badge when the label already says paper and remove the "· paper" suffixes.
5. **Data-viz colour tokens**: calls blue / puts orange, pos/neg, warn, spot = foreground, IV violet, band, today, grid/axis; the sequential violet ramp (5) and the diverging red–green ramp (7) with their ink tokens, in both themes, with the §4 contrast figures. Add `seqStep`/`divStep` in options.js with tests, and the hatch sprite in index.html.
6. **Chain base cleanliness** using those tokens:
   - neutral ITM fill instead of yellow;
   - neutral ITM boundary edge;
   - ATM strike as a contrast pill;
   - spot row capsule;
   - CALLS/PUTS headers in side colours;
   - coloured OI bars (call blue / put orange) with pos/neg change micro-bars;
   - build-up tags coloured by direction.
7. **Motion primitives**: duration and easing tokens, `barsEnter`/bar resize via `--v`, `flashValue` (shared `dv-flash` keyframes), the section enter on route change only, count-up on first KPI paint, one `dv-shimmer` skeleton, thumb slide, line reveal and the live-dot tick pulse. Every one has a reduced-motion fallback. Wire `animatePage` into the desk pages' first draw.
8. **Shared `viz.js`**: `legend`, `hbar`, `heatCell`, `spotPill`, `svgEl` and `scrubber`. Register it in `DASHBOARD_FILES` (core/app.mjs) and the format.test.mjs list, so the page units build OI, vol, screener, arb and positions visuals on one system.
9. **Finish and commit the PRD 08 working-tree work**:
   - create `polish.test.mjs` (the PRD 08 checks plus the §11 foundation checks);
   - delete the duplicate `.chain-tools .segmented.custom` rule;
   - fold the skeleton keyframes into one;
   - run `npx vitest run` and `npm run -s check:mjs`;
   - commit with `docs/prd/08-responsive-polish.md` and `docs/design/foundation.md`.
10. **Playwright audit**: 7 pages × phone/tablet/desktop × dark/light, with the §11 assertions (no horizontal scroll, top bar ≤ 52 px, one demo indicator, the selected segment colour per theme, the first chain row position). Read every screenshot before pushing.
