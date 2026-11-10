# Running the Bridge on a VPS

For live trading, SEBI's retail algo framework needs orders to come from a **static IP registered with your broker**
(**needs verification** against the circular and your broker's rules; [compliance.md](compliance.md),
[deployment.md](deployment.md)). A small Linux server with a fixed IPv4 address is the most common answer. It also gives
TradingView somewhere to send alerts without a tunnel to your home. This guide is a hardened, ordinary setup: nothing in
it is specific to one hosting company, and every price, region and broker rule is yours to check.

**Status of the recipes.** The files in [`deploy/expose/`](../../deploy/expose/) were checked for syntax only: the systemd
unit with `systemd-analyze verify`, the compose file with `docker compose config`. The Caddyfile and the cloudflared
sample were not run against the real programs. Test each in your own setup, on paper, before real money.

```
   TradingView --HTTPS 443--> Caddy ----> 127.0.0.1:4301  Bridge alerts listener
   you (SSH, over WireGuard if you like) --> 127.0.0.1:4300  Bridge dashboard (never public)
   Bridge ----orders and data----> your broker      (the broker sees THIS server's address: register it)
```

## 1. Choose and prepare the server

- A VPS with a **static public IPv4 address** that stays yours (ask the host whether it can change, for example on a
  rebuild). Low latency to your broker helps; an Indian region is common (**needs verification**: location is a
  preference, not a rule here).
- Ubuntu or Debian LTS, 1 GB RAM is enough for one or two accounts. Node.js 22 or newer.
- Keep the clock right and set the zone: `sudo timedatectl set-ntp true && sudo timedatectl set-timezone Asia/Kolkata`.
  Order times, the 09:00 check and session expiries depend on it.

## 2. Harden it

```bash
# a normal user with sudo, and SSH keys only
adduser you && usermod -aG sudo you
# copy your public key to ~you/.ssh/authorized_keys, then in /etc/ssh/sshd_config:
#   PasswordAuthentication no
#   PermitRootLogin no
sudo systemctl reload ssh

# firewall: deny everything inbound except SSH and HTTPS
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp          # or only from your own address: sudo ufw allow from <your-ip> to any port 22 proto tcp
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp    # Caddy: certificates and alerts. Skip both with a tunnel.
sudo ufw enable

sudo apt install -y unattended-upgrades          # security updates
```

**Never open 4300, 4301 or 4302 in the firewall.** The Bridge listens on `127.0.0.1`; Caddy or a tunnel on the same
server is what the internet talks to. Docker can publish ports around `ufw`: the compose file below uses the host
network and publishes nothing.

Optional, a private way in: install WireGuard and give the SSH port only to the WireGuard address
(`ufw allow in on wg0 to any port 22`). The dashboard still goes through SSH (section 5), because its pages answer
only requests that arrive as this computer itself.

## 3. Install the Bridge

Either systemd (this section) or Docker (section 4).

```bash
sudo apt install -y git curl
# Node.js 22 or newer: install it the way your distribution or nodejs.org describes, then check `node --version`.
sudo useradd --system --home /var/lib/mc-bridge --shell /usr/sbin/nologin mcbridge
sudo git clone https://github.com/MrChartist/api-bridge-v2.git /opt/mc-bridge
cd /opt/mc-bridge && sudo npm ci --omit=dev

sudo install -d -o mcbridge -g mcbridge -m 700 /etc/mc-bridge /var/lib/mc-bridge /var/lib/mc-bridge-secrets
sudo -u mcbridge MCB_HOME=/var/lib/mc-bridge node /opt/mc-bridge/bin/mc-bridge.mjs init --config /etc/mc-bridge/bridge.config.json
```

`init` writes the settings file, a paper account and an admin key (shown once: save it). Then edit
`/etc/mc-bridge/bridge.config.json` so the data and the master key live in the folders the unit owns:

```json
{ "dataDir": "/var/lib/mc-bridge", "masterKeyFile": "/var/lib/mc-bridge-secrets/master.key" }
```

(`init` prints where it put the key: move that file to the path above, or set `masterKeyFile` to where it is.) Keep `server.host` at its default
`127.0.0.1`. Install and start the service:

```bash
sudo cp deploy/expose/mc-bridge.service /etc/systemd/system/    # check the node path on its ExecStart line (which node)
sudo systemctl daemon-reload && sudo systemctl enable --now mc-bridge
sudo systemctl status mc-bridge && journalctl -u mc-bridge -n 30
sudo -u mcbridge MCB_CONFIG=/etc/mc-bridge/bridge.config.json node /opt/mc-bridge/bin/mc-bridge.mjs doctor --strict
```

The unit runs as the `mcbridge` user, restarts on failure, has no extra privileges, a read-only file system except its
own two state folders and `/etc/mc-bridge`, and logs to the journal. Its header says what it expects.

## 4. Or with Docker

[`deploy/expose/docker-compose.yml`](../../deploy/expose/docker-compose.yml) runs the Bridge and Caddy in containers on the
**host network** (so the Bridge sees Caddy as a local proxy and trusts its `X-Forwarded-For`), read-only, without
extra capabilities, with the data and the master key in separate volumes. The Bridge listens on the server's loopback
only, so nothing but Caddy's 80 and 443 faces the internet.

```bash
export DOMAIN=hooks.example.com
docker compose -f deploy/expose/docker-compose.yml up -d --build
docker compose -f deploy/expose/docker-compose.yml logs bridge        # the first admin key, once
docker compose -f deploy/expose/docker-compose.yml exec bridge mc-bridge expose alerts --provider caddy --host "$DOMAIN" --yes
docker compose -f deploy/expose/docker-compose.yml restart bridge
```

The first start of the container makes a paper account and an admin key; add real broker accounts from the dashboard.

## 5. Reach the dashboard (never over the internet)

From your own computer, with an SSH tunnel:

```bash
ssh -L 4300:127.0.0.1:4300 you@your-vps
```

Leave it open and browse to `http://127.0.0.1:4300/dashboard` on your computer. To sign in without typing a key, run
`mc-bridge open` on the server (as the service user, with the same `MCB_CONFIG`): with no browser there it prints a one-time link starting `http://127.0.0.1:4300/dashboard#signin=`;
open that link in your own browser while the tunnel is up. Close the tunnel when you are done.

Why not WireGuard straight to the dashboard? Dashboard pages and every admin or order-confirmation route answer only a
request that reaches the Bridge as **this computer** (a loopback connection to a loopback name). A connection from a
WireGuard address is not that, so it is refused by design. SSH, even over WireGuard, ends on the server's own loopback.

## 6. Let TradingView in

Follow [expose-alerts.md](expose-alerts.md): run `mc-bridge expose alerts --provider caddy --host hooks.example.com`
(as the service user on a systemd install), copy [`Caddyfile.example`](../../deploy/expose/Caddyfile.example) to
`/etc/caddy/Caddyfile`, restart the Bridge, then `mc-bridge expose check --public-url https://hooks.example.com --allow-outbound`.

## 7. Register the static address, and plan changes

1. Find the server's public IPv4 address (your host's control panel shows it; or `curl -4 https://api.ipify.org` on the
   server, which asks that service).
2. Register it in your broker's API settings as the **primary** address (**needs verification**: where and how, per
   broker; most also accept one backup).
3. Put it in the account: `"live": { "enabled": true, "allowedSources": ["rest", "webhook"], "registeredIp": "<address>" }`.
4. Turn on the readiness lookup ([deployment.md](deployment.md), section 4) so the Bridge notices a different address
   within minutes.

**Brokers limit how often the registered address can change** (some allow one change a week; **needs verification** per
broker), and a change may take effect after a delay. So plan it:

| When | Steps |
|---|---|
| You are moving to a new server | Outside market hours. (1) Build and test the new server on **paper**. (2) Register its address as the **backup** with the broker, if the broker has one, and set `live.backupIp`. (3) Wait until the broker shows it as accepted. (4) Switch the DNS record or tunnel to the new server and run the check. (5) Make it the primary when the broker allows, update `live.registeredIp` and `backupIp`. (6) Run `mc-bridge doctor --strict` and look at the readiness badge. (7) Stop the old server. Keep the **kill switch** on while the two overlap so only one Bridge can send orders. |
| The server's address changed by itself | The readiness badge shows `IP_MISMATCH` within about 5 minutes and automated live orders are refused. Engage the kill switch (`mc-bridge kill`), ask the host for the old address back or register the new one (mind the broker's change limit), update `live.registeredIp`, release the kill switch. |
| You rebuild the server | Ask the host to keep the address; take a copy first (section 9). |

Never run two Bridges with live trading on at once: each has its own order counters and daily limits.

## 8. Updating

```bash
cd /opt/mc-bridge
sudo systemctl stop mc-bridge
# take a copy first (section 9), and read CHANGELOG.md for what changed
sudo git pull --ff-only && sudo npm ci --omit=dev
sudo systemctl start mc-bridge
sudo -u mcbridge MCB_CONFIG=/etc/mc-bridge/bridge.config.json node bin/mc-bridge.mjs doctor --strict
```

With Docker: `docker compose -f deploy/expose/docker-compose.yml build --pull && docker compose -f deploy/expose/docker-compose.yml up -d`.
Update outside market hours, then look at the readiness badge and send a paper order.

## 9. Backups

`mc-bridge backup` makes a verified copy of the settings and state (see [backup.md](backup.md): what it holds, the schedule, restore and the
runbooks). Downloads and recordings are left out unless you add `--include-data`. Everything the Bridge keeps is in two places, and they
should be backed up **separately**:

- the **data folder** (`/var/lib/mc-bridge`, or the `bridge-data` volume): keys (hashed), settings of hooks, the audit log
  and the encrypted broker secrets;
- the **master key** (`/var/lib/mc-bridge-secrets/master.key`, or the `bridge-secrets` volume) and `/etc/mc-bridge/bridge.config.json`.

A copy of the data without the key is useless to a thief, and a copy of the key without the data is too; keep them in
different places. For a copy that is consistent, stop the service, copy, start it. Practice a restore on a spare machine
before you need it. Broker sessions are not restored: you log in again.

## 10. Keep an eye on it

- `journalctl -u mc-bridge -f` (or `docker compose logs -f bridge`) for the log; keys never appear in it.
- A daily check from cron or a systemd timer: `mc-bridge doctor --strict` exits 1 when something blocks. Send its output
  by mail or to your own monitor.
- Log in to your broker every morning (the Bridge never automates it) and look at the readiness badge: a forgotten login is
  the most common reason an alert is refused ([deployment.md](deployment.md), section 5).

## Checklist

- [ ] SSH keys only, root login off, firewall allows only 22 (or WireGuard), 80 and 443.
- [ ] `server.host` is `127.0.0.1`; nothing listens publicly except Caddy (`ss -ltnp` shows 4300, 4301, 4302 on 127.0.0.1).
- [ ] `mc-bridge doctor --strict` exits 0; `mc-bridge expose check --public-url ... --allow-outbound` says good.
- [ ] The server's address is registered with the broker and set as `live.registeredIp`; the readiness lookup is on.
- [ ] Live hooks use `requireConfirmation` or a sender allowlist; you tested on paper first.
- [ ] Data and master key are backed up in different places, and a restore has been tried.
