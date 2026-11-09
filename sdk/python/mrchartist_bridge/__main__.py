"""``python3 -m mrchartist_bridge strategy describe|run <file.py>``: run a strategy file or describe its parameters."""

import sys

from .strategy import main


def _cli() -> int:
    args = sys.argv[1:]
    if args[:1] == ["strategy"]:
        return main(args[1:])
    sys.stderr.write("usage: python3 -m mrchartist_bridge strategy describe|run <file.py>\n")
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
