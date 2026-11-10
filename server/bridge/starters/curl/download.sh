#!/usr/bin/env bash
# Save history to files on the Bridge's computer (a download job).
#   bash download.sh [symbol] [interval] [from date]       for example:  bash download.sh NSE:RELIANCE 5m 2024-01-01
# Downloads are a newer feature. On a Bridge that does not have them yet this prints a note and ends without an error.
. "$(dirname "$0")/lib.sh"
symbol="${1:-NSE:RELIANCE}"
interval="${2:-5m}"
from="${3:-$(date -u -d '30 days ago' +%F 2>/dev/null || date -u -v-30d +%F)}"
body="{\"name\":\"starter $symbol $interval\",\"symbols\":[\"$symbol\"],\"intervals\":[\"$interval\"],\"from\":\"$from\",\"format\":\"csv\"}"
bridge POST /v1/downloads -H 'Content-Type: application/json' -d "$body" || {
  if missing; then
    echo "Downloads: This Bridge does not have this feature yet. Update the Bridge and restart it."
    exit 0
  fi
  explain
  exit 1
}
show
echo "The job runs on the Bridge. List jobs with:  curl -H \"Authorization: Bearer \$BRIDGE_KEY\" \$BRIDGE_URL/v1/downloads   (or open the dashboard)."
