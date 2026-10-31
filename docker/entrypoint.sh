#!/bin/sh
# Mr. Chartist API Bridge container entrypoint.
# First start: writes /data/bridge.config.json (paper account, live trading off) and an admin key, shown once in
# `docker compose logs bridge`. The master key lives in its own volume (/secrets), apart from the data volume.
set -e
cd /app
export MCB_CONFIG="${MCB_CONFIG:-/data/bridge.config.json}"
export MCB_MASTER_KEY_FILE="${MCB_MASTER_KEY_FILE:-/secrets/master.key}"
export MCB_DOCKER=1
if [ ! -f "$MCB_CONFIG" ]; then
  echo "First start: setting up the Bridge in /data (your admin key is printed once below)."
  node bin/mc-bridge.mjs init --yes --config "$MCB_CONFIG"
  echo
  echo "That admin key is now in this container's log. Once you are signed in, make a new admin key on the"
  echo "dashboard's API keys page (or: docker compose exec bridge mc-bridge keys create --label admin --scope admin)"
  echo "and revoke the first one, so the logged key stops working."
fi
if [ "$#" -eq 0 ]; then
  set -- start
fi
case "$1" in
  start|init|setup|doctor|keys|accounts|kill|mcp|openai-tools) exec node bin/mc-bridge.mjs "$@" --config "$MCB_CONFIG" ;;
  *) exec "$@" ;;
esac
