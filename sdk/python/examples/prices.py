"""Last prices and quotes, each with its freshness label.

    python prices.py [SYMBOL ...]
"""

import sys

from mrchartist_bridge import Bridge

symbols = sys.argv[1:] or ["NSE:NIFTY", "NSE:RELIANCE", "NSE:TCS"]

bridge = Bridge()                       # finds the URL and key; see mrchartist_bridge.discovery
print(bridge.ping())

for q in bridge.quotes(symbols):
    f = q.freshness
    print("%-24s %10.2f  bid %s ask %s  | %s %s, %d ms old%s" % (q.symbol, q.ltp, q.bid, q.ask, f.source, f.data_class, f.age_ms or 0, " (stale)" if f.stale else ""))

result = bridge.ltp(symbols + ["NSE:NO-SUCH-SYMBOL"])
for e in result.errors:                 # symbols that failed do not fail the whole call
    print("not available:", e.symbol, e.code)
