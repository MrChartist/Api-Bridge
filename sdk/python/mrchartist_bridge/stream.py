"""Live stream for the Mr. Chartist API Bridge (docs/asyncapi.yaml), standard library only.

    with bridge.stream(["NSE:NIFTY"], mode="ltp") as s:
        for msg in s:                      # blocks; reconnects by itself
            if msg["type"] == "tick":
                print(msg["symbol"], msg["ltp"])

Each connection uses a fresh single-use token from ``POST /v1/stream/token``, so the API key never appears in a URL.
After a drop (or a ``go_away`` from a restarting Bridge) it reconnects with exponential back-off and jitter, then
re-subscribes everything it was asked for. Messages carry a per-connection ``seq``; a gap means ticks were conflated
for a slow reader (the newest value always arrives): it is counted in ``gaps`` and passed to ``on_gap``.

``close()`` may be called from another thread to stop an iterating loop.

The WebSocket client here is a minimal RFC 6455 implementation (text frames, ping/pong, close, fragmentation; no
extensions), enough for the Bridge's JSON stream without adding a dependency.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import socket
import ssl
import struct
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable, Dict, Iterator, List, Optional, Sequence, Tuple, Union

from .errors import BridgeApiError

if TYPE_CHECKING:  # pragma: no cover
    from .client import BridgeClient

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_MAX_FRAME = 16 * 1024 * 1024


class WebSocketClosed(Exception):
    """The WebSocket connection ended."""


class WebSocket:
    """Minimal blocking WebSocket client (RFC 6455)."""

    def __init__(self, url: str, *, timeout: float = 45.0) -> None:
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ("ws", "wss"):
            raise ValueError("WebSocket URL must start with ws:// or wss://")
        host = u.hostname or "127.0.0.1"
        port = u.port or (443 if u.scheme == "wss" else 80)
        path = (u.path or "/") + (("?" + u.query) if u.query else "")
        sock = socket.create_connection((host, port), timeout=timeout)
        if u.scheme == "wss":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        self._sock = sock
        self._buf = b""
        self._send_lock = threading.Lock()
        self.closed = False
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_header = host if u.port is None else "%s:%d" % (host, port)
        req = (
            "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, host_header, key)
        )
        sock.sendall(req.encode("ascii"))
        head = self._read_until(b"\r\n\r\n", limit=16384)
        lines = head.decode("latin-1").split("\r\n")
        status = lines[0].split(" ")
        if len(status) < 2 or status[1] != "101":
            sock.close()
            raise WebSocketClosed("Handshake refused: %s" % lines[0])
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        expected = base64.b64encode(hashlib.sha1((key + _GUID).encode("ascii")).digest()).decode("ascii")
        if headers.get("sec-websocket-accept") != expected:
            sock.close()
            raise WebSocketClosed("Handshake failed: bad Sec-WebSocket-Accept")

    def _read_until(self, marker: bytes, limit: int) -> bytes:
        while marker not in self._buf:
            if len(self._buf) > limit:
                raise WebSocketClosed("Handshake reply too large")
            chunk = self._sock.recv(4096)
            if not chunk:
                raise WebSocketClosed("Connection closed during handshake")
            self._buf += chunk
        head, _, rest = self._buf.partition(marker)
        self._buf = rest
        return head

    def _read_exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self._sock.recv(max(4096, n - len(self._buf)))
            if not chunk:
                raise WebSocketClosed("Connection closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self._send_lock:
            self._sock.sendall(bytes(header) + mask + masked)

    def send_text(self, text: str) -> None:
        if self.closed:
            raise WebSocketClosed("Connection closed")
        self._send_frame(0x1, text.encode("utf-8"))

    def recv(self) -> str:
        """Next text message. Answers pings; raises WebSocketClosed at the end of the connection."""
        parts: List[bytes] = []
        while True:
            b1, b2 = self._read_exact(2)
            fin, opcode = b1 & 0x80, b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read_exact(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read_exact(8))[0]
            if n > _MAX_FRAME:
                raise WebSocketClosed("Frame too large")
            mask = self._read_exact(4) if b2 & 0x80 else None
            payload = self._read_exact(n)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x9:  # ping
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x8:  # close
                try:
                    self._send_frame(0x8, payload[:2])
                except OSError:
                    pass
                self.close()
                raise WebSocketClosed("Closed by the server")
            if opcode in (0x1, 0x0, 0x2):
                parts.append(payload)
                if fin:
                    return b"".join(parts).decode("utf-8", errors="replace")

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            self._send_frame(0x8, struct.pack("!H", 1000))
        except OSError:
            pass
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._sock.close()


class BridgeStream:
    """Iterable live stream with automatic reconnect and re-subscribe."""

    def __init__(
        self,
        client: "BridgeClient",
        *,
        symbols: Sequence[str] = (),
        mode: str = "ltp",
        orders: Union[bool, Sequence[str]] = False,
        reconnect: bool = True,
        max_backoff: float = 30.0,
        recv_timeout: float = 45.0,
        on_gap: Optional[Callable[[int, int], None]] = None,
        on_reconnect: Optional[Callable[[int], None]] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.client = client
        self.subscriptions: Dict[str, str] = {s: mode for s in symbols}
        self.orders = orders
        self.reconnect = reconnect
        self.max_backoff = max_backoff
        self.recv_timeout = recv_timeout
        self.on_gap = on_gap
        self.on_reconnect = on_reconnect
        self.gaps = 0
        self.reconnects = 0
        self.conflated = 0
        """Ticks the Bridge replaced with newer ones for this slow reader, summed from its heartbeats (the newest value always arrived)."""
        self.connected = False
        self._handlers: Dict[str, List[Callable[[Dict[str, Any]], None]]] = {}
        self._sleep = sleep
        self._ws: Optional[WebSocket] = None
        self._closed = threading.Event()
        self._last_seq = 0
        self._attempt = 0
        self._go_away_delay: Optional[float] = None

    # context manager
    def __enter__(self) -> "BridgeStream":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def _connect(self) -> None:
        url = self.client.stream_url()
        self._ws = WebSocket(url, timeout=self.recv_timeout)
        self._last_seq = 0
        self.connected = True
        self._resubscribe()
        if self.reconnects and self.on_reconnect:
            self.on_reconnect(self.reconnects)

    def _send(self, obj: Dict[str, Any]) -> None:
        ws = self._ws
        if ws is not None and not ws.closed:
            ws.send_text(json.dumps(obj))

    def _resubscribe(self) -> None:
        by_mode: Dict[str, List[str]] = {}
        for sym, mode in self.subscriptions.items():
            by_mode.setdefault(mode, []).append(sym)
        for mode, syms in by_mode.items():
            for i in range(0, len(syms), 500):
                self._send({"op": "subscribe", "symbols": syms[i : i + 500], "mode": mode})
        if self.orders:
            self._send({"op": "subscribe_orders", "accounts": list(self.orders)} if not isinstance(self.orders, bool) else {"op": "subscribe_orders"})

    def subscribe(self, symbols: Union[str, Sequence[str]], mode: str = "ltp") -> None:
        syms = [symbols] if isinstance(symbols, str) else list(symbols)
        for s in syms:
            self.subscriptions[s] = mode
        self._send({"op": "subscribe", "symbols": syms, "mode": mode})

    def unsubscribe(self, symbols: Union[str, Sequence[str]]) -> None:
        syms = [symbols] if isinstance(symbols, str) else list(symbols)
        for s in syms:
            self.subscriptions.pop(s, None)
        self._send({"op": "unsubscribe", "symbols": syms})

    def ping(self) -> None:
        self._send({"op": "ping"})

    def close(self) -> None:
        """Stop for good (safe from another thread)."""
        self._closed.set()
        ws = self._ws
        if ws is not None:
            ws.close()

    def _wait_before_reconnect(self) -> None:
        if self._go_away_delay is not None:
            wait, self._go_away_delay = self._go_away_delay, None
        else:
            base = min(self.max_backoff, 0.5 * (2 ** self._attempt))
            wait = base + random.random() * base * 0.5
        self._attempt += 1
        self.reconnects += 1
        self._closed.wait(wait) if self._sleep is time.sleep else self._sleep(wait)

    # callback API

    def on(self, type_: str, handler: Callable[[Dict[str, Any]], None]) -> "BridgeStream":
        """Register ``handler(message)`` for messages of one ``type`` ("tick", "order", "snapshot", "status", "error",
        "heartbeat", "go_away", or "*" for all). Returns the stream, so calls chain. Run them with ``run()``."""
        self._handlers.setdefault(type_, []).append(handler)
        return self

    def run(self, *, max_messages: Optional[int] = None) -> int:
        """Iterate the stream and call the registered handlers until ``close()`` (from a handler or another thread) or
        ``max_messages``. Returns the number of messages handled. A handler that raises stops the run (and closes the stream)."""
        n = 0
        try:
            for msg in self:
                for h in self._handlers.get(msg.get("type", ""), []) + self._handlers.get("*", []):
                    h(msg)
                n += 1
                if max_messages is not None and n >= max_messages:
                    break
        finally:
            if max_messages is not None and n >= max_messages:
                self.close()
        return n

    def events(self) -> Iterator["StreamEvent"]:
        """Like iterating the stream, but each message is a typed event (``Tick``, ``OrderUpdate``, ``Snapshot`` ...)."""
        for msg in self:
            yield parse_event(msg)

    def __iter__(self) -> Iterator[Dict[str, Any]]:
        while not self.closed:
            if self._ws is None or self._ws.closed:
                try:
                    self._connect()
                    self._attempt = 0
                except BridgeApiError as e:
                    if not e.retryable and 400 <= e.status < 500 and e.status != 429:
                        self.close()
                        raise
                    if not self.reconnect:
                        self.close()
                        raise
                    self._wait_before_reconnect()
                    continue
                except (OSError, WebSocketClosed):
                    if self.closed or not self.reconnect:
                        self.close()
                        return
                    self._wait_before_reconnect()
                    continue
            try:
                raw = self._ws.recv()  # type: ignore[union-attr]
            except (OSError, WebSocketClosed):
                self.connected = False
                if self._ws is not None:
                    self._ws.close()
                if self.closed or not self.reconnect:
                    self._closed.set()
                    return
                self._wait_before_reconnect()
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            seq = msg.get("seq")
            if isinstance(seq, int):
                if self._last_seq and seq != self._last_seq + 1:
                    self.gaps += 1
                    if self.on_gap:
                        self.on_gap(self._last_seq + 1, seq)
                self._last_seq = seq
            if msg.get("type") == "heartbeat" and isinstance(msg.get("conflated"), int):
                self.conflated += msg["conflated"]
            if msg.get("type") == "go_away":
                try:
                    self._go_away_delay = max(0.0, float(msg.get("reconnectAfterMs") or 0) / 1000.0)
                except (TypeError, ValueError):
                    self._go_away_delay = None
            yield msg


# ── typed events ───────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class StreamEvent:
    """Base of the typed events. ``seq`` is the per-connection counter; ``raw`` the message as the Bridge sent it."""

    seq: Optional[int]
    raw: Dict[str, Any] = field(repr=False, compare=False)


@dataclass(frozen=True)
class Tick(StreamEvent):
    """A price update. Stream data is real-time and official (it comes from a live broker feed): there is no delayed stream."""

    symbol: str = ""
    ltp: float = 0.0
    received_at: Optional[datetime] = None
    exchange_ts: Optional[datetime] = None
    account_id: Optional[str] = None
    broker: Optional[str] = None
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    close: Optional[float] = None
    change_pct: Optional[float] = None
    volume: Optional[float] = None
    oi: Optional[float] = None
    bid: Optional[float] = None
    ask: Optional[float] = None

    @property
    def age_ms(self) -> Optional[float]:
        """How old this tick is now (since the Bridge received it)."""
        return None if self.received_at is None else (datetime.now(timezone.utc) - self.received_at).total_seconds() * 1000.0


@dataclass(frozen=True)
class Snapshot(StreamEvent):
    mode: str = "ltp"
    symbols: Tuple[str, ...] = ()
    ticks: Tuple[Tick, ...] = ()
    pending: Tuple[str, ...] = ()


@dataclass(frozen=True)
class OrderUpdate(StreamEvent):
    order_id: str = ""
    account_id: str = ""
    status: str = ""
    mode: str = "paper"
    client_order_id: Optional[str] = None
    filled_quantity: Optional[float] = None
    avg_price: Optional[float] = None

    @property
    def is_filled(self) -> bool:
        return self.status == "filled"


@dataclass(frozen=True)
class Heartbeat(StreamEvent):
    conflated: int = 0


@dataclass(frozen=True)
class FeedStatus(StreamEvent):
    account_id: str = ""
    broker: str = ""
    state: str = ""
    connected: bool = False
    reason: Optional[str] = None


@dataclass(frozen=True)
class StreamProblem(StreamEvent):
    code: str = ""
    message: str = ""
    retryable: bool = False


@dataclass(frozen=True)
class GoAway(StreamEvent):
    reason: str = ""
    reconnect_after_ms: Optional[int] = None


@dataclass(frozen=True)
class OtherEvent(StreamEvent):
    """A message type this library does not model (``budget`` and any newer one). Read ``raw``."""

    type: str = ""


def _tick(m: Dict[str, Any], seq: Optional[int]) -> Tick:
    def n(k: str) -> Optional[float]:
        v = m.get(k)
        return None if v is None or isinstance(v, bool) else float(v)

    def ms(k: str) -> Optional[datetime]:
        v = m.get(k)
        return None if v is None else datetime.fromtimestamp(float(v) / 1000.0, tz=timezone.utc)

    return Tick(seq, m, str(m.get("symbol")), float(m.get("ltp") or 0), ms("receivedAt"), ms("exchangeTs"), m.get("accountId"), m.get("broker"), n("open"), n("high"), n("low"), n("close"), n("changePct"), n("volume"), n("oi"), n("bid"), n("ask"))


def parse_event(m: Dict[str, Any]) -> StreamEvent:
    """A typed event from a stream message (see docs/asyncapi.yaml)."""
    t = m.get("type")
    seq = m.get("seq") if isinstance(m.get("seq"), int) else None
    if t == "tick":
        return _tick(m, seq)
    if t == "snapshot":
        return Snapshot(seq, m, str(m.get("mode") or "ltp"), tuple(m.get("symbols") or ()), tuple(_tick(x, seq) for x in m.get("ticks") or [] if isinstance(x, dict)), tuple(m.get("pending") or ()))
    if t == "order" and isinstance(m.get("order"), dict):
        o = m["order"]
        return OrderUpdate(seq, m, str(o.get("orderId")), str(o.get("accountId")), str(o.get("status")), str(o.get("mode") or "paper"), o.get("clientOrderId"), o.get("filledQuantity"), o.get("avgPrice"))
    if t == "heartbeat":
        return Heartbeat(seq, m, int(m.get("conflated") or 0))
    if t == "status":
        return FeedStatus(seq, m, str(m.get("accountId")), str(m.get("broker")), str(m.get("state")), bool(m.get("connected")), m.get("reason"))
    if t == "error":
        return StreamProblem(seq, m, str(m.get("code")), str(m.get("message")), bool(m.get("retryable")))
    if t == "go_away":
        return GoAway(seq, m, str(m.get("reason")), m.get("reconnectAfterMs"))
    return OtherEvent(seq, m, str(t))
