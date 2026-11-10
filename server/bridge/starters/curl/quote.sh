#!/usr/bin/env bash
# Your first call: is the Bridge up, and what is the price of two symbols?   Run it with:  bash quote.sh
. "$(dirname "$0")/lib.sh"
echo "Health (needs no key):"
curl -sS "$BRIDGE_URL/v1/health" | pretty || {
  echo "Could not reach the Bridge at $BRIDGE_URL. Is it running?" >&2
  exit 1
}
echo
echo "Prices (needs a key with the read scope):"
if bridge GET "/v1/ltp?symbols=NSE:RELIANCE,NSE:NIFTY"; then
  show
  echo
  echo "It works. Next: bash history.sh   (candles),  bash download.sh   (data files),  bash events.sh   (live events)"
else
  explain
  exit 1
fi
