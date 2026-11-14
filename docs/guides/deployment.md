# Deployment: static IP, daily login and the readiness check

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

Paper trading works from any computer and any connection. **Live API orders do not.** This guide explains why, the
ways to give the Bridge a fixed internet address, and how the Bridge's trading-readiness check tells you, before an
order fails, that something is wrong.

Every rule below that comes from SEBI, an exchange or a broker is marked **needs verification**: check it against your
broker's current rules before you rely on it. See also [compliance.md](compliance.md) and [safety.md](safety.md).

## 1. Why it matters

- SEBI's retail algo framework (in force from 1 April 2026; **needs verification**) requires API **orders** to come
  from a **static IP address registered with your broker**: one primary address and, at most brokers, one backup.
  Brokers refuse an API order from any other address.
- Data calls (quotes, chains, positions) generally work from anywhere. Only orders are checked (**needs
  verification** per broker).
- A normal home connection or a mobile hotspot has a **dynamic** address that changes after a router restart, a
  power cut or at the provider's will. From such a connection, live orders will be refused, and you find out only
  when one is.
- Brokers also log API sessions out every day (the "daily logout"; **needs verification** per broker). You log in
  each morning; the Bridge never automates logins or two-factor codes.

## 2. Options for a fixed address

| Option | What you do | Notes |
|---|---|---|
| (a) Static IP from your internet provider | Ask your ISP for a static IPv4 address for your home connection and run the Bridge on your PC | Cost and availability vary by provider and city; ask the ISP |
| (b) A small Linux VPS in India | Rent a server with a static IPv4 address, install the Bridge there ([vps.md](vps.md)), keep it on `127.0.0.1` and reach the dashboard from your own computer with `ssh -L 4300:127.0.0.1:4300 you@your-vps` | Monthly cost is modest at most hosts (**needs verification**); pick an Indian region for low latency |
| (c) A VPN or exit node with a dedicated IP | Route the Bridge's traffic through a VPN that gives you your own fixed exit address | The broker sees the **exit** address, so register that one. Split tunnels can send broker traffic another way: check |

**Never put a public tunnel (ngrok, Cloudflare Tunnel and similar) in front of a Bridge that holds `live` keys.** A
tunnel does not give the broker a fixed address (it is inbound only: orders still leave from the computer the Bridge runs
on), and a tunnel to the main port exposes your API to the internet. TradingView alerts and Google Sheets have their own
narrow public listeners for that, with a wizard and a check: [expose-alerts.md](expose-alerts.md). A hardened server
recipe is in [vps.md](vps.md).

## 3. Register the address with your broker, then tell the Bridge

1. Find your public address on the machine that runs the Bridge (for example, open `https://api.ipify.org` in a
   browser on that machine).
2. Register it in your broker's API settings (the developer or API-key page at Dhan, Zerodha Kite Connect and Upstox;
   **needs verification**: menu names change).
3. Put the same address in `bridge.config.json` for that account:

```json
{
  "id": "dhan-main",
  "broker": "dhan",
  "live": { "enabled": true, "allowedSources": ["rest"], "registeredIp": "203.0.113.10", "backupIp": "203.0.113.11" }
}
```

`mc-bridge doctor` warns about any live-enabled account without `live.registeredIp`.

## 4. Turn on the readiness lookup

The Bridge cannot know its own public address; only an outside service can echo it back. So the check is **off by
default**. Turn it on in `bridge.config.json`:

```json
"readiness": { "egressIp": { "mode": "lookup", "lookupUrl": "https://api.ipify.org" } }
```

- Choose an **IPv4-only** service: brokers register IPv4 addresses, and an answer over IPv6 cannot be compared (the
  check then shows "IP family differs", a warning, not a failure).
- **The service you choose sees your IP address** every time the Bridge asks: once per check, every 4 minutes from
  08:45 to 15:45 IST on trading days. The Bridge keeps the answer in memory only, never writes it to disk, and never
  puts it in notifications, logs or MCP results.
- Its answer can differ from what your broker sees (dual WAN, a VPN split tunnel). The dashboard always says "as seen
  by <service>".
- `"mode": "manual"` with `"manualIp"` records the address you state. It can never notice a change.

## 5. The daily routine and what the badge means

Every page of the dashboard has a **trading-readiness badge** in the toolbar (on phones, a power icon with a dot).
Click it for the detail; the Safety page has the full card, the last changes and a **Check now** button.

| Badge | Meaning |
|---|---|
| Ready | Every live account passed: session, static IP, order headroom, daily limits, kill switch |
| Check: … | Something needs a look but orders can still go (a session that ends before the close, a daily loss limit that is nearly used, the lookup is off) |
| Cannot trade: … | At least one live account would have its orders refused. Automated live orders (webhooks) on that account are refused with `CANNOT_TRADE`; orders you send yourself carry a warning |
| Paper only | No account has live trading on |
| Not checked since … | Outside market hours the Bridge does not call the broker, so the reading gets old by design |

The routine:

1. Log in to each broker in the morning (Accounts page, or `mc-bridge accounts connect <id>`).
2. At **09:00 IST** on trading days the Bridge checks every live account and flags any that is not
   ready on the badge and in `GET /v1/readiness`.
3. During the day it checks every 4 minutes, and at once when a session changes, a broker refuses a session or the
   kill switch moves. A changed address is noticed within 5 minutes.

## 6. Clock

Keep automatic time (NTP) on. Order times, the 09:00 check and session expiries all depend on the clock. With the
lookup on, the readiness card warns when the clock is off by more than 5 seconds.

## 7. Phones

Reach the dashboard from your phone over your own VPN (WireGuard, Tailscale) or an SSH tunnel, never a public tunnel.
The badge works the same on a phone: a power icon with a dot, and a bottom sheet with the detail.

## 8. Troubleshooting

| Reason | What it means | What to do |
|---|---|---|
| `SESSION_EXPIRED`, `SESSION_MISSING`, `SESSION_REJECTED` | The broker session is gone or was refused | Log in again: `mc-bridge accounts connect <id>`, or the Accounts page |
| `SESSION_EXPIRES_SOON` | The broker's stated expiry is before the close | Log in again before it ends |
| `PROBE_FAILED` | A read call to the broker failed (timeout, broker error) | Usually passes by itself; check the broker's status page |
| `IP_MISMATCH` | The looked-up address is not the registered one | Check the connection or VPN; if your address changed for good, register the new one with the broker and in `live.registeredIp` |
| `IP_NOT_REGISTERED`, `IP_INVALID_CONFIG` | `live.registeredIp` is missing or not a valid address | Set it (section 3) |
| `IP_UNCHECKED` | The lookup is off | Turn it on (section 4), or accept that a change is found only when an order is refused |
| `IP_LOOKUP_FAILED` | The lookup service did not answer | Check the URL; choose another service |
| `IP_FAMILY_DIFFERS` | The service answered over IPv6 | Use an IPv4-only lookup URL |
| `CLOCK_SKEW` | This computer's clock is off | Turn on automatic time |
| `DAILY_ORDERS_LOW`, `DAILY_ORDERS_EXHAUSTED` | Few or no orders left today | The count resets at midnight IST |
| `DAILY_LOSS_NEAR`, `DAILY_LOSS_REACHED` | The daily loss limit is nearly or fully used | It resets at midnight IST |
| `KILL_SWITCH` | The kill switch is on | Release it on the Safety page if this was not intended |
| `RATE_CAP_REACHED`, `BROKER_ORDER_BACKOFF` | The order-rate cap is in use, or the broker asked to slow down | Passes within seconds |

Escape hatches, if the check itself gets in the way: `"readiness": { "gateAutomated": false }` turns the refusal of
automated orders into a warning, and `"readiness": { "enabled": false }` turns the checks off.
