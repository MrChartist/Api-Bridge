# To-do: dashboard (v1, private)

Where things stand on 31 Oct 2026. Everything below is merged into `dashboard/picker-menu` (PR #19 into `master`).

## Blockers
- [ ] **GitHub CI is not running.** Every check on PR #19 fails because GitHub will not start jobs ("recent account
      payments have failed or your spending limit needs to be increased"). Fix in GitHub › Settings › Billing & plans,
      then re-run the checks on PR #19.
- [ ] Review and merge PR #19 once CI is green.

## Known test failures (Windows only; check they pass on CI)
- [ ] `pricing.shared` "365", `undefinedNames` (spawnSync tsc), 0600 file-mode tests, ivModel / openapi CRLF,
      recorder `.gz`, config `/tmp`, init file mode, brokerCapabilitiesSnapshot, `studies/vendor.test` (`.npmignore`
      hash under CRLF checkout).
- [ ] Not on the known list, check on CI: recorder `routes.test` ("read routes need a key"), recorder `plan.test`,
      `recorderService.test` (.gz roll).

## Trading workspaces
- [ ] Buy/Sell in a workspace jumps to the Option Chain page for the ticket; open the ticket over the workspace
      (needs a ticket host outside the Options pages; `openTicketFor` in `one-tap.js`).
- [ ] Custom workspace (pick widgets, arrange, name, start from a template); Shift+6 opens the list for now.
- [ ] Scalper stacked layout needs a little scrolling on short screens (~860 px tall).

## Charts
- [ ] Not built: Gann, Elliott waves, anchored VWAP drawing, arrows, script editor, strike picker inside the chart.
- [ ] Re-test "Alert at this price" after its last validation fix.
- [ ] Check charts at phone widths (360 / 720).
- [ ] Position-tool labels can sit over candles on busy charts.
- [ ] Bridge studies are daily only; intraday charts use the browser studies.

## 1-Tap and shortcuts
- [ ] Options-page toolbar is crowded at 1280 px in demo mode (chain tools run into the Demo/API pills; the 1-Tap
      bolt adds ~46 px). Needs its own fix.
- [ ] The mini chain in the right rail always opens the ticket on Buy.

## Market brief
- [ ] Gamma flip not on the brief's ladder (Home's key levels card has it).
- [ ] Breadth for BANKNIFTY / SENSEX uses all F&O stocks (no list of each index's own stocks).
- [ ] Home strip picks up a change of the key-levels underlying only on the next refresh.

## Right rail
- [ ] No phone / tablet version (hidden under 1024 px).
- [ ] Sector heatmap covers up to 150 most active / moving F&O stocks, not all of them.

## OI and volatility
- [ ] Spurts: trails on the rotation map, pick a leg to open its card.
- [ ] Heatmap: LTP columns, more tags than ATM / MP.
- [ ] Strike PCR: a per-strike change card.
- [ ] GEX session: 5-minute change shows a dash in demo (thinned readings ~8 min apart).

## Data and other
- [ ] Moneycontrol RSS retired; Business Standard feed unverified.
- [ ] Dhan 200-level depth: confirm the URL path.
- [ ] Demo cannot simulate expired sessions or near-limit safety states.
- [ ] Orders page: the Mode column was replaced by a Live pill; decide whether to bring the column back.
- [ ] Licence check for the paid EXE (plan in `docs/licensing-plan.md`).
- [ ] Make api-bridge-v2 public when ready.
