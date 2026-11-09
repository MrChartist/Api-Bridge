# Telegram: alerts on your phone, and prices when you ask

The Bridge can send you a short Telegram message when something needs you (an order was rejected, a broker is logged
out, the kill switch went on) and can answer a few **read-only** questions: prices, positions, orders, funds, status.

It needs a Telegram account and a bot you make yourself (two minutes, free). The Bridge talks to Telegram only from this
computer, outward: no port is opened, no tunnel, no webhook.

Set it up in the dashboard: **API, Integrations, Telegram**. Or in a terminal: `mc-bridge notify telegram setup`.

## What it does, and what it never does

| It does | It never does |
|---|---|
| Sends alerts for the events you switch on (table below) | Place, change or cancel an order |
| Answers `/price`, `/positions`, `/orders`, `/funds`, `/status`, `/help` to chats you allowed | Approve an order that is waiting for you |
| Sends a morning reminder when a broker account is not logged in | Create or revoke an API key |
| Lets you turn the **kill switch on** with `/kill` and a one-time code | Release the kill switch (that is only possible on this computer) |

**Why there are no approve buttons.** An order that needs a person is approved with a single-use token, by an admin key,
from this computer. That is on purpose. A Telegram account can be taken over (a SIM swap, a stolen unlocked phone, a
hijacked session), Telegram chats are not end-to-end encrypted by default, and a forwarded message or a stale button
would be enough to confirm real money. So the Bridge tells you in Telegram that an order is waiting, and you approve it
on the computer. Orders from Telegram, from TradingView and from spreadsheets never approve themselves.

## Set it up

### 1. Make a bot with BotFather

1. In Telegram, search for **@BotFather** (the official bot with a blue tick) and press Start.
2. Send `/newbot`.
3. Choose a name (anything, for example "My Bridge") and a username that ends in `bot` (for example `my_bridge_123_bot`).
4. BotFather replies with a **token**: a long text like `123456789:ABC...`. Anyone who has it can control the bot, so
   treat it like a password. If it leaks, send `/token` to BotFather to get a new one.

### 2. Give the token to the Bridge, on this computer

Dashboard: **API, Integrations, Telegram**, paste the token, press **Check and save**. The Bridge asks Telegram whether the
token is real, then keeps it **encrypted on this computer** (the same store as your broker login values). It is never
shown again, never written to a log, and never sent anywhere except to Telegram.

Terminal: `mc-bridge notify telegram setup`. The token is asked for with hidden input; it is never an argument (a
command line stays in your shell history and in the process list). It needs an admin key: `MCB_ADMIN_KEY` in the
environment, or `--key`.

The token can only be entered on this computer. The routes that take it refuse requests from anywhere else.

### 3. Find your chat

A bot cannot write to you until you write to it first.

1. In Telegram, open your new bot and press **Start** (or send any message).
2. In the dashboard press **Find my chat**. The Bridge reads your message and shows the chat's name, its type and the last
   four digits of its id. Press **Use this chat** to confirm.

Only chats you confirm here ever get alerts. A message from any other chat is **ignored without a reply** and only
counted (the status line shows "N messages from other chats ignored"), so a stranger who finds your bot learns nothing.

A **private chat** may also ask for prices and status. A **group** receives alerts but may not ask for anything until you
switch that on (everyone in the group could type commands). In a group the bot only sees commands that name it
(`/price@my_bridge_123_bot NIFTY`) while Telegram's privacy mode is on, which is the default.

### 4. Choose what you get, and send a test

Tick the events you want (the defaults are sensible), then press **Send a test message**. The result says delivered, or what
is wrong, in plain words.

## Which events

All are on or off in the dashboard (or `PUT /v1/notify/events`). Messages are plain text, short, with rupees written the Indian way.

| Event | Default | Example message |
|---|---|---|
| An order is rejected | on | `Order rejected: SELL 5 INFY (live, Dhan Main). Reason: Insufficient margin.` |
| An order's result is not known | on, always sent | `Order result unknown: BUY 1 RELIANCE on Dhan Main. The broker did not confirm it: check your broker. Do not send it again; the Bridge is checking the order book.` |
| An order is filled | on | `Filled: BUY 10 RELIANCE at ₹2,431.50 (paper, Paper).` |
| An order is placed | off | `Order placed: BUY 10 RELIANCE (paper, Paper).` |
| An order needs your approval | on | `An order is waiting for your approval: BUY 10 RELIANCE (about ₹24,315) on Dhan Main. Approve it ON THIS COMPUTER, in the Bridge dashboard, within about a minute. It cannot be approved from Telegram.` |
| The kill switch is turned on | on, always sent | `Kill switch ON (by Telegram): manual. New orders are blocked until you release it on this computer.` |
| The kill switch is turned off | on | `Kill switch OFF. Orders can be sent again.` |
| A broker account is logged out | on | `Dhan Main is logged out. Log in again on this computer, or prices and orders from it stop.` |
| An account cannot trade (or can again) | on | the readiness check's own sentence |
| A webhook alert is rejected | on | `A webhook alert was rejected on "NIFTY scalp" (BUY INFY). Reason: Symbol is not on the hook's allowed list.` |
| A webhook alert arrived too late | on | `A webhook alert arrived too late and was dropped on "NIFTY scalp".` |
| A webhook alert failed after it was accepted | on | `A webhook alert was accepted but its order failed on "NIFTY scalp". Reason: ...` |
| A daily safety limit is reached | on | `Daily loss limit reached on Dhan Main: ₹5,200 against a limit of ₹5,000. New orders on it are blocked for today.` |
| A data source is switched off after failures | on | `Data source NSE end of day is paused after repeated failures. The Bridge tries it again by itself.` |
| Many requests are slowed by rate limits | on | `Rate limits slowed 23 requests in the last 10 minutes. Most of it on Dhan Main (quote). Prices may lag a little; nothing is lost.` |
| Morning reminder to log in | on | `2 accounts are not logged in: Zerodha Main, Dhan Main. Log in on this computer before the market opens at 09:15.` |
| End-of-day summary | off | one line per account: orders, fills, rejections, P&L |

An order whose result is unknown is never called "failed": it may well have reached the exchange. The message says
"unknown, check your broker".

There is no event for backup results: the Bridge has no backup job today.

**What is never in a message:** a bot token, an API key, an order confirmation token, a webhook address, a broker password
or a session value. Every message is scrubbed for anything shaped like those before it is queued, and a test checks it.

### Reminders and quiet hours

- **Morning reminder:** at 08:45 IST on trading days, "N accounts are not logged in" with their names; a second nudge at
  09:10 if they still are. Nothing is sent when everything is logged in, on weekends, or on an exchange holiday (the
  holiday list shipped with the Bridge, `server/bridge/reference/data/holidays.json`; a day it does not know is judged by
  weekday). A special session (Muhurat trading) has its own hours, so no reminder is sent that day. A Bridge started at
  14:00 does not send the 08:45 reminder late. The times can be changed.
- **End-of-day summary:** optional, 15:45 IST: orders, fills, rejections and profit or loss per account, paper and live
  kept apart.
- **Quiet hours:** off by default. When on (for example 22:00 to 07:00 IST), everyday alerts are held and arrive as one
  message when quiet hours end. The kill switch and unknown order results are never held.
- **Bursts:** if ten orders are rejected in a few seconds you get the first one at once, then one line, "9 more (an order is
  rejected) in the last 20 seconds. Latest: ...". The same text again within a minute is counted, not sent.

## Commands

Send these from a chat you switched commands on for. They only read.

| Command | What you get |
|---|---|
| `/price NIFTY RELIANCE` | A price for each symbol, with its **data class and delay**: `NIFTY 24,880.50 (+0.42%) - real-time, 2 s ago`, or `RELIANCE 2,431.50 - delayed 15 min, unofficial`. A bare symbol means NSE; write `BSE:SENSEX` for another exchange. Up to 10 symbols. |
| `/positions` | Open positions per account (paper and live), with profit or loss |
| `/orders` | The latest orders, with plain status words |
| `/funds` | Cash and margin per account |
| `/status` | Which accounts are logged in, whether the kill switch is on, and how the data sources are doing |
| `/help` | The list |
| `/kill` | Turn the kill switch on. The bot replies with a short code; send `/kill 4821` (your code) within 60 seconds. The code works once, three wrong tries cancel it, and it only turns the switch **on**. Open orders are not cancelled. |

A price is never shown without how fresh it is. A delayed, end-of-day or unofficial number carries that word. Those numbers
never feed orders, risk checks, paper fills or alerts: they are for you to read.

Commands are limited to 10 per minute per chat (a setting). A command that waited more than two minutes (the Bridge was
off) is ignored, so an old message never runs later. Every command is written to the audit log with the chat's short key,
never its id.

## The safety stance, in one place

- The bot token and your chat ids are typed on this computer only, stored encrypted, masked everywhere (screens show four
  characters of the token and the last four digits of a chat id), and never logged.
- Alerts go only to chats you confirmed. Commands are answered only to chats you allowed for commands. Everyone else is
  ignored silently and counted.
- Commands read through a read-only key made for this: it can see prices, positions, orders and funds, nothing else.
- The only action from Telegram is **kill switch on**, after a one-time code. Releasing it is not possible from Telegram.
- Telegram sees the text of the messages you ask for (prices, positions, orders). Do not add the bot to a chat with people
  you would not show your positions to. Telegram chats are not end-to-end encrypted.
- The Bridge connects only to `api.telegram.org`, over HTTPS, with certificate checks. There is no setting to point it elsewhere.

## When Telegram is slow or down

Messages wait in a small file on this computer (`notify/outbox.json` in the data folder) and survive a restart. The Bridge
retries with growing pauses (2 s, 4 s, 8 s ... up to 5 minutes, six tries), waits exactly as long as Telegram says when it
asks the Bridge to slow down, never sends to one chat faster than about once a second, keeps a group under 18 messages a
minute and the whole bot under 20 a second, and drops a message that is more than an hour old rather than delivering stale
news. The queue holds at most 200 messages; when full the oldest ordinary one goes first. All of these are settings
(`notify` in `bridge.config.json`, see [notifications.md](notifications.md)).

## Telegram's limits (from Telegram's own documentation)

Checked on 2026-11-09 against Telegram's official pages. Numbers Telegram does not publish are marked.

| Fact | Source |
|---|---|
| One chat: avoid more than **one message per second**; short bursts may pass, but going on eventually gives `429` errors | [Bots FAQ](https://core.telegram.org/bots/faq) |
| A group: no more than **20 messages per minute** | Bots FAQ |
| Broadcasting: about **30 messages per second** across users, unless paid broadcasts are enabled (up to 1000 per second, 0.1 Star per message over the free 30, needs a large balance and audience) | Bots FAQ |
| A flood-control error carries `parameters.retry_after`: the seconds to wait before trying again | [Bot API, ResponseParameters](https://core.telegram.org/bots/api) |
| A group that became a supergroup answers with `parameters.migrate_to_chat_id` | Bot API |
| `sendMessage` text: **1 to 4096 characters** after entity parsing (the Bridge cuts at 4000 and sends plain text, so nothing needs escaping) | Bot API, `sendMessage` |
| `getUpdates` is long polling: `timeout` is the seconds to hold the request, `limit` 1 to 100, `offset` confirms what was read; unread updates are kept at most **24 hours**; it does not work while a webhook is set | Bot API, `getUpdates` |
| A failed request has `ok: false`, a `description` and an integer `error_code`, whose "contents are subject to change in the future" | Bot API |
| Privacy mode is on by default: in groups the bot sees only commands that name it, replies to it and a few more; it sees all messages in private chats | [Bots FAQ](https://core.telegram.org/bots/faq), [Bot features](https://core.telegram.org/bots/features) |
| `/newbot` makes a bot; the token "can be used by anyone to control your bot"; `/token` makes a new one | [Bot features](https://core.telegram.org/bots/features) |
| Chat ids fit in 52 bits; the Bridge keeps them as text | Bot API |

**Not promised by Telegram's documentation** (seen in practice, so the Bridge treats these only as hints and maps them to
plain words): the exact `error_code` and `description` for a rejected token (usually 401), a chat that blocked the bot
(usually 403 "bot was blocked by the user"), another program reading the same bot (409 "Conflict") and an unknown chat
(400 "chat not found"); and that a person must press Start before a bot can write to them. If Telegram changes a wording, the
worst case is the generic message "Telegram refused the request" instead of a specific one; nothing is sent twice because of it.

## Troubleshooting

**It went quiet.** Open the Telegram card or run `mc-bridge notify status`. The health line says why, in plain words:
- *Telegram does not accept this bot token*: BotFather's `/token` gave a new one, or the bot was deleted. Paste the new token (Change token).
- *This chat has blocked the bot*: open the chat and press Start again, or add the bot back to the group. Then send a test.
- *Telegram asked the Bridge to slow down*: it waits by itself; the status shows how long.
- *Could not reach Telegram*: check this computer's internet or VPN. Messages wait and are sent when it is back (up to an hour).
- Nothing is wrong but nothing arrives: check the event is switched on, that quiet hours are not holding it, and that a chat is on the list.

**I am being flooded.** Switch off the chatty events (An order is placed, An order is filled), turn quiet hours on, or raise
the rate-limit alert threshold. A burst already arrives as one digest line. If a webhook sends hundreds of bad alerts, fix the
alert or delete the hook; "A webhook alert is rejected" is merged into digests too.

**The bot does not answer my commands.** Is the chat on the list with commands switched on (private chats are on by
default, groups off)? In a group, address the bot (`/price@my_bridge_123_bot NIFTY`) or make it an admin. Is the command
older than two minutes? Did you send more than 10 in a minute? A chat that is not on the list is never answered, by design.

**"Another program is already reading this bot's messages."** Telegram allows one reader per bot. Another copy of the Bridge,
a script or a webhook is using the same token. Stop it, or make a second bot for the Bridge.

**The token ended up somewhere it should not be** (a screenshot, a chat, a shell history). Send `/token` to BotFather for a
new one, then change it in the Bridge. The old one stops working at once.

**The time is wrong.** Times in the card and the messages are IST. The morning reminder uses the shipped holiday list; if an
exchange holiday is missing, update the Bridge: the list is refreshed with each release.

## Settings

See [notifications.md](notifications.md) for the `notify` section of `bridge.config.json` and the routes.
