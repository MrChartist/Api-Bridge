# Charts with the Mr. Chartist API Bridge

## The UDF datafeed

The Bridge serves a TradingView UDF-compatible datafeed at `/udf`:

| Route | Returns |
|---|---|
| `GET /udf/config` | resolutions `1 3 5 10 15 30 60 1D 1W 1M`, search, server time |
| `GET /udf/symbols?symbol=` | symbol info: `ticker` is the canonical Bridge symbol, session in `Asia/Kolkata`, `minmov`/`pricescale` from the tick size, `lot_size` |
| `GET /udf/search?query=&type=&exchange=&limit=` | types `stock`, `index`, `futures`, `option`; exchanges `NSE BSE NFO BFO MCX CDS` |
| `GET /udf/history?symbol=&resolution=&from=&to=&countback=` | `{ s, t, o, h, l, c, v }`, Unix seconds; `no_data` with `nextTime` across gaps |
| `GET /udf/time` | Unix seconds as text |
| `GET /udf/quotes?symbols=` | `{ s, d: [{ s, n, v }] }` |

Rules worth knowing: `from` is inclusive and `to` exclusive; `countback` wins over `from`; daily, weekly and monthly
bars are stamped 00:00 UTC of the trading date; sessions default to 09:15–15:30 for NSE, BSE, NFO and BFO (the MCX and
CDS defaults need verification and can be set in `integrations.udf.sessions`). Every read goes through the Bridge's
streaming-first cache and rate limiter, so charts share your broker budget politely with everything else.

Authentication: `Authorization: Bearer <read key>`. Chart libraries that cannot send headers may use `?key=` with a
read-only key created with `--allow-query`.

### Licences

- **TradingView Lightweight Charts** (Apache 2.0) is free to use, including commercially, with attribution: keep the
  TradingView logo (`layout.attributionLogo`) or a visible link to tradingview.com. Option Hub's own chart should use
  it.
- **TradingView Advanced Charts / Trading Platform** is licensed by TradingView separately and, as far as we know, not
  for personal or private projects (**needs verification**). The UDF feed works with it if you hold your own licence;
  nothing in this repository includes or redistributes it.

## Example page

[`lightweight-charts.html`](lightweight-charts.html) draws a candlestick chart from `/udf/history` and keeps the last
bar live from the WebSocket stream (`POST /v1/stream/token`, then `ws://…/v1/stream?token=…`).

```
cd integrations/charts
python -m http.server 5180 --bind 127.0.0.1
# open http://localhost:5180/lightweight-charts.html, paste a read key, press Load
```

The page's origin must be in `cors.allowedOrigins` (the example config allows `http://localhost:5180`; 5173 is Option Hub's). The key stays
in memory and in this tab's `sessionStorage`; it is sent in a header, never in a URL. The page is read-only.
