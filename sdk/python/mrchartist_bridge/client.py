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

import hashlib
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

from .secret import SecretStr
from .errors import BridgeApiError, BridgeConnectionError, BridgeNotRunning, error_from_problem

if TYPE_CHECKING:  # pragma: no cover
    from .stream import BridgeStream

DEFAULT_BASE_URL = "http://127.0.0.1:4300"
USER_AGENT = "mrchartist-bridge-python/0.3"
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
        raw_key = api_key if api_key is not None else os.environ.get("MCB_API_KEY")
        # A SecretStr shows *** in repr(), vars(), copy and pickle (a logger that dumps the object cannot leak the key).
        self.__api_key = SecretStr(raw_key) if raw_key else raw_key
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_base = retry_base
        self.user_agent = user_agent
        self._sleep = sleep
        # ProxyHandler({}) disables HTTP(S)_PROXY from the environment for this opener.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def __repr__(self) -> str:
        return "%s(base_url=%r, api_key=%s)" % (type(self).__name__, self.base_url, "set" if self.__api_key else "unset")

    @property
    def has_api_key(self) -> bool:
        """Whether a key is set (the key itself is never exposed)."""
        return bool(self.__api_key)

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
                refused = isinstance(reason, ConnectionRefusedError) or isinstance(e, ConnectionRefusedError)
                safe = method in _SAFE_METHODS or refused  # a refused connection never carried the request
                if safe and attempt < max_retries:
                    self._sleep(self._backoff(attempt))
                    attempt += 1
                    continue
                if refused:
                    raise BridgeNotRunning(
                        "Nothing is listening at %s (connection refused). %s" % (self.base_url, BridgeNotRunning.hint),
                        method=method, path=path, outcome_unknown=False, idempotency_key=idempotency_key,
                    ) from e
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
            err = error_from_problem(problem, idempotency_key=idempotency_key)
            if err.retryable and attempt < max_retries:
                wait = problem.get("retryAfterMs")
                self._sleep(min(_MAX_RETRY_WAIT_S, wait / 1000.0) if wait is not None else self._backoff(attempt))
                attempt += 1
                continue
            raise self._explain(err, method, path)

    def _explain(self, err: BridgeApiError, method: str, path: str) -> BridgeApiError:
        """Hook for subclasses that know more (whether a key was found) to improve the hint. Returns the error."""
        return err

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

    def limits(self, account: Optional[str] = None, *, explain: bool = False) -> Dict[str, Any]:
        """``GET /v1/limits``. ``explain=True`` adds the budget pools, the competing clients and ``savedCalls``."""
        return self._get("/v1/limits", {"account": account, "explain": True if explain else None})

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

    def history(self, symbol: str, interval: str, *, from_: Optional[Union[str, int]] = None, to: Optional[Union[str, int]] = None, countback: Optional[int] = None, account: Optional[str] = None, format: Optional[str] = None,  # noqa: A002
                local_first: Optional[bool] = None, dataset: Optional[str] = None, backup: Optional[bool] = None) -> Any:
        """Candles. ``format="csv"`` returns the CSV text instead of the envelope. ``local_first=True`` lets the Bridge
        serve bars it already stored (``dataset="name"`` picks a dataset) and fetch only what is missing from the broker;
        ``meta.source`` says ``local`` for bars read from disk."""
        return self._get("/v1/history", {"symbol": symbol, "interval": interval, "from": from_, "to": to, "countback": countback, "account": account, "format": format,
                                         "localFirst": local_first, "dataset": dataset, "backup": backup})

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

    # ── streamed replies: files and event streams ──
    def open_stream(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        timeout: Optional[float] = None,
        accept: str = "*/*",
    ) -> Any:
        """Open a reply that is read piece by piece (a file, or a Server-Sent Events stream). Returns the open response
        (``read``, ``readline``, ``close``; a context manager) after checking the status: a problem reply raises the
        usual typed error. A retryable problem (rate limit) is retried like ``request()``; an unreachable Bridge raises
        ``BridgeNotRunning`` or ``BridgeConnectionError``. ``timeout`` is the longest silence between two reads."""
        method = method.upper()
        url = self.base_url + path + to_query(query)
        h = {"Accept": accept, "User-Agent": self.user_agent}
        h.update(headers or {})
        if self.__api_key:
            h["Authorization"] = "Bearer " + self.__api_key
        attempt = 0
        while True:
            req = urllib.request.Request(url, headers=h, method=method)
            try:
                return self._opener.open(req, timeout=timeout or self.timeout)
            except urllib.error.HTTPError as e:
                status, rheaders = e.code, e.headers
                try:
                    raw = e.read()
                except Exception:  # noqa: BLE001
                    raw = b""
                finally:
                    e.close()
                parsed = _parse_body(raw, rheaders.get("Content-Type", ""))
                problem = _to_problem(status, rheaders, parsed)
                err = error_from_problem(problem)
                if err.retryable and attempt < self.max_retries:
                    wait = problem.get("retryAfterMs")
                    self._sleep(min(_MAX_RETRY_WAIT_S, wait / 1000.0) if wait is not None else self._backoff(attempt))
                    attempt += 1
                    continue
                raise self._explain(err, method, path)
            except (urllib.error.URLError, socket.timeout, ConnectionError, http.client.HTTPException, OSError) as e:
                reason = getattr(e, "reason", e)
                timed_out = isinstance(reason, socket.timeout) or isinstance(e, socket.timeout) or "timed out" in str(reason)
                refused = isinstance(reason, ConnectionRefusedError) or isinstance(e, ConnectionRefusedError)
                if attempt < self.max_retries:
                    self._sleep(self._backoff(attempt))
                    attempt += 1
                    continue
                if refused:
                    raise BridgeNotRunning("Nothing is listening at %s (connection refused). %s" % (self.base_url, BridgeNotRunning.hint), method=method, path=path, outcome_unknown=False) from e
                raise BridgeConnectionError("Could not reach the Bridge at %s (%s)." % (self.base_url, "timed out" if timed_out else reason), method=method, path=path, outcome_unknown=False, timed_out=timed_out) from e

    def download_to(
        self,
        path: str,
        dest: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        expect_sha256: Optional[str] = None,
        chunk_size: int = 1 << 16,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Stream a GET reply into the file ``dest`` (written as ``dest + ".part"`` and renamed when complete, so a
        broken transfer never leaves a half file under the real name). Returns ``{"path", "bytes", "sha256"}``. With
        ``expect_sha256`` a different checksum raises ``ChecksumMismatch`` and the file is removed."""
        from .errors import ChecksumMismatch

        part = dest + ".part"
        digest = hashlib.sha256()
        size = 0
        with self.open_stream("GET", path, query=query, timeout=timeout) as res:
            try:
                with open(part, "wb") as f:
                    while True:
                        try:
                            block = res.read(chunk_size)
                        except (socket.timeout, ConnectionError, http.client.HTTPException, OSError) as e:
                            raise BridgeConnectionError("The transfer from %s broke off after %d bytes (%s)." % (self.base_url, size, e), method="GET", path=path, outcome_unknown=False) from e
                        if not block:
                            break
                        f.write(block)
                        digest.update(block)
                        size += len(block)
            except BaseException:
                try:
                    os.remove(part)
                except OSError:
                    pass
                raise
        actual = digest.hexdigest()
        if expect_sha256 and actual.lower() != expect_sha256.lower():
            try:
                os.remove(part)
            except OSError:
                pass
            raise ChecksumMismatch("%s does not match its manifest (expected sha256 %s, got %s). It was not kept." % (os.path.basename(dest), expect_sha256, actual), expected=expect_sha256, actual=actual)
        os.replace(part, dest)
        return {"path": dest, "bytes": size, "sha256": actual}

    # ── data: downloads, datasets, recordings, collections, subscriptions ──
    def create_download(self, request: Mapping[str, Any], *, dry_run: bool = False) -> Dict[str, Any]:
        """``POST /v1/downloads``: queue a download job (202 with the job). ``dry_run=True`` starts nothing and returns the estimate."""
        return self.request("POST", "/v1/downloads", query={"dryRun": True} if dry_run else None, body=dict(request)).body

    def download_settings(self) -> Dict[str, Any]:
        """``GET /v1/downloads/settings``: the budget share and the after-hours switch in force."""
        return self._get("/v1/downloads/settings")

    def set_download_settings(self, changes: Mapping[str, Any]) -> Dict[str, Any]:
        """``PATCH /v1/downloads/settings`` (an admin key from this computer)."""
        return self.request("PATCH", "/v1/downloads/settings", body=dict(changes)).body

    def downloads(self, *, status: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None) -> Dict[str, Any]:
        return self._get("/v1/downloads", {"status": status, "limit": limit, "cursor": cursor})

    def download(self, job_id: str) -> Dict[str, Any]:
        return self._get("/v1/downloads/" + _seg(job_id))

    def pause_download(self, job_id: str) -> Dict[str, Any]:
        return self._post("/v1/downloads/%s/pause" % _seg(job_id))

    def resume_download(self, job_id: str) -> Dict[str, Any]:
        return self._post("/v1/downloads/%s/resume" % _seg(job_id))

    def cancel_download(self, job_id: str) -> Dict[str, Any]:
        return self._post("/v1/downloads/%s/cancel" % _seg(job_id))

    def delete_download(self, job_id: str) -> Any:
        """Remove the job and its files from the Bridge's disk."""
        return self.request("DELETE", "/v1/downloads/" + _seg(job_id)).body

    def edit_download(self, job_id: str, changes: Mapping[str, Any]) -> Dict[str, Any]:
        """Rename a job or change its tags (``PATCH /v1/downloads/{id}``)."""
        return self.request("PATCH", "/v1/downloads/" + _seg(job_id), body=dict(changes)).body

    def download_files(self, job_id: str) -> Dict[str, Any]:
        return self._get("/v1/downloads/%s/files" % _seg(job_id))

    def datasets(self, *, tag: Optional[str] = None) -> Dict[str, Any]:
        return self._get("/v1/datasets", {"tag": tag})

    def dataset(self, name: str) -> Dict[str, Any]:
        return self._get("/v1/datasets/" + _seg(name))

    def update_dataset(self, name: str, body: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        """``POST /v1/datasets/{name}/update``: fetch only the bars after the dataset's last one (202 with a job)."""
        return self._post("/v1/datasets/%s/update" % _seg(name), dict(body or {}))

    def edit_dataset(self, name: str, changes: Mapping[str, Any]) -> Dict[str, Any]:
        """Rename a dataset or change its tags or description (``PATCH /v1/datasets/{name}``)."""
        return self.request("PATCH", "/v1/datasets/" + _seg(name), body=dict(changes)).body

    def recordings(self, *, status: Optional[str] = None) -> Dict[str, Any]:
        return self._get("/v1/recordings", {"status": status})

    def recording_status(self) -> Dict[str, Any]:
        """``GET /v1/recordings/status``: one plain line about today's recording and the numbers behind it."""
        return self._get("/v1/recordings/status")

    def recording_settings(self) -> Dict[str, Any]:
        """``GET /v1/recordings/settings``: the budget share recordings may use."""
        return self._get("/v1/recordings/settings")

    def set_recording_settings(self, changes: Mapping[str, Any]) -> Dict[str, Any]:
        """``PATCH /v1/recordings/settings`` (an admin key from this computer)."""
        return self.request("PATCH", "/v1/recordings/settings", body=dict(changes)).body

    def recording_presets(self) -> Dict[str, Any]:
        return self._get("/v1/recordings/presets")

    def apply_recording_preset(self, preset_id: str, body: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        """``POST /v1/recordings/presets/{id}/apply`` (admin key from this computer): makes the rule and turns auto-record on."""
        return self.request("POST", "/v1/recordings/presets/%s/apply" % _seg(preset_id), body=dict(body or {})).body

    def create_recording(self, request: Mapping[str, Any]) -> Dict[str, Any]:
        return self._post("/v1/recordings", dict(request))

    def recording(self, recording_id: str) -> Dict[str, Any]:
        return self._get("/v1/recordings/" + _seg(recording_id))

    def pause_recording(self, recording_id: str) -> Dict[str, Any]:
        return self._post("/v1/recordings/%s/pause" % _seg(recording_id))

    def resume_recording(self, recording_id: str) -> Dict[str, Any]:
        return self._post("/v1/recordings/%s/resume" % _seg(recording_id))

    def stop_recording(self, recording_id: str) -> Dict[str, Any]:
        return self._post("/v1/recordings/%s/stop" % _seg(recording_id))

    def delete_recording(self, recording_id: str) -> Any:
        return self.request("DELETE", "/v1/recordings/" + _seg(recording_id)).body

    def recording_files(self, recording_id: str) -> Dict[str, Any]:
        return self._get("/v1/recordings/%s/files" % _seg(recording_id))

    def recording_rules(self) -> Dict[str, Any]:
        return self._get("/v1/recordings/rules")

    def create_recording_rule(self, rule: Mapping[str, Any]) -> Dict[str, Any]:
        return self._post("/v1/recordings/rules", dict(rule))

    def update_recording_rule(self, rule_id: str, changes: Mapping[str, Any]) -> Dict[str, Any]:
        return self.request("PATCH", "/v1/recordings/rules/" + _seg(rule_id), body=dict(changes)).body

    def delete_recording_rule(self, rule_id: str) -> Any:
        return self.request("DELETE", "/v1/recordings/rules/" + _seg(rule_id)).body

    def collections(self, *, tag: Optional[str] = None, kind: Optional[str] = None) -> Dict[str, Any]:
        return self._get("/v1/collections", {"tag": tag, "kind": kind})

    def collection(self, name: str) -> Dict[str, Any]:
        return self._get("/v1/collections/" + _seg(name))

    def create_collection(self, collection: Mapping[str, Any]) -> Dict[str, Any]:
        return self._post("/v1/collections", dict(collection))

    def update_collection(self, name: str, changes: Mapping[str, Any]) -> Dict[str, Any]:
        return self.request("PATCH", "/v1/collections/" + _seg(name), body=dict(changes)).body

    def delete_collection(self, name: str) -> Any:
        return self.request("DELETE", "/v1/collections/" + _seg(name)).body

    def resolve_collection(self, name: str, *, allow_stale: Optional[bool] = None) -> Dict[str, Any]:
        """The concrete symbols of a collection right now (an option universe is recomputed on each call). A delayed or
        end-of-day ATM price is refused (422) and a stale one too (503) unless ``allow_stale=True`` (then labelled)."""
        return self._get("/v1/collections/%s/resolve" % _seg(name), {"allowStale": 1 if allow_stale else None})

    def collection_usage(self, name: str) -> Dict[str, Any]:
        return self._get("/v1/collections/%s/usage" % _seg(name))

    def collection_estimate(self, name: str, *, intervals: Union[str, Sequence[str], None] = None, days: Optional[int] = None) -> Dict[str, Any]:
        return self._get("/v1/collections/%s/estimate" % _seg(name), {"intervals": _list(intervals) if intervals else None, "days": days})

    def subscriptions(self) -> Dict[str, Any]:
        return self._get("/v1/subscriptions")

    def create_subscription(self, subscription: Mapping[str, Any]) -> Dict[str, Any]:
        return self._post("/v1/subscriptions", dict(subscription))

    def update_subscription(self, subscription_id: str, changes: Mapping[str, Any]) -> Dict[str, Any]:
        return self.request("PATCH", "/v1/subscriptions/" + _seg(subscription_id), body=dict(changes)).body

    def delete_subscription(self, subscription_id: str) -> Any:
        return self.request("DELETE", "/v1/subscriptions/" + _seg(subscription_id)).body

    def test_subscription(self, subscription_id: str) -> Dict[str, Any]:
        return self._post("/v1/subscriptions/%s/test" % _seg(subscription_id))

    def subscription(self, subscription_id: str) -> Dict[str, Any]:
        return self._get("/v1/subscriptions/" + _seg(subscription_id))

    def subscription_deliveries(self, subscription_id: str, *, limit: Optional[int] = None, outcome: Optional[str] = None) -> Dict[str, Any]:
        """Every delivery attempt, newest first. ``outcome`` is delivered, retry, dead or failed."""
        return self._get("/v1/subscriptions/%s/deliveries" % _seg(subscription_id), {"limit": limit, "outcome": outcome})

    def subscription_dead_letters(self, subscription_id: str) -> Dict[str, Any]:
        return self._get("/v1/subscriptions/%s/dead-letters" % _seg(subscription_id))

    def retry_dead_letter(self, subscription_id: str, delivery_id: str) -> Dict[str, Any]:
        return self._post("/v1/subscriptions/%s/dead-letters/%s/retry" % (_seg(subscription_id), _seg(delivery_id)))

    def clear_dead_letters(self, subscription_id: str) -> Dict[str, Any]:
        return self.request("DELETE", "/v1/subscriptions/%s/dead-letters" % _seg(subscription_id)).body

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

