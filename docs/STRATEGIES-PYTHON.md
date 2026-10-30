# Python strategies

Write a trading strategy as a small Python class, put the file in your Bridge's `strategies` folder, and run, stop and
watch it from the dashboard (**Trade › Algo**). Orders are paper by default. Every order a strategy sends goes through
the Bridge's REST order API, so the kill switch, per-order limits, daily limits, the order-rate cap and the paper/live
gates apply to it exactly as they do to any other script.

- SDK: `sdk/python/mrchartist_bridge/strategy.py` (standard library only, Python 3.9+)
- Runner: `server/bridge/strategies/` (module `strategies`, stream S30)
- Examples: `sdk/python/examples/strategies/`
- Page: `server/bridge/dashboard/algo.js` (Trade › Algo, `#/algo`)

## 1. Quick start

1. Start the Bridge (`npm run dev` for the demo with sample prices).
2. Open **Trade › Algo** and press **Add the examples**. The four examples are copied into
   `<Bridge home>/strategies/` (for `npm run dev` that is beside the data folder; the page shows the path).
3. Pick a strategy, choose a paper account, change its settings if you like, and press **Start paper**.
4. Watch the log, the P&L and the orders. Press **Stop** to stop it; the examples close what they hold when stopped.

Python 3.9 or newer must be installed as `python3` (`python` on Windows). Another interpreter, for example a virtual
environment with numpy, can be set in the config file: `"strategies": { "python": "/home/me/venv/bin/python" }`.

## 2. Writing one

```python
from mrchartist_bridge.strategy import Param, Strategy


class MyStrategy(Strategy):
    name = "My strategy"
    description = "Buys the NIFTY ATM call when a 1 minute bar closes up."
    symbols = ["NSE:NIFTY"]          # live ticks for on_tick, bars for on_bar
    timeframes = ["1m"]              # 15s, 30s, 1m, 2m, 3m, 5m, 10m, 15m, 30m, 1h
    timer_seconds = 0                # > 0: on_timer every N seconds
    params = {                       # the form on the Algo page
        "lots": Param(1, min=1, max=10, help="Lots per order"),
        "max_trades": Param(3, min=1, max=20, help="Entries per day at most"),
    }

    def on_start(self): ...                  # once, after its orders from earlier runs today are loaded
    def on_tick(self, quote): ...            # every live tick: quote.ltp, quote.bid, quote["oi"] ...
    def on_bar(self, bar, timeframe): ...    # a finished bar: bar.open, .high, .low, .close, .volume, .time
    def on_order_update(self, order): ...    # one of ITS orders changed (filled, cancelled, rejected)
    def on_timer(self): ...
    def on_stop(self): ...                   # Stop, the kill switch, Bridge shutdown or self.stop()
```

One file holds one `Strategy` subclass (or set `STRATEGY = YourClass` when it has several). Files whose names start
with `_` are never run, so you can keep helpers (`_indicators.py`) beside your strategies and import them.

### Params

`Param(default, min=, max=, choices=, step=, help=, label=)`. The type comes from the default: `Param(1)` is an int,
`Param(0.5)` a float, `Param(True)` a bool, `Param("09:20")` text, `Param("NIFTY", choices=[...])` a choice. Read
them as `self.p.lots`. The page draws a typed form from them and checks each value before the start; the Bridge and the
SDK check them again. Use literal values in `params` (numbers, text, True and False, lists): the Bridge reads them
**without running your file** (Python's `ast`), so the list and the form never execute your code.

### Trading helpers

| Call | What it does |
|---|---|
| `self.buy(symbol, lots=1)`, `self.sell(...)` | One order through `POST /v1/orders`. Keyword arguments: `quantity=` (units instead of lots), `order_type="MARKET"` (or LIMIT, SL, SL-M), `price=`, `trigger_price=`, `product=` (default `self.product`, MARGIN), `validity=`, `tag=`. Returns the order; raises `BridgeApiError` when the Bridge refuses it (the refusal is logged either way). |
| `self.exit(symbol)` | Closes **this strategy's** position in the symbol, never anything else on the account. |
| `self.exit_all()` | Closes every position this strategy holds, shorts first. |
| `self.cancel(order_id)`, `self.cancel_open_orders()` | Cancels its orders. |
| `self.positions()`, `self.position(symbol)` | Net quantity per symbol from its own fills today (all runs). |
| `self.pnl()` | `{"realised", "unrealised", "total", "positions"}` for its own orders today, priced from live ticks or the Bridge. |
| `self.orders()` | Its orders today. |
| `self.ltp(symbol)`, `self.ltps([...])`, `self.quote(symbol)` | Prices: the live tick when fresh, else the Bridge. |
| `self.expiries(u)`, `self.nearest_expiry(u)`, `self.option_chain(u, expiry, strikes=10)` | Option data. |
| `self.oi_analytics(u, expiry)` | The Bridge's OI analytics: PCR (OI, volume, change), max pain, support and resistance. |
| `self.near_future(u)`, `self.history(symbol, interval)` | The nearest future; past candles (the key may not be allowed to read history; see the EMA example). |
| `self.subscribe(symbols)` | Stream more symbols. |
| `self.log.info(...)`, `.warn`, `.error`, `.debug` | Lines that stream to the Algo page's log. |
| `self.stop(reason)` | Stops after the current callback; `on_stop` still runs. |
| `self.account`, `self.mode`, `self.now()` | The account, "paper" or "live", the time in IST. |

`option_parts(symbol)` and `chain_legs(chain)` (in the same module) turn option symbols and chains into
dictionaries. `ConfigError` raised from `on_start` means "these settings cannot work": the strategy fails without being
restarted.

### How a strategy knows its own orders

Every order carries a `clientOrderId` of `A-<id>-<run>-<n>` (the id is the file name: `ema_crossover.py` is
`ema_crossover`). That is how the strategy, the Algo page and its P&L find its orders among everything else on the
account, and how positions carry over when it restarts on the same day. A strategy's positions are its own: `exit_all`
never touches orders placed by hand or by another strategy. On the Algo page a running strategy shows its orders since Start; "Orders today" and "P&L today" cover every run of it today, since positions carry over from one run to the next.

## 3. The examples

| File | What it does | Paper orders in the demo |
|---|---|---|
| `short_straddle.py` | Sells the ATM call and put of the nearest weekly expiry. Exits both when the combined premium rises `stop_loss_pct` (stop loss) or falls `target_pct` (target), or when the IST clock passes `square_off` while it runs. `max_entries` straddles a day. | Two sells at start, two buys on exit or Stop |
| `ema_crossover.py` | Bars of the nearest NIFTY or BANKNIFTY future from live ticks; fast EMA above slow is long, below is short. A cross counts once the fast EMA clears the slow one by `band_pct` (0.02 %), and each side is held `hold_bars` bars (3), so noise around the cross does not flip-flop. `trade = "option"` (default) buys the ATM call or put; `trade = "future"` trades the future, which needs `safety.maxOrderValue` raised (one NIFTY lot is about ₹17 lakh against the default ₹2 lakh, so the Bridge refuses it). Warm-up from history when the key may read it, else from live bars. | An option when the EMAs are ready, a reversal on each cross |
| `iron_condor.py` | Sells a call and a put near `short_delta`, buys wings `wing_width` points out (wings first). Every 10 s it adds up the position delta from the live chain; past `adjust_delta` per lot it rolls the untested side closer, once that side's short option has drifted 0.05 or more below `short_delta`. `max_adjustments` a day. | Four legs at start, two to four per roll |
| `oi_walls.py` | Every 15 s reads `/v1/analytics/oi`. Support is the put strike with the most OI at least `min_gap` points below the spot, resistance the call strike with the most at least `min_gap` above it. PCR at or above `bull_pcr` sells only the put, at or below `bear_pcr` only the call, between them both. A leg is bought back when the spot breaks its wall, on a premium stop loss, or when the PCR no longer wants it. | One or two sells at start, buy-backs on breaks |

The examples are tested against a fake Bridge (`sdk/python/tests/strategy_test.py`) and run end to end against the
demo Bridge (`server/bridge/strategies/strategies.e2e.test.mjs` runs a smaller strategy through the same path).

## 4. Safety model

What the Bridge runs:

- **Only files you put in your own folder.** The strategies folder is `<Bridge home>/strategies` (beside the data
  folder; `strategies.dir` in the config file changes it). Only `<id>.py` files directly in it are listed: no
  sub-folders, no symbolic links, nothing starting with `_` or `.`, at most 512 KB. The web names a strategy only by its
  id; the path is rebuilt from the folder listing, so no request can point the Bridge at any other file.
- **No code from anyone else.** On Linux and macOS the folder and each file must belong to the user running the Bridge
  and must not be writable by other users (`chmod go-w`), so another account on the computer cannot add code to it.
  Files are never fetched or uploaded through the API. **Add the examples** copies only the files shipped in
  `sdk/python/examples/strategies` and never overwrites a file.
- **Listing never runs code.** Names, descriptions and params are read with Python's `ast` (literals only), from the
  SDK's folder rather than the strategies folder, so not even a module there named like the standard library is
  imported.
- **Admin, this computer only.** Every `/v1/strategies` route needs an admin key from loopback. The Bridge still binds
  `127.0.0.1` only.

What a running strategy can do:

- **One key per run.** Each start mints an API key with scope `paper` (or `live`, below) limited to the one account
  you chose, `clientKind: "script"`. It is passed in the child's environment, held only in memory, never written to
  disk or logs, and revoked when the strategy stops, finishes, fails or the Bridge shuts down. A key left over by a
  crash of the Bridge itself is revoked at the next start. (Revoked keys are pruned oldest first when the key file
  nears its 1000-record limit; active keys never are.)
- **A clean environment.** The child gets PATH, HOME, the locale and the variables it needs (`MCB_BRIDGE_URL`,
  `MCB_API_KEY`, `MCB_STRATEGY_*`), never the Bridge's own environment (master key, notification tokens and so on).
- **The Bridge's gates on every order.** Orders go through `POST /v1/orders` with an Idempotency-Key: kill switch,
  per-order lots and value, price band, market-order policy, daily order count and daily loss, the order-rate cap and
  the paper/live decision. A refused order is logged on the Algo page (`Order refused: BUY 20 lots ... INVALID_ORDER`)
  and raised to the strategy; the strategy keeps running. A refusal a restart cannot fix (kill switch, a daily limit, the key's scope or account) that escapes the strategy ends it with exit 4, and it is not restarted. The daily order count also applies to exits: a strategy that reaches it cannot close its legs until the next day (or the limit is raised), so leave room in `safety.dailyMaxOrders` for exits.
- **The kill switch stops every strategy** at once (SIGTERM, so `on_stop` runs; ended after 3 s) and no strategy can
  start while it is on. Its own orders are refused anyway while it is on. **Stop all** on the Algo page stops every
  strategy without touching other tools.
- **Health.** The SDK sends a heartbeat every 5 s from its main loop. No heartbeat for 30 s (60 s before the first)
  means stuck: the process is ended and treated as a crash. A crash restarts after 2 s, then 4 s, then 8 s, up to
  `maxRestarts` (3); then it gives up and the page shows the last error. A strategy that ran for 10 minutes starts its
  restart count again. Exit 0 is "finished", a load or settings error (exit 3) is "failed" without restarts.
- **Logs** are kept in memory (2000 lines per strategy), capped at 200 lines a second.

### Paper and live

Paper is the default and the only mode the dashboard's main button starts. A live start needs **all** of:

1. a second confirmation: the **Start live** dialog asks you to type the strategy id (the API's `confirmLive`);
2. a key with the `live` scope on the request that starts it (the minted key gets `live` only then);
3. `safety.liveTrading: true` in the config file;
4. the account's `live.enabled: true` and `"rest"` in its `live.allowedSources` (strategies send orders over REST);
5. an account that is ready to trade (trading readiness: session, static IP, headroom).

A live start that misses any is refused (`CONFIRMATION_REQUIRED`, `SCOPE_REQUIRED`, `PAPER_ONLY`, `CANNOT_TRADE`); it is
never started as paper instead. Each order is then still decided by the Bridge's own live gates. Live starts are
audited (`strategy.live_confirmed`, `strategy.started`), as are stops and failures.

## 5. Running a strategy by hand

Outside the Bridge a strategy runs like any script, with your own key (paper unless you pass `mode="live"` and your key
and config allow it):

```bash
export MCB_BRIDGE_URL=http://127.0.0.1:4300 MCB_API_KEY=mcb_... MCB_STRATEGY_ACCOUNT=demo-paper
PYTHONPATH=sdk/python python3 -m mrchartist_bridge strategy run sdk/python/examples/strategies/short_straddle.py
PYTHONPATH=sdk/python python3 -m mrchartist_bridge strategy describe sdk/python/examples/strategies/oi_walls.py
```

`MCB_STRATEGY_PARAMS='{"lots": 2}'` sets params. Logs print as plain lines; Ctrl+C runs `on_stop`.

## 6. API

All admin, this computer only (`docs/openapi.yaml`, tag Strategies):

| Route | |
|---|---|
| `GET /v1/strategies` | The folder: each strategy with params, status, account, mode, uptime, heartbeat, restarts, P&L and orders today; skipped files and why |
| `GET /v1/strategies/{id}` | One strategy with its orders and positions today |
| `GET /v1/strategies/{id}/logs?after=<seq>` | Log lines after a sequence number |
| `POST /v1/strategies/{id}/start` | `{ account, mode?, params?, confirmLive? }` |
| `POST /v1/strategies/{id}/stop` | Stop it |
| `PUT /v1/strategies/{id}/settings` | `{ account?, params? }` for the next start |
| `POST /v1/strategies/stop-all` | Stop every strategy |
| `POST /v1/strategies/examples` | Copy the shipped examples into the folder |

Config (file only), all optional:

```json
"strategies": { "enabled": true, "dir": "strategies", "python": "python3", "maxRestarts": 3, "restartBackoffMs": 2000,
                "heartbeatTimeoutMs": 30000, "startTimeoutMs": 60000, "stopGraceMs": 8000, "maxRunning": 10, "logLines": 2000 }
```

## 7. Tests

```bash
pytest sdk/python/tests                                          # SDK and examples against a fake Bridge
npx vitest run server/bridge/strategies server/bridge/dashboard/algo-core.test.mjs
```
