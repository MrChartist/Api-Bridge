# UX audit: every flow, used for real

30 October 2026. Branch `claude/happy-carson-2a6o3y`. I used every page at 1440 × 900 with Playwright, against:

- a demo Bridge (`start --demo`, the way the Windows .exe often starts);
- a normal Bridge with only the paper account, then a Dhan account added from the dashboard;
- an untouched copy of the branch as it was before this pass, for the "before" screenshots.

Severity:

- **P0:** broken, a silent failure or a dead end.
- **P1:** confusing, missing feedback, or too many steps.
- **P2:** polish.

The **Done** column says what changed, and where.

## Counts

| | Found | Fixed | Left (see Proposals) |
|---|---|---|---|
| P0 | 5 | 5 | 0 |
| P1 | 18 | 17 | 1 |
| P2 | 14 | 10 | 4 |

## P0: broken

| # | Page | What happened | Done |
|---|---|---|---|
| 1 | Accounts | In demo mode every "Add a broker" button was hidden (`app.state.demo ? null : …`). Nothing explained why, so the user could not add anything. | **Fixed.** Add always shows. In demo it opens a guide: pick your broker, then see step by step what connecting it takes, including the exact fields it asks for (API key, secret, PIN, TOTP …). **Save for normal mode** writes the same paper-only entry to the config file without loading it. The optional "Start normally next time" removes `"demo": true` from the file. A last sheet says exactly what to do next. Server: `POST /v1/accounts` in demo mode (`accounts/routes.mjs`, `configFile.mjs`, tests in `manageAccounts.test.mjs`). It is refused when the demo dashboard is served to other computers, and paper-only defaults are kept. |
| 2 | API › Keys | Create with an empty name showed a **green success tick** toast ("Give the key a name") and created nothing. | **Fixed.** Problems show on the field: a red ring, a message under it, `aria-invalid`, `aria-describedby` and focus (`flows.js fieldError`). "Used by" now comes first and fills in a name such as "Excel key · 30 Oct". It also sets the least access the tool needs, the expiry and URL use, so Create works first time. |
| 3 | Everywhere | 35 `toast()` calls reported problems with the success tick. Examples: "That file is not JSON", "Couldn't load the chain", a failed revoke, a failed connection test. | **Fixed.** `toast()` gains `warn` and `error` tones (amber or red icon, `role=alert`, shown longer). Every problem toast now uses the right tone. |
| 4 | Orders | An open order could not be modified or cancelled anywhere in the dashboard. | **Fixed.** Open orders get **Modify** (quantity and limit price, with inline errors) and **Cancel** (confirmed first). Both answer with a toast and a redraw. |
| 5 | Every sheet | Enter did nothing in sheet forms. The new handler had first landed in the popover sheet, not in `modal()`. | **Fixed.** Enter in a one-line field presses the sheet's main action. Search pickers use Enter to pick the first match. |

## P1: confusing, missing feedback, too many steps

| # | Page | Finding | Done |
|---|---|---|---|
| 1 | Accounts | Adding an account ended with "Restart the Bridge". | **Investigated, fixed.** The server already hot-adds accounts in normal mode (`AccountManager.addAccount`). Add now goes straight to the login sheet, so add, log in and connect happen in one go (verified with Dhan). The restart sheet is only a fallback and lists the steps. A self-restart was rejected: on Windows the .exe owns its console window, and a respawned detached Bridge would leave a process nobody can close. |
| 2 | Accounts | Capability chips showed API names ("testConnection", "orderBook"). | **Fixed.** Accounts show one summary chip ("Data and orders"), and **+N** lists each capability in words. |
| 3 | Accounts, Home | Session pill read "Missing". | **Fixed.** It now reads "Not logged in", "Logged in", "Expired: log in again" or "Login failed", and paper accounts show "Ready". |
| 4 | Log in sheet | An empty or wrong PIN or TOTP was only caught by the broker. "Nothing to send" appeared as an alert below the form. | **Fixed.** A missing PIN or TOTP, or a TOTP that is not 6 digits, is marked on the field before anything is sent. The button shows it is busy. The broker's refusal names the broker. |
| 5 | API › Keys | After Create, the key appeared as a small box with no next step. | **Fixed.** The new key is shown big, with a **Copy key** button that changes to "Copied" and a clear shown-once warning. Below it, **Paste it into** has ready setups with the key already filled in: Excel and Sheets, Python, Node, Claude (MCP), curl. |
| 6 | API › Keys | You could revoke the key this browser signs in with, without being told. | **Fixed.** That key is tagged "this browser", and revoking it warns that you will be signed out. |
| 7 | API › Keys | The "For" column showed raw values ("ui", "other"). | **Fixed.** It now shows words. |
| 8 | Home | In demo, the checklist said "close the Bridge and start it normally" with a button to Accounts, where nothing could be added. The steps did not match a first run. | **Fixed.** The four steps are now: connect a broker or explore the demo, create a key for Excel or AI, open the chain, place a paper trade. Each ticks itself off: chain opened, a paper order that is not the demo seed, a non-admin tool key. The card becomes "You are all set". |
| 9 | Orders | Raw symbols (`NFO:NIFTY-2026-11-03-27000-CE`), account ids, and a "Rejected" pill with no reason. | **Fixed.** Contracts read "NIFTY 3 Nov 27000 CE", accounts show by name, and a rejected, expired or unknown order shows why under its pill. |
| 10 | Strategy › Place | On paper, an iron condor was "Blocked: Short of margin by ₹3.72L", with no way forward. The demo paper account starts with 85 % of its money in use, and the paper engine gives no hedge offset. | **Fixed (the dead end).** The block says why (each short leg is margined on its own) and links to **Add paper funds**. The margin model itself is in Proposals. |
| 11 | Accounts | There was no way to reset a paper account or give it more money from the dashboard (the API had a route). | **Fixed.** Paper rows get **Reset funds**: it shows what is in use, lets you pick ₹10 lakh to ₹1 crore, and confirms first. |
| 12 | Live events | The summary chips counted option kinds in the Stocks view. | **Fixed.** The chips follow the Stocks or Options view. |
| 13 | Live events | Strength showed 0.00 or −0.01 for VWAP and pivot crosses. | **Fixed.** `strengthText()` shows a % move, a volume multiple, lots, vol points or a circuit band. Level crosses and custom conditions leave the cell empty. A tooltip says what is measured. Tested. |
| 14 | Live events | Company names were cut to 5 or 6 letters beside the ticker. | **Fixed.** Names are now a tooltip only (the side sheet still shows them). |
| 15 | Normal mode, no broker | Market calendar led with a red "Symbol not found … NIFTY is not in any loaded instrument master". | **Fixed.** The message says the contract list comes from a broker you are logged in to, error states link to **Log in on Accounts**, and the calendar shows a caution with that button. |
| 16 | Option Chain ticket | Only "You pay" was shown before sending. | **Fixed.** The ticket now shows **Max loss** ("Unlimited" for a short call), **Breakeven** and, for sells, **Margin ≈** (hedged estimate). `ticketRisk()` is tested. |
| 17 | Option Chain | After a density switch, the extra strike rows appeared only on the next data refresh. | **Fixed.** The window-resize refit had shared a timer with a ResizeObserver, which cancelled it. It now has its own timer and redraws when the density changes. |
| left | Paper engine | Spreads are margined as naked shorts, so the iron condor needs ₹5.23L on paper. | **Proposal** (server margin model, out of scope for a UX pass). |

## P2: polish

| # | Finding | Done |
|---|---|---|
| 1 | Copy buttons gave feedback only by toast. | **Fixed.** `copyButton()` shows "Copied" with a check on the button. A blocked clipboard gives a warning toast instead of a false "Copied". |
| 2 | Live events top bar was a two-line capsule in the compact 34 px bar. | **Fixed.** It is now one line. |
| 3 | Live events: Enter on the feed with nothing chosen did nothing. | **Fixed.** It opens the first event, and the feed's label names its keys. Row click to open the sheet was checked and works. `?debug=1` gates the paint-p95 readout (checked: hidden without it). |
| 4 | Orders table wrapped contract names and stacked the action buttons. | **Fixed.** Contracts stay on one line and actions sit side by side. |
| 5 | Add a broker: Enter in search did nothing, and a preselected broker was off-screen. | **Fixed.** Enter picks the first match, and the preselected broker scrolls into view. |
| 6 | Add a broker: id or name errors from the server showed as a list at the bottom. | **Fixed.** They now show on the field (and the id box opens). |
| 7 | Primary button said "Add". | **Fixed.** It says **Add and log in** (or **Save for normal mode** in demo). |
| 8 | The Key "Last used" column showed "–" for keys never used. | **Fixed.** It shows "Never". |
| 9 | In demo, a saved broker is not listed on Accounts until the next normal start. | Proposal: list saved-for-later accounts under the demo ones. |
| 10 | Stock scanner condition examples are code (`rsi(14) > 60 and close > sma(50)`). | Proposal: a plain label for each, such as "RSI above 60 and above the 50-day average". |
| 11 | Normal mode with no broker: "Reference data unavailable: using dashboard defaults" banner on every Options page. | **Fixed.** Shown once per browser tab; the reference chip keeps its red "Defaults" on later pages. |
| 12 | Demo paper account starts with ₹8.49L of ₹10L in use by seeded positions. | Proposal: seed demo paper accounts with ₹25 lakh, or seed fewer shorts. |
| 13 | `?` on Home after closing Ctrl K once did not open shortcuts in the test run (focus was likely left in the sidebar search). | **Checked.** `?` opens the shortcuts after Ctrl K closes by Escape, a click outside or the sidebar Search button. |
| 14 | The order ticket's risk figures are before charges. | Proposal: add charges, as the Strategy Builder does. |

## Checked and working (no change needed)

- Option Chain: price click opens the ticket. Paper buy fills and toasts. Enter opens the contract sheet. Select mode, Customise, the expiry and underlying pickers, and Shift+B (add to strategy) all work. `?` lists keys.
- Strategy Builder: templates (with Undo), Save, and the Place sheet with hedges first.
- Positions: Exit all sheet, hedge helper, Analyse.
- Safety: kill switch confirm and readiness simulations.
- API: Integrations ("Create a key for this" fills snippets), Test console (send, curl copy), Rate limits, Activity.
- Data recorder, OI Analysis (both tabs), Volatility, Screeners (all four tabs), Ctrl K palette, account popover (theme, density, forget key).

## Proposals: brainstormed improvements not built in this pass

1. **Hedge-aware paper margin** in the paper engine (the hedged estimate the Strategy Builder already computes), so paper spreads need the margin a broker would ask.
2. **One-click structures from the chain:** right-click a strike for "Straddle here", "Strangle ±1σ" or "Iron condor around here", opening the Strategy Builder filled in.
3. **Position alerts:** "tell me when P&L < −₹5000 or spot crosses 26500" from the Positions row ⋯ menu. This needs the alerts module (Phase 1 steps 23 and 24).
4. **Excel workbook download:** a ready `.xlsx` with BridgeKey, a watchlist and formulas filled in, from API › Keys after creating an Excel key.
5. **Copy as Python / curl** from the chain contract sheet, next to the new Excel formula.
6. **Guided first paper trade:** after "Place a paper trade" on Home, highlight the ATM ask, then the ticket's Max loss, then Buy.
7. **Saved-for-later accounts in demo:** list what was saved, and offer "Remove from the config file".
8. **Undo for Cancel order** (re-place the same order within 5 s) and for paper reset (keep the last state for a minute).
9. **Order ticket charges** (brokerage, STT, exchange fees) in Max loss and Breakeven.
10. **Per-key usage sparkline** on API › Keys, showing which tool is calling and how often.
11. **Restart button** once the launcher can relaunch itself safely: for example, the .exe exits with code 75 and its launcher loop starts it again.

## Screenshots

Under `/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/ux/shots/`:

- `pair-*-before|after`: home, accounts, ticket, orders
- `before-*` / `after-*`: key and accounts flows
- `ev*`: Live events
- `ord-*`: orders and reset
- `norm*`: normal mode

## Trading pass (30 October 2026, second half)

Built from the proposals above, then brainstormed page by page.

### Built

| Proposal | What shipped | Where |
|---|---|---|
| 1 Hedge-aware paper margin | One portfolio model for the paper engine, the ticket, the Strategy margin line and the Positions bar: a 16-scenario price and vol scan per underlying (Black-76 at each leg's IV, one day ahead), premium for buys, 2 % / 3.5 % exposure, a calendar charge and expiry-day ELM. Labelled "approximate, not the exchange's SPAN". NIFTY iron condor (200-point wings): ₹87k, was ₹5.33L. Naked short 26150 PE ₹1.63L; with a 25950 PE bought ₹44k. | `dashboard/span-margin.js` (+ test), `paper/paperEngine.mjs`, `POST /v1/paper/accounts/{id}/margin`, `docs/guides/paper-margin.md` |
| 2 Structures from the chain | Right-click a strike (long-press the strike cell on touch, or T): straddle, strangle ±1σ, iron condor, bull call and bear put spreads, butterfly, calendar into the next expiry, long straddle. Each item lists its legs; the Strategy Builder opens filled, with Undo. | `options.js aroundStrikeLegs` (+ test), `desk.js strategyMenu`, `strategy.js` |
| 3 Position alerts | P&L above or below, spot above or below, delta outside a band (lots), expiry within N minutes, a leg at N× its average. All or any, once or every N minutes, edge-fired with a latch that survives a restart. In-app bell and toast; optional notify targets through `option.alert`. Notify only. | `dashboard/alert-core.js` (+ test), `server/bridge/alerts/` (+ test), `alerts.js` |
| 8 Undo | Cancel a paper order: Undo places the unfilled part again through every check. Reset paper funds: Undo within 2 minutes. Live orders are never re-sent from a toast. | `views.js`, `POST /v1/paper/accounts/{id}/reset/undo` |
| 9 Ticket charges | Charges round trip (brokerage, STT, exchange, SEBI, stamp, GST from the reference table), max loss and breakeven after charges, and "With your positions: adds" from the paper engine. | `flows.js riskAfterCharges` (+ test), `desk.js` |
| P2-12 Demo funds | Demo paper accounts start with ₹25 lakh; the seeded book now uses about 10 %. | `paper/config.mjs`, `paperEngine.mjs` |
| Wide screens | Home is a cockpit (indices, P&L today, open positions with delta, expiry and what to watch, live events, today's calendar, API and broker health) on 1 to 5 columns. API › Keys puts Create beside the list from 1700 px. Accounts already filled the width. | `cockpit.js`, `views.js`, `app.css` |

### Proposals by page (not built)

- **Option Chain:** a payoff preview in the build-around menu (hover an item); "Alert on this strike" in the contract sheet (premium or IV level); one-click "hedge this short" (buy the wing 1σ out) from a position row in the chain.
- **Strategy Builder:** what-if sliders shared with Positions (one state for spot, IV and days); a margin breakdown popover (premium, scan, exposure, calendar) from the margin line; "Set alerts for this strategy" that pre-fills the breakevens as spot levels.
- **Positions:** roll to the next expiry for a whole group in one sheet (today per leg); a P&L calendar heatmap from paper history (needs a daily P&L snapshot in the paper store); a trailing "lock in" alert (P&L falls N % from its high).
- **Orders:** Undo after Modify (put back the old price and quantity); "Repeat" for a filled order.
- **Safety:** show which alerts and guards are on beside the kill switch.
- **OI Analysis and Volatility:** an "Explain this" box in plain words (what the PCR, walls and build-up say now; where IV sits against its range and what that means for buyers and sellers), built from the existing verdict functions.
- **Screeners:** "Alert me when this matches" on a screener row (needs the P1-11 chain conditions).
- **Market calendar:** add position alerts' expiry warnings to the calendar day.
- **Accounts:** a "Today" column (P&L and margin used) using the cockpit's reads; saved-for-later demo accounts (proposal 7 above).
- **API:** per-key usage sparkline (proposal 10 above); an alerts webhook example in Integrations.
- **Data recorder:** feed the alert evaluator from recorder snapshots so chain-level alerts need no extra calls.
- **Paper margin:** calibrate the scan ranges against broker basket-margin figures once P1-10's calibration log exists; inter-commodity credit (NIFTY against BANKNIFTY).

## Trader tools (30 October 2026, evening)

Built for an Indian options trader, highest value first. No charting work: charts live elsewhere. Every maths module is
pure and tested; every new route is in `docs/openapi.yaml` with a test; demo mode shows each one with sample data.

### Built

| # | Tool | What shipped | Where |
|---|---|---|---|
| 1 | What-if, shared | One panel (spot ±%, IV ± points, days forward, σ and day chips, Reset) with one state, the desk's `st.whatIf`, used by Positions and the Strategy Builder. It shows P&L and its change, Δ, Γ, Θ, vega and margin at the scenario (span-margin at the moved forward, shifted IVs and the later date). Positions can scope it to one expiry group. | `whatif.js`, `whatif-core.js` (+ test) |
| 2 | Roll | Roll a leg or a whole group (Positions group head and leg menu) to a later expiry: same strikes, same delta, or same distance from the forward. The sheet shows each leg from and to at the touch, net credit or debit, charges, the book's margin before and after, and breakevens that count what the old legs locked in. Review and send opens the basket sheet. | `roll-core.js` (+ test), `positions.js openRoll` |
| 3 | Basket orders | The order sheet now shows the whole basket's margin first (paper engine), splits legs above the freeze quantity into whole-lot slices (also when a preview reports the freeze), sends buys first or as listed (saved), shows each leg's status live, and has Cancel remaining. Live sends keep every gate. | `basket-core.js` (+ test), `strategy-place.js` |
| 4 | Trade journal | Orders › Journal: fills grouped into trades by strategy group; tags, notes, setup; P&L calendar heatmap; stats by strategy, tag, setup or underlying (win rate with n, average win and loss, expectancy, max drawdown); CSV. The paper engine stores daily P&L snapshots (end of day and on demand), kept through a reset. Demo: six weeks of sample history. | `journal-core.js` (+ test), `journal.js`, `server/bridge/journal/`, `GET/POST /v1/paper/accounts/{id}/daily`, `GET /v1/journal`, `PUT /v1/journal/trades/{id}` |
| 5 | Expiry desk | On Positions when a held expiry is today or the next session (else offered folded): countdown to the close, time value left, max pain and walls, gamma by strike, pin risk, legs at risk of assignment, exercise STT or delivery, and Square off expiring legs through the exit plan. | `expiry-core.js` (+ test), `positions.js` |
| 6 | Watchlists | Screeners › Watchlists: named lists with last price, % change, the near future's OI change against the previous day (stocks from the stock scanner's facts), ATM IV, IV rank, HV20, a chain link for every F&O row. One list feeds Live events, one shows on Home. | `watchlist-core.js`, `watchlists.js`, `server/bridge/watchlists/`, `/v1/watchlists*`, `scanner factsFor` |
| 7 | Explain this | A folded box on OI Analysis and Volatility that says, in plain neutral words, what the PCR, walls, max pain, build-up, IV against HV, IV rank, skew and term structure measure now. The IV rank tile and the box read the same source. | `explain-core.js` (+ test, copy rules), `explain.js` |
| 8 | Command bar trading | Ctrl K: "buy 2 nifty 26000 ce" opens the ticket filled in; "sell nifty straddle 3 nov" opens the Strategy Builder with the legs. Nothing is sent from the palette. | `trade-intent.js` (+ test), `palette.js`, `desk.js` |
| 9 | Accounts today, workbook | Accounts › Session and today: P&L, open positions, orders and margin per account. Excel workbook: Setup (cell BridgeKey, no key written in), Watchlist and Positions as live WEBSERVICE formulas; written without a dependency. | `today-core.js`, `xlsx-core.js`, `workbook-core.js` (+ test), `workbook.js` |

### Proposals (not built)

- **Journal:** roll chains (link the trade a roll closes to the one it opens, with cumulative credit); stats by DTE at
  entry, weekday and IV rank at entry (store them on the first fill); a weekly review card on Home.
- **What-if:** a "breakeven move" readout (the spot % that takes the scenario P&L to zero); save named scenarios
  ("gap down 2 %, IV +4") and apply one with a key.
- **Roll:** a credit target ("roll for at least ₹X"), which walks strikes until the net meets it; a roll ladder that
  lists the next three expiries side by side.
- **Basket:** limit at mid ± ticks with a bounded chase per leg; a margin-after-each-leg line (F9) in the sheet before
  sending; save a basket and resend it later.
- **Expiry desk:** the running settlement average from 15:00 (A16) and the payoff at it; an alert "spot within 0.3 % of a
  short strike in the last hour" from the desk.
- **Watchlists:** a mini sparkline of today's move per row from the stream; sort and filter by event count from Live
  events; import a list from a CSV of symbols.
- **Explain this:** the same box on Positions (what the book's Δ, Θ and vega mean for a 1 % move and a day) and on the
  Strategy Builder (what POP and the breakevens assume).
- **Command bar:** "exit nifty 3 nov" (opens the exit plan for that group), "roll nifty 3 nov" (opens the roll sheet),
  "alert nifty below 25800" (prefills an alert).
- **Workbook:** a Journal sheet (closed trades and the stats as formulas) and a Google Sheets variant with IMPORTDATA.
- **Accounts at 1024 px:** with the holder column (demo) the accounts table stacks into cards at 1024 px; a narrower
  broker cell would keep it a table.

## QA pass (30 Oct)

Every flow used end to end like a trader, in demo mode, after 18:00 IST (after the close: several bugs only show
then). A demo Bridge on port 4550 with a private home, deleted for each fresh pass (first run included); Playwright at
1920 dark, 390 light and 820 dark, plus keyboard-only runs. Every page got a DOM text scan for "null", "undefined",
"NaN", "Infinity" and "[object Object]" (text, title, aria-label, placeholder, input values), the em dash and
horizontal scroll. Scripts: `scratchpad/qa/*.cjs` (`sweep.cjs` the page scan, `f2` to `f10` one per flow,
`pairs.cjs` the before / after shots against an untouched copy of the branch on port 4551).

### Tested

| Flow | What was checked |
|---|---|
| First run | Get started (1 of 4 after a CLI key); cockpit P&L = sum of the account rows; legs 10 = books; Home, Accounts › Today and Positions agree per account; margin % and free funds match Positions. |
| Option Chain | Ticket from the ask: pay, max loss, breakeven, charges (1 and 2 lots, by hand); paper buy lands in Orders, Positions (Δ +68 for 2 lots of a 0.51 Δ call) and the Journal; right-click › Iron condor lands in Strategy with Undo; Ctrl K "buy 2 nifty 26300 ce" (Home, Positions, OI) opens a 130-qty ticket; "sell nifty straddle 3 nov" (Accounts, Chain) fills Strategy; contract sheet Excel formula copies the right `=VALUE(WEBSERVICE(…))`. Build-up tags, walls, PCR, volume PCR, straddle and net OI change checked against the rows. |
| Strategy | Templates; what-if spot, IV, days shared with Positions both ways and Reset; hedged margin vs naked ("Hedge saves"); a 40-lot basket slices 27 + 13 under the 1800 freeze and buys go first; a 30-lot one sent (raised limits in a test config); Cancel remaining withdraws the open hedge and marks the rest "Not sent". |
| Positions | What-if; Roll group and the leg menu's roll; alert "spot at or above" fired by the Bridge in about 25 s, bell count, list and toast; Exit, Exit all, Exit group sheets; Expiry desk (time value, max pain, pin risk distances by hand) and Square off. |
| Orders, Journal | Modify (invalid price and a non-lot quantity refused on the field), Cancel, Undo (placed again); Journal tags, setup, notes saved; stats by tag, setup, underlying, strategy; calendar month total; CSV (34 lines, no bad tokens); Snapshot today. |
| Safety | Kill switch blocks the chain ticket, the Ctrl K ticket, the basket, the roll and the exit ticket (buttons disabled, reason shown, no order reached the Bridge); release needs RELEASE. |
| OI, Volatility, Participants | Explain this matches the tiles (PCR, walls, max pain; ATM IV, HV20, IV rank and percentile, 25Δ skew and fly); participants long % and nets by hand. |
| Screeners | Stocks library (3 tabs), builder to Advanced and back (two rules survive), Save every 5 min, Run now, Export CSV, Excel formula and API URL (works with `curl`, `format=csv` too); Watchlists new, add (incl. a bad symbol), remove, rename sheet; Live events rows, side sheet, its Buy. |
| Accounts | Workbook downloads and opens in openpyxl (Setup, Watchlist, Positions, the `BridgeKey` name); its `/xl` formulas answer with an Excel key; Add your broker (Zerodha guide); Reset funds and Undo (positions back). |
| API | Empty name refused on the field; Excel defaults; Copy key; the key works in `/xl/ltp?key=`, then fails after Revoke; Test console; Rate limits; budget popover. |
| Recorder, Calendar | Coverage and gaps; holidays, moved expiries, lots and freeze. |

### Found and fixed

| # | Page | Symptom | Fix |
|---|---|---|---|
| 1 | Option Chain ticket | After 15:20 IST every paper buy from the chain was "Rejected" (Intraday after the square-off), shown with the green tick and no reason. | The ticket starts on Margin (NRML) from 15:20 to midnight (`options.js ticketProduct`, tested); a rejected or cancelled order toasts in the error tone with the Bridge's reason. |
| 2 | Strategy › Place (paper) | After the close a resting limit leg expired the moment it was sent, so an iron condor ended "Placed 3 of 4" (a short call missing); Orders › Modify and Undo could not be used after 15:30. | Demo only: a resting DAY order stays open until the day rolls, as the demo market ticks at any hour (`paperEngine.mjs`, tested). Live and normal paper keep the session-end expiry. |
| 3 | Everywhere (Ctrl K) | Escape on a sheet, then Ctrl K at once: the palette did not open and the typed text went into the closing ticket ("Buy 2263000 lots"). | A closing sheet is inert and the palette closes it at once (`app.js modal`, `palette.js`). |
| 4 | 17 toasts (Scanner, Live events, Calendar, Participants) | Problems used tone "bad", which `toast()` does not know, so they showed the green success tick. | Tone "error"; `polish.test.mjs` fails on any toast with an unknown tone. |
| 5 | Strategy | Two margins for the same legs: Risk & capital ₹87,249 (paper engine) and what-if "Margin ≈ ₹83,311, ₹0 vs now". | The what-if starts from the page's figure and moves it by the model's change (`whatIfFigures marginNow`, tested). |
| 6 | Option Chain → any page | An open order ticket stayed over the next page after a link, Back or a hash change. | Leaving the desk closes it (`desk.js` cleanup). |
| 7 | Toolbar budget popover | Printed "null" between Today and Saved today when no job ran. | Nulls filtered before `replaceChildren` (`budget.js`). |
| 8 | Roll › Review | Closing a long was labelled "short leg"; buying back a short "buy first". | Roll's closing orders carry `closing`; the sheet says "close" (`roll-core.js`, tested). |
| 9 | Stocks scanner | OI chg % showed "1.61%" next to "−0.76%" (no + sign). | Change columns (OI chg %, Gap %, Basis %) are signed. |
| 10 | Journal | "1 fills". | "1 fill". |
| 11 | Home, Accounts, Strategy what-if | "free ₹2413463", "+₹1069.25" beside "margin ₹48,211", "Margin ≈ ₹170174". | Free funds and what-if margin as on Positions (₹24.13L, ₹1.70L); Accounts › Today P&L in whole rupees as on Home. |

Before / after shots (`scratchpad/qa/shots/`): `pair-ticket-after-close-*`, `pair-basket-after-close-*`,
`pair-ctrlk-after-escape-*`, `pair-problem-toast-tone-*`, `pair-strategy-two-margins-*`, `pair-budget-null-*`,
`pair-ticket-over-next-page-*`.

### Left (not fixed here)

Done since in the speed work (round 2):
- **Live events side sheet Buy / Sell**: disabled, with the reason in its title and under the buttons, when no
  connected broker's master lists the symbol (`GET /v1/instruments/{symbol}`); the order takes the instrument's lot and
  the chain ticket's product rule (`options.js ticketProduct`: Intraday until 15:20 IST, then NRML for F&O, delivery
  for cash).
- **Chain LTP sub-figure** reads "+14.7%" / "−38.0%" (`format.js formatSignedPercent`).

Others:
- **Watchlist IV** mixes measures: indices show the 30-day constant-maturity IV (NIFTY 24.3%), stocks the scanner's ATM
  IV, while the chain and Volatility show the front expiry's ATM IV (28.5%). Needs a front-expiry ATM IV from the
  server for indices, or a column label per source. Index rows show no OI change: quotes carry no previous-day OI.
- **Freeze slicing in demo:** slices of 27 lots always exceed the demo per-order limit of 10 lots, so a big basket is
  blocked slice by slice. Safety limits were not loosened; a note in the sheet ("per-order limit 10 lots: lower the
  size or raise the limit") would help.
- **Order ticket:** Enter in the lots field does not place (the main button is the coloured Buy / Sell, not
  `.primary`). Safer as it is; documented here so nobody "fixes" it by accident.
- **Modify** asks for quantity in units while the ticket uses lots; its error shows "The Bridge answered 422" and the
  message twice.
- **Exit sheets** say "Margin effect: shown by your broker" on paper accounts, where the paper model knows it. Square
  off does not mention an exit order already working.
- **Strategy:** "Now −₹149" (marked at mid, after charges) beside the what-if's P&L ₹0 at the neutral scenario; Max loss
  "below 25121 / above 27379" (exercise STT makes the far tails a little worse) reads oddly.
- **Scanner:** saving an edited library scan keeps the library name; scheduled runs wait for market hours even in demo,
  so "new since last run" and Scan hit rows need market hours or Run now twice.
- **Watchlists:** an unknown symbol (FOOBAR) is added silently ("1 not priced"); duplicate list names are allowed.
- **Safety** limits table shows account ids and paise; **Recorder** counts are ungrouped (436400 leg rows).
- **First run:** Home opened within a second of the start shows the demo book half seeded (7 legs, "not family" at
  ₹0); a reload a few seconds later shows all 10. The seed could finish before the dashboard link is printed.
- **Tests:** `screens.test.mjs` "recomputes every tab over about 1000 legs quickly" failed once in a full run under
  load and passes alone; one full run had one failed file and the rerun was clean. Not loosened.
