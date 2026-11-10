#!/usr/bin/env bash
# Shared by the other scripts: reads .env and gives you one function, `bridge METHOD PATH [curl options]`.
#   - the key goes in the Authorization header only, never in the address
#   - it keeps the answer body in BRIDGE_BODY and the HTTP status in BRIDGE_STATUS (use `show` to print the body)
#   - a read that gets 429 or a temporary failure is repeated, waiting as long as Retry-After says (3 times at most)
#   - returns 0 for a 2xx answer, 1 for an error answer from the Bridge, 2 when the Bridge could not be reached
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Read KEY=value lines from .env. It is never run as shell code (a command inside a value would run), and only these names are taken.
if [ -f "$HERE/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "" | \#*) continue ;;
      BRIDGE_URL=* | BRIDGE_KEY=* | MCB_*=* | WEBHOOK_SECRET=* | RECEIVER_*=*)
        name="${line%%=*}"
        value="${line#*=}"
        value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
        export "$name=$value"
        ;;
    esac
  done <"$HERE/.env"
fi
BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:4300}"
BRIDGE_URL="${BRIDGE_URL%/}"
BRIDGE_STATUS=""
BRIDGE_BODY=""

# A Bridge on this computer is never reached through a proxy (HTTP_PROXY, http_proxy): the proxy cannot reach 127.0.0.1 and
# would only see your key. Use bcurl in place of curl for every call to the Bridge.
_host="${BRIDGE_URL#*://}"
_host="${_host%%/*}"
case "$_host" in
  \[*\]*) _host="${_host%%\]*}]" ;; # [::1] or [::1]:4300
  *) _host="${_host%%:*}" ;;
esac
case "$_host" in
  localhost | \[::1\]) BRIDGE_LOOPBACK=1 ;;
  127.*.*.*) case "$_host" in *[!0-9.]*) BRIDGE_LOOPBACK=0 ;; *) BRIDGE_LOOPBACK=1 ;; esac ;;
  *) BRIDGE_LOOPBACK=0 ;;
esac
bcurl() {
  if [ "$BRIDGE_LOOPBACK" = 1 ]; then curl --noproxy '*' "$@"; else curl "$@"; fi
}

bridge() {
  local method="$1" path="$2"
  shift 2
  if [ -z "${BRIDGE_KEY:-}" ]; then
    echo "No API key. Put BRIDGE_KEY=mcb_... in .env (make one with: mc-bridge keys create --label my-script --scope read)." >&2
    return 2
  fi
  local attempt=0 headers out wait keyfile
  headers="$(mktemp)"
  # The key goes to curl in a private file (-H @file), not on the command line, where other users of this machine could read it with ps.
  keyfile="$(mktemp)"
  chmod 600 "$keyfile"
  printf 'Authorization: Bearer %s\n' "$BRIDGE_KEY" >"$keyfile"
  # Ctrl+C or a kill must not leave the key file behind in the temporary folder.
  trap 'rm -f "$headers" "$keyfile"; exit 130' INT TERM
  while :; do
    if ! out="$(bcurl -sS --max-time 30 -X "$method" -D "$headers" -H "@$keyfile" -H "Accept: application/json" -w $'\n%{http_code}' "$@" "$BRIDGE_URL$path")"; then
      trap - INT TERM
      rm -f "$headers" "$keyfile"
      echo "Could not reach the Bridge at $BRIDGE_URL. Is it running?" >&2
      return 2
    fi
    BRIDGE_STATUS="${out##*$'\n'}"
    BRIDGE_BODY="${out%$'\n'*}"
    case "$BRIDGE_STATUS" in
      2??)
        trap - INT TERM
        rm -f "$headers" "$keyfile"
        return 0
        ;;
      429 | 502 | 503 | 504)
        if [ "$method" = "GET" ] && [ "$attempt" -lt 3 ]; then
          wait="$(tr -d '\r' <"$headers" | awk -F': ' 'tolower($1)=="retry-after"{print $2}' | head -n1)"
          sleep "${wait:-1}"
          attempt=$((attempt + 1))
          continue
        fi
        ;;
    esac
    trap - INT TERM
    rm -f "$headers" "$keyfile"
    return 1
  done
}

# Print JSON readably when jq is installed, as it is otherwise.
pretty() { if command -v jq >/dev/null 2>&1; then jq .; else cat; fi; }

# Print the last answer.
show() { printf '%s\n' "$BRIDGE_BODY" | pretty; }

# After a failed call: the code to switch on and the request id to quote.
explain() {
  [ -n "$BRIDGE_STATUS" ] || return 0 # nothing was answered: the message was already printed
  local code
  code="$(printf '%s' "$BRIDGE_BODY" | sed -n 's/.*"code":"\([A-Z_]*\)".*/\1/p' | head -n1)"
  echo "The Bridge answered $BRIDGE_STATUS ${code:-}" >&2
  printf '%s\n' "$BRIDGE_BODY" >&2
  case "$code" in
    UNAUTHENTICATED) echo "  Check BRIDGE_KEY in .env (a key is shown once; make a new one if it was lost)." >&2 ;;
    SCOPE_REQUIRED) echo "  This key may not do that. Make a key with the scope the route needs (see Developers in the dashboard)." >&2 ;;
  esac
}

# True when the answer means "this Bridge does not have that route" (an older Bridge).
missing() {
  case "$BRIDGE_BODY" in
    *'"code":"NOT_FOUND"'* | *'"code":"NOT_IMPLEMENTED"'* | *'"code":"METHOD_NOT_ALLOWED"'*) return 0 ;;
  esac
  return 1
}
