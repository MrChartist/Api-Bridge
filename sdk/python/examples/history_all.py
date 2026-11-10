"""Candles over a long range, with local-first reads to save API calls.

    python history_all.py [SYMBOL] [INTERVAL] [FROM]

The Bridge answers from data it already stored (realtime class, no gaps) and asks the broker only for the rest.
Parquet is written only when pyarrow is installed (pip install pyarrow); nothing else needs it.
"""

import sys

from mrchartist_bridge import Bridge
from mrchartist_bridge.frames import parquet_available

symbol = sys.argv[1] if len(sys.argv) > 1 else "NSE:RELIANCE"
interval = sys.argv[2] if len(sys.argv) > 2 else "5m"
start = sys.argv[3] if len(sys.argv) > 3 else "2024-01-01"
bridge = Bridge()

candles = bridge.history_all(symbol, interval, start, local_first=True)
n = sum(1 for _ in candles)                      # fetched window by window, oldest first, no duplicates
print(n, "candles in", candles.calls, "calls;", candles.local_windows, "from the Bridge's disk,", candles.broker_windows, "from the broker")
print("label:", candles.freshness.data_class, "from", candles.freshness.source, "(partial)" if candles.partial else "")

print(candles.to_csv().splitlines()[0])         # the freshness columns travel with the data
if parquet_available():
    print("wrote", candles.to_parquet(symbol.replace(":", "-") + "_" + interval + ".parquet"))
