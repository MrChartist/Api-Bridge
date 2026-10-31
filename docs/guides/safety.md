# Safety model

The Bridge is built so that a mistake (a buggy script, a runaway alert, a confused AI assistant, a leaked key) costs
as little as possible. Everything below is on by default.

## Paper first

- Every order, webhook and AI tool is **paper** unless it explicitly asks for live. Each order result says
  `"mode": "paper"` or `"live"`.
- The `paper` account (and paper mode on any account) is a local simulator priced from real market data: ₹10,00,000
  starting capital, fills at the opposite best price or LTP ± slippage, intraday square-off at 15:20 IST, simple margin
  approximations (not a broker's SPAN). `POST /v1/paper/accounts/{id}/reset` starts over.

## Live orders need every one of these

1. `"safety": { "liveTrading": true }` in `bridge.config.json`;
2. the account's `"live": { "enabled": true }`;
3. the request source (`rest`, `webhook`, `mcp` or `cli`) listed in that account's `live.allowedSources`
   (`["rest"]` by default);
4. an API key with the `live` scope (created from this computer only);
5. `"mode": "live"` in the request;
6. human confirmation for AI assistants and for hooks with `requireConfirmation`. "AI assistant" means a key created
   with `--client mcp`, on **every** route (REST included), not only the MCP endpoint; such a key cannot have the
   admin scope, and the client that prepared a ticket can never confirm it;
7. an `Idempotency-Key` header or a `clientOrderId` (a live order without one is refused, so a retry cannot double it);
8. every safety check below.

A request that misses any of them is refused with a clear code, never quietly downgraded. Nothing in the API, the
environment (`MCB_PAPER_ONLY=1` can only tighten), an MCP tool or a webhook can switch live trading on.

### Trading readiness

The Bridge checks every live-enabled account at 09:00 IST on trading days and every 4 minutes from 08:45 to 15:45
IST: broker session (stated expiry plus a cheap read call), this computer's IP against `live.registeredIp` (only when
you turn the lookup on), order-rate and daily headroom, and the kill switch. Each account is `ready`, `warn`,
`cannot_trade`, `paper_only` or `unknown`. `GET /v1/readiness` returns it; the dashboard shows it as a badge on every
page and a card on the Safety page; `get_safety_status` (MCP) includes it.

| Order | While its account is `cannot_trade` |
|---|---|
| Automated live order (webhook; later guards and alert actions) | **Refused** with `CANNOT_TRADE`; no broker call is made. A stale reading is refreshed first (up to 5 s) |
| Live order a person sends (REST, CLI, a confirmed MCP ticket) | Sent through the usual checks, with a `READINESS` warning |
| Paper order | No readiness line (paper never needs the broker session) |

Readiness only adds a refusal or a warning: it never engages the kill switch, cancels or sends anything. Turn the
refusal into a warning with `readiness.gateAutomated: false`. Static IP and the daily login are explained in
[deployment.md](deployment.md).

## Checks on every order (paper and live)

| Check | Default |
|---|---|
| Kill switch | Off. `POST /v1/safety/kill-switch` from any key, with an empty body or `{"reason": "..."}`, stops every new order at once, including orders already waiting in the queue and the remaining parts of a sliced order (checked again right before each is sent). `"cancelOpenOrders": true` needs a `live` key (or admin on this computer) and cancels only orders the Bridge placed, on the accounts that key may use; `"includeExternal": true` (admin on this computer) also cancels orders placed outside the Bridge, such as protective stop-losses. Release: admin key, this computer, `DELETE /v1/safety/kill-switch {"confirm": "RELEASE"}`. `mc-bridge kill` / `mc-bridge kill release` from the terminal, with no key needed on the computer running the Bridge (it reads the owner-only `control.token` the Bridge keeps in its data folder while it runs; the token works only for the kill switch, from this computer). `MCB_KILL_SWITCH=1` or `safety.killSwitchOnStart` engages it at start. |
| Order rate | 5 per second per account (place, modify and cancel all count), taken when the order actually leaves for the broker, so orders that queued behind a broker back-off cannot burst above it. Paper orders are paced at the same rate in their own window. Config cannot set more than 10 (see [compliance.md](compliance.md)). Kept per Bridge account: two entries for the same broker login each get their own cap (**needs verification**: per client, per PAN or per exchange). |
| Daily orders | 100 per account per IST day; an order that passes its checks reserves its place at once (so concurrent requests cannot overshoot), and each slice of a sliced order counts as one |
| Daily loss | ₹10,000 per account per IST day. Paper: realised P&L from the paper engine's fills. Live: the broker's day P&L (realised plus open positions) read before each live order; when it cannot be read the order carries a warning that the limit was not checked |
| Order value | ₹2,00,000. A modify is checked on the order after the change: the new quantity × the new limit (or trigger) price, or × LTP for a market order |
| Lots per order | 10, on every place and every modify (paper and live) |
| Price band | Limit and trigger prices within 3% of LTP, on every place and every modify, paper and live (a live modify without an LTP is refused) |
| Market orders | `protect`: sent as a limit order at LTP ± 2% (or the broker's native protection); `reject`: refused |
| Market hours | Live orders outside NSE/BSE hours are refused; MCX (09:00 to 23:55) and CDS (09:00 to 17:00) by weekday window (**needs verification**, holidays not known); paper orders only warn |
| Unverified live adapters | Live orders on brokers verified only against fixtures (today Zerodha and Upstox) carry a warning on every preview and place |
| Freeze quantity | Orders above the exchange freeze quantity are refused (or sliced, if `orders.sliceAboveFreeze` is on). A modify cannot be sliced, so a change above the freeze quantity is refused |

A modify, paper or live, passes every check in this table on the order as it would stand after the change, except
the daily order count and daily loss (it changes an order already counted). Cancels pass none of them except the order
rate, so risk can always be reduced.

Per-account `limits` may be stricter than the global `safety` values, never looser. `GET /v1/safety` shows today's
counters.

## Idempotency

Send an `Idempotency-Key` header on every write (the SDKs do it for you); live orders without it (or a
`clientOrderId`) are refused. The same key, from the same key holder,
never reaches a broker twice; a repeat returns the first result with `Idempotency-Replayed: true`. A live call that
times out becomes `outcome_unknown`; the Bridge then checks the broker's order book and updates the order. It never
retries an order write blindly.

## Keys

- Format `mcb_<keyId>_<secret>`; only `scrypt(secret)` is stored (`data/keys.json`). The key is shown once.
- Scopes: `read` (data, portfolio, orders list) < `paper` (+ paper orders) < `live` (+ live orders); `admin` (+ keys,
  audit, sessions, hooks, confirmations, kill-switch release), most admin actions from this computer only.
- Effective hierarchy: `admin` implies `read` only, **not** `paper` or `live`. A key can never grant more than it
  holds where it matters: creating a `live` key, or a webhook with `"mode": "live"`, needs a key that has `live`
  itself (an admin key pasted into the dashboard cannot open a live trading path on its own). The CLI, run on this
  computer, is not limited. `key.created` and `hook.created` audit records name the creating key.
- Malformed keys and unknown key ids are refused without any hashing; at most two scrypt checks run at a time, and an
  address that sends 30 bad keys in a minute is refused for the rest of that minute.
- Optional account list and expiry per key. `mc-bridge keys revoke <id>` takes effect on the next request and closes
  the key's open streams.
- `?key=` in a URL only for read-only keys created with `--allow-query` (Excel, AmiBroker).

## Network

- Binds `127.0.0.1`. Binding anything else needs `server.allowNonLoopback: true` in the file, and keys are still
  required everywhere.
- Host header allowlist (blocks DNS rebinding: a web page cannot point its own name at `127.0.0.1` and talk to the
  Bridge). Origin allowlist for browsers (`cors.allowedOrigins`, no wildcard). The dashboard calls its own origin.
- The optional public-ingress listener serves webhook routes only.

## Secrets

- Broker credentials: AES-256-GCM per entry (fresh 12-byte IV per write, entry name as associated data), an HMAC over
  the whole file to catch tampering or rollback, atomic writes. A tampered file is refused, never partly read.
- Master key: `MCB_MASTER_KEY` (base64 of 32 bytes), or `MCB_MASTER_KEY_FILE` / `data/master.key`, created with mode
  `600` on first start; a key file readable by other users is refused. Back it up: without it the saved broker logins
  cannot be read (you can always log in again).
- Keep the master key **out of the data folder**. The default `data/master.key` sits next to `secrets.enc`, so one
  backup, cloud sync or zip of the folder leaks both. Set `MCB_MASTER_KEY_FILE` to, for example,
  `~/.config/mc-bridge/master.key` (Windows: a file under `%APPDATA%` restricted with
  `icacls <file> /inheritance:r /grant:r %USERNAME%:F`; the Bridge cannot check Windows permissions).
  `mc-bridge doctor` warns while they share a folder.
- Passwords, PINs and TOTP codes are used once for a broker login and never stored.

## Audit log

Every key change, login, order step, confirmation, kill-switch action and webhook signal is appended to
`data/audit/YYYY-MM-DD.jsonl` (IST days), redacted and hash-chained. `GET /v1/audit` (admin, this computer) queries it;
`GET /v1/audit/verify` checks the chain.

## Logs

One JSON line per event on stderr. Secret field names, Bridge keys, bearer tokens, JWTs and every decrypted credential
are masked; request bodies are never logged; webhook paths are logged without their tokens.
