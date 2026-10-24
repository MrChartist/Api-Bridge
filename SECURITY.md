# Security policy

The Bridge holds your broker credentials and can place orders, so we take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** ([direct link](https://github.com/MrChartist/api-bridge/security/advisories/new)).

Include what you found, the steps to reproduce it, the version or commit, and what an attacker could do with it. We aim to acknowledge reports within 3 working days and to agree a disclosure date with you once a fix is ready. We are happy to credit you in the advisory.

## Supported versions

Security fixes go into the latest release on the `main` branch.

## Scope

In scope, for example:

- Anything that lets someone other than the local user read stored broker credentials or API keys, or place, change or cancel an order.
- Bypassing a safety gate: paper/live mode, key scopes, account limits, the kill switch, webhook signing or IP allowlists, or the confirmation step for AI-prepared orders.
- Secrets leaking into logs, API answers, the dashboard or error messages.
- Cross-site attacks against the local dashboard or API (DNS rebinding, CSRF, XSS).

Out of scope:

- Attacks that need someone who can already run commands as you on your computer. Such a person or program can read your files and use the local CLI; see the README's safety model.
- Running the Bridge on a public network address after turning off the loopback-only default.
- Bugs in a broker's own API.

## Keeping your setup safe

- Keep the Bridge on `127.0.0.1` (the default). With Docker, use the provided `docker-compose.yml`, which publishes the port on `127.0.0.1` only.
- Give each tool its own API key with the fewest scopes it needs, and revoke keys you no longer use.
- Rotate the first admin key after setup if it was printed into logs (for example `docker compose logs`).
- Keep live trading off until you have tried your setup in paper mode.
