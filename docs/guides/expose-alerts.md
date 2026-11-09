# Letting TradingView (and a Google Sheet) reach the Bridge safely

TradingView sends an alert from its own servers, and Google Sheets fetches prices from Google's servers. Neither can
reach a Bridge that listens on `127.0.0.1`. This guide shows how to open **one narrow door** for them without opening
the dashboard, and without breaking the static-IP rule for live orders.

The short version, on the computer that runs the Bridge:

```bash
mc-bridge expose alerts          # asks a few questions, writes the settings, prints what to paste
# restart the Bridge, start the tunnel, then:
mc-bridge expose check --public-url https://hooks.example.com --allow-outbound
```

Related: [webhooks.md](webhooks.md) (hook types and alert messages), [deployment.md](deployment.md) (static IP),
[vps.md](vps.md) (a hardened server), [safety.md](safety.md), [compliance.md](compliance.md).

## 1. The safe layout

The Bridge has up to three listeners. Only the two narrow ones may ever be pointed at by a tunnel or proxy.

```
  TradingView ---HTTPS 443--> [tunnel or proxy] --> 127.0.0.1:4301  alerts listener   POST /hooks/* only
  Google Sheet ---HTTPS 443--> [tunnel or proxy] --> 127.0.0.1:4302  Sheets listener   GET /xl/* only, read-only keys
                                                     127.0.0.1:4300  main listener     dashboard, /v1 API, keys, confirm
                                                                     ^ never reachable from outside
```

| Listener | Setting | Serves | Everything else |
|---|---|---|---|
| Main, port 4300 | `server` | The dashboard, the whole `/v1` API, key and order-confirmation routes | This is yours. Keep it on `127.0.0.1`. |
| Alerts, port 4301 | `server.publicIngress` | `POST /hooks/{source}/{token}` | 404 |
| Sheets, port 4302 | `server.sheetsIngress` | `GET /xl/*` for keys that are read-only | 404 |

What the wizard sets up, and what the check proves:

- A listener answers only to the host names in **its own** `allowedHosts` (plus `127.0.0.1`). A made-up host gets 403.
  The main listener's `server.allowedHosts` is not touched.
- A web page from another site (a browser `Origin` that is not allowed) gets 403.
- The alerts listener refuses a message over 16 KB (413). The Sheets listener takes no body and refuses any method but
  GET.
- The Sheets listener refuses any key with a scope beyond `read` (401) and limits each caller address to 600 requests a
  minute (`server.sheetsIngress.requestsPerMinute`).
- No listener accepts a WebSocket upgrade except where a route is marked public (none are on these two).

### What not to do

- **Do not point a tunnel or proxy at port 4300.** That publishes the API login to the internet. Dashboard pages still
  refuse other computers, but every key you have made would work from anywhere.
- **Do not set `server.host` to `0.0.0.0`** or turn on `server.allowNonLoopback` to "make the tunnel work". A tunnel on
  the same computer reaches `127.0.0.1`.
- **Do not add the tunnel's host name to `server.allowedHosts`** (the main listener). Add it only to
  `server.publicIngress.allowedHosts` or `server.sheetsIngress.allowedHosts`; the wizard does that.
- **Do not use `server.remoteDashboard`** outside a public demo. The Bridge refuses it with real accounts.
- **Do not put the key in a TradingView message.** TradingView says not to put credentials in the message body. The
  secret is in the webhook address; keep that address private.
- **Do not share the Sheets address, the sheet or its key.** Serving your broker's data to other people is outside the
  personal-use terms most brokers have ([compliance.md](compliance.md#tunnels-and-public-endpoints)).
- **Do not leave a quick tunnel running** after a test.

## 2. Where orders come from (the static IP rule)

SEBI's retail algo framework needs live API orders to come from a static IP registered with your broker (**needs
verification** against the circular and your broker's rules; see [compliance.md](compliance.md) and
[deployment.md](deployment.md)). A tunnel is **inbound only**: it carries TradingView's alert to the Bridge. The order
then goes from the Bridge to your broker **from the computer the Bridge runs on**.

```
  Home PC runs the Bridge, tunnel in front        VPS runs the Bridge (+ Caddy or a tunnel)
  TradingView -> tunnel -> Bridge (home PC)       TradingView -> VPS -> Bridge (VPS)
                              |                                           |
                              v                                           v
               broker sees your HOME address              broker sees the VPS's static address
               (changes unless your ISP gave a            register THIS address with the broker
               static IP) = live orders refused           = live orders accepted
```

- **Bridge at home, ordinary home connection:** alerts arrive and paper orders work. Live orders from that connection
  are refused by the broker unless your internet provider gave you a static address and you registered it.
- **A tunnel or forwarder on a VPS pointing at a Bridge on your home PC does not help.** It moves where alerts *enter*,
  not where orders *leave*. The broker still sees your home address, because the Bridge's own calls to the broker go out
  through your home connection. Only a VPN or exit node that carries the Bridge's outbound traffic changes what the broker
  sees ([deployment.md](deployment.md), option c).
- **Bridge on the VPS:** run the Bridge itself on the host that holds the registered address ([vps.md](vps.md)).

Set `live.registeredIp` on each live account so the Bridge's readiness check can warn you before an order fails.
`mc-bridge doctor` warns when a public listener and live trading are both on and that field is empty.

## 3. The three settings that make a listener safe

1. **`allowedHosts`** (on the listener): the exact host names it answers to, for example `["hooks.example.com"]`. No
   wildcards, schemes, ports or paths; the Bridge compares names exactly. A quick tunnel gets a new name each run, so it
   needs a new entry (and a restart) each run.
2. **`hooks.clientIpHeader`** (alerts only): behind a tunnel or proxy on this computer every connection comes from
   `127.0.0.1`. Name the header your tunnel or proxy fills with the caller's address and the Bridge will use it, but
   only when the connection itself comes from this computer, and it reads the **last** entry of `x-forwarded-for`.
   Without it, address-based rules see only `127.0.0.1`.

   | Provider | Header | Source |
   |---|---|---|
   | Caddy | `x-forwarded-for` | Caddy's `reverse_proxy` page: sets or augments it and ignores incoming values (read 2026-11-09) |
   | ngrok | `x-forwarded-for` | ngrok's HTTP docs: adds the client address, appending to an existing value (read 2026-11-09) |
   | Cloudflare Tunnel | `cf-connecting-ip` | **Unverified for Tunnel:** Cloudflare's header page says the edge sends it to the origin and does not mention Tunnel. Test it (section 7) |
   | Plain port forward | none | The Bridge sees the real caller as the connection address |

3. **`hooks.allowSourceIps`** (alerts only): a list of sender addresses; an alert from any other address is refused. It
   is the strongest protection for TradingView, which cannot sign its messages. The wizard offers TradingView's list:

   `52.89.214.238`, `34.212.75.30`, `54.218.53.128`, `52.32.178.7`

   These are the addresses TradingView's help page ([About webhooks](https://www.tradingview.com/support/solutions/43000529348-about-webhooks/),
   read 2026-11-09) lists. TradingView can change them: compare with that page now and then, and replace the list with
   `mc-bridge expose alerts --allow-ips a,b,c` (or edit `hooks.allowSourceIps`). **This list applies to every webhook
   of this Bridge**, including ChartInk and GoCharting hooks, whose senders have other addresses. If you use those too, leave
   the allowlist off here (`--allow-ips none`) and use per-hook `allowSourceIps`, or `requireConfirmation`.

TradingView's own limits, from the same page: it calls only **port 80 and 443**, cancels the call after **3 seconds**,
does not support **IPv6**, needs **2-factor authentication** on your TradingView account, and sends `application/json`
when the message is valid JSON and `text/plain` otherwise. Whether it can send custom headers is not stated there, so do
not depend on it. The Bridge answers an alert immediately (the order is processed after the answer), so the 3 seconds
is spent mostly on the tunnel.

## 4. The wizard: `mc-bridge expose`

```bash
mc-bridge expose                       # asks everything
mc-bridge expose alerts                # TradingView alerts
mc-bridge expose sheets                # Google Sheets
mc-bridge expose status                # what is on, in words
mc-bridge expose check                 # prove that only the intended routes answer (this computer only)
mc-bridge expose off [alerts|sheets]   # turn it off
```

Without questions (for a script or a server):

```bash
mc-bridge expose alerts --provider cloudflare --host hooks.example.com --yes
mc-bridge expose alerts --provider caddy --host hooks.example.com --allow-ips none --yes --check
mc-bridge expose sheets --provider cloudflare --host sheet.example.com --yes
```

| Option | Meaning |
|---|---|
| `--provider` | `cloudflare` (named tunnel), `cloudflare-quick` (testing only), `ngrok`, `caddy`, `port-forward` |
| `--host` | The public host name, for example `hooks.example.com` (a pasted `https://...` address is trimmed to the name) |
| `--port` | The listener's local port (default 4301 for alerts, 4302 for Sheets) |
| `--allow-ips` | `tradingview` (default for alerts), `none`, or a comma-separated list of addresses or IPv4 ranges |
| `--yes` | Ask nothing; fail with a clear message if something needed is missing |
| `--check` | Run the self-check right after writing (the Bridge must already run with the new settings) |
| `--public-url` and `--allow-outbound` | With `check`: also test the public address from this computer |
| `--json` | One JSON object instead of text |

What it writes: the listener (`enabled`, `host`, `port`, `allowedHosts`), `hooks.clientIpHeader` and
`hooks.allowSourceIps` for alerts, and `server.allowNonLoopback` only for a port forward. It keeps everything else in your
file, checks that the result loads before writing, saves the old file next to it as `bridge.config.json.bak-expose`, and
writes atomically. Running it twice changes nothing the second time.

**Restart.** The Bridge reads its settings once, when it starts, and does not reload them. After `mc-bridge expose`
(also after `off`), stop the Bridge (Ctrl+C in its window, or stop the service) and start it again. One restart covers
every change the wizard made. The wizard says so each time.

**Nothing is sent anywhere by the Bridge.** It never contacts TradingView, Google or a tunnel provider. The one outbound
request is the self-check's call to *your own* public address, and only when you pass `--allow-outbound` (the
dashboard never does it).

## 5. Provider recipes

Pick one. In each, run the wizard line first, restart the Bridge, then start the tunnel or proxy.

### A. Cloudflare Tunnel, named (recommended at home)

Needs a free Cloudflare account and a domain on it. The address never changes.

```bash
mc-bridge expose alerts --provider cloudflare --host hooks.example.com
cloudflared tunnel login
cloudflared tunnel create mc-bridge
cloudflared tunnel route dns mc-bridge hooks.example.com
```

Save `~/.cloudflared/config.yml` (use the id `tunnel create` printed; a sample with comments is in
[`deploy/expose/cloudflared-config.example.yml`](../../deploy/expose/cloudflared-config.example.yml)):

```yaml
tunnel: <Tunnel-UUID>
credentials-file: /home/<you>/.cloudflared/<Tunnel-UUID>.json
url: http://127.0.0.1:4301
```

```bash
cloudflared tunnel run mc-bridge
```

The commands are from Cloudflare's "create a locally-managed tunnel" page (read 2026-11-09). To keep it running after a
reboot, use Cloudflare's service install for cloudflared. The tunnel points at **4301**, not 4300.

### B. Cloudflare quick tunnel (first test only)

No account, but the name changes every run.

```bash
cloudflared tunnel --url http://127.0.0.1:4301     # prints https://<random>.trycloudflare.com
mc-bridge expose alerts --provider cloudflare-quick --host <random>.trycloudflare.com --yes
# restart the Bridge
```

Each new run needs the same two steps again. Do not use it for real alerts.

### C. ngrok (reserved domain)

Needs an ngrok account and a reserved domain.

```bash
mc-bridge expose alerts --provider ngrok --host your-name.ngrok.app
ngrok http 4301 --url https://your-name.ngrok.app
```

(`--url` is the current flag; ngrok's page marks `--domain` as deprecated, read 2026-11-09.)

### D. Caddy reverse proxy on a VPS

For the Bridge running on a VPS ([vps.md](vps.md)) with a domain pointing at it.

```bash
mc-bridge expose alerts --provider caddy --host hooks.example.com
sudo cp deploy/expose/Caddyfile.example /etc/caddy/Caddyfile
sudo systemctl edit caddy        # add:  [Service]  then  Environment=DOMAIN=hooks.example.com
export DOMAIN=hooks.example.com && caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

[`deploy/expose/Caddyfile.example`](../../deploy/expose/Caddyfile.example) answers only `POST /hooks/*` from the
TradingView addresses, 404 to everything else, caps the body at 16 KB and points at 4301. It is **untested** against a
real Caddy here: run `caddy validate` first. Open only ports 80 and 443 in the firewall.

### E. A plain port forward on your router (not recommended)

No HTTPS (the secret address travels unencrypted), your home address changes, and the Bridge has to listen on every
network interface. The wizard insists on the TradingView allowlist and refuses Sheets this way.

```bash
mc-bridge expose alerts --provider port-forward --host your-home-name.example.net
```

On the router forward external port 80 (TradingView calls only 80 and 443) to this computer, internal port 4301, TCP,
and nothing else. Never forward 4300. `mc-bridge doctor` will warn about the open listener. Prefer A or D.

## 6. Google Sheets

Sheets formulas and Apps Script run on Google's servers, so they need a public address. **The choice made here:** a
separate, optional, read-only listener (`server.sheetsIngress`, port 4302) that serves only `GET /xl/*`, for keys that are
read-only, with its own host list and request cap. A tunnel to it publishes nothing else. It reuses the same route rules
as the main port (the `/xl` routes and their key checks), refuses every other path and method with 404, and refuses a key
that has any scope beyond `read`. Pointing a tunnel at the main port, which the old Sheets instructions required, would
have exposed the whole API to anyone holding a read key; this does not.

```bash
mc-bridge expose sheets --provider cloudflare --host sheet.example.com
mc-bridge keys create --label sheet --scope read --expires 90d              # header key for Apps Script
# restart the Bridge, point the tunnel (hostname sheet.example.com) at http://127.0.0.1:4302
```

In Apps Script (*Project Settings, Script properties*, see [`integrations/google-sheets`](../../integrations/google-sheets/README.md)):
`BRIDGE_URL` = `https://sheet.example.com` (no slash at the end) and `BRIDGE_KEY` = the read-only key. The key is sent in a
header, not in the address. Use `--allow-query` only if you use `IMPORTDATA`, which puts the key in the address that
everyone who can open the sheet sees, and in Google's logs; `mc-bridge doctor` warns about URL keys with no expiry or one
longer than 90 days.

What is still true: the data passes through Google's and the tunnel provider's servers, and your broker's terms may not
allow that (**needs verification per broker**); the key is readable by anyone who can edit the script; there is no address
allowlist (Google's sending addresses are not something this guide can confirm). Excel on this computer needs none of this.

## 7. Test it

On the computer that runs the Bridge, after the restart and with the tunnel running:

```bash
mc-bridge expose check                                                    # this computer only, no outbound call
mc-bridge expose check --public-url https://hooks.example.com --allow-outbound
```

The first form probes `127.0.0.1` on each listener and confirms: the listener answers; the dashboard, `/v1` routes, keys,
orders, sign-in and spreadsheet routes (or, for Sheets, writes and webhooks) all answer 404; a foreign host name and a
foreign web-page origin get 403; an oversized alert gets 413. The second also looks up the host name and calls your public
address from this computer: it must reach the Bridge (not just the tunnel), the host must be on the list, the port must be
80 or 443, and the dashboard must not answer through it. Each failure comes with the fix. The verdict is **good**, **safe
with notes**, **not working yet** (the rules hold but the address does not reach the Bridge) or **unsafe** (turn the tunnel
off). The dashboard's Expose card (API, Integrations, Webhooks) runs the local part with one button.

Then send a real test: create a **paper** webhook (Dashboard, API, Integrations, Webhooks), paste its address into a
TradingView alert, and trigger it. In the Bridge's log, "hook refused: source address not allowed" means the sender list or
`hooks.clientIpHeader` is wrong for your provider (the quickest way to test the Cloudflare header); a 404 for the webhook
means the token in the address is wrong. Stay on paper until alerts arrive reliably.

## 8. Turn it off

```bash
mc-bridge expose off            # or: off alerts / off sheets
# restart the Bridge, then stop the tunnel or proxy
```

Also delete the webhooks you no longer use (dashboard) and the alerts in TradingView, and revoke the Sheets key
(`mc-bridge keys revoke <keyId>`). The settings stay in the file with `enabled: false`; `mc-bridge expose status` shows
the state.

## 9. What `mc-bridge doctor` checks

`mc-bridge doctor` prints each problem with a one-line **Fix**. `BLOCK` means it leaves the Bridge open to the internet or
makes a safety rule meaningless; `mc-bridge doctor --strict` then exits 1 (use it in a scheduler or monitor).

| Check | Raised when | Blocking |
|---|---|---|
| `expose-bind` | `server.host` is not loopback | with live trading or a public listener |
| `expose-dashboard` | `server.remoteDashboard` is on | outside demo |
| `expose-alerts-open`, `expose-sheets-open` | A public listener is bound to an open address | without a sender allowlist (and always for Sheets) |
| `expose-alerts-hosts`, `expose-sheets-hosts` | Listener on but no host name set | no |
| `expose-alerts-wildcard`, `expose-sheets-wildcard`, `expose-main-wildcard` | A host entry that can never match (`*`, scheme, path) | no |
| `expose-alerts-shared-host`, `expose-sheets-shared-host` | A tunnel host is also on the main listener | with live trading |
| `expose-client-ip` | A local tunnel with no `hooks.clientIpHeader` | no |
| `expose-allowlist` | Public alerts with no sender allowlist anywhere | no |
| `expose-live-alerts` | A live webhook with no `requireConfirmation` | also without any allowlist |
| `expose-static-ip` | A public listener, live trading and no `live.registeredIp` | no |
| `expose-url-keys` | A `--allow-query` key with no expiry or one over 90 days, with Sheets or a non-loopback bind | no |

## 10. When it does not work

| You see | Likely cause | Do |
|---|---|---|
| Check: "Nothing answered on 127.0.0.1:4301" | The Bridge is not running, or runs with the old settings | Start or restart it |
| Public check: the Bridge answered 403 | The host is not on the listener's `allowedHosts` | `mc-bridge expose alerts --host <name>`, restart |
| Public check: something answered, but not the Bridge | The tunnel is down or points at the wrong port | Check the tunnel and that it points at 4301 (or 4302) |
| Public check: name does not resolve | DNS record missing or still spreading | Wait a few minutes; check the record |
| TradingView shows a failed webhook, nothing in the log | Port other than 443/80, 3-second timeout, IPv6-only host, 2FA off | Fix per section 3 |
| Log: "source address not allowed" | The sender list or the client-address header is wrong | Check `hooks.clientIpHeader` for your provider, compare the list with TradingView's page |
| Every alert refused after you enabled the list behind a tunnel | No `hooks.clientIpHeader`, so every caller looks like `127.0.0.1` | Set it (the wizard does) |
| Live alert: `CANNOT_TRADE` | The broker session or the static address is not ready | The readiness badge says why ([deployment.md](deployment.md)) |
