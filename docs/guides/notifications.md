# Notifications: Telegram, Discord, Slack and webhooks

Get Bridge events on your phone or into your own automations (n8n, Zapier, Make, a script):

| Event | Sent when | Default filter |
|---|---|---|
| `scan.alert` | a [saved scan](scanner.md) finds symbols its previous run did not | always |
| `scan.completed` | a saved scan run finishes | saved scans only |
| `order.updated` | an order changes state | live orders that are filled, rejected or outcome unknown (`orderModes`, `orderStatuses` change it) |
| `safety.kill_switch` | the kill switch is engaged or released | always |
| `account.status` | a broker session expires or errors | expired / error only |
| `limits.throttled` | a broker answered "rate limited" | broker throttles only |
| `option.alert` | a position alert fires (Positions › Alert, or `POST /v1/alerts`) and the alert has "Also send to my notification channels" on | per alert |
| `trading.readiness` | a live account cannot trade (session gone, IP mismatch, daily limit, kill switch), recovers, or is not ready at the 09:00 pre-open check | at most one message per account per 15 minutes for the same reasons; warnings only at 09:00 |

Each target listens to the events you list (default `scan.alert`, `safety.kill_switch` and `trading.readiness`).
`mc-bridge doctor` and the readiness card on the Safety page say when no target listens to `trading.readiness`.

A `trading.readiness` message names the broker and your own account id and label, the reasons and the remedy, for
example **"Dhan dhan-main: cannot trade"** / "The broker session has expired. Automated orders on this account are
paused. Log in again: mc-bridge accounts connect dhan-main, or the Accounts page." It never carries an IP address,
the lookup service, a token or a broker client code. See [deployment.md](deployment.md).

## Telegram

1. In Telegram, talk to **@BotFather**, send `/newbot`, and copy the token it gives you.
2. Send any message to your new bot, then open `https://api.telegram.org/bot<token>/getUpdates` and copy
   `message.chat.id`.
3. Put the token in the environment (never in the config file) and the chat id in the config:

```bash
export MCB_TELEGRAM_BOT_TOKEN=123456:ABC...
```

```json
"notify": {
  "targets": [
    { "id": "phone", "kind": "telegram", "chatId": "123456789", "events": ["scan.alert", "safety.kill_switch", "order.updated", "account.status"] }
  ]
}
```

## Discord and Slack

Create an incoming webhook in the channel settings. The webhook URL is itself a secret, so it goes in the
environment:

```json
{ "id": "team", "kind": "discord", "urlEnv": "MCB_DISCORD_WEBHOOK_URL", "events": ["scan.alert"] },
{ "id": "desk", "kind": "slack",   "urlEnv": "MCB_SLACK_WEBHOOK_URL",   "events": ["scan.alert"] }
```

## Any webhook (n8n, Zapier, your own code)

```json
{ "id": "n8n", "kind": "webhook", "url": "https://n8n.example.com/webhook/bridge", "secretEnv": "MCB_NOTIFY_SECRET", "events": ["scan.alert", "order.updated"] }
```

The Bridge POSTs JSON:

```json
{ "event": "scan.alert", "title": "Scan \"Breakouts\": 2 new match(es)", "text": "New: NSE:TCS, NSE:INFY", "at": "2026-10-27T05:05:00.000Z",
  "data": { "savedId": "saved_…", "name": "Breakouts", "jobId": "scan_…", "newMatches": ["NSE:TCS", "NSE:INFY"] } }
```

With `secretEnv` set, each request carries `X-MCB-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`,
the same scheme the Bridge checks on its own inbound webhooks, so your receiver can prove the message is yours.
Plain `http://` is accepted only for this computer (`127.0.0.1`, `localhost`).

## Delivery

One message at a time per target (Telegram about one a second), 5 s timeout, retries on network errors, 429
(honouring `Retry-After`) and 5xx with back-off up to `maxRetries` (3), and a bounded queue (`queueSize`, 200) that
drops the oldest message rather than grow without limit. Delivery never slows the Bridge down. Notifications are off
in demo mode.

```bash
curl -H "Authorization: Bearer $ADMIN_KEY" http://127.0.0.1:4300/v1/notify                      # targets and counts, no secrets
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  http://127.0.0.1:4300/v1/notify/test -d '{"target":"phone"}'                                  # send a test message
```
