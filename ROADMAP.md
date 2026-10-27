# Roadmap

What we plan to work on after the first public release. Dates are targets, not promises. If something here matters to you, open an issue or a pull request — help is welcome.

## Launch (v0.1.0)

- MIT licence, public repository, contributing guide, code of conduct and security policy.
- 41 Indian brokers for market data, portfolio and paper trading. **Dhan** is verified with a live account; the others are beta.
- Live orders for Dhan (verified), Zerodha and Upstox (beta), behind every safety opt-in.
- Test suite green on a clean clone, `npm audit` clean, CI on every pull request.

## Next few days (v0.1.x)

**Make first use smoother**
- Show the reachable webhook URL (public ingress or tunnel) next to the local one, so Chartink and GoCharting alerts work on the first try.
- Remember the first-run checklist on the server, not only in one browser.
- `mc-bridge kill` while the Bridge is running: work without `--key` from this computer, or explain the flag clearly.
- Account-not-found errors in demo mode suggest `demo-paper`.

**Safety and security hardening**
- Account-limited admin keys can only list, delete and revoke hooks and keys for their own accounts.
- Pin the Docker base image by digest; document that the compose file is the supported way to run in Docker.
- Prompt to rotate the first admin key printed during Docker setup.
- Document clearly that the AI confirmation step does not protect against an agent that can run shell commands on your machine.

**Release plumbing**
- Publish the Node SDK to npm and the Python SDK to PyPI.
- Tagged releases with a changelog and a prebuilt Docker image.
- Run CI on Windows and macOS as well as Linux, on Node 20 and 22.

## Done since launch

- Multi-account work splitting, Yahoo Finance / NSE backup data, the scanner with saved scans and alerts, the
  compat `/api/v1` REST and WebSocket API, and Telegram / Discord / Slack / webhook notifications.

## Next few weeks (v0.2)

**Broker verification programme**
- A "verify your broker" checklist: connect a real account, run a new `mc-bridge doctor --verify` check (to be built), and share an anonymised report.
- Move brokers from beta to verified as reports come in, starting with the most-used: Zerodha, Upstox, Angel One, Fyers, Groww, ICICI Direct, Kotak, 5paisa.
- Record fresh, anonymised fixtures from verified accounts.

**Live orders for more brokers**
- Wire live order mapping for brokers once they are verified, one at a time, each behind the same safety gates.

**Streaming**
- Live feeds for more brokers (currently 14 of 41).

## Later

- A small documentation website built from `docs/`.
- More integrations: Amibroker real-time plugin, NinjaTrader / MetaTrader bridges, more charting platforms.
- Strategy-level risk controls (daily loss limit per strategy, per-symbol exposure caps).
- Translations of the dashboard (Hindi first).

## How to help

- **Use a beta broker?** Try it in paper mode and file a "New broker / broker report" issue with what worked and what didn't.
- **Found a bug?** Open an issue with steps to reproduce.
- **Security issue?** Please report it privately — see [SECURITY.md](SECURITY.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.
