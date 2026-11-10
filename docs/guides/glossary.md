# Glossary

Short meanings for the words these guides and the dashboard use. The dashboard shows the first group as a small **?** next to the
word; the second group is words the guides use that the dashboard does not mark. *This page is generated from
`server/bridge/dashboard/glossary.js` (run `npm run docs:generate`); change the words there.*

## Words the dashboard explains

- **AFL**: AmiBroker's own formula language.
- **Burst**: A short rush of requests that is allowed at once, before the steady limit applies.
- **CLI**: The command line: typing commands in a terminal window.
- **Data class**: How current a price is: realtime (your broker's live feed), delayed (minutes late) or eod (end of the day). Only realtime data is used for orders.
- **Delayed**: Prices that arrive some minutes after the market. Free sources are often delayed, so they are never used for orders.
- **Endpoint**: One address on the Bridge that answers one kind of question, such as prices or orders.
- **Fallback**: A second source of prices for when your main one cannot answer. It is labelled and never feeds an order (it is not a file backup).
- **Fingerprint**: A short code that identifies a key. The Bridge keeps it instead of the key, so nobody can read your key from it.
- **Hash chain**: A record in which every line depends on the one before it, so any change would show.
- **Idempotency key**: A label sent with an order so that sending it twice only places it once.
- **JSON**: A plain text format that programs use to pass data to each other.
- **Kill switch**: A button that stops every new order from every tool at once. Cancelling orders still works.
- **Latency**: How long an answer takes to arrive.
- **LTP**: Last traded price: the price of the most recent trade.
- **MCP**: A standard way for AI assistants to use tools. The Bridge speaks it, so an assistant can read your data.
- **OAuth**: A login where you approve access on your broker's own website, so you never type your password here.
- **Paper trading**: Practice trading with pretend money. Nothing reaches the market.
- **Pooling**: Your own broker accounts share the work of getting prices. It is off until you accept a notice, and orders never move between accounts.
- **Quota**: A limit on how many requests one key or tool may make. It stops one busy tool from using up everyone's room.
- **Scope**: What a key is allowed to do, such as read prices or place practice orders.
- **SDK**: Ready-made code for a programming language that talks to the Bridge for you.
- **Static IP**: A fixed internet address that your broker has on record. Some brokers accept orders only from it.
- **Throttled**: Held back or slowed down so a tool stays inside its limit.
- **Token**: A secret code that proves who you are, like a password that a program can use.
- **Tunnel**: A secure link that lets a website reach a program on your own computer.
- **Upstream**: The broker or data source the Bridge asks, as opposed to your own tools that ask the Bridge.
- **Webhook**: A web address that one program calls to say something happened. An alert sent to a Bridge hook becomes a practice order unless you chose live trading.
- **WebSocket**: A connection that stays open, so prices arrive as they change and nobody has to keep asking.

## Words the guides use

- **ATM (at the money)**: The strike nearest the current price of the underlying. A collection works it out from a realtime price each time it is resolved, and says so when the price is delayed or stale.
- **Canonical symbol**: The one way the Bridge writes an instrument, whichever broker is behind it: `EXCHANGE:NAME`, such as `NSE:RELIANCE`, and for derivatives `NFO:NIFTY-2026-12-29-FUT` or `NFO:NIFTY-2026-12-29-25000-CE` (the dates here only show the format).
- **CE and PE**: Call (CE) and put (PE): the two kinds of option.
- **Collection**: A named, tagged list of instruments, or an option universe that works out its symbols when you use it. Downloads, recordings, sheets and Python can all use one instead of a pasted list.
- **Control token**: A file in the data folder that lets the command line on this computer do a few things (such as the kill switch) without a key. It works only from this computer.
- **Cursor**: A number that marks your place in the Bridge's event list. Ask for events `since` a cursor to catch up without missing or repeating any.
- **Dataset**: Downloaded history kept under a name. Updating it fetches only the bars after the last stored one.
- **Dead letter**: A webhook delivery that kept failing and was given up on. It is kept in a list so you can retry it or clear it.
- **Demo mode**: `start --demo` runs the Bridge with sample prices made on your computer and one paper account (`demo-paper`). Nothing reaches a broker, and every answer says so.
- **Expiry**: The date a futures or options contract ends. It is part of the symbol (`YYYY-MM-DD`). A contract that has expired is `SYMBOL_NOT_FOUND`, so list live ones with `GET /v1/expiries`.
- **Freshness**: The label on every price: where it came from (`source`), how old it is (`ageMs`), whether it is `stale`, and its data class. Read it before you trust a number.
- **HMAC signature**: A code made from a message and a shared secret. A receiver recomputes it to check that a webhook came from the Bridge and was not changed on the way.
- **Ingress and egress**: Ingress is traffic coming in to the Bridge from outside, which is off unless you open the separate webhook or Sheets listener. Egress is the internet address your broker sees when the Bridge calls out.
- **Loopback**: The address `127.0.0.1`, which only this computer can reach. Admin actions work only from there, even when a tunnel forwards other requests.
- **Lot**: The smallest batch a derivative trades in. `lots` counts batches, `quantity` counts units; the safety limit is also in lots.
- **Master key**: The key that encrypts the broker logins the Bridge saves. Keep it outside the data folder and back it up separately; without it saved logins cannot be read (you can log in again).
- **Product (CNC, INTRADAY, MARGIN, MTF)**: How an order is held. `CNC` is delivery shares, `INTRADAY` (also written `MIS`) must close the same day, `MARGIN` (also `NRML`) carries a derivative overnight, and `MTF` is margin-funded delivery. The Bridge accepts the common spellings and shows what it used.
- **Readiness**: A check, per live-enabled account, of whether a live order could be sent right now: broker session, registered address, headroom and the kill switch. It never changes anything.
- **Realtime, delayed, eod**: The three data classes. Realtime comes from your own broker's live feed. Delayed arrives some minutes late. Eod is end-of-day data. Only realtime data feeds orders, risk checks, paper fills and alerts.
- **Snapshot**: The latest known price for each symbol you subscribed to, sent first when a stream opens, before the live ticks.
- **SSE (server-sent events)**: A one-way live feed over an ordinary web request. The Bridge uses it for events; a WebSocket is the two-way kind.
- **Stale**: A price older than the Bridge accepts for that kind of data, or from a feed that has gone quiet. It is marked `stale: true` and is never used for an order.
- **Strike**: The price an option is written at. The symbol carries it before CE or PE.
- **Tick**: One price update on a stream. A slow reader may skip some; the newest always arrives.
- **Ticket and confirmation code**: An order that an AI assistant or a hook prepared waits as a ticket until you approve it on the computer running the Bridge. Approving gives a one-time confirmation code that lets exactly that order be sent, once.

More: [the error codes](../api/errors.md), [troubleshooting](troubleshooting.md), the [FAQ](faq.md).
