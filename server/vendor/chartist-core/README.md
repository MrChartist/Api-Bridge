# @chartist/core: the ChartistScript language

**In plain words.** You write an idea in a line or two, such as "the close is above the highest high of the 20 candlesticks before today, on more than 1.5 times the usual volume". The same text can then find stocks that match today, draw on a chart, raise an alert, or be tested on past candlesticks. It cannot look at tomorrow's candlestick, and it never treats "no data" as "no".

ChartistScript is a small language for writing a trading idea once and using it to **scan** a market, **draw** on a chart, **alert**, and **backtest**. It looks like Python, but it is smaller and it makes three promises that a general-purpose language cannot:

1. **No look-ahead, by construction.** A script can only use the same candlestick and earlier ones. A negative index does not exist, and every library name is tagged and tested.
2. **Unknown is not false.** A value can be true, false or unknown; a stock matches only on a definite true, and "no data" is reported, never read as a miss.
3. **Honest results.** A backtest carries labels about what is wrong with its data that no caller can remove, withholds figures that would mislead, and gives a host what it needs to count how many things were tried.

```python
@screener(universe="liquid")
def scan(n: int = input(20), k: float = input(1.5)):
    level = ta.highest(high, n)[1]
    return ta.crossover(close, level) and volume > k * ta.sma(volume, 20)[1]
```

One line is also a valid script: `close > ta.sma(close, 50) and volume > 2 * ta.sma(volume, 20)`.

## Status

**A draft, not yet released.** The language and the engine are built and tested; the intermediate form (`IR_VERSION` 0) and the standard library (`1.0.0-rc.3`) are **not frozen**, so names and meanings can still change and a script's hash can change when the engine does. The package is `private`, **copyrighted, all rights reserved** (see [COPYRIGHT](COPYRIGHT)), and has **no open-source licence yet**; nothing is published. It lives inside a larger repository and is built so it can be lifted out (decision record ADR-0007 in that repository).

## Start here

| If you want to | Read |
|---|---|
| write your first script | [Getting started](docs/GETTING-STARTED.md) |
| look up a rule | [Language guide](docs/LANGUAGE.md) · [Standard library](docs/STDLIB.md) · [Error catalogue](docs/ERRORS.md) |
| write screeners, indicators, alerts, strategies | [Screeners](docs/SCREENERS.md) · [Indicators and alerts](docs/INDICATORS-AND-ALERTS.md) · [Strategies and backtests](docs/STRATEGIES.md) · [Options and futures](docs/OPTIONS-AND-FUTURES.md) |
| copy ready-made price-action scripts | [Cookbook](docs/COOKBOOK.md) · [Options cookbook](docs/COOKBOOK-OPTIONS.md) |
| run it inside your own application | [Embedding](docs/EMBEDDING.md) · the runnable [examples](examples) |
| understand how it works | [Architecture](docs/ARCHITECTURE.md) · [Specification](docs/SPEC.md) |
| find out what is coming | [Roadmap](docs/ROADMAP.md) · [Changelog](CHANGELOG.md) |
| ask a question | [FAQ](docs/FAQ.md) · [Glossary](docs/GLOSSARY.md) |

The full index is [docs/README.md](docs/README.md).

To see the language run in a browser, the repository folder holds a project page with a playground (`site/`, built with `node site/build.mjs`; it needs the `esbuild` tool and is not part of the published package).

## What is in the package

- the language: lexer, parser, formatter, checker (every problem in plain words, with a place and a hint), compiler to a small graph with two hashes, and a plan;
- a vector runtime that works a script out over typed arrays within a budget, and a reference interpreter (tests only) that it must agree with on thousands of random programs;
- a standard library: prices, `ta` functions, the 83 chart studies as `ind.<id>(...)`, 24 candlestick patterns, levels, stock facts, comparison across stocks, weekly and monthly candlesticks, other instruments;
- hosts for scripts that **draw** on a chart and that **alert**;
- a backtest: a signal panel, a simulator in whole paise, six sizing rules, rebalancing, costs and slippage, metrics, labels, forbidden views, walk-forward windows, sweep limits, a holdout window and a deflated Sharpe ratio (the ledger that counts tries is the host's), and option and future legs;
- derivatives maths and file readers (end-of-day futures and options), off until a host supplies data.

## What is not in the package

- **Data.** It reads candlesticks you pass in. It fetches nothing and stores nothing.
- **Orders.** There is no order-placement code, and a test fails if the backtest can reach any.
- **Dependencies.** None at run time. Development uses TypeScript and Vitest.
- **A user interface, an account system, a server, a command-line tool.** Those belong to the application around it. (A command-line tool is not part of the package yet; the application this package was built inside has one, and a package version that needs no data is on the [roadmap](docs/ROADMAP.md).)

## Using it as a library

```ts
import { compileSource, run } from '@chartist/core'

const compiled = compileSource('ta.crossover(close, ta.highest(high, 20)[1])\n')
if (compiled.ok && compiled.compiled) {
  const { outputs } = run(compiled.compiled, { date, open, high, low, close, volume }) // typed arrays or plain arrays
}
```

Inside this repository the package is imported through the alias `@chartist/core` (and `@chartist/core/kernel` for the candlestick maths on its own). See [Embedding](docs/EMBEDDING.md) for complete, tested examples.

## Layout

| Path | What |
|---|---|
| `src/lang/` | lexer, parser, formatter, friendly errors for Python habits |
| `src/check/` | the checker, host profiles, "did you mean" |
| `src/ir/` | the graph: lowering, hashes, plan, validation, serialisation |
| `src/runtime/` | the vector runtime, panel runs, calendars |
| `src/stdlib/`, `src/kernel/` | the manifest (data only), the library's functions, the candlestick maths |
| `src/backtest/`, `src/signal/` | the signal panel, simulator, costs, metrics, labels, validation, legs |
| `src/derivatives/` | derivatives maths and file readers |
| `src/indicator.ts`, `src/alert.ts`, `src/explain.ts` | the chart, alert and explain hosts |
| `examples/` | three runnable hosts, quoted by the embedding guide |
| `docs/` | the documentation (see the index) |
| `PROVENANCE.md`, `THIRD_PARTY_NOTICES.md` | where every ported algorithm came from; third-party notices |

## Rules (checked by tests)

No import leaves the package; no runtime dependency; no `window`, `document`, `fetch`, `process.env` or `require`; no `eval`, `new Function` or dynamic `import()`; no clock, timers or random numbers (the same input always gives the same output); no product or vendor names in source; the kernel imports only the kernel. See [Contributing](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md): what the package defends against (hostile script text), what it does not (your process, your data), and how to report a problem.
