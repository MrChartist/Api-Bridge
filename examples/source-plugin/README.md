# Example source plugin

A complete, small plugin you can copy. It adds a **15-minute delayed quote** source to the Bridge from a vendor that
does not exist (`quotes.example.com`), so the tests run offline.

| File | What it is |
|---|---|
| `mc-source.json` | The manifest: id, data class, which capabilities, which host it may reach, its limits and terms. |
| `index.mjs` | The plugin: one file, exports the read methods it declares. |
| `fixtures/` | What the vendor answers, for the tests. `conformance.json` says which fixture answers which request. |
| `plugin.test.mjs` | Unit tests with a stub `ctx`, plus the offline conformance run. |

## Try it

```sh
# 1. Read mc-source.json and index.mjs. You are about to run this code.
# 2. Read what you would be granting, and get the pin.
mc-bridge sources plugins pin examples/source-plugin

# 3. Check it (optional). This RUNS the plugin: it validates the manifest, starts the plugin for real in the same restricted
#    process as production, answers every request from fixtures/ and runs the conformance checks. No network.
mc-bridge sources plugins check examples/source-plugin
```

To load a plugin, add it to `bridge.config.json` (after reviewing the manifest and the code):

```json
"sources": {
  "plugins": [
    { "path": "examples/source-plugin", "sha256": "<the pin>", "granted": true }
  ]
}
```

Then restart the Bridge and turn it on: `mc-bridge sources enable example-delayed`. This example points at a placeholder
host, so it will not return real quotes; change `network.allowHosts` and the URLs in `index.mjs` for a real vendor.

## What to copy

- **One file.** The Bridge pins the manifest and the entry file by sha256 and runs exactly those bytes. A plugin cannot
  `import` other local files.
- **Fetch through `ctx.fetch`.** The Bridge makes the request for you, and only to a host in `network.allowHosts`
  (https, no IP addresses, no redirects to elsewhere). There is no `fetch` of your own and no cookies.
- **Pass the vendor's timestamp through** (`at`). A delayed answer stamped "now" would pass for live.
- **Say what went wrong** with `ctx.fail(code, message, retryAfterMs)`: `RATE_LIMITED`, `AUTH`, `NOT_FOUND`,
  `UNAVAILABLE`, `BAD_RESPONSE`, `UNSUPPORTED`. The Bridge decides about retries and failover.
- **Do not throttle yourself.** Put the vendor's documented limits in the manifest; the Bridge enforces them.

The full reference, including the manifest, the wire protocol, the sandbox and its honest limits, is in
[docs/source-contract.md](../../docs/source-contract.md).
