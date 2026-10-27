#!/bin/bash
# Mr. Chartist API Bridge: double-click to start (macOS). First run installs what it needs and runs the setup.
# If macOS blocks it the first time: right-click the file, choose Open, then Open again.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org/ and double-click this file again."
  echo
  read -r -p "Press Enter to close." _
  exit 1
fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"; then
  echo "This needs Node.js 22 or newer. Install the LTS version from https://nodejs.org/ and try again."
  read -r -p "Press Enter to close." _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run: installing the Bridge. This takes a minute..."
  npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund || {
    echo "Installing failed. Check your internet connection and try again."
    read -r -p "Press Enter to close." _
    exit 1
  }
fi

if [ ! -f bridge.config.json ]; then
  echo
  echo "First run: a few questions to set things up. Press Enter to accept a suggestion."
  node bin/mc-bridge.mjs init || { read -r -p "Press Enter to close." _; exit 1; }
  echo
  read -r -p "Copy the admin key above, then press Enter to start the Bridge." _
fi

node bin/mc-bridge.mjs start --open
echo
read -r -p "The Bridge has stopped. Press Enter to close." _
