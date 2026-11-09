# Google Sheets with the Mr. Chartist API Bridge

> **Compliance warning.** A tunnel to the Bridge's main API makes a **public endpoint**, and your broker's market data
> then passes through Google's and the tunnel provider's servers. Broker data terms (for example Kite Connect's
> personal-use clause) may not allow that (**needs verification per broker**); the risk is yours. If you are not sure,
> use Excel on this computer instead (no tunnel needed). See
> [docs/guides/compliance.md](../../docs/guides/compliance.md#tunnels-and-public-endpoints).

**Read this first.** Google Sheets formulas (`IMPORTDATA`) and Apps Script run on Google's servers, not on your
computer, so they cannot reach the Bridge at `127.0.0.1`. Using Sheets means making the Bridge reachable from the
internet through a tunnel you run yourself. Only do this if you understand the trade-off:

- Anyone who learns the tunnel URL and a key can read your market data, positions and orders list through it.
  Put the tunnel behind its own access control (for example an identity-aware proxy on the tunnel) where you can.
- Use a **read-only** key with an expiry, limited to the accounts the sheet needs:
  `mc-bridge keys create --label sheets --scope read --accounts dhan-main --expires 30d`
- Add the tunnel's host name to `server.allowedHosts` in `bridge.config.json`, otherwise the Bridge refuses the
  requests (DNS-rebinding protection). The separate public-ingress listener serves webhooks only and will not
  serve `/xl`. Requests through the tunnel are never treated as "this computer": the dashboard and every admin,
  login and confirmation route refuse them, even with an admin key.
- Broker data terms are generally for personal use; do not share the sheet with other people.

Excel on Windows (see `../excel`) works locally with none of this.

## Apps Script (recommended)

[`bridge.gs`](bridge.gs) adds a **Bridge** menu and custom functions. The full guide is
[docs/guides/excel-sheets.md](../../docs/guides/excel-sheets.md); the tunnel is
[docs/guides/expose-alerts.md](../../docs/guides/expose-alerts.md).

1. *Extensions > Apps Script*, paste `bridge.gs` (the dashboard has a "Copy the Apps Script" button), save.
2. *Project Settings > Script properties*: `BRIDGE_URL` = your tunnel URL, `BRIDGE_KEY` = a read-only key.
3. Reload the sheet. **Bridge > Set up sheets**, then **Bridge > Refresh now**: one request per sheet, however many
   rows. **Bridge > Start timed refresh** refreshes every 5 minutes.
4. `=BRIDGE_QUOTES(A5:A30)` is the same price table in one request, with `as_of`, `age_s`, `class`, `source` and
   `stale` on every row. `=BRIDGE_QUOTE("NSE:RELIANCE","pct")` is one request per cell: use it for one or two values.
   `=BRIDGE_CHAIN(...)` and `=BRIDGE_HISTORY(...)` are unchanged.

The key is sent in an `Authorization` header, never in a URL, so a plain read-only key is enough. Anyone who can edit
the script can read the script properties: share the sheet as view-only, or not at all.

## IMPORTDATA (simplest, least private)

```
=IMPORTDATA("https://your-tunnel.example.com/xl/chain?underlying=NIFTY&expiry=2026-10-27&key=mcb_...")
```

This needs a key created with `--allow-query`, and the key is then visible to everyone who can view the sheet and in
Google's logs. Google refreshes `IMPORTDATA` roughly hourly. Prefer the Apps Script functions.

Everything under `/xl` is read-only: no formula can place an order.
