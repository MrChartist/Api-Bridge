#!/usr/bin/env bash
# Shared by the other scripts: reads .env and gives you one function, `bridge METHOD PATH [curl options]`.
#   - the key goes in the Authorization header only, never in the address
#   - it keeps the answer body in BRIDGE_BODY and the HTTP status in BRIDGE_STATUS (use `show` to print the body)
#   - a read that gets 429 or a temporary failure is repeated, waiting as long as Retry-After says (3 times at most)
#   - returns 0 for a 2xx answer, 1 for an error answer from the Bridge, 2 when the Bridge could not be reached
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HERE/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HERE/.env"
  set +a
fi
BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:4300}"
BRIDGE_URL="${BRIDGE_URL%/}"
BRIDGE_STATUS=""
BRIDGE_BODY=""

bridge() {
  local method="$1" path="$2"
  shift 2
  if [ -z "${BRIDGE_KEY:-}" ]; then
    echo "No API key. Put BRIDGE_KEY=mcb_... in .env (make one with: mc-bridge keys create --label my-script --scope read)." >&2
    return 2
  fi
  local attempt=0 headers out wait
  headers="$(mktemp)"
  while :; do
    if ! out="$(curl -sS --max-time 30 -X "$method" -D "$headers" -H "Authorization: Bearer $BRIDGE_KEY" -H "Accept: application/json" -w $'\n%{http_code}' "$@" "$BRIDGE_URL$path")"; then
      rm -f "$headers"
      echo "Could not reach the Bridge at $BRIDGE_URL. Is it running?" >&2
      return 2
    fi
    BRIDGE_STATUS="${out##*$'\n'}"
    BRIDGE_BODY="${out%$'\n'*}"
    case "$BRIDGE_STATUS" in
      2??)
        rm -f "$headers"
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
    rm -f "$headers"
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
