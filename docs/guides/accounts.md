# Brokers and multiple accounts

The Bridge holds connections to several brokers and several accounts at once. Each account has its own session, its
own rate-limit budget and its own credentials; one account's credentials are never used for another account's calls.

## 1. Declare accounts in `bridge.config.json`

The easiest way: on the dashboard, open **Accounts** and press **Add a broker**. The Bridge saves the account to the
config file it loaded (or creates the per-user `bridge.config.json` when it started without one) and uses it at once,
no restart. Accounts added this way are paper only; turning live trading on stays an edit of the file. **Remove**
takes an account out again (not one with live trading set up, and not your last paper account). Over the API:
`POST /v1/accounts` with `{ "broker": "dhan" }` (optional `id` and `label`) and `DELETE /v1/accounts/{id}`, both
admin, this computer only, with an admin key that may use every account.

Or edit the file yourself:

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
| `marketData.pooling` | Opt in to letting this account serve other unpinned reads (see [rate-limits.md](rate-limits.md)). Off by default. Pooling also needs your consent, below. |
| `marketData.poolingWhenTermsUnknown` | Also pool when the broker's terms on this are not confirmed (every broker today). Your decision; off by default. |
| `live` | `{ "enabled": false, "allowedSources": ["rest"], "registeredIp": "..." }`; see [safety.md](safety.md). Off by default. |
| `limits` | Per-account safety limits that may only be stricter than the global `safety` section. |

`npx mc-bridge accounts list` shows what the Bridge read. `npx mc-bridge doctor` checks the file.

## 2. Log in

Credentials never go in the config file. They go to the encrypted SecretStore (`data/secrets.enc`, AES-256-GCM)
through `POST /v1/accounts/{id}/session`, which answers only on this computer and needs an admin key.
The dashboard's **Log in** button (Accounts page) shows the fields your broker needs and calls it for you;
`mc-bridge accounts connect <accountId>` does the same in a terminal.

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

**Morning login.** On the Accounts page, "Morning login" opens one sheet that lists every account that needs a login
today (and any whose session the broker ends before the 15:30 close), says how each one logs in (session login, one-time
code, OAuth link or access token), and takes you through them one at a time with a progress count. You type each login as
usual; the Bridge still never logs in for you or keeps a code. Skip an account to leave it for later.

**Reminder.** On trading days at `morningLogin.remindAt` (default `08:45` IST) the Bridge emits one `account.login_needed`
event per account that needs a login, and again `warnBeforeEndMinutes` (default 30) before a session that ends before the
close. The event names the account by its label and how it logs in; it never carries a key or code. Notification
channels subscribe to it by name.

```json
"morningLogin": { "enabled": true, "remindAt": "08:45", "warnBeforeEndMinutes": 30 }
```

**One session per app.** For brokers whose documentation allows only one session per app key (the XTS family), logging in
again ends the first session, for example one open in another tool. The login sheet warns about it first, and
`GET /v1/brokers` marks these with `singleSession: true`.

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
  can serve the request), or several accounts when pooling is on for them (see below).
- A key limited to some accounts (`--accounts`) is served only by those accounts. If none of them can answer, it gets an
  error, or, when the read allows backup sources, a labelled delayed answer from a data source; it never borrows another
  account's data or request budget.
- Orders always name their account. Portfolio reads (positions, holdings, funds, orders) are per account.

## 6. Pooling needs your consent

Pooling spreads read-only market-data calls (quotes, option chains, history) over several of **your own** accounts, so
each account's request limit is used. It is off by default. An account takes part only when it opts in
(`marketData.pooling`), names its `holder`, its broker's policy does not say `not-allowed`, **and you have accepted the
pooling notice for it**. The notice says in plain words that no broker's published terms clearly allow pooling and none
clearly forbids it, and that you are responsible for your brokers' terms. Accepting is a deliberate step:

- the dashboard shows the notice on the Sources page, with the accounts that could pool, and asks you to accept it;
- or from this computer with an admin key: `GET /v1/pooling` shows the notice and the accounts, `PUT /v1/pooling/consent`
  accepts it for the accounts you name, `DELETE /v1/pooling/consent` turns pooling off on the next read.

Only accounts of one holder are ever pooled together. Orders, positions, funds and other account data are never pooled:
they always use the account they belong to, from its own registered IP. Full details, the paid data plans some brokers
need, and what `mc-bridge doctor` checks are in [rate-limits.md](rate-limits.md).

## 7. Data beyond your accounts

Your broker accounts are the only real-time source. The Bridge can also read from free data sources and plugins you
switch on, and labels every answer from them as delayed or end of day. They never answer orders, risk checks, paper
fills or alerts. See [sources.md](sources.md).
