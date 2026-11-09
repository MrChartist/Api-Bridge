# Security policy

The Bridge holds your broker credentials and can place orders, so we take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** ([direct link](https://github.com/MrChartist/api-bridge-v2/security/advisories/new)).

Include what you found, the steps to reproduce it, the version or commit, and what an attacker could do with it. We aim to acknowledge reports within 3 working days and to agree a disclosure date with you once a fix is ready. We are happy to credit you in the advisory.

## Supported versions

Security fixes go into the latest release on the default branch (`main`).

## Scope

In scope, for example:

- Anything that lets someone other than the local user read stored broker credentials or API keys, or place, change or cancel an order.
- Bypassing a safety gate: paper/live mode, key scopes, account limits, the kill switch, webhook signing or IP allowlists, or the confirmation step for AI-prepared orders.
- Secrets leaking into logs, API answers, the dashboard or error messages.
- Cross-site attacks against the local dashboard or API (DNS rebinding, CSRF, XSS).
- A data-source plugin escaping its restrictions: reading the Bridge's files, environment or credentials, reaching a host its manifest does not list, or loading without the pinned hash matching (see [docs/guides/sources.md](docs/guides/sources.md)).

Out of scope:

- Attacks that need someone who can already run commands as you on your computer. Such a person or program can read your files and use the local CLI; see the [safety guide](docs/guides/safety.md).
- Running the Bridge on a public network address after turning off the loopback-only default.
- Bugs in a broker's own API.

## Keeping your setup safe

- Keep the Bridge on `127.0.0.1` (the default). With Docker, use the provided `docker-compose.yml`, which publishes the port on `127.0.0.1` only.
- Give each tool its own API key with the fewest scopes it needs, and revoke keys you no longer use.
- Rotate the first admin key after setup if it was printed into logs (for example `docker compose logs`).
- Keep live trading off until you have tried your setup in paper mode.
- The confirmation step for AI-prepared orders protects against an assistant that only has its MCP tools or API key. It does not protect against one that can run shell commands or control the browser on your computer; give such tools a `read` key only (see [docs/guides/mcp.md](docs/guides/mcp.md)).
