# Compliance notes

**Not legal advice.** These notes record how we read the rules that shape the Bridge's design, as of October 2026.
Anything marked **needs verification** must be checked against the primary SEBI, NSE and BSE circulars and each
broker's current notices before you rely on it. The detailed table, with circular numbers, is in
[ARCHITECTURE.md §12](../ARCHITECTURE.md#12-compliance-notes).

## What the Bridge is

Self-hosted, personal software. You run it on your own computer, with your own broker accounts and API keys, for
yourself and the family members SEBI allows. It ships no strategies or signals and hosts nothing for anyone else.

## SEBI retail algo framework

- SEBI's circular SEBI/HO/MIRSD/MIRSD-PoD/P/CIR/2025/0000013 of 4 February 2025 on safer participation of retail
  investors in algorithmic trading, and NSE's implementation standards NSE/INVG/67858 of 5 May 2025. Fully mandatory
  from 1 April 2026 after extensions (SEBI/HO/MIRSD/MIRSD-PoD/P/CIR/2025/108 and /132) (**needs verification**: the
  effective date and any changes after it).
- **Order threshold:** algos not registered with the exchange must stay at or below 10 orders per second per exchange
  segment, measured by the broker; brokers may set lower limits and may count modifications and cancellations
  (**needs verification per broker**). The Bridge's default cap is 5 per second per account, counting every order
  action, and the config cannot exceed 10.
- **Algo IDs:** the broker tags API orders (a generic tag below the threshold). The Bridge never invents tags.
- **Static IP:** API orders must come from a static IP registered with the broker (a primary and an optional
  secondary, changeable only occasionally); data and portfolio calls generally work from any IP (**needs
  verification** against CIR/2025/0000013, NSE/INVG/67858 and your broker's rules). Set `live.registeredIp` (and an optional `live.backupIp`) per account so the Bridge can warn before an order;
  the readiness check compares them with this computer's address when you turn its lookup on. A tunnel to a PC with
  a changing IP cannot place live orders. Ways to get a fixed address: [deployment.md](deployment.md).
- **Daily logout:** API sessions must end before the next trading day (**needs verification** per broker and against
  CIR/2025/0000013). The Bridge follows each broker's expiry, never
  stores TOTP secrets and never automates 2FA.
- **Order types:** plain market and some other order types may be restricted for API orders. The Bridge protects
  market orders by default or refuses them.

## Who may use it

A retail algo may be used by the client, spouse, dependent children and dependent parents (**needs verification**:
the family definition in CIR/2025/0000013 and NSE/INVG/67858). Running the Bridge for
anyone else, hosting it, or selling signals or strategies would likely make the operator an exchange-empanelled algo
provider, and black-box strategies may need Research Analyst registration (**legal review before any hosted
use**).

## Market data

Broker API terms generally allow market data for the account holder's personal use only (for example Kite Connect).
By default the Bridge serves only you, on loopback, has no multi-user mode, and spreads reads across accounts only
when they share one `holder` in your config (a family member is a different user), the calling key may use them, and
the broker's policy entry says pooling is allowed; every broker is treated as not allowed today (**needs
verification per broker**).

### Tunnels and public endpoints

The Bridge itself never opens a public data endpoint, but **you can**. The Google Sheets route
([integrations/google-sheets/README.md](../../integrations/google-sheets/README.md), [excel-sheets.md](excel-sheets.md))
asks you to put a tunnel in front of the main API so Google's servers can fetch prices. Be clear about what that means:

- A tunnel to the main API **is a public endpoint**. Anyone who learns its URL and a key can read your market data,
  positions and orders list. A read key can also engage the kill switch (it cannot cancel orders).
- Your broker's market data then passes through a third party's servers (Google, and the tunnel provider). Broker data
  terms, such as Kite Connect's personal-use clause, may not allow redistribution to, or storage on, third-party
  servers, even for your own sheet (**needs verification per broker**). You carry that risk; if your broker's terms
  do not clearly allow it, use Excel on this computer instead (`/xl/*` over `127.0.0.1`), which needs no tunnel.
- The opt-in public ingress listener for webhooks (`server.publicIngress`) is different: it serves only `/hooks/*`,
  carries no market data out, and is not affected by this note.
- Never share the sheet or the tunnel URL with anyone else: serving data to other people is outside personal use.

## AI assistants

No regulator or broker guidance covers AI agents placing orders. An order an AI places through your key is still your
API order. The Bridge therefore keeps AI read-only by default, requires a person to confirm every AI-prepared order on
this computer, and logs which client prepared it (**gray area**).

## Brokers

Live order paths are wired for Dhan, Zerodha and Upstox; only Dhan has been verified against a live account. The other
adapters are tested against fixtures from each broker's documentation. Rate-limit figures carry a source URL and a
`verified` flag in the policy table.
