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

Others (still open; the rest of this list was fixed in the follow-up below):
- **Order ticket:** Enter in the lots field does not place (the main button is the coloured Buy / Sell, not
  `.primary`). Safer as it is; documented here so nobody "fixes" it by accident.
- **Square off** does not mention an exit order already working.
- ~~**Exit sheets** still slice at the freeze only~~: fixed in the safety pass below (#24).
- **Strategy:** "Now −₹149" (marked at mid, after charges) beside the what-if's P&L ₹0 at the neutral scenario; Max loss
  "below 25121 / above 27379" (exercise STT makes the far tails a little worse) reads oddly.
- **Recorder** counts are ungrouped (436400 leg rows).
- **Market calendar** at 1024: a holiday cell that also has "unverified" (Diwali Padwa) has no room for that line (the
  tooltip and the cell's sheet say it); the special session's first word wraps inside the word ("Muhura t").
- ~~**Modify safety (server)**: a paper modify to 20 lots passed the 10-lot / ₹2 lakh limits~~: fixed in the safety
  pass below (#23).
- **Live events search placeholder** cut at 1024 ("Search symbol or ev"): it is `events.js`'s own input, not a shared
  component, so it is left for the speed agent.
- **Tests:** `screens.test.mjs` "recomputes every tab over about 1000 legs quickly" failed once in a full run under
  load and passes alone; one full run had one failed file and the rerun was clean. Not loosened.

### Fixed in the follow-up (30 Oct, evening)

Checked again in demo after 19:00 IST against a fresh Bridge on port 4560 (and an untouched copy of the branch on
4561 for the before shots); Playwright at 1440 dark, 1024 dark and 390 light. Scripts: `scratchpad/qa2/cap.cjs` (one
flow per argument), `home.cjs` (Home the moment the Bridge answers), `sweep.cjs`; shots in `scratchpad/qa2/shots/`
as `before-*` and `after-*`.

| # | Page | Was | Now |
|---|---|---|---|
| 12 | Screeners › Watchlists, Home | IV mixed measures: NIFTY 24.3% (30-day constant maturity) while Chain and Volatility showed 28.5%; stocks the scanner's own ATM IV (RELIANCE 42.4% beside a chain at 37.2%). | One measure for every row: the front expiry's ATM IV, read from that expiry's chain with `chainSummary` exactly as the Option Chain reads it (NIFTY 28.6% beside the chain's 28.58%, RELIANCE 37.4%). Background priority, kept 30 s, at most 8 chains a call. Column "ATM IV (front)", tooltip with the expiry; Home's IV says the same. IV rank and HV20 unchanged (`watchlistService.mjs`, `watchlist-core.js frontExpiry`, tested). |
| 13 | Watchlists | Index rows had no OI change (quotes carry no previous-day OI). | The near future's OI against its OI at the previous recorded close, from the Data recorder's daily rows (same expiry), tooltip "against its OI at the 29 Oct close (Data recorder)"; "–" with the old tooltip when nothing is recorded (asked again after 5 minutes). Demo futures OI does not move between days, so demo shows 0.00% (`prevFutureOi`, tested). |
| 14 | Strategy › Place | A 40-lot basket sliced 27 + 13 under the freeze, and every slice failed the demo per-order limit of 10 lots. | Slices at the smaller of the freeze, the account's `maxLotsPerOrder` and `maxOrderValue` at the leg's price (GET /v1/safety, read when the sheet opens, before the first checks): 10 + 10 + 10 + 10. The sheet says why once: "Sliced to 10 lots per order: your per-order limit (Safety)". No limit is raised (`basket-core.js perOrderCap`, `sliceNotes`; tests in `basket-core.test.mjs`). |
| 15 | Orders › Modify | Asked in units while the ticket asks in lots; a refusal showed "The Bridge answered 422", the reason, and the reason again. | Asks in lots, "195 qty · lot 65 · none filled yet" under the field; whole lots and the filled part are checked on the field (`flows.js modifyChange`, tested); a refusal shows once, under its field when it names one, else one line. `INVALID_ORDER` reads "The order was refused" everywhere, and an alert no longer repeats its own text in the field list. |
| 16 | Positions › Exit, Exit all, Exit group; hedge helper | "Margin effect: shown by your broker" on paper accounts. | Paper: "Margin released ≈ ₹1.72L (NIFTY margin ₹1.72L now, ₹0 after; paper margin model)" from `span-margin.js marginImpact` (the paper engine's model; the Margin tile behind the sheet reads the same ₹1.72L). An exit that lifts a hedge says the margin goes up. Live and broker accounts keep the broker line. |
| 17 | Stocks scanner › Save | An edited library scan was saved under the library's name ("Saved: Gap up"). | The sheet is titled "Save your edited Gap up", offers "Gap up (edited)" and refuses the library's own name on the field (`scan-library.js libraryEdited`, `savedScanName`, tested). |
| 18 | Stocks scanner, schedules | Scheduled scans waited for market hours even in demo. | Demo runs them at any hour (the demo market ticks at any hour), labelled "Every 1 min (demo: any hour)" and "Every (minutes; demo: also after hours)"; normal mode keeps market hours (`scanService.mjs due`, tested). Checked: the 1-minute scan ran at 19:46 IST. |
| 19 | Watchlists | FOOBAR was added silently ("1 not priced"); a second list named Banks was allowed. | Symbols new to a list must be in the instrument master (without a loaded master nothing can be checked and they are kept); the refusal is under the Add field. Names are unique, any case, on the Bridge and in the sheet (tested). |
| 20 | Safety | Limits table showed account ids and paise (₹2,00,000.00). | Account names (id in the tooltip), whole rupees. |
| 21 | Home, first run | Home opened a second after the start showed 1 or 7 legs and "not family ₹0". | `core/startup.mjs`: `listen()` arms a gate before binding; positions, funds, orders, trades and the book wait for the demo seed (bounded 20 s); everything else answers at once. Measured: positions asked 0.5 s after the first health answer came back with the seeded leg (3.2 s; about 10 s since the seed is paced to keep half the data budget free, 6c2137e); Home showed 10 legs once loaded, never a partial book (tested). |
| 22 | Market calendar at 1024 | "Mahatma Gandhi…" cut in the month cell. | Holiday names in the cell use their everyday short form on two lines ("Gandhi Jayanti", "Ambedkar Jayanti", "Guru Nanak", "Diwali Padwa"); the whole cell's tooltip, its sheet and the list keep the full name (`calendar.js holidayShort`, tested). |

Before / after shots (`scratchpad/qa2/shots/`): `*-watchlist-1440-dark`, `*-basket-1440-dark` (40 lots) and
`after-basket14-1440-dark` (15 lots, sendable), `*-modify-error-1440-dark`, `*-exitall-1440-dark`,
`*-scansave-1440-dark`, `*-scansched-list-1440-dark`, `*-wl-unknown-1440-dark`, `*-wl-dupname-1440-dark`,
`*-safety-1440-dark`, `*-home-first-second-1440-dark`, `*-cal-1024-dark`.

### Safety pass (30 Oct, night)

Demo Bridge from the worktree on port 4580; Playwright at 1440 dark and 390 light. Scripts and shots in
`scratchpad/safety2/` (`exit.cjs`, `shots/before-*`, `shots/after-*`).

| # | Page | Was | Now |
|---|---|---|---|
| 23 | Orders › Modify (server) | A modify reached SafetyGuard with no lot size, no value and (paper) no LTP: a 5-lot paper order could be raised to 20 lots, past `maxLotsPerOrder` and `maxOrderValue`. | Every modify, paper and live, is checked like a new order on the order as it would stand after the change (`orderService.mjs modifyShape`): lots from the lot size, value from the new quantity × the new limit (or trigger) price, × LTP for a market order, the price band, the market-order policy, market hours and the kill switch. A change above the freeze quantity is refused (a change cannot be sliced). A paper modify whose value or lots cannot be worked out now says so instead of passing silently. Live modify keeps all its opt-ins. Tests: `modifyLimits.integration.test.mjs` (real SafetyGuard and PaperEngine: above the lot limit, above the value limit, within limits, to MARKET at LTP, above freeze, kill switch), `orderService.live.test.mjs`, `safetyGuard.test.mjs`. `safety.md` says it. |
| 24 | Positions › Exit, Exit all, Exit group, Exit selected, Square off | Exit plans sliced at the freeze only: 40 lots went as 1755 + 845 units and both orders were blocked by the 10-lot and ₹2 lakh limits. The single Exit ticket sent 40 lots as one order (blocked three ways). | `options.js exitPlan` slices with the basket's `perOrderCap` at the smallest of the freeze, `maxLotsPerOrder` and `maxOrderValue` at the order's price (the touch for a market exit); the sheet says why with the basket's own line ("Sliced to 10 lots per order: your per-order limit (Safety)"). The limits come from GET /v1/safety (`basket-core.js orderLimitsOf`, shared with the basket) and are read before the first preview. An Exit (or Exit 25 / 50 / 75 %) on one leg that is larger than one order opens the same sliced plan for that leg instead of a ticket the Bridge would refuse; smaller exits keep the ticket. Slices go at least 220 ms apart and a 429 rate refusal waits and retries the same client order id, so 12 slices are not refused by the 5-a-second cap. Checked: 40 lots exit as 4 × 10, all filled, leg flat. Tests in `options.test.mjs`. |

| 25 | Home, first run | Home opened at start showed "Loading…" for about 8 s (1.5 s to 9.5 s after the start in the before run): it waited for positions, funds and orders, which the Bridge holds until the paced demo seed is done (#21), and for the Home watchlist's quotes (about 2 s at start). | The cockpit draws at once (2.3 s after the start, 0.5 s after the first paint). The P&L and Open positions cards show a skeleton under "Setting up the demo book · 4 of 9 legs", from `startup` in GET /v1/health (`core/startup.mjs startupProgress / startupStatus`, OpenAPI updated), read every half second; when the Bridge answers book reads the cockpit reads the whole book and puts both cards (and Orders today) in place at once, so a partial book is never shown or read. API clients keep the hold, capped at 20 s as before. The watchlist card fills in behind its own skeleton. The seed itself is faster without bursting the quote window: one batched LTP read per account (its legs and their spots) before its legs, so each paper order only reads its depth and is paced at 1 quote read instead of 3 (seed done 3.9 s after listen, was 7.6 to 9.7 s; with Home open at start 5.6 s, was 9 s). `fno/routes` passed 10 runs in a row. Tests: `startup.test.mjs`, `startupHealth.test.mjs`, `demoBook.test.mjs`, `flows.test.mjs startupText`. |

#### Proposal: should exits be exempt from per-order limits? (for the owner to decide; nothing changed)

Today an exit is a new order like any other: every gate applies. That is the safe default, and this pass keeps it.
The sheets now slice exits under the limits, so per-order lots and value no longer stop a close. What can still
stop a user closing risk through the Bridge:

1. **Daily loss.** `dailyMaxLoss` refuses every `place` once the day's loss is past the limit, including a sell that
   closes a long or a buy that covers a short. A user who is losing cannot cut the loss here (the broker app still
   can). This is the strongest case for an exemption.
2. **Daily order count.** Each slice counts. A 40-lot exit under a 10-lot limit is 4 of the 100 orders; a busy day can
   leave no room to close.
3. **Per-order lots and value.** Now handled by slicing, at the cost of more orders (point 2) and more time.
4. **Price band.** A limit exit far from LTP is refused, which is right; a market exit is protected at LTP ± 2%.

Options, from least to most change:

- **A. Keep as is** (this pass). Users close from the broker app when a daily limit blocks them.
- **B. Reduce-only exemption from the daily loss and daily count limits only.** An order is "reduce-only" when the
  Bridge itself (not the client) sees that it only shrinks an existing position in that account and product and does
  not cross zero, read from the paper engine or the broker's positions at check time, the same reading the F&O ban
  rule already uses (`heldQtyOf`). Such an order still meets the kill switch, the rate cap, the price band, market
  hours, the freeze, per-order lots and value (sliced), and live opt-ins; it still counts towards the day's total but
  is not refused by it. Audited as `safety.reduce_only_exempt`.
- **C. B plus per-order lots and value.** A reduce-only order may be one order up to the freeze. Fewer orders, but a
  per-order limit is also a fat-finger guard (a wrong quantity on a position you hold is still a big order), so this
  adds less than it risks now that exits slice.

Recommendation: **B**, behind `safety.reduceOnlyExempt: true` (default off until checked against each broker's live
positions), never C. Not the kill switch: it stays a full stop, and cancels already pass it.


## QA pass 2 (31 Oct)

The whole site after a day of parallel work: redesigns, the PR 17 analytics pages, brand colours, soft buttons, demo
prices, broker features, the Algo page. Demo Bridge from the QA worktree on port 4660, with a fresh home in
`scratchpad/qa2/home` for each round. It ran from Saturday 00:30 IST, a weekend after the close. Playwright went
through every sidebar page and every tab (49 routes once Algo and the new Volatility and OI tabs landed) at 1920 dark,
1440 light, 1280 dark, 768 dark and 390 dark. Each page was checked for:
- console errors and failed requests;
- horizontal scroll and text clipped without an ellipsis;
- overlapping text boxes (glyph rectangles);
- "null", "undefined", "NaN", "Infinity" and the em dash;
- "Loading" still on screen after 2.8 s;
- a near-empty main panel.

Scripts are in `scratchpad/qa2/p2/`:
- `sweep.cjs` is the page scan;
- `flow.cjs <item>` runs one flow each: ticket, orders, ic, exit, pnl, ctrlk, release, wladd, alert, scan, theme,
  switch;
- `o-f6.cjs` is the kill-switch run;
- `cmp.mjs`, `walkcheck.mjs` and `hist.mjs` are the demo price probes.

Shots are in `scratchpad/qa2/p2/shots/`: `r1-*` and `r2-*` before, `r3-*` and `after-*` after.

### Flows (paper)

All worked end to end:
- **Chain ticket:** place; resting limit; Modify to 2 lots; Cancel with Undo.
- **Strategy Builder:** iron condor placed, 4 of 4 filled, hedges first.
- **Positions:** Exit (MARGIN legs close as MARGIN).
- **Watchlists:** add SBIN.
- **Alerts:** a position alert, which shows in the bell.
- **Stocks scan:** runs (4 of 204 match Gap up).
- **Ctrl K:** a trade ("buy 2 nifty 26300 ce" opens a 130-qty ticket) and navigation (positions, volat, risk,
  exposure, orders).
- **Theme:** light from the palette.
- **Accounts:** switching on Positions.
- **Kill switch:** blocks the chain ticket, the Ctrl K ticket, the basket, the roll and the exit, and no order reached
  the Bridge; release needs RELEASE.
- **Price band:** the ticket refuses a limit 20 % from LTP ("the limit is 3 %").

P&L agrees on Home (per account), Positions (all accounts), Accounts › Today, Risk (paper account: legs, margin
16.9 % of ₹25 L, delta ₹2.3 L on BANKNIFTY as on Positions) and `GET /v1/positions` to the rupee, given the tick
between reads.

### Found and fixed

| # | Page | Was | Now |
|---|---|---|---|
| 26 | Watchlists sparklines, history, backtest, HV20 | The demo intraday path was three fixed sines. The 11-minute one, sampled every 5 minutes, drew a sawtooth. They kept running after the close, so the live price (the sparkline's last point) jumped off the last 5-minute bar. The walk also stepped on weekend days: Monday opened 2 to 5 % away from Friday's close, and Saturday's quote moved a full day. | Inside a session the price runs along a seeded Brownian bridge from the previous close to the day's close. Outside it the price holds at the close, with a wiggle of at most 0.04 % that fades in and out, so the demo still ticks. History candles, sparklines, the backtest, HV20, IV rank and live quotes all read this one function. Monday opens on Friday's close. `previousClose` is the close before the latest session, so a Saturday shows Friday's change (`demoAdapter.mjs`; tested in `demo.test.mjs`: after-hours price, Monday open, daily close, Saturday change, no lag-1 sawtooth). |
| 27 | Demo spot across a restart | A Bridge restarted on newer code jumped from about 26200 to 25030 and fired a bracket stop. | Diagnosis: spot is a pure function of time, and a restart on the same code is continuous (24977.10, then 24976.55). The 26200 level came from the price function before the random walk (94952ae). Test: two adapters made at different times agree (`demo.test.mjs`). CHANGELOG: "Demo price path changed. A demo Bridge updated across this version may see a one-off gap, which can fire open demo triggers." |
| 28 | Futures at 768, Risk › Execution costs at 768, Flow › Filings at 1440 | When a table is wider than its panel it scrolls sideways inside its own box, and the desk's sticky offset pushed its head down over the first row. At 768 the futures row could not be read. | Such heads sit at top 0 (`app.css`, `.an-page` scoped). |
| 29 | OI › Strike history | The IV axis read "21.3, 21.2, 21.2, 21.1". | Ticks get as many decimals as their step needs (`analyticsViews.js tickDecimals`, tested). |
| 30 | Volatility › Cone | Expiries were evenly spaced, so 3 days and 14 days drew the same width. ISO dates; no +2σ column. | Points sit at days to expiry, so the cone widens with √time (`seriesLayout` takes `at`, tested). Dates read "3 Nov". The table has +2σ. |
| 31 | Futures | "2026-11-23"; "Days left 23.6". Demo listed one index future, so Roll cost and Calendar spreads stayed empty. | "23 Nov"; "Calendar days 23". Index futures on the next three monthlies. The route adds the instrument master's FUT expiries to an option list that stops at the weeklies (tested). |
| 32 | Flow and every analytics figure | "50.9k / 90" beside "5.77 L". Far strikes with 1 lot of OI traded more than 1000 lots, so every top row read "> 100x". | One suffix style ("50.9 K", "5.77 L", "1.25 Cr"). Demo option volume falls away from the money like OI does. |
| 33 | Volatility › Forward, RR and BF, Event vol | Expiry cells printed "2026-11-03". | "3 Nov", with the ISO date in the tooltip. |
| 34 | Tests: vol/agreement, analytics.integration | Failed in every full run: "Hook timed out" in afterAll. `app.close()` waited for the demo book seed, and a seed step sitting in the market-data queue never returns on the frozen clock these tests inject. | Shutdown waits for the seed at most 3 s (`book/module.mjs SEED_STOP_WAIT_MS`). Test: `book/stop.test.mjs` closes a demo Bridge mid-seed on a frozen clock (it timed out at 30 s before). Full suite: 352 files passed. |
| 35 | Tests: futuresChain | Expiries 10, 40 and 70 days ahead can share a month (1 and 31 January), so the test depended on the run date. | Mid-month in three different months. |

### Left (not fixed here)

- **Flow › Unusual activity (demo):** BANKNIFTY calls 2 to 3 % out of the money still read 20 to 75 times their OI,
  because the demo OI hump is narrower than the volume hump. Better than "> 100x" on every row, but a real monthly
  reads 2 to 5 times.
- **Algo page** (its own agent's area): at 1440 the strategies card takes half the width and the right half stays
  empty until a strategy exists.
- **Event vol:** the event date is the browser's own date field ("11/04/2026" in an en-US browser), and its term chart
  is still evenly spaced by expiry, like the other term-structure charts.
- **Strategy:** Max loss "below 24250 / above 25700" and "Now −₹139" next to a what-if P&L of ₹0 are still open from
  the first QA pass.
- **Tests under heavy machine load** (load average 15 to 30 from parallel agents): `recorder/store.test` "full-day
  read ≤ 300 ms" took 342 to 1297 ms and `hooks/routes` "acknowledges within 50 ms" timed out. Both pass on a quiet
  machine. Not loosened.
