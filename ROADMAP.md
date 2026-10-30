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

**Release plumbing**
- Publish the Node SDK to npm and the Python SDK to PyPI.
- A prebuilt Docker image on each tagged release (the ready-to-run ZIPs are already built per tag).
- Run the full test suite on Windows and macOS as well as Linux (the installers already run there).
- Sign the Windows and macOS downloads, so the one-time "unknown developer" prompt goes away.
- Let the dashboard swap Zerodha/Upstox request tokens for the day's access token, so nobody pastes tokens.

## Done since launch

- Multi-account work splitting, Yahoo Finance / NSE backup data, the scanner with saved scans and alerts, the
  compat `/api/v1` REST and WebSocket API, and Telegram / Discord / Slack / webhook notifications.
- macOS-style dashboard with Motion animations and a ⌘K command palette; a public demo kit for a VPS.
- `mc-bridge kill` works without `--key` on the computer running the Bridge.
- Account-limited admin keys only see and manage keys and hooks for their own accounts.
- Account-not-found errors in demo mode name the demo accounts.
- Docker base images pinned by digest, kept current by Dependabot.
- The MCP guide and SECURITY.md say plainly that AI confirmation does not stop an agent with shell or browser control.
- Docker: `docker compose` documented as the supported way, and the first start asks you to rotate the logged admin key.
- Easy install: one-line installers and ready-to-run ZIPs with Node.js inside, no-question launchers, automatic
  dashboard sign-in, and adding and logging in to brokers from the dashboard.

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

## Terminal plan (Bloomberg-inspired, Indian markets)

Ten research passes looked at what the Bloomberg Terminal does and what free or broker data can supply for NSE and BSE.
Their web evidence was thin (mostly university guides and vendor pages), so the Bloomberg descriptions are a guide, not a
spec, and every NSE, RBI, SEBI or CCIL endpoint named below has to be probed before it is relied on. All exchange and
regulator data is for personal, local use; redistribution needs the exchange's own licence.

**Phase 1: terminal feel (dashboard)**
- Command line grammar `[symbol] [page code]` with a short code on every page, `HELP <code>`, asset-class suffixes
  (`EQ`, `FUT`, `OPT`), back and forward history, and a configurable home page.
- Linked panels: two or three colour groups that share underlying and expiry, building on the shared workspace context.
- Saved layouts with JSON export and import, a dense theme, CSV and copy-as-TSV on every table.

**Phase 2: markets overview**
- Markets home: index strip with India VIX, market summary, movers (one batched quote of the F&O universe).
- Sector heatmap (1D, 1W, 1M), breadth after the close as a cached background job, relative rotation and a correlation
  matrix as labelled proxies (the official rotation formula is closed).
- Configurable monitor grid saved next to watchlists: column picker, sorting, colour rules, rows linked to the workspace.

**Phase 3: derivatives depth**
- Scenario ladder: full-reprice P&L over spot, IV and days, per position and per book.
- Implied forward and carry per expiry from put-call parity, 25-delta risk reversal and butterfly, vol cone with the
  IV-versus-realised spread, event vol around results and expiry.
- SVI surface fit with arbitrage checks, and a risk-neutral density from it (large; after the above).

**Phase 4: risk and portfolio (read-only or plan-only)**
- Margin and exposure summary, concentration, historical VaR and expected shortfall, P&L attribution, a what-if impact
  check, a risk-limits view, and TCA from paper fills. Anything that would place an order stays behind the existing
  gates (live opt-in, human confirmation, kill switch, daily loss limit, rate limits).

**Phase 5: news, calendars and alerts**
- Regulatory wire from the SEBI and RBI feeds, NSE and BSE announcement feed with keyword and watchlist alerts, earnings
  and board-meeting calendar, central-bank dates, F&O ban list changes, and price-level and AND/OR alerts.

**Phase 6: data access**
- A field catalogue and search, `/v1/fields` and `/v1/fields/history`, batch requests, overrides, `=MC.BDP`, `=MC.BDH`
  and `=MC.BDS` for Excel, CSV on every route. A small query language comes last.

**Phase 7: charting and equity pages**
- Chart page with studies, comparison and relative strength, multi-timeframe grid, seasonality, volume profile and OI
  levels on the price chart. Stock snapshot, holders, per-stock deals, corporate actions and index membership.
- Macro: broker-quote strip first (India VIX, USDINR, crude, gold), then forex reserves and FPI flows.

**Not planned**
- Analyst ratings, consensus estimates, standardised fundamentals and ESG data (licensed data).
- Rate-probability tools (WIRP) and a global news wire (no free equivalent).
- A natural-language command bar that calls an outside AI service (the Bridge stays local-first), free-floating
  multi-window layouts, and more than three link colours.

## How to help

- **Use a beta broker?** Try it in paper mode and file a "New broker / broker report" issue with what worked and what didn't.
- **Found a bug?** Open an issue with steps to reproduce.
- **Security issue?** Please report it privately — see [SECURITY.md](SECURITY.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.
