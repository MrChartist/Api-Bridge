# Mr. Chartist API Bridge: finds or downloads Node.js 22 for the installer and the double-click launchers.
# POSIX sh (works in bash, dash and the macOS sh). Source it, then call:  mcb_ensure_node <app folder>
# It uses the computer's own Node.js when it is version 22 or newer. Otherwise it downloads a private copy of the
# newest Node.js 22 from nodejs.org into <app folder>/runtime, checks its SHA-256 against nodejs.org's list, and
# puts it first on PATH. No admin rights are needed and nothing outside <app folder> is changed.
# Sourcing this file only defines functions. Everything below is safe to call on its own (tests do).

MCB_NODE_MAJOR=22
MCB_NODE_DIST=${MCB_NODE_DIST:-https://nodejs.org/dist}

mcb_say() { printf '%s\n' "$*"; }
mcb_warn() { printf '%s\n' "$*" >&2; }

# The major version of a node binary ("22"), or nothing when it does not run.
mcb_node_major() {
  "${1:-node}" -v 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p'
}

# The newest vMAJOR.x.y listed in a nodejs.org index.json file. Prints e.g. v22.23.4; fails when there is none.
mcb_pick_node_version() {
  [ -r "$1" ] || return 1
  _mcb_v=$(grep -o "\"version\": *\"v${2:-$MCB_NODE_MAJOR}\.[0-9][0-9]*\.[0-9][0-9]*\"" "$1" |
    sed 's/.*"\(v[0-9.]*\)"$/\1/' | sort -t. -k1,1 -k2,2n -k3,3n | tail -n 1)
  [ -n "$_mcb_v" ] || return 1
  printf '%s\n' "$_mcb_v"
}

# nodejs.org's name for this computer: darwin-arm64, darwin-x64, linux-x64, linux-arm64 or linux-armv7l.
# Arguments (for tests): the output of `uname -s` and `uname -m`.
# shellcheck disable=SC2120
mcb_node_platform() {
  _mcb_os=${1:-$(uname -s)}
  _mcb_arch=${2:-$(uname -m)}
  case "$_mcb_os" in
    Darwin) _mcb_os=darwin
      # An Apple Silicon Mac running this in Rosetta reports x86_64; the native build is faster.
      if [ -z "${2:-}" ] && [ "$_mcb_arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then _mcb_arch=arm64; fi ;;
    Linux) _mcb_os=linux ;;
    *) return 1 ;;
  esac
  case "$_mcb_arch" in
    x86_64 | amd64) _mcb_arch=x64 ;;
    arm64 | aarch64) _mcb_arch=arm64 ;;
    armv7l | armv7*) [ "$_mcb_os" = linux ] || return 1; _mcb_arch=armv7l ;;
    *) return 1 ;;
  esac
  printf '%s-%s\n' "$_mcb_os" "$_mcb_arch"
}

# Download a URL to a file with curl or wget. A progress bar is shown when MCB_PROGRESS=1 and this is a terminal.
mcb_download() {
  if command -v curl >/dev/null 2>&1; then
    if [ "${MCB_PROGRESS:-0}" = 1 ] && [ -t 2 ]; then
      curl -fL --retry 3 --connect-timeout 20 --progress-bar -o "$2" "$1"
    else
      curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1"
    fi
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 20 -t 3 -O "$2" "$1"
  else
    mcb_warn "This needs curl or wget to download files, and neither is on this computer."
    return 1
  fi
}

# The SHA-256 of a file (lowercase hex).
mcb_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else return 1
  fi
}

# Check <file> against the line for <name> in a SHASUMS256.txt file. Fails on a mismatch or a missing line.
mcb_verify_sha256() {
  _mcb_want=$(awk -v n="$3" '$2 == n || $2 == "*" n { print tolower($1); exit }' "$2")
  [ -n "$_mcb_want" ] || return 1
  _mcb_got=$(mcb_sha256 "$1") || return 1
  [ "$_mcb_got" = "$_mcb_want" ]
}

# True when this Linux uses musl (Alpine): nodejs.org's Linux builds do not run there.
mcb_is_musl() {
  for _mcb_f in /lib/ld-musl-*; do [ -e "$_mcb_f" ] && return 0; done
  return 1
}

# Download the newest Node.js 22 into <app>/runtime (bin/node, bin/npm). Prints friendly progress.
mcb_install_private_node() {
  _mcb_app=$1
  _mcb_fail_net="Could not download Node.js. Check your internet connection and run this again."
  if [ "$(uname -s)" = Linux ] && mcb_is_musl; then
    mcb_warn "This Linux (for example Alpine) needs Node.js from its own package manager."
    mcb_warn "Install Node.js 22 or newer (on Alpine: apk add nodejs npm) and run this again."
    return 1
  fi
  if ! _mcb_plat=$(mcb_node_platform); then
    mcb_warn "This computer ($(uname -s) $(uname -m)) is not one Node.js offers a ready-made download for."
    mcb_warn "Install Node.js 22 or newer from https://nodejs.org/ and run this again."
    return 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    mcb_warn "This needs the 'tar' program to unpack Node.js. Install it and run this again."
    return 1
  fi
  _mcb_tmp=$(mktemp -d 2>/dev/null || mktemp -d -t mcbnode) || { mcb_warn "Could not create a temporary folder."; return 1; }
  if ! mcb_download "$MCB_NODE_DIST/index.json" "$_mcb_tmp/index.json"; then
    mcb_warn "$_mcb_fail_net"; rm -rf "$_mcb_tmp"; return 1
  fi
  if ! _mcb_ver=$(mcb_pick_node_version "$_mcb_tmp/index.json" "$MCB_NODE_MAJOR"); then
    mcb_warn "$_mcb_fail_net"; rm -rf "$_mcb_tmp"; return 1
  fi
  _mcb_name="node-$_mcb_ver-$_mcb_plat"
  mcb_say "    Downloading Node.js $_mcb_ver (about 30 MB) ..."
  if ! MCB_PROGRESS=1 mcb_download "$MCB_NODE_DIST/$_mcb_ver/$_mcb_name.tar.gz" "$_mcb_tmp/$_mcb_name.tar.gz" ||
    ! mcb_download "$MCB_NODE_DIST/$_mcb_ver/SHASUMS256.txt" "$_mcb_tmp/SHASUMS256.txt"; then
    mcb_warn "$_mcb_fail_net"; rm -rf "$_mcb_tmp"; return 1
  fi
  if ! mcb_sha256 "$_mcb_tmp/$_mcb_name.tar.gz" >/dev/null; then
    mcb_warn "Could not check the download: this computer has no sha256sum, shasum or openssl."; rm -rf "$_mcb_tmp"; return 1
  fi
  if ! mcb_verify_sha256 "$_mcb_tmp/$_mcb_name.tar.gz" "$_mcb_tmp/SHASUMS256.txt" "$_mcb_name.tar.gz"; then
    mcb_warn "The Node.js download was damaged or changed on the way (its checksum does not match), so it was not used."
    mcb_warn "Run this again. If it keeps happening, your network may be interfering with downloads."
    rm -rf "$_mcb_tmp"; return 1
  fi
  mcb_say "    Download checked (SHA-256 matches nodejs.org). Unpacking ..."
  if ! (cd "$_mcb_tmp" && gzip -dc "$_mcb_name.tar.gz" | tar -xf -) || [ ! -x "$_mcb_tmp/$_mcb_name/bin/node" ]; then
    mcb_warn "Could not unpack Node.js. Check there is free disk space and run this again."; rm -rf "$_mcb_tmp"; return 1
  fi
  rm -rf "$_mcb_app/runtime" && mkdir -p "$_mcb_app" && mv "$_mcb_tmp/$_mcb_name" "$_mcb_app/runtime" || {
    mcb_warn "Could not save Node.js into $_mcb_app/runtime. Check you can write to that folder."; rm -rf "$_mcb_tmp"; return 1
  }
  rm -rf "$_mcb_tmp"
  return 0
}

# Make node and npm (version 22 or newer) available on PATH for the rest of this script.
mcb_ensure_node() {
  _mcb_app=${1:?mcb_ensure_node needs the app folder}
  _mcb_major=$(mcb_node_major node)
  if [ -n "$_mcb_major" ] && [ "$_mcb_major" -ge "$MCB_NODE_MAJOR" ] && command -v npm >/dev/null 2>&1; then
    mcb_say "    Using the Node.js already on this computer ($(node -v))."
    return 0
  fi
  _mcb_major=$(mcb_node_major "$_mcb_app/runtime/bin/node")
  if [ -n "$_mcb_major" ] && [ "$_mcb_major" -ge "$MCB_NODE_MAJOR" ] && [ -e "$_mcb_app/runtime/bin/npm" ]; then
    PATH="$_mcb_app/runtime/bin:$PATH"; export PATH
    mcb_say "    Using the Bridge's own Node.js ($(node -v))."
    return 0
  fi
  if [ -n "$(mcb_node_major node)" ]; then
    mcb_say "    The Node.js on this computer is too old ($(node -v)); the Bridge will use its own copy instead."
  else
    mcb_say "    Node.js is not installed; the Bridge will use its own copy (nothing else on this computer changes)."
  fi
  mcb_install_private_node "$_mcb_app" || return 1
  PATH="$_mcb_app/runtime/bin:$PATH"; export PATH
  _mcb_major=$(mcb_node_major node)
  if [ -z "$_mcb_major" ] || [ "$_mcb_major" -lt "$MCB_NODE_MAJOR" ]; then
    mcb_warn "Node.js was downloaded but does not start on this computer. Install Node.js 22 or newer from https://nodejs.org/ and run this again."
    return 1
  fi
  mcb_say "    Node.js $(node -v) is ready."
  return 0
}

# Install the Bridge's parts in <app> (npm ci, or npm install when the lock file does not fit). Quiet unless it fails.
mcb_npm_install() {
  (cd "$1" && export NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false &&
    { npm ci --omit=dev --no-audit --no-fund --loglevel=error ||
      npm install --omit=dev --no-audit --no-fund --loglevel=error; })
}
