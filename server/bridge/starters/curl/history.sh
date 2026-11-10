#!/usr/bin/env bash
# Candles: bash history.sh [symbol] [interval] [how many]     for example:  bash history.sh NSE:RELIANCE 5m 20
# The Bridge splits long ranges across the broker's limits by itself; you ask for the range you want.
. "$(dirname "$0")/lib.sh"
bridge GET "/v1/history?symbol=${1:-NSE:RELIANCE}&interval=${2:-1d}&countback=${3:-5}" || {
  explain
  exit 1
}
show
