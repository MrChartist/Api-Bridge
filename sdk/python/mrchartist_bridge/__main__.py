"""``python3 -m mrchartist_bridge <command>`` (also installed as ``mrchartist-bridge``).

    ping                         is the Bridge up, how fast, and is the key accepted
    login [--url U] [--key K] [--account A]
                                 save the URL and key (mode 600) to client.json in the Bridge folder, then ping
    price SYMBOL [SYMBOL ...]    last prices with their freshness labels
    version                      this library's version
    strategy describe|run FILE   run a strategy file or describe its parameters (see strategy.py)

The URL and key come from the usual places (see mrchartist_bridge.discovery): --url/--key, MCB_BRIDGE_URL, MCB_API_KEY, ...
"""

from __future__ import annotations

import getpass
import sys
from typing import List, Optional

USAGE = __doc__


def _flag(args: List[str], name: str) -> Optional[str]:
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            v = args[i + 1]
            del args[i : i + 2]
            return v
    return None


def _cli(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    cmd = args[0] if args else ""
    if cmd == "strategy":
        from .strategy import main

        return main(args[1:])
    if cmd in ("", "-h", "--help", "help"):
        sys.stderr.write(USAGE or "")
        return 0 if cmd else 2
    from . import __version__
    from .errors import BridgeError

    if cmd == "version":
        sys.stdout.write(__version__ + "\n")
        return 0
    rest = args[1:]
    url = _flag(rest, "--url")
    key = _flag(rest, "--key")
    account = _flag(rest, "--account")
    try:
        if cmd == "login":
            from .bridge import Bridge
            from .discovery import save_credentials

            k = key or getpass.getpass("API key (input hidden): ")
            path = save_credentials(url, k, account=account)
            sys.stdout.write("Saved to %s (only you can read it).\n" % path)
            sys.stdout.write("%s\n" % Bridge().ping())
            return 0
        from .bridge import Bridge

        bridge = Bridge(url, key, account=account)
        if cmd == "ping":
            sys.stdout.write("%s\n" % bridge.ping())
            return 0
        if cmd == "price":
            if not rest:
                sys.stderr.write("usage: mrchartist_bridge price SYMBOL [SYMBOL ...]\n")
                return 2
            res = bridge.ltp(rest)
            for p in res:
                f = p.freshness
                sys.stdout.write("%-40s %12.2f  %s %s%s\n" % (p.symbol, p.ltp, f.source, f.data_class, " (stale)" if f.stale else ""))
            for e in res.errors:
                sys.stdout.write("%-40s %s: %s\n" % (e.symbol or "", e.code, e.message))
            return 0 if len(res) else 1
    except BridgeError as e:
        sys.stderr.write("Error: %s\n" % e)
        return 1
    sys.stderr.write(USAGE or "")
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
