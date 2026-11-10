"""Events out: react to what the Bridge does without polling (``bridge.events``), and check signed webhooks.

    for ev in bridge.events.subscribe(["download.*", "recording.gap"]):
        print(ev.cursor, ev.topic, ev.data)

``subscribe`` reads the Bridge's event stream (``GET /v1/events/stream``, Server-Sent Events). It reconnects by itself
with growing waits after a drop and asks for everything after the last event it saw (``since=<cursor>``, and the
``Last-Event-ID`` header), so a restart of the Bridge or of your network loses nothing the Bridge still keeps. Keep the
``ev.cursor`` somewhere if you want to continue after your own program restarts: ``subscribe(since=saved_cursor)``.
A read key sees only the events a read key may see; admin events need an admin key.

Webhooks (the Bridge posts to your URL) are managed with ``bridge.subscriptions``. Every delivery carries the headers
``X-Bridge-Signature: v1=<hex>`` and ``X-Bridge-Timestamp: <unix seconds>`` (also ``X-Bridge-Event-Id``, ``X-Bridge-Delivery``,
``X-Bridge-Attempt``): the hex is HMAC-SHA256 of ``"<timestamp>." + the exact raw body`` with your secret. Check it with
``verify_signature`` before you trust the body, and answer 401 when it fails::

    ok = verify_signature(SECRET, raw_body_bytes, request.headers)        # or timestamp=..., signature=...

Use the raw bytes as received: re-serialising parsed JSON changes them. A timestamp more than 5 minutes from your clock
fails (replay protection; this helper keeps no memory: de-duplicate on ``X-Bridge-Event-Id``, delivery is at least once). A
secret being replaced makes the Bridge send several ``v1=`` values: any one may match, and you may pass a list of secrets.
Standard library only.
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import random
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple, Union

from .errors import BridgeApiError, BridgeConnectionError, SignatureInvalid
from .records import parse_time

if TYPE_CHECKING:  # pragma: no cover
    from .bridge import Bridge

SIGNATURE_HEADER = "X-Bridge-Signature"
TIMESTAMP_HEADER = "X-Bridge-Timestamp"
EVENT_ID_HEADER = "X-Bridge-Event-Id"
EVENT_TOPIC_HEADER = "X-Bridge-Event-Topic"
DELIVERY_HEADER = "X-Bridge-Delivery"
ATTEMPT_HEADER = "X-Bridge-Attempt"
DEFAULT_TOLERANCE_SEC = 300
EVENTS_PATH = "/v1/events/stream"

_Secret = Union[str, bytes]


# ── signatures ─────────────────────────────────────────────────────────────────────────────────────────────────


def _b(v: Union[str, bytes, bytearray, memoryview, None]) -> bytes:
    if v is None:
        return b""
    if isinstance(v, str):
        return v.encode("utf-8")
    return bytes(v)


def compute_signature(secret: _Secret, timestamp: int, body: Union[str, bytes]) -> str:
    """Hex HMAC-SHA256 of ``"<timestamp>." + body``."""
    return hmac.new(_b(secret), str(int(timestamp)).encode("ascii") + b"." + _b(body), hashlib.sha256).hexdigest()


def sign_payload(secret: _Secret, body: Union[str, bytes], timestamp: Optional[int] = None) -> Dict[str, str]:
    """The two headers the Bridge sends with a delivery (``X-Bridge-Timestamp`` and ``X-Bridge-Signature: v1=<hex>``) for
    ``body``: for sending your own test deliveries to a receiver."""
    t = int(time.time() if timestamp is None else timestamp)
    return {TIMESTAMP_HEADER: str(t), SIGNATURE_HEADER: "v1=" + compute_signature(secret, t, body)}


def _signatures(header: str) -> List[str]:
    out: List[str] = []
    for part in re.split(r"[\s,]+", header.strip()):
        m = re.fullmatch(r"v1=([0-9a-fA-F]{64})", part)
        if m:
            out.append(m.group(1).lower())
    return out


def _from_headers(headers: Mapping[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    low = {str(k).lower(): v for k, v in headers.items()}
    ts, sig = low.get(TIMESTAMP_HEADER.lower()), low.get(SIGNATURE_HEADER.lower())
    return (None if ts is None else str(ts)), (None if sig is None else str(sig))


def explain_signature(
    secret: Union[_Secret, Sequence[_Secret]],
    body: Union[str, bytes],
    headers: Optional[Mapping[str, Any]] = None,
    *,
    timestamp: Optional[Union[str, int]] = None,
    signature: Optional[str] = None,
    tolerance_sec: float = DEFAULT_TOLERANCE_SEC,
    now: Optional[float] = None,
) -> Tuple[bool, str]:
    """``(ok, reason)``: ``reason`` is ``ok``, ``missing_header``, ``malformed_header``, ``timestamp_out_of_range`` or
    ``signature_mismatch``. Give the request ``headers`` (any mapping, any letter case) or ``timestamp`` and ``signature``
    yourself. Log the reason; answer the caller with a plain 401."""
    if headers is not None:
        h_ts, h_sig = _from_headers(headers)
        timestamp = h_ts if timestamp is None else timestamp
        signature = h_sig if signature is None else signature
    if timestamp in (None, "") or not signature:
        return False, "missing_header"
    ts = str(timestamp)
    sigs = _signatures(str(signature))
    if not re.fullmatch(r"\d{1,12}", ts) or not sigs:
        return False, "malformed_header"
    clock = time.time() if now is None else now
    if abs(clock - int(ts)) > tolerance_sec:
        return False, "timestamp_out_of_range"
    secrets = [secret] if isinstance(secret, (str, bytes, bytearray)) else list(secret)
    for sec in secrets:
        want = compute_signature(sec, int(ts), body)
        for got in sigs:
            if hmac.compare_digest(want, got):
                return True, "ok"
    return False, "signature_mismatch"


def verify_signature(
    secret: Union[_Secret, Sequence[_Secret]],
    body: Union[str, bytes],
    headers: Optional[Mapping[str, Any]] = None,
    *,
    timestamp: Optional[Union[str, int]] = None,
    signature: Optional[str] = None,
    tolerance_sec: float = DEFAULT_TOLERANCE_SEC,
    now: Optional[float] = None,
    raise_on_fail: bool = False,
) -> bool:
    """True when the delivery is genuine: ``signature`` (``X-Bridge-Signature``, ``v1=<hex>``) is the HMAC-SHA256 of
    ``"<timestamp>." + raw body`` made with ``secret`` (or any of several secrets), and ``timestamp``
    (``X-Bridge-Timestamp``) is within ``tolerance_sec`` of now. Pass the request ``headers`` mapping, or the two values
    as ``timestamp=`` and ``signature=``. Compared in constant time. With ``raise_on_fail=True`` a failure raises
    ``SignatureInvalid`` (its ``reason`` says which check failed) instead of returning False."""
    ok, reason = explain_signature(secret, body, headers, timestamp=timestamp, signature=signature, tolerance_sec=tolerance_sec, now=now)
    if not ok and raise_on_fail:
        raise SignatureInvalid("The webhook signature was not accepted (%s). Do not process this request." % reason, reason)
    return ok


def verify_request(secret: Union[_Secret, Sequence[_Secret]], headers: Mapping[str, Any], body: Union[str, bytes], **kw: Any) -> bool:
    """``verify_signature`` with the arguments in the order a request handler has them (headers, then raw body)."""
    return verify_signature(secret, body, headers, **kw)


# ── events ─────────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Event:
    """One event from the Bridge. ``cursor`` is the position to resume from; ``topic`` looks like ``download.done``."""

    topic: str
    data: Mapping[str, Any]
    cursor: Optional[str] = None
    time: Optional[datetime] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    def matches(self, pattern: str) -> bool:
        """``download.*`` matches ``download.done``; ``*`` matches everything."""
        return topic_matches(pattern, self.topic)


def topic_matches(pattern: str, topic: str) -> bool:
    if pattern in ("*", topic):
        return True
    return pattern.endswith(".*") and topic.startswith(pattern[:-1])


def _event_from(sse_id: Optional[str], sse_event: Optional[str], payload: str) -> Event:
    try:
        d: Any = json.loads(payload) if payload else {}
    except ValueError:
        d = {"text": payload}
    if isinstance(d, dict) and isinstance(d.get("topic"), str) and ("data" in d or "payload" in d or "cursor" in d or "id" in d):
        body = d.get("data") if "data" in d else d.get("payload")
        return Event(d["topic"], body if isinstance(body, Mapping) else {"value": body}, str(d["cursor"] if d.get("cursor") is not None else d["id"]) if (d.get("cursor") is not None or d.get("id") is not None) else sse_id, parse_time(d.get("time") or d.get("at") or d.get("ts")), dict(d))
    topic = sse_event or (d.get("type") if isinstance(d, dict) and isinstance(d.get("type"), str) else None) or "message"
    return Event(topic, d if isinstance(d, Mapping) else {"value": d}, sse_id, parse_time(d.get("time") or d.get("at")) if isinstance(d, dict) else None, d if isinstance(d, dict) else {"value": d})


def parse_sse(lines: Iterator[bytes]) -> Iterator[Tuple[Optional[str], Optional[str], str, Optional[int]]]:
    """Frames of a Server-Sent Events stream as ``(id, event, data, retry_ms)``. Comment lines (heartbeats) are skipped."""
    sid: Optional[str] = None
    ev: Optional[str] = None
    data: List[str] = []
    retry: Optional[int] = None
    for raw in lines:
        line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
        if line == "":
            if data:  # a frame with no data (only an id, or comments) is not an event
                yield sid, ev, "\n".join(data), retry
            ev, data = None, []
            continue
        if line.startswith(":"):
            continue
        k, _, v = line.partition(":")
        v = v[1:] if v.startswith(" ") else v
        if k == "id":
            sid = v
        elif k == "event":
            ev = v
        elif k == "data":
            data.append(v)
        elif k == "retry" and v.isdigit():
            retry = int(v)


class EventSubscription:
    """A live, self-reconnecting read of the Bridge's event stream. Iterate it; ``close()`` ends the iteration.

    ``cursor`` is the last event seen, ``reconnects`` how many times the connection was re-made. After a drop it waits
    (1 s doubling to ``max_backoff``, with jitter) and asks for events after ``cursor``. A problem that retrying
    cannot fix (a wrong key, a missing scope) is raised at once; so is any failure when ``reconnect=False``.
    ``idle_timeout`` is the longest silence before the connection is treated as dead (the Bridge sends heartbeats).
    """

    def __init__(
        self,
        bridge: "Bridge",
        topics: Union[str, Sequence[str], None] = None,
        since: Optional[str] = None,
        *,
        reconnect: bool = True,
        max_backoff: float = 30.0,
        idle_timeout: float = 90.0,
        max_reconnects: Optional[int] = None,
    ) -> None:
        self._b = bridge
        self.topics: List[str] = [topics] if isinstance(topics, str) else list(topics or [])
        self.cursor: Optional[str] = since
        self.reconnect = reconnect
        self.max_backoff = max_backoff
        self.idle_timeout = idle_timeout
        self.max_reconnects = max_reconnects
        self.reconnects = 0
        self.connected = False
        self.closed = False
        self._res: Any = None
        self._attempt = 0
        self.ready: Optional[Dict[str, Any]] = None
        """The Bridge's last ``ready`` message: ``cursor``, ``oldest``, ``replayed``, ``gap``, ``gapReason``, ``topics``."""
        self.gap = False
        """True when the Bridge said events were lost between your cursor and what it still keeps (``gap_reason`` is
        ``retention`` or ``cursor_ahead``). Read the current state from the API again (orders, positions), then carry on."""
        self.gap_reason: Optional[str] = None
        self.on_gap: Optional[Callable[[Optional[str]], Any]] = None

    def __enter__(self) -> "EventSubscription":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __iter__(self) -> Iterator[Event]:
        return self._run()

    def close(self) -> None:
        """Stop: the iteration ends after the event being read (or at once if it is waiting)."""
        self.closed = True
        res, self._res = self._res, None
        if res is not None:
            try:
                res.close()
            except Exception:  # noqa: BLE001
                pass

    def _delay(self, floor: float = 0.0) -> float:
        base = min(self.max_backoff, 1.0 * (2 ** min(self._attempt, 10)))
        return max(floor, base + random.random() * base * 0.25)

    def _run(self) -> Iterator[Event]:
        c = self._b.client
        retry_floor = 0.0
        while not self.closed:
            headers = {"Last-Event-ID": self.cursor} if self.cursor else None
            query = {"topics": self.topics or None, "since": self.cursor}
            try:
                res = c.open_stream("GET", EVENTS_PATH, query=query, headers=headers, accept="text/event-stream", timeout=self.idle_timeout)
            except BridgeApiError as e:
                # 4xx other than a rate limit will not get better by itself: tell the caller.
                if not self.reconnect or not (e.retryable or e.status >= 500):
                    raise
                if not self._wait_to_retry(retry_floor):
                    return
                continue
            except BridgeConnectionError:
                if not self.reconnect:
                    raise
                if not self._wait_to_retry(retry_floor):
                    return
                continue
            if self.closed:
                res.close()
                return
            self._res = res
            self.connected = True
            try:
                for sid, name, payload, retry in parse_sse(iter(res.readline, b"")):
                    self._attempt = 0
                    if retry is not None:
                        retry_floor = retry / 1000.0
                    if name == "ready":
                        try:
                            self.ready = dict(json.loads(payload or "{}"))
                        except (ValueError, TypeError):
                            self.ready = {}
                        self.gap = bool(self.ready.get("gap"))
                        self.gap_reason = self.ready.get("gapReason") if self.gap else None
                        if self.gap and self.on_gap is not None:
                            self.on_gap(self.gap_reason)
                        continue
                    if name == "go_away":  # the Bridge is closing this connection: reconnect with the cursor
                        break
                    ev = _event_from(sid, name, payload)
                    if ev.cursor:
                        self.cursor = ev.cursor
                    yield ev
                    if self.closed:
                        return
            except (OSError, http.client.HTTPException, ValueError):
                if self.closed:
                    return
            finally:
                self.connected = False
                self._res = None
                try:
                    res.close()
                except Exception:  # noqa: BLE001
                    pass
            if self.closed or not self.reconnect:
                return
            if not self._wait_to_retry(retry_floor):
                return

    def _wait_to_retry(self, floor: float) -> bool:
        self.reconnects += 1
        if self.max_reconnects is not None and self.reconnects > self.max_reconnects:
            return False
        self._b._sleep(self._delay(floor))
        self._attempt += 1
        return not self.closed


@dataclass(frozen=True)
class EventPage:
    """One answer of ``events.poll``. ``gap`` is True when events between your cursor and the oldest kept one were lost."""

    events: List[Event]
    cursor: Optional[str]
    gap: bool = False
    gap_reason: Optional[str] = None
    has_more: bool = False

    def __iter__(self) -> Iterator[Event]:
        return iter(self.events)

    def __len__(self) -> int:
        return len(self.events)


class Events:
    """``bridge.events``: subscribe to the event stream; verify webhook signatures."""

    def __init__(self, bridge: "Bridge") -> None:
        self._b = bridge

    def subscribe(self, topics: Union[str, Sequence[str], None] = None, since: Optional[str] = None, **kw: Any) -> EventSubscription:
        """Events as they happen (see the module text). ``topics`` filters (``"download.*"``, ``["recording.gap", "order.*"]``);
        none means every topic your key may see. ``since`` is a cursor saved from an earlier ``ev.cursor``. Other
        keyword arguments: ``reconnect``, ``max_backoff``, ``idle_timeout``, ``max_reconnects``. After the first message
        ``sub.gap`` says whether events were lost (``sub.on_gap`` is called too)."""
        return EventSubscription(self._b, topics, since, **kw)

    def wait_for(self, topic: str, predicate: Optional[Callable[[Event], bool]] = None, *, timeout: float = 60.0, since: Optional[str] = None) -> Optional[Event]:
        """The first event on ``topic`` (that satisfies ``predicate``), or None after ``timeout`` seconds. For scripts
        that start something and wait for its event. Silence for ``timeout`` seconds, or a dropped connection, ends the wait with None."""
        deadline = self._b._clock() + timeout
        with self.subscribe(topic, since, idle_timeout=timeout, max_reconnects=0) as sub:
            for ev in sub:
                if ev.matches(topic) and (predicate is None or predicate(ev)):
                    return ev
                if self._b._clock() >= deadline:
                    return None
        return None

    def topics(self) -> List[Dict[str, Any]]:
        """The topics this key may receive (``GET /v1/events/topics``): ``topic``, ``scope``, ``accountScoped``, ``description``."""
        return list((self._b.client._get("/v1/events/topics").get("data")) or [])

    def poll(self, since: Optional[str] = None, topics: Union[str, Sequence[str], None] = None, *, limit: Optional[int] = None) -> "EventPage":
        """The same events as one JSON answer (``GET /v1/events``), for a script that runs now and then. Pass the returned
        ``page.cursor`` as ``since`` next time. Without ``since`` it returns the newest events."""
        r = self._b.client._get("/v1/events", {"since": since, "topics": [topics] if isinstance(topics, str) else (list(topics) if topics else None), "limit": limit})
        meta = r.get("meta") or {}
        evs = [_event_from(None, None, json.dumps(e)) for e in (r.get("data") or [])]
        return EventPage(evs, str(meta["cursor"]) if meta.get("cursor") is not None else since, bool(meta.get("gap")), meta.get("gapReason"), bool(meta.get("hasMore")))

    verify_signature = staticmethod(verify_signature)
    sign_payload = staticmethod(sign_payload)
