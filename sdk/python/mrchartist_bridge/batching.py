"""Retry with back-off that respects the Bridge's rate limits, and batching for many symbols.

``retry(fn)`` is for READS and other calls that are safe to repeat. It waits as the Bridge says:

* ``RateLimited``: ``retry_after_ms`` (the same time as ``Retry-After``) when given, else a growing back-off.
  ``scope`` shapes the wait: ``client`` is your own key's quota (wait exactly as told), ``upstream`` is the broker's
  shared limit (wait at least a second: everyone is waiting for it), ``queue`` and ``consumer-cap`` mean the Bridge's
  queue is full or you hold your share of it (back off, do not hammer).
* ``UpstreamError`` (and any other Bridge error marked ``retryable``) and connection errors whose outcome is known.
* Never: a write whose outcome is unknown (``OutcomeUnknown``, ``BridgeConnectionError.outcome_unknown``). Those are
  reconciled, not repeated: see ``bridge.orders``.

A wait longer than ``max_wait`` raises the error instead of sleeping: a script that has to wait ten minutes should say so.
"""

from __future__ import annotations

import random
import time
from functools import partial
from typing import TYPE_CHECKING, Any, Callable, List, Optional, Sequence, TypeVar

from .errors import BridgeApiError, BridgeConnectionError, OutcomeUnknown, RateLimited
from .records import ItemProblem, Result

if TYPE_CHECKING:  # pragma: no cover
    from .bridge import Bridge

T = TypeVar("T")

#: smallest wait by ``RateLimited.scope`` when the Bridge gave no ``retry_after_ms``
_MIN_WAIT = {"client": 0.25, "upstream": 1.0, "queue": 0.5, "consumer-cap": 1.0}


def wait_for(err: BaseException, attempt: int, *, base: float = 0.5, max_wait: float = 30.0) -> Optional[float]:
    """Seconds to wait before retrying after ``err``, or ``None`` when it must not be retried."""
    if isinstance(err, OutcomeUnknown):
        return None
    if isinstance(err, RateLimited):
        floor = _MIN_WAIT.get(err.scope or "", 0.25)
        if err.retry_after_ms is not None:
            wait = max(0.0, err.retry_after_ms / 1000.0)
            if err.scope == "upstream":
                wait = max(wait, floor)
        else:
            wait = max(floor, min(max_wait, base * (2 ** attempt)))
        wait += random.random() * min(0.25, wait * 0.1)  # a little jitter so parallel scripts do not all wake together
    elif isinstance(err, BridgeApiError):
        if not err.retryable:
            return None
        wait = err.retry_after_ms / 1000.0 if err.retry_after_ms is not None else min(max_wait, base * (2 ** attempt))
    elif isinstance(err, BridgeConnectionError):
        if err.outcome_unknown:
            return None
        wait = min(max_wait, base * (2 ** attempt))
    else:
        return None
    return wait if wait <= max_wait else None


def retry(fn: Callable[[], T], *, attempts: int = 5, base: float = 0.5, max_wait: float = 30.0, sleep: Callable[[float], None] = time.sleep,
          on_wait: Optional[Callable[[BaseException, float, int], None]] = None) -> T:
    """Call ``fn()``; on a retryable error wait as above and call it again, up to ``attempts`` calls in all."""
    attempt = 0
    while True:
        try:
            return fn()
        except (BridgeApiError, BridgeConnectionError) as e:
            wait = wait_for(e, attempt, base=base, max_wait=max_wait)
            if wait is None or attempt >= attempts - 1:
                raise
            if on_wait:
                on_wait(e, wait, attempt + 1)
            sleep(wait)
            attempt += 1


def fetch_many(
    bridge: "Bridge",
    symbols: Sequence[str],
    fn: Callable[..., Result[T]],
    *,
    chunk: int = 200,
    pause: float = 0.0,
    attempts: int = 5,
    max_wait: float = 30.0,
    **kw: Any,
) -> Result[T]:
    """Call ``fn(chunk_of_symbols, **kw)`` for any number of symbols and join the answers.

    Symbols are de-duplicated (order kept) and sent ``chunk`` at a time (the Bridge accepts up to 200). A throttled
    chunk waits as ``retry`` says; ``pause`` adds a fixed gap between chunks. Items that failed are collected in
    ``result.errors`` and the rest are returned; a chunk that fails outright (a bad key, the Bridge down) raises.
    """
    size = max(1, min(int(chunk), 200))
    seen = set()
    uniq: List[str] = []
    for s in symbols:
        if s not in seen:
            seen.add(s)
            uniq.append(s)
    items: List[Any] = []
    errors: List[ItemProblem] = []
    meta: dict = {}
    for i in range(0, len(uniq), size):
        part = uniq[i : i + size]
        res: Result[T] = retry(partial(fn, part, **kw), attempts=attempts, max_wait=max_wait, sleep=bridge._sleep)
        items.extend(res)
        errors.extend(res.errors)
        meta = dict(res.meta)
        if pause and i + size < len(uniq):
            bridge._sleep(pause)
    return Result(items, meta, errors)
