# Speed and broker calls: before and after

How these were measured: [README.md](README.md). Raw results: `before-1.json`, `before-2.json`, `after-1.json`,
`after-2.json` in this folder; the tables below come from `node scripts/perf/table.mjs`.

## Conditions

- One Linux container, 4 vCPU, Node 22.22, headless Chromium 1243 (Playwright 1.63), 1440 x 900, dark theme.
- Demo Bridge with `--latency 200` (every demo broker REST read answers after 200 ms, like a real broker).
- Before: commit `dea4cfe` (the code before this work, with the harness). After: commit `461d217`.
- Interleaved rounds on the same machine: before, after, before, after. 30 s steady window per page, 60 s idle,
  60 s busiest scenario. Each cell is the mean, then the two rounds in brackets.

## Read this first: noise

- The spread between the two rounds of one side is often as large as the change (Chain first data before: 805 and
  2577 ms). Trust figures where both rounds agree; treat the rest as noise.
- "Broker / min" per page includes the Bridge's own background jobs (the recorder works in minute-long rounds), so
  per-page broker figures move by ±10 a minute on their own. The busiest scenario and the idle row are the reliable
  broker figures.
- Headless Chromium paints in software: long-task milliseconds are much higher than in a desktop browser with a GPU.
- A dash means the figure could not be taken: Strategy, OI Analysis and Volatility keep a skeleton bar on screen (a
  chart slot), so the strict "no skeleton" test for first data never passes on them, before or after.
- Orders' first switch is slower after (about 530 ms against 140 to 290) because the Orders page now also reads each
  paper account's positions and funds (the paper-margin work merged in the same period), each priced through the
  broker. Its switch from memory is 38 ms.

## Summary

| | Before | After |
|---|---|---|
| Busiest scenario (Chain + OI + Strategy + Live events on NIFTY), broker calls / min | 32 (33, 30) | 20 (20, 20), **37 % fewer** |
| of which option-chain calls in 60 s | 12 (13, 10) | **0** |
| of which quote calls in 60 s (the Live events engine's own universe) | 20 | 20 |
| Idle Bridge, broker calls / min | 11 (9, 13) | 2 (1, 3) |
| JS loaded on a cold start of Home, Orders, Accounts, API | 2368 KB, 34 files | 502 KB |
| Page switch from memory (Home, Orders, Positions, Chain) | 290, 303, 513, 579 ms | 47, 38, 80, 75 ms |
| Chain tick to cell, p50 / p95 | 845 / 1842 ms | 93 / 246 ms |
| Chain main-thread long tasks in 30 s | 18 / 1522 ms | 40 / 2689 ms (redraws on live ticks) |

Targets: page switch to useful paint from memory ≤ 150 ms: met on every page measured. Tick to cell p95 ≤ 100 ms: p50
is under it, p95 is not (246 ms in headless software paint; the chain redraws on every tick burst, at most every
150 ms). Broker calls on the busiest scenario: 37 % fewer, all option-chain calls gone; what is left is the Live
events engine polling its 200-symbol stock universe, which no page watches.

Server hot paths (`node scripts/perf/bench-server.mjs`, same machine, after): Black-76 IV and Greeks for a 91-strike
chain 0.74 ms (p95 0.96); broker chain to rows with legacy Greeks 1.8 ms; serialising a priced chain 1.0 ms; 100
ticks to 20 stream clients 4.2 ms. These functions did not change; what changed is that each cached chain is priced
once for every reader instead of once per request, and a streamed window costs no broker call. No Web Worker: the
Greeks are well under a frame.

## Per page

| Page | Figure | Before | After |
|---|---|---|---|
| home | First paint, ms | 176 (124, 228) | 138 (148, 128) |
| home | First data, ms | 737 (562, 912) | 533 (558, 507) |
| home | Switch (first), ms | 288 (280, 296) | 77 (89, 65) |
| home | Switch (from cache), ms | 290 (292, 287) | 47 (70, 24) |
| home | JS KB | 2368 (2368, 2368) | 502 (502, 502) |
| home | REST / min | 14 (14, 14) | 14 (14, 14) |
| home | Duplicates | 0 (0, 0) | 0 (0, 0) |
| home | Broker / min (raw) | 12 (12, 12) | 0 (0, 0) |
| home | Long tasks (count / ms) | 1 (0, 1) / 29 (0, 57) | 0 (0, 0) / 0 (0, 0) |
| home | Tick to cell p50 / p95, ms | – | – |
| chain | First paint, ms | 238 (152, 324) | 150 (180, 120) |
| chain | First data, ms | 1691 (805, 2577) | 759 (950, 568) |
| chain | Switch (first), ms | 562 (292, 832) | 322 (406, 237) |
| chain | Switch (from cache), ms | 579 (405, 752) | 75 (1, 148) |
| chain | JS KB | 2368 (2368, 2368) | 2048 (2048, 2048) |
| chain | REST / min | 62 (62, 62) | 62 (62, 62) |
| chain | Duplicates | 0 (0, 0) | 0 (0, 0) |
| chain | Broker / min (raw) | 30 (30, 30) | 22 (24, 20) |
| chain | Long tasks (count / ms) | 18 (8, 28) / 1522 (560, 2484) | 40 (59, 21) / 2689 (4117, 1261) |
| chain | Tick to cell p50 / p95, ms | 845 (512, 1177) / 1842 (803, 2881) | 93 (108, 77) / 246 (256, 236) |
| strategy | First paint, ms | 188 (120, 256) | 160 (196, 124) |
| strategy | First data, ms | – | – |
| strategy | Switch (first), ms | – | – |
| strategy | Switch (from cache), ms | – | – |
| strategy | JS KB | 2368 (2368, 2368) | 2048 (2048, 2048) |
| strategy | REST / min | 62 (62, 62) | 62 (62, 62) |
| strategy | Duplicates | 0 (0, 0) | 0 (0, 0) |
| strategy | Broker / min (raw) | 30 (30, 30) | 25 (20, 30) |
| strategy | Long tasks (count / ms) | 1 (0, 2) / 52 (0, 104) | 0 (0, 0) / 0 (0, 0) |
| strategy | Tick to cell p50 / p95, ms | – | – |
| positions | First paint, ms | 160 (116, 204) | 150 (168, 132) |
| positions | First data, ms | 708 (438, 977) | 764 (833, 695) |
| positions | Switch (first), ms | 194 (386, 1) | 528 (671, 385) |
| positions | Switch (from cache), ms | 513 (523, 502) | 80 (67, 92) |
| positions | JS KB | 2368 (2368, 2368) | 2048 (2048, 2048) |
| positions | REST / min | 66 (66, 66) | 66 (66, 66) |
| positions | Duplicates | 0 (0, 0) | 0 (0, 0) |
| positions | Broker / min (raw) | 30 (30, 30) | 22 (22, 22) |
| positions | Long tasks (count / ms) | 7 (4, 9) / 756 (239, 1273) | 11 (10, 11) / 767 (661, 873) |
| positions | Tick to cell p50 / p95, ms | 134 (73, 194) / 292 (82, 501) | 109 (101, 116) / 314 (295, 333) |
| orders | First paint, ms | 188 (108, 268) | 154 (128, 180) |
| orders | First data, ms | 707 (517, 896) | 802 (759, 844) |
| orders | Switch (first), ms | 144 (287, 1) | 535 (517, 552) |
| orders | Switch (from cache), ms | 303 (291, 315) | 38 (33, 42) |
| orders | JS KB | 2368 (2368, 2368) | 502 (502, 502) |
| orders | REST / min | 2 (2, 2) | 2 (2, 2) |
| orders | Duplicates | 0 (0, 0) | 0 (0, 0) |
| orders | Broker / min (raw) | 10 (20, 0) | 0 (0, 0) |
| orders | Long tasks (count / ms) | 0 (0, 0) / 0 (0, 0) | 0 (0, 0) / 0 (0, 0) |
| orders | Tick to cell p50 / p95, ms | – | – |
| oi | First paint, ms | 186 (124, 248) | 236 (132, 340) |
| oi | First data, ms | – | – |
| oi | Switch (first), ms | – | – |
| oi | Switch (from cache), ms | – | – |
| oi | JS KB | 2368 (2368, 2368) | 2048 (2048, 2048) |
| oi | REST / min | 62 (62, 62) | 62 (62, 62) |
| oi | Duplicates | 0 (0, 0) | 0 (0, 0) |
| oi | Broker / min (raw) | 30 (30, 30) | 20 (20, 20) |
| oi | Long tasks (count / ms) | 22 (4, 39) / 2348 (208, 4488) | 46 (42, 49) / 3726 (3784, 3668) |
| oi | Tick to cell p50 / p95, ms | 108 (61, 155) / 762 (75, 1449) | 284 (272, 296) / 750 (788, 712) |
| vol | First paint, ms | 428 (132, 724) | 168 (156, 180) |
| vol | First data, ms | – | – |
| vol | Switch (first), ms | – | 3 (3, –) |
| vol | Switch (from cache), ms | – | – |
| vol | JS KB | 2368 (2368, 2368) | 2048 (2048, 2048) |
| vol | REST / min | 66 (66, 66) | 66 (66, 66) |
| vol | Duplicates | 0 (0, 0) | 0 (0, 0) |
| vol | Broker / min (raw) | 28 (28, 28) | 24 (24, 24) |
| vol | Long tasks (count / ms) | 49 (0, 97) / 5761 (0, 11521) | 11 (5, 17) / 829 (315, 1343) |
| vol | Tick to cell p50 / p95, ms | 195 (95, 294) / 769 (609, 928) | 145 (147, 143) / 681 (1016, 346) |
| screener | First paint, ms | 370 (128, 612) | 240 (180, 300) |
| screener | First data, ms | 4733 (3572, 5894) | 4460 (3672, 5248) |
| screener | Switch (first), ms | 2614 (2013, 3214) | 2527 (2311, 2742) |
| screener | Switch (from cache), ms | 89 (80, 98) | 44 (87, 1) |
| screener | JS KB | 2368 (2368, 2368) | 2272 (2272, 2272) |
| screener | REST / min | 6 (6, 6) | 6 (6, 6) |
| screener | Duplicates | 0 (0, 0) | 0 (0, 0) |
| screener | Broker / min (raw) | 4 (4, 4) | 4 (4, 4) |
| screener | Long tasks (count / ms) | 2 (2, 2) / 200 (251, 149) | 6 (3, 8) / 403 (206, 599) |
| screener | Tick to cell p50 / p95, ms | 82 (83, 81) / 82 (83, 81) | 138 (116, 160) / 139 (116, 162) |
| events | First paint, ms | 114 (112, 116) | 306 (112, 500) |
| events | First data, ms | 470 (397, 543) | 707 (432, 981) |
| events | Switch (first), ms | 142 (147, 136) | 58 (114, 2) |
| events | Switch (from cache), ms | 48 (4, 92) | 55 (36, 74) |
| events | JS KB | 2368 (2368, 2368) | 953 (953, 953) |
| events | REST / min | 2 (2, 2) | 2 (2, 2) |
| events | Duplicates | 0 (0, 0) | 0 (0, 0) |
| events | Broker / min (raw) | 0 (0, 0) | 0 (0, 0) |
| events | Long tasks (count / ms) | 0 (0, 0) / 0 (0, 0) | 1 (0, 1) / 34 (0, 68) |
| events | Tick to cell p50 / p95, ms | – | – |
| accounts | First paint, ms | 124 (116, 132) | 212 (128, 296) |
| accounts | First data, ms | 328 (298, 357) | 430 (284, 576) |
| accounts | Switch (first), ms | 62 (64, 60) | 77 (52, 102) |
| accounts | Switch (from cache), ms | 38 (40, 36) | 26 (24, 28) |
| accounts | JS KB | 2368 (2368, 2368) | 502 (502, 502) |
| accounts | REST / min | 2 (2, 2) | 2 (2, 2) |
| accounts | Duplicates | 0 (0, 0) | 0 (0, 0) |
| accounts | Broker / min (raw) | 9 (18, 0) | 0 (0, 0) |
| accounts | Long tasks (count / ms) | 0 (0, 0) / 0 (0, 0) | 0 (0, 0) / 0 (0, 0) |
| accounts | Tick to cell p50 / p95, ms | – | – |
| api | First paint, ms | 186 (248, 124) | 134 (132, 136) |
| api | First data, ms | 498 (743, 252) | 279 (269, 288) |
| api | Switch (first), ms | 43 (57, 29) | 36 (28, 44) |
| api | Switch (from cache), ms | 26 (31, 20) | 2 (1, 2) |
| api | JS KB | 2368 (2368, 2368) | 502 (502, 502) |
| api | REST / min | 2 (2, 2) | 2 (2, 2) |
| api | Duplicates | 0 (0, 0) | 0 (0, 0) |
| api | Broker / min (raw) | 14 (6, 22) | 0 (0, 0) |
| api | Long tasks (count / ms) | 0 (0, 0) / 0 (0, 0) | 0 (0, 0) / 0 (0, 0) |
| api | Tick to cell p50 / p95, ms | – | – |
| limits | First paint, ms | 138 (152, 124) | 160 (108, 212) |
| limits | First data, ms | 470 (601, 338) | 298 (232, 364) |
| limits | Switch (first), ms | 45 (58, 31) | 55 (56, 54) |
| limits | Switch (from cache), ms | 38 (57, 18) | 64 (94, 34) |
| limits | JS KB | 2368 (2368, 2368) | 502 (502, 502) |
| limits | REST / min | 50 (50, 50) | 42 (42, 42) |
| limits | Duplicates | 0 (0, 0) | 0 (0, 0) |
| limits | Broker / min (raw) | 2 (0, 4) | 0 (0, 0) |
| limits | Long tasks (count / ms) | 0 (0, 0) / 0 (0, 0) | 1 (0, 1) / 48 (0, 95) |
| limits | Tick to cell p50 / p95, ms | – | – |

| Scenario | Before | After |
|---|---|---|
| Idle Bridge (no page), broker calls / min | 11 (9, 13) | 2 (1, 3) |
| Busiest (Chain + OI + Strategy + Live events), broker calls / min, raw | 32 (33, 30) | 20 (20, 20) |
| Busiest: chain calls in the window | 12 (13, 10) | 0 (0, 0) |
| Busiest: quote calls in the window | 20 (20, 20) | 20 (20, 20) |

Busiest scenario: 37 % fewer broker calls (raw, background jobs included).

# After round 2

Raw results: `round2-before-1.json`, `round2-before-2.json`, `round2-after-1.json`, `round2-after-2.json` (Chain, Strategy,
OI Analysis, Live events, busiest scenario) and `round2-before-3-chain.json`, `round2-after-3-chain.json` (a third
Chain-only pair). Same machine and settings as above (4 vCPU, Node 22.22, headless Chromium, `--latency 200`, 30 s
steady window, 60 s busiest, 30 s idle), rounds interleaved: after, before, after, before, then after, before.
Before: commit `614fa1b` (the branch when round 2 started). After: commit `6c2137e`.

## Summary

| | Before | After |
|---|---|---|
| Chain tick to cell, p95 (three rounds) | 259 ms (319, 225, 234) | 104 ms (135, 92, 86) |
| Chain tick to cell, p50 | 92 ms (124, 77, 74) | 56 ms (71, 52, 46) |
| Chain long tasks in 30 s, count / ms | 43 (75, 26, 27) / 3173 ms | 6 (13, 2, 3) / 377 ms |
| Busiest scenario (Chain + OI + Strategy + Live events), broker calls / min | 28 (35, 20) | 5 (9, 0) |
| of which quote calls in 60 s | 20 (20, 20) | 0 (0, 0) |
| of which chain calls in 60 s (the recorder's background REST chains) | 8 (15, 0) | 5 (9, 0) |
| Chain page alone, broker calls / min | 20 (20, 20) | 9 (16, 2) |
| Strategy page alone, broker calls / min | 20 (20, 20) | 0 (0, 0) |
| Live events page, broker calls / min | 0 | 0 (the 18 in one round are recorder chains, see below) |

## Read this first: noise and what the numbers are

- **Tick to cell p95 ≤ 100 ms**: met in two of the three after rounds (92, 86) and missed in one (135, the round with
  13 long tasks). The mean of the three is 104 ms, the median 92 ms. Single runs on a quiet Bridge during the work
  gave 76 to 102 ms. Every before round was 225 ms or more. Treat "about 100 ms in headless software paint, under
  half of before" as the honest result; a desktop browser with a GPU paints faster.
- **Long tasks**: the per-tick full redraw is gone (ticks now patch cells); what is left is mostly the 3 s REST
  refresh, which still redraws chain-wide figures (totals, PCR, bar scales, tags) in one task.
- **The 20 quote calls a minute were not the Live events engine.** In demo the events engine runs on its own
  simulator and makes no broker call. They were the paper positions the Chain, OI and Strategy pages poll every 3 s
  (`/v1/positions`), each marked to market by a broker read for legs no page streamed. A polled positions read now has
  its open positions watched on the live connection, and those calls are gone (busiest: 20 to 0).
- **Per-page broker figures include background jobs**: the recorder's REST chains (demo plan: 14 index chains) land
  in whichever window they fall in (chain 7 on one after Chain round, chain 9 on the events after-2 round). The
  busiest and idle rows are the better broker figures.
- **Idle is higher after (19 against 14 a minute)**: the demo book seed now paces its nine paper orders through the
  background gate, so its reads (quote and depth) fall in the harness's idle window (which starts 3 s after boot)
  instead of a burst in the first second. Same calls, spread out; it is the fix for the flaky
  `fno/routes.test.mjs`.
- Strategy and OI first data and switch times stay "–" for the reason given above (a skeleton bar slot never leaves).

## Per page (rounds 1 and 2)

| Page | Figure | Before | After |
|---|---|---|---|
| chain | First data, ms | 906 (1122, 689) | 740 (873, 606) |
| chain | Switch (first), ms | 236 (4, 467) | 145 (1, 289) |
| chain | Switch (from cache), ms | 191 (185, 196) | 186 (168, 203) |
| chain | Broker / min (raw) | 20 (20, 20) | 9 (16, 2) |
| chain | Long tasks (count / ms) | 51 (75, 26) / 3915 (6151, 1679) | 8 (13, 2) / 477 (815, 139) |
| chain | Tick to cell p50 / p95, ms | 101 (124, 77) / 272 (319, 225) | 62 (71, 52) / 114 (135, 92) |
| strategy | Broker / min (raw) | 20 (20, 20) | 0 (0, 0) |
| strategy | Long tasks (count / ms) | 0 (0, 0) / 0 (0, 0) | 1 (1, 0) / 26 (52, 0) |
| oi | Broker / min (raw) | 27 (20, 34) | 4 (0, 8) |
| oi | Long tasks (count / ms) | 5 (7, 3) / 383 (600, 166) | 0 (0, 0) / 0 (0, 0) |
| oi | Tick to cell p50 / p95, ms | 67 (67, 67) / 317 (85, 549) | 50 (48, 52) / 304 (537, 70) |
| events | First data, ms | 348 (346, 350) | 326 (329, 323) |
| events | Switch (from cache), ms | 37 (33, 41) | 37 (39, 34) |
| events | Broker / min (raw) | 0 (0, 0) | 9 (0, 18) |
| Idle Bridge (no page), broker calls / min | | 14 (22, 6) | 19 (18, 20) |
| Busiest, broker calls / min, raw | | 28 (35, 20) | 5 (9, 0) |

OI tick to cell is unchanged in substance (it redraws every strike at most twice a second; one round each side had a
500+ ms outlier).

## What changed in round 2

- **Chain per-cell live path** (`desk.js` `patchLive` / `patchLegs`, `live.js` per-watcher gap): ticks are delivered to
  the chain every frame and patch only the cells of the legs that ticked; IV and Greeks of a ticked leg are repriced
  on the chain's own Black-76 pricing block (`options.js repriceLeg`, checked against the server's figures in
  `market/ivModel.test.mjs`); the parity cells of that strike are redone. Full redraw only on a structural change.
- **The biggest single cost was CSS**: `:has()` rules whose subject was `.content` or `.app-main` turned every DOM
  change in the page into a style recalculation of ~2000 nodes (40 to 90 ms a tick). They now key off
  `:root[data-page]`.
- `morph()` writes only what differs, without allocating; bar lengths snap on live ticks; Greek column signatures are
  their displayed text, so a refresh with the same rounded figure writes nothing.
- **Quiet strikes** (`market.quietLegMaxAgeMs`, 60 s): a stream-first chain no longer falls back to the broker because
  an illiquid far leg has not traded, while its feed is live; labelled with `tickAgeMs` and `freshness.quiet`.
- **Live events**: on real brokers, REST only for symbols the hub refused, never ticked, or whose feed went silent
  (`events.quietMaxMs`); the page uses the tab's one live connection. `events/feedCalls.test.mjs` counts the calls.
- **Polled positions stream**, **next-expiry prefetch**, **start-up seed paced through the background gate**: see
  README §2 and §3.

# After round 3

Raw results: `round3-before-1.json` … `round3-before-4.json` and `round3-after-1.json` … `round3-after-4.json` (Chain,
OI Analysis, busiest scenario; rounds 1 and 2 also Strategy and Live events). Same machine and settings as above
(4 vCPU, Node 22.22, headless Chromium, `--latency 200`, 30 s steady window, 60 s busiest, 30 s idle). Rounds
interleaved: after, before, after, before, twice. Before: commit `8d7ea71` (the branch when round 3 started). After:
`7d5ae9a` for rounds 1 and 2, `b9d355a` for rounds 3 and 4 (the same plus OI taking ticks every 50 ms instead of
150 ms). Another agent ran its test suites on the same machine during part of these runs: read the spread.

## Summary

| | Before | After |
|---|---|---|
| Main thread busy, Option Chain (ms per second, two rounds) | 255 (263, 247) | 147 (154, 139), **42 % less** |
| Main thread busy, OI Analysis | 276 (243, 308) | 132 (127, 137), **52 % less** |
| Main thread busy, a still page (Accounts) | 58 (56, 60) | 6 (5, 6), **90 % less** |
| Chain long tasks in 30 s, count (four rounds) | 3 (6, 4, 1, 1) | 2 (2, 0, 3, 1) |
| Chain tick to cell p50 / p95, ms | 51 / 82 (84, 82, 88, 73) | 47 / 101 (103, 71, 138, 91) |
| OI tick to cell p95, ms | 559 (548, 589, 551, 549) | 239 (215, 263) with the 150 ms gap; 102 (111, 92) with 50 ms |
| OI tick to cell p50, ms | 70 (58, 105, 60, 55) | 58 (66, 82, 45, 39) |
| OI long tasks in 30 s | 6 (1, 23, 0, 1) | 4 (2, 13, 0, 2) |
| Busiest scenario, broker calls / min | 5 (7, 0, 0, 14) | 4 (0, 14, 0, 0): unchanged, the recorder's chains |

"Main thread busy" is Chromium's own `TaskDuration` (CDP `Performance.getMetrics`) over 30 s of the steady page,
divided by the seconds, from a separate interleaved pair of runs (after, before, after, before; each a fresh demo
Bridge). It counts style, layout and paint as well as script, so it shows what the long-task and tick-to-cell figures
hide on a fast machine.

## Read this first: what the numbers say, and what they do not

- **The cost was paint.** A trace of the chain before this round spent about 290 ms of every second painting: the
  signed-in dot's endless Motion animation (a JS `scale` loop) repainted the whole page layer on every frame, and the
  chain's LTP flash (an animated background-color) repainted the whole table on every frame of every flash. Both now
  run on the compositor (opacity and transform of an overlay); the same trace paints about 15 ms a second. That is
  the 42 to 90 % less main-thread time above, and it is why a still page is now nearly free.
- **Chain tick to cell did not improve in this session, and missed 100 ms in two of four after rounds.** The before
  side was already at or under 100 ms in all four rounds today (82 mean; round 2's before was 225 ms and more on a
  busier machine). With about 40 ticks a round, p95 is the second-slowest tick, so two slow ticks decide it: after-3
  had 113 and 138 ms next to a 750 ms one-off. One-off ticks of 650 to 930 ms appear on both sides (before-b 647,
  after-a 932 in the 60 s tick-to-cell probes), so they are not new; their cause is not found yet.
- **Chain long tasks**: at most 2 in 30 s in three of four after rounds (3 in after-3), against 6 and 4 in two before
  rounds. The 3 s refresh no longer redraws every row in one task: it patches the rows nearest the focus (or spot)
  and the rest a few milliseconds a frame.
- **OI Analysis**: the 500+ ms outliers are gone: p95 559 to 239 ms, and to 102 ms (111, 92) once the page took ticks
  every 50 ms. The rest of the gap was the live connection's 150 ms delivery gap: a tick that arrived just after a
  delivery waited for the next one. The one round with 13 and 23 long tasks (after-2, before-2) ran while the other
  agent's tests did.
- **Live events REST on strict brokers** cannot be measured in demo (the demo events engine reads no broker). The
  call-count tests on Dhan's policy (market quote 1 a second) are the figure: before, the fallback made no call at all
  in three minutes (the share never fits a 1-call window); now one batched call at most every 10 s while nobody uses
  the broker (6 broker calls for the five refused stocks in three minutes, the cache answering the other rounds),
  never two within 10 s, and none while a person reads quotes every 5 s.
- Idle broker calls (24 against 30 a minute) are the recorder's minute rounds and the demo seed landing in the window
  or not; they did not change.

## Per page (four rounds)

| Page | Figure | Before | After |
|---|---|---|---|
| chain | First data, ms | 682 (891, 633, 570, 634) | 648 (866, 558, 601, 567) |
| chain | Switch (from cache), ms | 175 (207, 200, 168, 125) | 133 (183, 185, 163, 1) |
| chain | Broker / min (raw) | 3 (4, 2, 2, 2) | 2 (2, 2, 2, 2) |
| chain | Long tasks (count / ms) | 3 (6, 4, 1, 1) / 183 (361, 235, 73, 64) | 2 (2, 0, 3, 1) / 96 (101, 0, 200, 83) |
| chain | Tick to cell p50 / p95, ms | 51 (54, 50, 49, 49) / 82 (84, 82, 88, 73) | 47 (52, 42, 49, 46) / 101 (103, 71, 138, 91) |
| oi | Broker / min (raw) | 3 (0, 10, 0, 0) | 1 (0, 0, 0, 2) |
| oi | Long tasks (count / ms) | 6 (1, 23, 0, 1) / 395 (57, 1461, 0, 63) | 4 (2, 13, 0, 2) / 403 (131, 1273, 0, 207) |
| oi | Tick to cell p50 / p95, ms | 70 (58, 105, 60, 55) / 559 (548, 589, 551, 549) | 58 (66, 82, 45, 39) / 170 (215, 263, 111, 92) |
| Idle Bridge (no page), broker calls / min | | 24 (18, 18, 40, 20) | 30 (18, 42, 40, 20) |
| Busiest, broker calls / min, raw | | 5 (7, 0, 0, 14) | 4 (0, 14, 0, 0) |

## What changed in round 3

- **Compositor-only animations**: the breathing dot (`motion.js pulse`, `.dv-breathe`: CSS opacity and transform on
  its own layer, paused on `:root.tab-hidden`, none under reduced motion), the live dot's ring, the chain's LTP flash
  and the OI ladder's change flash (an overlay's opacity), the top-line ink (holds, then settles in one step).
- **Chain work split across frames** (`desk.js` `runRows` / `drainRows`): ticks and the refresh patch the rows nearest
  the focus first, about 5 ms of script a frame; the totals row is its own step.
- **OI Analysis live path** (`oi.js draw({ live })`): ladder and tiles on every delivery (every 50 ms at most), panels
  every 2 s in their own task; out-of-band rows format nothing; tooltips are formatted on hover; bars snap on ticks.
- **Table labelling once a frame** (`views.js`), not on every cell change.
- **Guaranteed share for the Live events REST fallback** (`events.restEverySeconds`, `backgroundGate.floorDecision`),
  shown in the budget popover as the job "Live events by REST".
- Harness: tick to cell also records `max` and the samples.

## Not done

- The rare 650 to 930 ms tick-to-cell one-offs on the chain (both sides): not traced to a cause.
- Chain p95 at or under 100 ms in every round: met in two of four after rounds.
- OI's panels (walls, movers, expiries table) still rebuild their DOM when their figures change (at most every 2 s on
  ticks, in their own task); they are not patched per row like the ladder.

# Round 4 (30 October, after the new pages)

Raw results in this folder:
- `round4-all-pages-1.json`: every page, the new ones included, on the branch as it stood.
- `round4-ab1-{before,after}-{1,2}.json`: Home, Chain, Strategy, OI, Orders, Screener and Watchlists, rounds interleaved.
- `round4-ab2-*.json`: Chain and OI, interleaved, on a quiet machine.
- `round4-soak-after-1.json`: a 10-minute heap soak.

How they were run:
- Before: `8f404f8` (the branch when the round started). After: this round's commits.
- Same harness on both sides, 20 s steady windows, `--latency 200`, port 4670.
- The harness now also records the new pages:
  - paint / layout / style ms per second, from a 6 s Chromium trace of the renderer main thread;
  - main-thread and script ms per second (CDP `Performance.getMetrics`);
  - JS heap after a forced GC at the start and end of the window;
  - `--soak N`: heap over N minutes, one browser per page plus a tab that switches page every 4 s.

## Read this first

- `ab1` ran while other agents' test suites kept the load average at 10 to 19 on 4 vCPU. Paint, long-task and
  tick-to-cell figures moved by 2× between rounds of the same side there. Only the request, broker and first-data
  figures are reliable in `ab1`. `ab2` ran right after a reboot (load 3 to 7) and is the one to read for Chain and OI.
- On a quiet machine the Chain is where round 3 left it: 0 to 11 long tasks in 20 s, tick to cell p95 98 to 178 ms.
  The 40 to 70 long tasks and 400 to 600 main-thread ms/s of the first all-pages run were machine load, not a regression.

## Summary

| | Before | After |
|---|---|---|
| Option Screener (15 underlyings, 32 chains), first data | 17.6 s (18.4, 16.9) | **2.1 s** (2.6, 1.5) |
| Option Screener, switch from Home | 12.2 s (12.9, 11.6) | 0.4 s (0.01, 0.8) |
| Watchlists, broker calls / min | 12 (12, 12) | **0** (0, 0) |
| Watchlists, tick to cell p95 | no ticks (5 s poll) | 65 ms (54, 75) |
| Home, broker calls / min | 18 (18, 18) | 3 (6, 0) |
| Orders (Triggers card), REST / min | 39 (38, 39) | **9** (9, 9) |
| Every page, bell REST / min | 12 (inbox + 2 rule lists every 15 s) | 5 (inbox every 15 s, lists every 60 s) |
| Route switching, JS heap per cycle of 18 pages (`leak.mjs`-style walk) | +5.8 MB (13.0, 18.9, 24.7 MB) | **+1.1 MB** (11.1, 12.2, 13.3 MB) |
| Detached DOM nodes after 3 cycles | 22,761 | 3,975 |

## Heap over 10 minutes (soak, after, while the machine was loaded)

| Page held open | Heap at 1 min | At 10 min | Growth |
|---|---|---|---|
| Chain | 4.3 MB | 4.9 MB | +0.6 MB |
| OI Analysis | 5.0 MB | 5.9 MB | +0.9 MB |
| Strategy | 4.4 MB | 5.2 MB | +0.8 MB |
| Positions | 4.8 MB | 5.1 MB | +0.3 MB |
| Orders, Watchlists, Exposure, Flow | 1.8 to 2.7 MB | same | −0.1 to +0.02 MB |
| A tab switching page every 4 s (149 switches) | 12.4 MB | 49.1 MB | **+36.7 MB**: the leak fixed below |

The pages held open level off (the growth is caches filling: chain history, the OI timeline). Changing page leaked.
Every desk page (Chain, OI, Strategy, Positions, Volatility, Arbitrage), the screener and the calendar stayed alive
after you left. The cause was the reference chip's ResizeObserver: it watches the shared toolbar slot `#toolbar-ctx`,
which outlives every page, and was never disconnected.

## Chain and OI on a quiet machine (`ab2`)

| Page | Figure | Before | After |
|---|---|---|---|
| chain | Main thread, ms / s | 207 (167, 247) | 268 (237, 298) |
| chain | Paint, ms / s | 92 (62, 122) | 81 (91, 70) |
| chain | Long tasks in 20 s | 6 (0, 11) | 7 (2, 11) |
| chain | Tick to cell p50 / p95, ms | 61 / 138 (52 / 98, 69 / 178) | 63 / 137 (53 / 127, 72 / 147) |
| oi | Main thread, ms / s | 173 (129, 216) | 126 (130, 121) |
| oi | Long tasks in 20 s | 4 (1, 6) | 0 (0, 0) |
| oi | Tick to cell p95, ms | 94 (46, 141) | 88 (86, 89) |

No change outside the spread. The toolbar's backdrop blur is gone (see below), but these runs cannot show its effect.
A same-page CSS A/B (`exp.mjs`: the blur put back with an injected stylesheet, three interleaved pairs of 2 × 4 s
traces) gave about 350 against 230 main-thread ms/s and 66 against 28 paint ms/s, blur against no blur, with a wide
spread.

## What changed in round 4

- **Watchlists and Home's list card stream.** The list's symbols and near futures are watched on `live.js`, so the
  Bridge answers the 5 s poll from ticks. Last and Chg % change in place on each tick. The table and its sparklines are
  rebuilt only when a figure changed.
- **Watchlist quotes on the Bridge** read the expiries and the vol summaries of every symbol together, not one after
  another.
- **Option Screener.** The first underlying's nearest chain is read as soon as its expiries are known, and HV20 after
  the chains (it only feeds the IV-against-HV figure).
- **Orders › Triggers.** Reads every 2 s while a trigger is open, every 10 s otherwise, and never while the tab is
  hidden.
- **The bell.** The inbox every 15 s. The rule lists every fourth poll, after any change, and after a new fire.
- **No measure loop per tick.** The desk's toolbar capsule refits when its room changes, not when its own figures
  resize it. The market chip and the IST clock write the DOM only when their text changes.
- **No backdrop blur in the toolbar or on the scroll-edge veil.** The toolbar capsules use the near-opaque
  `--mat-thick` surface, and the veil is a plain gradient (owner's decision: soft, not glossy).
- **Leaks on route change:**
  - the reference chip disconnects its observer when the page goes (desk, screener, calendar);
  - a desk page left while still loading is tidied up once its load ends, and cleanup runs at most once;
  - the desk's document-wide key handler lets go of the page;
  - OI's window scroll listener and Live events' key listener are removed when you leave the page.

# Round 5 (31 Oct)

After the late broker features: the Triggers card, Statement, Funds, depth polling while the panel is open, AMO,
Cancel all's dry run on Orders, the Algo page with its log stream, and the Volatility depth tabs.

Raw results in this folder:
- `round5-before-{1,2}.json`: every page at `eb80003` (round 4's end).
- `round5-after-{1,2}.json`: every page at `e073ad4` (the branch when this round started).
- `round5-fix-1.json`: every page with this round's fixes.
- `round5-firstdata-{before,fix}-{1,2,3}.json`: Chain, Orders and Futures cold loads only, three interleaved pairs.
- `round5-probe-*.json`: `probes.mjs` (Cancel all's dry run, the depth panel, Algo with two paper strategies running).
  `head` is `e073ad4`, `fix` is this round's fixes.
- `round5-soak-{head,fix}.json`: a 5-minute heap soak with a tab cycling every page, Algo included.

How they were run:
- 4 vCPU, Node 22, headless Chromium, `--latency 200`, 20 s steady windows, 30 s idle, 60 s busiest, port 4730.
- Before and after interleaved: before-1, after-1, before-2, after-2, then fix-1. Load average 0.4 to 3 through the
  page rounds; 4 to 10 during the soaks, while another agent's suite ran.
- The same harness on both sides. It now also records Algo and the three Volatility depth tabs.
- Those tabs do not exist at `eb80003`. There the route falls back to Volatility › Overview, so their "before"
  columns are left out.

## Summary

| | Round 4 end (`eb80003`) | Before fixes (`e073ad4`) | After fixes |
|---|---|---|---|
| Orders: Cancel all dry runs per page visit | 0 (no Cancel all count) | **2** (2, 2) | 1 (1, 1) |
| Orders: dry runs for 3 Reload clicks, 1.5 s apart | 0 | 3 (3, 3) | 2 (2, 2): one within 3 s reuses the count |
| Orders: dry runs per minute while the page sits still | 0 | 0 (0, 0) | 0 (0, 0) |
| Orders: REST / min, still | 9 (9, 9) | 9 (9, 9) | 9 |
| Home, switch back from Orders (from cache), ms | 40 (1, 79) | **270** (272, 268) | 72 |
| Orders, switch from cache, ms | 26 (26, 26) | 48 (47, 48) | 25 |
| Ticket depth, `/v1/depth` per minute: ticket shut / panel shut / panel open / shut again / ticket closed | no panel | 0 / 0 / 30 / 0 / 0 | 0 / 0 / 30 / 0 / 0 |
| Algo, two paper strategies running: REST / min (log, list, detail) | 117 (60, 27, 27) | 117 (60, 27, 27) | 117 (60, 27, 27) |
| Algo: after six quick clicks between strategies, REST / min | 129 | 129 (129, 129) | 129 (129, 129) |
| Algo: duplicated log lines shown | 0 | 0 | 0 |
| Algo, nothing selected (the harness's demo), REST / min | 33 (33, 33) | 33 (33, 33) | 33 |
| Chain, cold first data, ms (three interleaved pairs) | 523 (547, 529, 493) | – | 751 (761, 766, 725): see "Not done" |
| Futures, cold first data, ms (three pairs) | 244 (236, 244, 252) | 493 (487, 499) in the page rounds | 498 (498, 498, 499): see "Not done" |
| Busiest scenario, broker calls / min | 0 (0, 0) | 0 (0, 0) | 0 |
| Idle Bridge, broker calls / min | 0 (0, 0) | 0 (0, 0) | 0 |

A dry run costs 3 to 9 ms in demo. On a live account it reads the broker's order book, one call per live account.

## Read this first

- **Orders: one Cancel all dry run per render, not a loop.**
  - The dry run runs on render only: none while the page sits still, and none from the Triggers card's 2 s / 10 s
    reads (they do not redraw the page).
  - Two things were wrong with it:
    - A visit made two. The page paints from remembered answers, then draws once more when a fresh answer differs,
      and each draw ran its own dry run.
    - The dry run went through the write path, so each one forgot every remembered answer. Going back to Home after
      Orders became a cold load: 270 ms against 1 to 79.
  - Now a dry run keeps the remembered answers. The button reuses its count for 3 s unless a write happened since
    (cancel, modify, place, Cancel all itself). The Cancel all question always asks afresh, so what you confirm is
    never an old count.
- **Depth polls only while its panel is open.** 30 calls a minute open (one every 2 s), none otherwise, and none
  after the ticket closes. It used to keep going in a hidden tab; it no longer reads while the tab is hidden.
- **Algo.** The log every 1 s, the list and the selected strategy every 2 s: about 117 requests a minute, all
  local (no broker calls). Unchanged since round 4.
  - Clicking between strategies does not stack poll loops (129 a minute right after the clicks, the clicks' own reads
    included) and shows no duplicated log lines.
  - Two costs are now gone: a hidden tab kept all three reads going, and a stopped strategy's log was still read
    every second. A stopped strategy's log is now read every 5 s, a running one's every second, and a hidden tab
    reads nothing.
- **The new pages are cheap at rest.** Forward, RR and BF and Event vol make no reads after they load (3 REST a
  minute: the bell) and 20 to 26 main-thread ms/s. Forward's first data is 1.4 s: it reads six chains one after
  another.
- **Heap.** No growth from changing page beyond round 4's figure. Each page held open levels off; Algo held open for
  5 minutes: +48 KB.

## Heap over 5 minutes (soak, cycling every page every 4 s, 76 switches)

| Page held open | Before fixes: 1 min → 5 min | After fixes: 1 min → 5 min |
|---|---|---|
| Chain | 4.3 → 4.4 MB (+0.1) | 4.3 → 4.4 MB (+0.1) |
| OI Analysis | 5.3 → 5.7 MB (+0.4) | 5.5 → 6.0 MB (+0.5) |
| Strategy | 4.1 → 4.8 MB (+0.7) | 4.1 → 4.8 MB (+0.7) |
| Positions | 4.8 → 4.9 MB (+0.1) | 4.8 → 4.9 MB (+0.1) |
| Orders, Watchlists, Exposure, Flow | 1.8 to 2.7 MB, −0.07 to +0.05 | 1.8 to 2.7 MB, −0.07 to −0.02 |
| Algo | 1.8 MB (−0.02) | 1.9 MB (+0.05) |
| Tab cycling all 22 pages | 11.4 → 14.5 MB (+3.0 over about 3.5 cycles) | 11.6 → 14.6 MB (+3.0) |

About +0.85 MB per cycle of 22 pages, against round 4's +1.1 MB per cycle of 18 (13.0 → 24.7 MB before its fix). The
DOM node count does not grow (1,248 at 1 and 5 minutes).

## Every page (two interleaved rounds each side; after fixes: one round)

| Page | Figure | Round 4 end | Before fixes | After fixes |
|---|---|---|---|---|
| home | First data, ms | 2192 (2197, 2187) | 2154 (2166, 2142) | 2173 |
| home | Switch from cache, ms | 40 (1, 79) | 270 (272, 268) | 72 |
| chain | First data, ms | 568 (504, 631) | 704 (719, 689) | 762 |
| chain | Main thread, ms / s | 112 (115, 110) | 108 (109, 108) | 93 |
| chain | Tick to cell p95, ms | 52 (51, 53) | 48 (49, 48) | 46 |
| positions | Tick to cell p95, ms | 155 (157, 153) | 108 (51, 164) | 53 |
| orders | First data, ms | 674 (677, 671) | 702 (713, 690) | 703 |
| orders | Switch from cache, ms | 26 (26, 26) | 48 (47, 48) | 25 |
| orders | REST / min | 9 (9, 9) | 9 (9, 9) | 9 |
| oi | Main thread, ms / s | 80 (81, 78) | 92 (93, 91) | 89 |
| oi | Tick to cell p95, ms | 101 (136, 66) | 75 (84, 66) | 86 |
| vol | Broker / min | 27 (27, 27) | 27 (27, 27) | 24 |
| screener | First data, ms | 753 (747, 759) | 798 (837, 758) | 810 |
| futures | First data, ms | 264 (282, 246) | 493 (487, 499) | 500 |
| watchlists | Broker / min | 15 (15, 15) | 16 (18, 15) | 18 |
| algo | First data, ms | 240 (257, 222) | 268 (251, 285) | 291 |
| algo | REST / min | 33 (33, 33) | 33 (33, 33) | 33 |
| volfwd | First data, ms | – | 1434 (1402, 1466) | 1457 |
| volrrbf | First data, ms | – | 651 (663, 639) | 655 |
| volevent | First data, ms | – | 1061 (638, 1484) | 560 |
| volfwd, volrrbf, volevent | REST / min; main thread, ms / s | – | 3; 20 to 24 | 3; 24 to 26 |

The other figures did not move outside the spread:
- every page: REST / min, duplicates (0 everywhere) and long tasks (0, one 1 on Limits after the fixes);
- Accounts, API, Limits, Exposure, Flow, Risk and Lab: first data and switch times.

Broker / min on still pages (0 to 30 in single rounds on Positions, Accounts, API, Limits, Exposure and Algo) is the
recorder's minute round landing in the 20 s window; it moves between rounds of the same side.

## What changed in round 5

- **Cancel all's dry run** (`app.js forgetsAnswers`, `orders-book.js`, `orders-core.js shortMemo`):
  - a POST with `dryRun: true` keeps the remembered answers;
  - the Orders button reuses its count for 3 s (`DRY_RUN_REUSE_MS`) unless a write happened since (`writeCount`);
  - the Cancel all question asks afresh.
- **Ticket depth** (`desk.js`): no reads while the tab is hidden.
- **Algo** (`algo.js`, `algo-core.js logGap`): the log every 1 s while the selected strategy runs and every 5 s
  otherwise; no reads while the tab is hidden.
- **Harness**: `run.mjs` measures Algo and the three Volatility depth tabs, and the soak holds Algo open. New:
  `probes.mjs`.

## Not done

- **Chain and Futures first data are about 230 ms slower on a cold load** (523 → 751 and 244 → 498 ms, three
  interleaved pairs each, consistent).
  - Cause: the demo instrument master now lists three index futures instead of two (`8409f98`, as NSE lists them).
    The desk quotes every future with the index before it draws, and the Futures analytics quote all three.
  - The recorder streams only the two near futures (`recorderService.mjs`, `slice(0, 2)` for an index). So the third
    is a cold broker read (one 200 ms round trip in demo) on the first load. Request traces: the quote read takes
    15 ms → 240 ms on the Chain and 3 ms → 337 ms on Futures.
  - On a real broker the master already listed three, so this is the demo catching up with reality, not new code.
  - Fix options:
    - the recorder streams all three index futures (one more stream symbol per index; `plan.mjs` and its test count
      two);
    - or the desk draws before the far futures' quotes arrive.
  - Both are design choices, so neither was made here.
- **Volatility › Forward reads its six chains one after another** (`derivDepth.mjs forwardCurve`), so its first data is
  about 1.4 s at 200 ms a read. Exposure and Event vol do the same; the scheduler would pace parallel reads anyway.
- Algo's log and list reads (117 a minute with a strategy running) could move to the shared live connection. They are
  local reads and cost no broker calls.

# Round 5b (31 Oct)

The two items left in round 5's "Not done": Chain and Futures cold first data, and the Volatility depth tabs reading
their chains one after another.

Raw results in this folder: `round5b-{before,after}-{1,2,3}.json` (`--only chain,futures,exposure,volfwd,volrrbf,volevent`,
`--latency 200`, 10 s steady windows, port 4740). Before is `9a766b5` (round 5's end), after is this round's fixes; the
same harness on both sides, run interleaved (before-1, after-1, … after-3). 4 vCPU, load average 0.4 to 0.8.

| Page | Figure | Round 5 end (`9a766b5`) | After round 5b |
|---|---|---|---|
| chain | First data, ms | 811 (824, 811, 766) | **534** (511, 583, 534) |
| chain | Switch from Home, ms | 460 (501, 460, 435) | 215 (215, 268, 215) |
| futures | First data, ms | 523 (468, 523, 541) | **307** (264, 320, 307) |
| volfwd | First data, ms | 1237 (1231, 1242, 1237) | **827** (827, 1060, 797) |
| volevent | First data, ms | 1500 (1506, 1500, 1219) | **876** (838, 876, 907) |
| exposure (one expiry), volrrbf | First data, ms | 280; 654 | 287; 692 (within the spread: one chain each) |
| all six | REST / min; broker / min; duplicates | 6; 0 to 6; 0 | 0 to 6; 0 to 6; 0 |

Medians, the three runs in brackets. Chain and Futures are back to round 4's figures (523 and 244 to 264 ms).

What changed:
- **The far-month future no longer holds the first draw.** No stream slot was added: the recorder still streams the two
  nearest index futures.
  - Chain (`desk.js quotePlan / readQuotes`): the index, the two nearest futures and the selected expiry's own future
    are awaited. A farther future without a quote yet is read at the same time and filled in (the page redrawn) when
    it arrives. Once it has a quote, one read as before, so no extra request per refresh.
  - Futures: `GET /v1/analytics/futures?wait=near` answers once spot and the two nearest futures are quoted. A far
    month still on its way comes back `pending: true` with null figures, and its read carries on through the
    scheduler. The page draws that ("–" for the far month), then fills it in from the default `wait=all` read, which
    joins the read already running. The default answer is unchanged for API clients.
- **Chains 3 at a time** (`CHAIN_READS` in `analytics/math.mjs`, `mapSettledLimit` in `server/lib/batch.mjs`): forward
  curve, vol cone (Event vol's term structure), event vol, and exposure / OI explorer across expiries.
  - Every read still goes through `marketData.optionChain`, so through the rate-limit scheduler and its budget. The
    cap only bounds how many reads one request has in flight.
  - Results are used in expiry order, so the answers and errors are those of the sequential loop
    (`chainReads.test.mjs` checks each route against a one-at-a-time run and the in-flight cap).
  - The vol cone also reads its daily candles alongside its chains.
- Forward's 827 ms is two chain round trips plus the expiry list and the page's own work. Six chains at 3 in flight
  can't go lower than two round trips.
