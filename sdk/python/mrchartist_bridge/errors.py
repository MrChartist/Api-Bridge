"""Errors raised by the Mr. Chartist API Bridge Python client.

* ``BridgeApiError``: the Bridge answered with an RFC 9457 problem (or another non-2xx reply). ``code`` is the stable
  Bridge error code and ``retryable`` says whether exactly the same request may be sent again.
* ``BridgeConnectionError``: no usable reply (connection refused or reset, timeout). For a write,
  ``outcome_unknown`` is True: the Bridge may have acted on it. Check the order book, or resend with the SAME
  ``idempotency_key`` (the Bridge de-duplicates it), instead of sending a fresh order.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


class BridgeError(Exception):
    """Base class for every error this package raises."""


class BridgeApiError(BridgeError):
    """The Bridge refused or failed the request and said why."""

    def __init__(self, problem: Dict[str, Any], idempotency_key: Optional[str] = None) -> None:
        self.problem = problem
        self.status: int = int(problem.get("status") or 0)
        self.code: str = str(problem.get("code") or "UNKNOWN")
        self.title: Optional[str] = problem.get("title")
        self.detail: Optional[str] = problem.get("detail")
        self.retryable: bool = problem.get("retryable") is True
        self.request_id: Optional[str] = problem.get("requestId")
        self.retry_after_ms: Optional[float] = problem.get("retryAfterMs")
        self.broker: Optional[Dict[str, Any]] = problem.get("broker")
        self.errors: Optional[List[Dict[str, str]]] = problem.get("errors")
        self.idempotency_key = idempotency_key
        super().__init__(self.detail or self.title or "HTTP %s" % self.status)

    def __repr__(self) -> str:
        return "BridgeApiError(status=%r, code=%r, retryable=%r)" % (self.status, self.code, self.retryable)


class BridgeConnectionError(BridgeError):
    """No reply from the Bridge. For writes the outcome is unknown."""

    def __init__(
        self,
        message: str,
        *,
        method: str,
        path: str,
        outcome_unknown: bool,
        idempotency_key: Optional[str] = None,
        timed_out: bool = False,
    ) -> None:
        super().__init__(message)
        self.method = method
        self.path = path
        self.outcome_unknown = outcome_unknown
        self.idempotency_key = idempotency_key
        self.timed_out = timed_out
