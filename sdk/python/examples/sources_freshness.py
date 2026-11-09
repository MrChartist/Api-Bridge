"""Where data comes from, and what the freshness label lets you do with it.

    python sources_freshness.py
"""

from mrchartist_bridge import Bridge, NotRealtime

bridge = Bridge()

for s in bridge.sources():
    print("%-16s %-8s %-9s delay %s s  official=%s  health=%s" % (s.id, s.kind, s.data_class, s.delay_sec, s.official, s.health_state))

price = bridge.price("NSE:RELIANCE")
f = price.freshness
print("\nRELIANCE %.2f from %s: class=%s delay=%ss official=%s confidence=%s flags=%s" % (price.ltp, f.source, f.data_class, f.delay_sec, f.official, f.confidence, list(f.flags)))

try:
    price.require_realtime()           # raises for delayed, end-of-day, unofficial or stale values
    print("usable for orders, risk checks, paper fills and alerts")
except NotRealtime as e:
    print("not usable for orders:", e)
