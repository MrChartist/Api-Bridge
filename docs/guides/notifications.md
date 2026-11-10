# Notifications: how the Bridge tells you things

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

The Bridge listens to its own events (orders, tickets, the kill switch, broker sessions, webhook alerts, safety limits,
data sources) and turns the ones you chose into short plain messages. Today the way to receive them is
**Telegram**: see the step-by-step [Telegram guide](telegram.md). This page is the reference: how a message travels, the
settings, and the routes.

## How a message travels

```
event on the Bridge's bus
  -> is this event switched on?                         (PUT /v1/notify/events, defaults in the table of telegram.md)
  -> same text a moment ago? count it, do not send       (dedupe, 60 s)
  -> a burst of the same kind? first at once, rest merged (one digest line, 20 s)
  -> quiet hours? hold it, send with the others later    (critical events skip this)
  -> outbox: a file on disk, bounded, survives restart
  -> pacing: one chat about once a second, a group under 18 a minute, the bot under 20 a second
  -> Telegram sendMessage, plain text
       failure: retry with growing pauses; "slow down" from Telegram: wait exactly that long;
       a bad token or a blocked chat: stop, say so in plain words
```

Nothing here can change what the Bridge does: notifications only observe. If Telegram is down, orders, prices and safety
checks are unaffected.

Delayed, end-of-day and unofficial data never feed alerts or orders. A `/price` answer shows such data only with its
label (see [sources.md](sources.md)).

## Settings

Everything has a default. `bridge.config.json`, section `notify` (all optional):

```json
"notify": {
  "enabled": true,
  "events": { "order.placed": true, "hook.stale": false },
  "quietHours": { "enabled": false, "start": "22:00", "end": "07:00" },
  "morning": { "enabled": true, "at": "08:45", "secondAt": "09:10", "endOfDay": { "enabled": false, "at": "15:45" } },
  "coalesceSeconds": 20,
  "dedupeSeconds": 60,
  "rateLimitAlert": { "threshold": 20, "windowMinutes": 10 },
  "pacing": { "perChatMs": 1100, "perSecond": 20, "groupPerMinute": 18 },
  "retry": { "maxAttempts": 6, "baseMs": 2000, "maxMs": 300000, "maxAgeMinutes": 60 },
  "queue": { "max": 200 },
  "inbound": { "enabled": true, "commandsPerMinute": 10, "pollSeconds": 25, "allowKill": true, "maxCommandAgeSeconds": 120 }
}
```

| Setting | Meaning |
|---|---|
| `events` | Event key to on or off. Keys are in the table of [telegram.md](telegram.md). What you save in the dashboard wins over the file. |
| `quietHours`, `morning` | Times are IST, 24-hour `"HH:MM"`. `morning.enabled` and `morning.endOfDay.enabled` only choose where the two reminder switches start. `morning.at` (and `secondAt`) set when the Telegram reminder goes; they are **separate** from `morningLogin.remindAt` in [accounts.md](accounts.md#3-sessions), which sets when the `account.login_needed` event is emitted. Changing one does not change the other. |
| `coalesceSeconds`, `dedupeSeconds` | Burst window and duplicate window. `0` switches that off. |
| `rateLimitAlert` | The "many requests are slowed by rate limits" message is sent once when `threshold` slowed requests happen within `windowMinutes`. |
| `pacing` | Telegram's documented limits are one message per second per chat, 20 a minute to a group, about 30 a second for a bot. These defaults stay under them. They are settings because Telegram may change them. |
| `retry` | Tries, first pause, longest pause, and how old a message may get before it is dropped instead of sent late. |
| `queue.max` | The outbox holds at most this many messages. |
| `inbound.enabled` | Switch off to stop listening for commands (alerts still go out). |
| `inbound.allowKill` | Whether `/kill` can turn the kill switch on. Releasing from Telegram is never possible. |

The bot token and the chat ids are **not** settings: they are entered on this computer (dashboard, or `mc-bridge notify
telegram setup`) and kept encrypted.

## Files

All under the data folder, `notify/` (mode 0600, written atomically): `outbox.json` (messages waiting), `state.json` (what
Telegram last said, poll position, reminders already sent, today's counters), `settings.json` (the events you chose).
The token and chat ids are in the encrypted secret store (`secrets.enc`), names `notify:telegram:<id>`. If `outbox.json`
cannot be read it is moved aside as `outbox.json.corrupt-<time>` and the Bridge starts with an empty outbox.

## Routes

All need an admin key. Everything that changes something or sends a message is **this computer only**; the three reads
(`status`, `targets`, `events`) are admin only. No response contains a token or a chat id: only a token hint (four
characters), the bot name, a chat name, the last four digits of a chat id and a short chat key. Full shapes are in
[openapi.yaml](../openapi.yaml) (tag Notifications).

| Route | Does |
|---|---|
| `GET /v1/notify/status` | Queue depth, last delivery, last error per target (plain words), counters, quiet hours, next reminder |
| `GET /v1/notify/targets` | Bots and their chats, masked |
| `POST /v1/notify/targets` | `{ "token": "..." }`: checks it with Telegram, stores it encrypted. The same bot with a new token replaces the token |
| `DELETE /v1/notify/targets/{id}` | Forget the bot, its token, its chats and its queued messages |
| `POST /v1/notify/targets/{id}/test` | Send a test message; reports delivery per chat |
| `POST /v1/notify/targets/{id}/find-chat` | Chats that wrote to the bot recently, to confirm |
| `POST /v1/notify/targets/{id}/chats` | `{ "ref" }` (from find-chat) or `{ "chatId", "name" }`, optional `commands` |
| `PATCH` / `DELETE /v1/notify/targets/{id}/chats/{key}` | Allow or stop commands from a chat / remove it |
| `GET` / `PUT /v1/notify/events` | The events with labels and whether each is on / change them, quiet hours and reminder times |

Terminal: `mc-bridge notify telegram setup | remove <id>`, `mc-bridge notify status`, `mc-bridge notify test`. `mc-bridge
doctor` reports Telegram truthfully: not set up, set up but never delivered (unverified), delivering (with the time), or
cannot send (with the reason). It makes no network call; it reports what the running Bridge last saw.

## For module authors: events the notify module listens to

Bus topics (`server/bridge/core/eventBus.mjs`): `order.updated`, `order.outcome_unknown`, `orders.drift` (the read-only order-book check), `ticket.prepared`,
`safety.kill_switch`, `safety.limit`, `account.status`, `trading.readiness` (when `notify: true`), `limits.throttled`,
and `hook.rejected`, `hook.stale`, `hook.failed` for a webhook alert that was accepted with 202 and then did not become an
order (payload: `label`, `hookId`, `source`, `reason`, optional `symbol` and `side`). A module can also queue its own
message with `deps.notify.publish({ key, text, group })`; it goes through the same switches, dedupe and quiet hours. A
payload must never carry a secret; messages are scrubbed anyway.
