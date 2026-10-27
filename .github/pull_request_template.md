## What this changes

<!-- One or two sentences. Link the issue it fixes, for example "Fixes #123". -->

## Why

<!-- The problem, the trader-facing effect, or the broker documentation that motivates it. -->

## How it was tested

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run check:mjs`
- [ ] SDK tests, if `sdk/` changed (`node --test sdk/node/test/client.test.mjs`, `python3 -m unittest discover -s sdk/python/tests -t sdk/python`)
- [ ] Tried it in demo mode (`npm start -- --demo --open`), if it changes the dashboard, an integration or an API answer

## Checklist

- [ ] No real credentials, tokens, account IDs, client codes, names, PANs or phone numbers anywhere (code, fixtures, logs, screenshots)
- [ ] Orders still default to **paper**; nothing here can switch live trading on or bypass a safety check
- [ ] Broker facts come only from the broker's **official** documentation, SDKs or Postman collections, and are cited; anything else is marked "needs live verification"
- [ ] `docs/openapi.yaml` / `docs/asyncapi.yaml` updated if a route, field or stream message changed
- [ ] User-facing docs (README, `docs/guides/`) updated if behaviour changed
- [ ] `CHANGELOG.md` has a line under "Unreleased" for anything a user would notice

<!-- Adding or changing a broker adapter? Paste the per-broker checklist from docs/broker-contract.md, section 8. -->
