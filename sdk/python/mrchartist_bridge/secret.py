"""A string that does not give itself away: ``repr``, ``copy``, ``deepcopy`` (so ``dataclasses.asdict``) and ``pickle`` show
``***`` instead of the text. ``str(key)`` and ``"Bearer " + key`` still give the real text, because the client needs it to
build the Authorization header; only a logger that dumps an object, a ``vars()`` or an ``asdict`` is kept from leaking it."""

from __future__ import annotations

from typing import Any, Tuple

MASK = "***"


class SecretStr(str):
    __slots__ = ()

    def __repr__(self) -> str:
        return "'%s'" % MASK

    def __reduce__(self) -> Tuple[Any, Tuple[str]]:
        # copy.copy, copy.deepcopy and pickle all go through here: they get the mask, never the key
        return (SecretStr, (MASK,))

    def __copy__(self) -> "SecretStr":
        return SecretStr(MASK)

    def __deepcopy__(self, memo: Any) -> "SecretStr":
        return SecretStr(MASK)
