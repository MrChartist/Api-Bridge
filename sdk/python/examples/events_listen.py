"""React to Bridge events without polling; resume after a restart from the last cursor.

    python events_listen.py [TOPIC ...]        # default: download.* recording.*

Needs a key for the events you ask for (admin-only events are not sent to a read key).
"""

import os
import sys

from mrchartist_bridge import Bridge

CURSOR_FILE = ".events-cursor"
topics = sys.argv[1:] or ["download.*", "recording.*"]
bridge = Bridge()

since = open(CURSOR_FILE).read().strip() if os.path.exists(CURSOR_FILE) else None
with bridge.events.subscribe(topics, since=since) as sub:      # reconnects by itself and continues after the last cursor
    for ev in sub:
        print(ev.cursor, ev.topic, ev.data)
        with open(CURSOR_FILE, "w") as f:
            f.write(ev.cursor or "")
