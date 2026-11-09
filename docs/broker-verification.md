# Verify a broker

Every broker adapter sits on a four-step ladder. The level of each one is recorded in `server/brokers/verification.json` and shown in the dashboard, in `GET /v1/brokers` (`verification.level`) and in the generated tables of [BROKERS.md](BROKERS.md).

| Level | Meaning | Who sets it |
|---|---|---|
| `beta` | Recorded samples only. At least one contract case is still missing (a table cell says `needs fixture`). | The code (generated) |
| `contract` | Every contract case passes with none missing, on recorded replies. No real broker was involved. | The code (generated) |
| `sandbox` | Checked against the broker's own sandbox or paper environment. | A person, with evidence |
| `live-verified` | Checked with a real account, with the date and who did it. | A person, with evidence |

`beta` and `contract` are rewritten by `node scripts/generate-broker-verification.mjs` from the test results, and `server/brokers/verification.test.mjs` fails when the file and the adapters disagree. `sandbox` and `live-verified` are never set by code: a person edits the file, and the test refuses either level on a broker that is missing a contract case.

## A. Close the gaps (no account needed)

1. Run `node scripts/generate-broker-verification.mjs --check` and open the "Order-safety contract cases" table in BROKERS.md. Find your broker's `needs fixture` cells.
2. Open the broker's official API documentation (the link is in `server/brokers/__fixtures__/<id>/manifest.json`).
3. Add or fix `server/brokers/__fixtures__/<id>/orderCases.json`. Copy each reply from the documentation or from your own sandbox recording; never type one from memory. Each entry carries a `source` URL:
   - `refusals`: the reply the broker sends when it refuses an order (often HTTP 200 with an error body).
   - `sessionExpired`: the reply when the session or token has ended.
   - `stopLoss`: an adapter-shaped stop-loss order and the request fields the docs name for the trigger and limit price. Use `"offered": false` with a note only if the adapter does not send stop-loss orders.
   - `cancelVariety`: only where the broker's cancel call takes an order variety.
4. Run `npx vitest run server/brokers/contractOrders.test.mjs server/brokers/verification.test.mjs`. A failing case is a real adapter problem: fix the adapter, not the fixture.
5. Run `node scripts/generate-broker-verification.mjs` and commit the three changes (fixture, `verification.json`, BROKERS.md).

## B. Check against a sandbox or a real account

You need a broker account with API access and, for orders, a registered static IP where the broker requires one. Use the smallest possible quantity, and an instrument you do not mind holding for a minute.

1. Start the Bridge on your own computer with the broker's account added and **paper mode on**. Log in from the dashboard (Morning login works). Confirm the account shows as logged in.
2. Reads: call `GET /v1/funds`, `/v1/positions`, `/v1/orders`, `/v1/ltp`, `/v1/optionchain` for the account. Compare each figure with the broker's own app.
3. Feed (if the adapter declares one): subscribe to two symbols on the stream, confirm ticks arrive, close your network for 60 seconds and confirm it recovers by itself.
4. Session end: log out in the broker's app, or wait for the daily end. Confirm the account shows "Session ended", reads fail with `SESSION_EXPIRED`, and a login brings it back without restarting the Bridge.
5. Orders (live opt-ins required, see the safety guide). For each of limit, stop-loss and stop-loss market where the broker offers them: place, check the order in the broker's app, modify the price, cancel. Check the trigger price and order variety in the broker's app, not only in the Bridge. Place one order the broker will refuse (for example a price far outside the range) and confirm the Bridge shows it as refused, not placed.
6. Lost reply: this cannot be tested safely against a real broker. The contract cases cover it.
7. Write down: the date, your name or handle, the broker's plan or app type, the Bridge version, and anything that differed.

## What to redact before you share results

A result you share (an issue, a pull request, a chat) must contain none of this:

- API keys, secrets, access tokens, request or auth codes, session tokens, the `master.key` file or `secrets.enc`.
- Passwords, PINs, MPINs, one-time codes and the TOTP secret.
- Your client or user ID, account number, PAN, date of birth, phone number, e-mail.
- Your static IP address.
- Order ids and trade ids if they identify you to the broker; prices and symbols are fine.
- Screenshots: crop to the figures, and check the address bar and any account banner.

Replace each with a dummy (`dummy-token-0001`, `DEMO1`). The Bridge's own logs and error messages already hide saved secrets, but check anyway. If a raw broker reply is useful, trim it to the fields in question first.

## Record it

Edit your broker's entry in `server/brokers/verification.json`:

```json
"mybroker": {
  "level": "live-verified",
  "verifiedOn": "2026-11-20",
  "verifiedBy": "your name or handle",
  "evidence": "Placed, modified and cancelled a limit and a stop-loss order on a live account; funds and positions matched the app."
}
```

Use `sandbox` instead when the check was in the broker's sandbox. Then run `node scripts/generate-broker-verification.mjs` and send the change. Verified brokers are opened for live orders one at a time, so a small, clear record is more useful than a long one.
