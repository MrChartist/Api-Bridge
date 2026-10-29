# PRD 07: Option Screener, page `#/screener`

Status: ready to build · Owner: Options desk · Round 1

Files:
- New `server/bridge/dashboard/screener.js`: the page UI (`renderScreenerPage`), scan queue, table and cards, filter sheet, detail panel.
- New `server/bridge/dashboard/screens.js`: **pure** preset registry, config validation, filter funnel, sort, reason strings, desk hand-off. No DOM, no fetch. Tested in the new `screens.test.mjs`.
- `options.js` and `options.test.mjs`: all new maths (per-leg metrics, scores, costs, skew, hedge, HV).
- `desk.js`: export the underlying lists, read the one-shot hand-off focus, use `O.unusualVolume` (moved).
- `views.js`: PAGES entry and import.
- `app.js`: one new icon, `radar`.
- `app.css`: new section `12s · SCREENER`.
- `server/bridge/core/app.mjs`: add `screener.js` and `screens.js` to `DASHBOARD_FILES`.
- `format.test.mjs`: add `screener.js` and `screens.js` to the file list.

No new API endpoint this round.

---

## 0. Decisions

**D1. One new page, not a panel.** `{ id: "screener", label: "Option Screener", short: "Screener", icon: "radar", tint: "yellow", group: "Options", layout: "desk", title: "Option Screener", sub: "Scan every underlying and expiry for unusual activity, build-ups, rich or cheap premium, hedges and arbitrage", render: renderScreenerPage }`.
- Place it directly after `oi`, or after `vol` if PRD 05 has landed. Not in the phone tab bar.
- Every other Options page shows one underlying and one expiry. This page ranks across all of them. No Indian retail tool does that per strike (Sensibull Options Central ranks underlyings only; Dhan, Opstra and Quantsapp show one chain at a time). That gap is the product.
- Label it "Option Screener" so it is not confused with the equity "Scanner" in the Overview group.

**D2. Its own toolbar and its own state.** It does **not** use the desk's single underlying/expiry picker. It has its own slot, `mcb.dashboard.screener`, so the screener never moves the Chain page's selection. The one exception is when the user explicitly opens a row in the chain (§8).

**D3. One scan engine, eight preset tabs.** A sweep fetches each (underlying, expiry) chain once. Every tab is a filter plus sort plus column set over the same in-memory records, so switching tabs costs no network.

**D4. Relative, not absolute, thresholds for activity.** On Indian index options, intraday volume is routinely 5–50× open interest. The demo is the same: NIFTY ATM shows Vol/OI of about 10. Barchart's US cut-off (Vol/OI ≥ 1.25) would flag every strike. "Unusual" therefore means **Vol/OI relative to the median of the same chain side**, with floors on volume in lots, turnover and price. This keeps the existing `unusualVolume` idea, makes it public and testable, and adds floors.

**D5. Cheap or rich is judged against realised vol (HV20), never a fake IV rank.** We have no IV history, so IV rank and IV percentile are not shown anywhere (LATER L1). Realised vol comes from `GET /v1/history` daily candles (one call per underlying per day, cached). It gives the honest "IV / HV" ratio. When HV is unavailable the verdict falls back to "vs peers" and says so.

**D6. Same numbers as the Chain page.** Underlying-level figures that also appear on the Chain summary strip use the same functions: `chainSummary` (ATM IV, straddle, PCR, max pain, walls), `forwardPrice`, `sigmaMove`, `timeToExpiry`, and broker/server leg IV. The two pages therefore never disagree. PRD 05's client-side recomputed IV is LATER L6 here.

**D7. Every score is explainable.** Each composite score shows its components (detail panel bars) and a one-line "why" reason, and every column header has a formula tooltip. POP is never shown without max loss.

**D8. Costs are part of the maths.** Round-trip charges per lot (STT at the Budget 2026 rates, exchange charge, SEBI fee, stamp duty, GST, brokerage) appear in Buy, Sell and Arbitrage. Arbitrage edges are shown **net**. No Indian competitor does this.

---

## 1. Goals per persona

| Persona | Job on this page | Tabs | Numbers they decide on | Mistakes the page must prevent |
|---|---|---|---|---|
| **Buyer** (directional / event long premium) | Find the contract that gives the most move per rupee with acceptable decay, without overpaying for IV | Buy options, Overview, IV outliers, Unusual | Capital ₹/lot; breakeven distance in % and in σ; POP (long); θ % of premium per day; vega % per vol point; leverage; IV − HV20; spread %; liquidity; round-trip costs % | Deep OTM lottery tickets (POP < 10%); buying on expiry day (θ > 30%/day); buying straight after an IV spike (IV/HV high); wide spreads; holding ITM into expiry and paying exercise STT |
| **Seller** (strangles, condors, naked/covered) | Find rich premium outside the priced move, with liquidity to get out | Sell premium, Overview, IV outliers, Build-up | Bid; Δ; POP (short); σ distance OTM; premium ₹/lot; θ ₹/lot/day; IV − HV20; OI-wall buffer; max loss with a wing; costs | Strikes inside 1σ; selling when IV < HV; expiry-day naked gamma (extra 2% ELM); selling into short covering; illiquid legs; POP without max loss |
| **Hedger** (holds a portfolio or futures) | Buy protection cheapest per year at the right depth, sized to notional | Hedge, Overview | Depth % below forward; cost % of forward; ₹/lot and ₹/day; **annualised cost %**; payout multiple at a −2σ fall; skew paid (IV − ATM IV); lots for a notional | Rolling weeklies when the monthly is cheaper per year; overpaying for steep skew; a hedge notional that does not match the book |
| **Arbitrageur** | Find executable mispricing net of costs, on fresh two-sided quotes | Arbitrage, IV outliers | Gross edge pts and ₹/lot at bid/ask; costs ₹; **net ₹/lot**; capital; quote age; calendar variance inversions | Trading LTP instead of bid/ask; ignoring STT and charges; stale chains; mixing chains fetched far apart |
| **Everyone** | See what the market is doing across all underlyings in one look | Overview, Unusual, Build-up | ATM IV, IV/HV, skew, straddle, ±1σ, verdict, PCR, max pain, walls, dominant build-up, data age | Stale data without a timestamp; "unusual" hits on dead strikes; unexplained metrics |

**Success this round:**
1. In demo, the first sweep finishes in ≤ 5 s (≤ 16 s live at 1.1 s spacing). Rows appear progressively from the first chain.
2. Every tab shows ranked rows in demo. Arbitrage shows near misses when there are no executable hits, so it is never blank.
3. Phone 390, tablet 820, desktop 1440, light and dark: no horizontal page scroll, every control at least 44 px on touch.
4. Clicking any contract row and choosing "Open in Option Chain" lands on `#/chain` with that underlying, expiry and strike focused and scrolled into view. "Add to Strategy" lands on `#/strategy` with the leg in the basket.
5. Recomputing all tabs over 8 chains (about 1,000 legs) takes ≤ 6 ms of main-thread time on desktop.

---

## 2. Current implementation: keep, change, add, remove

### Keep (reuse as is)
- `options.js`: `atmRow`, `chainSummary`, `maxPain`, `oiWall`, `buildup`, `BUILDUP_NAMES`, `mid`, `spreadPct`, `oiChangePct`, `changePct`, `liquidityScore`, `volumeRanks`, `black76`, `probItm`, `forwardPrice`, `yearsToExpiry`, `timeToExpiry`, `sigmaMove`, `presetLegs`, `parseOptionSymbol`.
- `app.js`: `h` (filter nulls before `replaceChildren`), `api` (returns headers, which we need for `RateLimit`), `optional`, `alertBox`, `emptyState`, `toast`, `icon`, `istTime`, `app.local`, `app.state.demo`.
- `views.js`: `segmented`, `keepFocus`, `every`/`stopTimer` (`every` already skips hidden tabs), and `arrangePanels` (movable panels for free via `data-panel`).
- `format.js` for every number on screen.
- CSS tokens and desk classes: `.desk-panel`, `.desk-bar`, `.desk-clock`, `.live-toggle`, `.segmented`, the hairline `--hl` rules, tabular numerals.

### Change
| # | Today | Problem | Change |
|---|---|---|---|
| C1 | `unusualVolume(rows)` is private in desk.js:1398 and untested | The screener needs it, and logic should be tested | Move it to `options.js` as `export function unusualVolume(rows, { minRatio = 3, top = 4 } = {})`, with identical output for the default arguments. desk.js calls `O.unusualVolume(c.rows)`. Add tests. |
| C2 | `UNDERLYINGS` / `DEMO_UNDERLYINGS` are private consts in desk.js:14-15 | They would be duplicated | Export both from desk.js. The screener imports them. |
| C3 | The desk ignores any focus from outside | A screener row cannot land on its strike | `renderDesk` reads `prefs.focus` (`{ underlying, expiry, strike, side }`) **once**. If underlying and expiry match the state after `loadExpiries`, it sets `st.focus = { strike, side }`. On the first chain draw it scrolls that row to the centre of `.chain-wrap` (`block: "center"`, no smooth scroll under reduced motion) and paints the focus. It then deletes `focus` from the slot. `save()` never writes `focus`. |
| C4 | Strategy legs can only be added from the chain | The screener needs to add legs | The pure `handoffPrefs(prefs, { underlying, expiry, focus?, leg? })` in `screens.js` returns the new desk prefs object. It sets underlying and expiry, sets `focus`, and pushes the leg into `baskets["U|E"]`, merging same strike/right/side by adding lots, exactly like desk `addLeg`. `screener.js` writes it to `mcb.dashboard.desk` and sets `location.hash`. |

### Add (MUST; details in later sections)
- Scan engine: sequential queue, cache, progress, rate-limit backoff, auto-refresh, HV fetch, daily baseline (§6).
- Eight preset tabs with tables (≥ 720 px) or cards (< 720 px) (§4, §5).
- Filter sheet with a funnel ("why nothing matched") (§7).
- Customise columns per preset: show, hide, reorder (§9).
- Detail panel or sheet with score breakdown, risk box, costs, warnings and actions (§4.4).
- Chart engine slot panel (placeholder only).
- New maths in `options.js` (§5) and preset logic in `screens.js`.

### Remove
- The private `unusualVolume` in desk.js (moved, C1).
- Nothing user-visible is removed.

### Shared primitives with PRD 05 (Volatility)
PRD 05 defines `realisedVol(closes, n)`, `forwardVol(a, b)`, `arbChecks(chain, { df, minEdge })`, `isMonthly(expiry, allExpiries)` and `RATE = 0.065`. The screener uses them with exactly those names, signatures and semantics.
- If they already exist in `options.js` when work starts, import them.
- If not, the screener's maths agent implements them to the PRD 05 spec (§5.7–§5.9), with PRD 05's tests. Whichever page lands second reuses them.
- One extra requirement: `arbChecks` must accept a **negative** `minEdge` and then return near misses, sorted by edge descending.
- `forwardVol` takes `{ atmIv, years }` objects (a TermRow is a superset of that).

---

## 3. Page layout per device

The page is three top-level panels. All are movable (`data-panel`), so `arrangePanels` gives drag, maximise and persisted order:
1. `screener-main` (`.desk-panel`): toolbar, chips, description, results, footer.
2. `screener-detail`: the detail panel, a desktop column only (see below).
3. `screener-chart`: the chart engine slot.

### 3.1 Desktop (≥ 1280 px; target 1440 × 900, content about 1130 px)
```
┌ screener-main ────────────────────────────────────────────────────────────────┬ detail (340px) ┐
│ [Overview|Unusual|Build-up|Sell|Buy|IV outliers|Hedge|Arbitrage]   ▮▮▮▯ 6/8  │ NIFTY 3 Nov     │
│   NIFTY 3 Nov · 14:32:05 [↻ Rescan] [● Auto 2m] [⚲ Filters·3] [⚙ Customise]   │ 26200 PE    ×   │
│ (NIFTY)(BANKNIFTY)(SENSEX)  Δ 0.10–0.30 ×  Spread ≤ 3% ×  POP ≥ 65% ×  Reset │ score 78 ▮▮▮▮▯  │
│ Short OTM options ranked by richness, POP, decay and liquidity. How it works ↗│ metrics grid    │
│ ┌table (sticky header + sticky first column, scrolls inside, max-h 70vh)────┐ │ risk box        │
│ │ Contract ▾ │ Bid │ Δ │ POP │ σ OTM │ ₹/lot │ θ ₹/day │ IV−HV │ Liq │ Score │ │ costs           │
│ └───────────────────────────────────────────────────────────────────────────┘ │ warnings        │
│ Showing 50 of 214 · 8 chains · [Show 50 more]        Scan issues (1) ▸        │ [Open in chain] │
└───────────────────────────────────────────────────────────────────────────────┴ [+Buy] [+Sell]  ┘
┌ screener-chart: "Chart engine slot · price and IV history for NIFTY" (160px, dashed hairline) ┐
```
- Main and detail sit side by side in a grid (`minmax(0,1fr) 340px`) only at ≥ 1280 px. With nothing selected, the detail column folds away and the results take the full width (so priority-3 columns fit); selecting a row brings it back. Its actions are a sticky footer inside the column, as in the sheets.
- **Toolbar row 1** (`.desk-bar`):
  - Left: preset tabs (`.segmented`, scrolls horizontally if needed, never wraps).
  - Right: scan status, Rescan, Auto, Filters, Customise.
- **Scan status:**
  - While a sweep runs: a 3 px progress bar under the toolbar (`role="progressbar"`) and the text "Scanning 4/8 · BANKNIFTY 24 Nov".
  - At rest: "8/8 chains · 14:32:05", where the time is the oldest chain's `asOf` (`istTime`).
  - The text turns orange ink and adds "Stale" when any chain is older than 2× the auto interval or its freshness says `stale`.
  - It turns red ink with "Not updating" after a sweep where every chain failed.
- **Row 2:** underlying toggle chips (multi-select; at least one must stay on), then the active non-default filters as removable chips ("Δ 0.10–0.30 ×"), then "Reset" when any filter is non-default. Clicking a chip body opens the filter sheet focused on that field.
- **Row 3:** a single-sentence description of the preset (muted, 12.5 px) and a "How it works" link that opens the methodology `<details>` at the panel foot.
- **Results:** a dense table. Row height `var(--desk-row)` (34 px; 44 px on coarse pointers). Tabular numerals, hairline row rules, sticky header and sticky lead column. It scrolls inside `.scr-wrap` (`max-height: min(70vh, 860px); overflow: auto`).
- **Footer:**
  - "Showing N of M" and "Show 50 more".
  - A "Scan issues (k)" disclosure, shown only when k > 0, listing per-chain errors.
  - The methodology `<details>`.

### 3.2 Tablet (720–1279 px; target 820 × 1180, content about 788 px)
- Same table. Columns of priority 3 are hidden while the results panel is narrower than 1100 px (each column has `p: 1 | 2 | 3`): on tablets, and on desktop while the detail column is open. The p1 + p2 set of every tab fits 760 px with no sideways scroll. The lead column stays sticky.
- No detail column. Selecting a row (click, Enter) opens the detail as a **bottom sheet** (`<dialog class="scr-sheet">`: 70 vh, drag handle, Esc and a close button). The same sheet component serves phones.
- Toolbar: tabs on line 1 (full width, horizontal scroll); status and buttons on line 2. Button labels are kept down to 820 px; below that, icon-only with `aria-label` and `title`.

### 3.3 Phone (< 720 px; target 390 × 844)
- **Sticky preset chip bar** at the top of the panel: a horizontal scroller with snap and fade edges. Each chip is 36 px tall in a 44 px hit area.
- Line 2: status text (truncates), icon buttons Rescan, Filters (with a count badge) and Sort (a `<select>` listing the current preset's sortable columns plus asc/desc).
- Underlying chips row (wraps, 3 chips fit on 390 px).
- Active filter chips are **not** shown inline on phones (the Filters badge shows the count) to save height.
- **Cards instead of a table** (`ul.scr-cards`). Each card is a button-like `li` (≥ 64 px tall):
  - Line 1: contract name (bold, e.g. "NIFTY 3 Nov 26200 PE"), with the score (or the verdict on Overview) right-aligned.
  - Line 2: 3 key metrics in a 3-column grid. Each metric has its label above (11.5 px muted) and its value below (15 px tabular). The keys per preset are listed in §4.3.
  - Line 3: the reason string (12.5 px muted, 1 line, ellipsis).
  - Tap opens the bottom sheet (90 vh on phones).
- **Filters** open as a full-height bottom sheet with Apply and Reset (sticky footer). Changes apply live; Apply just closes.
- **Chart slot:** 120 px tall.
- No horizontal page scroll anywhere. Card text truncates, never overflows.

### 3.4 Common
- Light and dark come from tokens only. Green/red ink is used **only** for signed gains or losses (price change %, net ₹ edge sign). Scores, verdicts, build-up tags and IV figures use neutral ink plus words. Calls and puts are distinguished by the "CE"/"PE" text, never by colour.
- Heat shading: the IV/HV ratio and Score cells get a neutral accent wash (`--mat-fill` at 3 steps) proportional to rank. It never encodes good or bad by colour.
- The empty chart slot reads "Chart engine slot · price and IV history for {selected underlying}". It is a dashed hairline box with no library.

---

## 4. Tabs, columns and cards

Notation:
- `U` underlying, `E` expiry, `K` strike, `S` spot (`underlyingLtp`), `F = O.forwardPrice(chain) ?? S`.
- `T = O.yearsToExpiry(E)`, floored at 1 hour (`1/(24·365)`), so σ maths never divides by 0. Chains whose `timeToExpiry` label is "Expired" are dropped.
- `days = timeToExpiry(E).days`.
- `lot = chain.lotSize`. Never hardcode it: demo is NIFTY 75 / BANKNIFTY 35 / SENSEX 20, and live values differ.
- `σA = atmIv/100` from `chainSummary`.
- `σL` = the leg's own `iv/100`, or `σA` when the leg has none (the row is then tagged "ATM IV used").
- Volume and OI are in **units** (quantity), as the API returns them. `lots = qty / lot`.

Every contract row has a lead cell: "NIFTY 3 Nov 26200 PE" (`contractName`), with a sub line "5d 14h · lot 75 · M". "M" marks a monthly per `isMonthly`.

Column format rules:
- Prices: `formatFixed(x, 2)`.
- IV: `formatFixed(x, 1)`. IV differences: `formatSigned(x, 1)` plus " pts".
- Percentages: `formatPercent(x, 1)`; POP uses `formatPercent(x, 0)`.
- ₹ per lot: `formatRupee(x, 0)`. Large ₹ (turnover): `"₹" + formatCompact(x)`.
- Counts: `formatCompact`.
- Ratios: `formatFixed(x, 2) + "×"`. σ: `formatFixed(x, 2) + "σ"`. Δ: `formatFixed(x, 2)`.
- Score: `formatInt`.
- A missing value is `--`.

### 4.1 The eight presets (default sort in **bold**; `p` = column priority)

**1. Overview** (one row per U × E; "high/low IV" and "cheap/expensive straddles" at underlying level)

| Column | p | Formula / source |
|---|---|---|
| Underlying · expiry | 1 | "NIFTY 3 Nov", sub "W 5d 14h" or "M 26d" |
| ATM IV | 1 | `chainSummary.atmIv`; sub `Δ {formatSigned(atmIv − base.atmIv,1)} since {hh:mm}` (daily baseline, §6.6) |
| HV20 | 2 | `realisedVol(closes, 20)` per underlying; `--` with title "No daily history from this broker" |
| **IV/HV** | 1 | `atmIv / hv20`. Default sort descending (richest first) |
| Skew 25Δ | 2 | `skew25(rows).rr` = IV(put nearest Δ −0.25) − IV(call nearest Δ +0.25), each within ±0.08; `--` otherwise. Positive = puts richer |
| Term | 3 | `atmIv − atmIv(next scanned expiry of U)`, pts. Title gives `forwardVol`, or "Inverted: total variance falls" |
| Straddle | 1 | `chainSummary.straddle` (ATM CE + PE LTP, as on the Chain page); sub `₹/lot = straddle × lot` |
| Straddle % | 2 | `straddle / S × 100` |
| ±1σ move | 1 | `em = sigmaMove(F, atmIv, T)`; sub `formatPercent(em/F×100, 2)` |
| Verdict | 1 | §5.6: "Rich ×1.24", "Cheap ×0.86", "Fair ×1.03", "Rich vs peers", "Expiry day" |
| PCR | 2 | `chainSummary.pcr`; sub "Δ {pcrChange}" |
| Max pain | 3 | `chainSummary.maxPain`; sub `formatSigned(maxPain − S, 0)` |
| Walls | 2 | "{support.strike} / {resistance.strike}" (put wall / call wall) |
| Build-up | 3 | `dominantBuildup(chain)`: the tag with the largest Σ `|oiChange| × mid` over all legs, read as "Put writing" etc. (§5.4); `--` without OI change |
| Basis | 3 | `F − S`; sub carry `ln(F/S)/T × 100` % a year |
| Age | 2 | `now − fetchedAt`, "12 s" / "3 m"; orange ink when stale |

Phone card: Verdict on the right; metrics **ATM IV · IV/HV · ±1σ**; reason, e.g. "IV 1.24× realised · puts 1.8 pts richer · 0.6% move priced".
Row actions (detail): Open in Option Chain; "Straddle → Strategy" (adds ATM CE + PE, side chosen by Buy/Sell buttons); "16Δ strangle → Strategy" (the two strikes nearest Δ ±0.16 from `deltaTargets`).

**2. Unusual volume** (contracts with volume far beyond the chain's normal turnover)

| Column | p | Formula |
|---|---|---|
| Contract | 1 | |
| LTP | 1 | ltp; sub `changePct` (green/red ink: a signed price change) |
| Volume | 1 | `formatCompact(volume)`; sub "{lots} lots" |
| OI | 2 | `formatCompact(oi)` |
| Vol/OI | 2 | `volume / oi` (`--` when oi = 0: tag "Fresh strike") |
| **× median** | 1 | `volOiRel = (volume/oi) / median(volume/oi over legs on the same side of the same chain with volume > 0 and oi > 0)`. Null when fewer than 5 such legs |
| Turnover | 1 | `volume × mid` (₹, compact) |
| OI chg % | 2 | `oiChangePct(leg)` |
| Build-up | 2 | `buildup(leg)` → reading (§5.4) |
| IV | 3 | leg iv |
| Δ | 3 | leg delta |

Default filters: OI ≥ 50 lots, `× median ≥ 3`, volume ≥ 20 lots, turnover ≥ ₹10 L, mid ≥ ₹1, oi > 0 (or include fresh strikes: toggle, default off). Legs with less than 5 lots of OI get no × median ratio and are left out of the median (Vol/OI on a lot or two of OI is noise).
Card: **× median · Turnover · Build-up**. Reason: "Vol/OI 4.2× chain median · ₹3.10Cr traded · call writing".

**3. OI build-up**

| Column | p | Formula |
|---|---|---|
| Contract | 1 | |
| Price chg % | 1 | `changePct(leg)` (signed ink) |
| OI | 2 | |
| OI chg | 1 | `formatCompact(oiChange, { signed: true })`; sub "{lots} lots" |
| OI chg % | 2 | `oiChangePct`, only when prior OI `oi − oiChange ≥ 100 lots`; else `--` with title "Prior OI too small" |
| **₹ committed** | 1 | `|oiChange| × mid` |
| Tag | 1 | `BUILDUP_NAMES[buildup(leg)]` |
| Reading | 1 | §5.4 (e.g. "Put writing · bullish"), neutral ink |
| Volume | 3 | |
| IV | 3 | |

Default filters: |OI chg| ≥ 50 lots, tags all four (multi-select chips), ₹ committed ≥ ₹25 L.
A chain whose legs all have `oiChange === null` is excluded and listed in a banner above the table: "OI change unavailable for {U} {E} from this broker". It is never shown as zeros.
Card: **OI chg · ₹ committed · Reading**.

**4. Sell premium** (single short OTM legs: the building blocks for strangles, condors and credit spreads)

| Column | p | Formula |
|---|---|---|
| Contract | 1 | |
| Bid | 1 | the price you sell at (bid; `ltp` fallback flagged "LTP") |
| Δ | 1 | `|delta|` |
| POP | 1 | `popShort` §5.2 |
| σ OTM | 1 | `sigmaOtm` §5.2 |
| Premium ₹/lot | 1 | `bid × lot` |
| θ ₹/day | 2 | `|theta| × lot` |
| θ %/day | 3 | `thetaPct` §5.2 |
| IV − HV | 2 | `iv − hv20` pts |
| Max loss (wing) | 3 | `wing` §5.3: "₹{maxLoss} · R:R 1:{x}" |
| Liq | 2 | `liquidityScore` as "4/5" |
| Costs | 3 | round trip ₹/lot §5.7 |
| **Score** | 1 | `sellScore` §5.5 |

Default filters: OTM only; |Δ| 0.10–0.30; spread ≤ 3%; liquidity ≥ 3; premium ≥ ₹300/lot; POP ≥ 65%; exclude expiry day (days < 1) on.
Card: **POP · σ OTM · ₹/lot**, score on the right. Reason: "IV 3.1 pts over HV · POP 82% · 1.4σ OTM · beyond put wall".

**5. Buy options**

| Column | p | Formula |
|---|---|---|
| Contract | 1 | |
| Ask | 1 | the price you buy at |
| Δ | 1 | |delta| |
| Capital ₹/lot | 1 | `ask × lot` (premium is collected upfront) |
| Breakeven | 2 | `be = K ± ask`; sub `formatSigned((be − S)/S×100, 2)%` |
| BE σ | 1 | `beSigma` §5.2 |
| POP | 2 | `popLong` |
| θ %/day | 1 | `thetaPct` |
| Vega % | 3 | `vega / ask × 100` (premium change per +1 vol pt) |
| Leverage | 3 | `|Δ| × S / ask` |
| IV − HV | 2 | |
| Liq | 2 | |
| Costs % | 3 | round trip ÷ (ask × lot) × 100 |
| **Score** | 1 | `buyScore` §5.5 |

Default filters: |Δ| 0.25–0.60; spread ≤ 3%; liquidity ≥ 3; days ≥ 2; θ %/day ≤ 10; side Both (CE/PE/Both segmented); max capital ₹/lot (empty = none).
Card: **Capital · BE σ · θ %/day**. Reason: "BE 0.6σ away · θ 4.1%/day · IV 2.0 pts under HV".

**6. IV outliers** (rich or cheap strikes within each smile: high IV at strike level)

| Column | p | Formula |
|---|---|---|
| Contract | 1 | |
| IV | 1 | leg iv |
| Neighbours | 2 | `nbrIv`: median IV of up to 4 nearest strikes (2 each side) on the same side with iv > 0 |
| **Bump** | 1 | `iv − nbrIv` pts; sort by |bump| descending |
| vs ATM | 2 | `iv − atmIv` |
| Mid | 1 | |
| Fair | 2 | `black76(F, K, T, nbrIv, right)` |
| Rich ₹/lot | 1 | `(mid − fair) × lot` (signed, neutral ink: rich is not a gain) |
| Spread % | 2 | |
| Liq | 3 | |

Default filters: |Δ| ≤ 0.60 (deep ITM legs have no vega, so a bump there means nothing); exclude expiry day; |bump| ≥ 1.0 pt; |rich ₹/lot| ≥ ₹50; spread ≤ 5%; liquidity ≥ 2; two-sided quotes; direction Rich / Cheap / Both (default Both). A smooth smile (the demo's) correctly shows the empty state.
Rows whose price came from LTP (one-sided quote) are excluded by default ("Two-sided quotes only" toggle on), because stale prints make fake bumps.
Card: **Bump · Rich ₹/lot · Spread**.

**7. Hedge** (protective puts)

| Column | p | Formula |
|---|---|---|
| Underlying · expiry | 1 | |
| Put | 1 | strike |
| Depth | 1 | `(F − K)/F × 100` |
| Ask | 2 | |
| Cost % | 2 | `ask / F × 100` |
| ₹/lot | 1 | `ask × lot` |
| ₹/day | 2 | `ask × lot / max(days, 0.25)` |
| **Annualised** | 1 | `cost% × 365 / max(days, 0.25)`; ascending (cheapest per year first) |
| Payout @−2σ | 2 | `max(0, K − F·e^(−2·σA·√T)) / ask` as "×" |
| Skew paid | 3 | `iv − atmIv` pts |
| Lots | 2 | when notional N is set: `ceil(N / (F × lot))`; sub total `lots × ask × lot` |
| Liq | 3 | |

Default filters: depth 2–8%; liquidity ≥ 2; "Best per expiry" on (keeps the lowest-annualised put per U × E); notional ₹ (empty).
Title on Lots: "Index notional only; scale by your portfolio beta".
Card: **Depth · Annualised · Payout @−2σ**.

**8. Arbitrage** (executable at bid/ask, net of costs)

| Column | p | Formula |
|---|---|---|
| Type | 1 | Vertical / Vertical bound / Butterfly / Buy box / Sell box / Calendar (from `arbChecks` + `forwardVol`) |
| Underlying · expiry | 1 | |
| Legs | 1 | "Buy 26400 CE @195.70 · Sell 2× 26450 CE @170.15 · Buy 26500 CE @145.45" (wraps; `wrap` cell) |
| Gross | 2 | `edge` pts per unit |
| Gross ₹/lot | 2 | `edge × lot` |
| Costs ₹ | 2 | `arbCosts(hit, lot, exchange)` §5.7 |
| **Net ₹/lot** | 1 | gross ₹ − costs (green/red ink: a money edge) |
| Capital | 3 | box: `cost × lot`; others: `--` (title "Margin depends on broker") |
| Status | 1 | "Executable" when net > 0, else "Near miss" |
| Age | 2 | chain age |

`arbChecks` is run with `minEdge = −2` pts on every scanned chain (ATM ±20, two-sided only). Calendar rows come from consecutive scanned expiries of the same U where `forwardVol(...).inverted`; they are model-based, have no net edge, and their Status is "Check".
Default filters: exclude expiry day; min leg ₹1; "Near misses" on, showing only the closest near miss of each type per chain, within gross ≥ −0.5 pts and net ≥ −₹500/lot (so ordinary debit spreads do not bury a real edge).
With zero rows: "No executable edge after costs across {n} strikes in {m} chains."
Footer note: "Costs are estimates (§methodology). Quotes move; re-check in the chain before trading."
Card: **Net ₹/lot · Gross pts · Status**.

### 4.2 Selection and the reason string
- `reason(rec, presetId)` in `screens.js` returns 1–3 phrases joined by " · ".
- It picks the components with the highest contribution for the preset, from fixed phrase templates (formatted with format.js).
- Neutral ink. Max 80 characters; the card ellipsises it.

### 4.3 Phone card keys (summary)
| Preset | Right badge | Key 1 | Key 2 | Key 3 |
|---|---|---|---|---|
| Overview | Verdict | ATM IV | IV/HV | ±1σ |
| Unusual | × median | Turnover | Volume | Build-up |
| Build-up | Tag | OI chg | ₹ committed | Reading |
| Sell | Score | POP | σ OTM | ₹/lot |
| Buy | Score | Capital | BE σ | θ %/day |
| IV outliers | Bump | Rich ₹/lot | IV | Spread |
| Hedge | Annualised | Depth | ₹/lot | Payout @−2σ |
| Arbitrage | Status | Net ₹/lot | Gross pts | Age |

### 4.4 Detail panel or sheet (contract rows)
1. **Header:** contract name, "Close" (×), and a sub line "{U} spot {S} · F {F} · {days label} · lot {lot} · as of {istTime}".
2. **Score:** a big number and 4 component bars (label, value, weight). Each bar is a hairline track plus a neutral fill, e.g. "Richness 0.72 × 35%". Components that are missing show "n/a · weight redistributed".
3. **Metrics grid:** a 2-column list of every metric in §5.2 for this row, including those hidden in the table.
4. **Risk box (always shown when POP is shown):**
   - Max profit and max loss per lot for the single leg. Buy: loss = ask × lot; profit = unlimited (CE) or (K − ask) × lot (PE). Sell: profit = bid × lot; loss = "Unlimited" (CE) or (K − bid) × lot (PE).
   - The wing alternative (§5.3) for sell rows.
   - POP and probability of touch.
5. **Costs:** the breakdown table of §5.7 (brokerage, STT, exchange, SEBI, stamp, GST, total) for open + close.
6. **Warnings** (each with an icon `warn` and one sentence, only when applicable):
   - Expiry day (days < 1): "Expiry day: gamma is extreme and short options carry an extra 2% ELM."
   - Exercise STT (buy row, days ≤ 1, |Δ| ≥ 0.5): "Held to expiry in the money, STT is 0.15% of intrinsic (about ₹{x}/lot). Exit before 15:30 to avoid it."
   - Spread > 5%: "Wide spread: about ₹{(ask−bid)/2 × lot}/lot to cross."
   - LTP-priced: "One-sided quote; price is the last trade."
   - Stale chain: "Data is {age} old."
   - Selling into short covering (sell row whose tag is SC): "Short covering on this strike: writers are exiting."
   - Inside 1σ (sell row with σ OTM < 1): "Strike sits inside the 1σ expected move."
   - Wall (sell row): "Beyond the put wall at {support}" / "Inside the call wall at {resistance}" (informational).
7. **Actions:**
   - **Open in Option Chain** (hand-off focus, §8).
   - **Add Buy to Strategy** and **Add Sell to Strategy** (hand-off leg, then navigate to `#/strategy`).
   - Sell rows add **Add with wing** (sell K, buy wing K).
   - There is no order button. Orders go through the chain's ticket so every safety gate stays in one place.

---

## 5. Maths (pure; `options.js` unless marked `screens.js`; all tested)

### 5.1 New exports
```
unusualVolume(rows, { minRatio = 3, top = 4 } = {}) → Set<symbol>      // moved from desk.js (C1)
median(values) → number | null                                       // ignores nulls; null when empty
volOiRelative(rows, side) → Map<strike, number>                      // (vol/oi) ÷ side median; needs ≥ 5 legs
neighbourIv(rows, side, strike, n = 2) → number | null               // median iv of n nearest each side, iv > 0
skew25(rows) → { put, call, rr, putStrike, callStrike } | null       // nearest |Δ| 0.25 within ±0.08
probBelow(x, forward, years, ivPct) → number | null                  // public wrapper over cdfAt
legMetrics(leg, row, side, ctx) → LegRec                             // §5.2; ctx from chainContext
chainContext(chain, { now, hv20 }) → Ctx                             // §5.2
wingFor(rec, chain, widthStrikes = 4) → { wingStrike, credit, maxLoss, rr } | null
sellScore(rec) / buyScore(rec) → { score, parts: [{ id, value, weight }] } | null
dominantBuildup(chain) → { tag, rupees } | null
buildupReading(tag, right) → { text, bias: "bullish" | "bearish" }
hedgeRows(chain, ctx, { minDepth, maxDepth, notional }) → HedgeRec[]
straddleVerdict(ov, peers) → { label, ratio, basis: "hv" | "peers" | "expiry" | null }
CHARGES (frozen) · legCosts({ side, price, qty, exchange }, charges) · roundTripCosts(price, lot, exchange, charges) · arbCosts(hit, lot, exchange, charges)
// shared with PRD 05 (see §2): realisedVol, forwardVol, arbChecks, isMonthly, RATE
```

### 5.2 Context and per-leg record
`chainContext(chain)`:
- `{ S, F, T, days, lot, atmIv, em = sigmaMove(F, atmIv, T), sm = chainSummary(chain), ranks: { ce: volumeRanks, pe: volumeRanks }, volOi: { ce, pe } (volOiRelative), hv20, exchange: "BFO" when symbols start with BFO: else "NFO" }`.

`legMetrics` returns, for a leg with right R ("CE"/"PE"):
- `bid, ask, ltp`.
- `mid = O.mid(leg)`. `priceQ`: "mid" when two-sided, "ltp" when falling back, "none" when there is no price (row dropped).
- `spread = spreadPct(leg)`.
- `liq = liquidityScore(leg, ranks[side].get(K))`.
- `otm`: CE `K > F`; PE `K < F`.
- `sigmaOtm = (R === "CE" ? ln(K/F) : ln(F/K)) / (σA·√T)`. Negative means ITM. Null without σA.
- `thetaPct = |theta| / mid × 100`. Null when `mid < 0.5`, because a few paise of premium make the ratio meaningless.
- `vegaPct = vega / mid × 100`.
- `leverage = |delta| × S / mid`.
- `popShort`: CE `probBelow(K + bid, F, T, σL)`; PE `1 − probBelow(K − bid, F, T, σL)`.
- `popLong`: CE `1 − probBelow(K + ask, F, T, σL)`; PE `probBelow(K − ask, F, T, σL)`.
- `beLong = K ± ask`. `beSigma = |ln(beLong/F)| / (σA·√T)`.
- `touch = min(1, 2 × probItm(F, K, T, σL, R))`.
- `ivHv = iv − hv20`. Null without HV.
- `volOiRel`. `oiChgPct` (only when prior OI ≥ 100 lots). `committed = |oiChange| × mid`. `turnover = volume × mid`.
- `tag = buildup(leg)`.
- `nbrIv`, `bump = iv − nbrIv`, `vsAtm = iv − atmIv`.
- `costsRt = roundTripCosts(mid, lot, exchange)`.

### 5.3 Wing (defined-risk view for sellers)
- `wingStrike` = the short strike plus (CE) or minus (PE) `widthStrikes` strike steps. The step is the minimum strike gap in the chain. The width is a setting, default 4.
- If that strike is not in the chain, use the furthest available strike beyond the short. If there is none, null.
- `credit = shortBid − wingAsk`, null if ≤ 0.
- `maxLoss = (|wingStrike − K| − credit) × lot`. `rr = maxLoss / (credit × lot)`.

### 5.4 Build-up reading (per option leg; the writer view)
| tag | CE | PE |
|---|---|---|
| LB | Call buying · bullish | Put buying · bearish |
| SB | Call writing · bearish | Put writing · bullish |
| SC | Call short covering · bullish | Put short covering · bearish |
| LU | Call unwinding · bearish | Put unwinding · bullish |

- `dominantBuildup(chain)` sums `|oiChange| × mid` per (tag, right) and returns the largest.
- Null when every leg's `oiChange` is null.

### 5.5 Scores (0–100, explainable; constants in one frozen `SCORE` object)
`clamp01(x) = min(1, max(0, x))`. Each part has a value v ∈ [0, 1] and a weight w. The score is `round(100 × Σ w·v / Σ w)` over the parts that are not null. If fewer than 3 parts are available, the score is null and the row sorts last.

**sellScore** (row must be OTM):
| Part | Weight | Value |
|---|---|---|
| Richness | 0.35 | `clamp01((ivHv + 2) / 8)`: −2 pts → 0, +6 pts → 1 |
| Safety | 0.25 | `clamp01((popShort − 0.60) / 0.30)` |
| Decay | 0.20 | `clamp01(thetaPct / 15)` |
| Liquidity | 0.20 | `(liq − 1) / 4` |

Penalty: × 0.5 when `sigmaOtm < 1` (inside the expected move) or days < 1.

**buyScore:**
| Part | Weight | Value |
|---|---|---|
| Cheapness | 0.30 | `clamp01((2 − ivHv) / 8)`: +2 pts → 0, −6 pts → 1 |
| Reach | 0.30 | `clamp01((1.5 − beSigma) / 1.0)`: BE ≤ 0.5σ → 1, ≥ 1.5σ → 0 |
| Decay | 0.20 | `clamp01(1 − thetaPct / 10)` |
| Liquidity | 0.20 | `(liq − 1) / 4` |

Penalty: × 0.5 when `popLong < 0.10` (lottery ticket) or days < 1.

### 5.6 Straddle verdict (Overview)
- `days < 1` → "Expiry day", no ratio.
- When hv20 is available: `ratio = atmIv / hv20`. ≥ 1.20 "Rich", ≤ 0.90 "Cheap", else "Fair". Basis "hv"; the title cites IV and HV.
- Otherwise use peers. `dns = (straddle / S) / √days` for every non-expiry-day row in the scan. `ratio = dns / median(dns)`. ≥ 1.15 "Rich vs peers", ≤ 0.87 "Cheap vs peers", else "Fair vs peers". This needs at least 3 rows, else null (`--`).
- Tooltip states the convention: "±1σ = F·(e^{σ√T} − e^{−σ√T})/2 ≈ F·σ·√T. An ATM straddle ≈ 0.8 × 1σ, so the straddle alone is not a verdict; it is judged against realised vol."

### 5.7 Costs (`CHARGES`, as of 1 Apr 2026; approximate, shown as estimates)
```
CHARGES = { asOf: "2026-04-01", brokeragePerOrder: 20, sttSellPct: 0.15, sttExercisePct: 0.15,
            txnPct: { NFO: 0.03503, BFO: 0.0325 }, sebiPerCrore: 10, stampBuyPct: 0.003, gstPct: 18 }
```
- `legCosts({ side, price, qty, exchange })`:
  - `turnover = price × qty`;
  - `brokerage = brokeragePerOrder` (the setting; 0 allowed);
  - `stt = side === "SELL" ? turnover × 0.15% : 0`;
  - `txn = turnover × txnPct[exchange]`;
  - `sebi = turnover × 10 / 1e7`;
  - `stamp = side === "BUY" ? turnover × 0.003% : 0`;
  - `gst = 18% × (brokerage + txn + sebi)`;
  - `total` = the sum.
  - Every figure is in ₹, unrounded; only display rounds.
- `roundTripCosts(price, lot, exch)` = `legCosts(BUY) + legCosts(SELL)` at the same price for one lot.
- `arbCosts(hit, lot, exch)` = Σ `legCosts` over the hit's legs (open only). For a **bought** box (long K1 call, long K2 put), add settlement STT: `0.15% × (K2 − K1) × lot`, the intrinsic of the ITM long leg at expiry. A sold box is long the K2 call and the K1 put, both OTM when settlement lands between the strikes (its short legs are assigned and pay none), so it adds nothing.
- The methodology note lists the rates and says "Brokerage is your setting; check your broker's contract note."

### 5.8 Hedge rows
- For each PE with `K < F`, `depth ∈ [minDepth, maxDepth]` and `ask > 0`, compute the fields in §4.1.7, using `σA` for the −2σ scenario.
- "Best per expiry" keeps the row with the minimum `annualised` per U × E. Ties go to the deeper put.

### 5.9 `screens.js` (pure)
- `PRESETS`: `[{ id, label, short, description, kind: "underlying" | "contract" | "hedge" | "arb", columns: [{ id, label, p, num, sortable, title (formula), get(rec), fmt(v) }], defaults: { filters, sort, cols } }]`. `fmt` uses format.js only.
- `screenerConfig(saved)` validates and fills defaults (§9). It drops unknown ids, clamps ranges, and keeps column order while appending new columns.
- `runPreset(records, preset, filters, sort)` returns `{ rows, total, funnel: [{ filter, label, removed }] }`. Filters run in a fixed order; `removed` counts rows dropped at each step. The sort is stable, with ties broken by the lead text.
- `reason(rec, presetId)`.
- `handoffPrefs(prefs, h)` (C4).
- `dailyBaseline(stored, todayIst, rows)` returns `{ stored', base }`. It keeps the first snapshot of each IST day per U|E and resets on a new day.

---

## 6. Data, scan engine and rate limits

### 6.1 Endpoints (all existing)
- `GET /v1/expiries?underlying=U`: cached 5 min in memory.
- `GET /v1/optionchain?underlying=U&expiry=E&strikes={30}&greeks=true&maxAgeMs=5000`. `maxAgeMs` lets the Bridge reuse a chain fetched in the last 5 s (for example by the Chain page) instead of calling the broker. `strikes=30` reaches about 10–16Δ on BANKNIFTY monthlies in demo (±25 only reached 16Δ). The setting allows ±20, ±30 or ±40.
- `GET /v1/history?symbol={NSE|BSE}:{U}&interval=1d&countback=40`. SENSEX and BANKEX use BSE. Drop a final candle dated today (IST). Compute `hv20` and `hv10`. Cache per IST date in `mcb.dashboard.screener.hv` (`{ date, values: { U: { hv20, hv10 } } }`), so one call per underlying per day. On error, set `hv20 = null` and do not retry until the next day or a manual rescan.

### 6.2 Universe
- Underlyings: in demo, `DEMO_UNDERLYINGS` (NIFTY, BANKNIFTY, SENSEX). Live: all of `UNDERLYINGS`, with NIFTY, BANKNIFTY and SENSEX on by default and FINNIFTY, MIDCPNIFTY and BANKEX off.
- An underlying whose `/v1/expiries` is empty or errors is shown in Scan issues ("BANKEX: no listed contracts") and skipped for the session until a manual rescan.
- Expiries per underlying: the first N listed (setting 1/2/3, default 2), **plus** the current monthly (first expiry where `isMonthly`) when "Include monthly" is on (default on).
- Demo: NIFTY 3 Nov, 10 Nov and 24 Nov (monthly); BANKNIFTY 24 Nov and 29 Dec; SENSEX 29 Oct (expiry day, also the October monthly) and 5 Nov. That is 7 chains. (`isMonthly` works on the listed expiries, so SENSEX's 19 Nov counts as November's monthly only while it is the last one listed.)

### 6.3 Queue
- One module-level async queue, strictly **sequential**.
- Gap between calls: `app.state.demo ? 300 : 1100` ms. The broker chain class is 1/s and shares its budget with quotes and depth (`DEFAULT_GROUP_CLASSES`). Dhan is 1/s and 20/min.
- The gap grows to `reset` seconds whenever the `RateLimit` response header shows `remaining ≤ 1`.
- On a 429 (`ApiError.status === 429`): back off 2 s, then 4 s, then 8 s (3 tries), then mark the chain "Rate limited" in Scan issues and move on.
- Order: all nearest expiries first (one per underlying), then the second ones, then the monthlies. Useful rows appear early.
- **Expiries for all underlyings are fetched before any chain**, so the progress total is known.
- Each chain lands → its records are recomputed (memoised by `U|E|fetchedAt`) → the current preset is re-run → the results re-render (progressive).
- Cancel: each sweep has a `seq`. Leaving the page (root disconnected), a new manual rescan, or a settings change that alters the universe increments `seq`. Pending awaits then exit without drawing.
- `document.hidden` pauses the queue between calls; it resumes on `visibilitychange`.

### 6.4 Cache and freshness
- Module-level `Map` `U|E → { chain, fetchedAt, asOf, ms, error }`. It survives navigation within the tab, so coming back shows the last results instantly and then refreshes the oldest chains first.
- TTL = the auto interval. A sweep refetches only entries older than TTL × 0.9. A manual rescan refetches everything.
- Rows keep showing while their chain refreshes. Age shows per row (Age column / detail header).

### 6.5 Auto refresh
- Setting: Off / 1 / 2 / 5 min. Default 2 min live, 1 min demo.
- The toolbar "Auto" toggle (styled like `.live-toggle`) pauses and resumes it. It uses `every()` with a `scanning` guard, so sweeps never overlap.
- Never faster than 60 s.

### 6.6 Daily baseline
- `mcb.dashboard.screener.base` holds `{ date, rows: { "U|E": { atmIv, straddle, pcr, at } } }`, the first successful snapshot of each IST date.
- It feeds the "Δ since hh:mm" sub on Overview ATM IV.
- On a new IST date it is replaced.

### 6.7 Budget
- First live sweep (same universe as demo): 3 expiries + 3 history + 7 chains = 13 calls, about 14.3 s.
- Later sweeps: 7 calls, about 7.7 s, every 2 min (well under 20/min).
- Payload: about 61 rows × 2 legs × 300 B ≈ 37 KB per chain.

---

## 7. Filters and the funnel

- Common filters (every contract preset):
  - underlyings (chips);
  - expiries (multi-select of scanned ones);
  - days min/max;
  - side (CE/PE/Both);
  - min liquidity 1–5;
  - max spread %;
  - min OI (lots);
  - min volume (lots);
  - two-sided quotes only.
- Preset-specific filters are those listed in §4.1. Each preset keeps its **own** filter values.
- Controls:
  - Numeric ranges use two `<input type="number" inputmode="decimal">` with min/max and step; invalid input reverts on blur.
  - Toggles use `segmented`.
  - Multi-selects are chip groups (`aria-pressed`).
- Filter changes re-run `runPreset` within one animation frame (no network).
- **Empty result** shows "No contracts pass these filters", then up to 2 filters ranked **leave-one-out**: for each active filter, the rows that pass with only that filter switched off (`funnel[i].without`). Those with a count above 0 are listed ("Switching off one filter brings rows back: Δ 0.95–0.95 (116) · POP ≥ 65% (12)"), each with a "Turn off" button; when none is, "No single filter is the cause". Plus "Reset all". (A sequential "removed" count blames the earliest default filters, whose removal alone often still leaves nothing.)

---

## 8. Interactions and keyboard

- **Sort:** click a sortable header. The first click uses the column's natural direction, the second click reverses it. `aria-sort` is set on the `th`, and the header is a `button`. On phones, use the Sort select.
- **Select:** click a row or card (or Enter/Space on it). Desktop fills the detail column; tablet and phone open the sheet. The selected row gets `aria-selected="true"` and an accent hairline.
- **Hand-off:**
  - Open in Option Chain: `handoffPrefs` with focus, write `mcb.dashboard.desk`, `location.hash = "#/chain"`.
  - Add Buy/Sell to Strategy: `handoffPrefs` with a leg (and a wing leg when chosen), toast "Sell 26200 PE added to Strategy Builder", then go to `#/strategy`. A second button in the toast, "Stay", is out of scope: navigation is immediate, keeping it simple.
  - Overview "Straddle → Strategy" and "16Δ strangle → Strategy" add 2 legs the same way.
- **Keyboard** (one document listener, active only while the screener root is connected; same guards as desk `bindKeys`: ignores inputs, modifiers, open dialogs):

| Key | Action |
|---|---|
| `[` / `]` | Previous / next preset |
| `J` / `K` or `↓` / `↑` | Move the selection down / up (scrolls into view) |
| `Enter` | Open detail (sheet on tablet/phone) |
| `C` | Open the selected contract in the Option Chain |
| `B` / `S` | Add the selected contract to the Strategy as Buy / Sell |
| `R` | Rescan now |
| `F` | Open Filters |
| `A` | Toggle Auto |
| `Esc` | Close sheet or popover |

  A `.desk-keys` hint row lists these at the panel foot. It is hidden on coarse pointers, as on the desk.
- **Focus management:** the table uses a roving tabindex (one row `tabindex=0`). Re-renders reconcile rows by key (`symbol`, or `U|E` / hit key), so focus and scroll position survive refreshes (`keepFocus`).

---

## 9. Settings (persisted in `mcb.dashboard.screener`, validated by `screenerConfig`)
```
{ v: 1, preset: "overview",
  underlyings: ["NIFTY","BANKNIFTY","SENSEX"], expiries: 2, monthly: true, strikes: 30,
  auto: 120, rows: 50, brokerage: 20, wingStrikes: 4, hedgeNotional: null,
  filters: { [presetId]: {...} }, sort: { [presetId]: { by, dir } }, cols: { [presetId]: [colId, ...] } }
```
- **Customise popover** (gear; the same pattern as the chain's Customise):
  - For the current preset: the list of columns with a checkbox each (show/hide) and ↑/↓ buttons (reorder; keyboard accessible, `aria-label` "Move IV up").
  - "Reset columns".
  - The lead column is fixed and cannot be hidden.
  - Below it, scan settings: expiries per underlying (1/2/3), include monthly, strikes (±20/±30/±40), auto interval, rows shown (25/50/100), brokerage ₹ per order, wing width (strikes).
- Changing the universe (underlyings, expiries, monthly, strikes) starts a new sweep. All other settings re-render only.
- A storage failure (private mode) falls back to defaults silently (try/catch, as `readPrefs` does).

---

## 10. States

| State | What shows |
|---|---|
| First visit, scanning | 6 skeleton rows (or 4 skeleton cards), progress "Scanning 1/8 · NIFTY 3 Nov". Rows replace the skeleton as chains land |
| No underlying selected | Prevented: the last chip cannot be turned off (it shakes, with title "Keep at least one") |
| No matches | Leave-one-out funnel message and Turn off buttons (§7) |
| Some chains failed | Results from the others, plus "Scan issues (k)" in the footer listing `U E: message` (rate limited / no contracts / broker error) and a Retry per item |
| All chains failed | `alertBox(firstError)` with "Retry" in place of the results; status "Not updating" in red ink |
| Not signed in / no market data account | `alertBox` with the API's message (e.g. no account can serve option chains) and a link to Accounts |
| OI change missing | Build-up tab banner per chain; the Overview Build-up cell shows `--` with a title |
| HV missing | IV−HV and IV/HV show `--`; verdict "vs peers"; score parts renormalise; the detail shows "Richness n/a" |
| Expiry day chain | Included. The row sub shows "Expires today". Sell/Buy exclude it by default; the Overview verdict reads "Expiry day" |
| Stale | Age in orange ink, status "Stale" |
| Hidden tab | Queue paused; nothing renders |
| Demo | The page shows the global demo notice like other desk pages |

---

## 11. Performance
- Records are memoised per chain (`U|E|fetchedAt`). Only the landed chain is recomputed (about 122 legs, ≤ 1 ms).
- `runPreset` over all records is ≤ 3 ms for 1,000 legs. Medians are precomputed per chain side in `chainContext`, not per leg.
- Render: at most `rows` (≤ 100) rows. Rows are keyed and reused, and only text nodes that changed are updated. No layout thrash: write text, then read nothing.
- One document key listener; no per-row listeners (event delegation on the tbody and the card list).
- Debug timing: when `localStorage["mcb.debug"]` is set, `window.__scrMs` records the last compute+render ms. Target ≤ 6 ms on desktop.
- No timers while hidden; no work after leaving the page.

## 12. Accessibility
- The table has a `<caption class="pal-sr-only">` naming the preset and the count. Headers are `scope="col"` buttons with `aria-sort`. Every column `title` carries its formula.
- The status has `aria-live="polite"` and announces only at sweep end: "Scan complete: 8 chains, 214 matches". The progress bar uses `role="progressbar"` with `aria-valuenow` and `aria-valuemax`.
- The preset tabs use the `role="tablist"` / `tab` / `aria-selected` pattern with arrow-key navigation.
- Cards are `li` > `button`, with an accessible name made of the contract plus the 3 metrics plus the reason.
- The sheets are `<dialog>`: focus moves into them on open, they trap focus, and Esc returns focus to the row.
- Meaning never relies on colour alone: tags and verdicts are words, and signed values carry "+" or "−".
- Touch targets ≥ 44 px under `(pointer: coarse)`. `prefers-reduced-motion`: no progress animation easing, no smooth scroll. `forced-colors`: selected row outline `Highlight`.

## 13. CSS (`12s · SCREENER`, tokens only, hairlines as inset shadows)
- `.scr-grid` (main + detail at ≥ 1280), `.scr-wrap` (scroll container), `.scr-table` (sticky `thead th` with `--mat-grouped-solid` background; sticky `td.lead` with a right hairline), `.scr-cards`, `.scr-card`, `.scr-metrics` (3-column grid), `.scr-reason`, `.scr-chip`, `.scr-progress`, `.scr-sheet`, `.scr-bars`, `.scr-slot` (dashed hairline placeholder).
- No inline styles, no `<style>`. Widths are set via classes; the progress width is set via `element.style.width` (allowed).

---

## 14. Test plan

### 14.1 Unit (`options.test.mjs`)
- `unusualVolume`: output identical to the old desk version on a fixture; `minRatio` and `top` respected; fewer than 5 legs gives an empty set.
- `median`: odd and even counts, nulls ignored, empty gives null.
- `volOiRelative`: hand-computed ratios; oi = 0 legs excluded; fewer than 5 legs gives an empty map.
- `neighbourIv`: edge strikes (only one side present); iv ≤ 0 skipped.
- `skew25`: picks the nearest |Δ| 0.25 within ±0.08; null when absent; sign convention (puts richer gives positive).
- `probBelow`: matches `1 − probItm(CE)` at the same strike; 0 for x ≤ 0; null without vol.
- `legMetrics`:
  - `sigmaOtm` sign for ITM/OTM on both rights;
  - `popShort + popLong(at the same price) ≈ 1` when bid = ask;
  - `thetaPct` null under ₹0.5;
  - `beSigma` against a hand value;
  - falls back to `σA` when the leg IV is missing and flags it.
- `wingFor`: credit/maxLoss/rr hand values; a missing wing strike uses the furthest strike; credit ≤ 0 gives null.
- `sellScore` / `buyScore`: hand-computed parts; weights renormalise when HV is null; fewer than 3 parts gives null; penalties applied (inside 1σ, expiry day, lottery).
- `buildupReading`: all 8 cells of the table in §5.4. `dominantBuildup`: null when OI change is missing.
- `hedgeRows`: depth band, annualised maths, payout at −2σ, best-per-expiry tie-break, lots for a notional.
- `straddleVerdict`: HV basis thresholds at the boundaries (1.20, 0.90); peers fallback; fewer than 3 peers gives null; expiry day.
- `legCosts` / `roundTripCosts` / `arbCosts`: hand-computed totals for NFO and BFO, including GST on brokerage+txn+sebi; STT only on sells; stamp only on buys; box settlement STT.
- PRD 05 shared functions (if implemented here): the tests specified in PRD 05 §13, plus `arbChecks` with a negative `minEdge` returning near misses sorted.

### 14.2 Unit (`screens.test.mjs`, new)
- `screenerConfig`: defaults from `{}`; garbage input; unknown preset/column ids dropped; column order kept and new columns appended; ranges clamped; `auto` < 60 is raised to 60.
- `runPreset`: filter order and funnel counts on a fixture; stable sort with tie-break; `rows` limit; asc/desc.
- `reason`: deterministic text per preset; ≤ 80 characters; uses `--`-free phrases only (skips missing parts).
- `handoffPrefs`: sets underlying/expiry/focus; merges the same leg by adding lots; keeps other baskets untouched; does not drop unknown desk keys.
- `dailyBaseline`: keeps the first snapshot of the day; resets on a new IST date (a UTC/IST boundary case at 18:45 UTC).
- Every `fmt` uses format.js (the `format.test.mjs` file list covers both new files).

### 14.3 Playwright (`scratchpad/screener.cjs`, adapted from `desk.cjs`; screenshots under `scratchpad/shots/`, all read and inspected)
- Viewports: 390×844, 820×1180, 1440×900 × light and dark.
- For each viewport and theme:
  - Wait for the status to read "N/N chains" (7/7 in demo).
  - Screenshot Overview, Sell, Buy and Arbitrage.
  - On phone, also the filter sheet and the detail sheet.
- Assertions:
  - `document.scrollingElement.scrollWidth <= innerWidth` on every shot;
  - zero console errors and zero CSP violations;
  - every tab has ≥ 1 row in demo;
  - the empty-funnel state appears when Δ min is set to 0.95 on Sell;
  - a row → "Open in Option Chain" → `#/chain` shows the same strike focused (`[aria-selected]` or the focus class) and visible in the viewport;
  - "Add Sell to Strategy" → `#/strategy` basket contains the leg;
  - the keyboard: `]` moves the preset, `J` moves the selection, `R` restarts the scan;
  - on a coarse pointer (phone emulation), interactive elements' bounding boxes ≥ 44 px.
- Before committing: `npx vitest run server/bridge/dashboard`, then the full `npx vitest run` and `npm run -s check:mjs`.

---

## 15. MUST (this round), ranked
1. **Maths** in `options.js` with tests: `unusualVolume` (moved), `median`, `volOiRelative`, `neighbourIv`, `skew25`, `probBelow`, `chainContext`, `legMetrics`, `wingFor`, `sellScore`, `buyScore`, `buildupReading`, `dominantBuildup`, `hedgeRows`, `straddleVerdict`, `CHARGES`, `legCosts`, `roundTripCosts`, `arbCosts`. Also the PRD 05 shared `realisedVol`, `forwardVol`, `arbChecks` (negative `minEdge`), `isMonthly`, `RATE` if not yet present.
2. **`screens.js`** with tests: the `PRESETS` registry (8 presets, columns with formula titles and priorities, defaults), `screenerConfig`, `runPreset` with funnel, `reason`, `handoffPrefs`, `dailyBaseline`.
3. **Scan engine** in `screener.js`: universe and expiry selection (nearest N + monthly), the sequential queue (300/1100 ms gap, `RateLimit` header, 429 backoff), `maxAgeMs=5000`, cache and TTL, progressive render, cancel on leave, pause when hidden, auto refresh (Off/1/2/5 min), HV fetch with a daily cache, the daily baseline.
4. **Page shell:** PAGES entry, `radar` icon, toolbar (tabs, status and progress, Rescan, Auto, Filters, Customise), underlying chips, active filter chips, description line, footer (count, Show more, Scan issues, methodology), chart engine slot panel.
5. **Eight tabs** with the columns, defaults and sorts in §4.1: Overview, Unusual volume, OI build-up, Sell premium, Buy options, IV outliers, Hedge, Arbitrage (net of costs, near misses).
6. **Responsive results:** table ≥ 720 px (sticky header and lead column, internal scroll, priority-3 columns hidden while the results panel is < 1100 px); cards < 720 px with the §4.3 keys and the reason; phone Sort select.
7. **Detail:** desktop column ≥ 1280 px, bottom sheet below. Score bars, metrics grid, risk box (max loss always with POP; wing for sells), costs breakdown, warnings, actions.
8. **Hand-off:** desk.js C2 and C3 (exported lists, one-shot focus with scroll into view), C1 (desk uses `O.unusualVolume`); "Open in Option Chain" and "Add Buy/Sell (with wing) to Strategy"; Overview straddle and 16Δ strangle to Strategy.
9. **Filters sheet** with per-preset values, live apply, and the empty-result leave-one-out funnel with Turn off buttons.
10. **Customise:** per-preset show/hide/reorder of columns plus scan settings, persisted and validated.
11. **Keyboard and accessibility** (§8, §12).
12. **States** (§10), including the OI-change-missing banner, HV-missing fallback and Scan issues.
13. **CSS** section `12s · SCREENER`, light and dark, 44 px touch, reduced motion, forced colours.
14. **File lists:** `DASHBOARD_FILES` and `format.test.mjs` include `screener.js` and `screens.js`.
15. **Verification:** Playwright run (§14.3) on 3 viewports × 2 themes with screenshots read, plus all test suites green.

## 16. LATER (ranked)
- **L1 IV history:** shared with PRD 05 L1. A server-side daily ATM IV snapshot plus `GET /v1/vol/history`. Then real IV rank and IV percentile columns (with an "n of 252 days" badge) and "IV percentile ≥ 80 / ≤ 20" filters.
- **L2 Saved screens:** name and save a filter+sort+columns combination as a custom tab (stored locally); import/export as JSON.
- **L3 Alerts:** notify when a saved screen gains a new row (in-page toast first; push later).
- **L4 CSV export** of the current tab.
- **L5 Server-side scan endpoint** (`GET /v1/optionchain/scan?underlyings=&expiries=`) that reuses the Bridge cache and spreads calls across accounts, like the equity Scanner. Clients then make one call per sweep.
- **L6 Recomputed IV:** switch to PRD 05's Black-76-on-forward IV from mids once it has landed and been verified, for both pages at once (keeps D6).
- **L7 Futures:** conversion/reversal vs the futures quote (`{EXCH}:{U}-{E}-FUT` via `/v1/quotes`), and basis vs fair carry.
- **L8 Margin:** per-row margin from the broker (via order preview where supported), so sellers see return on margin and annualised return.
- **L9 Event calendar:** RBI, budget, CPI and results dates as row warnings and a "skip event expiries" filter.
- **L10 Multi-leg candidates:** a ranked strangle/condor/credit-spread search (OptionStrat Optimizer style) with a target price and date.
- **L11 Stock F&O universe** (about 200 underlyings) once L5 exists; Sensibull-style heatmap.
- **L12 Chart engine:** price and IV history for the selected underlying in `screener-chart`, plus a flow time series (OI/volume) once the owner's engine is supplied.
- **L13 Intraday deltas:** Vol/OI and OI change against a user-chosen reference time (Dhan-style), using stored sweeps.

## 17. OUT OF SCOPE (this round)
- Any chart library or price/time chart. The `screener-chart` panel is a labelled placeholder only.
- IV rank and IV percentile, or any number derived from IV history (shown nowhere, not even estimated).
- Placing orders from the screener. Trades go through the chain ticket and its safety gates.
- New server endpoints or broker adapter changes.
- Trade-side (bid/ask aggressor) flow, block or sweep detection: we only have snapshots.
- Margin (SPAN/exposure) estimates.
- Stock options and the full F&O universe.
- Push notifications, alerts, saved screens, CSV.
- Changing `chainSummary`, the Chain page's figures or its 3 s refresh.

## 18. Build plan (3 agents, in parallel after step 0)
0. Agent A publishes the §5.1 signatures and empty stubs first (½ hour), so B and C can code against them.
- **Agent A: maths.** Owns `options.js` and `options.test.mjs`. Delivers MUST 1 and C1 (moves `unusualVolume`, desk.js one-line change).
- **Agent B: engine and logic.** Owns `screens.js` and `screens.test.mjs`, the scan engine part of `screener.js` (`createScan({ onChain, onProgress, onIssue })`), desk.js C2 and C3, and the file lists. Delivers MUST 2, 3, 8 and 14.
- **Agent C: UI.** Owns the rest of `screener.js` (shell, tabs, table/cards, filters, customise, detail, keyboard), `views.js`, the icon, the `app.css` section and the Playwright script. Delivers MUST 4–7, 9–13 and 15.
- Integration order: A stubs → B engine renders raw Overview → C table/cards → A real maths → C detail and filters → B hand-off → C Playwright on all devices → fix → full test run → commit.
