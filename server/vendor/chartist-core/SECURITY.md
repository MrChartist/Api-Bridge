# Security

ChartistScript is built to run **text written by someone else**: a script pasted into a form, an answer from an AI assistant, a file from a stranger. This page says what the package defends against, what it does not, and how to report a problem.

## Reporting a problem

A security contact has **not been published yet** (the package is private and unreleased). Until it is, report a problem privately to the owner of the repository you received this package from; do not open a public issue. Please include the script text, the data shape and what you saw. A contact address and a response policy will be added here before any release.

## What the package does

| Risk | Defence |
|---|---|
| A script runs code | Nothing is generated or evaluated as code. A script becomes a graph of known operations that the engine interprets. There is no `eval`, no `new Function`, no generated JavaScript, no dynamic `import()`; a boundary test fails if a source file has one |
| A script reaches the outside world | The package imports nothing that leaves it and uses no `fetch`, file, environment, clock or timer; a test fails if a source file does |
| A script takes unbounded time or memory | Static limits (size, nesting, tree size, helper depth, series alive at once, history needed) are enforced before a run; a run has a work budget and stops with the line that pushed it over |
| A script crashes the parser | The lexer and parser throw only `ScriptError`; fuzz tests feed them hostile input at the size limit and require speed and a clean error |
| A script reads the future | A negative index does not exist; every library name carries a causality tag that is tested by cutting the data and replacing what follows |
| A stored program is tampered with | `deserializeIr` checks the parts that could do harm (a shift must be a non-negative whole number; every length must be inside the range its parameter allows) before a program is trusted. It is not the whole checker: a program that asks for a very long look-back is accepted by it and refused afterwards, when the plan is made (`E-LOOKBACK`) |
| A result is not what it seems | Backtests carry labels the caller cannot remove and forbidden views cannot be asked for. The package keeps a list of forbidden phrases and its own tests apply it to its label texts, refusal reasons and field names; applying it to text a host adds is the host's job |
| A backtest becomes an order | The package contains no order-placement code, and a test walks everything the backtest can reach to prove it |

## What the package does not do

- **It does not sandbox your process.** It bounds the work of one run; it cannot bound your server. Run untrusted scripts in a worker or process with its own time and memory limits, and refuse a script before running it when the checker says so.
- **It does not authenticate anyone.** Who may write or run a script is the host's decision.
- **It does not protect the data you give it.** A script can read every number you pass in and show it in a result column. Pass only what the person may see.
- **It does not hide timing.** Runs take different times for different scripts and data.
- **It does not vouch for the label inputs.** Whether data is survivors-only is a fact the host reports; the package makes it impossible to say nothing, not impossible to say something false.

## Known limits

- The limits and the budget are starting values and may be tuned before a stable release.
- The package has had two independent reviews; each fix has a test. That is evidence, not proof. A read by someone outside the project is not scheduled; the roadmap lists only a read of the *documentation* by someone who did not write it ([roadmap](docs/ROADMAP.md)).
- The options and futures file readers are written against published layouts and have been run on invented sample files only.

## Supply chain

The package has **zero runtime dependencies**. Its development dependencies are TypeScript, Vitest and Node's type definitions. Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the origin of every ported algorithm is in [PROVENANCE.md](PROVENANCE.md).
