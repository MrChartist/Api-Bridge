"""A paper order from price to fill, then flatten the position.

Orders are paper unless you pass live=True (and the Bridge allows it). Safe to run any number of times.

    python paper_order.py [SYMBOL]
"""

import sys

from mrchartist_bridge import Bridge, NotRealtime, OrderRefused, OutcomeUnknown

symbol = sys.argv[1] if len(sys.argv) > 1 else "NSE:RELIANCE"
bridge = Bridge()                       # set MCB_ACCOUNT (or Bridge(account="...")) when there is more than one paper account

quote = bridge.quote(symbol)
try:
    order = bridge.orders.place(symbol, "BUY", quantity=1, product="CNC", price=quote)   # the quote must be real-time
except NotRealtime as e:
    sys.exit("Not placing an order: %s" % e)
except OrderRefused as e:
    sys.exit("The Bridge refused the order (%s): %s" % (e.code, e))
except OutcomeUnknown as e:             # never resend as a new order: look it up, or resend with the SAME ids
    sys.exit("Unknown outcome. Resend only with idempotency_key=%r and client_order_id=%r" % (e.idempotency_key, e.client_order_id))

print("placed", order.order_id, order.status, "idempotency key", order.idempotency_key)
done = bridge.orders.wait_for_fill(order, timeout=30)
print("filled" if done.is_filled else done.status, done.filled_quantity, "at", done.avg_price)

again = bridge.orders.place(symbol, "BUY", quantity=1, product="CNC", price=quote, idempotency_key=order.idempotency_key, client_order_id=order.client_order_id)
print("same ids again -> replayed:", again.replayed, "(no second order)")

flat = bridge.orders.to_target(symbol, target_quantity=0, product="CNC", order_type="MARKET")
print("flatten:", flat.action, "via", flat.via)
