"""Candles: python3 examples/history.py [symbol] [interval] [how many]     for example:  python3 examples/history.py NSE:RELIANCE 5m 20
The Bridge splits long ranges across the broker's limits by itself; you ask for the range you want."""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from bridge import Bridge, explain  # noqa: E402

symbol, interval, count = (sys.argv[1:] + ["NSE:RELIANCE", "1d", "5"][len(sys.argv) - 1 :])[:3]
IST = timezone(timedelta(hours=5, minutes=30))
try:
    answer = Bridge().get("/v1/history", {"symbol": symbol, "interval": interval, "countback": int(count)})
    data = answer["data"]
    f = data.get("freshness") or answer.get("meta", {}).get("freshness") or {}
    print(f"{data['symbol']} {data['interval']}: {len(data['candles'])} candles ({f.get('class', 'unknown class')}, from {f.get('source', 'unknown')})")
    for c in data["candles"]:
        t = datetime.fromtimestamp(c["time"], IST).strftime("%d %b %Y %H:%M")
        print(f"{t:<18} O {c['open']}  H {c['high']}  L {c['low']}  C {c['close']}  V {c['volume']}")
    if data.get("partial"):
        print("The answer is partial: the broker could not give the whole range. Ask for a shorter range or try again.")
except Exception as err:  # noqa: BLE001
    print(explain(err), file=sys.stderr)
    sys.exit(1)
