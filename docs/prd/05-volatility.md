# PRD 05: Volatility, page `#/vol`

Status: ready to build · Owner: Options desk · Round 1

Files:
- new `server/bridge/dashboard/vol.js`: page UI, `createVolPage`.
- new `server/bridge/dashboard/vol-curves.js`: the two small purpose-built SVG curves (smile and term structure).
- `options.js` and `options.test.mjs`: all volatility maths, pure.
- `desk.js`: wiring only.
- `views.js`: the PAGES entry and the import.
- `app.js`: one new icon, `wave`.
- `app.css`: new section `12v · VOLATILITY`.
- `server/bridge/core/app.mjs`: add both new files to `DASHBOARD_FILES`.
- `format.test.mjs`: add both new files to the file list.
- `server/bridge/demo/demoAdapter.mjs` and `demo.test.mjs`: demo smile realism (§12.2).

No new API endpoint this round.

## 0. Decision: a new page, not a panel

`#/vol` is a new page in the Options group: `{ id: "vol", label: "Volatility", icon: "wave", tint: "pink", group: "Options", layout: "desk", title: "Volatility", sub: "Smile, skew, term structure and expected move", render: renderVolPage }`. It goes between `oi` and `positions` and is not in the phone tab bar.

Reasons:
1. The view needs one chain per listed expiry, up to N calls. The Option Chain page should not pay for those.
2. It needs width for two curves and a wide per-expiry table.
3. Every peer treats it as a destination: FYERS IV Skew, Dhan IV Analysis, NiftyTrader volatility dashboard, Barchart Volatility Charts, Market Chameleon, Unusual Whales.

It shares the desk state (underlying, expiry, account, Live/Paused, `mcb.dashboard.desk`) and the shared toolbar, so switching between Chain, OI and Volatility keeps the context.

What the page is: one screen that answers four questions:
- How expensive is volatility?
- Where is it rich along strikes (smile/skew)?
- Where is it rich along time (term structure)?
- How big a move is priced for each expiry (straddle and expected move)?

Every number shows its method. Anything the data cannot support is marked unavailable, not estimated. IV rank and IV percentile are the main case.

---

## 1. Goals per persona

| Persona | Job on this page | Numbers they decide on | Mistakes the page must prevent |
|---|---|---|---|
| **Buyer** (long gamma/vega, directional or event) | Decide whether options are cheap or dear, which expiry gives the most move per rupee, and whether the priced move clears the breakeven | ATM IV vs HV20 (IV − HV); straddle in points, % and ₹/lot per expiry; 1σ move per expiry; breakevens; straddle ÷ 1σ; ₹/lot a day; wing richness (16Δ IV − ATM IV) | Buying into an IV spike (IV far above realised); buying an OTM wing whose IV sits several points over ATM; buying expiry-day weeklies without seeing that theta dominates |
| **Seller** (strangles, condors, credit spreads) | Sell rich vol, put strikes outside the priced move, and lean toward the rich side | IV − HV20 (variance risk premium), HV20 percentile (labelled realised), 1σ range and the strikes at its edges, 25Δ RR (which side is rich), 25Δ fly, term shape (contango or inverted) | Selling inside the 1σ band; selling when IV is under realised; ignoring an inverted term structure; sizing a steep put skew as if it were symmetric |
| **Hedger** (long book or futures; protective puts, collars) | Find the cheapest protection per year, choose tenor and strike, and read the put skew cost | Hedge put (95/97/99% of forward) per expiry: points, % of forward, **annualised %**; 25Δ RR; forward and carry per expiry | Rolling weeklies when the monthly costs less per year; pricing off spot instead of the forward; buying puts when skew is at an extreme without seeing the RR |
| **Arbitrageur** (parity, boxes, flies, calendars) | Find executable mispricing across strikes and expiries | Parity forward per expiry vs the futures LTP (Fut − F); carry %; CE vs PE IV gap outside both bid–ask IV bands; vertical, butterfly and box violations at **bid/ask**; forward vol between expiries and variance inversions | Trading stale LTP prints; IV computed on spot instead of the forward; mixing broker IVs with computed IVs; ignoring that edges are gross of charges |

Success this round:
1. On a 390 px phone the first screen shows the toolbar, all 8 KPI tiles and the top of the smile, with no horizontal page scroll. Tapping an expiry row shows every metric for that expiry.
2. In demo, every KPI and every term-table cell has a value or a stated reason. The IV rank tile says "Unavailable" with its reason.
3. CE IV and PE IV agree within 0.1 vol point at every two-sided strike in demo. This proves the forward and model are consistent.
4. With 8 expiries loaded, a refresh tick costs 8 ms or less of main-thread time on desktop, and makes no more than 2 chain calls per 3 s tick.

---

## 2. Current implementation: keep, change, add, remove

### Keep
- The shared toolbar (`desk-bar`: underlying, expiry, account, clock, Live/Paused), the 3 s `REFRESH_MS` tick, `every()` (it already skips hidden tabs), the `st.seq` race guard, `alertBox`, `optional`, `segmented`, `keepFocus`.
- The tile markup and CSS (`.desk-stats` / `.desk-stat`), reused for the KPI strip.
- `O.black76`, `O.normCdf`, `O.sigmaMove`, `O.timeToExpiry`, `O.yearsToExpiry`, `O.mid`, `O.spreadPct`, `O.deltaTargets`, unchanged. The new functions sit beside them.
- Movable panels: every top-level section gets `data-panel`, so `arrangePanels` gives drag, maximise and persisted order for free.

### Change
| # | Today | Problem | Change |
|---|---|---|---|
| V1 | `renderDesk(kind)` knows chain / strategy / oi / positions | No volatility view | Add `renderVolPage = () => renderDesk("vol")`. For `kind === "vol"`, desk.js calls `createVolPage({ st, save, api, selectExpiry, refreshTick })` from `vol.js` and returns `[top, ...volPage.panels]`. The shared `summary` strip is **not** rendered on this page, because it has its own KPI strip. `drawAll` calls `volPage.draw(x)`. `activeDesk` is set to `{ root, onKey: volPage.onKey }` for this page. |
| V2 | `loadChain` always asks for `strikes=40` (`FETCH_STRIKES`) | Too narrow for 10Δ wings on monthlies | The vol page's selected expiry fetches `strikes=60` (`VOL_STRIKES`). desk.js picks the count per kind: `kind === "vol" ? 60 : FETCH_STRIKES`. |
| V3 | `save()` writes a fixed key list | Vol settings would be lost | Add `vol: st.vol` to the saved object and `st.vol = volConfig(prefs.vol)` to the state (§9). |
| V4 | Server IV (market/chain.mjs) is Black-Scholes on **spot** and **LTP**. The client prices on an undiscounted parity forward (`forwardPrice`) | Two models: a fake CE/PE IV gap that grows with DTE, and jagged wings from stale LTP | The vol page **recomputes every IV client-side**: Black-76 on the per-expiry parity forward, discounted at the rate setting, from the **mid** (LTP only as a flagged fallback). The broker/server IV is not used on this page. The methodology note says so (§5.12). Other pages are unchanged this round (LATER L9). |
| V5 | `chainSummary.atmIv` = mean of CE/PE IV at the nearest strike | Jumps a strike step as spot crosses the midpoint | The vol page uses `O.atmIvAt(points, F)`, linear in strike at the forward (§5.3). `chainSummary` is unchanged for the other pages. |
| V6 | `drawStats` ends with `void years;` | Dead code | Remove the line. |
| V7 | The demo smile depends on the right (PE below the money gets more skew than CE at the same strike) and has no term structure | Demo breaks put-call parity: every ITM call shows a fake "parity gap", and the term curve is flat | Demo IV becomes a function of strike and tenor only, with richer front expiries (§12.2). |

### Add (MUST; details below)
- KPI strip.
- Smile panel: SVG, x-axis toggle, series toggles, range, compare expiry.
- Strikes table.
- Term structure panel: SVG and shape label.
- Per-expiry table: customisable columns, phone detail rows.
- Realised vol (HV10/HV20/HV20 percentile).
- "Read" panel: persona lines.
- Arbitrage checks panel.
- Methodology panel.
- Chart engine slot.
- Keyboard.
- Settings.

### Remove
- Nothing user-facing. V6 removes dead code only.

---

## 3. Information architecture (panels, top to bottom, default order)

| Panel (`data-panel`) | Content | Fixed? |
|---|---|---|
| toolbar | Shared `desk-bar` | `data-fixed` |
| `vol-kpi` | 8 tiles for the selected expiry (§5.1) | movable |
| `vol-curves` | Smile (left) + term structure (right) on desktop; stacked below 1100 px | movable |
| `vol-term` | Per-expiry table (§6) | movable |
| `vol-strikes` | Strikes table for the selected expiry (§7) | movable |
| `vol-read` | Persona lines (§5.10) and arbitrage checks (§5.11), two columns ≥ 1100 px | movable |
| `vol-history` | **Chart engine slot**: "ATM IV and HV20 over time · chart engine slot". Empty bordered placeholder, 160 px tall (120 on phone), with a one-line caption saying which series it will show. No chart library | movable |
| `vol-method` | Methodology and data quality (§5.12), a `<details>`, closed by default | movable |

Phone default order: toolbar, kpi, curves, term, read, strikes, history, method. Phone defaults to the smile and term curves as **tabs** inside `vol-curves` (one visible at a time), because stacked they cost about 420 px.

---

## 4. Layout per device

All three widths, light and dark: no horizontal page scroll. Tables scroll only inside `.table-wrap`. Tabular numbers. Hairline rules as inset box-shadows (`--hl`). 44 px targets on `pointer: coarse`.

### 4.1 Desktop (1440×900, content about 1170 px)
- KPI strip: 8 tiles in one row (`repeat(8, minmax(0, 1fr))` at ≥ 1280; auto-fit below).
- `vol-curves`: CSS grid `minmax(0, 3fr) minmax(0, 2fr)`.
  - Smile SVG viewBox 640×280; term SVG 420×280.
  - Each half has a one-line head: title, controls right-aligned, and a readout line under the head.
- `vol-term`: full width. All chosen columns, sticky first column, row height 36 px.
- `vol-strikes`: full width, max-height 420 px with internal scroll and a sticky header. The ATM row is scrolled into view on first draw only.
- `vol-read`: grid `1fr 1fr`, persona lines left and arbitrage checks right.

### 4.2 Tablet (820×1180 portrait, content about 770 px; landscape behaves as desktop below 1280)
- KPI strip: 4×2.
- `vol-curves`: stacked. Smile then term, each full width, SVG height 240.
- `vol-term`: Expiry plus the **first 8** chosen columns. The rest go into the row detail (tap or Enter), as on phone.
- `vol-read`: stacked.

### 4.3 Phone (390×844, content 358 px)
- KPI strip: 2 columns × 4 rows. Tile padding 8/10, value 15 px.
- `vol-curves`:
  - The head shows a `segmented` [Smile | Term]. Its value is persisted (`st.vol.tab`).
  - SVG height 200.
  - Controls wrap onto one second line: x-axis segmented, a "Series" menu button and a range select.
  - The readout line is fixed height (no layout jump).
- `vol-term`:
  - Shows Expiry plus the **first 4** chosen columns. Default: DTE, ATM IV, Straddle, 1σ move.
  - Tapping a row toggles a detail row under it. The detail is a 2-column label/value grid of **every** other column, including hidden ones.
  - Only one row is expanded at a time.
  - Each row also has a "Select" button, which makes that expiry the selected one. That is how the phone changes expiry from the table; the toolbar select works too.
- `vol-strikes`: Strike, OTM IV, vs ATM, |Δ|, Flag. A `segmented` [OTM | CE/PE] swaps the three middle columns for CE IV and PE IV.
- `vol-read`: each persona is a collapsed `<details>` with its first line visible as the summary.

---

## 5. Every number: formula, format and edge cases

Conventions:
- IV is in **percent** (`ivPct`), as in the rest of `options.js`.
- Vol differences are **vol points** ("pts").
- `T` (years) = `O.timeToExpiry(e).days / 365`, floored at 0.25/365 for IV and delta maths only.
- `r` = rate setting (default 6.5 %, the server default). Discount factor `df = e^(−rT)`.
- All text goes through `format.js`. No grouping commas. A missing value prints `--` (DASH) with a `title` saying why.
- Unless a formula says "executable", **price** means the leg price from `O.legPrice(leg, basis)` (§5.2).

New exported constants and functions in `options.js` (pure, tested):

```
RATE = 0.065
legPrice(leg, basis = "mid") → { price, q: "mid" | "wide" | "ltp" | "none" }
impliedVolB76(price, F, K, years, right, df = 1) → ivPct | null
b76Delta(F, K, years, ivPct, right) → number | null          // forward delta: N(d1) or N(d1) − 1
impliedForward(chain, years, rate = RATE) → { F, source: "parity" | "spot" | null }
smilePoints(chain, { F, years, rate, basis }) → Point[]
atmIvAt(points, F) → ivPct | null
ivAtDelta(points, target) → { iv, strike } | null            // target −0.25 / −0.10 put, 0.25 / 0.10 call
skewMetrics(points, atmIv) → { rr25, bf25, rr10, bf10, put25, call25, put10, call10, wingPut16, wingCall16 }
termRow(chain, { now, rate, basis, hedgePct, spot, monthly }) → TermRow
forwardVol(a, b) → { vol, inverted }                         // a, b are TermRows, a before b
termShape(rows) → { kind, slope }
realisedVol(closes, n) → pct | null
hvPercentile(closes, n = 20, lookback = 252) → { pct, count } | null
arbChecks(chain, { df, minEdge = 0.5 }) → Hit[]
volRead(m) → [{ persona, lines: string[] }]
isMonthly(expiry, allExpiries) → boolean                     // last listed expiry in its calendar month
```

### 5.1 KPI strip (selected expiry; tiles patched in place, never rebuilt)

| Tile | Value | Sub line | Formula / notes | When missing |
|---|---|---|---|---|
| **Forward** | `formatFixed(F, 1)` | `Spot {S} · basis {formatSigned(F − S, 1)}` | §5.2 | `F` falls back to spot with sub "F = spot (no two-sided ATM quotes)" |
| **ATM IV** | `formatPercent(atmIv, 1)` | `CE {ceIv} · PE {peIv}` at the ATM strike, 1 dp | §5.3 | `--`, title "No usable ATM quotes" |
| **1σ move** | `±{formatInt(move)}` | `{formatPercent(move/F·100, 2)} · {formatInt(lo)}–{formatInt(hi)}` | `move = O.sigmaMove(F, atmIv, T)`; `lo = F·e^(−sd)`, `hi = F·e^(sd)`, `sd = σ√T` | `--` |
| **Straddle** | `formatFixed(straddle, 2)` | `₹{formatInt(straddle·lot)} a lot · ÷1σ {formatFixed(ratio, 2)}` | ATM-strike CE + PE price; `ratio = straddle / move` (lognormal theory ≈ 0.80) | `--` if either leg has no price |
| **25Δ skew** | `{formatSigned(rr25, 1)} pts` | "Puts richer" (rr25 ≥ 0.5) · "Calls richer" (≤ −0.5) · "Balanced" | `rr25 = IV(25Δ put) − IV(25Δ call)`. **Sign: put minus call**, printed in the tile title, because Deribit/CME use call − put | "n/a" with sub "Chain too narrow for 25Δ" |
| **25Δ fly** | `{formatSigned(bf25, 1)} pts` | "Wings over ATM" (> 0.3) · "Flat smile" | `bf25 = (IV25P + IV25C)/2 − atmIv` | as above |
| **HV20** | `formatPercent(hv20, 1)` | `IV − HV {formatSigned(atmIv − hv20, 1)} · pctl {formatInt(hvPct)}` | §5.8. The percentile is of **realised** vol (title says "realised, not implied") | `--`, sub "No daily history from this broker" |
| **IV rank** | `Unavailable` (muted, 13 px) | "Needs 252 days of IV history" | No IV history exists (§12.3). **Never estimated.** Title: "IV rank and IV percentile need a stored daily ATM IV. The Bridge does not record one yet." | always this round |

The 25Δ tiles and the HV20 tile set `aria-label` with the full sentence, e.g. "25-delta risk reversal, put minus call, plus 1.4 vol points: puts richer".

### 5.2 Forward and leg price
- **`legPrice(leg, basis)`**:
  - When `basis === "mid"`, bid > 0, ask ≥ bid: price = `(bid + ask)/2`. `q = "wide"` if `spreadPct > 10`, else `"mid"`.
  - Otherwise, when ltp > 0: price = ltp, `q = "ltp"`.
  - Otherwise `{ price: null, q: "none" }`.
  - With `basis === "ltp"` it always uses ltp (`q = "ltp"`), so the user can compare.
- **`impliedForward(chain, T, r)`**:
  - Take the 3 strikes nearest spot where both legs have `q` mid or wide.
  - For each, compute `F_K = K + (C − P)·e^(rT)`. F is the median of these.
  - `source = "parity"`. With no such strike, `F = spot`, `source = "spot"`. With no spot either, `{ F: null, source: null }`.
  - `O.forwardPrice` (undiscounted, used by other pages) is unchanged.

### 5.3 IV per leg, smile points and ATM IV
- **`impliedVolB76(price, F, K, T, right, df)`**:
  - Solves `df·Black76(F, K, T, σ) = price`.
  - Start from the Brenner–Subrahmanyam seed `σ0 = √(2π/T)·(price/df)/F`, clamped to [5 %, 200 %].
  - Newton on vega, falling back to bisection on [0.5 %, 500 %] whenever a step leaves the bracket. Stop when |Δσ| < 1e-6 or price error < 1e-7·F. Maximum 60 iterations.
  - Returns `null` when any of these hold:
    - price ≤ 0;
    - price < df·intrinsic − 0.025 ("below intrinsic");
    - price ≥ df·F for a CE, or ≥ df·K for a PE;
    - T ≤ 0;
    - no convergence.
- **`smilePoints`** returns one Point per strike with at least one leg:
  ```
  { strike, m,                       // m = (K/F − 1)·100, moneyness %
    ce: { price, q, iv, bidIv, askIv, delta } | null,
    pe: { ... } | null,
    otm: { side: "pe" | "ce", iv, delta, q } | null,   // PE for K < F, CE for K ≥ F
    callDelta,                       // b76Delta(F, K, T, otm.iv, "CE"): the delta x-axis
    gap,                             // true when ce.bidIv > pe.askIv or pe.bidIv > ce.askIv (parity outside both IV bands)
    out }                            // null, or "tick" | "intrinsic" | "range" | "noquote"
  ```
  - `bidIv` / `askIv` are the IV at bid / at ask. They are null when that side is missing.
  - `out` reasons:
    - "tick": price ≤ 0.05, the tick floor, where IV is meaningless;
    - "intrinsic": below intrinsic;
    - "range": iv < 1 or > 300;
    - "noquote".
  - Out points are not drawn, but they are listed in the strikes table, dimmed, with the reason.
  - `q = "ltp"` or `"wide"` points are drawn **hollow**.
- **`atmIvAt(points, F)`**:
  - Per strike, take `ivMid` = the mean of the valid CE and PE IV (or the one that exists).
  - Interpolate linearly in strike between the two strikes bracketing F.
  - If F is exactly a strike, use that strike's value.
  - If only one side brackets, use the nearest strike when it is within one strike step; otherwise return null.
- The **ATM strike** is the strike nearest F (lower on a tie). The tile's "CE / PE" values and the straddle use this strike.

### 5.4 Skew metrics (`skewMetrics`, `ivAtDelta`)
- Deltas are Black-76 forward deltas at each point's **own** OTM IV, not broker deltas.
- `ivAtDelta(points, −0.25)` uses the OTM puts (K < F, valid IV) ordered by strike. It interpolates IV linearly in delta between the two puts whose deltas bracket the target. Calls work the same way with K ≥ F and target +0.25.
  - No bracket returns null; the UI shows "n/a".
  - `strike` is the strike nearest the target delta, used for labels.
- `rr25 = put25.iv − call25.iv`; `bf25 = (put25.iv + call25.iv)/2 − atmIv`; `rr10` and `bf10` are the same at 10Δ.
- `wingPut16 = IV(16Δ put) − atmIv`; `wingCall16` is the same for calls. They are used by the Read panel.

### 5.5 Straddle and breakevens
- `straddle = ce.price + pe.price` at the ATM strike.
- `straddlePct = straddle/F·100`.
- `rupee = straddle · lot`, where lot = `chain.lotSize`. If the lot is missing, ₹ values print `--`.
- `perDay = rupee / max(days, 0.25)`, labelled "₹/lot a day". This is a theta proxy for comparing tenors.
- Breakevens: `K_atm − straddle` and `K_atm + straddle`.

### 5.6 Hedge put
- `hedgePct` is a setting: 95, 97 (default) or 99.
- Take the strike nearest `F·hedgePct/100` that has a PE price.
- `pts` = its price; `pctF = pts/F·100`; `annualPct = pctF · 365 / max(days, 0.25)`.
- The column shows `pts`, with a sub line `{annualPct}% a yr`.
- No strike within 1.5 steps of the target gives "n/a" with the title "Strike not in the loaded chain".

### 5.7 Term structure (`termRow`, `forwardVol`, `termShape`)
- **TermRow** fields: `{ expiry, weekday, monthly, days, years, F, source, basis: F − S, carryPct: ln(F/S)/T·100, atmStrike, atmIv, ceIv, peIv, straddle, straddlePct, rupee, perDay, move, movePct, lo, hi, beLo, beHi, ratio, rr25, bf25, rr10, hedge, futGap, quality, dim }`.
  - `quality` is the share of points within ATM ±10 strikes that have `q === "mid"`. Below 0.5 the row gets the flag "Thin quotes".
  - `dim = isExpiryDay(expiry) || days === 0`: the IST expiry date itself (the same calendar test as the toolbar's "Expires today"), not merely under 24 hours away. The evening before expiry is not dimmed.
- **Forward vol** between consecutive rows a → b: `v = (σb²·Tb − σa²·Ta) / (Tb − Ta)`, with σ in decimals.
  - `vol = √v · 100` when `v > 0`.
  - If `v ≤ 0`: `{ vol: null, inverted: true }`, shown as "Inverted" with the title "Total variance falls between these expiries: calendar check".
  - If `Tb − Ta < 0.5/365`: `{ vol: null, inverted: false }`.
  - Printed on row b ("from previous").
- **`termShape(rows)`** uses rows with `!dim && atmIv !== null`.
  - Fewer than 2 such rows: `{ kind: "insufficient" }`, label "Needs 2 expiries".
  - Otherwise `slope = (last.atmIv − first.atmIv)` in vol points:
    - `slope ≥ 0.5` gives "contango";
    - `slope ≤ −0.5` gives "backwardation";
    - otherwise "flat";
    - but "humped" when any interior row is more than 0.5 above both ends.
  - Labels: "Contango · back richer", "Inverted · front richer", "Flat", "Humped", printed in the term head with the slope in pts.
- **Fut − F**: for each term expiry, one batched `GET /v1/quotes?symbols=` with `{EXCH}:{U}-{expiry}-FUT`, where EXCH is NFO, or BFO for SENSEX/BANKEX.
  - `futGap = futLtp − F` (futures mid when bid and ask are present).
  - A missing future (weeklies have none) gives `--` with the title "No future for this expiry".
- **`isMonthly`**: true for the last expiry in each calendar month of the full expiry list, before any cap. It shows as a small "M" tag after the date.

### 5.8 Realised vol (`realisedVol`, `hvPercentile`)
- Data: `GET /v1/history?symbol={NSE|BSE}:{U}&interval=1d&countback=300`. SENSEX and BANKEX use BSE.
  - Drop a final candle whose IST date is today (a partial session).
  - Fetched once per underlying and cached in memory for 30 min.
- `realisedVol(closes, n)`:
  - `r_i = ln(c_i / c_{i−1})` over the last n returns.
  - Sample stdev (n − 1), × √252 × 100.
  - Null when fewer than n + 1 closes.
- HV10 and HV20 are computed. HV20 is in the tile; HV10 goes in the tile title.
- `hvPercentile`:
  - Build the rolling HV20 series over the last `lookback` days.
  - `pct = 100 · #(hv_i < hv_now) / count`.
  - Null when `count < 120`; the sub then reads "pctl n/a".
- Trading-day convention: HV uses √252, while IV uses calendar days. The methodology note says so.

### 5.9 Arbitrage checks (`arbChecks`; executable prices only, selected expiry)
- Strikes: ATM ±20 with both bid and ask.
- `minEdge = 0.5` pts per unit.
- Each Hit is `{ kind, legs: [{ side: "BUY" | "SELL", right, strike, price }], edge }`.
- Checks:
  1. **Call vertical**: for adjacent K1 < K2, `C2.bid − C1.ask > minEdge`. Buy C1, sell C2 for a credit.
     **Put vertical**: `P1.bid − P2.ask > minEdge`.
  2. **Vertical bound**: `C1.bid − C2.ask − (K2 − K1)·df > minEdge`. The credit is above the maximum loss. Puts mirror this.
  3. **Butterfly**: for three adjacent equally spaced strikes, `2·C2.bid − C1.ask − C3.ask > minEdge`. That is a long fly for a credit. Puts are the same.
  4. **Box** (adjacent K1 < K2):
     - buy-box cost = `C1.ask − C2.bid + P2.ask − P1.bid`, and the hit is `(K2 − K1)·df − cost > minEdge`;
     - sell-box proceeds = `C1.bid − C2.ask + P2.bid − P1.ask`, and the hit is `proceeds − (K2 − K1)·df > minEdge`.
     - Box hits carry "depends on rate" in their text.
  5. **Calendar variance** (across the term rows, model-based, informational): every `forwardVol(...).inverted` pair.
- Hits are sorted by edge, descending, and the panel shows the top 8. Each line reads, for example: "Butterfly · Buy 26400 CE @ 195.70 · Sell 2× 26450 CE @ 170.15 · Buy 26500 CE @ 145.45 · edge 0.85 pts · ₹64 a lot".
- Footer: "Gross of brokerage, STT (0.15% of sell premium; 0.15% of intrinsic on exercised ITM) and exchange charges. Quotes can move before you trade."
- With no hits: "No executable violations at bid/ask across {n} strikes (verticals, flies, boxes)."
- No order buttons this round (LATER L7).

### 5.10 Read panel (`volRead(m)`; deterministic text, neutral ink, never green/red)
`m` carries:
- `atmIv`, `hv20`, `vrp = atmIv − hv20`, `rr25`, `wingPut16`, `wingCall16`;
- `straddle`, `straddlePct`, `move`, `movePct`, `ratio`;
- `emDown` / `emUp`: the strikes nearest `lo` / `hi`;
- `shape`, `inversions[]`;
- `hedge` (selected expiry) and `cheapestHedge` (the lowest `annualPct` across loaded rows, with its expiry);
- `hits.length`, `gapCount` (points with `gap`), `futGaps` (rows with a future);
- `days`, `expiryLabel`.

Lines are emitted only when their inputs exist:
- **Buyer**:
  1. "The ATM straddle costs {straddle} ({straddlePct}%): that is the move needed by {expiry} to break even. The 1σ move is ±{move} ({movePct}%)." Always shown.
  2. "IV is {vrp} pts over 20-day realised: options are priced above recent movement." Shown when vrp ≥ 2. When vrp ≤ −1: "…under 20-day realised: options are cheap relative to recent movement."
  3. "The 16Δ put is {wingPut16} pts over ATM IV: OTM puts are dear; a spread offsets it." Shown when wingPut16 ≥ 3. The call side is the same when wingCall16 ≥ 3.
  4. "Expiry day: time value decays fastest now." Shown when days < 1.
- **Seller**:
  1. "1σ range {lo}–{hi}: {emDown} PE and {emUp} CE sit at its edges." Always shown.
  2. The vrp line, phrased for sellers: "IV is {vrp} pts over realised: premium is rich relative to recent movement" / "IV is under realised: premium is thin relative to recent movement".
  3. "Front IV is above later expiries (inverted): the market expects a near-term move." Shown when shape = backwardation.
  4. "Puts carry {rr25} pts more IV than calls at 25Δ." Shown when rr25 ≥ 2. Calls get the mirror line when rr25 ≤ −2.
- **Hedger**:
  1. "{hedgePct}% put ({strike} PE): {pts} pts, {pctF}% of the forward, {annualPct}% a year." For the selected expiry.
  2. "Cheapest per year among loaded expiries: {expiry} at {annualPct}%." Shown when it differs from the selected expiry.
  3. The rr25 line, worded for hedging: "Downside protection carries {rr25} pts of skew over calls."
- **Arbitrageur**:
  1. "{n} executable violations at bid/ask (gross)." or "No executable violations at bid/ask."
  2. "CE/PE IV gap outside both bid–ask bands at {gapCount} strikes: check conversions/reversals." Shown when gapCount > 0.
  3. "Total variance falls from {e1} to {e2}: forward vol undefined." Shown for each inversion.
  4. "{expiry} future is {futGap} pts {over|under} the parity forward." Shown when |futGap| > 0.1 % of F.
- Footer, always: "Context from current prices, not advice."

### 5.11 Strikes table (selected expiry; rows in strike order)
- Columns: Strike | Mny % (`formatSigned(m, 1)`) | CE IV | PE IV | OTM IV | vs ATM (`otm.iv − atmIv`, signed pts) | |Δ| (OTM leg, 2 dp) | Spread % (OTM leg) | Flag.
- The "Bid/ask IV" toggle in the panel head changes the CE IV and PE IV cells to `bidIv–askIv`.
- Flags are text, not colour:
  - `◦ LTP`: priced from LTP;
  - `W`: wide;
  - `⇄`: parity gap;
  - the out reason, e.g. "tick floor", "below intrinsic".
- Markers:
  - The ATM row gets class `atm` and a "ATM" chip.
  - A hairline separates the rows either side of F.
  - The 25Δ and 10Δ strikes get small tags ("25Δ P", "10Δ C") from `skewMetrics`.
- The table and the smile SVG share one **highlight**: hover, focus, J/K or a tap on either highlights the same strike in both and fills the smile readout.

### 5.12 Methodology (`vol-method` `<details>`; also the source of the KPI tile titles)
- Time: calendar days to 15:30 IST ÷ 365 (calendar-day vol), floored at 0.25 day for IV.
- Rate: the setting value (default 6.5 %), the same default as the server.
- Forward: the median of `K + (C − P)·e^(rT)` over the 3 two-sided strikes nearest spot.
- IV: Black-76 on that forward, from the bid–ask mid. LTP is used only when there is no two-sided quote, and those points are hollow.
- Broker/server IVs (`greeksSource`) are not used here, so they can differ from the Option Chain's IV column.
- ATM IV: linear in strike at the forward.
- RR sign: put minus call.
- HV: daily log returns, sample stdev, √252, completed sessions only.
- IV rank and IV percentile: unavailable, with the reason.
- Data age: `freshness.asOf` of the selected chain and the oldest term row, e.g. "Term rows 3–14 s old".

---

## 6. Per-expiry table (`vol-term`)

`VOL_TERM_COLUMNS` (in `vol.js`, exported for tests). Each entry has an id, header, cell, sub line and a default flag.

| id | Header | Cell (sub line) | Default |
|---|---|---|---|
| expiry | Expiry | `3 Nov Tue` + "M" tag; the selected row is marked with `aria-current="true"` and a leading bar (always first, not removable) | fixed |
| dte | DTE | `formatFixed(days, days < 3 ? 1 : 0)` | ✓ |
| atmIv | ATM IV | `formatPercent(atmIv, 1)` | ✓ |
| straddle | Straddle | pts (`straddlePct`%) | ✓ |
| move | 1σ move | ±pts (`movePct`%) | ✓ |
| range | 1σ range | `lo–hi` | ✓ |
| rr25 | 25Δ RR (P−C) | signed pts | ✓ |
| bf25 | 25Δ fly | signed pts | ✓ |
| fwdVol | Fwd vol | `formatPercent(vol, 1)` or "Inverted" | ✓ |
| perDay | ₹/lot a day | `formatRupee(perDay, 0)` | ✓ |
| atmStrike | ATM | strike | |
| ceIv / peIv | CE IV / PE IV | at the ATM strike | |
| rupee | Straddle ₹/lot | `formatRupee(rupee, 0)` | |
| be | Breakevens | `beLo–beHi` | |
| ratio | Straddle ÷ 1σ | 2 dp | |
| rr10 | 10Δ RR | signed pts | |
| fwd | Forward | 1 dp (sub: basis) | |
| carry | Carry %/yr | 2 dp | |
| futGap | Fut − F | signed 1 dp | |
| hedge | Put {hedgePct}% | pts (`annualPct`% a yr) | |

Row behaviour:
- Rows follow expiry order. `dim` rows (expiry day) use `--a-quiet` ink with "Expiry day" in the DTE title. They are excluded from the shape label and are not used as the "a" side of forward vol.
- Clicking a row selects it (`selectExpiry(e)`). On a coarse pointer, a tap toggles the detail row and the "Select" button selects.
- Loading rows show the date and "Loading…" in one spanning cell. An error row shows "Couldn't load · Retry" (button). Other rows are unaffected.
- The number of expiries loaded is a setting (4 / 6 / 8 / 12, default 6), counted from the nearest. If the selected expiry is beyond the cap, it is loaded too.
- Footer line: "{n} of {total} expiries · shape {label}".

---

## 7. Curves (`vol-curves.js`; small SVG, no library)

`smileSvg(series, opts)` and `termSvg(rows, opts)` return an `<svg>` built with the existing `s()` helper pattern (copied, not imported from desk.js). They are rebuilt only when their input object changes, which is memoised by chain identity and settings.

### 7.1 Smile
- **x-axis** (segmented, persisted `st.vol.x`): Strike | Mny % | Delta.
  - Delta plots `callDelta` from 1 (left) to 0 (right), so puts stay on the left. Ticks read "10Δ P", "25Δ P", "50Δ", "25Δ C", "10Δ C".
- **y**: IV %, `niceTicks` (copied), padded 1 vol point.
- **Series** (menu of checkboxes, persisted `st.vol.series`):
  - OTM composite: on by default. Solid line in `--accent` ink.
  - CE IV: off by default. Dashed.
  - PE IV: off by default. Dotted.
  - Lines are told apart by **dash pattern and direct end labels**, not by green/red.
  - Valid points are filled circles r = 2.5 (r = 3.5 on coarse pointers). `q !== "mid"` points are hollow. Lines skip `out` points without joining across a gap larger than 2 strikes.
- **Markers**:
  - A vertical hairline at F, labelled "F {F}".
  - A shaded band from `lo` to `hi`, labelled "±1σ".
  - A dotted vertical at spot, only when |F − S| ≥ half a strike step.
- **Range** (select, persisted `st.vol.range`): ATM ±10 | ±20 (default) | All loaded. This applies to the strikes table too.
- **Compare** (select, persisted as `"none" | "next" | "monthly"`): overlays the OTM composite of the next expiry, or of the first monthly that is not the selected one. It is drawn in `--a-label` ink and dashed, with an end label of its date.
  - The x-axis must be Mny % or Delta for compare. If it is Strike, compare switches the axis to Mny % and toasts "Compare uses moneyness".
- **Readout** (one line above the plot): "{strike} · Mny {m}% · OTM {iv}% · CE {ce} · PE {pe} · |Δ| {d}". With no highlight it shows ATM.
- **Pointer**: move or tap selects the nearest point by x and highlights it in the table. Leaving the plot clears the hover but not a keyboard highlight.

### 7.2 Term
- x = √DTE, scaled so weeklies do not bunch, with ticks labelled by short dates. y = ATM IV %.
- Points are joined by a line. The selected expiry gets a ring. Monthly expiries get a small "M". Dim rows are hollow.
- Toggle "25Δ P / C" (persisted, off by default): adds two dotted series of put25 and call25 IV.
- Clicking or tapping a point selects that expiry.
- Head: title "Term structure", then the shape label and slope ("Contango · +1.8 pts").
- With 1 row, the SVG shows the single point and the text "Needs 2 expiries for a curve".

### 7.3 Accessibility
- Both SVGs have `role="img"` and an `aria-label` sentence, e.g. "Smile for 3 Nov: ATM IV 12.2%, 25-delta put minus call +1.4 points, 41 strikes". The tables are the accessible data.
- No animation.

---

## 8. Data loading and performance

- **Selected expiry**: desk.js `loadChain` on every tick (`strikes=60&greeks=false`). Greeks are not needed because IVs and deltas are recomputed, and this saves server work. The chain page still asks for greeks.
- **Term expiries**: `vol.js` keeps `cache = Map<expiry, { chain, at, error }>`.
  - On page load or underlying change, it fetches all capped expiries with **concurrency 2** (`greeks=false`, `strikes` sized from the expected move: `clamp(ceil(2.2·F·σ√T / step), 40, 80)` each side, with σ the nearest loaded expiry's ATM IV or 20%, so the 25Δ wings are in the window).
  - After that, each tick refreshes **one** non-selected expiry, round-robin, oldest first. With 6 expiries, each row is at most about 15 s old; the methodology note prints row ages.
  - Underlying change clears the cache and bumps a `volSeq` guard.
  - The selected expiry's entry is always the latest `st.chain`, so no duplicate fetch.
- **Futures quotes**: one `/v1/quotes` call for all term expiries every 5th tick (15 s). Errors per symbol are ignored.
- **History**: once per underlying per 30 min (§5.8).
- **Compute**: `smilePoints` and `termRow` are memoised per chain object (a WeakMap). The arbitrage checks run on the selected chain only. Budget: ≤ 8 ms per tick on desktop with 8 expiries; measure with `performance.now()` in the Playwright run (§11.2).
- **DOM**:
  - The KPI tiles, the term table and the strikes table are **built once and patched** by cell, as `createChain` does. Rows are keyed by expiry and by strike.
  - Re-render only when the row set changes, e.g. range, columns or expiry.
  - Focus is preserved with `keepFocus`.
- **Paused** (Live off): no polling at all. Pressing R refreshes the selected chain and the oldest term row.

---

## 9. Settings (persisted in `mcb.dashboard.desk` under `vol`; validated by `volConfig(saved)`)

| Key | Values (default) | Where |
|---|---|---|
| `x` | `"strike" \| "m" \| "delta"` (`"strike"`) | Smile head |
| `series` | `{ otm: true, ce: false, pe: false, wings: false }` | Smile "Series" menu; `wings` = the term 25Δ toggle |
| `range` | `"10" \| "20" \| "all"` (`"20"`) | Smile head |
| `compare` | `"none" \| "next" \| "monthly"` (`"none"`) | Smile head |
| `tab` | `"smile" \| "term"` (`"smile"`) | Phone only |
| `cols` | ordered ids from `VOL_TERM_COLUMNS` (the default set) | Customise popover |
| `expiries` | `4 \| 6 \| 8 \| 12` (`6`) | Customise popover |
| `hedgePct` | `95 \| 97 \| 99` (`97`) | Customise popover |
| `basis` | `"mid" \| "ltp"` (`"mid"`) | Customise popover |
| `rate` | number 0–15 (`6.5`) | Customise popover (input, step 0.25) |
| `bidAsk` | boolean (`false`) | Strikes table head |

Customise popover:
- Opened by a "Customise" gear button in the `vol-term` head, following the chain's Customise pattern.
- Each column has a checkbox plus ↑/↓ buttons, so reordering works by keyboard and touch. No drag needed.
- A "Reset" button restores the defaults.
- Invalid saved values fall back to defaults silently. Unknown column ids are dropped.

Panel order and maximise come from `arrangePanels` (already persisted per page).

---

## 10. Interactions and keyboard

Keys come through the existing `bindKeys` via `onKey`. They are ignored in inputs and dialogs, and with modifier keys.

| Key | Action |
|---|---|
| `[` / `]` | Previous / next expiry (selects it, as in the toolbar) |
| `J` / `K` (↓ / ↑ when a strike is highlighted) | Move the strike highlight in the smile and strikes table |
| `G` | Highlight ATM |
| `X` | Cycle the smile x-axis |
| `C` | Cycle compare: none → next → monthly |
| `T` | Phone or tablet: switch the Smile/Term tab; desktop: no-op |
| `P` / `R` | Pause / refresh (shared) |
| `Esc` | Clear highlight, close the detail row |

Other interactions:
- A keys hint row (like `.desk-keys`) sits under `vol-strikes` and is hidden on coarse pointers.
- The term table rows are focusable (`tabindex="0"`). Enter selects; Space toggles the detail.

---

## 11. Test plan

### 11.1 Unit tests (`options.test.mjs`)
- `impliedVolB76`:
  - round-trips CE and PE for σ in {5, 12, 40, 150}%, T in {0.5/365, 7/365, 90/365}, K/F in {0.9, 1, 1.1}, df in {1, 0.98}, within 1e-4 pts;
  - returns null below intrinsic, at or above the upper bound, at price 0 and at T = 0.
- `b76Delta`: ATM CE ≈ 0.5 + small; put = call − 1.
- `impliedForward`:
  - recovers F on a synthetic Black-76 chain with df ≠ 1;
  - uses the median of 3;
  - falls back to spot when there are no two-sided quotes.
- `legPrice`: mid, wide (> 10%), ltp fallback, none, and the forced "ltp" basis.
- `smilePoints`:
  - flat 15% chain: every OTM IV is 15 ± 1e-3 and there are no gaps;
  - picks the OTM side correctly at K = F;
  - out reasons for tick floor, below intrinsic and > 300%;
  - `gap` true when CE IV > PE ask IV by construction.
- `atmIvAt`: exact strike, interpolation, one-sided within and beyond one step.
- `ivAtDelta` and `skewMetrics`:
  - a linear-skew synthetic chain gives a known rr25 and a positive bf25 for a convex smile;
  - a narrow chain gives null.
- `termRow`: straddle, ₹/lot (lot missing gives null), perDay floor, BE, ratio ≈ 0.80 on a flat smile, hedge put nearest strike and annualisation, `dim` on expiry day.
- `forwardVol`: the known value √((0.15²·0.1 − 0.12²·0.02)/0.08); inverted when variance falls; null under half a day.
- `termShape`: contango, backwardation, flat, humped, insufficient; dim rows excluded.
- `realisedVol`: a constant-return series gives 0; a known alternating series matches a hand value; null when too short.
- `hvPercentile`: null under 120 points; 100 at the series max.
- `arbChecks`: no hits on a clean synthetic chain. It detects a planted vertical, a planted butterfly and planted buy-box and sell-box mispricings, and computes their edges.
- `volRead`: each threshold line appears and disappears at its boundary; there is no line when its inputs are null; the footer is always present.
- `isMonthly`: last-in-month detection across a year boundary.
- `vol.js` exports `VOL_TERM_COLUMNS` and `volConfig`. A small test (in `options.test.mjs` or a new `vol.test.mjs` without DOM) checks the defaults, invalid input and the dropping of unknown columns.
- Demo (`demo.test.mjs`): CE and PE prices at the same strike satisfy parity (the same vol). Front ATM vol > back ATM vol. The put-side vol at K = 0.95·S is greater than the call-side vol at 1.05·S.

### 11.2 Playwright (copy `desk.cjs` to `vol.cjs`; screenshots under `scratchpad/shots/`; open and look at every one)
- `#/vol` NIFTY at 390×844, 820×1180 and 1440×900, light and dark: 6 shots.
- BANKNIFTY at 1440, light: a 3-row term table and the shape label.
- Assertions per run:
  - `document.scrollingElement.scrollWidth <= innerWidth`;
  - 8 KPI tiles, each with non-empty text;
  - the IV rank tile contains "Unavailable";
  - term rows = min(listed, 6);
  - the smile SVG has ≥ 20 circles;
  - no "NaN", "undefined", "null" or "Infinity" anywhere in `#content` text;
  - no console errors.
- Phone:
  - tap the 2nd term row: the detail is visible and contains "Breakevens";
  - tap "Select": the toolbar expiry changes.
- Keyboard (desktop): `]` changes the expiry select value; `X` changes the pressed x-axis button; `J` moves the highlighted strike row.
- Error: `page.route("**/v1/optionchain**expiry=<3rd>**", 500)` makes that row show "Retry" while the others are filled. Then unroute and click Retry, and the row fills.
- Timing: log the max of `performance.now()` deltas around `volPage.draw` over 10 ticks (via a `window.__volDrawMs` debug hook set only when `localStorage["mcb.debug"]` is set). It must be ≤ 8 ms.

### 11.3 Gates
`npx vitest run server/bridge/dashboard`, then the full `npx vitest run` and `npm run -s check:mjs`. The house rules in format.test.mjs (no `toFixed(` etc.) cover the new files.

---

## 12. Data and API

### 12.1 Existing endpoints used
- `/v1/expiries`
- `/v1/optionchain` (`strikes`, `greeks=false`)
- `/v1/quotes` (futures)
- `/v1/history` (1d, countback 300)

No change to them.

### 12.2 Demo realism (server, small, tested)
In `demoAdapter.mjs`, `smileVol` becomes `smileVol(u, spot, strike, years)`, independent of the right:

```
x    = ln(K/S) / √max(years, 1/365)
base = u.iv · (1 + 0.3 · e^(−years·365/6))          // front expiries richer
vol  = base · (1 + 1.2·x² + (x < 0 ? 0.8 : 0.1)·|x|) + 0.002·sin(K/step)
```

`optionPrice` passes `years`. Parity then holds by construction, because both rights use the same vol and BS has the same rate. The implementer may tune the constants. The acceptance is the demo tests in §11.1, plus a visibly downward-sloping NIFTY smile and a contango-or-inverted, non-flat term curve in the screenshots. Update any demo test that pins exact prices.

### 12.3 IV history (not this round)
No endpoint stores ATM IV. `/v1/history` serves price bars only. Option history is broker-dependent, and expired contracts are not listed. Therefore IV rank and IV percentile are shown as **Unavailable** with the reason (§5.1). The design for later is L1.

---

## 13. States

| State | What shows |
|---|---|
| First load | Tiles show `--`. The smile shows "Loading the chain…". The term table shows one row per expiry with "Loading…". The history slot shows its caption |
| Selected chain error | `alertBox(err)` in `vol-curves`. KPI tiles show `--`. Term rows that loaded stay visible |
| Term row error | That row reads "Couldn't load · Retry". The shape label is computed from the rows that loaded |
| No expiries | The same alert as the other desk pages |
| No two-sided quotes (market closed or a feed without depth) | A banner above the smile: "No live bid/ask: IVs use last traded prices (hollow points)". The arbitrage checks say "Needs live bid/ask" |
| Expiry day selected | A banner: "Expiry day: IV is unstable in the final hours". The row is dimmed |
| F from spot | The Forward tile sub says so. The methodology note lists it |
| Narrow chain | The 25Δ/10Δ cells read "n/a" with the title "Chain too narrow" |
| HV unavailable | The HV20 tile shows `--` with sub "No daily history from this broker". The persona lines that need vrp are omitted |
| One expiry only | The term SVG shows a single point plus "Needs 2 expiries". Fwd vol is `--` |
| Paused | The clock shows "Paused". Nothing polls |

---

## 14. Accessibility
- Real `<table>` elements with `<th scope="col">`. The selected term row has `aria-current="true"`. The detail row is linked with `aria-expanded` and `aria-controls`.
- Flags are text glyphs with `title`s. Meaning never depends on colour. Green and red are not used on this page (no gains or losses are shown).
- The SVGs have `role="img"` and an `aria-label` sentence (§7.3). The readout line is `aria-live="polite"`, updated at most once per 500 ms.
- Focus rings are visible. Every control can be reached and used by keyboard, with no drag-only actions. Targets are 44 px on coarse pointers.
- Contrast is checked in light and dark. Hollow points have a 1.5 px stroke in `--accent`.

---

## 15. MUST (this round), ranked

1. **Maths** in `options.js` with tests: `RATE`, `legPrice`, `impliedVolB76`, `b76Delta`, `impliedForward`, `smilePoints`, `atmIvAt`, `ivAtDelta`, `skewMetrics`, `termRow`, `forwardVol`, `termShape`, `realisedVol`, `hvPercentile`, `arbChecks`, `volRead`, `isMonthly`.
2. **Page wiring**: PAGES entry `vol`, `wave` icon, `renderVolPage`, desk.js per-kind strikes / no shared summary / `activeDesk` / `save` (V1–V3), V6 cleanup. New files go in `DASHBOARD_FILES` and the `format.test.mjs` list.
3. **KPI strip**: 8 tiles, with IV rank explicitly "Unavailable".
4. **Per-expiry table**: default columns, multi-expiry loader (concurrency 2, round-robin), row select, phone and tablet detail rows, error and retry rows, M tag, dim expiry day, footer.
5. **Smile SVG**: OTM/CE/PE series, x-axis Strike/Mny/Delta, F line, ±1σ band, hollow and out points, range, readout, shared highlight with the strikes table.
6. **Term SVG**: shape label, select by click, 25Δ wings toggle.
7. **Strikes table**: flags, bid/ask IV toggle, 25Δ/10Δ tags.
8. **Realised vol**: HV10/HV20/HV20 percentile from `/v1/history`, and IV − HV.
9. **Read panel**: 4 personas.
10. **Arbitrage checks panel**: verticals, bounds, flies, boxes and calendar variance, at executable prices, gross of charges.
11. **Settings**: `st.vol`, the Customise popover (columns and order, expiries, hedge %, basis, rate), validation.
12. **Keyboard** `[ ] J K G X C T P R Esc`, and the keys hint.
13. **Methodology panel** and the **chart engine slot** placeholder.
14. **Demo realism** (§12.2) with demo tests.
15. **CSS** section `12v · VOLATILITY`, at 3 widths × 2 themes, verified by the Playwright run (§11.2).

## 16. LATER (ranked)

- L1 **IV history store**: the server snapshots ATM IV per expiry and a 30-day constant-maturity IV once a day at 15:25 IST into the local store, and exposes `GET /v1/vol/history?underlying=&days=`. The tile shows "n of 252 days collected" until there is enough. IVR (52-week high/low) and IVP (share of days below) then go live, with a lookback setting of 30/90/252 days.
- L2 **Chart engine series**: ATM IV vs HV20 over time, time-lapse skew (the same expiry on earlier dates), and intraday ATM IV and straddle. These go into the `vol-history` slot once the owner's engine lands.
- L3 Constant-maturity IV (7d / 30d), interpolated in total variance between expiries, as a KPI and a term marker.
- L4 ATM IV change vs the previous close (IV of the `close` prices with T + 1 day).
- L5 India VIX tile (percentile, VIX/16 daily move) where the broker lists `NSE:INDIAVIX`. The demo does not list it.
- L6 Positions overlay on the smile, with held strikes marked.
- L7 "Load in Strategy Builder" from an arbitrage hit (same-expiry structures), with net-of-charges edge using the builder's charges model.
- L8 OI bars under the smile (FYERS-style) and IV movers.
- L9 Unify models across pages: server IV via Black-76 on the forward (an optional `ivModel` param), `forwardPrice` with discounting, and `chainSummary.atmIv` via `atmIvAt`.
- L10 A compact "ATM IV · 1σ" link chip on the Option Chain and Strategy Builder pages that opens `#/vol`.
- L11 Trading-day (business-time) variance toggle, and event-vol extraction from weekly kinks.
- L12 Multi-underlying IV dashboard and screener (high or low IV − HV across NIFTY, BANKNIFTY and SENSEX).

## 17. OUT OF SCOPE (this round)
- Any chart library, and any price/time chart. The `vol-history` panel is a labelled empty slot only. The two small SVG curves are purpose-built and allowed.
- IV rank or IV percentile numbers of any kind, including client-side or localStorage estimates.
- Placing orders from this page.
- 3D vol surfaces, SVI or other smile fitting and smoothing.
- Changing server IV maths for the other pages (L9).
- Stock options specifics such as dividends and early exercise. Index options are European; the page works generically for any underlying `/v1/expiries` supports.
- Alerts and notifications on vol levels.

## 18. Suggested split (three agents)
- **Agent A: maths and demo.** Owns `options.js` and its tests, and `demoAdapter.mjs` with `demo.test.mjs`. Delivers MUST 1 and 14. Publishes the exact signatures from §5 first, so B and C can stub against them.
- **Agent B: page.** Owns `vol.js` (loader, KPI strip, term table, strikes table, read and arbitrage panels, settings, keyboard, methodology, slot), the desk.js and views.js wiring, the icon, and the two file lists. Delivers MUST 2–4, 7–13.
- **Agent C: curves and polish.** Owns `vol-curves.js`, the `app.css` section `12v · VOLATILITY`, the responsive rules, and `vol.cjs` with the Playwright verification. Delivers MUST 5, 6 and 15. It agrees with B on one hook: `smileSvg(series, { x, range, compare, highlight, onPick })` / `termSvg(rows, { selected, wings, onPick })`.
