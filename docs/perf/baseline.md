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
