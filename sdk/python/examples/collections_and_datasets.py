"""A named list of instruments (a collection), an option universe that follows the market, and a dataset that grows.

    python collections_and_datasets.py
"""

from mrchartist_bridge import Bridge, option_universe

bridge = Bridge()

bridge.collections.create("my-watchlist", ["NSE:RELIANCE", "NSE:TCS", "NSE:INFY"], tags=["watch"])
bridge.collections.create("nifty-near", universe=option_universe("NIFTY", "current-weekly", count=10), description="ATM +/- 10, this week")

res = bridge.collections.resolve("nifty-near")          # recomputed on every call: the ATM moves, the weekly expiry rolls
print(len(res), "symbols;", res.rule)
for w in res.warnings:
    print("  careful:", w)                              # a delayed or missing price is reported, never used silently
print("size estimate:", bridge.collections.estimate("my-watchlist", intervals=["5m"], days=365))

# Downloads and recordings take the collection by name instead of pasted symbols.
job = bridge.downloads.create(collection="my-watchlist", intervals="5m", from_="2024-01-01", dataset="watchlist-5m")
bridge.downloads.wait(job)
bridge.datasets.update("watchlist-5m", wait=True)       # later: only the bars after the last stored one are fetched
print([d.name for d in bridge.datasets.list(tag=None)])
history = bridge.datasets.read("watchlist-5m", "NSE:TCS", "5m")   # from the Bridge's own disk
print(len(history), "bars,", history.freshness.data_class)
