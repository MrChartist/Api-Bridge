# Docker

> `mc-bridge ...` on this page means the command inside the container: `docker compose exec bridge mc-bridge ...` ([running it in other set-ups](README.md#running-mc-bridge)).

The repository has a `Dockerfile` and a `docker-compose.yml`. They run the Bridge in a container on your own computer, reachable on
`127.0.0.1:4300` only. This page says what they do, how to start, where the data lives, how to run commands, back up and upgrade.
It is written from those files and from `docker/entrypoint.sh`; the facts here are checked against them by a test
(`scripts/docker-guide.test.mjs`).

**Status.** The compose file is accepted by `docker compose config`. Nothing in this repository's tests or CI builds and runs the image,
and Docker Desktop on Mac and Windows reaches the container from an address range the Bridge allows by a rule marked in the code as needing
verification (see "The dashboard" below). So treat Docker as a recipe: start in demo mode, then with paper accounts, and test your own
set-up before any real money. Docker is not needed for anything else in this project; the [quickstart](quickstart.md) runs it with Node
directly, and a [hardened server recipe](vps.md) shows Docker behind a proxy.

## Start

From the repository folder:

```sh
docker compose up -d            # builds the image the first time, then starts it
docker compose logs bridge      # the first start prints your admin key, once
```

The first start finds no settings file in the data volume, so the entrypoint runs `mc-bridge init --yes` for you: it writes
`/data/bridge.config.json` with one paper account and **live trading off**, creates the master key, and prints an admin key. Copy that key
from the log; it is not shown again. Then open <http://127.0.0.1:4300/dashboard> in your browser **on this computer** and paste the key.
Once you are in, make a new admin key on the dashboard's keys page (or `docker compose exec bridge mc-bridge keys create --label admin
--scope admin`) and revoke the first, so the one in the log stops working.

For sample prices and no broker, set `MCB_DEMO: "1"` in `docker-compose.yml` (it is `"0"` by default) and run `docker compose up -d`
again. Demo mode serves generated data and never trades live.

`docker compose ps` shows the container (`mc-bridge`); it has a health check that calls `/v1/health` every 30 seconds.

## What the compose file sets up

| Setting | What it does |
|---|---|
| `ports: "127.0.0.1:4300:4300"` | Publishes the port on this computer only. **Never change it to `0.0.0.0`** or drop the address: that would put your API on your network. Every route still needs a key, but a published port is more exposure than you need |
| `volumes: bridge-data:/data` | Everything the Bridge keeps: settings, API keys (hashed), saved broker logins (encrypted), audit log, paper books, orders, downloads, recordings, backups |
| `volumes: bridge-secrets:/secrets` | The master key (`/secrets/master.key`) in a volume of its own, apart from `/data`, so a copy of the data volume does not carry the key |
| `read_only: true`, `tmpfs: /tmp` | The image cannot be changed while it runs; only the two volumes and `/tmp` are writable |
| `cap_drop: [ALL]`, `no-new-privileges` | The container has no extra Linux powers |
| `networks: bridge-net`, subnet `172.31.240.0/24`, gateway `172.31.240.1` | A network of its own with a fixed gateway address (see below) |
| `restart: unless-stopped` | Starts again after a reboot or a crash, until you stop it |

The image is `node:25-alpine` (pinned by digest), the Bridge runs as the unprivileged user `node`, and it installs only the production
packages.

## The dashboard and "this computer only"

Pages like the dashboard and every admin route answer only a request that arrives as *this computer*. Inside Docker your browser's request
reaches the container from the network's gateway, not from loopback. So the first-start settings file lists the gateway
(`172.31.240.1`, and `192.168.65.0/24` for Docker Desktop) under `server.localPeers`, sets `server.host` to `0.0.0.0` inside the container and
turns on `server.allowNonLoopback`. That is safe only because the compose file publishes the port on `127.0.0.1`. If you change the
network's subnet or gateway in the compose file, change `server.localPeers` to match, or the dashboard will refuse you. See
[config.md](config.md#server).

## Running commands in the container

The `mc-bridge` command is in the container. Run it with `docker compose exec`:

```sh
docker compose exec bridge mc-bridge doctor                  # checks settings, keys, disk, calendar, backup
docker compose exec bridge mc-bridge keys create --label me --scope read
docker compose exec -it bridge mc-bridge accounts connect dhan-main      # -it: it asks for fields
docker compose exec bridge mc-bridge kill                     # the kill switch
```

In the guides, `mc-bridge ...` means this. A command that needs a key takes `--key` or `MCB_ADMIN_KEY` as usual. Programs outside the container
(your scripts, Excel) use `http://127.0.0.1:4300` and a key made with `keys create`.

## Add a broker, turn on live trading

Add a broker on the dashboard (**Accounts, Add a broker**): it writes the account to `/data/bridge.config.json`, paper only. Log in from the
Accounts page or with `accounts connect` above.

Live trading is a setting in that file, by design: `safety.liveTrading`, the account's `live.enabled` and the rest of the list in
[orders.md](orders.md#live-orders). Edit the file in the volume, then restart:

```sh
docker compose exec -it bridge vi /data/bridge.config.json
docker compose restart bridge
```

Live orders also need your broker's registered static address. A container on your home computer sends orders from your home connection's address,
which is usually not static: read [deployment.md](deployment.md) first.

## Where things are, logs and the clock

- Logs go to the container's output: `docker compose logs -f bridge`. The log file under `/data/logs` is off in Docker.
- The container's clock should be right (the host's usually is); order times, the morning checks and session expiry depend on it.
- To look inside the data volume: `docker compose exec bridge ls /data`.

## Back up and restore

The data is the `bridge-data` volume. Inside the container:

```sh
docker compose exec bridge mc-bridge backup           # lands in /data/backups inside the volume
docker cp mc-bridge:/data/backups/. ./bridge-backups/   # copy them out, to another disk
```

To restore, stop the service first, then run the restore in a one-off container on the same volume:

```sh
docker compose stop
docker compose run --rm --no-deps bridge mc-bridge restore <path inside the container> --dry-run
docker compose run --rm --no-deps bridge mc-bridge restore <path inside the container>
docker compose up -d
```

A backup never contains the master key; it is in the `bridge-secrets` volume. Back that volume up **separately** and keep it apart from the
data backups. Everything about what a backup holds is in [backup.md](backup.md). `docker compose down -v` deletes both volumes and with them
your keys, saved logins and paper books: do not use `-v` unless you mean it.

## Upgrade

```sh
git pull
docker compose up -d --build
docker compose logs bridge          # look for "Saved a copy of your data before this version runs"
```

The data volume keeps your data, and the first start of a new version copies it to `/data/backups` before anything is read
([upgrading.md](upgrading.md)). Upgrade outside market hours and check **Safety** (readiness) afterwards.

## When it does not work

| You see | Cause and fix |
|---|---|
| `docker compose up` cannot bind `127.0.0.1:4300` | Another program (or a Bridge started with Node) holds the port. Stop it, or change the left-hand port in the compose file (`"127.0.0.1:4301:4300"`) and use 4301 outside |
| The dashboard refuses you or says this is not this computer | The gateway address is not in `server.localPeers`: the subnet in the compose file was changed, or Docker Desktop uses another range. Add the address, restart |
| The admin key scrolled away | `docker compose logs bridge` still has it; or make a new one with `keys create --scope admin` |
| `read-only file system` errors | Something tried to write outside `/data`, `/secrets` and `/tmp`. Keep your files in the volumes |
| The container keeps restarting | `docker compose logs bridge`: usually a settings error ([upgrading.md](upgrading.md#settings-that-a-new-version-no-longer-accepts)) |
| The master key is lost with the `bridge-secrets` volume | Saved broker logins cannot be read; log in again. Keys and paper books are unaffected |
