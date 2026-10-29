# Changelog

API changes that need a migration window. Each entry keeps its anchor so `Link` headers can point at it.

## optionchain-ivmodel

`GET /v1/optionchain` gains `ivModel` (docs/spec/p1-03-pricing-vol.md §3.9, §10).

- `ivModel=b76-forward`: every leg's `iv`, `delta`, `gamma`, `theta` and `vega` come from Black-76 on the 5-strike
  put-call-parity forward, mid prices and the vol-time clock (`server/bridge/dashboard/pricing.js`, the same code the
  dashboard runs). Theta is per trading-day unit. The broker's own IV, when it sent one, is kept in `brokerIv`. The
  chain carries a `pricing` object (forward, rate, clock). A leg without an IV says why in `ivReason` (`SETTLING`
  inside the expiry-day settlement window, `NOQUOTE`, `TICK`, `INTRINSIC`, `RANGE`, `SETTLED`, `NOFORWARD`).
- `ivModel=legacy-bs-spot`: Black-Scholes on spot with calendar days to 15:30 IST (at least a quarter day) and theta
  per calendar day. Byte for byte the output before this change.
- Default: `market.chain.ivModelDefault`, `legacy-bs-spot` until **1 May 2027**, then `b76-forward`. A response that
  used the legacy model because it was the default carries `Deprecation: @1809109800` and
  `Link: </docs/CHANGELOG.md#optionchain-ivmodel>; rel="deprecation"`. `legacy-bs-spot` stays selectable until `/v2`.
- Owners can switch early with `"market": { "chain": { "ivModelDefault": "b76-forward" } }`.

Why: the old default gave a different IV from the dashboard (Black-76 on the forward) and jumped over weekends and on
expiry day; the vol-time clock keeps IV steady from Friday's close to Monday's open and has no quarter-day floor.
