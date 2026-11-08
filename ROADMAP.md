# Roadmap

API Bridge v2 is a local connection layer for Indian broker APIs. This file lists the directions the project is open to; day-to-day work is tracked in GitHub issues.

## Open for contribution

- **Broker verification.** Only Dhan is verified with a live account. Trying the other brokers in paper mode and reporting what works helps the most (see [docs/BROKERS.md](docs/BROKERS.md)).
- **Verifying limits and policies.** Rate limits, pooling terms and compliance notes marked "needs verification" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and `server/bridge/ratelimit/brokerPolicies.mjs` need a check against each broker's current documentation.
- **Live order mapping** for more brokers, accepted once the broker has been verified with a live account (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- **Streaming feeds** for brokers that do not declare `feed` yet.
- **OAuth callback routes** (Zerodha, Upstox, Composite Edge), so users do not need to paste tokens.
- **Docs and SDKs:** clearer guides, and client libraries for other languages built on `docs/openapi.yaml`.
