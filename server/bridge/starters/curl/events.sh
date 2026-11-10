#!/usr/bin/env bash
# Watch Bridge events as they happen, without polling.   bash events.sh [seconds] [topic,topic]
# Events are a newer feature. On a Bridge that does not have them yet this prints a note and ends without an error.
# Keep the last event id you handled: reconnect with since=<id> and you get what you missed.
. "$(dirname "$0")/lib.sh"
seconds="${1:-20}"
query=""
[ -n "${2:-}" ] && query="?topics=$2"
if [ -z "${BRIDGE_KEY:-}" ]; then
  echo "No API key. Put BRIDGE_KEY=mcb_... in .env." >&2
  exit 1
fi
echo "Listening for $seconds seconds..."
tmp="$(mktemp)"
status="$(curl -sS -N --max-time "$seconds" -H "Authorization: Bearer $BRIDGE_KEY" -H "Accept: text/event-stream" -o "$tmp" -w '%{http_code}' "$BRIDGE_URL/v1/events/stream$query" 2>/dev/null)"
case "$status" in
  404 | 405 | 501) echo "Events: This Bridge does not have this feature yet. Update the Bridge and restart it." ;;
  *) cat "$tmp" ;;
esac
rm -f "$tmp"
exit 0
