"""Wait for a person to approve an order on the Bridge's computer.

An order that needs a human (prepared by an AI assistant or a hook that asks for confirmation) waits as a ticket.
Approval happens in the dashboard (Pending confirmations), by a person: this script can only watch. Watching needs an
admin key, from the computer the Bridge runs on.

    python ticket_wait.py TICKET_ID
"""

import sys

from mrchartist_bridge import Bridge, ScopeRequired, WaitTimeout

if len(sys.argv) < 2:
    sys.exit("usage: ticket_wait.py TICKET_ID   (list the open ones: bridge.tickets.list())")

bridge = Bridge()
try:
    outcome = bridge.tickets.wait(sys.argv[1], timeout=90)
except ScopeRequired as e:
    sys.exit(str(e))
except WaitTimeout:
    sys.exit("Still waiting for a person. Look again later.")

print("ticket", outcome.ticket_id, "->", outcome.state, outcome.reason or "")
if outcome.order:
    print("order", outcome.order.order_id, outcome.order.status)
