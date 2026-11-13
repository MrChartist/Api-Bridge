# Contributing

Thanks for helping. The most useful contributions right now are:

- **Broker reports.** Only Dhan is verified with a live account; the other 40 brokers are beta. Trying one in paper mode and telling us what worked is a real help. Use the "New broker / broker report" issue form.
- **Bug fixes** with a test that fails before the fix.
- **Docs fixes** wherever something was unclear when you set the Bridge up.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first. Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Development setup

You need Node.js 22.12 or newer (CI runs 22 and 24; the test tools need 22.12) and, for the Python SDK, Python 3.9 or newer.

```bash
git clone https://github.com/MrChartist/api-bridge-v2.git
cd api-bridge
npm ci
npm start -- --demo --open   # dashboard with demo data, no broker account needed
```

Before you open a pull request, run what CI runs:

```bash
npm test                     # vitest, all server tests (no network)
npm run typecheck
npm run check:mjs            # node --check on every .mjs file
npm audit --omit=dev         # runtime dependencies must have no known vulnerabilities
node --test sdk/node/test/client.test.mjs
python -m pip install ./sdk/python pytest && python -m pytest sdk/python/tests -q
```

Tests never touch the network or a real broker. Broker adapters are tested against recorded sample responses in `server/brokers/__fixtures__/`.

## Ground rules

- **Paper by default.** Nothing may switch live trading on, or bypass a safety check, without every opt-in described in the README's safety model.
- **No real data.** No real credentials, tokens, account IDs, client codes, names, PANs or phone numbers anywhere: code, fixtures, logs or screenshots.
- **Official sources only.** Broker behaviour comes from the broker's official API docs, SDKs or Postman collections, cited in the adapter header and fixture manifest. Anything the docs leave out is marked "needs live verification".
- **Exact dependency versions.** Runtime dependencies are pinned (`"zod": "4.6.7"`, not `^4.6.7`); CI checks this.
- **Keep the API contract in sync.** If a route, field or stream message changes, update `docs/openapi.yaml` or `docs/asyncapi.yaml` and the user-facing guide in `docs/guides/`.
- Add a line to `CHANGELOG.md` under "Unreleased" for anything a user would notice.

## Adding or improving a broker

Read [docs/broker-contract.md](docs/broker-contract.md) first. In short:

1. Add `server/brokers/<id>.mjs` exporting `id`, `credentialFields` (non-secret fields only), `capabilities` and one function per declared capability. Dhan (`server/brokers/dhan.mjs`) is the reference adapter.
2. Add fixtures in `server/brokers/__fixtures__/<id>/`: a `manifest.json` citing the official sources and one `<capability>.json` per capability, with every token, ID and name replaced by a dummy value.
3. Add `server/brokers/<id>.test.mjs` running `validateAdapter` and `runContractHarness`.
4. Add the broker's documented rate limits to `server/bridge/ratelimit/brokerPolicies.mjs`, with a source link.
5. Regenerate the capability table with `npm run capabilities` and update [docs/BROKERS.md](docs/BROKERS.md).
6. Paste the per-broker checklist from section 8 of the contract into your pull request.

Live order mapping for a new broker is only accepted once the broker has been verified with a live account.

## Pull requests

- Keep each pull request to one change; it is easier to review and to revert.
- Fill in the pull request template, including how you tested it.
- Every change is reviewed by a maintainer (see `.github/CODEOWNERS`) before it is merged.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
