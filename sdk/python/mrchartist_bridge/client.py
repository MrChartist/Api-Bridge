"""Mr. Chartist API Bridge — Python client (standard library only, Python 3.9+).

    from mrchartist_bridge import BridgeClient
    bridge = BridgeClient()                         # $MCB_BRIDGE_URL or http://127.0.0.1:4300, key from $MCB_API_KEY
    ltp = bridge.ltp(["NSE:NIFTY", "NSE:RELIANCE"])["data"]
    result = bridge.place_order({"account": "dhan-main", "symbol": "NSE:RELIANCE", "side": "BUY", "quantity": 1,
                                 "product": "CNC", "orderType": "LIMIT", "price": 2900})   # paper unless mode="live"

Behaviour that matters for trading code:

* Every order write (place, modify, cancel, cancel-all) carries an ``Idempotency-Key``. One is generated per call
  unless you pass your own; it is kept across the client's own retries and returned as ``idempotency_key``, so a
  retry can never create a second order. ``replayed`` is True when the Bridge returned a stored result.
* Retries happen only when the Bridge marks an error ``retryable`` (honouring ``Retry-After``), plus network
  failures of reads. A write that gets no reply raises ``BridgeConnectionError`` with ``outcome_unknown=True`` and is
  never retried automatically. ``OUTCOME_UNKNOWN`` from the Bridge is not retryable either.
* System proxy settings are ignored: requests go straight to the Bridge, so your key never passes through a proxy.
* Responses are the Bridge's envelope ``{"data", "meta", "errors"?}`` for /v1 routes, so freshness stays visible.
"""

from __future__ import annotations

import http.client
import json
import os
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Union

from .errors import BridgeApiError, BridgeConnectionError

if TYPE_CHECKING:  # pragma: no cover
    from .stream import BridgeStream

DEFAULT_BASE_URL = "http://127.0.0.1:4300"
USER_AGENT = "mrchartist-bridge-python/0.1"
_SAFE_METHODS = frozenset({"GET", "HEAD"})
_MAX_RETRY_WAIT_S = 30.0


def new_idempotency_key() -> str:
    """A fresh idempotency key (UUID4; matches the Bridge's ``^[A-Za-z0-9_.:-]{8,255}$``)."""
    return str(uuid.uuid4())


def to_query(params: Optional[Mapping[str, Any]]) -> str:
    """Query string from a mapping. None values are left out, lists are comma-joined, booleans are true/false."""
    pairs = []
    for k, v in (params or {}).items():
        if v is None:
            continue
        if isinstance(v, bool):
            v = "true" if v else "false"
        elif isinstance(v, (list, tuple)):
            v = ",".join(str(x) for x in v)
        pairs.append((k, str(v)))
    return ("?" + urllib.parse.urlencode(pairs)) if pairs else ""


@dataclass
class Response:
    status: int
    headers: Mapping[str, str]
    body: Any


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects: a redirect could carry the Authorization header somewhere else."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


class BridgeClient:
    """Client for the Bridge's /v1 API. Thread-safe for concurrent requests (no shared mutable state per call)."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        *,
        timeout: float = 15.0,
        max_retries: int = 2,
        retry_base: float = 0.25,
        user_agent: str = USER_AGENT,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.base_url = (base_url or os.environ.get("MCB_BRIDGE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.__api_key = api_key if api_key is not None else os.environ.get("MCB_API_KEY")
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_base = retry_base
        self.user_agent = user_agent
        self._sleep = sleep
        # ProxyHandler({}) disables HTTP(S)_PROXY from the environment for this opener.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def __repr__(self) -> str:
        return "BridgeClient(base_url=%r, api_key=%s)" % (self.base_url, "set" if self.__api_key else "unset")

    # ── transport ──

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        body: Any = None,
        idempotency_key: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
        timeout: Optional[float] = None,
        retries: Optional[int] = None,
    ) -> Response:
        """Send one request (with the retry rules above) and return status, headers and the parsed body."""
        method = method.upper()
        url = self.base_url + path + to_query(query)
        h = {"Accept": "application/json, text/plain;q=0.9, text/csv;q=0.8", "User-Agent": self.user_agent}
        h.update(headers or {})
        if self.__api_key:
            h["Authorization"] = "Bearer " + self.__api_key
        if idempotency_key:
            h["Idempotency-Key"] = idempotency_key
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        max_retries = self.max_retries if retries is None else retries
        attempt = 0
        while True:
            req = urllib.request.Request(url, data=data, headers=h, method=method)
            try:
                with self._opener.open(req, timeout=timeout or self.timeout) as res:
                    status, rheaders, raw = res.status, res.headers, res.read()
            except urllib.error.HTTPError as e:
                status, rheaders = e.code, e.headers
                try:
                    raw = e.read()
                except Exception:  # noqa: BLE001
                    raw = b""
                finally:
                    e.close()
            except (urllib.error.URLError, socket.timeout, ConnectionError, http.client.HTTPException, OSError) as e:
                reason = getattr(e, "reason", e)
                timed_out = isinstance(reason, socket.timeout) or isinstance(e, socket.timeout) or "timed out" in str(reason)
                safe = method in _SAFE_METHODS
                if safe and attempt < max_retries:
                    self._sleep(self._backoff(attempt))
                    attempt += 1
                    continue
                if safe:
                    msg = "Could not reach the Bridge at %s (%s)." % (self.base_url, "timed out" if timed_out else reason)
                else:
                    msg = "No reply from the Bridge for %s %s. The Bridge may have acted on it: check before sending it again" % (method, path)
                    if idempotency_key:
                        msg += ", or resend with the same Idempotency-Key %s" % idempotency_key
                    msg += "."
                raise BridgeConnectionError(msg, method=method, path=path, outcome_unknown=not safe, idempotency_key=idempotency_key, timed_out=timed_out) from e

            parsed = _parse_body(raw, rheaders.get("Content-Type", ""))
            if 200 <= status < 300:
                return Response(status, rheaders, parsed)
            problem = _to_problem(status, rheaders, parsed)
            err = BridgeApiError(problem, idempotency_key=idempotency_key)
            if err.retryable and attempt < max_retries:
                wait = problem.get("retryAfterMs")
                self._sleep(min(_MAX_RETRY_WAIT_S, wait / 1000.0) if wait is not None else self._backoff(attempt))
                attempt += 1
                continue
            raise err

    def _backoff(self, attempt: int) -> float:
        base = self.retry_base * (2 ** attempt)
        return min(_MAX_RETRY_WAIT_S, base + random.random() * base)

    def _get(self, path: str, query: Optional[Mapping[str, Any]] = None) -> Any:
        return self.request("GET", path, query=query).body

    def _post(self, path: str, body: Any = None) -> Any:
        return self.request("POST", path, body=body).body

    def _write(self, method: str, path: str, body: Any = None, idempotency_key: Optional[str] = None, timeout: Optional[float] = None) -> Dict[str, Any]:
        key = idempotency_key or new_idempotency_key()
        r = self.request(method, path, body=body, idempotency_key=key, timeout=timeout)
        out = dict(r.body) if isinstance(r.body, dict) else {"data": r.body}
        out["replayed"] = (r.headers.get("Idempotency-Replayed") or "").lower() == "true"
        out["idempotency_key"] = key
        return out

    # ── system ──
    def health(self) -> Dict[str, Any]:
        return self._get("/v1/health")

    def meta(self) -> Dict[str, Any]:
        return self._get("/v1/meta")

    def brokers(self) -> Dict[str, Any]:
        return self._get("/v1/brokers")

    # ── accounts and limits ──
    def accounts(self) -> Dict[str, Any]:
        return self._get("/v1/accounts")

    def account(self, account_id: str) -> Dict[str, Any]:
        return self._get("/v1/accounts/" + _seg(account_id))

    def test_account(self, account_id: str) -> Dict[str, Any]:
        return self._post("/v1/accounts/%s/test" % _seg(account_id))

    def limits(self, account: Optional[str] = None) -> Dict[str, Any]:
        return self._get("/v1/limits", {"account": account})

    def usage(self) -> Dict[str, Any]:
        return self._get("/v1/usage")

    # ── instruments ──
    def search_instruments(self, q: str, *, exchange: Optional[str] = None, kind: Optional[str] = None, underlying: Optional[str] = None, expiry: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None) -> Dict[str, Any]:
        return self._get("/v1/instruments/search", {"q": q, "exchange": exchange, "kind": kind, "underlying": underlying, "expiry": expiry, "limit": limit, "cursor": cursor})

    def instrument(self, symbol: str, *, include: Optional[str] = None) -> Dict[str, Any]:
        return self._get("/v1/instruments/" + _seg(symbol), {"include": include})

    def convert_symbol(self, input: str, *, from_format: Optional[str] = None, exchange: Optional[str] = None, broker: Optional[str] = None) -> Dict[str, Any]:  # noqa: A002
        return self._get("/v1/symbols/convert", {"input": input, "from": from_format, "exchange": exchange, "broker": broker})

    def convert_symbols(self, items: Sequence[Union[str, Mapping[str, Any]]]) -> Dict[str, Any]:
        return self._post("/v1/symbols/convert", {"items": [{"input": i} if isinstance(i, str) else dict(i) for i in items]})

    # ── market data ──
    def ltp(self, symbols: Union[str, Sequence[str]], *, account: Optional[str] = None, max_age_ms: Optional[int] = None) -> Dict[str, Any]:
        return self._get("/v1/ltp", {"symbols": _list(symbols), "account": account, "maxAgeMs": max_age_ms})

    def quotes(self, symbols: Union[str, Sequence[str]], *, account: Optional[str] = None, max_age_ms: Optional[int] = None) -> Dict[str, Any]:
        return self._get("/v1/quotes", {"symbols": _list(symbols), "account": account, "maxAgeMs": max_age_ms})

    def depth(self, symbol: str, *, account: Optional[str] = None, max_age_ms: Optional[int] = None) -> Dict[str, Any]:
        return self._get("/v1/depth", {"symbol": symbol, "account": account, "maxAgeMs": max_age_ms})

    def history(self, symbol: str, interval: str, *, from_: Optional[Union[str, int]] = None, to: Optional[Union[str, int]] = None, countback: Optional[int] = None, account: Optional[str] = None, format: Optional[str] = None) -> Any:  # noqa: A002
        """Candles. ``format="csv"`` returns the CSV text instead of the envelope."""
        return self._get("/v1/history", {"symbol": symbol, "interval": interval, "from": from_, "to": to, "countback": countback, "account": account, "format": format})

    def expiries(self, underlying: str, *, exchange: Optional[str] = None, account: Optional[str] = None) -> Dict[str, Any]:
        return self._get("/v1/expiries", {"underlying": underlying, "exchange": exchange, "account": account})

    def option_chain(self, underlying: str, expiry: str, *, strikes: Optional[int] = None, greeks: Optional[bool] = None, account: Optional[str] = None, max_age_ms: Optional[int] = None) -> Dict[str, Any]:
        return self._get("/v1/optionchain", {"underlying": underlying, "expiry": expiry, "strikes": strikes, "greeks": greeks, "account": account, "maxAgeMs": max_age_ms})

    def stream_stats(self) -> Dict[str, Any]:
        return self._get("/v1/stream/stats")

    # ── portfolio ──
    def positions(self, account: str, *, mode: Optional[str] = None) -> Dict[str, Any]:
        return self._get("/v1/positions", {"account": account, "mode": mode})

    def holdings(self, account: str) -> Dict[str, Any]:
        return self._get("/v1/holdings", {"account": account})

    def funds(self, account: str, *, mode: Optional[str] = None) -> Dict[str, Any]:
        return self._get("/v1/funds", {"account": account, "mode": mode})

    # ── orders (paper unless the order says mode="live") ──
    def orders(self, *, account: Optional[str] = None, mode: Optional[str] = None, status: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None) -> Dict[str, Any]:
        return self._get("/v1/orders", {"account": account, "mode": mode, "status": status, "limit": limit, "cursor": cursor})

    def order(self, order_id: str) -> Dict[str, Any]:
        return self._get("/v1/orders/" + _seg(order_id))

    def order_by_client_id(self, client_order_id: str) -> Dict[str, Any]:
        return self._get("/v1/orders/by-client-id/" + _seg(client_order_id))

    def trades(self, *, account: Optional[str] = None, mode: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None) -> Dict[str, Any]:
        return self._get("/v1/trades", {"account": account, "mode": mode, "limit": limit, "cursor": cursor})

    def preview_order(self, order: Mapping[str, Any]) -> Dict[str, Any]:
        return self._post("/v1/orders/preview", dict(order))

    def place_order(self, order: Mapping[str, Any], *, idempotency_key: Optional[str] = None, timeout: Optional[float] = None) -> Dict[str, Any]:
        """Place an order (paper unless ``order["mode"] == "live"``). Returns the envelope plus ``replayed`` and ``idempotency_key``."""
        return self._write("POST", "/v1/orders", dict(order), idempotency_key, timeout)

    def modify_order(self, order_id: str, changes: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._write("PATCH", "/v1/orders/" + _seg(order_id), dict(changes), idempotency_key)

    def cancel_order(self, order_id: str, *, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._write("DELETE", "/v1/orders/" + _seg(order_id), None, idempotency_key)

    def cancel_all_orders(self, *, account: Optional[str] = None, mode: Optional[str] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        body = {k: v for k, v in {"account": account, "mode": mode}.items() if v is not None}
        return self._write("POST", "/v1/orders/cancel-all", body, idempotency_key)

    # ── paper and safety ──
    def paper_account(self, account_id: str) -> Dict[str, Any]:
        return self._get("/v1/paper/accounts/" + _seg(account_id))

    def reset_paper_account(self, account_id: str, *, starting_capital: Optional[float] = None) -> Dict[str, Any]:
        return self._post("/v1/paper/accounts/%s/reset" % _seg(account_id), {} if starting_capital is None else {"startingCapital": starting_capital})

    def safety(self) -> Dict[str, Any]:
        return self._get("/v1/safety")

    def engage_kill_switch(self, reason: str, *, cancel_open_orders: bool = False) -> Dict[str, Any]:
        """Stop all orders now. Any key may engage the kill switch; releasing it is deliberately not in the SDK."""
        return self._post("/v1/safety/kill-switch", {"reason": reason, "cancelOpenOrders": cancel_open_orders})

    def paginate(self, fn: Callable[..., Dict[str, Any]], **params: Any) -> Iterator[Any]:
        """Yield every item of a paginated list, e.g. ``for o in bridge.paginate(bridge.orders, account="x")``."""
        cursor = params.pop("cursor", None)
        while True:
            page = fn(cursor=cursor, **params)
            for item in page.get("data") or []:
                yield item
            cursor = (page.get("meta") or {}).get("nextCursor")
            if not cursor:
                return

    # ── streaming ──
    def stream_token(self) -> Dict[str, str]:
        """A single-use, short-lived token for the stream URL (your API key never goes in a URL)."""
        return self._post("/v1/stream/token")["data"]

    def stream_url(self) -> str:
        token = self.stream_token()["token"]
        scheme_base = ("ws" + self.base_url[4:]) if self.base_url.lower().startswith("http") else self.base_url
        return "%s/v1/stream?token=%s" % (scheme_base, urllib.parse.quote(token, safe=""))

    def stream(self, symbols: Iterable[str] = (), *, mode: str = "ltp", orders: Union[bool, Sequence[str]] = False, reconnect: bool = True, **kwargs: Any) -> "BridgeStream":
        """Open a live stream; iterate it for messages. Reconnects with a fresh token and re-subscribes after a drop."""
        from .stream import BridgeStream

        return BridgeStream(self, symbols=list(symbols), mode=mode, orders=orders, reconnect=reconnect, **kwargs)


def _seg(s: str) -> str:
    return urllib.parse.quote(str(s), safe="")


def _list(symbols: Union[str, Sequence[str]]) -> List[str]:
    return [symbols] if isinstance(symbols, str) else list(symbols)


def _parse_body(raw: bytes, content_type: str) -> Any:
    text = raw.decode("utf-8", errors="replace")
    if "json" in (content_type or "").lower():
        try:
            return json.loads(text) if text else None
        except ValueError:
            return text
    return text


def _to_problem(status: int, headers: Mapping[str, str], body: Any) -> Dict[str, Any]:
    if isinstance(body, dict) and isinstance(body.get("code"), str):
        problem = dict(body)
        problem.setdefault("status", status)
    else:
        problem = {
            "status": status,
            "code": headers.get("X-Error-Code") or "HTTP_%d" % status,
            "detail": body[:200] if isinstance(body, str) else None,
            "retryable": False,
        }
    if problem.get("retryAfterMs") is None:
        ra = headers.get("Retry-After")
        try:
            if ra is not None and float(ra) >= 0:
                problem["retryAfterMs"] = float(ra) * 1000.0
        except ValueError:
            pass
    return problem

