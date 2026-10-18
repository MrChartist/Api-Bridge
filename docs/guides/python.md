# Python

The Python client uses the standard library only (Python 3.9+), including its own small WebSocket client. Full
method list: [sdk/python/README.md](../../sdk/python/README.md).

```bash
pip install ./sdk/python
export MCB_API_KEY=mcb_...                 # a paper key for paper orders, a read key for data only
export MCB_BRIDGE_URL=http://127.0.0.1:4300   # optional; this is the default
```

## Market data

```python
from mrchartist_bridge import BridgeClient, BridgeApiError

bridge = BridgeClient()

r = bridge.ltp(["NSE:NIFTY", "NSE:BANKNIFTY", "NFO:NIFTY-2026-10-27-25000-CE"])
for item in r["data"]:
    f = item["freshness"]
    print(f'{item["symbol"]:40} {item["ltp"]:>10}  {f["source"]:6} {f["ageMs"]} ms{" (stale)" if f["stale"] else ""}')
for e in r.get("errors", []):
    print("not available:", e["symbol"], e["code"])

chain = bridge.option_chain("NIFTY", "2026-10-27", strikes=10)["data"]
candles = bridge.history("NSE:NIFTY", "5m", countback=300)["data"]["candles"]
```

## Paper orders

```python
try:
    res = bridge.place_order({
        "account": "paper", "symbol": "NFO:NIFTY-2026-10-27-25000-CE", "side": "BUY",
        "lots": 1, "product": "MARGIN", "orderType": "LIMIT", "price": 180,
    })
    print(res["data"]["orderId"], res["data"]["status"], "replayed" if res["replayed"] else "new")
except BridgeApiError as e:
    print(e.status, e.code, e.detail)          # e.g. 423 KILL_SWITCH_ACTIVE, 422 INVALID_ORDER
```

Every order write sends an `Idempotency-Key` (a fresh UUID unless you pass `idempotency_key=`), so resending after a
network error never creates a second order. A write that got no reply raises `BridgeConnectionError` with
`outcome_unknown=True` and is never retried automatically: check `orders()` or resend with the same key.

## Live stream

```python
with bridge.stream(["NSE:NIFTY", "NSE:RELIANCE"], mode="ltp", orders=True) as s:
    for msg in s:
        if msg["type"] == "tick":
            print(msg["symbol"], msg["ltp"])
        elif msg["type"] == "order":
            print("order", msg["order"]["orderId"], msg["order"]["status"])
```

## pandas

```python
import pandas as pd
c = bridge.history("NSE:RELIANCE", "1d", countback=250)["data"]["candles"]
df = pd.DataFrame(c)
df["time"] = pd.to_datetime(df["time"], unit="s", utc=True).dt.tz_convert("Asia/Kolkata")
```
