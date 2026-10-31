# Licence check for the paid Bridge (plan)

Status: plan, not built. Applies to **version 1** (`MrChartist/api-bridge`, the full app sold as a Windows EXE).
Version 2 (`MrChartist/api-bridge-v2`, the API connection layer) stays free and has no licence check.

## 1. What it must do

- A buyer pays, gets a **licence key**, pastes it once in the dashboard, and the Bridge is unlocked on that PC.
- It keeps working **offline** for days (markets do not wait for our server), and never interrupts trading mid-session.
- It is hard to share casually (one key on fifty PCs), without pretending to be uncrackable: the EXE is JavaScript
  and a determined cracker will win. The aim is honest users paying, not perfect DRM.
- It never sends trading data, broker credentials or API keys anywhere. Only the licence key and a hashed machine id.

## 2. Pieces

| Piece | What it is |
| --- | --- |
| Licence key | What the buyer types: `MCB-XXXXX-XXXXX-XXXXX-XXXXX` (random, 100+ bits, base32 without look-alike letters). |
| Licence server | A small HTTPS service we run (a Cloudflare Worker + KV/D1, or a tiny Node service). Holds licences, machines and plans. |
| Payment | Razorpay (India, UPI/cards) and/or Stripe. Its webhook tells the licence server to create or extend a licence and email the key. |
| Licence token | What the server hands the Bridge after activation: a JSON document **signed with Ed25519**. The Bridge ships only the public key, so it can check the token offline but cannot forge one. |
| Machine id | SHA-256 of (Windows MachineGuid + OS user SID + a fixed app salt). Only the hash leaves the PC. |

Licence token contents: `licenceId`, `plan` (monthly / yearly / lifetime), `features` (list), `machineHash`,
`maxMachines`, `issuedAt`, `validUntil` (subscription end), `refreshBy` (issuedAt + 7 days), `graceDays` (14),
`tokenVersion`. Signed bytes = canonical JSON.

## 3. Flows

**Buy.** Checkout page → payment webhook → licence server creates the licence (plan, end date, 2 machines) → email
with the key and a "Open your Bridge" link.

**Activate (first run).** The dashboard shows an **Activate** screen before anything else (after the no-key local
sign-in): paste the key → `POST /v1/licence/activate` on the Bridge → the Bridge calls
`https://licence.mrchartist.com/v1/activate` with `{ key, machineHash, appVersion }` → gets a signed token →
verifies it with the built-in public key → saves it to `<dataDir>/licence.json` (mode 0600). Wrong key, expired, or
too many machines: a clear message with "Manage your machines" (link to the customer portal).

**Every start and every 6 hours.** Verify the saved token offline: signature, `machineHash` matches this PC,
`validUntil` not passed. If `refreshBy` has passed, refresh online (`/v1/refresh`); a refresh failure is fine until
`refreshBy + graceDays`.

**Renew.** The payment provider renews the subscription; the next refresh picks up the new `validUntil`. No user action.

**Move to a new PC.** "Deactivate this computer" in the dashboard (`/v1/deactivate` frees the seat), or from the web
portal if the old PC is gone. Limit: 3 self-service moves a month, to stop rotation sharing.

**Trial.** First run without a key may start a 14-day trial: the server issues a trial token for that `machineHash`,
once per machine.

## 4. What the licence unlocks, and what it never blocks

- **Free without a licence (v2 parity):** broker accounts and login, API keys, market data, stream, orders, paper,
  safety, webhooks, MCP, compat API. Keeps the public v2 promise and lets scripts keep running.
- **Needs a licence:** the v1 extras: option desk, strategy builder, OI and vol analytics, screeners and scanner,
  market calendar and reference data, recorder, participants, journal, alerts, Excel workbook extras, and so on.
  Gating is per module: `defineModule({ licence: "pro" })`; an unlicensed module's routes answer 402
  `LICENCE_REQUIRED` and its dashboard pages show an "Activate" card instead.
- **Never blocked, licence or not:** closing or cancelling orders, exits, the kill switch and every safety route. An
  expired licence must never trap someone in a live position.
- **Expiry behaviour:** a 7-day banner before `validUntil`; after the grace period the paid modules lock at the next
  start or the next market close, never during market hours.

## 5. Tamper resistance (reasonable, not absolute)

- Build the EXE as a Node single executable with the app bundled and compiled to V8 bytecode, so the source is not
  sitting in plain files.
- Check the licence in more than one place (module loader, router, dashboard bootstrap) through one small module, so
  one patched `if` does not unlock everything.
- Pin the licence server's TLS certificate fingerprint; reject tokens whose `issuedAt` is in the future (clock tricks);
  remember the newest `issuedAt` seen and refuse older tokens (rollback).
- Server side: rate-limit activations, flag keys activated on many machines or from many countries, revoke on chargeback.

## 6. Privacy and law

- Sent: licence key, machine hash, app version, OS name. Never: broker data, orders, positions, API keys, IP logs
  beyond 30 days.
- Privacy policy and EULA shown once at activation (accept = a click, stored with the token).
- GST invoices from the payment provider; the licence server stores only the email, plan and payment reference.

## 7. Build order

1. **Licence server** (activation, refresh, deactivate, Ed25519 signing, admin view) with the payment webhook. About 4–5 days.
2. **Bridge `licence` module**: token verify, `licence.json`, background refresh, `/v1/licence` status routes, the
   per-module gate and 402 answers, plus tests (forged, expired, wrong machine, offline grace, rollback). About 3–4 days.
3. **Dashboard**: Activate screen, Licence page (status, plan, renew link, deactivate), expiry banner, locked-page card. About 2–3 days.
4. **EXE build**: bytecode bundle, signing the EXE with a code-signing certificate (removes the Windows SmartScreen
   warning; needs an OV/EV certificate), auto-update channel. About 3–4 days.
5. **Checkout and emails**: pricing page, receipt and key email, customer portal (machines, invoices). About 2–3 days.

## 8. Decisions needed

1. Payment provider: Razorpay, Stripe, or both?
2. Plans and prices: monthly / yearly / lifetime, and the price of each.
3. Machines per licence: 2 suggested.
4. Offline grace: 14 days suggested.
5. Trial: 14 days, or none?
6. Exactly which modules are paid (section 4 is the proposal).
7. Licence server hosting and domain (e.g. `licence.mrchartist.com` on Cloudflare).
