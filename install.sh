#!/bin/sh
# Mr. Chartist API Bridge: one-line installer for macOS, Linux and Android (Termux). No admin password needed.
#
#   curl -fsSL https://raw.githubusercontent.com/MrChartist/api-bridge/master/install.sh | sh
#
# Options (after "| sh -s --", for example:  curl -fsSL <url> | sh -s -- --demo):
#   --demo               start with sample prices (no broker needed), to try it out
#   --no-start           install only; do not start the Bridge
#   --uninstall          remove the Bridge's program files and shortcuts (your settings and data are kept)
#   --uninstall --purge  also delete your settings, keys and data (asks first; add --yes to skip the question)
# Running it again upgrades the Bridge in place; your settings and data are never touched.
#
# Where things go: the program in ~/.mc-bridge/app (its own Node.js in ~/.mc-bridge/app/runtime when the computer
# has no Node.js 22), settings and data in ~/.mc-bridge, the "mc-bridge" command in ~/.local/bin, and a
# "Mr Chartist Bridge" app in ~/Applications (macOS: Spotlight and Launchpad find it) or in your applications menu
# and on the Desktop (Linux).
# For testing: MCB_SOURCE=<folder, .tar.gz file or URL> installs from there; MCB_REF=<branch or tag> picks a version.
# MCB_HOME moves the whole thing (the Bridge itself reads MCB_HOME too).
#
# Everything is inside functions and the last line calls main, so a download cut short runs nothing at all.

mcb_main() {
  set -u
  STEPS=5
  OPT_DEMO=0 OPT_NO_START=0 OPT_UNINSTALL=0 OPT_PURGE=0 OPT_YES=0 MOVED_RUNTIME=0 STAGE="" WORK=""
  for arg in "$@"; do
    case "$arg" in
      --demo) OPT_DEMO=1 ;;
      --no-start) OPT_NO_START=1 ;;
      --uninstall) OPT_UNINSTALL=1 ;;
      --purge) OPT_PURGE=1 ;;
      --yes | -y) OPT_YES=1 ;;
      -h | --help)
        sed -n '2,18p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
        echo "Options: --demo, --no-start, --uninstall, --uninstall --purge [--yes]"
        return 0 ;;
      *) mcb_fail "Unknown option: $arg" "Options: --demo, --no-start, --uninstall, --uninstall --purge, --yes" ;;
    esac
  done
  [ "$OPT_PURGE" = 0 ] || [ "$OPT_UNINSTALL" = 1 ] || mcb_fail "--purge only works together with --uninstall."

  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || mcb_fail "Your home folder could not be found (HOME is not set)."
  # MCB_TEST_OS=mac|linux makes the other system's shortcuts (for the installer's own tests on one system).
  # Android: Termux (from F-Droid) reports Linux; its "uname -o" says Android and it sets TERMUX_VERSION.
  _os=${MCB_TEST_OS:-$(uname -s)}
  if [ -z "${MCB_TEST_OS:-}" ] && { [ -n "${TERMUX_VERSION:-}" ] || [ "$(uname -o 2>/dev/null)" = Android ]; }; then _os=android; fi
  case "$_os" in
    Darwin | mac) OS=mac ;;
    android) OS=android ;;
    Linux | linux) OS=linux ;;
    *) mcb_fail "This installer is for macOS and Linux. On Windows, use install.ps1 (see the README)." ;;
  esac

  MCB_DIR=${MCB_HOME:-$HOME/.mc-bridge}
  case "$MCB_DIR" in /*) ;; *) MCB_DIR=$(pwd)/$MCB_DIR ;; esac
  MCB_DIR=${MCB_DIR%/}
  # Never let a mistake point the deletions below at the home folder or the whole disk.
  if [ -z "$MCB_DIR" ] || [ "$MCB_DIR" = "${HOME%/}" ] || [ "$MCB_DIR" = / ]; then
    mcb_fail "MCB_HOME must be a folder of its own (it is \"${MCB_HOME:-}\")."
  fi
  APP="$MCB_DIR/app"
  # The Bridge words its hints with this name (init and start run below; the mc-bridge command is made in step 4).
  MCB_CLI_NAME=mc-bridge; export MCB_CLI_NAME
  BIN_DIR="$HOME/.local/bin"
  # Termux puts its own bin folder on PATH already.
  if [ "$OS" = android ] && [ -n "${PREFIX:-}" ] && [ -d "$PREFIX/bin" ] && [ -w "$PREFIX/bin" ]; then BIN_DIR="$PREFIX/bin"; fi
  SHIM="$BIN_DIR/mc-bridge"
  # Android: a home-screen shortcut through the Termux:Widget add-on (it lists the scripts in ~/.shortcuts).
  ANDROID_SHORTCUT="$HOME/.shortcuts/Mr Chartist Bridge"
  LINUX_ENTRY="$HOME/.local/share/applications/mr-chartist-bridge.desktop"
  MAC_APP="$HOME/Applications/Mr Chartist Bridge.app"
  # Earlier test versions of this installer made a .command file here instead of the app; removed on upgrade.
  MAC_LAUNCHER_OLD="$HOME/Applications/Mr Chartist Bridge.command"

  if [ "$OPT_UNINSTALL" = 1 ]; then
    mcb_uninstall
    return 0
  fi

  echo
  echo "Installing the Mr. Chartist API Bridge"
  echo "Program: $APP"
  echo "Your settings and data: $MCB_DIR"
  echo

  umask 022
  WORK=$(mktemp -d 2>/dev/null || mktemp -d -t mcbinstall) || mcb_fail "Could not create a temporary folder."
  trap 'mcb_cleanup' EXIT
  trap 'mcb_cleanup; exit 130' INT TERM
  mkdir -p "$MCB_DIR" || mcb_fail "Could not create $MCB_DIR. Check you can write to your home folder."
  STAGE="$MCB_DIR/app.new"
  rm -rf "$STAGE"

  # 1. The Bridge's files
  echo "[1/$STEPS] Getting the Bridge ..."
  mcb_fetch_source "$STAGE"
  [ -f "$STAGE/scripts/install/node-runtime.sh" ] || mcb_fail "The downloaded Bridge is incomplete (scripts/install/node-runtime.sh is missing)." "Run this again later, or ask for help on GitHub: https://github.com/MrChartist/api-bridge/issues"
  # Keep an already downloaded Node.js (it is the same for every version of the Bridge).
  if [ -d "$APP/runtime" ] && [ ! -e "$STAGE/runtime" ]; then
    mv "$APP/runtime" "$STAGE/runtime" && MOVED_RUNTIME=1
  fi

  # 2. Node.js
  echo "[2/$STEPS] Getting Node.js (what the Bridge runs on) ..."
  # shellcheck source=scripts/install/node-runtime.sh
  . "$STAGE/scripts/install/node-runtime.sh"
  mcb_ensure_node "$STAGE" || mcb_fail "Node.js is not ready (see the message above), so the Bridge was not installed."

  # 3. The Bridge's parts
  echo "[3/$STEPS] Installing the Bridge's parts (this takes a minute) ..."
  mcb_npm_install "$STAGE" ||
    mcb_fail "Installing the Bridge's parts failed. Check your internet connection and run this again."
  # Swap the new version in. The old one is removed only now that the new one is complete.
  if [ -d "$APP" ]; then
    echo "    Replacing the previous version. If the Bridge is running, close its window and start it again afterwards."
    rm -rf "$APP.old" && mv "$APP" "$APP.old" || mcb_fail "Could not replace the old version in $APP. Close the Bridge if it is running and run this again."
  fi
  mv "$STAGE" "$APP" || { [ -d "$APP.old" ] && mv "$APP.old" "$APP"; mcb_fail "Could not move the Bridge into $APP."; }
  rm -rf "$APP.old"
  MOVED_RUNTIME=0
  # The PATH set in step 2 pointed into app.new; point it at the final folder.
  [ -x "$APP/runtime/bin/node" ] && PATH="$APP/runtime/bin:$PATH" && export PATH

  # 4. Settings and shortcuts
  echo "[4/$STEPS] Setting up and adding shortcuts ..."
  if [ -f "$MCB_DIR/bridge.config.json" ]; then
    echo "    Keeping your existing settings in $MCB_DIR/bridge.config.json."
  else
    out=$(cd "$MCB_DIR" && node "$APP/bin/mc-bridge.mjs" init --yes </dev/null 2>&1)
    rc=$?
    # init's "Next steps" are for people typing commands; this installer covers them.
    printf '%s\n' "$out" | sed '/^Next steps/,$d' | sed 's/^/    /'
    [ "$rc" -eq 0 ] || mcb_fail "Setting up failed (see the message above)."
  fi
  mcb_make_shim
  case "$OS" in
    linux) mcb_make_linux_shortcuts ;;
    android) mcb_make_android_shortcuts ;;
    *) mcb_make_mac_shortcuts ;;
  esac

  # 5. Start
  echo
  echo "Installed. Paper (practice) trading is on; real orders stay off until you switch them on."
  case "$OS" in
    mac) where=" (Applications folder, Spotlight or Launchpad)" ;;
    android) where=" (Termux:Widget on your home screen)" ;;
    *) where=" (applications menu or Desktop)" ;;
  esac
  echo "Start it any time from the \"Mr Chartist Bridge\" shortcut$where,"
  echo "or by typing:  mc-bridge start --open"
  mcb_path_hint
  if [ "$OPT_NO_START" = 1 ]; then
    echo
    echo "[5/$STEPS] Not starting the Bridge (--no-start)."
    return 0
  fi
  echo
  echo "[5/$STEPS] Starting the Bridge. Your browser opens the dashboard in a moment."
  echo "    Keep this window open while you use the Bridge. To stop it, press Ctrl+C."
  echo
  mcb_cleanup
  trap - EXIT INT TERM
  cd "$MCB_DIR" || exit 1
  mcb_wake_lock
  set -- start --open
  [ "$OPT_DEMO" = 1 ] && set -- "$@" --demo
  # When piped from curl, standard input is the download; give the Bridge the keyboard instead.
  if (: </dev/tty) 2>/dev/null; then
    exec node "$APP/bin/mc-bridge.mjs" "$@" </dev/tty
  fi
  exec node "$APP/bin/mc-bridge.mjs" "$@" </dev/null
}

mcb_fail() {
  echo >&2
  for line in "$@"; do printf '%s\n' "$line" >&2; done
  exit 1
}

# Remove temporary files; after a failed upgrade, put the kept Node.js back where it was.
mcb_cleanup() {
  if [ "${MOVED_RUNTIME:-0}" = 1 ] && [ -d "${STAGE:-}/runtime" ] && [ -d "${APP:-}" ] && [ ! -e "$APP/runtime" ]; then
    mv "$STAGE/runtime" "$APP/runtime" 2>/dev/null || true
  fi
  MOVED_RUNTIME=0
  [ -n "${STAGE:-}" ] && [ -d "$STAGE" ] && rm -rf "$STAGE"
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
  return 0
}

mcb_get() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -T 20 -t 3 -O "$2" "$1"
  else mcb_fail "This needs curl or wget to download the Bridge, and neither is on this computer." "Install curl (for example: sudo apt install curl) and run this again."
  fi
}

# Put the Bridge's files into $1, from GitHub or from MCB_SOURCE (a folder, a .tar.gz file or a URL).
mcb_fetch_source() {
  dest=$1
  src=${MCB_SOURCE:-}
  ref=${MCB_REF:-}
  command -v tar >/dev/null 2>&1 || mcb_fail "This needs the 'tar' program, which is missing. Install it and run this again."
  if [ -z "$src" ]; then
    if [ -n "$ref" ]; then src="https://codeload.github.com/MrChartist/api-bridge/tar.gz/$ref"
    else src="https://codeload.github.com/MrChartist/api-bridge/tar.gz/refs/heads/master"; fi
  fi
  mkdir -p "$WORK/src"
  if [ -d "$src" ]; then
    echo "    From the folder $src"
    # Program files only: no installed parts, no git history, no private Node.js, no local settings or data.
    (cd "$src" && tar -cf - --exclude=node_modules --exclude=.git --exclude=./runtime --exclude=./data \
      --exclude=./bridge.config.json --exclude=./.cache --exclude=./coverage --exclude=./.mc-bridge .) |
      (cd "$WORK/src" && tar -xf -) || mcb_fail "Could not copy the Bridge from $src."
  else
    case "$src" in
      http://* | https://*)
        echo "    Downloading from ${src%%/tar.gz/*} ..."
        mcb_get "$src" "$WORK/src.tar.gz" || mcb_fail "Could not download the Bridge. Check your internet connection and run this again." ;;
      *)
        [ -f "$src" ] || mcb_fail "MCB_SOURCE points to $src, which does not exist."
        cp "$src" "$WORK/src.tar.gz" || mcb_fail "Could not read $src." ;;
    esac
    (cd "$WORK/src" && gzip -dc ../src.tar.gz | tar -xf -) ||
      mcb_fail "The Bridge download could not be unpacked (it may be incomplete). Run this again."
  fi
  # GitHub's archive has one folder inside (api-bridge-master); a folder copy does not.
  root="$WORK/src"
  if [ ! -f "$root/bin/mc-bridge.mjs" ]; then
    for d in "$WORK"/src/*/; do
      [ -f "$d/bin/mc-bridge.mjs" ] && root=${d%/} && break
    done
  fi
  [ -f "$root/bin/mc-bridge.mjs" ] || mcb_fail "The download does not look like the Bridge (bin/mc-bridge.mjs is missing)."
  rm -rf "$root/node_modules" "$root/runtime"
  mv "$root" "$dest" || mcb_fail "Could not save the Bridge into $dest. Check you can write to $MCB_DIR."
}

# The "mc-bridge" command, so it works from any folder. It finds the Bridge's own Node.js by itself.
mcb_make_shim() {
  mkdir -p "$BIN_DIR" || { echo "    Could not create $BIN_DIR; skipping the mc-bridge command."; return 0; }
  if [ -e "$SHIM" ] && ! grep -q "mr-chartist-bridge-shim" "$SHIM" 2>/dev/null; then
    echo "    $SHIM already exists and is not ours; leaving it alone."
    return 0
  fi
  {
    echo "#!/bin/sh"
    echo "# mr-chartist-bridge-shim: the mc-bridge command, made by the Mr. Chartist API Bridge installer."
    echo "# Remove it with the installer's --uninstall option."
    printf "MCB_APP='%s'\n" "$(mcb_sq "$APP")"
    printf ': "${MCB_HOME:=%s}"\n' "$(mcb_dq "$MCB_DIR")"
    echo 'export MCB_HOME'
    echo '# The Bridge words its hints with this command name.'
    echo 'MCB_CLI_NAME=mc-bridge; export MCB_CLI_NAME'
    echo 'if [ -x "$MCB_APP/runtime/bin/node" ]; then PATH="$MCB_APP/runtime/bin:$PATH"; export PATH; fi'
    echo 'if ! command -v node >/dev/null 2>&1; then'
    echo '  echo "Node.js for the Bridge was not found. Run the installer again:" >&2'
    echo '  echo "  curl -fsSL https://raw.githubusercontent.com/MrChartist/api-bridge/master/install.sh | sh" >&2'
    echo '  exit 1'
    echo 'fi'
    echo 'exec node "$MCB_APP/bin/mc-bridge.mjs" "$@"'
  } >"$SHIM" && chmod 755 "$SHIM" && echo "    Added the mc-bridge command: $SHIM"
}

# Text for inside '...' in sh (a ' becomes '\'').
mcb_sq() { printf '%s' "$1" | sed "s/'/'\\\\''/g"; }
# Text for inside "..." in sh.
mcb_dq() { printf '%s' "$1" | sed 's/[\\"$`]/\\&/g'; }

# The command a shortcut runs: the launcher, which starts the Bridge and keeps the window open at the end.
mcb_launch_cmd() {
  printf "/bin/sh '%s' '%s' '%s'" "$(mcb_sq "$APP/scripts/install/launch.sh")" "$(mcb_sq "$APP")" "$(mcb_sq "$MCB_DIR")"
}

mcb_make_android_shortcuts() {
  mkdir -p "$HOME/.shortcuts" 2>/dev/null || return 0
  {
    echo '#!/bin/sh'
    echo '# Mr. Chartist API Bridge: Termux:Widget shortcut (made by install.sh).'
    echo "exec $(mcb_launch_cmd)"
  } > "$ANDROID_SHORTCUT" && chmod 755 "$ANDROID_SHORTCUT"
  echo "    Added a home-screen shortcut for the Termux:Widget add-on (install it from F-Droid, then add its widget)."
}

mcb_make_linux_shortcuts() {
  # Desktop entry Exec= quoting: inside "...", escape \ " ` $ with a backslash, then double every backslash
  # (the file format's own escaping), and write % as %%.
  q() { printf '%s' "$1" | sed -e 's/[\\"`$]/\\&/g' -e 's/\\/\\\\/g' -e 's/%/%%/g'; }
  icon="$APP/scripts/install/icon/app-icon-1024.png"
  mkdir -p "$(dirname "$LINUX_ENTRY")" || return 0
  {
    echo "[Desktop Entry]"
    echo "Type=Application"
    echo "Version=1.0"
    echo "Name=Mr Chartist Bridge"
    echo "GenericName=Broker API Bridge"
    echo "Comment=Start the Mr. Chartist API Bridge and open its dashboard"
    printf 'Exec=/bin/sh "%s" "%s" "%s"\n' "$(q "$APP/scripts/install/launch.sh")" "$(q "$APP")" "$(q "$MCB_DIR")"
    [ -f "$icon" ] && echo "Icon=$icon"
    echo "Terminal=true"
    echo "Categories=Office;Finance;"
    echo "Keywords=trading;broker;stocks;api;"
    echo "StartupNotify=false"
  } >"$LINUX_ENTRY" && chmod 755 "$LINUX_ENTRY" && echo "    Added \"Mr Chartist Bridge\" to your applications menu."
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$LINUX_ENTRY")" >/dev/null 2>&1
  desk=$(mcb_desktop_dir)
  if [ -n "$desk" ]; then
    cp "$LINUX_ENTRY" "$desk/mr-chartist-bridge.desktop" 2>/dev/null && chmod 755 "$desk/mr-chartist-bridge.desktop" &&
      echo "    Added a shortcut to your Desktop."
    # GNOME asks before running a Desktop shortcut unless it is marked as trusted.
    command -v gio >/dev/null 2>&1 && gio set "$desk/mr-chartist-bridge.desktop" metadata::trusted true >/dev/null 2>&1
  fi
  return 0
}

mcb_make_mac_shortcuts() {
  # A small app in ~/Applications, so "Mr Chartist Bridge" shows in Spotlight, Launchpad and Finder. It opens
  # Terminal with the launcher (the Bridge needs a window to show what it is doing and to be stopped).
  # Made on this Mac by this script (not downloaded by a browser), so macOS does not block it on first open.
  # No Desktop copy: writing to the Desktop makes macOS ask for permission, and this installer asks nothing.
  mkdir -p "$HOME/Applications" || return 0
  rm -f "$MAC_LAUNCHER_OLD"
  tmpapp="$HOME/Applications/.mr-chartist-bridge.app.new"
  rm -rf "$tmpapp"
  mkdir -p "$tmpapp/Contents/MacOS" "$tmpapp/Contents/Resources" || return 0
  version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$APP/package.json" | head -n 1)
  icon=""
  mcb_make_mac_icon "$tmpapp/Contents/Resources/AppIcon.icns" && icon=AppIcon
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0">'
    echo '<dict>'
    echo '  <key>CFBundleName</key><string>Mr Chartist Bridge</string>'
    echo '  <key>CFBundleDisplayName</key><string>Mr Chartist Bridge</string>'
    echo '  <key>CFBundleIdentifier</key><string>com.mrchartist.bridge</string>'
    echo '  <key>CFBundleExecutable</key><string>mr-chartist-bridge</string>'
    echo '  <key>CFBundlePackageType</key><string>APPL</string>'
    echo '  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>'
    echo "  <key>CFBundleShortVersionString</key><string>${version:-0.0.0}</string>"
    echo "  <key>CFBundleVersion</key><string>${version:-0.0.0}</string>"
    [ -n "$icon" ] && echo "  <key>CFBundleIconFile</key><string>$icon</string>"
    echo '  <key>LSApplicationCategoryType</key><string>public.app-category.finance</string>'
    echo '</dict>'
    echo '</plist>'
  } >"$tmpapp/Contents/Info.plist"
  {
    echo "#!/bin/sh"
    echo "# Start the Mr. Chartist API Bridge in a Terminal window. Made by its installer."
    echo "exec $(mcb_launch_cmd)"
  } >"$tmpapp/Contents/Resources/launch.command"
  {
    echo "#!/bin/sh"
    echo "# Mr Chartist Bridge.app: open Terminal with the launcher next to this file. Made by the Mr. Chartist API Bridge installer."
    echo 'exec /usr/bin/open -a Terminal "$(cd "$(dirname "$0")/../Resources" && pwd)/launch.command"'
  } >"$tmpapp/Contents/MacOS/mr-chartist-bridge"
  chmod 755 "$tmpapp" "$tmpapp/Contents/MacOS/mr-chartist-bridge" "$tmpapp/Contents/Resources/launch.command" || return 0
  rm -rf "$MAC_APP" && mv "$tmpapp" "$MAC_APP" || { rm -rf "$tmpapp"; echo "    Could not add the app to ~/Applications."; return 0; }
  # Tell macOS about the new (or updated) app so Spotlight and Launchpad show it straight away.
  lsreg=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  [ -x "$lsreg" ] && "$lsreg" -f "$MAC_APP" >/dev/null 2>&1
  echo "    Added \"Mr Chartist Bridge\" to your Applications folder (find it with Spotlight or Launchpad)."
  return 0
}

# The app icon, shipped ready-made (scripts/install/icon/AppIcon.icns), so no macOS tools are needed.
mcb_make_mac_icon() {
  [ -f "$APP/scripts/install/icon/AppIcon.icns" ] && cp "$APP/scripts/install/icon/AppIcon.icns" "$1"
}

# The Desktop folder (Linux may name it in the user's language), or nothing when there is none.
mcb_desktop_dir() {
  d=""
  if [ "$OS" = linux ] && command -v xdg-user-dir >/dev/null 2>&1; then d=$(xdg-user-dir DESKTOP 2>/dev/null); fi
  [ -n "$d" ] && [ "$d" != "$HOME" ] && [ -d "$d" ] || d="$HOME/Desktop"
  [ -d "$d" ] && printf '%s\n' "$d"
  return 0
}

mcb_path_hint() {
  case ":${PATH:-}:" in *":$BIN_DIR:"*) return 0 ;; esac
  [ -f "$SHIM" ] || return 0
  case "${SHELL:-}" in */zsh) rc="$HOME/.zprofile" ;; */bash) [ "$OS" = mac ] && rc="$HOME/.bash_profile" || rc="$HOME/.bashrc" ;; *) rc="$HOME/.profile" ;; esac
  echo
  echo "To use the mc-bridge command in a terminal, your terminal needs to know about $BIN_DIR. Run this once,"
  echo "then open a new terminal window:"
  echo "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> \"$rc\""
  echo "(The shortcuts work without this. Until then you can also type: $SHIM start --open)"
}

mcb_uninstall() {
  echo
  echo "Removing the Mr. Chartist API Bridge"
  removed=0
  for p in "$APP" "$MCB_DIR/app.new" "$MCB_DIR/app.old"; do
    [ -e "$p" ] && rm -rf "$p" && removed=1
  done
  if [ -f "$SHIM" ] && grep -q "mr-chartist-bridge-shim" "$SHIM" 2>/dev/null; then rm -f "$SHIM" && removed=1; fi
  # (On macOS the Desktop is not looked at: that would make macOS ask for permission. Nothing is put there.)
  desk=""
  [ "$OS" = linux ] && desk=$(mcb_desktop_dir)
  [ -f "$ANDROID_SHORTCUT" ] && grep -q "Mr. Chartist API Bridge" "$ANDROID_SHORTCUT" 2>/dev/null && rm -f "$ANDROID_SHORTCUT" && removed=1
  for p in "$LINUX_ENTRY" "$MAC_LAUNCHER_OLD" ${desk:+"$desk/mr-chartist-bridge.desktop"}; do
    [ -f "$p" ] && grep -q "Mr. Chartist API Bridge" "$p" 2>/dev/null && rm -f "$p" && removed=1
  done
  if [ -f "$MAC_APP/Contents/MacOS/mr-chartist-bridge" ] && grep -q "Mr. Chartist API Bridge" "$MAC_APP/Contents/MacOS/mr-chartist-bridge" 2>/dev/null; then
    rm -rf "$MAC_APP" && removed=1
  fi
  if [ "$removed" = 1 ]; then echo "Removed the program, its shortcuts and the mc-bridge command."
  else echo "The Bridge's program was not found (already removed)."; fi

  keyfile=$(mcb_master_key_path)
  if [ "$OPT_PURGE" != 1 ]; then
    echo
    echo "Your settings, keys and data are kept in: $MCB_DIR"
    [ -n "$keyfile" ] && echo "The master key that unlocks saved broker logins is kept in: $keyfile"
    echo "Installing again picks them up. To delete them too, run the installer with: --uninstall --purge"
    return 0
  fi
  if [ ! -d "$MCB_DIR" ]; then
    echo "There are no settings or data to delete in $MCB_DIR."
    return 0
  fi
  echo
  echo "--purge also deletes, permanently: $MCB_DIR"
  echo "(your settings, API keys, saved broker logins, paper trades and logs)"
  if [ "$OPT_YES" != 1 ]; then
    if ! (: </dev/tty) 2>/dev/null; then
      mcb_fail "Nothing was deleted: there is no keyboard to confirm with. Add --yes to delete without asking."
    fi
    printf 'Type DELETE (in capitals) to delete them, or press Enter to keep them: '
    answer=""
    read -r answer </dev/tty || answer=""
    if [ "$answer" != DELETE ]; then
      echo "Nothing was deleted. Your settings and data are still in $MCB_DIR."
      return 0
    fi
  fi
  rm -rf "$MCB_DIR" && echo "Deleted $MCB_DIR."
  if [ -n "$keyfile" ]; then
    # The master key can be shared with another copy of the Bridge (for example one started from a ZIP), so it stays.
    echo "The master key was left in $keyfile, because another copy of the Bridge on this computer may use it."
    echo "If you have no other copy, you can delete it:  rm \"$keyfile\""
  fi
  return 0
}

# The master key file: the one named in the settings, else the default place `mc-bridge init` uses.
mcb_master_key_path() {
  k=""
  if [ -f "$MCB_DIR/bridge.config.json" ]; then
    k=$(sed -n 's/^ *"masterKeyFile": *"\(.*\)",\{0,1\} *$/\1/p' "$MCB_DIR/bridge.config.json" | head -n 1)
  fi
  [ -n "$k" ] || k="${MCB_MASTER_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/mc-bridge/master.key}"
  [ -f "$k" ] && printf '%s\n' "$k"
  return 0
}

mcb_main "$@"
