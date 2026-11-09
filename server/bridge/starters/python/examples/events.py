"""Watch Bridge events as they happen, without polling.   python3 examples/events.py [seconds] [topic,topic]
Events are a newer feature. On a Bridge that does not have them yet this prints a note and ends without an error.
Keep the last event id you handled: reconnect with since=<id> and you get what you missed."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from bridge import Bridge, BridgeError, explain  # noqa: E402

seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 20
topics = sys.argv[2] if len(sys.argv) > 2 else None
try:
    print(f"Listening for {seconds} seconds...")
    for event_id, event, data in Bridge().events("/v1/events/stream", {"topics": topics}, seconds=seconds):
        print(f"{event_id or '-'}  {event}  {data[:120]}")
    print("Done listening.")
except BridgeError as err:
    if err.missing:
        print("Events: This Bridge does not have this feature yet. Update the Bridge and restart it.")
    else:
        print(explain(err), file=sys.stderr)
        sys.exit(1)
except Exception as err:  # noqa: BLE001
    print(explain(err), file=sys.stderr)
    sys.exit(1)
