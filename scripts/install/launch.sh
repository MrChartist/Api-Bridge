#!/bin/sh
# Mr. Chartist API Bridge: the shared start-up steps behind start-mac.command, start-linux.sh and the shortcuts
# the one-line installer makes. Usage:  sh launch.sh <app folder> <settings folder> [extra start options, e.g. --demo]
#   <app folder>       holds bin/mc-bridge.mjs (and runtime/ when the Bridge has its own Node.js)
#   <settings folder>  holds bridge.config.json (the ZIP keeps it next to the app; the installer uses ~/.mc-bridge)
# First run: gets Node.js if needed, installs the Bridge's parts, writes a safe setup (paper account, live trading
# off, no questions). Every run: starts the Bridge and opens the dashboard. The window waits for Enter at the end.

mcb_pause() {
  echo
  printf '%s ' "${1:-Press Enter to close.}"
  read -r _mcb_answer || true
}
mcb_stop() {
  echo
  printf '%s\n' "$@"
  mcb_pause
  exit 1
}

APP_DIR=$1
CONFIG_DIR=${2:-$1}
[ -n "$APP_DIR" ] && [ -f "$APP_DIR/bin/mc-bridge.mjs" ] ||
  mcb_stop "The Bridge's files were not found${APP_DIR:+ in $APP_DIR}." "Download the Bridge again, or run the installer again."
[ -f "$APP_DIR/scripts/install/node-runtime.sh" ] ||
  mcb_stop "Part of the Bridge is missing ($APP_DIR/scripts/install/node-runtime.sh)." "Download the Bridge again, or run the installer again."
if [ $# -ge 2 ]; then shift 2; else shift $#; fi
# Installed by install.sh (settings kept apart from the program): the mc-bridge command exists, so the Bridge's
# hints can name it. A downloaded ZIP has no such command, so its hints keep their default wording.
if [ "$APP_DIR" != "$CONFIG_DIR" ] && [ -z "${MCB_CLI_NAME:-}" ]; then MCB_CLI_NAME=mc-bridge; export MCB_CLI_NAME; fi

# shellcheck source=scripts/install/node-runtime.sh disable=SC1091
. "$APP_DIR/scripts/install/node-runtime.sh"

echo "Mr. Chartist API Bridge"
echo
mcb_ensure_node "$APP_DIR" || mcb_stop "The Bridge could not start because Node.js is not ready (see the message above)."

if [ ! -f "$APP_DIR/node_modules/.package-lock.json" ]; then
  echo "First run: installing the Bridge's parts. This takes a minute ..."
  mcb_npm_install "$APP_DIR" ||
    mcb_stop "Installing failed. Check your internet connection and try again."
fi

mkdir -p "$CONFIG_DIR" && cd "$CONFIG_DIR" || mcb_stop "Could not open the settings folder $CONFIG_DIR."

if [ ! -f bridge.config.json ]; then
  echo "First run: setting things up (a practice account with virtual money; real orders stay off) ..."
  # Show what init says, without its "Next steps" (those are for people typing commands; this window does it all).
  _mcb_out=$(node "$APP_DIR/bin/mc-bridge.mjs" init --yes </dev/null 2>&1)
  _mcb_rc=$?
  printf '%s\n' "$_mcb_out" | sed '/^Next steps/,$d'
  [ "$_mcb_rc" -eq 0 ] || mcb_stop "Setting up failed (see the message above)."
fi

echo "Starting the Bridge. Your browser opens the dashboard in a moment."
echo "Keep this window open while you use the Bridge. To stop it, press Ctrl+C or close the window."
echo
# Ctrl+C stops the Bridge (it shuts down cleanly); this script then carries on to the "Press Enter" line.
trap ':' INT
node "$APP_DIR/bin/mc-bridge.mjs" start --open "$@"
trap - INT
mcb_pause "The Bridge has stopped. Press Enter to close."
