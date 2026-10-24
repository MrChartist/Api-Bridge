# Charts: the UDF datafeed

The Bridge serves a TradingView UDF-compatible datafeed under `/udf`. Full route table and rules:
[integrations/charts/README.md](../../integrations/charts/README.md).

```bash
K="Authorization: Bearer $READ_KEY"
curl -H "$K" http://127.0.0.1:4300/udf/config
curl -H "$K" "http://127.0.0.1:4300/udf/symbols?symbol=NSE:NIFTY"
curl -H "$K" "http://127.0.0.1:4300/udf/history?symbol=NSE:NIFTY&resolution=5&countback=300&to=$(date +%s)"
```

- Resolutions `1 3 5 10 15 30 60 1D 1W 1M`; Unix seconds; `from` inclusive, `to` exclusive; `countback` wins over
  `from`; `no_data` with `nextTime` across gaps.
- Sessions in `Asia/Kolkata` (`0915-1530` for NSE, BSE, NFO and BFO; MCX and CDS defaults need verification and can
  be set in `integrations.udf.sessions`).
- Errors keep their HTTP status and use the UDF shape `{ "s": "error", "errmsg": "...", "code": "..." }`, including a
  missing or bad key, so a chart never mistakes an error for data.
- Every read goes through the streaming-first cache and the rate limiter.

## Keys

Use a read key in the `Authorization` header. Libraries that cannot send headers may use `?key=` with a read-only
key created with `--allow-query`:

```bash
npx mc-bridge keys create --label charts --scope read --allow-query
```

`?key=` is refused for any key that can place orders.

## Lightweight Charts (free, Apache 2.0)

[integrations/charts/lightweight-charts.html](../../integrations/charts/lightweight-charts.html) draws candles from
`/udf/history` and keeps the last bar live from the WebSocket. Serve it from an origin listed in
`cors.allowedOrigins`. The example config allows `http://localhost:5180` for it (5173 is Vite's
default), so from the `integrations/charts` folder run `python -m http.server 5180 --bind 127.0.0.1` and open
<http://localhost:5180/lightweight-charts.html>. The page loads the pinned library with an SRI `integrity` hash, so a
changed CDN file is refused. Keep TradingView's attribution.

## TradingView Advanced Charts

Advanced Charts is licensed by TradingView separately (as far as we know, not for personal or private projects:
needs verification). If you hold a licence, point its `UDFCompatibleDatafeed` at `http://127.0.0.1:4300/udf` and add
the key as an `Authorization` header through the adapter's request hook (version dependent: needs verification). The
adapter appends paths to its base URL, so `?key=` cannot be put in the base URL. Nothing in this repository includes
Advanced Charts.
