#!/bin/sh
# Mr. Chartist API Bridge: double-click to start (macOS). The first run gets everything it needs by itself
# (Node.js included, no admin password) and sets up a practice account with no questions. Settings stay in this folder.
#
# Easiest on a Mac: the one-line installer (see the README), which avoids the security prompt below entirely.
# If macOS blocks this file the first time (files from a downloaded ZIP are marked as "from the internet"):
#   macOS 15 Sequoia and newer: double-click it once, then open System Settings > Privacy & Security, scroll down,
#     click "Open Anyway" next to start-mac.command and confirm.
#   macOS 14 and older: right-click (or Control-click) the file, choose Open, then Open again.
# If it says you do not have permission to run it, open Terminal and type:  chmod +x  (with a space), drag this
# file into the Terminal window, press Enter, then double-click it again. Or type: sh  then drag the file in.
cd "$(dirname "$0")" || exit 1
if [ ! -f scripts/install/launch.sh ]; then
  echo "Part of the Bridge is missing (scripts/install/launch.sh). Download the Bridge again and unzip all of it."
  printf 'Press Enter to close. '
  read -r _
  exit 1
fi
exec /bin/sh scripts/install/launch.sh "$PWD" "$PWD" "$@"
