# Google Sheets starter for the Bridge

`Code.gs` is the Bridge's Apps Script for Google Sheets: a **Bridge** menu (set up sheets, refresh now, timed refresh)
and the custom functions `BRIDGE_QUOTES`, `BRIDGE_QUOTE`, `BRIDGE_CHAIN` and `BRIDGE_HISTORY`. It is read-only: nothing
in it can place or change an order.

> **Read this first.** Google runs Apps Script on its own servers, so it cannot reach `{{baseUrl}}` on your computer.
> Using Sheets means making the Bridge reachable from the internet through a tunnel you run yourself. That puts price
> data from your broker on a public address, which your broker's terms may not allow, and the risk is yours. If you are
> not sure, use Excel on this computer instead (no tunnel needed). See `docs/guides/expose-alerts.md`.

## Three steps

1. {{keyStep}}
2. Check from this computer that the key and the route work (the script uses the same ones):

   ```bash
   cd {{folder}}
   node check.mjs
   ```

   Then run `mc-bridge expose sheets` and follow it: it sets up a listener that serves only the read-only `/xl` routes.
3. In the sheet: **Extensions > Apps Script**, paste all of `Code.gs`, save. **Project Settings > Script properties**:
   add `BRIDGE_URL` (your tunnel address) and `BRIDGE_KEY` (the key from `.env`). Reload the sheet, then
   **Bridge > Set up sheets** and **Bridge > Refresh now**. Try `=BRIDGE_QUOTES(A5:A30)`.

## The key

{{keyNote}}

Script properties are visible to everyone who can edit the script: share the sheet as view-only, or not at all. The
script sends the key in a header, never in a web address. Do not use the `?key=` address form from Sheets.

`.env` holds the key only so you can copy it into the Script properties and run `check.mjs`. Never commit it.
