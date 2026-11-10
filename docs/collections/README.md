# API collections

Import these into Postman or Bruno to try every call of the Bridge without writing code. They are generated from
[`docs/openapi.yaml`](../openapi.yaml), so they list exactly the operations the Bridge serves.

- **187 requests** in 24 folders (one folder per area: System, Accounts, Keys, Instruments, Collections, Market data, Streaming, Events, Portfolio, Orders, Paper, Limits, Sources, Pooling, Quotas, Notifications, Safety, Readiness, Data downloads, Backup, Spreadsheets, Webhooks, AI (MCP), Compat REST).
- Two variables: `baseUrl` (default `http://127.0.0.1:4300`) and `apiKey`. The key is empty in the files: make one with
  `mc-bridge keys create --label postman --scope read,paper` and paste it into your own environment, never into the collection.
- Every request says in its description which scope it needs and whether it works only from this computer.
- Order examples are **paper orders** on the demo paper account (`demo-paper`, from `mc-bridge start --demo`).
  A live order needs the opt-ins in [safety.md](../guides/safety.md); nothing here turns them on.
- Calls that act on something you create (an order id, a key id, a ticket) show a placeholder such as `<orderId>`: replace it.
- Dates such as `expiry` in the examples are samples. Send **Expiries** first and use one of the dates it returns.

## Postman

1. Import `postman/mr-chartist-bridge.postman_collection.json` and `postman/local.postman_environment.json`.
2. Pick the **Local Bridge** environment and set `apiKey` (a secret variable).
3. Start the Bridge (`npm run dev` for demo mode) and send **Health** first.

## Bruno

1. Open the `bruno/` folder as a collection (Open Collection).
2. Choose the **local** environment and fill `apiKey` (a secret variable).

## Regenerating

```bash
node scripts/gen-collections.mjs           # rewrite the files
node scripts/gen-collections.mjs --check   # exit 1 when they are out of date (CI runs this)
```

Do not edit the generated files by hand. Change the OpenAPI document (or the examples in `scripts/lib/examples.mjs`) and regenerate.
