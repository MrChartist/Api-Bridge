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
| P2 | 14 | 8 | 6 |

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
| 11 | Normal mode with no broker: "Reference data unavailable: using dashboard defaults" banner on every Options page. | Proposal: show it once per session, or fold it into the readiness pill. |
| 12 | Demo paper account starts with ₹8.49L of ₹10L in use by seeded positions. | Proposal: seed demo paper accounts with ₹25 lakh, or seed fewer shorts. |
| 13 | `?` on Home after closing Ctrl K once did not open shortcuts in the test run (focus was likely left in the sidebar search). | Proposal: return focus to the page after the palette closes. |
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
