# Reference data

The Bridge ships a few tables of market facts: the holiday calendar, the trading hours, special sessions such as Muhurat trading, freeze quantities, statutory charges and the delivery-margin schedule. They are plain JSON files in `server/bridge/reference/data/`. This page says where each one comes from, how to update it, and what the `verified` flag means.

The tables are a dated snapshot, not a live feed from the exchange. The Bridge never fetches them at run time.

## What the `verified` flag means

A row is `verified: true` only when whoever updated the file **read the figure in the circular itself** (an NSE, BSE or SEBI document) and wrote down which circular, its address and the date it was read.

A row is `verified: false` when the figure rests on anything else: a broker page, a news report, a forum summary, memory. It stays in the file, labelled, and every answer that uses it says so. The flag is honest per row: one unverified row does not make its neighbours unverified.

What an unverified row is allowed to do:

| Where | Unverified row |
|---|---|
| Live orders | It can never make the order window **longer** than the floor in `sessions.json` (`gateFloor`: open 09:15, close 15:30). It can still make the window shorter. A special session with an unverified timing is closed for live orders. |
| Calendar pages, recorder schedule, history, readiness | It is used and shown, with `verified: false` and the note. |
| Charges and freeze quantities | The old numbers stay. A newer figure from a secondary source is written down as `pending` and is **not applied**: money maths does not change without a primary source and a test. |
| An unverified holiday | It warns; it does not block a live order. A verified one blocks. |

Paper orders are never blocked by market hours; they get a warning.

## The files

Every file has an `asOf` date (the oldest date inside it) and a `note` saying what it covers.

| File | What it holds | Where it comes from |
|---|---|---|
| `holidays.json` | NSE and BSE trading holidays by year, with `sources` per year (circulars, address, date read) and `amendments` issued later | NSE trading-holiday circulars. 2026 was read in NSE/CMTR/71775 and NSE/FAOP/71777 (2025-12-12), plus the amendment NSE/CMTR/72260 (2026-01-15 closed). The 2025 rows were not re-read, so they are unverified. |
| `sessions.json` | Session rules by segment and date: pre-open, open, close, `expiringIndexClose`, closing auction times, and `gateFloor` | SEBI circulars of 2026-01-16 (derivatives to 15:40 from 2026-08-03) and 2026-10-15 (to 15:45 from 2026-12-07; an index contract expiring that day stops at 15:30), both read in full. Older hours: no circular read, unverified. |
| `special-sessions.json` | Sessions on days that are normally closed or have their own hours: Budget day, Muhurat trading | The exchange circular for each session. None is verified yet: Muhurat 2026 and Budget Sunday 2026 rest on a press report and a broker bulletin. |
| `freeze-quantities.json` | The largest quantity one index-derivative order may carry | The NSE and BSE freeze-limit circulars. Unverified: only a forum summary of NSE/FAOP/77189 was read; the BSE rows were not read at all. |
| `charges.json` | STT, stamp duty, exchange transaction charges, SEBI fee, GST, with `groups` that each carry their own `asOf` and `verified` | Secondary sources (a broker bulletin and charge page). The NSE transaction charges are the rates before NSE/FA/73061 (March 2026); the newer ones are kept under `pending`. |
| `delivery-margin.json` | Phased delivery margin for physically settled stock derivatives (E-4 to E-1) | Secondary sources agree on 10/25/45/70 percent, one disagrees on E-1; the NSE Clearing circular was not read. |
| `corporate-actions.json` | Empty in this release | Rows come from your own store. |

`server/bridge/dashboard/reference.js` keeps its own copy of the charge rates for the Trades tab. A test checks that it agrees with `charges.json`; change both together.

## One source for session times

The live-order gate (`server/lib/marketHours.mjs` and the safety guard), the calendar routes, readiness, the recorder schedule, history bar counts, expiry rolls and the paper engine's day end all read `sessions.json` and `special-sessions.json` through one shared calendar (`reference/sharedCalendar.mjs`). Change a time in the data file, nowhere else. A test keeps the literals `09:15` and `15:30` out of every other file under `server/bridge`.

Only NSE, BSE, NFO and BFO are in the table. MCX and CDS hours, and their holidays, are not: the calendar refuses them, and the safety guard uses its own labelled window.

## How to update a file

1. Find the circular. For holidays, read the NSE list "Trading Holidays" for the year; for hours, the SEBI and exchange circulars; for freeze quantities and charges, the NSE and BSE circulars.
2. Edit the JSON. Put the quantity or time in, the circular's number and date in `circular`, its address in `source`, and today's date in `readOn`. Set `verified: true` only if you read the circular itself.
3. Move `asOf` to the date of the newest circular you used.
4. Add a test if a number that feeds money maths or the order window changed. The tests in `server/bridge/reference/` show the pattern.
5. Add a line under Unreleased in `CHANGELOG.md`.

**Sessions.** A new rule is a new row with `from` (and the old row's `to` set to the day before). The rows of a segment must follow each other with no gap and no overlap; a test checks it.

**Special sessions.** Add a row as soon as the exchange announces the day. Leave `verified: false` until the timing circular has been read: until then live orders in that session are refused, and the calendar says "timing unverified".

**Holidays.** Exchanges amend the list at short notice (a local election, for example). Before every release, read the exchange's circular list for "Trading Holiday" amendments and add each one to `years` and to `amendments`.

## Checks

`mc-bridge doctor` warns when:

- the holiday calendar has no rows for next year (NSE publishes the list for a year in December, so this warning is normal in November and early December), or
- any file or group has an `asOf` older than six months.

The Safety page of the dashboard shows the same sentences under "Market reference data". The same data is in the `referenceData` part of `GET /v1/readiness`. These are warnings: they never stop an order.

Release gate: in early December, add the next year's holiday list before tagging a release.
