"""Python client for the Mr. Chartist API Bridge.

See README.md. Standard library only; Python 3.9+.
"""

from .client import DEFAULT_BASE_URL, BridgeClient, Response, new_idempotency_key, to_query
from .errors import BridgeApiError, BridgeConnectionError, BridgeError
from .stream import BridgeStream, WebSocket, WebSocketClosed

__all__ = [
    "DEFAULT_BASE_URL",
    "BridgeApiError",
    "BridgeClient",
    "BridgeConnectionError",
    "BridgeError",
    "BridgeStream",
    "Response",
    "WebSocket",
    "WebSocketClosed",
    "new_idempotency_key",
    "to_query",
]

__version__ = "0.1.0"
