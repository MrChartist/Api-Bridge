# PRD 08: All-device polish pass for every Options page

Status: ready to build · Owner: Options desk · Round 1 (final pass after PRDs 01–07)

Pages in scope: `#/chain`, `#/strategy`, `#/oi`, `#/positions`, plus `#/vol` (PRD 05), `#/arb` (PRD 06) and `#/screener` (PRD 07) **if they have landed when this pass runs**. A page that has not landed is skipped. It is not built here.

Files:
- `server/bridge/dashboard/app.js`: shared state components (`loadingState`, `errorState`, an `emptyState` upgrade, `freshnessPill`), `touchWord()`, a `sheetPopover()` helper, and `table()` caption support.
- `server/bridge/dashboard/format.js` (+ `format.test.mjs`): `formatSignedRupee`, and `formatRupee` sign placement.
- `server/bridge/dashboard/desk.js`: toolbar, summary strip, chain head, Customise, ticket, builder, OI, positions (wiring only; the maths stays in `options.js`).
- `server/bridge/dashboard/views.js`: `arrangePanels` and `panelTools` behaviour on touch and phone, plus page subtitles.
- `server/bridge/dashboard/app.css`: sections 12b, 12c, 13 and the per-page sections added by PRDs 03, 05, 06 and 07 (`12d`, `12v`, `12a`, `12s`), plus a new block `12z · OPTIONS POLISH TOKENS` at the top of 12b.
- New test `server/bridge/dashboard/polish.test.mjs`: static checks that keep the rules below from regressing. It is pure (reads files) and has no DOM.
- No server change. No new endpoint.

Evidence: the audit screenshots in `/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/audit/*.png` (chain, OI and builder at 390/820/1440 in both themes; Customise on phone and desktop). Line numbers below refer to the working tree at the time of writing. Search by the quoted code, not by the number.

---

## 0. Principles (decisions; every fix below follows from one of these)

- **P1. One control, one place.** Underlying, expiry, account and live/pause appear once, in the fixed toolbar panel at the top of the page. A control is shown only on a page where it changes what that page shows.
- **P2. No duplicate readouts.** A figure appears once per screen. Spot, PCR, Max Pain and ATM IV live in the summary strip. The chain footer shows totals. Panels do not repeat them.
- **P3. One component per state.** Every page uses the same loading, empty, error, stale and market-closed components, in the same place: the body of the panel that is waiting.
- **P4. Touch and pointer get their own wording.** Phones never read "press B". Desktops never read "tap".
- **P5. Phone is a layout, not a squeezed desktop.** Below 720 px: one column, one side of the chain by default, sheets instead of popovers, no panel handles, a single-row stat strip.
- **P6. Hairlines and tokens only.** Rules are inset box-shadows of `var(--hl)` in `var(--mat-separator)`. There are no `border:` declarations in Options sections (outside `forced-colors`) and no raw colours outside tokens.
- **P7. Colour is never the only signal.** Every gain or loss carries a sign, every side carries CE or PE text or a position, and every ITM or ATM tint also has a non-colour cue.
- **P8. Keep the last good data.** A refresh never blanks a panel. Failure shows on top of stale data, with its age.

---

## 1. Goals per persona (what this polish pass must make true)

| Persona | Must be true after this pass |
|---|---|
| **Buyer** (phone-first, directional) | On a 390 px phone, the chain opens on ATM, one side, rows of at least 44 px. Premium, breakeven and P(ITM) read without ellipsis. A tap on bid or ask opens the ticket as a bottom sheet. The copy says "Tap", not "press B". |
| **Seller** (tablet or desktop, many legs) | Max loss, margin and credit are never truncated. Signs are consistent (`-₹1204`, never `₹-1204`). Avg price is visible on the phone positions view. "Unlimited" is spelled out. Clear has Undo. |
| **Hedger** | Net delta and its ₹ value read the same on every page, with the same label ("Net Δ") and sign rule. The Positions empty state links to the Chain and Strategy pages. |
| **Arbitrageur** (desktop, dense) | Desktop density is unchanged or better: no extra row heights at 1440, keyboard reach to every bid and ask in at most 2 Tab stops plus arrows, and a visible data age so a stale quote is never mistaken for live. |
| **Everyone** | No horizontal page scroll at 320 to 1440 px. Focus is always visible and never hidden under sticky bars. Light and dark both pass contrast. Every page has the same loading, empty and error look. |

---

## 2. Current implementation: keep / change / add / remove

### Keep
- Roving-tabindex chain rows (`tr tabindex="-1" aria-selected`), the screen-reader live region inside `createChain`, and the phone Calls | Puts | Both switch (`phoneSide`, `.phone-side`).
- The sticky thead and tfoot on `table.chain`, the `--hl` hairline token (0.5 px at 2 dppx), and the reduced-motion, reduced-transparency and forced-colors blocks at the end of app.css.
- `modal()` as a sheet on phones, `aria-live="polite"` on the ticket preview, and `arrangePanels` with keyboard move on the grip.
- The format.js house rule (no grouping, `--` for missing values).

### Change
| # | Today | After |
|---|---|---|
| C1 | Desk clock prints `01:08:04 20 ms`, which duplicates the top-bar clock (shown at ≥1180) and shows developer latency. | `freshnessPill(st)`: `as of 14:32:05`, or with a state, `Paused · 2 min old` / `Stale · 45 s old` / `Not updating · 2 min old`. No ms. The tooltip gives the source account and the full IST date-time. |
| C2 | `chain-title` `NIFTY 3 Nov · 5 days · lot 75` repeats the selects. | Removed. Days to expiry and the W/M tag move into the expiry `<option>` text (`3 Nov · 5d · W`). The lot moves to the underlying tile's sub-line (`lot 75 · Fut 26412 (+68.5)`). |
| C3 | `.desk-acct select { max-width: 210px }` truncates `Demo paper account · pa`. | `max-width: 280px` on tablet and desktop, with `text-overflow: ellipsis` and a `title` holding the full label. On phone it takes the full row (as today). The option text is shortened: `Demo paper account` plus a separate `Paper` badge after the select, never `· paper` in the option. |
| C4 | The account select is shown on OI (and on Vol, if present). | Rendered only for `kind ∈ {chain, strategy, positions}` and on any page whose PRD places orders (screener hand-off excluded). |
| C5 | `formatRupee(-1204)` → `₹-1204`, while `pnl()` → `-₹11711.25`. | New `formatSignedRupee(v, dp=2)` → `+₹1204.00` / `-₹1204.00` / `₹0.00`. `formatRupee` with a negative value also puts the sign first: `-₹1204.00`. One rule everywhere. ASCII hyphen-minus is kept for copy-paste and to match format.js. |
| C6 | Loading is `<p>Loading the chain…</p>` (desk.js `drawAll`), which shifts the layout. | `loadingState({ rows, cols, label })`: skeleton rows at the final row height inside the panel, with `aria-busy="true"` on the panel and one `sr-only` text "Loading the NIFTY 3 Nov chain". |
| C7 | Error is `alertBox(err)` with no retry, and it replaces the data. | `errorState(err, { onRetry, lastGood })`: the plain cause from `friendlyError`, a **Retry** button and `Showing data from 14:31:58` when old data stays visible. Without data, it sits in the panel body. With data, it is a slim bar at the top of the panel and the data stays. |
| C8 | Empty states mix `emptyState`, `p.desk-empty` and `p.desk-empty.flush`. | All use `emptyState(icon, title, body, action)`, with a compact variant `emptyState(..., { compact: true })` for in-card use (no icon tile, 16 px padding). `p.desk-empty` is deleted from desk.js and app.css. |
| C9 | Copy says "press B / S on a strike" and "press ⇧B / ⇧S" on touch screens. | `touchWord()` returns `"Tap"` or `"Click"`. Key hints are appended only when `!matchMedia("(pointer: coarse)").matches \|\| matchMedia("(any-pointer: fine)").matches`. |
| C10 | `.desk-keys` hidden by `pointer: coarse`. | Hidden when `(pointer: coarse) and (not (any-pointer: fine))`, so tablets with keyboards keep the hints. Always hidden below 720 px. |
| C11 | Panel tools (26×20 pill) are always visible on touch and overlap panel content (`lot 75`, stat tiles). | Below 720 px, `.panel-tools` gets `display: none` (one column, nothing to rearrange, maximise is pointless). On touch from 720 px up, the tools sit **in flow** in a 44 px gutter at the panel's top-right (`.movable { padding-top: 0 }`, and the tools become `position: static` inside the panel head row when the panel has a `.card-head` or `.desk-head`; otherwise there is a 44 px reserved strip). They never overlap content. |
| C12 | Customise is an absolute popover inside an `overflow: hidden` panel, clipped and under the tab bar on phone (cust-phone.png). | `sheetPopover()`: below 720 px it opens in `#dialog` as a bottom sheet (the `modal()` sheet pattern) with `aria-modal="true"`. From 720 px up it is a popover attached to `document.body` and positioned against the trigger rect (clamped to the viewport), so it is never clipped. In both: focus moves to the first control, Tab is trapped, Esc closes, focus returns to the trigger, and presets carry `aria-pressed`. |
| C13 | Summary strip: 8 tiles stack in 4 rows on phone (about 300 px before the chain). | Phone: one horizontal row, `overflow-x: auto; scroll-snap-type: x mandatory`, tiles 132 px wide and 64 px tall, with a 16 px fade mask on the trailing edge. The row scrolls inside itself, never the page. Tablet: 4 columns × 2 rows. Desktop: 8 in one row (as today). |
| C14 | Chain head wraps to 3 rows on phone. | Phone chain head is one row: `[Calls\|Puts\|Both] [±strikes select] [Customise icon-only 44×44]`. The OI/Greeks/Value view segment moves inside Customise on phone. Tablet and desktop: one row, with labels. |
| C15 | Strike tags at 8.5 px. | 10 px, weight 650, `letter-spacing: 0.02em`. Text stays: `ATM`, `Max Pain`, `±1σ`, `Put wall`, `Call wall` (C17). |
| C16 | Footer totals row has no label. | The footer strike cell reads `Total`, and PCR stays labelled. |
| C17 | Wording drift (see §6 glossary). | One term per concept, everywhere: tiles, tags, column headers, Customise labels, tooltips and subtitles. |
| C18 | Ticket quote grid: 5 cells → 3 columns on phone, so IV and Δ wrap and leave a gap. | Phone: 5 compact columns (`grid-template-columns: repeat(5, minmax(0, 1fr))`), values 13 px, labels 10.5 px. If the width is under 340 px, Δ moves into the ticket header sub-line and the grid drops to 4. |
| C19 | Ticket account label wraps (`· paper` on its own line). | Account label plus a `Paper`/`Live` badge on one line. The label ellipsizes; the badge never wraps. |
| C20 | Place button found with `document.querySelector("#dialog .dialog-actions button:last-child")`. | `modal()` buttons accept `{ id }` / return refs. The ticket keeps a direct reference. Tab order is side segment → qty → order type → price → product → Place. |
| C21 | Builder key numbers ellipsized on phone (`+₹3266…`). | Phone: a 2-column grid. Money values never ellipsize (`white-space: normal; overflow-wrap: anywhere` is off; the font scales `clamp(14px, 4.2vw, 17px)`). All ₹ in the builder use 0 dp (`formatSignedRupee(v, 0)`). Premiums per unit keep 2 dp. |
| C22 | Clear and Place sit in the card head, far from the legs on phone. Clear has no undo. | Phone: a sticky bottom action bar (`position: sticky; bottom: calc(var(--tabbar-h) + var(--safe-b))`) holding `Clear` (secondary) and `Place n legs` (primary). Clear shows a toast with **Undo** (5 s) that restores the legs. Desktop and tablet: unchanged place, plus Undo. |
| C23 | Payoff readout says "Hover the chart…". | `${touchWord()} or drag on the chart`, plus keyboard scrubbing: the SVG gets `tabindex="0"`, ←/→ move by one strike step and Shift by 5, and a key-numbers `<dl>` under the chart is the text equivalent. X ticks use `niceTicks`. Breakeven labels are offset above the zero line with collision nudging (min 4 px gap; if two collide, merge into `BE 25906 · 26420`). |
| C24 | The builder card is `.card` and the summary is `.desk-panel`, so radius and shadow differ. | Every top-level panel on an Options page is `.desk-panel` (cards inside are fine). One radius (`--r-panel`), one shadow. |
| C25 | OI chart on phone: 19 px axis text in viewBox units crowds; 2 y ticks; the spot label overlaps the bars; the legend wraps. | The viewBox width follows the container (`W = clamp(container, 320, 1100)`), so text is a true 11 px. Y ticks come from `niceTicks(0, max, 4)`. The spot label gets its own lane above the plot. The legend goes on its own line under the chart on phone. A table alternative goes in `<details>` "Show as table" (strike, CE OI, PE OI, CE chg, PE chg). Puts are drawn with a 45° hatch pattern (SVG `<pattern>`) as well as colour. |
| C26 | Positions hides Avg on phone (`.table-wrap .opt-x`). | Avg stays visible. LTP's sub-text (change) is hidden instead. Exit is a `button.small` (same style as Exit all). |
| C27 | Subtitles promise things the page lacks (OI: "build-up and walls"; Positions: "Greeks"). | Subtitles describe what is actually shown (§6.3). If PRD 03/04 landed the feature, keep the wording. |
| C28 | Breakpoints in Options CSS: 719/720, 761, 899, 1023/1024, 1099, 1279. | Options sections use only **720, 1024, 1280** (plus 360 for very small phones). The OI `.grid.cols-2` stacking at 899 moves to a desk-specific `.desk-grid-2` that stacks below 1024. Global (non-Options) queries are not touched. |

### Add
- A1 `freshnessPill`, `loadingState`, `errorState`, `emptyState` compact variant, `touchWord`, `sheetPopover` (app.js).
- A2 `formatSignedRupee` (format.js) with tests.
- A3 A **Market closed** state: when `freshness.marketOpen === false` or, with no flag, when IST is outside 09:15–15:30 on a weekday or it is a weekend, the pill reads `Market closed · last 15:29:59` and auto-refresh drops to 30 s. Never shown as an error.
- A4 A **No broker connected** state on trading pages with no tradable account: an `emptyState` in the ticket area, `Connect an account to trade` with a link to `#/accounts`. The chain still renders, because data comes from the demo or any data account.
- A5 `<caption class="sr-only">` on every Options table (`NIFTY 3 Nov option chain, 24 strikes`), and `aria-label` on each bid and ask button: `Sell NIFTY 3 Nov 26400 CE at 112.50`.
- A6 `scroll-padding-top` and `scroll-padding-bottom` on `.desk-chain .table-wrap` equal to the thead and tfoot heights, and `scroll-margin-bottom: calc(var(--tabbar-h) + 16px)` on focusable rows on phone and tablet (WCAG 2.4.11).
- A7 A sticky strike column on any one-sided view (`side-ce`, `side-pe`, phone `ce`/`pe`): `position: sticky; left: 0` for CE-only, `right: 0` for PE-only (strike sits on the outer edge there), `z-index: 2` (thead strike `z-index: 4`), with an inset hairline on the inner edge. Both-sides view: no sticky column (it cannot work for two sides). On phone, "Both" shows the compact 3+1+3 preset (§3.3).
- A8 `polish.test.mjs` (§10.1).
- A9 The chart-engine slot uses one shared `chartSlot(label)` (fixed `aspect-ratio: 16 / 7` on desktop and tablet, `4 / 3` on phone, dashed hairline, centred `Chart engine slot` caption). It replaces any page-specific placeholder created by PRDs 02, 05 and 07, so there is one look.

### Remove
- R1 The `ms` latency figure (`st.ms` stays in state for debugging only).
- R2 `.chain-title` (DOM and CSS).
- R3 `p.desk-empty`, `p.desk-empty.flush`, and the `"Loading the chain…"` paragraph.
- R4 The account select on OI and Vol.
- R5 Duplicate PCR, Max Pain or ATM IV readouts inside panels other than the summary strip and the chain footer, including any added by PRDs 03 and 05: keep the strip one, and replace the duplicate with a pointer only if the panel needs it for context.
- R6 Panel tools below 720 px.
- R7 Any `border:` declaration in Options CSS sections (convert to inset `box-shadow` with `--hl`), except inside `@media (forced-colors: active)`.

---

## 3. Layout per device

Widths: content width = viewport − sidebar − gutters. Phone 390 → content 358. Tablet 820 portrait → about 770 (no sidebar below 1024; the tab bar is at the bottom). Desktop 1440 → about 1170.

### 3.1 Toolbar (fixed panel, every Options page)
- **Desktop (≥1024):** one row: `[Underlying ▾] [Expiry ▾ "3 Nov · 5d · W"] [Account ▾ (trading pages)] [Paper badge]` · spacer · `[freshness pill] [Live/Paused toggle]`. Height 52 px.
- **Tablet (720–1023):** the same row. If it overflows, the account select wraps to a second row at full width, and the pill plus toggle stay on row 1. Height 52 or 96 px.
- **Phone (<720):** row 1 `[Underlying ▾][Expiry ▾]` (two equal columns); row 2 `[Account ▾ (flex 1)][Live toggle 44px]`, with the freshness pill as the toggle's sub-text below 360 px or inline otherwise. On non-trading pages row 2 is `[freshness pill][Live toggle]` on the right. Controls are 44 px tall.

### 3.2 Summary strip
Desktop: 8 tiles in 1 row, tiles 72 px tall. Tablet: 4×2. Phone: 1 scrolling row (C13). Tile label 11 px uppercase-free (sentence case), value 17 px tabular, sub 11.5 px. A tile never ellipsizes its value. It may ellipsize its sub, with the full text in `title`.

### 3.3 Chain
- **Desktop:** both sides, preset columns as configured, rows 32 px (compact 28 px option kept), strike column 90 px centred, keyboard hints row below the chain (one line, 12 px).
- **Tablet portrait:** both sides with **at most 4 columns per side** by default (`OI bar, OI chg, LTP, Bid/Ask` merged) unless the user chose more in Customise, in which case the table scrolls inside `.table-wrap`. Rows 40 px on coarse pointers. Tablet landscape (1180) behaves as desktop.
- **Phone:** default `phoneSide = "ce"`, with columns `LTP · Chg · OI (bar) · IV · Bid · Ask` and the sticky strike on the outer edge. "Both" uses a 3+1+3 compact set: `OI bar · LTP` | Strike | `LTP · OI bar` (bid and ask open from a row tap via the action sheet from PRD 01). Rows 44 px. The ATM row is scrolled into view on first load and on expiry change (`block: "center"`). The ATM pill (`.atm-pill`) shows when ATM is out of view.
- Footer tfoot: `Total` + CE OI total, PE OI total, PCR. Sticky bottom, and it sits above the tab bar on phone (the wrapper's max-height accounts for `--tabbar-h`).

### 3.4 Strategy
- Desktop: presets row, legs table and payoff in two columns (legs 5/12, payoff 7/12), key numbers in 4 columns under the payoff, actions in the head.
- Tablet: one column: presets, legs, payoff (`aspect-ratio 16/9`), key numbers in 4 columns.
- Phone: presets as a horizontal chip scroller (chips 44 px tall), legs as stacked cards (side/strike/right in the title row, qty stepper 44 px, price), payoff `aspect-ratio 4/3`, key numbers in 2 columns, sticky action bar (C22).

### 3.5 OI
- Desktop: chart, then the build-up and walls panels in 2 columns (if PRD 03 landed).
- Tablet: one column. The chart is full width at `aspect-ratio 16/9`.
- Phone: chart at `aspect-ratio 4/5` with **horizontal bars** (strike on the y axis, calls extending left and puts right, a butterfly layout), because 24 vertical bar pairs cannot be read in 358 px. The mode segment (OI / Change) sits on its own row above, the legend under the chart, and "Show as table" under that.

### 3.6 Positions
- Desktop: table with Instrument, Qty/Lots, Avg, LTP, P&L, Δ, θ, Exit. Totals row. Analyse button in the head.
- Tablet: same table; θ hidden below 900 px content width (`opt-x` priority), never Avg.
- Phone: stacked rows from `table(…, { mobile: "stack" })`: title `NIFTY 3 Nov 26400 CE`, then Qty, Avg, LTP, P&L (signed, coloured plus sign), and the Exit button full width (44 px). An Exit all bar sits at the bottom, sticky above the tab bar, and shows a spread warning count when any leg's spread is more than 5 % (`Exit all at market · 2 legs have wide spreads`).

### 3.7 Vol / Arb / Screener (if landed)
Apply §3.1 and §3.2 and the state components. Their own PRDs define the bodies. This pass checks them against §5 (state matrix) and §9 (accessibility checklist) and fixes deviations only.

---

## 4. Every number shown: format policy (one decimal policy per field)

| Field | Format | Helper | Edge cases |
|---|---|---|---|
| Premium, LTP, bid, ask, avg | 2 dp | `formatFixed(v, 2)` | null → `--`; 0 bid → `--` (no bid). |
| Change (premium) | signed, 2 dp | `formatSigned(v, 2)` | 0 → `0.00` (no sign). |
| Strike | integer (or 1 dp if it is fractional) | `formatInt` / `formatFixed(v,1)` | |
| Spot, future | 2 dp in tiles, integer in labels and ticks | | |
| IV | 1 dp `%` in cells, 2 dp in the ATM IV tile | `formatPercent` | IV ≤ 0 or > 300 → `--`. |
| Δ | 2 dp, signed for net | `formatFixed(v,2)` / `formatSigned` | |
| Γ | 4 dp | | |
| θ, ν per unit | 2 dp | | |
| θ, ν per lot or book (₹) | `formatSignedRupee(v, 0)` | | |
| OI, volume, OI chg | `formatCompact` (signed for chg) | | missing OI chg → `--`, not `0`. |
| Money: P&L, credit/debit, max profit/loss, margin | `formatSignedRupee(v, 0)` in builder and summary; 2 dp in positions rows | | unbounded → `Unlimited` (never `∞`, never a number). |
| PCR | 2 dp | `formatFixed(v,2)` | CE OI 0 → `--`. |
| Probabilities (P(ITM), POP) | 0 dp `%` | `formatPercent(v,0)` | <1 → `<1%`, >99 → `>99%`. |
| Days to expiry | `5d`, `<1d` on expiry day, then `4h 10m` in the pill | `O.timeToExpiry` label | expired → `Expired`. |
| Data age | `12 s old`, `2 min old`, `1 h old` | new `ageText(ms)` in app.js (whole units, no decimals) | negative or clock skew → `just now`. |

**Formula for data age:** `ageMs = Date.now() − Date.parse(freshness.asOf)`. Stale when `freshness.stale` is true, or when `ageMs > 3 × REFRESH_MS` while live.

**formatSignedRupee(v, dp=2):** `!isFigure(v)` → `--`; `t = formatFixed(Math.abs(v), dp)`; `Number(t) === 0` → `₹${t}`; else `${v > 0 ? "+" : "-"}₹${t}`. Tests: `1204.5→"+₹1204.50"`, `-1204.5→"-₹1204.50"`, `-0.004→"₹0.00"`, `null→"--"`, `(1e7, 0)→"+₹10000000"` (no grouping).

`formatRupee(v)` change: a negative value prints `-₹1204.00`. Update its doc comment and any test that asserted `₹-`.

---

## 5. States: one matrix for every Options page

| State | Trigger | What renders | Where |
|---|---|---|---|
| Loading (first) | no data yet | `loadingState({ rows: 12, cols })`: skeleton rows at the final row height (chain 32/40/44 px by device), a shimmer that is static under reduced motion, `aria-busy="true"` | body of each waiting panel; the toolbar is live at once |
| Refreshing | a poll in flight | nothing visible (no spinner); the pill keeps `as of` | |
| Stale | `freshness.stale` or age > 3 × refresh | pill turns amber: `Stale · 45 s old` | toolbar pill, on all devices (visible on phone too) |
| Paused | user paused | pill: `Paused · 2 min old`; the toggle reads `Paused` | toolbar |
| Error with data | fetch fails, last good kept | `errorState(err, { onRetry, lastGood })` as a slim bar at the top of the panel: `Couldn't refresh: Broker session expired. Showing 14:31:58. [Retry]`; pill `Not updating · 2 min old` | top of the affected panel |
| Error without data | first fetch fails | `errorState` card in the panel body with Retry, the plain cause from `friendlyError`, and a link to Accounts when the cause is a session or auth problem | panel body |
| Empty | valid response with no rows | `emptyState` (§6.2 copy), one action | panel body |
| Market closed | §2 A3 | pill `Market closed · last 15:29:59`; data shown normally | toolbar |
| No account | no tradable account | ticket area: `Connect an account to trade` → `#/accounts`; chain still shows | ticket and positions |
| Expired expiry | selected expiry < today | auto-select the next expiry plus a toast `3 Nov expired; showing 10 Nov` | |

Retry calls the page's existing `refresh()` immediately and resets the backoff. An error is announced once through the app's `announce()` live region, never per tick. The chain contains **no** live region for prices: the existing `createChain` `live` region only announces focus moves (row, side) and must not be written on ticks. Add a test hook to assert this (§10.2).

---

## 6. Wording

### 6.1 Glossary (one term per concept; applies to headers, tags, tiles, Customise labels, tooltips)
| Concept | Use | Never |
|---|---|---|
| Option sides (headers, segments) | **Calls / Puts** | CE/PE in headers |
| Contract names, legs, tickets, aria-labels | **CE / PE** (`NIFTY 3 Nov 26400 CE`) | Call/Put inside a contract name |
| Quantity unit | **Lots** when the "values in lots" setting is on, otherwise **Qty**; the header switches, the column does not duplicate | "Quantity", "Lot(s)" |
| Open interest change | **OI chg** (header and Customise) | "OI change", "Chng in OI" |
| Spread | **Spread %** | "Spread" for a percentage |
| Premium traded | **Premium traded** (header `Prem. traded` only below 1024 px) | "Traded" |
| Probability | **P(ITM)** for a single option, **POP** for a strategy | "Win chance" |
| Biggest OI strikes | **Call wall / Put wall** (tiles and strike tags) | "Support / Resistance" |
| Max pain | **Max Pain** | "Max pain", "MaxPain" |
| Expected move band | **±1σ** (tag) and **Expected move** (tile) | "1SD", "±1 SD" |
| Margin | **Margin** (ticket: `Margin (est.)`) | "Carry (NRML)" |
| Settings popover | **Customise** | "Settings", "Configure" |
| Pause | **Live / Paused** | "Streaming", "Auto" |
| Net delta | **Net Δ** | "Delta (net)" |

### 6.2 Empty-state copy (touch word in braces resolves via `touchWord()`; key hint appended only with a fine pointer)
- Chain, no strikes: title `No strikes for NIFTY 3 Nov`, body `This expiry has no listed strikes yet. Pick another expiry.`, action `Next expiry` (button).
- Strategy, no legs: title `Build a strategy`, body `Pick a ready-made strategy above, or {Tap} a bid or ask in the Option Chain and choose "Add to strategy".` + ` Keys: ⇧B / ⇧S on a strike.`, action `Open Option Chain`.
- Positions, none: title `No open NIFTY options`, body `{Tap} a bid or ask in the Option Chain to trade, or build a strategy first.` + ` Keys: B / S on a strike.`, actions `Open Option Chain` (primary) and `Strategy Builder` (link).
- OI, no OI data: title `No open interest yet`, body `The broker returned no OI for NIFTY 3 Nov. It usually appears after the first trades of the day.`
- Positions page subtitle, Analyse with nothing held: `Nothing to analyse for NIFTY 3 Nov.`

### 6.3 Page subtitles (views.js PAGES `sub`; keep to what is on the page)
- chain: `Live chain with OI, IV and Greeks. {Tap|Click} a bid or ask to trade` (computed at render).
- strategy: `Payoff, breakevens, POP and margin before you trade`.
- oi: `Open interest and OI chg by strike` (+ `, build-up and walls` only if PRD 03 shipped them).
- positions: `Open option positions with P&L, net Δ and θ`.

---

## 7. Settings (persisted; no new settings keys except two)
- Existing chain config (`mcb.dashboard.desk` → `cfg`: columns, order, presets, phoneSide, tags) is unchanged. `chainConfig(saved)` keeps validating.
- New `cfg.rowDensity: "auto" | "compact"` (default `auto` = 32/40/44 px by device; `compact` = 28 px on every device, a user choice that overrides the 44 px phone row). It lives in Customise under "Rows". Validated in `chainConfig`.
- New `cfg.lotsView: boolean` is **not** added here if PRD 01 or 04 already defines one. If neither does, add it (default false). Ticket, legs, positions and the chain qty columns read the same flag.
- Panel layout per page (`mcb.dashboard.layout.<page>`) is unchanged. On phone the saved order still applies, but it cannot be edited there (R6).
- All reads go through try/catch (existing `readPrefs`). An invalid value falls back to the default silently.

---

## 8. Interactions and keyboard
- Tab order on every Options page: toolbar controls → summary strip (tiles are not focusable unless they are actionable) → page body. Each panel's first interactive control is reached in one Tab.
- Chain: one Tab stop for the grid (the roving row). ↑/↓ or J/K move rows, ←/→ move between bid and ask cells of the focused side, Enter opens the ticket for the focused cell, B/S buy or sell, G goes to ATM, Esc leaves the grid to the chain head. The bid and ask `<button>`s carry `tabindex="-1"` except the active one. **Acceptance:** 10 or fewer Tab stops from the page top to the first bid button on `#/chain` at 1440 px.
- Customise (C12): focus trap, Esc, focus return, `aria-pressed` on presets. Column reorder by keyboard: each row has Move up / Move down buttons (44 px on coarse pointers), and `aria-live` announces `IV moved to position 4`.
- Panel grip (≥720 px): ↑/↓ move (as today), Home/End move to the first or last position, double-click or `R` on the grip resets the layout (with a confirm toast and Undo).
- Payoff scrubbing (C23).
- Clear legs → toast with Undo (C22). Exit all → confirm sheet that lists legs, marks wide spreads, and defaults focus to Cancel.
- Focus rings: `:focus-visible { outline: 2px solid hsl(var(--ios-blue)); outline-offset: 2px }` on every interactive element in Options sections. Inside tables use `outline-offset: -2px` so sticky neighbours do not clip it. Contrast ≥3:1 against both themes' surfaces (blue on white 4.5:1, on `#1c1c1e` 5.1:1).

---

## 9. Accessibility checklist (each item is verified in §10)
1. Every `<table>` has a caption (sr-only allowed) and `th scope`.
2. Every icon-only button has `aria-label`. The Customise icon on phone gets `aria-label="Customise the chain"`.
3. Every SVG chart has `role="img"`, an `aria-label` summarising it, and a text equivalent (key-numbers list or "Show as table").
4. Touch targets ≥44×44 on `(pointer: coarse)` for `.q-btn`, `.side-btn`, `.chain-tools .segmented button`, `button.preset`, `.live-toggle`, `.panel-tools button`, `.atm-pill`, Customise reorder buttons, qty steppers, and the payoff scrub area. ≥24×24 on fine pointers.
5. Text ≥10 px everywhere in Options sections (strike tags were 8.5). Body numbers ≥12 px on phone.
6. Contrast: text ≥4.5:1 (≥3:1 for 14 px bold or larger). OI bars, ITM tint edges, ATM marker and focus ring ≥3:1 against the row background, in light and dark. Where a tint cannot reach 3:1 (ITM fill), add a non-colour cue: an inset 2 px left rule in `--ios-yellow-ink` on ITM cells adjacent to the strike, and ATM keeps its `ATM` tag.
7. Gains and losses always carry `+`/`-`. OI bars: calls solid, puts hatched (C25).
8. `prefers-reduced-motion`: no tick flash animation (use a static 1 s background tint without transition), no skeleton shimmer, no sheet slide (instant).
9. `forced-colors`: hairlines become `CanvasText` borders, selected or ATM rows use `Highlight`, OI bars use `CanvasText` fill with hatch for puts, and focus uses `Highlight`.
10. Focus not obscured: A6.
11. Reflow at 320 px: no page horizontal scroll. Tables scroll inside their wrapper, and the strike column stays sticky on one-sided views.
12. Status messages: one polite region (app `announce`) for order results, errors, expiry changes and Undo, never for ticks.

---

## 10. Test plan

### 10.1 Unit and static tests
- `format.test.mjs`: `formatSignedRupee` cases (§4) and `formatRupee` negative sign-first.
- `options.test.mjs`: `niceTicks` if it moves to options.js (move it from desk.js: pure maths belongs there) with cases `(25344, 27120, 5)` → round steps of 250 or 500, `(0, 0, 4)` → `[0]`, negative ranges. Add `ageText` tests in `app.test.mjs` if app.js already has a test harness for pure helpers; otherwise put `ageText` in format.js and test it there.
- New `polish.test.mjs` (reads files as text):
  - Options CSS sections (12b…12z) contain no `font-size` or `font:` value below 10px.
  - The same sections contain no `border:`/`border-(top|right|bottom|left):` outside `@media (forced-colors`.
  - Options CSS media queries use only widths from {359/360, 719/720, 1023/1024, 1279/1280}.
  - desk.js (and any `strategy.js`, `oi.js`, `screener.js`, `vol*.js`, `arb*.js` present) contain no `desk-empty`, no `"Loading the chain"`, no `press B`/`press ⇧B` outside a key-hint branch (assert the strings appear only inside a `keyHint(` call), no `" ms"` label, no `₹-`.
  - Every dashboard file using `document.querySelector("#dialog .dialog-actions` fails the test.
  - The `@media (pointer: coarse)` block lists the selectors in §9.4.
- Existing suites: `npx vitest run server/bridge/dashboard`, then `npx vitest run` and `npm run -s check:mjs`, all green.

### 10.2 Playwright audit (copy `scratchpad/desk.cjs` to `scratchpad/polish.cjs`)
For each page in {chain, strategy, oi, positions, vol?, arb?, screener?} × viewport {390×844, 820×1180, 1440×900, plus 320×640 reflow-only} × theme {light, dark}:
1. Screenshot to `scratchpad/shots/polish-<page>-<w>-<theme>.png`, and **open and look at every one**.
2. Assert `document.documentElement.scrollWidth <= innerWidth`.
3. Assert no element's text is `null` or `undefined` and no visible text contains `NaN`.
4. Assert no visible `.value` (tiles, key numbers) has `scrollWidth > clientWidth` (no truncated money).
5. With `hasTouch: true, isMobile: true` at 390 and 820: every visible button, `[role=button]`, `select` and `input` in `#content` has a bounding box ≥44×44 (list offenders and fail on any).
6. Assert no `.panel-tools` is visible at 390, and none overlaps a sibling's text at 820 (box intersection test).
7. Tab from the top on `#/chain` at 1440: the count to the first `.q-btn` is ≤10, and every focused element is fully inside the viewport and not under a sticky element (elementFromPoint at the focus rect centre returns the element or its descendant).
8. Customise at 390: it opens as `dialog[open].sheet`, Esc closes it, and focus returns to the trigger.
9. Force an error: route `/v1/optionchain` to 503 after the first load. Assert the data stays, the error bar shows Retry, and the pill reads `Not updating`. Retry with the route restored recovers.
10. Force empty: route `/v1/positions` to `[]`. Assert one `.empty` with an `Open Option Chain` link.
11. First load with a delayed chain (1.5 s): assert skeleton rows exist and CLS between skeleton and data is under 0.05 (measured with PerformanceObserver `layout-shift`).
12. Emulate `prefers-reduced-motion: reduce` and `forced-colors: active` once each at 1440 and take screenshots.
13. Emulate `pointer: coarse` at 1440 (tablet with keyboard is not emulatable; check that `.desk-keys` is hidden on the phone context and shown on the desktop context).

### 10.3 Gates
All unit suites green, `check:mjs` clean, Playwright script exits 0, screenshots reviewed. Commit in small slices (state components; format; toolbar and strip; chain; Customise sheet; strategy; OI; positions; panel tools; wording; tests), each one green.

---

## 11. Data and API
- No new endpoint. Uses `freshness` from the existing chain response (`asOf`, `stale`, `accountId`, and `marketOpen` if present; if not, the IST-hours rule in A3).
- W/M expiry tag: monthly = the last expiry of its calendar month in the `/v1/expiries` list for that underlying. It is derived from data, never from a hard-coded weekday.
- The lot size always comes from the chain or instrument data. When it is missing, show `lot size unavailable` in the tile sub-line and disable lots view (never assume 1).

## 12. Performance
- No extra requests. Skeletons are static DOM (no timers).
- Chain patching stays cell by cell. The polish must not cause full re-renders on tick: `freshnessPill` updates its text node only, and the stale timer is one `setInterval(1000)` per page, cleared on page leave.
- Popover positioning: one `getBoundingClientRect` on open plus one on `resize`/`scroll` (rAF-throttled).
- The OI chart's responsive viewBox is recomputed on `ResizeObserver` with a 100 ms debounce, only when the width changes by more than 24 px.
- Budget: no new long tasks over 50 ms on chain refresh at 1440 (check with the Performance panel or the `longtask` observer in the Playwright script, recorded, not gating).

---

## 13. MUST (this round), in build order
1. **State components** (`loadingState`, `errorState` with Retry and last-good, compact `emptyState`, `freshnessPill` with `ageText`, `touchWord`) wired into every Options page, replacing the `Loading the chain…` paragraph, `p.desk-empty`, and the bare `alertBox` (C6–C9, A3, A4, §5).
2. **Sign and format consistency**: `formatSignedRupee`, sign-first `formatRupee`, the §4 precision table applied, 0 dp ₹ in the builder (C5, C21 money part).
3. **Builder on phone**: no truncated key numbers (2 columns, clamp font), a sticky action bar, Clear with Undo (C21, C22).
4. **Sticky strike column** on one-sided views, the phone compact "Both" preset, and ATM scrolled into view (A7, §3.3).
5. **Customise as a bottom sheet** on phone and a body-attached popover from 720 px up, with focus trap, Esc, return, `aria-pressed`, and keyboard reorder (C12).
6. **Panel tools**: hidden below 720 px, in-flow and non-overlapping on touch tablets (C11).
7. **Touch targets** ≥44 on coarse pointers for every control in §9.4, and strike tags at 10 px (C15).
8. **Toolbar clean-up**: remove the ms figure and `chain-title`, `3 Nov · 5d · W` expiry options, lot in the tile, account select width and badge, account select only on trading pages (C1–C4, R1, R2, R4).
9. **Summary strip** as one scrolling row on phone, 4×2 on tablet (C13), and the one-row chain head on phone (C14).
10. **Ticket**: 5-column quote grid on phone, account badge, direct Place reference and Tab order (C18–C20).
11. **Payoff**: touch and keyboard scrubbing, key-numbers text equivalent, `niceTicks` x axis, breakeven label collision (C23).
12. **OI chart**: responsive viewBox, horizontal butterfly bars on phone, 4 y ticks, spot lane, hatch for puts, "Show as table" (C25).
13. **Positions**: Avg visible on phone, consistent Exit buttons, empty state with links, Exit all spread warning (C26, §3.6, §6.2).
14. **Wording**: glossary applied everywhere, footer `Total`, subtitles truthful (C16, C17, C27, §6).
15. **Hairlines, breakpoints and tokens**: no `border:` in Options CSS, breakpoints 720/1024/1280 only, `.desk-panel` on every top-level panel, ITM/ATM non-colour cues, focus rings, scroll-padding (C24, C28, R7, A6, §9).
16. **A11y semantics**: table captions, bid and ask aria-labels, no live region on ticks (A5, §5).
17. **Shared `chartSlot`** placeholder adopted by every page that has one (A9).
18. **Tests and verification**: `polish.test.mjs`, the format and options tests, and the Playwright audit at 4 widths × 2 themes with every screenshot read (§10).

## 14. LATER
- L1 Phone swipe left/right on the chain to change **expiry** (Kite). Today's swipe changes side; doing both needs a gesture design.
- L2 Kite-style `P` badges on held strikes with a tap popover (Qty, Avg, P&L, Exit / Add). Belongs with PRD 01/04 follow-ups.
- L3 Font-size setting S / M / L (Sensibull).
- L4 Long-press on a panel head (phone) for Move up / Move down / Reset layout.
- L5 Full `role="grid"` with per-cell focus (today: row focus plus ←/→ between bid and ask).
- L6 Strike sort ascending or descending.
- L7 Percentage-change toggle (absolute or %) on the chain.
- L8 An automated contrast check over computed styles in the Playwright run (today the token pairs are checked by hand in §9.6).
- L9 A landscape-phone layout (844×390) tuned separately; today it falls into the tablet rules by width.

## 15. OUT OF SCOPE
- **Charts:** any price or time chart. Only the shared `chartSlot` placeholder is in scope. No chart library.
- New features or maths from PRDs 01–07 that have not landed. This pass polishes what exists, and does not build missing pages or panels.
- Server or API changes, order-safety changes (paper default, live opt-ins, preview gates are untouched), broker integrations.
- Non-Options pages and global (non-Options) CSS breakpoints, except shared components in app.js whose change is backwards compatible (`emptyState` gains an optional 5th argument; `modal()` gains optional button ids).
- Translations or a locale other than en-IN, and number grouping (the house rule stays: no grouping commas).

## 16. Suggested split (three agents)
- **Agent A (foundations):** MUST 1, 2, 7, 8, 9, 15, 16, plus `polish.test.mjs` and the format tests.
- **Agent B (chain, ticket, Customise, positions):** MUST 4, 5, 6, 10, 13, 14.
- **Agent C (strategy, OI, charts, verification):** MUST 3, 11, 12, 17, plus the Playwright audit (§10.2), which runs last over everyone's work.

Agents A and B both touch `desk.js`: A owns the toolbar, strip and state wiring (functions `renderDesk` top, `drawAll`, `drawClock`, `drawStats`); B owns `createChain`, `openTicket`, Customise, and the positions drawing. Merge A first.
