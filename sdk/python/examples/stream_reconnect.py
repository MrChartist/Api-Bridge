"""A live stream that reconnects and re-subscribes by itself.

    python stream_reconnect.py [SECONDS] [SYMBOL ...]

Stop the Bridge and start it again while this runs: the stream waits, reconnects with a fresh token and carries on.
"""

import sys
import time

from mrchartist_bridge import Bridge, FeedStatus, GoAway, OrderUpdate, Tick

seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 15.0
symbols = sys.argv[2:] or ["NSE:NIFTY", "NSE:RELIANCE"]
bridge = Bridge()

end = time.time() + seconds
with bridge.stream(symbols, mode="quote", orders=True, on_gap=lambda want, got: print("gap: expected seq %d, got %d (ticks were conflated)" % (want, got)),
                   on_reconnect=lambda n: print("reconnected (%d)" % n)) as stream:
    for event in stream.events():
        if isinstance(event, Tick):
            print("%-14s %10.2f" % (event.symbol, event.ltp))
        elif isinstance(event, OrderUpdate):
            print("order", event.order_id, event.status)
        elif isinstance(event, FeedStatus):
            print("feed", event.account_id, event.state)
        elif isinstance(event, GoAway):
            print("the Bridge is restarting; reconnecting")
        if time.time() > end:
            break
print("gaps: %d, ticks conflated for this reader: %d, reconnects: %d" % (stream.gaps, stream.conflated, stream.reconnects))
