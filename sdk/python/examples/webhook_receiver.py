"""A tiny webhook receiver that checks the Bridge's signature before it trusts a delivery.

    MCB_WEBHOOK_SECRET=... python webhook_receiver.py [PORT]

Register it (from the Bridge's computer, with an admin key; the URL must be https unless the Bridge allows a local target):
    bridge.subscriptions.create("https://your-server.example/hook", ["download.done"], secret=SECRET)
"""

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from mrchartist_bridge import verify_request

SECRET = os.environ["MCB_WEBHOOK_SECRET"]
seen = {}  # event id -> when handled. Delivery is at least once, and a captured copy stays valid for 5 minutes
SEEN_SECONDS = 600  # longer than the 5-minute signature window
MAX_SEEN = 10_000  # a bound, so a flood of events cannot grow it


def seen_before(event_id):
    now = time.time()
    for key in [k for k, at in seen.items() if now - at > SEEN_SECONDS]:
        del seen[key]
    if not isinstance(event_id, str):
        return False  # no id to match: handle it
    if event_id in seen:
        return True
    seen[event_id] = now
    while len(seen) > MAX_SEEN:
        del seen[next(iter(seen))]  # the oldest goes first
    return False


class Hook(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if not verify_request(SECRET, self.headers, raw):       # raw bytes, exactly as received
            self.send_response(401)
            self.end_headers()
            return
        event = json.loads(raw)
        # the id inside the signed body: the X-Bridge-Event-Id header is NOT signed, so anyone holding a copy can change it
        event_id = event.get("id")
        if not seen_before(str(event_id) if event_id is not None else None):
            print("verified:", event.get("topic"), event.get("data"))
        self.send_response(204)
        self.end_headers()


HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8099), Hook).serve_forever()
