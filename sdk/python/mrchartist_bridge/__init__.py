"""Python library for the Mr. Chartist API Bridge: market data, paper and live orders, live streams.

The Bridge is a program on your own computer that holds your broker logins and serves one local API (default
``http://127.0.0.1:4300``). This package is the Python side of it: standard library only, Python 3.9+, typed
(``py.typed``), safe by default (paper unless you say ``live=True``; real-time data only for orders).

    from mrchartist_bridge import Bridge

    bridge = Bridge()                                     # finds the URL and key (see mrchartist_bridge.discovery)
    bridge.ping()                                         # Ping(ok=True, latency_ms=3.1, ...)
    q = bridge.quote("NSE:RELIANCE")                      # Quote(ltp=..., freshness=Freshness(...))
    q.require_realtime()                                  # NotRealtime for delayed, end-of-day or stale data
    o = bridge.orders.place("NSE:RELIANCE", "BUY", quantity=1, product="CNC", price=q)   # paper order
    bridge.orders.wait_for_fill(o)
    bridge.history("NSE:RELIANCE", "1d", countback=250).to_dataframe()     # pip install mrchartist-bridge[pandas]

What is here (names importable from this package):

* ``Bridge``, ``AsyncBridge``: typed clients (``bridge.orders``, ``bridge.tickets``, ``bridge.symbols``, ``bridge.calendar``,
  ``bridge.hooks``, ``bridge.xl``). ``Bridge.demo()`` connects to a demo-mode Bridge.
* ``BridgeClient``: the original dict-returning client, unchanged (every route, one method each).
* Records (frozen dataclasses): ``Quote``, ``Ltp``, ``Candle``, ``History``, ``Depth``, ``Position``, ``Holding``, ``Funds``,
  ``Order``, ``Trade``, ``Instrument``, ``Source``, ``Freshness`` ... and ``Result`` (a list that also carries ``errors``).
* Errors: ``BridgeError`` and a typed tree (``RateLimited``, ``OutcomeUnknown``, ``ScopeRequired`` ...): see ``errors``.
* Streams: ``bridge.stream(...)`` (sync iterator with reconnect, gap detection and typed events) and
  ``AsyncBridge().stream(...)``.
* Data you keep: ``bridge.downloads`` (create, wait, save, read), ``bridge.datasets`` (incremental update, read),
  ``bridge.recordings`` (+ ``.rules`` for auto-record), ``bridge.collections`` (named symbol lists and option universes),
  ``bridge.history_all(...)`` (candles over any range, ``local_first=True`` to save API calls): see ``data`` and ``longhistory``.
* Events out: ``bridge.events.subscribe(...)`` (reconnects, resumes from a cursor), ``bridge.subscriptions`` (signed webhooks)
  and ``verify_signature`` for receivers: see ``events``.
* Helpers: ``frames`` (DataFrames, CSV, optional Parquet), ``batching`` (retry that honours Retry-After, many-symbol fetches), ``alerts``
  (alert messages for hooks, provisional).

Data is for personal use: broker data terms generally forbid passing market data to other people.
"""

from .aio import AsyncBridge, AsyncStream
from .bridge import Bridge, Features
from .client import DEFAULT_BASE_URL, BridgeClient, Response, new_idempotency_key, to_query
from .data import (
    Collection,
    Collections,
    DataFile,
    Dataset,
    Datasets,
    BudgetSettings,
    DownloadEstimate,
    DownloadItem,
    FailureReason,
    DownloadJob,
    DownloadProgress,
    Downloads,
    PresetResult,
    Recording,
    RecordingPreset,
    RecordingRule,
    RecordingRules,
    RecordingStatus,
    Recordings,
    Resolution,
    SavedCalls,
    SavedFile,
    Subscription,
    Subscriptions,
    option_universe,
)
from .discovery import Settings, discover, save_credentials
from .errors import (
    AccountForbidden,
    AccountNotFound,
    BridgeApiError,
    BridgeConnectionError,
    BridgeError,
    BridgeNotRunning,
    CannotTrade,
    CapabilityUnsupported,
    ChecksumMismatch,
    ConfigurationError,
    ConfirmationRequired,
    DailyLimitReached,
    DownloadFailed,
    FeatureUnavailable,
    IdempotencyConflict,
    InvalidOrder,
    KillSwitchActive,
    LiveNotConfirmed,
    LoopbackOnly,
    MarketClosed,
    NotFound,
    NotRealtime,
    OrderGateClosed,
    OrderNotFilled,
    OrderNotFound,
    OrderRefused,
    OutcomeUnknown,
    PaperOnly,
    PositionUnknown,
    RateLimited,
    ScopeRequired,
    ServerError,
    SessionExpired,
    SignatureInvalid,
    StateConflict,
    SymbolNotFound,
    Unauthenticated,
    UpstreamError,
    ValidationFailed,
    WaitTimeout,
    error_from_problem,
)
from .events import Event, EventPage, EventSubscription, Events, sign_payload, verify_request, verify_signature
from .longhistory import HistoryIter
from .orders import BatchItem, BatchResult, Orders, TargetResult, Tickets
from .records import (
    IST,
    Account,
    Candle,
    Check,
    Depth,
    DepthLevel,
    Freshness,
    Funds,
    Health,
    History,
    Holding,
    Instrument,
    ItemProblem,
    Ltp,
    Order,
    Ping,
    Position,
    Preview,
    Quote,
    Result,
    Source,
    Ticket,
    TicketOutcome,
    Trade,
)
from .stream import BridgeStream, FeedStatus, GoAway, Heartbeat, OrderUpdate, Snapshot, StreamEvent, Tick, WebSocket, WebSocketClosed, parse_event

__all__ = [
    "ChecksumMismatch", "Collection", "Collections", "DataFile", "Dataset", "Datasets", "DownloadFailed", "DownloadItem", "DownloadJob", "DownloadProgress", "Downloads", "Event", "EventSubscription", "FailureReason",
    "BudgetSettings", "DownloadEstimate", "EventPage", "Events", "HistoryIter", "PresetResult", "Recording", "RecordingPreset", "RecordingRule", "RecordingRules", "RecordingStatus", "Recordings", "Resolution", "SavedCalls", "SavedFile", "SignatureInvalid", "Subscription", "Subscriptions", "option_universe",
    "sign_payload", "verify_request", "verify_signature",
    "Account", "AccountForbidden", "AccountNotFound", "AsyncBridge", "AsyncStream", "BatchItem", "BatchResult", "Bridge", "BridgeApiError", "BridgeClient", "BridgeConnectionError",
    "BridgeError", "BridgeNotRunning", "BridgeStream", "Candle", "CannotTrade", "CapabilityUnsupported", "Check", "ConfigurationError", "ConfirmationRequired", "DEFAULT_BASE_URL",
    "DailyLimitReached", "Depth", "DepthLevel", "FeatureUnavailable", "Features", "FeedStatus", "Freshness", "Funds", "GoAway", "Health", "Heartbeat", "History", "Holding", "IST",
    "IdempotencyConflict", "Instrument", "InvalidOrder", "ItemProblem", "KillSwitchActive", "LiveNotConfirmed", "LoopbackOnly", "Ltp", "MarketClosed", "NotFound", "NotRealtime",
    "Order", "OrderGateClosed", "OrderNotFilled", "OrderNotFound", "OrderRefused", "OrderUpdate", "Orders", "OutcomeUnknown", "PaperOnly", "Ping", "Position", "PositionUnknown",
    "Preview", "Quote", "RateLimited", "Response", "Result", "ScopeRequired", "ServerError", "SessionExpired", "Settings", "Snapshot", "Source", "StateConflict", "StreamEvent",
    "SymbolNotFound", "TargetResult", "Tick", "Ticket", "TicketOutcome", "Tickets", "Trade", "Unauthenticated", "UpstreamError", "ValidationFailed", "WaitTimeout", "WebSocket",
    "WebSocketClosed", "discover", "error_from_problem", "new_idempotency_key", "parse_event", "save_credentials", "to_query",
]

__version__ = "0.3.0"
