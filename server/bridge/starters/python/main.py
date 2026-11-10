"""Your first call: is the Bridge up, and what is the price of two symbols?   Run it with:  python3 main.py"""
import sys

from bridge import Bridge, explain

bridge = Bridge()
try:
    # 1. Health needs no key. It also says whether you are looking at sample (demo) data.
    health = bridge.get("/v1/health")
    demo = " (demo mode: sample prices, not market data)" if health.get("demo") else ""
    print(f"Bridge {health['version']} is {health['status']}{demo}")

    # 2. Prices need a key with the read scope. Every row says how fresh it is and where it came from.
    answer = bridge.get("/v1/ltp", {"symbols": "NSE:RELIANCE,NSE:NIFTY"})
    for row in answer["data"]:
        f = row["freshness"]
        print(f"{row['symbol']:<14} {row['ltp']:>10}   {f['class']}, from {f['source']}, {f['ageMs']} ms old")
    for e in answer.get("errors", []):
        print(f"{e.get('symbol', '?')}: {e.get('code')} {e.get('message', '')}")
    print("\nIt works. Next: python3 examples/history.py   (candles),  python3 examples/download.py   (data files),  python3 examples/events.py   (live events)")
except Exception as err:  # noqa: BLE001 - a starter: show the message, set the exit code
    print(explain(err), file=sys.stderr)
    sys.exit(1)
