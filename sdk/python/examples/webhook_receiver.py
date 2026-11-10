"""A tiny webhook receiver that checks the Bridge's signature before it trusts a delivery.

    MCB_WEBHOOK_SECRET=... python webhook_receiver.py [PORT]

Register it (from the Bridge's computer, with an admin key; the URL must be https unless the Bridge allows a local target):
    bridge.subscriptions.create("https://your-server.example/hook", ["download.done"], secret=SECRET)
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from mrchartist_bridge import verify_request

SECRET = os.environ["MCB_WEBHOOK_SECRET"]
seen = set()  # event ids already handled: delivery is at least once


class Hook(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if not verify_request(SECRET, self.headers, raw):       # raw bytes, exactly as received
            self.send_response(401)
            self.end_headers()
            return
        event_id = self.headers.get("X-Bridge-Event-Id")
        if event_id not in seen:
            seen.add(event_id)
            event = json.loads(raw)
            print("verified:", event.get("topic"), event.get("data"))
        self.send_response(204)
        self.end_headers()


HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8099), Hook).serve_forever()
