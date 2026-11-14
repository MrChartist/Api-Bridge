"""Save history to files on the Bridge's computer (a download job), then list them.
  python3 examples/download.py [symbol] [interval] [from date]     for example:  python3 examples/download.py NSE:RELIANCE 5m 2024-01-01
Downloads are a newer feature. On a Bridge that does not have them yet this prints a note and ends without an error."""
import os
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from bridge import Bridge, explain  # noqa: E402

default_from = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%d")
symbol, interval, start = (sys.argv[1:] + ["NSE:RELIANCE", "5m", default_from][len(sys.argv) - 1 :])[:3]
bridge = Bridge()
try:
    made = bridge.optional("POST", "/v1/downloads", body={"name": f"starter {symbol} {interval}", "symbols": [symbol], "intervals": [interval], "from": start, "format": "csv"})
    if made is None:
        print("Downloads: This Bridge does not have this feature yet. Update the Bridge and restart it.")
    else:
        job = made["data"]
        print(f"Job {job['id']} is {job['status']}. Waiting for it (Ctrl+C leaves it running on the Bridge)...")
        now = job
        # A pause the user asked for, or one the Bridge made by itself (disk low, login lost), can last: say why and stop waiting.
        while now["status"] in ("queued", "running", "paused"):
            if now["status"] == "paused":
                print(f"  paused ({now.get('reason') or 'unknown'}): {now.get('message') or ''}")
                print("The job stays on the Bridge and continues when the cause is gone. Stopped waiting.")
                sys.exit(0)
            time.sleep(1.5)
            now = bridge.get(f"/v1/downloads/{job['id']}")["data"]
            p = now.get("progress") or {}
            print(f"  {now['status']}: {p.get('done', 0)} of {p.get('total', '?')} done, {p.get('rows', 0)} rows")
        failure = now.get("failure")
        if now["status"] == "failed" and failure:
            print(f"Why: {failure.get('message')}" + (f" Fix: {failure['fix']}" if failure.get("fix") else ""))
        print(f"Finished: {now['status']}. Data class: {now.get('dataClass', 'unknown')}, source: {now.get('source', 'unknown')}.")
        files = bridge.optional("GET", f"/v1/downloads/{job['id']}/files") or {}
        for f in files.get("data", []):
            print(f"  {f['name']}  {f.get('rows', '?')} rows  {f.get('bytes', '?')} bytes")
        print("The files are on the Bridge's computer, under its data folder. Fetch one with GET /v1/downloads/{id}/files/{name}.")
except KeyboardInterrupt:
    print("Stopped waiting. The job keeps running on the Bridge.")
except Exception as err:  # noqa: BLE001
    print(explain(err), file=sys.stderr)
    sys.exit(1)
