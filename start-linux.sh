#!/bin/sh
# Mr. Chartist API Bridge: start it on Linux. The first run gets everything it needs by itself (Node.js included,
# no admin password) and sets up a practice account with no questions. Settings stay in this folder.
#
# To start: double-click this file and choose "Run" (or "Run in Terminal"). Some file managers need it allowed first:
# right-click > Properties > Permissions > "Allow executing file as program", or right-click > "Run as a Program".
# Always works: open a terminal in this folder and type:  sh start-linux.sh
# If the file lost its "executable" mark when unzipping, the terminal way still works, or type: chmod +x start-linux.sh
cd "$(dirname "$0")" || exit 1

# Started from a file manager without a window? Reopen in a terminal so you can see what happens.
if [ ! -t 1 ] && [ -z "$MCB_IN_TERMINAL" ] && { [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; }; then
  MCB_IN_TERMINAL=1; export MCB_IN_TERMINAL
  for t in x-terminal-emulator gnome-terminal konsole xfce4-terminal mate-terminal xterm; do
    command -v "$t" >/dev/null 2>&1 || continue
    case "$t" in
      gnome-terminal) exec gnome-terminal -- sh "$PWD/start-linux.sh" "$@" ;;
      xfce4-terminal | mate-terminal) exec "$t" -x sh "$PWD/start-linux.sh" "$@" ;;
      *) exec "$t" -e sh "$PWD/start-linux.sh" "$@" ;;
    esac
  done
fi

if [ ! -f scripts/install/launch.sh ]; then
  echo "Part of the Bridge is missing (scripts/install/launch.sh). Download the Bridge again and unzip all of it."
  printf 'Press Enter to close. '
  read -r _
  exit 1
fi
exec sh scripts/install/launch.sh "$PWD" "$PWD" "$@"
