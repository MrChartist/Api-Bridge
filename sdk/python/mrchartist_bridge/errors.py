"""Errors raised by the Mr. Chartist API Bridge Python client.

Everything derives from ``BridgeError``. The tree, in the order you usually catch it::

    BridgeError
    ├── BridgeApiError                 the Bridge answered with an RFC 9457 problem (``code``, ``status``, ``retryable``)
    │   ├── Unauthenticated            UNAUTHENTICATED          no key, wrong key or revoked key
    │   ├── ScopeRequired              SCOPE_REQUIRED           the key lacks a scope (``needed`` says which, when known)
    │   ├── AccountForbidden           ACCOUNT_FORBIDDEN        the key may not use that account
    │   ├── LoopbackOnly               LOOPBACK_ONLY            admin routes work from the Bridge's own computer only
    │   ├── NotFound                   NOT_FOUND ...            (SymbolNotFound, OrderNotFound, AccountNotFound)
    │   ├── ValidationFailed           VALIDATION_FAILED, INVALID_JSON
    │   ├── IdempotencyConflict        IDEMPOTENCY_KEY_REUSED, IDEMPOTENCY_IN_PROGRESS, DUPLICATE_CLIENT_ORDER_ID
    │   ├── RateLimited                RATE_LIMITED, ORDER_RATE_LIMITED, UPSTREAM_RATE_LIMITED (``scope``, ``retry_after_ms``)
    │   ├── SessionExpired             SESSION_EXPIRED          the broker login has to be renewed on the Bridge
    │   ├── OrderRefused               an order was refused before it reached the broker
    │   │   ├── InvalidOrder           INVALID_ORDER
    │   │   ├── ConfirmationRequired   CONFIRMATION_REQUIRED    a person has to approve it on the Bridge's computer
    │   │   ├── PaperOnly              PAPER_ONLY               the account or the Bridge is paper only
    │   │   ├── OrderGateClosed        ORDER_GATE_CLOSED        live trading is not switched on
    │   │   ├── DailyLimitReached      DAILY_LIMIT_REACHED
    │   │   ├── MarketClosed           MARKET_CLOSED
    │   │   ├── KillSwitchActive       KILL_SWITCH_ACTIVE
    │   │   └── CannotTrade            CANNOT_TRADE             the account is not ready to trade (session, static IP ...)
    │   ├── StateConflict              STATE_CONFLICT           for example a ticket that is no longer open (``state``)
    │   ├── CapabilityUnsupported      CAPABILITY_UNSUPPORTED, NOT_IMPLEMENTED
    │   ├── UpstreamError              UPSTREAM_ERROR, BROKER_UNAVAILABLE, UPSTREAM_TIMEOUT
    │   ├── OutcomeUnknown             OUTCOME_UNKNOWN         the Bridge cannot tell whether the broker took the order
    │   │   └── PositionUnknown        POSITION_UNKNOWN        ... so the position is unknown too
    │   └── ServerError                INTERNAL
    ├── BridgeConnectionError          no usable reply (``outcome_unknown`` is True for a write)
    │   └── BridgeNotRunning           connection refused: the Bridge is not running at that address
    ├── NotRealtime                    delayed, end-of-day or stale data offered where only real-time is allowed
    ├── LiveNotConfirmed               a live order was requested without ``live=True``
    ├── FeatureUnavailable             this Bridge does not have the route you need (an older Bridge)
    ├── ConfigurationError             no key / bad URL found by ``Bridge()``
    ├── OrderNotFilled                 an order ended rejected, cancelled or expired (``order``)
    └── WaitTimeout                    ``wait_for_fill`` or ``tickets.wait`` ran out of time (the order may still fill)

Unknown codes (the list is open) become a plain ``BridgeApiError`` with ``code`` set, so new server codes never break
old code. Every error has ``hint``: one plain sentence on how to fix it. ``str(error)`` includes it.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Type


class BridgeError(Exception):
    """Base class for every error this package raises."""

    hint: Optional[str] = None


class BridgeApiError(BridgeError):
    """The Bridge refused or failed the request and said why. ``code`` is the stable Bridge error code."""

    default_hint: Optional[str] = None

    def __init__(self, problem: Dict[str, Any], idempotency_key: Optional[str] = None, *, hint: Optional[str] = None) -> None:
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
        self.hint = hint or self.default_hint
        self.message = self.detail or self.title or "HTTP %s" % self.status
        super().__init__(self._render())

    def _render(self) -> str:
        return self.message + ((" " + self.hint) if self.hint else "")

    def with_hint(self, hint: str) -> "BridgeApiError":
        """Set the hint (used by the clients, which know whether a key was found) and refresh the message."""
        self.hint = hint
        self.args = (self._render(),)
        return self

    def __repr__(self) -> str:
        return "%s(status=%r, code=%r, retryable=%r)" % (type(self).__name__, self.status, self.code, self.retryable)


class Unauthenticated(BridgeApiError):
    """UNAUTHENTICATED: the Bridge did not accept the API key (missing, mistyped, revoked or expired)."""

    default_hint = "Check the API key: pass api_key=..., or set MCB_API_KEY. Create one with: mc-bridge keys create --label py --scope read,paper"


class ScopeRequired(BridgeApiError):
    """SCOPE_REQUIRED: the key is valid but lacks the scope this route needs."""

    default_hint = "Use a key with the scope this route needs (read, paper, live or admin): mc-bridge keys create --label py --scope read,paper"

    def __init__(self, problem: Dict[str, Any], idempotency_key: Optional[str] = None, *, hint: Optional[str] = None) -> None:
        super().__init__(problem, idempotency_key, hint=hint)
        needed = problem.get("scope") or problem.get("requiredScope") or problem.get("needed")
        self.needed: Optional[str] = needed if isinstance(needed, str) else None


class AccountForbidden(BridgeApiError):
    """ACCOUNT_FORBIDDEN: the key is limited to other accounts."""

    default_hint = "Create a key for this account (mc-bridge keys create --accounts <id>) or use an account the key may use."


class LoopbackOnly(BridgeApiError):
    """LOOPBACK_ONLY: admin routes answer only to requests from the Bridge's own computer."""

    default_hint = "This route works only from the computer the Bridge runs on (approvals and admin actions never go over the network)."


class NotFound(BridgeApiError):
    """NOT_FOUND: no such route or record."""


class SymbolNotFound(NotFound):
    """SYMBOL_NOT_FOUND."""

    default_hint = "Check the symbol format EXCHANGE:NAME, for example NSE:RELIANCE; bridge.symbols.resolve(...) finds it."


class OrderNotFound(NotFound):
    """ORDER_NOT_FOUND."""


class AccountNotFound(NotFound):
    """ACCOUNT_NOT_FOUND."""

    default_hint = "List the account ids with bridge.accounts()."


class ValidationFailed(BridgeApiError):
    """VALIDATION_FAILED or INVALID_JSON: the request was malformed. ``errors`` lists the fields."""


class IdempotencyConflict(BridgeApiError):
    """The idempotency key or client order id was already used (for something else, or still in progress)."""


class RateLimited(BridgeApiError):
    """A throttling refusal. ``scope`` says which limit tripped (client, upstream, queue, consumer-cap),
    ``retry_after_ms`` when to try again and ``limit`` the limit that tripped. Read these, not the text."""

    def __init__(self, problem: Dict[str, Any], idempotency_key: Optional[str] = None, *, hint: Optional[str] = None) -> None:
        self.scope: Optional[str] = problem.get("scope") if isinstance(problem.get("scope"), str) else None
        self.limit: Optional[Dict[str, Any]] = problem.get("limit") if isinstance(problem.get("limit"), dict) else None
        super().__init__(problem, idempotency_key, hint=hint)
        if hint is None:
            wait = self.retry_after_ms
            when = " in %.1f s" % (wait / 1000.0) if wait is not None else " after a short wait"
            who = {
                "client": "This API key's own quota is used up",
                "upstream": "The broker's limit (shared by everything on the Bridge) is reached",
                "queue": "The Bridge's queue for that account is full",
                "consumer-cap": "This key already has its share of the queue",
            }.get(self.scope or "", "A rate limit was reached")
            self.with_hint("%s; try again%s." % (who, when))


class SessionExpired(BridgeApiError):
    """SESSION_EXPIRED: the broker login expired."""

    default_hint = "Sign in to the broker again on the Bridge (dashboard, Accounts)."


class OrderRefused(BridgeApiError):
    """An order was refused before it reached the broker. Nothing was placed."""


class InvalidOrder(OrderRefused):
    """INVALID_ORDER: the order failed validation (lot size, price band, quantity caps ...). ``errors`` says why."""


class ConfirmationRequired(OrderRefused):
    """CONFIRMATION_REQUIRED: a person has to approve this order on the Bridge's computer."""

    default_hint = "Approve it on the computer running the Bridge (dashboard, Pending confirmations). Approval never happens from code."

    def __init__(self, problem: Dict[str, Any], idempotency_key: Optional[str] = None, *, hint: Optional[str] = None) -> None:
        super().__init__(problem, idempotency_key, hint=hint)
        tid = problem.get("ticketId")
        self.ticket_id: Optional[str] = tid if isinstance(tid, str) else None


class PaperOnly(OrderRefused):
    """PAPER_ONLY."""

    default_hint = "The account or the Bridge is paper only. Live trading is switched on in bridge.config.json, never from code."


class OrderGateClosed(OrderRefused):
    """ORDER_GATE_CLOSED: live trading is not switched on for this account."""

    default_hint = "Live trading is off for this account in bridge.config.json; paper orders still work."


class DailyLimitReached(OrderRefused):
    """DAILY_LIMIT_REACHED."""


class MarketClosed(OrderRefused):
    """MARKET_CLOSED."""


class KillSwitchActive(OrderRefused):
    """KILL_SWITCH_ACTIVE."""

    default_hint = "The kill switch is on. Release it on the Bridge's computer (dashboard, Safety)."


class CannotTrade(OrderRefused):
    """CANNOT_TRADE: the account is not ready to trade (broker session, static IP, headroom)."""

    default_hint = "See bridge.readiness() or the dashboard's Readiness page for the reason."


class StateConflict(BridgeApiError):
    """STATE_CONFLICT. On a ticket route ``state`` is rejected, confirmed, consumed or expired."""

    def __init__(self, problem: Dict[str, Any], idempotency_key: Optional[str] = None, *, hint: Optional[str] = None) -> None:
        self.state: Optional[str] = problem.get("state") if isinstance(problem.get("state"), str) else None
        self.ticket_id: Optional[str] = problem.get("ticketId") if isinstance(problem.get("ticketId"), str) else None
        super().__init__(problem, idempotency_key, hint=hint)


class CapabilityUnsupported(BridgeApiError):
    """CAPABILITY_UNSUPPORTED / NOT_IMPLEMENTED: the broker or this Bridge does not do that."""


class UpstreamError(BridgeApiError):
    """The broker or a data source failed or timed out (UPSTREAM_ERROR, BROKER_UNAVAILABLE, UPSTREAM_TIMEOUT)."""


class OutcomeUnknown(BridgeApiError):
    """OUTCOME_UNKNOWN: the Bridge could not tell whether the broker accepted the order.

    Never send the order again as a new order. ``Orders.place`` reconciles for you (by client order id); by hand:
    ``bridge.orders.reconcile(client_order_id)``, or resend with the same idempotency key.
    """

    default_hint = "Do not send it again as a new order: check the order book (bridge.orders.reconcile) or resend with the same idempotency key."

    def __init__(self, problem: Dict[str, Any], idempotency_key: Optional[str] = None, *, hint: Optional[str] = None, client_order_id: Optional[str] = None) -> None:
        super().__init__(problem, idempotency_key, hint=hint)
        self.client_order_id = client_order_id


class PositionUnknown(OutcomeUnknown):
    """POSITION_UNKNOWN: the position could not be read, or an order's outcome stayed unknown. Never treat it as flat."""

    default_hint = "Read the broker's positions yourself before sizing another order for this symbol."


class ServerError(BridgeApiError):
    """INTERNAL: a bug or failure inside the Bridge."""


class BridgeConnectionError(BridgeError):
    """No reply from the Bridge. For writes the outcome is unknown: check before sending again, or resend with the same ``idempotency_key``."""

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
        self.client_order_id: Optional[str] = None


class BridgeNotRunning(BridgeConnectionError):
    """The connection was refused: nothing listens at the Bridge's address."""

    hint = "Start it with: mc-bridge start (or mc-bridge start --demo for sample data), or check MCB_BRIDGE_URL."


class NotRealtime(BridgeError):
    """Delayed, end-of-day, unofficial or stale data was offered where only real-time data may be used (orders, risk,
    paper fills, alerts). ``freshness`` holds the label that failed."""

    def __init__(self, message: str, freshness: Any = None) -> None:
        super().__init__(message)
        self.freshness = freshness


class LiveNotConfirmed(BridgeError):
    """A live order was requested without ``live=True``."""


class FeatureUnavailable(BridgeError):
    """This Bridge does not serve the route the call needs (it is probably older than this library)."""

    def __init__(self, message: str, *, method: str = "", path: str = "") -> None:
        super().__init__(message)
        self.method = method
        self.path = path


class ConfigurationError(BridgeError):
    """``Bridge()`` could not work out where the Bridge is or which key to use."""


class OrderNotFilled(BridgeError):
    """An order ended without filling (rejected, cancelled or expired). ``order`` is its final state."""

    def __init__(self, message: str, order: Any = None) -> None:
        super().__init__(message)
        self.order = order


class WaitTimeout(BridgeError):
    """A wait ran out of time. The thing waited for (an order, a ticket) is unchanged and may still complete: look again."""

    def __init__(self, message: str, last: Any = None) -> None:
        super().__init__(message)
        self.last = last


#: problem ``code`` -> class. Anything not listed becomes a plain BridgeApiError.
_BY_CODE: Dict[str, Type[BridgeApiError]] = {
    "UNAUTHENTICATED": Unauthenticated,
    "SCOPE_REQUIRED": ScopeRequired,
    "ACCOUNT_FORBIDDEN": AccountForbidden,
    "LOOPBACK_ONLY": LoopbackOnly,
    "NOT_FOUND": NotFound,
    "ACCOUNT_NOT_FOUND": AccountNotFound,
    "SYMBOL_NOT_FOUND": SymbolNotFound,
    "ORDER_NOT_FOUND": OrderNotFound,
    "VALIDATION_FAILED": ValidationFailed,
    "INVALID_JSON": ValidationFailed,
    "IDEMPOTENCY_KEY_REUSED": IdempotencyConflict,
    "IDEMPOTENCY_IN_PROGRESS": IdempotencyConflict,
    "DUPLICATE_CLIENT_ORDER_ID": IdempotencyConflict,
    "RATE_LIMITED": RateLimited,
    "ORDER_RATE_LIMITED": RateLimited,
    "UPSTREAM_RATE_LIMITED": RateLimited,
    "SESSION_EXPIRED": SessionExpired,
    "INVALID_ORDER": InvalidOrder,
    "CONFIRMATION_REQUIRED": ConfirmationRequired,
    "PAPER_ONLY": PaperOnly,
    "ORDER_GATE_CLOSED": OrderGateClosed,
    "DAILY_LIMIT_REACHED": DailyLimitReached,
    "MARKET_CLOSED": MarketClosed,
    "KILL_SWITCH_ACTIVE": KillSwitchActive,
    "CANNOT_TRADE": CannotTrade,
    "STATE_CONFLICT": StateConflict,
    "CAPABILITY_UNSUPPORTED": CapabilityUnsupported,
    "NOT_IMPLEMENTED": CapabilityUnsupported,
    "UPSTREAM_ERROR": UpstreamError,
    "BROKER_UNAVAILABLE": UpstreamError,
    "UPSTREAM_TIMEOUT": UpstreamError,
    "OUTCOME_UNKNOWN": OutcomeUnknown,
    "POSITION_UNKNOWN": PositionUnknown,
    "INTERNAL": ServerError,
}


def error_from_problem(problem: Dict[str, Any], idempotency_key: Optional[str] = None) -> BridgeApiError:
    """The most specific ``BridgeApiError`` subclass for a problem+json body (by ``code``)."""
    code = str(problem.get("code") or "")
    cls = _BY_CODE.get(code)
    if cls is None:
        # A reply that is not a Bridge problem (a proxy page, an older Bridge): fall back on the HTTP status.
        cls = {401: Unauthenticated, 404: NotFound, 429: RateLimited}.get(int(problem.get("status") or 0), BridgeApiError)
    return cls(problem, idempotency_key)
