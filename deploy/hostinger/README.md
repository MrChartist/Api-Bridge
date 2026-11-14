# Optional recipe: a demo on your own VPS (Hostinger or any Docker server)

> **This is an optional community recipe, not a hosted offering.** The Mr. Chartist API Bridge is software you run on your own computer. The project does not run, host or sell any service, public demo or website, and nothing in the Bridge needs this folder. It is here for someone who wants to show a demo copy of their own on a private VPS they rent and control, behind their own domain. Hostinger is named only as one example of a provider; any server with Docker works. It contains no account, address or credential of anyone; replace the example domain with your own. For your real trading, see [docs/guides/vps.md](../../docs/guides/vps.md).

This folder runs a **public, read-only-in-spirit demo** of the Bridge at your own domain, with HTTPS:

- **demo mode only**: sample prices, no broker, no broker credentials, paper orders only, nothing sent to third parties;
- the dashboard is served to visitors (`server.remoteDashboard`, which the Bridge refuses outside demo mode);
- every API call still needs a Bridge API key, and key management stays "this computer only".

> **Never put your real broker accounts on a public server.** The Bridge is designed to run on your own computer:
> it holds your broker sessions and can place orders, SEBI's retail-algo rules expect orders from your registered
> static IP, and brokers' terms limit API use to you. Use this folder for a demo, a portfolio piece or a test drive.
> For your real trading, run the Bridge at home (`npm start`) or on a VPS reached only through a private tunnel
> (Tailscale, WireGuard, SSH), never on a public address.

## What you need

- A **Hostinger VPS** (KVM 1 is enough). Shared and Cloud web hosting cannot run a long-lived Node.js server with
  WebSockets reliably; use a VPS.
- A domain or subdomain you control, for example `bridge.yourdomain.com`.

## 1. Create the VPS with Docker

In hPanel: **VPS → Create / Reinstall → OS & templates → Ubuntu 24.04 with Docker** (the "Docker" application
template). Note the server's IP address. Log in once with SSH: `ssh root@<server-ip>`.

## 2. Point your domain at it

In hPanel **Domains → DNS / Nameservers** (or wherever your DNS lives) add an **A record**:

| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `bridge` (for bridge.yourdomain.com) | `<server-ip>` | 300 |

Wait until `ping bridge.yourdomain.com` answers with that IP.

## 3. Open the firewall

hPanel **VPS → Security → Firewall**: allow TCP **80** and **443** (and 22 for SSH). Nothing else is needed: the
Bridge port is not published on the server; only Caddy (HTTPS) is.

## 4. Start it

```bash
git clone https://github.com/MrChartist/api-bridge-v2.git
cd api-bridge-v2/deploy/hostinger
export DOMAIN=bridge.yourdomain.com        # every docker compose command below needs it
docker compose up -d --build
docker compose logs bridge                 # copy the admin key printed on the first start (shown only once)
```

Caddy fetches a Let's Encrypt certificate on the first request. Open `https://bridge.yourdomain.com/dashboard`
and paste the admin key.

To give someone a key for the API without sharing your admin key, create one on the server itself (key creation
is refused through the proxy on purpose):

```bash
docker compose exec bridge node /app/bin/mc-bridge.mjs keys create --label visitor --scope read --config /data/bridge.config.json
```

## 5. Update or stop

```bash
cd api-bridge-v2 && git pull && cd deploy/hostinger
export DOMAIN=bridge.yourdomain.com
docker compose up -d --build                                 # update
docker compose down                                          # stop (data volumes are kept)
docker compose down -v                                       # stop and delete the demo data and keys
```

## What is locked down

- Only Caddy is published (80/443). The Bridge listens on the private compose network and answers only to
  `Host: <DOMAIN>`; the browser origin `https://<DOMAIN>` is the only one allowed.
- The Bridge container runs as a non-root user with a read-only filesystem, no Linux capabilities and
  `no-new-privileges`.
- Demo mode cannot load real brokers, live trading is forced off, and no broker secret or master key is used.
- "This computer only" routes (creating keys, confirming AI order tickets, releasing the kill switch) are refused
  through the proxy.
- HTTPS with HSTS from Caddy.
