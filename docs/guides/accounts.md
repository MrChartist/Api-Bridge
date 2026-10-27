# Brokers and multiple accounts

The Bridge holds connections to several brokers and several accounts at once. Each account has its own session, its
own rate-limit budget and its own credentials; one account's credentials are never used for another account's calls.

## 1. Declare accounts in `bridge.config.json`

```json
{
  "accounts": [
    { "id": "dhan-main",      "broker": "dhan",    "label": "Dhan (main)" },
    { "id": "zerodha-main",   "broker": "zerodha", "label": "Zerodha (main)" },
    { "id": "zerodha-spouse", "broker": "zerodha", "label": "Zerodha (spouse)", "enabled": true },
    { "id": "paper",          "broker": "paper",   "label": "Practice account" }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Your name for the account: 2-32 lowercase letters, digits or hyphens. Used everywhere (`account=` in queries, `"account"` in orders). |
| `broker` | Adapter id from [BROKERS.md](../BROKERS.md), or `paper`. |
| `label` | Shown on the dashboard and in API responses. |
| `enabled` | `false` keeps the account in the file but out of use. |
| `holder` | Whose account it is (`self`, `spouse` ...; never a PAN). Pooling only ever joins accounts of one holder. |
| `marketData.pooling` | Opt in to letting this account serve other unpinned reads (see [rate-limits.md](rate-limits.md)). Off by default. |
| `marketData.poolingWhenTermsUnknown` | Also pool when the broker's terms on this are not confirmed (every broker today). Your decision; off by default. |
| `live` | `{ "enabled": false, "allowedSources": ["rest"], "registeredIp": "..." }`; see [safety.md](safety.md). Off by default. |
| `limits` | Per-account safety limits that may only be stricter than the global `safety` section. |

`npx mc-bridge accounts list` shows what the Bridge read. `npx mc-bridge doctor` checks the file.

## 2. Log in

Credentials never go in the config file. They go to the encrypted SecretStore (`data/secrets.enc`, AES-256-GCM)
through `POST /v1/accounts/{id}/session`, which answers only on this computer and needs an admin key.
`mc-bridge accounts connect <accountId>` calls it for you.

`GET /v1/brokers` lists every broker with its `authKind` and the fields it needs (`credentialFields`). There are four
kinds of login:

| Kind | What you send | Examples |
|---|---|---|
| `apiKeyToken` | `values` with the broker's token fields | Dhan (`clientId`, `accessToken`), Groww, Samco |
| `oauthRedirect` | `values` with the API key, secret and the access token from the broker's login page | Zerodha, Upstox, Fyers |
| `requestTokenExchange` | `values` with the request code from the broker's login page; the Bridge exchanges it | Shoonya, Flattrade, Alice Blue |
| `sessionLogin` | `values` (API key, client id) plus `secrets` (PIN or password and the **current** TOTP code) | Angel One, Kotak, Motilal Oswal |

Example for Angel One (`GET /v1/brokers` shows each broker's exact `loginFields`):

```bash
curl -X POST http://127.0.0.1:4300/v1/accounts/angel-main/session \
  -H "Authorization: Bearer $MCB_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"values": {"apiKey": "...", "clientId": "A123"}, "secrets": {"password": "<PIN>", "totpCode": "123456"}}'
```

```bash
curl -X POST http://127.0.0.1:4300/v1/accounts/dhan-main/session \
  -H "Authorization: Bearer $MCB_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"values": {"clientId": "1100000000", "accessToken": "eyJ..."}}'
```

For `sessionLogin` brokers the password, PIN and TOTP code are passed to the broker's login call once and then
dropped. They are never stored, logged, cached or used as a cache key. Only the session token the broker returns is
kept, encrypted.

Check and test:

```bash
curl -H "Authorization: Bearer $MCB_ADMIN_KEY" http://127.0.0.1:4300/v1/accounts
curl -X POST -H "Authorization: Bearer $MCB_ADMIN_KEY" http://127.0.0.1:4300/v1/accounts/dhan-main/test
curl -X DELETE -H "Authorization: Bearer $MCB_ADMIN_KEY" http://127.0.0.1:4300/v1/accounts/dhan-main/session   # log out
```

## 3. Sessions

States: `missing` → `connected` → `expired` or `error`. Most brokers end API sessions early every morning (SEBI
requires a daily logout). When a broker rejects a session, the Bridge marks the account `expired` straight away, and
reads that need it answer `SESSION_EXPIRED` with a plain message. Log in again; nothing else changes. The Bridge never
stores TOTP secrets and never automates 2FA.

If you change credentials with another tool while the Bridge runs, it notices the change to `data/secrets.enc` and
reloads.

## 4. Family accounts

SEBI's retail algo rules allow use by you, your spouse, dependent children and dependent parents. Add each as its
own account. Limit API keys to the accounts a tool needs:

```bash
npx mc-bridge keys create --label spouse-sheet --scope read --accounts zerodha-spouse --expires 30d
```

Do not add anyone else's accounts: the Bridge is personal software, not a service for other people.

## 5. Choosing an account per request

- `account=<id>` (query) or `"account": "<id>"` (order body) pins the request to that account.
- Without it, market-data reads use the primary account (the first enabled, connected account in config order that
  can serve the request), or several accounts when pooling is allowed for that broker.
- Orders always name their account. Portfolio reads (positions, holdings, funds, orders) are per account.
