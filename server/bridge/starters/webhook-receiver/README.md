# Webhook receiver starter for the Bridge

A small server that receives signed events from your Bridge at `{{baseUrl}}`, checks the signature and handles each
event once. Use it as the start of anything that should react to the Bridge: a message, a database row, a job.
Node 22 or newer, no packages to install.

## Three steps

1. Start the receiver. It listens on `http://127.0.0.1:4600/events`, this computer only:

   ```bash
   cd {{folder}}
   node receiver.mjs
   ```

2. In a second window, try it without the Bridge. One signed event is accepted, one unsigned event is refused:

   ```bash
   node send-test.mjs
   ```

3. Tell the Bridge to send events to it. Creating a subscription needs an admin key and works from this computer only
   (the Bridge will call the address you give it). Make a short-lived admin key and use it for this one command:

   ```bash
   mc-bridge keys create --label events-admin --scope admin --expires 1d
   MCB_ADMIN_KEY=mcb_... node register.mjs order.updated,download.done
   ```

   Events are a newer feature. If your Bridge does not have them yet, `register.mjs` says so and you can still run steps
   1 and 2.

## The secret

`.env` holds `WEBHOOK_SECRET`, made for you when the project was created. The receiver uses it to check every request,
and `register.mjs` hands the same value to the Bridge once (the Bridge never shows it again). The admin key is never
written to a file here. By default the Bridge calls only `https` addresses; a plain `http` address on this computer works
only if the Bridge's configuration allows loopback targets (see the events part of `docs/guides/developers.md`).

## The rules the receiver follows

| Rule | Why |
|---|---|
| Verify the signature on the raw body before reading it (`verify.mjs`) | Anyone who finds the address can send a request |
| Refuse a timestamp more than 5 minutes off | A copy of a real request cannot be replayed later |
| Answer 2xx first, work afterwards | The Bridge retries anything slower or not 2xx, with growing waits |
| Remember event ids | The same event can arrive twice; handle it once |

The header is `X-MCB-Signature: t=<seconds>,v1=<hex>`, the HMAC-SHA256 of `<t>.` plus the raw body. The same check in
Python is in `docs/guides/developers.md`.

Edit `handleEvent` in `receiver.mjs` to do your own work.
