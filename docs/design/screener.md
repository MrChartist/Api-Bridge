# Design spec: Option Screener, round 2 (`#/screener`)

Status: ready to build · Files: `server/bridge/dashboard/screener.js` (page, table, cards, detail, filters), `screens.js` (column definitions, which gain a `viz` field, and new pure helpers, tested in `screens.test.mjs`), `app.css` (the `.scr-*` block, about lines 2890–3060). Shared helpers come from `viz.js`, `motion.js` and `options.js` as defined in `docs/design/foundation.md`. Builds on `docs/prd/07-screener.md`; every PRD 07 behaviour still applies unless this spec changes it.

Reference bar: Sahi Terminal for calm and clean; Sensibull/Opstra screeners and thinkorswim's Option Hacker for depth. The screener must answer one question in under two seconds: **what are the best few rows, and why.** Today every row looks the same, so the eye has nothing to grab.

Colour tokens: every colour named below is a foundation token (§3–§4): `--sel-bg/--sel-fg`, `--seg-track`, `--dv-call(-ink)`, `--dv-put(-ink)`, `--pos(-ink)`, `--neg(-ink)`, `--warn(-ink)`, `--neutral-ink`, `--dv-spot`, `--dv-iv(-ink)`, `--dv-hv`, `--dv-band`, `--dv-grid`, `--dv-axis`, `--seq-1…5` (+ `--seq-ink-4/5`), `--div-n3…p3` (+ `--div-ink-*`), `--mat-fill-1/2/3`, `--mat-hairline`, `--mat-separator`, `--surface-raised`, `--a-label`, `--a-quiet`. **Do not add new colours on this page.** The `--ios-blue`, `--ios-green-ink`, `--ios-red-ink` and `--ios-orange-ink` references in the `.scr-*` block are all replaced.

Screenshots this spec is based on (dark and light; phone 390×844, tablet 820×1180, desktop 1440×900; Overview, Unusual, Build-up, Sell, Arbitrage, the detail pane/sheet and the Filters sheet):
`/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/shots2/scr/` (script `scratchpad/scr.cjs`). No shot scrolls sideways (`scrollWidth === innerWidth` at all six sizes). No page errors.

---

## 1. What is wrong today (specific)

### 1.1 Ranking cannot be seen
1. **The heat is three shades of grey.** `heat-1/2/3` are `--mat-fill-1/2/3` (4.5 %, 7.5 % and 12 % foreground). On the Sell tab, scores 64 to 59 all sit in the same grey band (`desktop-dark-sell.png`), and the column reads as a grey stripe, not a ranking. In light (`desktop-light-buildup.png`), "₹ committed" is a flat grey bar from top to bottom.
2. **There is no rank number.** Users count rows to say "the third one". Nothing shows that a row rose or fell since the last sweep, or that it is new.
3. **The score is a bare integer.** Nothing shows what it is made of. The breakdown appears only in the detail pane, as four grey bars, with a cryptic label "0.00 × 35%".
4. **Ties look like ties.** Ten rows score 60 on Sell; the visual gives no secondary cue (POP, σ OTM) to separate them.

### 1.2 Colour carries nothing
5. **CE and PE look identical.** "NIFTY 3 Nov 27000 CE" and "…25950 PE" are the same grey text. The right is the last 2 characters of a 22-character string.
6. **Verdicts are plain words.** Overview says "Cheap" seven times in plain foreground. "Expiry day" (a warning) looks the same as "Cheap".
7. **OI change (Build-up, Unusual) is not coloured.** "+47.3K" and "−11.4K" have the same ink. Only "Price chg %" is coloured.
8. **Build-up tags are long words**: "Long build-up", "Short covering", "Call short covering" (these take 120–160 px). They have no colour and no direction.
9. **Arbitrage**: the status ("Near miss") is plain text. Net ₹ is red text on a grey heat column. The legs wrap to 3 lines of undifferentiated "Buy 25450 PE @8.85 · Sell 2× 25500 PE…" (`tablet-dark-arb.png`). Buy and sell legs look the same.
10. **IV − HV**, **σ OTM**, **POP**, **Liq** and **Spread** are numbers only. A POP of 84 % and one of 91 % look alike, and a 3/5 liquidity looks like 5/5.
11. **The sub-line change % under LTP** (Unusual) is 10.5 px in `--ios-*-ink` and reads as grey at a glance on tablet.

### 1.3 Selection and chrome (foundation violations)
12. **Tabs**: the selected tab is a grey thumb in dark and a white thumb in light. The foundation contrast rule says white/black in dark and black/white in light.
13. **Underlying chips** are blue-tinted when on. Blue is the call colour now, so they read as "calls".
14. **Expiry chips in Filters** are blue-tinted. The switches are green (green means gain only).
15. **"Auto 1m"** is a green slab button. It is a status, not a selection: it should be a dot plus text on a transparent background.
16. **Row selection** is a blue outline on all four sides. The foundation rule is a `--mat-fill-2` fill plus a 2 px `--sel-bg` leading bar.
17. **The sorted column header** is blue text plus ▼. Blue now means "call".

### 1.4 Space and repetition
18. **The status "7/7 chains · 09:10:39"** sits in the panel head, while the toolbar clock shows "09:10:46 IST". There are two times, 7 s apart.
19. **"Demo data"** pill in the toolbar: kept by the foundation as the single indicator. Nothing on this page may add another.
20. **On desktop with nothing selected**, the chart engine slot is a **600 px empty dashed box** under the results (`desktop-dark-sell.png`). It is the largest thing on the page and holds nothing.
21. **The keyboard-hint row** (`[ ] tabs J K row …`) is always on and uses 36 px for something used rarely.
22. **The description line plus "How it works" link**, and on Arbitrage a second banner "Costs are estimates (How it works)…", say the same thing twice.
23. **The panel head** uses three rows (tabs; status + tools; chips) and 150 px before the first row on desktop.

### 1.5 Phone and tablet
24. **Phone cards are 115 px tall and text-only.** 50 cards make a 5,873 px page (`phone-dark-sell.png`). The reason line is cut with an ellipsis ("· b…").
25. **The phone tab row** clips "Sell" at the edge with no fade, and the selected tab is not centred into view.
26. **The phone sort control** is a full-width native select ("IV/HV ↓") between two icon buttons. It looks like a text field.
27. **Tablet** shows the table with priority-3 columns hidden. The lead column is sticky, which is good, but the name, the rank and the right compete inside one string.
28. **The detail sheet on phone** puts four action buttons in a 2×2 grid of pale pills with no primary. "Sell with 27200 wing" and "Add Buy to Strategy" have the same weight as "Add Sell…" on the Sell tab.

### 1.6 Detail pane
29. **The metrics list has 23 rows in one column**, with no groups. You have to scroll past the actions to see Greeks (the pane cuts at "IV − HV20").
30. **"With wing 27200 CE: credit 15.75 · max loss ₹13819 · R:R 1:11.7"** wraps to two ragged lines.
31. **Nothing visual explains the risk.** A short call has an unlimited loss, but this is the word "Unlimited" in plain text.

---

## 2. Design principles for this page

1. **Rank first.** Every row shows its rank, and the ranking metric has the strongest visual on the row. The other columns are context.
2. **One visual language per meaning.** Intensity (how much) uses the violet sequential ramp. Signed money or direction uses red/green. Call/put uses blue/orange. Warnings use amber. A metric never borrows another meaning's colour.
3. **Colour is never alone.** Every coloured cue also has a glyph, a letter, a position or a bar length.
4. **Fixed scales where the number has meaning, percentiles where it is relative.** A score of 70 is always the same violet. "× median" is coloured relative to the rows on screen.
5. **Calm by default; motion only on change.** Rows reorder smoothly, changed values flash once, new matches get a short mark. Nothing loops.
6. **The page head is one line.** Data starts high.

---

## 3. Layout per device

### 3.1 Desktop ≥1280 (1440×900; content ≈1120 px with the sidebar open)

```
[toolbar 52: (◎) Option Screener │ 3 underlyings · 7 chains ········· ● Auto 1m · 09:10:39 │ ● Demo │ ⌕]
┌ results panel (flex 1, min 640) ─────────────────────────────┐ ┌ detail column 360 ─────────┐
│ head row 44: [Overview|Unusual|Build-up|Sell|Buy|IV out|Hedge|Arb]   [⟳ Rescan] [⚲ Filters 2] [▥] [?] │ │ title + close             │
│ chip row 32: NIFTY✓ BANKNIFTY✓ SENSEX✓ │ Δ 0.10–0.30 ✕ │ POP ≥ 70% ✕ │ Reset ····· 157 matches │ │ score ring + composition    │
│ legend row 24 (per tab, §6.1)                                │ │ chart engine slot 180       │
│ table (sticky head 34, sticky rank+lead columns)             │ │ risk visual (mini payoff)   │
│ …                                                            │ │ metrics in 3 groups         │
│ foot 36: Showing 50 of 157 · Show 50 more        How it works│ │ actions (sticky bottom)     │
└──────────────────────────────────────────────────────────────┘ └────────────────────────────┘
```

- **The toolbar** (foundation §5): the context capsule shows "3 underlyings · 7 chains" (the underlyings button opens the same chip set as a popover). The live control is the screener's auto toggle: "● Auto 1m · 09:10:39", where the time is the oldest chain's `asOf`. The states are:
  - while sweeping: "◌ Scanning 4/7", with a spinning ring on the dot (static under reduced motion);
  - when stale: "● Stale · 3 min" in `--warn-ink`;
  - when paused: "❚❚ Paused · 09:10".
  - Clicking it toggles auto. The panel's `status` span and `autoBtn` are removed from the panel head.
- **Head row** (44 px):
  - The tabs are a capsule bar (foundation §3.3: `--seg-track`, a sliding `--sel-bg` thumb, `--sel-fg` label, 32 px tall).
  - On the right: Rescan (icon + label, secondary), Filters (icon + label + count badge), Customise (icon only, ▥), and Shortcuts (icon only, `?`, which opens the key hints as a popover; the `.scr-keys` row is removed).
- **Chip row** (32 px; wraps to 2 lines at most):
  - **Underlying chips**: off = outline (`inset 0 0 0 1px var(--mat-separator)`), `--a-label` text; on = `--sel-bg`/`--sel-fg`, preceded by a 12 px ✓ glyph.
  - A 1×16 px `--mat-separator` divider, then the changed-filter chips: `--mat-fill-1` background, fg text, ✕ at the end (a 28 px hit area, 44 on coarse pointers).
  - Then Reset (plain link button).
  - Right-aligned: "157 matches", 600 12.5 px `--a-label`, with the number tabular in fg. It counts up on change (§7).
- **The description line** becomes the tab's `title` and the first sentence of the empty state. It is removed from the layout. Its text stays in "How it works".
- **Detail column** (360 px, sticky, as today) is **always present at ≥1280**:
  - On first load the rank-1 row is selected **without** opening anything (`select(rows[0].key)`).
  - Switching tabs keeps the selected key if it is still in the rows; otherwise it selects rank 1.
  - The close ✕ deselects; the column then shows "Select a row" with the chart slot (it does not fold away, because folding makes the table width jump on every click).
- **The chart engine slot** moves into the detail column, under the score block: `chartSlot("Price and IV history")`, 180 px tall, radius 12. The separate `.scr-chart` panel is removed at ≥1280. **That deletes the 600 px empty box.**
- **Footer** (36 px): "Showing 50 of 157" at left, "Show 50 more" plain button, and "How it works" disclosure at right. Scan issues stay as a disclosure above the footer (warn dot + "2 scan issues").

Head height: 52 (toolbar) + 12 + 44 + 32 + 24 (legend) = **first data row at y≈208** (today 278).

### 3.2 Desktop 1024–1279 and tablet landscape

The same as §3.1 with no detail column. A row click opens the detail as a **right-side sheet**, 400 px wide, full height, with the same content. The chart slot is inside the sheet. Priority-3 columns are hidden (`@container scr (max-width: 1099px)`, kept).

### 3.3 Tablet portrait 720–1023 (820×1180)

- **Head row**:
  - the tabs capsule scrolls sideways, with a 16 px `mask-image` fade at each scrollable edge and the selected tab centred (`scrollIntoView({inline:"center"})`);
  - the tools are icon-only (44×44, coarse pointer).
- **The chip row** is unchanged and wraps.
- **The table** shows priority 1 + 2 columns, the sticky rank + lead columns, and a row height of 44.
- **Detail**: a bottom sheet (`modal`, `.scr-sheet`) at 85 % height, with actions sticky at the bottom.

### 3.4 Phone <720 (390×844; content 358 px)

```
[toolbar 52: NIFTY+2 ▾ · 7 chains ······· ● 09:10 │ ⋯•]
sticky sub-head (48, under the toolbar, --card background + hairline when stuck):
  [Overview|Unusual|Build-up|Sell|Buy…] (scroll, fade, centred)       
  [⇅ Score ▾] [⚲ 2] [⟳]            157 matches
cards (88 px)…
```

- **Sticky sub-head**: tabs on line 1 (44 px). Line 2 (40 px) holds:
  - a **sort chip** "⇅ Score ▾", which opens a small sheet listing the sortable columns as a radio list with ↑/↓ (replacing the native select look; the native `<select>` stays underneath at `opacity:0` for accessibility, per the foundation's transparent-select technique);
  - Filters (icon + count badge) and Rescan (icon), each 44×44;
  - the match count right-aligned.
  - The underlying chips move to the toolbar capsule popover on phone.
- **Cards** (§6.9): 88 px for contract tabs, 76 px for Overview/Hedge. A hairline between cards. No outer card chrome: the list sits flush in the panel.
- **The chart engine slot** is in the detail sheet only (160 px).
- **Footer**: "Show 50 more" is a full-width 44 px secondary button, then "How it works".

---

## 4. Typography and spacing

- **Table**:
  - cells 13.5 px 450, tabular, slashed zero;
  - **the ranking column 650** with its value;
  - head 600 11.5 px `--a-quiet`, with the sorted header in fg 650 + a 10 px ▲/▼ in fg (not blue);
  - sub-lines 11 px 500 `--a-quiet` (raised from 10.5);
  - a coloured sub-line uses the ink token at 600 weight, so it reads as colour at 11 px.
- **Lead cell**:
  - line 1 is `NIFTY 3 Nov` 600 13.5 px fg, then the strike 650 tabular, then the **right capsule** (§6.2);
  - line 2 is "5d 6h · lot 75 · M" in 11 px `--a-quiet`.
- **Rank cell**: 12 px 600 tabular, `--a-quiet` for ranks ≥4; ranks 1–3 in fg 700.
- **Row heights**: 40 px desktop (two-line cells need it), 44 px coarse pointer. Padding 4 px 8 px. The first and last cells get 12 px.
- **Spacing**: 4 px grid; panel padding 12; chip gap 6; head row gaps 8.
- **Numbers** are always right-aligned. Signed values always show the sign (`formatSigned`, `formatCompact(…, {signed:true})`). Every number becomes text through `format.js` only.

---

## 5. The column visual system (`viz` field in `screens.js` columns)

Each column definition gains an optional `viz` field. `fillCell` renders it next to, or behind, the text. The kinds are:

| `viz.kind` | What it draws | Element |
|---|---|---|
| `seq` | cell background `--seq-n`, text `--seq-ink-n` for steps 4–5 | `heatCell(td, step, "seq")` |
| `div` | cell background `--div-*`, text `--div-ink-*` | `heatCell(td, step, "div")` |
| `bar` | a 3 px bar under the value, right-aligned, width ∝ value | `hbar()` in `.scr-mbar` |
| `cbar` | a centred signed bar (zero in the middle of the cell) | `.scr-cbar` with `--v` (−1…1) |
| `meter` | 5 dots (liquidity) | `.scr-dots` |
| `sigma` | a 0–3σ track with a 1σ tick and a dot at the value | `.scr-sig` |
| `chip` | tinted capsule (verdict, tag, status) | `.scr-pill` |
| `ink` | text colour only (existing `ink`/`subInk`, remapped to the tokens) | class |

Rules:
- **At most two visual columns per tab** (the ranking column plus one supporting column). Everything else is ink at most. This is what keeps the table clean.
- Bars are drawn with `transform: scaleX(var(--v))` and a transition (§7). `--v` is set with `el.style.setProperty`; there are no `style=""` attributes.
- Bar track: `--mat-fill-1`, radius 2. The bar has radius 2 at the far end. A non-zero value has a minimum length of 2 px.
- Each `viz` has a legend entry in the tab's legend row (§6.1).

### 5.1 Scales (pure helpers in `screens.js`, tested)

- **`scoreStep(score)`** (fixed bands, so a colour means the same score on every refresh): `≥75 → 5`, `65–74 → 4`, `55–64 → 3`, `45–54 → 2`, `<45 → 1`. `null → 0` (no fill, `--`).
- **`rankHeat(values, dir)`** for relative columns: `seqStep(v, p5, p95)` from `options.js` (foundation §4.3). p5 and p95 are taken over the **shown** rows (after filter, before the "Show more" cut). With fewer than 5 finite values every cell gets step 0. For `dir: "asc"` columns (cheaper is better) the step is inverted: `6 − step`.
- **`signedHeat(values)`**: `divStep(v, p95(|v|))` (foundation §4.4).
- **`barFrac(v, max)`** = `clamp(0, 1, v / max)`. `max` is the p95 of the shown values (so one outlier does not flatten the rest), or a fixed max where given below.
- **`sigmaPos(s)`** = `clamp(0, 1, s / 3)`. The 1σ tick is at 1/3.
- **`ratioPos(r)`** for IV/HV = `clamp(0, 1, (r − 0.5) / 1.0)`. 1.0 is at the centre.

### 5.2 Per tab: what is coloured (the ranking column is marked ★)

| Tab | Visual columns | Ink-only columns |
|---|---|---|
| **Overview** | ★ IV/HV: `cbar` around 1.0 (`ratioPos`). The fill is `--dv-iv` when > 1 (rich) and `--dv-hv` grey when < 1 (cheap); the value is in `--dv-iv-ink` when ≥ 1.20. **Verdict**: `chip`, see §6.3 | Skew `--dv-put-ink` when > +1 pt (puts richer), `--dv-call-ink` when < −1 pt (calls richer); ATM IV Δ sub-line `--pos-ink`/`--neg-ink`; Basis neutral |
| **Unusual** | ★ × median: `seq` by `rankHeat`, plus a ×-glyph weight 650. Turnover: `bar` (p95 max) | LTP chg sub `--pos-ink`/`--neg-ink`; OI chg % same; Build-up: `chip` (§6.4) |
| **Build-up** | ★ ₹ committed: `seq` by `rankHeat`. OI chg: `cbar`, positive in `--pos` and negative in `--neg` at 35 % fill + 1 px outline + hatch (the foundation's "decrease" mark), value in `--pos-ink`/`--neg-ink` | Price chg % ink; Tag `chip`; Reading's bias word with ▲ (`--pos-ink`, bullish) or ▼ (`--neg-ink`, bearish), or "–" for none |
| **Sell** | ★ Score: `seq` by `scoreStep`, and a **composition micro-bar** under the number (§6.5). POP: `bar` with fixed max 100 %, a tick at the active POP filter, value in fg | σ OTM: `sigma` (P2 when the column is wide enough: ≥ 72 px; else ink `--warn-ink` when < 1σ); IV − HV `--dv-iv-ink` when > 0, `--a-label` otherwise; Liq `meter`; Max loss (wing) `--neg-ink` |
| **Buy** | ★ Score: as Sell. BE σ: `sigma`, reversed meaning (closer is better; the dot is fg, the track shows 0.5σ–1.5σ as `--dv-band`) | Capital neutral; θ %/day `--warn-ink` when > 8 %; IV − HV `--dv-iv-ink` when > 0; Liq `meter` |
| **IV outliers** | ★ Bump: `cbar` around 0. Positive (rich) bars are solid `--dv-iv`; negative (cheap) bars are an `--dv-iv` 1 px outline only. Rich ₹/lot: `ink` with `--dv-iv-ink` for positive and fg for negative, sign always shown | Spread `--warn-ink` when > 3 %, plus ⚠ when > 5 % |
| **Hedge** | ★ Annualised: `seq` by `rankHeat`, inverted (cheaper is darker). Depth: `bar` with fixed max 10 % in `--dv-put` (puts) | Payout −2σ `--pos-ink` when ≥ 3×; Skew paid `--warn-ink` when > +3 pts |
| **Arbitrage** | ★ Net ₹/lot: `div` by `signedHeat`, so executable rows are green cells and near misses pale red. Status: `chip` (§6.6) | Costs `--a-label`; Age `--warn-ink` when stale; Legs as leg tokens (§6.6) |

Every tab also gets the **rank column** and the **right capsule** in the lead (contract tabs).

---

## 6. Components

### 6.1 Legend row (per tab; `viz.legend`)
- 24 px, 12 px text `--a-label`. Swatch 10×10 radius 2; line swatch 14×2. It sits under the chip row and scrolls sideways on phone (it is hidden on phone when the cards show the same cues; phone has a "Key" link in the sort sheet).
- Contents by tab:
  - Overview: `▮ rich (IV > HV) ▮ cheap · ┃ 1.0×`;
  - contract tabs: `CE ▮ PE ▮` plus the tab's own items;
  - Sell/Buy: `Score ▮▮▮▮▮ 45 55 65 75` as a 5-step ramp with ticks;
  - Build-up: `▮ OI added ▨ OI removed · ▲ bullish ▼ bearish for the index`;
  - Arbitrage: `▮ executable ▮ near miss`.
- The text is fixed per tab. Only the threshold numbers come from settings (for example the POP tick shows the active filter).

### 6.2 Right capsule (CE/PE) and lead cell
- The capsule is "CE" or "PE", 10.5 px 700, padding 1 5, radius 4.
  - CE: `--dv-call-ink` on `--dv-call` at 12 % (light) / 16 % (dark).
  - PE: `--dv-put-ink` on `--dv-put` at the same tint.
- The lead cell has a 2 px leading edge in the side colour at 0.85 (`box-shadow: inset 2px 0 0`). The selected row replaces it with the 2 px `--sel-bg` bar (§6.7), so selection wins.
- The name is split: `${underlying} ${expiryText}` 600, then the strike 650. Records already carry `underlying`, `expiry`, `strike` and `right`; add `r.nameParts` in `chainRecords` to avoid re-parsing.
- A monthly expiry shows `M` in the sub-line (as today). "Expires today" in the sub-line is `--warn-ink` with a 6 px warn dot.

### 6.3 Verdict chip (Overview)
- **Rich**: `--dv-iv-ink` on an `--dv-iv` 14 % tint, ▲ glyph.
- **Cheap**: `--a-label` text, outline `--mat-separator`, ▽ glyph.
- **Fair**: plain `--a-label` text, no chip.
- **Expiry day**: `--warn-ink` on a `--warn` 16 % tint, ⚠ glyph.
- The glyphs are 9 px and precede the label. The chip is 20 px tall, radius 999, 11.5 px 650.

### 6.4 Build-up chip (Unusual, Build-up; also on cards)
- A two-letter tag (`LB`/`SB`/`SC`/`LU`) in a 20 px square chip. This follows foundation §4.6: LB and SC are `--pos-ink` on a 12 % `--pos` tint; SB and LU are `--neg-ink` on a `--neg` tint. The colour describes the option's own price direction, as on the chain and OI pages.
- The full action ("Put writing") follows as plain 12.5 px text. On the Build-up tab the "Tag" column becomes this chip, and the Reading column shows only the bias (§5.2). That removes about 140 px of repeated words.
- Tooltip: `O.BUILDUP_NAMES[tag]` and the reading text.

### 6.5 Score cell and composition micro-bar (Sell, Buy)
- The number is 650 14 px on the `seq` cell (text `--seq-ink-n` on steps 4–5).
- Under it, inside the cell (≥ 1280 only; on tablet the bar is hidden): a 48×4 px stacked bar of 4 segments whose widths equal the **renormalised weights** of the non-null parts (`w_i / Σw`).
  - Each segment's fill = `value_i` of its width.
  - Segment colours: `--seq-5`, `--seq-4`, `--seq-3`, `--seq-2`, in weight order.
  - So the total filled length / 48 = the raw score before the penalty.
- When a penalty applies (`penalties.length`), the filled part is drawn at 50 % with the hatch, and a 9 px ⚠ sits after the number. The title explains "× 0.5: inside 1σ".
- Data: `chainRecords` already builds `r.sell`/`r.buy` (`{score, parts, penalties}`); the column reads them.

### 6.6 Arbitrage status and legs
- **Status chips**:
  - Executable: `--pos-ink` on a `--pos` tint, ✓;
  - Near miss: `--warn-ink` on a `--warn` tint, ≈;
  - Check: `--a-label` outline, `?`.
- **Legs** render as tokens, not a sentence. Each leg is `[B|S] 25450 PE @8.85`:
  - the side letter is a 16 px square in `--pos-ink`/`--neg-ink` on a tint;
  - the strike is fg;
  - the right is in the CE/PE ink;
  - the price is in `--a-label`;
  - a quantity > 1 shows "2×" before the strike.
- Tokens flow in a 2-column grid (max 2 lines for 4 legs) at 12 px. The cell's `min-width` is 260 px.
- The banner "Costs are estimates…" is removed. The sentence lives in the footer legend line: "Net after estimated opening charges · quotes move".

### 6.7 Rows: selection, hover, stale, new
- **Hover** (fine pointer): `--mat-fill-1` on the whole row, including the sticky cells (which need an opaque blend: `background: linear-gradient(var(--mat-fill-1), var(--mat-fill-1)), var(--card)`).
- **Selected**: `--mat-fill-2` on the row and a 2 px `--sel-bg` leading bar on the rank cell. There is no blue outline.
- **Focus-visible**: a 2 px `--sel-ring` outline inside the row (`outline-offset: −2px`).
- **Stale**: the non-lead cells at 0.6 opacity (kept), plus a 6 px `--warn` dot in the rank cell.
- **New since the last sweep**: a 6 px `--dv-spot` dot before the rank for one sweep, with the title "New match since 09:08".
- **Rank movement**: a ▲3 / ▼2 in 10 px under the rank, `--pos-ink`/`--neg-ink`, for one sweep (§8.1). It is not shown when the movement is 0, or on the first sweep.

### 6.8 Sticky columns and table scroll
- **The rank cell (36 px) and the lead cell are both sticky** (`left: 0` and `left: 36px`), on an opaque `--card` background. A 1 px `--mat-separator` right edge appears **only when the table is scrolled sideways** (a `.scrolled-x` class toggled from a passive `scroll` listener on `.scr-wrap`). This avoids a permanent heavy rule.
- The head stays sticky inside `.scr-wrap`, which has its own scroll on desktop with `max-height: calc(100dvh − toolbar − 120px)`. The page never scrolls sideways.
- A right-edge 16 px fade (`mask-image`) shows when more columns sit off-screen.

### 6.9 Phone card (rebuilt `cardFor`)
```
│▌#1  NIFTY 3 Nov 27000 [CE]                 ┌64┐│
│▌    5d 6h · lot 75                         └──┘│
│▌    POP ▬▬▬▬▬▬▬▬▬░ 89%   1.19σ   ₹2,183/lot     │
│▌    IV 9.8 pts under HV · beyond call wall     │
```
- **Left edge**: 3 px in the side colour (contract tabs). Overview uses no edge; Arbitrage uses the status colour.
- **Line 1**:
  - the rank (`#1`, 12 px 700; ranks ≥4 in `--a-quiet`) and the name;
  - the right capsule;
  - at the right, the **badge**: the ranking value in a 36×28 px rounded square (radius 8) filled with its `seq`/`div` step and the step's ink. A text badge (verdict, tag, status) uses its chip.
- **Line 2**: the sub-line (11 px `--a-quiet`).
- **Line 3**: the 3 card keys. The first key shows its micro-visual when it has one (POP bar 64×4, `sigma`, `cbar`), then the value. The others are value + 10.5 px label. Each key is 600 13 px.
- **Line 4**: the reason, 12 px `--a-label`, **clamped to 2 lines** (`-webkit-line-clamp: 2`), never one-line ellipsis.
- **Movement**: the new-dot and the ▲/▼ sit next to the rank.
- Tap opens the detail sheet. Card min height is 76 px; the whole card is the 44 px+ target.

### 6.10 Detail (pane at ≥ 1280, sheet below)
In order:
1. **Header**: the title with the right capsule; the sub-line "Spot 26457.75 · F 26482.53 · 5d 6h · lot 75". The "as of" time is dropped, because the toolbar shows it; it shows only when stale, as "Data 3 min old" in `--warn-ink`.
2. **Score block** (Sell/Buy):
   - a 56 px SVG **ring**: track `--mat-fill-2`, arc in the score's `--seq-n`, arc length = score/100, 6 px stroke, round caps; the number is in the centre, 650 20 px;
   - beside it, the 4 parts as rows `Richness ▬▬▬▬░░ 35%`: label; a bar 100 px long whose track **width is proportional to the weight** and whose fill is the value; then "35 %" as the weight; the value is in the bar's title;
   - a part with a null value shows the track hatched and "n/a · weight shared";
   - the penalty is one line: "⚠ Halved: inside 1σ".
   - Other tabs: the ranking metric as a 22 px hero with its chip.
3. **Chart engine slot**: 180 px pane / 160 px sheet, "Price and IV history".
4. **Risk visual** (contract tabs; new, SVG, 100 px tall, the full width):
   - the **expiry payoff of one lot** of the leg on the side the tab is about (Sell → short, Buy → long; Unusual/Build-up/IV outliers → long);
   - the x range is F·e^(±2.5σ√T) at ATM IV, with 120 samples;
   - a profit area in `--pos` at 0.16, a loss area in `--neg` at 0.14, and the payoff line 2 px in fg;
   - a `--dv-band` shading for ±1σ;
   - a spot line `--dv-spot` with the pill "Spot 26457";
   - a breakeven tick with the label;
   - when "With wing" exists on Sell, a dashed second line (`--dv-today` style) for the spread, with the legend "naked ─ with 27200 wing ┄";
   - an unlimited side ends in an arrow "→ unlimited" in `--neg-ink`;
   - formula: payoff(S) = side · (max(0, ±(S − K)) − premium) · lot (+ the wing leg).
   - It is static: no scrubber. `role="img"`, with an `aria-label` summary "Max profit ₹2,183, breakeven 27029, loss unlimited above".
5. **Risk per lot**: key-value rows. The values are coloured: profit `--pos-ink`, loss `--neg-ink`, "Unlimited" `--neg-ink` 650. POP is shown as a bar (`hbar`, max 100) next to the figure. The wing row splits into 3 rows: "Wing 27200 CE", "Credit 15.75 · R:R 1:11.7", "Max loss ₹13,819".
6. **Warnings**: as today. The icon is in `--warn-ink` and the text is fg.
7. **Metrics**, in **3 groups** with section labels, each a 2-column `dl` grid at ≥ 360 px:
   - **Price**: bid/ask, mid, spread, IV, IV − HV20, vs ATM IV, neighbours IV;
   - **Greeks**: Δ, Γ, θ ₹/day, θ %/day, vega %, σ OTM, BE, BE σ, leverage;
   - **Activity**: volume, OI, OI chg (signed ink), Vol/OI, turnover, build-up chip, price chg (signed ink).
   - Overview/Hedge/Arbitrage keep their lists, grouped where natural (Vol / Move / OI for Overview).
8. **Costs**: collapsed into a `details` "Round-trip costs ₹52.40 ▸".
9. **Actions** (sticky at the bottom of the pane/sheet, `--card` background, top hairline):
   - **primary**: "Open in Option Chain" (accent fill, full width);
   - **then the side the tab is about**, as a 2-up grid:
     - Sell tab: [Sell → Strategy] in `--neg` fill (black text in dark per foundation §4.1), and [Sell with 27200 wing] secondary;
     - Buy tab: [Buy → Strategy] in `--pos` fill;
     - the opposite side is a plain text button below ("Add Buy instead").
   - 40 px tall (44 coarse).

---

## 7. Motion (foundation §6 primitives only; each has a reduced-motion fallback)

| What | Trigger | Animation | Duration / easing | Reduced motion |
|---|---|---|---|---|
| Tab thumb | tab change | `::before` slides (`--seg-x/--seg-w`) | `--dur-2` `--ease-std` | jumps |
| Results swap | tab change | the table body cross-fades: old out `opacity 1→0` 120 ms `--ease-in`, new in `0→1` + `translateY(4px→0)` `--dur-2` `--ease-out` | 320 ms total | instant swap |
| Row reorder (FLIP) | a sweep or sort changes the order | each kept row in the viewport: measure the old `top`, then the new one, `translateY(old−new) → 0`; rows outside the viewport just move | `--dur-3` `--ease-std`; max 40 rows animated; skip when > 40 move | instant |
| New row enter | a key not in the previous sweep | `opacity 0→1`, `translateX(−6px→0)`, plus a `--dv-spot` dot | `--dur-3` `--ease-out`, stagger 20 ms, cap 200 ms | dot only |
| Removed row | it fails the filters after a sweep | `opacity 1→0`, height collapse via `grid-template-rows` 1fr→0fr on a wrapper (cards only; table rows simply vanish after the fade) | 160 ms `--ease-in` | instant |
| Value flash | a cell's text changed between sweeps | `flashValue(el, dir)`: `--pos`/`--neg` background wash, or `--mat-fill-3` for a non-directional change | `--dur-flash` | 2 px leading-edge marker, 3 s |
| Bars, heat | first draw | `barsEnter`: `scaleX 0→var(--v)`, stagger 12 ms | `--dur-3` `--ease-out`, cap 240 ms | final size |
| Bars, heat | a sweep updates values | `transform` transition to the new `--v`; heat `background-color` transition | `--dur-3` `--ease-std` | none |
| Score ring | detail opens or the selection changes | `stroke-dashoffset` from the previous value | `--dur-4` `--ease-out` | final |
| Risk payoff | detail opens | `lineReveal` (first open per key only) | `--dur-4` | none |
| Match count | it changes | `countUp` from the old to the new value (format via `formatInt`) | `--dur-4` | final text |
| Sweep progress | while scanning | a 2 px bar under the head row; `scaleX(done/total)` transition `--dur-3`, plus **chain dots** in the live control's popover (§8.2) | | static width |
| Skeleton | first load | `dv-shimmer` rows at the final row height (table 8 rows, cards 5) | 1.4 s linear | static `--mat-fill-2` |
| Underlying chip "keep one" | removing the last chip | `scr-shake` kept, 360 ms | | an outline flash instead |

Performance:
- Animate only `transform`, `opacity` and `background-color`.
- FLIP measures with one `getBoundingClientRect` pass before the patch and one after, inside the same `requestAnimationFrame`.
- A sweep patches at most 200 cells; this is the existing patch-in-place design (`fillCell` with `__t` guards).

---

## 8. Interactions

### 8.1 Rank memory
- **Pure helper `rankDiff(prevKeys, nextKeys)`** in `screens.js` returns `Map key → {delta, isNew}`:
  - `delta = prevIndex − nextIndex`; positive means it moved up;
  - `isNew = !prevKeys.includes(key) && prevKeys.length > 0`.
- The page keeps `prevRanks` per preset. The snapshot is taken **at the end of each sweep** (not on every draw), from the sorted row keys under the default sort.
- When the user sorts by a non-default column, the movement glyphs are hidden. They are about the screen's own ranking.
- Glyphs and new-dots stay until the next sweep ends.

### 8.2 Live control popover (screener)
Click the time part of the live control (the dot part toggles auto) to open a popover:
- a **chain grid**: one 10 px dot per planned chain, grouped by underlying, labelled with the expiry. The states are:
  - done: `--pos`;
  - fetching: fg with a pulse ring;
  - pending: `--mat-fill-3`;
  - error: `--neg` + ✕;
  - stale: `--warn`;
- "Rescan now" (R);
- the auto interval capsule (Off / 1m / 2m / 5m), which writes `cfg.auto`.

This replaces the "Scanning 4/7 · NIFTY 10 Nov" text spam; the toolbar shows only "◌ Scanning 4/7".

### 8.3 Keyboard (kept), and the shortcut popover
The `?` button and `?` key open the existing `KEY_HINTS` as a popover. J/K, ↵, [ ], C, B/S, R, F, A and Esc are unchanged. The **phone** has no `?` button.

### 8.4 Filters sheet
- **Controls** use the foundation styles:
  - the multi chips (expiries, tags) are contrast-on with a ✓;
  - the switches are `--sel-bg`;
  - the segmented controls slide.
- **Live count in the primary button**: "Show 160" instead of "Done", updated on every change with `countUp`. With 0 matches the button reads "No matches" and stays enabled.
- **Per-filter impact hint** (from the existing leave-one-out `result.funnel`): when a filter alone removes rows, a 11.5 px `--a-quiet` line under its label reads "removes 42".
- **A changed value** gets a 6 px fg dot before the label. Reset per filter sits in a ⋯ menu on the row (P2).
- **Range inputs** stay numeric (exact values matter). P2 adds a **histogram strip** above Δ band, POP and days: 24 bins of the unfiltered records for the tab, bars in `--mat-fill-3`, the bins inside the current range in fg at 0.6, 28 px tall.

### 8.5 Sorting
- **Desktop**: click a header (kept); sorted header in fg 650 with ▲/▼.
- **Phone**: the sort chip sheet: a radio list of sortable columns, each with a ↑/↓ toggle at the right. It applies at once and closes.
- **Secondary tie-break** (new, in `S.runPreset`): when the primary values are equal, sort by the tab's second key:
  - Sell → POP desc;
  - Buy → BE σ asc;
  - Unusual → turnover desc;
  - Build-up → |OI chg| desc;
  - IV out → |rich ₹| desc;
  - Hedge → payout desc;
  - Arb → gross desc;
  - Overview → ATM IV desc.
  - Then sort by key, for stability.
  - Formula: `cmp = primary || secondary || key.localeCompare`.

### 8.6 Pinned rows (watch) (P2)
- A ☆ button in the detail header and as a long-press / right-click on a row. It toggles `cfg.pins[preset]` (a list of keys; max 10; stored in `SLOT`).
- Pinned rows that still match show first, under a "Pinned" group header (24 px, `--a-quiet`), with ★ in the rank cell. Pinned rows that no longer match show greyed with "No longer matches", until unpinned or after 1 IST day.

---

## 9. States

| State | Look | Copy |
|---|---|---|
| First load | skeleton rows/cards (`dv-shimmer`) at the final height, legend and chips drawn, `aria-busy` on the panel. The toolbar shows "◌ Scanning 0/7" | sr-only "Scanning 7 chains" |
| Partial (sweep running, some chains done) | rows appear progressively (kept); the remaining chains show as dots in the popover; no skeleton below real rows | n/a |
| Refreshing | nothing moves except flashes, FLIP and the progress line | n/a |
| Empty (filters) | compact `emptyState` in the panel: title "No contracts pass these filters", the tab description as one line, then the **leave-one-out buttons** (kept, now `tinted` secondary chips: "Turn off POP (+12)") and "Reset all". On Arbitrage: "No executable edge after costs across 1,240 strikes in 7 chains" plus "Show near misses" when that filter is off | as today |
| Empty (universe) | "No underlyings selected": not reachable (one chip is kept, the shake stays) | n/a |
| Error, all chains failed | `errorState` in place of the table: title "Couldn't scan any chain", the API message, Retry (secondary), Accounts link for auth codes. The live control shows "● Not updating" in `--neg-ink` | as today |
| Error, some chains failed | the slim `err-bar` above the table: "2 chains failed · Retry". It expands into the issue list (the existing `details`, restyled) | "BANKNIFTY 29 Dec: Rate limited" |
| Stale | the live control shows `--warn` "Stale · 3 min"; the rows' warn dot; the values at 0.6 | n/a |
| No HV history | one info line under the legend row (kept, `--a-label`, no box): "No daily history for SENSEX: IV/HV shows --" | as today |
| OI change missing (Build-up) | one warn line (`--warn-ink` with a ⚠ icon) | as today |
| Demo | nothing on this page (foundation §7) | n/a |

---

## 10. Accessibility

- Rows keep `aria-label` = name + reason. Add the rank and movement: "Rank 1, up 3. NIFTY 3 Nov 27000 CE. Score 64…".
- Visual cells carry the value as text. Bars, dots and rings are `aria-hidden`.
- Chips have text (glyph + word), so they are not colour-only.
- Contrast:
  - every ink is from the foundation tables (≥ 4.5:1);
  - seq steps 4–5 and div ±3 use their ink tokens;
  - sub-lines never go below `--a-quiet`.
- The tabs keep `role="tablist"` and roving tabindex. The sort sheet uses a radio group. The live control popover uses a `dialog` with focus return.
- Touch: every control is ≥ 44 px on coarse pointers, including the filter-chip ✕ (via the padding of a 44 px hit box) and the sort chip.
- `prefers-reduced-motion` honoured per §7.

---

## 11. Feature gaps (prioritised; exact behaviour)

**P1 (this round)**
1. **Colour and heat system** (§5): `viz` on the columns, `scoreStep`, `rankHeat`, `signedHeat`, `barFrac`, `sigmaPos` and `ratioPos` in `screens.js`, with tests.
2. **Rank column + movement + new marker** (§6.7, §8.1): `rankDiff` in `screens.js`, with tests.
3. **CE/PE capsule and side edge** (§6.2).
4. **Chips**: verdict, build-up, status (§6.3, §6.4, §6.6), plus arbitrage leg tokens.
5. **Score composition**, micro-bar and detail ring (§6.5, §6.10).
6. **Phone cards** rebuilt (§6.9), with a sticky sub-head and a sort sheet (§3.4, §8.5).
7. **Detail column always on at ≥ 1280**, auto-selecting rank 1; the chart slot moves inside; grouped metrics; sticky actions with side colours.
8. **Toolbar integration**: the live control = auto + time + scan state; the panel status/auto removed; the shortcuts become a popover.
9. **Motion**: FLIP reorder, value flash, bar transitions, count-up, tab cross-fade.
10. **Secondary sort tie-break** (§8.5).

**P2**
11. **Risk payoff mini-chart** in the detail (§6.10 item 4).
12. **Live control popover** with the chain-dot grid and the interval capsule (§8.2).
13. **Filters**: "Show N" button, per-filter "removes N" hints, changed-dot. Histogram strips for Δ band, POP and days.
14. **Pinned rows** (§8.6).
15. **Match map** (new, desktop ≥ 1280, collapsible, 140 px, above the table on contract tabs):
    - an SVG scatter of all matches;
    - x = |Δ| (0–1, ticks 0.1/0.25/0.5);
    - y = the ranking metric (score 0–100, or × median on log₂ for Unusual);
    - dot 5 px in the CE/PE colour, opacity 0.7, the selected dot 8 px with a `--sel-bg` ring;
    - hover shows the row tooltip and highlights the row; a click selects;
    - the top 10 by rank get rank numbers;
    - a legend "CE ● PE ●";
    - it answers "where do the best trades cluster" at a glance.

**P3 / LATER**
16. **Saved screens**: "Save as…" in Customise stores `{name, preset, filters, sort, cols}` in `SLOT.saved` (max 8). Saved screens appear as extra tabs after Arbitrage with a ★ glyph, and can be renamed or deleted in Customise.
17. **New-match alert**: an in-page toast when a pinned or saved screen gains a row at the end of a sweep ("2 new Sell matches · View").
18. **Copy as CSV** of the shown rows (to the clipboard; the numbers via `format.js`).
19. **IV rank / percentile**: when IV history exists (PRD 07 L1).

---

## 12. Build notes

- `screens.js`:
  - add `viz` to the column defs, the `secondary` key per preset, `nameParts` and the pure scale/rank helpers;
  - `card` gains `viz: true` for its first key.
  - Tests in `screens.test.mjs`: score bands at 44/45/54/55/64/65/74/75; `rankHeat` with < 5 values, outliers and asc inversion; `rankDiff` on first sweep, up, down, new and removed; the tie-break order; `ratioPos`/`sigmaPos` clamps.
- `screener.js`:
  - `fillCell` renders `viz` via `viz.js` (`hbar`, `heatCell`, legend);
  - the existing `heatOf` (3 grey steps) is deleted;
  - `drawTable` adds the rank cell and the FLIP pass;
  - `cardFor` is rebuilt to §6.9;
  - `detailView` is regrouped, with the score ring and the risk SVG (`svgEl` from `viz.js`; payoff samples from `options.js` `payoffAt` if present, else a local pure function in `screens.js`, tested);
  - `drawStatus` writes into the toolbar live control via the foundation's `#toolbar-ctx` API instead of the panel `status` span;
  - the `.scr-chart` panel is created only below 1280 when no detail column exists (in practice: never; the slot lives in the detail).
- `app.css`:
  - replace all `--ios-*` in `.scr-*` with the tokens;
  - delete the `heat-1/2/3` rules, `button.scr-uchip.on` blue and the `tr.sel` blue outlines;
  - add `.scr-pill`, `.scr-cap`, `.scr-mbar`, `.scr-cbar`, `.scr-dots`, `.scr-sig`, `.scr-rank`, `.scr-legend`, `.scr-card` v2, the sticky rank column and `.scrolled-x`;
  - add reduced-motion rules for every new transition.
- **No new files** are needed beyond the foundation's `viz.js`. If one is added, register it in `DASHBOARD_FILES` (`server/bridge/core/app.mjs`) and the `format.test.mjs` list.
- **CSP**: no inline styles; `--v` via `style.setProperty`.

## 13. Acceptance checks

- **Static** (`polish.test.mjs` or `screens.test.mjs`):
  - no `--ios-blue`, `--ios-green-ink` or `--ios-red-ink` inside `.scr-` rules;
  - no `heat-1`/`heat-2`/`heat-3` class remains;
  - `button.scr-uchip.on` resolves to the `--sel-*` block only.
- **Playwright** (`scratchpad/scr.cjs` extended), for 3 devices × 2 themes:
  - no horizontal page scroll;
  - the selected tab's computed background is rgb(255,255,255) in dark and rgb(10,10,11) in light;
  - on desktop the first data row's top is ≤ 215 px, `.scr-detail` is visible with a selected row, and there is no element `.scr-chart` taller than 200 px;
  - on phone the cards are ≤ 96 px tall (contract tabs) and the reason is never cut to one line;
  - on the Sell tab, the score cells of rank 1 and rank 20 have different computed backgrounds;
  - on the Build-up tab, a positive and a negative OI chg cell have different colours;
  - the CE and PE capsules differ in colour;
  - on the Arbitrage tab, the status chip of a near miss has the warn tint;
  - read every screenshot.

---

## 14. MUST-DO (ordered by value)

1. **Ranking you can see**:
   - a rank column (sticky with the lead);
   - the ranking column coloured on the violet `--seq` ramp (fixed `scoreStep` bands for Score; p5–p95 `rankHeat` for relative metrics, inverted for "lower is better");
   - delete the 3-step grey heat;
   - tie-break secondary sort per tab.
2. **Contrast selection and token clean-up**:
   - tabs as a sliding contrast capsule;
   - underlying/expiry chips contrast-on with ✓;
   - switches `--sel-bg`;
   - row selection as a `--mat-fill-2` fill + a `--sel-bg` leading bar;
   - the sorted header in fg, not blue;
   - replace every `--ios-*` colour in the `.scr-*` block with foundation tokens.
3. **CE/PE identity**: a blue/orange right capsule in the lead cell (and on cards) plus a 2 px side-colour leading edge, and the name split into underlying·expiry / strike.
4. **Per-tab visual columns (§5.2)**, at most two per tab, plus ink rules:
   - IV/HV centred gauge and verdict chips (Overview);
   - × median heat + turnover bar (Unusual);
   - ₹ committed heat + signed OI-chg bar in pos/neg with the decrease hatch (Build-up);
   - score + composition micro-bar and POP bar (Sell/Buy);
   - bump gauge (IV outliers);
   - annualised heat + depth bar (Hedge);
   - net ₹ diverging cells, status chips and leg tokens (Arbitrage);
   - liquidity dots; spread/θ/stale warn inks;
   - a legend row per tab.
5. **Phone cards rebuilt**:
   - rank + capsule + coloured badge;
   - a micro-visual on the first key;
   - a 2-line reason clamp;
   - 76–88 px tall;
   - sticky sub-head with a scrolling, centred, fading tab capsule;
   - a sort chip sheet;
   - 44 px targets.
6. **Desktop space and chrome**:
   - the status and auto move into the toolbar live control (one time only);
   - the head is one row (tabs + tools) plus one chip row with the match count;
   - the description and duplicate banners are dropped;
   - the key hints go into a `?` popover;
   - the first row at y ≤ 215;
   - the detail column always on at ≥ 1280, auto-selecting rank 1, with the chart engine slot inside it (the 600 px empty slot is removed).
7. **Detail redesign**:
   - a score ring + weight-proportional part bars;
   - risk values coloured, with a POP bar;
   - metrics in 3 groups (Price / Greeks / Activity) in 2 columns;
   - costs collapsed;
   - sticky actions: a primary "Open in Option Chain", then the tab's side in a `--neg`/`--pos` fill, the opposite side as a text button.
8. **Motion**:
   - FLIP row reorder after a sweep;
   - new-row enter with a dot;
   - rank ▲/▼ for one sweep;
   - value flash on changed cells;
   - bar/heat transitions (never regrow from zero);
   - tab cross-fade;
   - match count-up;
   - skeleton shimmer;
   - all with reduced-motion fallbacks.
9. **Rank memory**: `rankDiff` and the per-preset snapshot at the end of each sweep, hidden under a non-default sort; tests in `screens.test.mjs` alongside the scale helpers.
10. **Filters sheet polish**:
    - a "Show N" live-count primary button;
    - per-filter "removes N" hints from the existing funnel;
    - a changed-value dot;
    - foundation chip/switch styles.
11. **Risk payoff mini-chart** in the detail: one-lot expiry payoff with ±1σ band, spot pill, breakeven and the wing overlay on Sell.
12. **Live control popover**: the chain-dot scan grid, Rescan, and the auto interval capsule.
13. **Pinned rows** (☆, max 10 per tab, a "Pinned" group) and the **match map** scatter (|Δ| vs ranking metric, CE/PE dots, linked to the table) on desktop.
14. **Playwright audit (§13)** at phone/tablet/desktop × dark/light. Read every screenshot before pushing.
