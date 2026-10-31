# ChartistScript core (vendored copy)

This folder is a **compiled copy** of the ChartistScript core, `@chartist/core`, from the owner's scanner repository
(`MrChartist/scanner`, folder `packages/chartist-core`, commit `c2ac504`).

- **Copyright.** The core is Copyright (c) 2026 Rohit Singh (Mr. Chartist), all rights reserved: see [COPYRIGHT](COPYRIGHT).
  It is **not** covered by this repository's MIT LICENSE. Where each part came from: [PROVENANCE.md](PROVENANCE.md) and
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The core's own README and SECURITY notes are kept beside them.
- **What changed.** Nothing but the build: the TypeScript in `src/` was compiled with TypeScript 7.0.2 to ES2023
  modules (comments kept), and each relative import was given its full file name (`./x` to `./x.js`, `./dir` to
  `./dir/index.js`) so Node can load it without a bundler. Tests are not included.
- **Do not edit these files.** Change the core in the scanner repository and run
  `node scripts/vendor-chartist-core.mjs --core <scanner checkout>`. `VENDOR.json` holds a sha256 of every file and
  `server/bridge/studies/vendor.test.mjs` fails when one differs.
- **How the Bridge uses it.** Only `server/bridge/studies/` imports it: through `index.js` (the core's public entry),
  plus `stdlib/studies/specs.js` (data only: which pane each study is drawn in).
  Studies run on the server, in a worker thread with a time limit: see `docs/guides/studies.md`. The core's backtest and
  derivatives modules are part of the copy because they compile cleanly, but nothing in the Bridge calls them; the
  Bridge has its own backtest.
