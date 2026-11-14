# Contributing

Thanks for helping. This project is a **connection layer**: one local API in front of Indian broker accounts, with the prices and data behind it and ways for other projects to connect. It does not include analytics, scanners, strategy tools or a trading desk (see [what it does not do](README.md#what-it-does-not-do)), so a pull request that adds one will be declined however good it is.

The most useful contributions right now are:

- **Broker reports.** Only Dhan is verified with a live account; the other 40 brokers are beta or contract-tested (the level of each is in [docs/BROKERS.md](docs/BROKERS.md)). Trying one in paper mode and telling us what worked is a real help. Use the bug report form (it has a field for the broker id) for what you found, or the "New broker request" form for a broker that is missing.
- **Bug fixes** with a test that fails before the fix.
- **Docs fixes** wherever something was unclear when you set the Bridge up.
- **Good first changes:** a typo or a wrong command in a guide, a missing error explanation, a test for a behaviour that has none. If you are unsure whether something fits, open an issue first and ask.

Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Quick path for a first pull request

You need git, Node.js 22.12 or newer (`node -v`) and a GitHub account. You do **not** need a broker account, extra tools, or git worktrees; a plain fork and branch is enough.

```bash
# 1. Fork the repository on GitHub, then:
git clone https://github.com/<your-user>/api-bridge-v2.git
cd api-bridge-v2
git switch -c fix/short-description

# 2. Install and check that everything passes before you change anything
npm ci
npm test

# 3. Make your change, then run only the tests around it
npx vitest run server/bridge/sources/router.test.mjs
npm run docs:generate            # only if you changed docs/openapi.yaml, a guide in docs/guides/, or the guides index

# 4. Commit, push the branch to your fork and open a pull request against main
git commit -am "Say what you changed, in one line"
git push -u origin fix/short-description
```

In the pull request, fill in the template (what, why, how you tested it). For a user-visible change add one line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md). A maintainer reviews every pull request; small, single-purpose ones are reviewed fastest. Maintainers who run several changes in parallel may use git worktrees; that is a personal workflow, not a requirement.

## Development setup

You need Node.js 22.12 or newer (CI runs 22 and 24; the test tools need 22.12) and, for the Python SDK, Python 3.9 or newer.

```bash
git clone https://github.com/MrChartist/api-bridge-v2.git
cd api-bridge-v2
npm ci
npm run dev                  # demo mode: sample data, no broker account needed, opens the dashboard
```

Before you open a pull request, run what CI runs:

```bash
npm test                     # vitest, all server tests (no network)
npm run typecheck            # checks the TypeScript in src/ only
npm run check:mjs            # node --check on every .mjs file
npm run docs:check           # fails when generated docs are out of date; fix with: npm run docs:generate
npm audit --omit=dev         # runtime dependencies must have no known vulnerabilities
node --test sdk/node/test/client.test.mjs sdk/node/test/data.test.mjs sdk/node/test/events.test.mjs sdk/node/test/examples.test.mjs   # Node SDK
python -m pip install ./sdk/python pytest && python -m pytest sdk/python/tests -q   # Python SDK (pytest, not unittest)
```

If you change `package-lock.json` (a dependency), also run `npm run notices` to refresh [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md); a test fails otherwise.

While you work, run one file at a time: `npx vitest run server/bridge/sources/router.test.mjs`.

**Tests never touch the network or a real broker.** The test run replaces the global `fetch` with a guard (`test/noRealNetwork.mjs`) that allows only requests to this computer and fails any test that tries another host, so inject a fake `fetch` where code takes one. Broker adapters are tested against recorded sample responses in `server/brokers/__fixtures__/`, and data sources against fixtures under `server/bridge/sources/providers/__fixtures__/`.

**A test keeps certain names out of the repository.** `server/bridge/core/sources.test.mjs` scans every text file (code, comments, docs, fixtures) and fails if it finds the name of a third-party broker-integration project; facts come from official documentation only, so do not copy from or name such projects. If it fails on your change, remove the name.

To run a Bridge by hand without touching your own data, give it a throwaway folder and a port of your choice: `MCB_HOME=$(mktemp -d) MCB_PORT=4401 node bin/mc-bridge.mjs start --demo`.

## Ground rules

- **Paper by default.** Nothing may switch live trading on, or bypass a safety check, without every opt-in described in the [safety guide](docs/guides/safety.md).
- **No real data.** No real credentials, tokens, account IDs, client codes, names, PANs or phone numbers anywhere: code, fixtures, logs or screenshots.
- **Official sources only.** Broker behaviour comes from the broker's official API docs, SDKs or Postman collections, cited in the adapter header and fixture manifest. Anything the docs leave out is marked "needs live verification".
- **Exact dependency versions.** Runtime dependencies are pinned (`"zod": "4.6.7"`, not `^4.6.7`); CI checks this.
- **Keep the API contract in sync.** If a route, field or stream message changes, update `docs/openapi.yaml` or `docs/asyncapi.yaml` and the user-facing guide in `docs/guides/`.
- Add a line to `CHANGELOG.md` under "Unreleased" for anything a user would notice.

## Adding or improving a broker

Read [docs/broker-contract.md](docs/broker-contract.md) first. In short:

1. Add `server/brokers/<id>.mjs` exporting `id`, `credentialFields` (non-secret fields only), `capabilities` and one function per declared capability. Dhan (`server/brokers/dhan.mjs`) is the reference adapter.
2. Add fixtures in `server/brokers/__fixtures__/<id>/`: a `manifest.json` citing the official sources and one `<capability>.json` per capability, with every token, ID and name replaced by a dummy value.
3. Add `server/brokers/<id>.test.mjs` (for example `dhan.test.mjs`) running `validateAdapter` and `runContractHarness`.
4. Add the broker's documented rate limits to `server/bridge/ratelimit/brokerPolicies.mjs`, with a source link.
5. Regenerate the capability table with `npm run capabilities` and update [docs/BROKERS.md](docs/BROKERS.md).
6. Paste the per-broker checklist from section 8 of the contract into your pull request.

Live order mapping for a new broker is only accepted once the broker has been verified with a live account.

## Adding a data source or a plugin

A data source answers read-only market-data questions (quotes, history, expiries, option chains) and labels every answer with its class (`realtime`, `delayed` or `eod`), its delay and whether it is official. It never places orders and never sees broker credentials. Anything that logs in, holds tokens or sends orders is a broker adapter and stays in this repository.

Read [docs/source-contract.md](docs/source-contract.md) first. It covers the descriptor, the provider methods, errors, limits, the plugin protocol, conformance, and (section 9) how to write a built-in provider. Then:

1. For a built-in provider, add `server/bridge/sources/providers/<id>.mjs` (add it to `createBuiltinProviders` in `providers/index.mjs`) with fixtures in `providers/__fixtures__/` and a test that runs `runProviderConformance`. Take `fetch` and the clock as arguments so tests inject fakes, use the vendor's documented limits, and link its terms. Use the vendor's official documentation only.
2. For a plugin, copy `examples/source-plugin/` (it runs offline) and check yours with `npm run bridge -- sources plugins check <folder>`. Note that this runs the plugin's code.
3. Update [docs/guides/sources.md](docs/guides/sources.md) (the user-facing guide), the OpenAPI file if a route changes, and `CHANGELOG.md`.

## Pull requests

- Keep each pull request to one change; it is easier to review and to revert.
- Fill in the pull request template, including how you tested it.
- Every change is reviewed by a maintainer (see `.github/CODEOWNERS`) before it is merged.

By contributing you agree that your contribution is licensed under the [GNU Affero General Public License v3.0](LICENSE).
