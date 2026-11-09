"""Candles as a pandas DataFrame with an IST index and freshness columns.

    pip install "mrchartist-bridge[pandas]"
    python history_dataframe.py [SYMBOL] [INTERVAL]
"""

import sys

from mrchartist_bridge import Bridge

symbol = sys.argv[1] if len(sys.argv) > 1 else "NSE:RELIANCE"
interval = sys.argv[2] if len(sys.argv) > 2 else "1d"
bridge = Bridge()

history = bridge.history(symbol, interval, countback=60)
if not history.freshness.is_realtime:
    print("note: this history is %s data from %s; fine for analysis, never for orders" % (history.freshness.data_class, history.freshness.provider or history.freshness.source))

df = history.to_dataframe()
df["sma20"] = df["close"].rolling(20).mean()
print(df.tail(5)[["open", "high", "low", "close", "volume", "sma20", "data_class"]])
print("index timezone:", df.index.tz)
print(history.to_csv().splitlines()[0])   # the same table as CSV text (standard library only)
