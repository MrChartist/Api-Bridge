# Third-party notices (ChartistScript core)

Status: written in S42, **for counsel to confirm**. Parent: [PROVENANCE.md](PROVENANCE.md) (the file-by-file register of where each piece came from). The licence of the package itself is **not chosen** (`"license": "UNLICENSED"`; ADR-0007 decision 12): the owner decides between a proprietary licence, source-available and open-core.

## What this package contains from other people

**No third-party code, no vendored library and no copied documentation.**

- **No runtime npm dependency.** `package.json` lists only development tools (`typescript`, `@types/node`, `vitest`), which are used to check and test the package and are not part of what is shipped. The server's script-engine bundle reports `0 npm deps` when it is built (`npm run script:build`), and a test (`boundary.test.ts`) fails if a source file imports anything that leaves the package.
- **Methods that are published and free to implement**, written here from the published description and checked against the package's own reference interpreter, not copied from any program:
  - Black, F. (1976), "The pricing of commodity contracts", J. Financial Economics 3 (option price on a forward);
  - Marsaglia, G. (2004), "Evaluating the Normal Distribution", J. Statistical Software 11(5) (the normal distribution function);
  - FIPS 180-4 (SHA-256), checked against the standard's test vectors and, in the host, against Node's own;
  - the textbook definitions of the common studies: Wilder (RSI, ATR, ADX, parabolic SAR), Appel (MACD), Bollinger, Donchian, Kaufman (adaptive average), Hosoda (Ichimoku), Klinger, Nison and Bulkowski (candlestick patterns), and similar. Each is named in the file that implements it (PROVENANCE.md);
  - standard techniques: recursive-descent parsing, Python-style indentation tokens (INDENT/DEDENT), content-addressed hash-consing, Levenshtein distance for "did you mean", running sums and a monotonic deque for rolling windows.
- **Names.** Many function names (`ta.sma`, `ta.crossover`, `close[1]`) are the common vocabulary of technical analysis and are also used by Pine Script. They were kept on purpose so the language feels familiar. No Pine Script code or documentation text was copied. Whether similar names raise any question is for counsel (PROVENANCE.md, "Standard-library manifest").
- **Python** is used only as a syntax reference. No Python source or documentation is included.
- **Data.** No exchange file, vendor feed or third-party price history is in the package. Fixtures are invented numbers. (The host application's candlestick corpus came from Yahoo and is marked "personal use, verify" in `docs/DATA_SOURCES_AND_LICENSING.md`; that is a data-rights decision for the host, not part of this package.)

## What was held back because its origin is not clear

Two studies in the host (not in this package) have headers that call them ports of other people's scripts. They were **not** moved into the package and are **not** offered by the standard library until counsel decides:
- `src/domains/charting/services/indicators/chandelierExit.ts`: its header calls it a port of a published community script whose licence is unknown;
- `src/domains/charting/services/indicators/williamsFractals.ts`: its header calls it a port of a charting platform's built-in study; Bill Williams' definition is public, but the encoding may follow the platform's code.

## What is not covered here (the host application)

The Scanner Pro application has its own dependencies (React, Vite, Supabase client, Express and others) under their own licences. They are listed by `package.json` and `package-lock.json`. A licence report for them (for example with a licence checker run at release time) is **not part of this repository yet**: Needs verification before any release outside the owner's own use.

## What counsel is asked to confirm

1. That the statements above about origin are enough (the register is based on git history, file headers and the nature of the maths, not on a legal search).
2. The two held-back studies.
3. The names question (similar function names to another language).
4. The licence model and the product name (trademark check; the word "Pine" is not used).
5. Whether the cookbook and the standard-library reference text, written for this project, can be published under the chosen licence.
