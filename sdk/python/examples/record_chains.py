"""Record option chains going forward (brokers give no history for them), by hand and by rule.

    python record_chains.py

Recording uses the Bridge's own real-time data only; it refuses delayed or end-of-day sources.
"""

from mrchartist_bridge import Bridge, option_universe

bridge = Bridge()

rec = bridge.recordings.create("chain", underlying="NIFTY", expiry=bridge.expiries("NIFTY")[0], every_sec=30)
print("recording", rec.id, rec.status)

# Let the Bridge do it every trading day by itself (start and stop at the session, resume after a restart).
bridge.collections.create("index-chains", universe=option_universe("NIFTY", "current-weekly", count=10))
rule = bridge.recordings.rules.create("Index option chains", "chain", every_sec=30, collection="index-chains", keep_days=60)
print("rule", rule.id, "enabled" if rule.enabled else "off", rule.schedule)

for r in bridge.recordings.list():
    print(r.id, r.status, r.rows, "rows,", r.gap_count, "gaps")
