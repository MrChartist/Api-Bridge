"""A small in-process fake of the Bridge REST API for the strategy tests (standard library only).

It serves what strategies and the typed client call: orders (paper fills at the price table, with the Bridge's limits on
lots, idempotent replays, lookups by id and client id), positions, funds, accounts, LTP and quotes with freshness labels,
expiries, an option chain (with open interest), instrument search, sources, tickets, meta (the route list), health, and
optional ``to-target`` and ``batch`` routes. Every request is recorded so tests can check the key, the Idempotency-Key and
the body. ``fake.fault(...)`` makes the next matching request fail (a problem reply, or a dropped connection). No stream
(see fake_ws.py): strategy tests feed ticks to Strategy.dispatch() directly.
"""

from __future__ import annotations

import json
import math
import socket
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

KEY = "mcb_test_strategy_key"
EXPIRY = "2026-11-03"


def chain_rows(spot: float, step: int = 50, n: int = 20, pcr: float = 1.0) -> List[Dict[str, Any]]:
    """Open interest is flat, with a put wall 150 points below the ATM strike and a call wall 200 above it; ``pcr``
    scales the put side."""
    atm = round(spot / step) * step
    rows = []
    for i in range(-n, n + 1):
        k = atm + i * step
        d = 1 / (1 + math.exp((k - spot) / 150.0))  # call delta, a smooth S curve
        rows.append({
            "strike": k,
            "ce": {"symbol": "NFO:NIFTY-%s-%d-CE" % (EXPIRY, k), "ltp": max(1.0, spot - k + 120), "delta": round(d, 3), "oi": 1000 + (3000 if i == 4 else 0)},
            "pe": {"symbol": "NFO:NIFTY-%s-%d-PE" % (EXPIRY, k), "ltp": max(1.0, k - spot + 120), "delta": round(d - 1, 3), "oi": round(1000 * pcr) + (3000 if i == -3 else 0)},
        })
    return rows


class FakeBridge:
    def __init__(self) -> None:
        self.spot = 26000.0
        self.prices: Dict[str, float] = {}
        self.orders: List[Dict[str, Any]] = []
        self.requests: List[Dict[str, Any]] = []
        self.max_lots = 10
        self.kill_switch = False
        self.pcr = 1.0
        self.lot = 65
        self._seq = 0
        self._lock = threading.Lock()
        self._tl = threading.local()
        self.faults: List[Dict[str, Any]] = []
        self.history_ok = False
        self.delayed: set = set()
        self.idem: Dict[str, Any] = {}
        self.positions: Dict[str, float] = {}
        self.positions_fail = False
        self.hold_orders: set = set()
        self.tickets: List[Dict[str, Any]] = []
        self.rejected_tickets: List[Dict[str, Any]] = []
        self.extra_routes: List[Dict[str, str]] = []
        self.has_to_target = False
        self.has_batch = False
        self.has_calendar = False
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:  # quiet
                pass

            def _send(self, status: int, body: Any, headers: Any = None) -> None:
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json" if status < 400 else "application/problem+json")
                self.send_header("Content-Length", str(len(raw)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(raw)

            def _handle(self, method: str) -> None:
                u = urllib.parse.urlsplit(self.path)
                q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"null") if n else None
                fake.requests.append({"method": method, "path": u.path, "query": q, "body": body, "auth": self.headers.get("Authorization"), "idem": self.headers.get("Idempotency-Key")})
                fault = fake.take_fault(method, u.path)
                if fault is not None:
                    if fault.get("drop"):
                        try:
                            self.request.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                        self.close_connection = True
                        return
                    return self._send(fault["status"], fault["body"], fault.get("headers"))
                if u.path != "/v1/health" and self.headers.get("Authorization") != "Bearer " + KEY:
                    return self._send(401, {"code": "UNAUTHENTICATED", "status": 401, "retryable": False})
                fake._tl.idem = self.headers.get("Idempotency-Key")
                status, out = fake.route(method, u.path, q, body)
                extra = {"Idempotency-Replayed": "true"} if isinstance(out, dict) and out.pop("_replayed", False) else None
                self._send(status, out, extra)

            def do_GET(self) -> None:  # noqa: N802
                self._handle("GET")

            def do_POST(self) -> None:  # noqa: N802
                self._handle("POST")

            def do_DELETE(self) -> None:  # noqa: N802
                self._handle("DELETE")

            def do_PATCH(self) -> None:  # noqa: N802
                self._handle("PATCH")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def price(self, sym: str) -> float:
        if sym in self.prices:
            return self.prices[sym]
        if sym.endswith("-FUT"):
            return self.spot + 100
        for r in chain_rows(self.spot):
            for side in ("ce", "pe"):
                if r[side]["symbol"] == sym:
                    return r[side]["ltp"]
        return self.spot

    def problem(self, status: int, code: str, detail: str, **more: Any) -> Any:
        return status, dict({"status": status, "code": code, "title": code, "detail": detail, "retryable": False}, **more)

    def fault(self, method: str, path: str, status: int = 500, code: str = "INTERNAL", *, drop: bool = False, times: int = 1, headers: Any = None, **more: Any) -> None:
        """Make the next ``times`` matching requests fail (path is matched exactly)."""
        body = dict({"status": status, "code": code, "title": code, "detail": "injected", "retryable": False}, **more)
        self.faults.append({"method": method, "path": path, "status": status, "body": body, "drop": drop, "times": times, "headers": headers})

    def take_fault(self, method: str, path: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            for f in self.faults:
                if f["method"] == method and f["path"] == path and f["times"] > 0:
                    f["times"] -= 1
                    return f
        return None

    def freshness(self, sym: str) -> Dict[str, Any]:
        if sym in self.delayed:
            return {"source": "backup", "asOf": "2026-10-30T09:45:00.000+05:30", "ageMs": 900000, "stale": False, "accountId": None, "broker": None, "provider": "yahoo", "class": "delayed",
                    "delaySec": 900, "official": False, "confidence": "low", "flags": ["delayed", "unofficial"]}
        return {"source": "broker", "asOf": "2026-10-30T10:00:00.000+05:30", "ageMs": 12, "stale": False, "accountId": "paper", "broker": "paper", "class": "realtime", "delaySec": 0,
                "official": True, "confidence": "high", "flags": []}

    def order_record(self, body: Dict[str, Any], status: str = "filled") -> Dict[str, Any]:
        qty = body.get("quantity") or body["lots"] * self.lot
        self._seq += 1
        o = {
            "orderId": "PAPER-%06d" % self._seq, "clientOrderId": body.get("clientOrderId"), "accountId": body["account"], "mode": body.get("mode") or "paper", "broker": "paper",
            "symbol": body["symbol"], "side": body["side"], "quantity": qty, "filledQuantity": qty if status == "filled" else 0, "avgPrice": self.price(body["symbol"]) if status == "filled" else None,
            "status": status, "orderType": body["orderType"], "product": body.get("product", "CNC"), "legs": [], "placedAt": "2026-10-30T10:00:%02d.000+05:30" % (self._seq % 60),
            "updatedAt": "2026-10-30T10:00:%02d.000+05:30" % (self._seq % 60),
        }
        self.orders.append(o)
        if status == "filled":
            sign = 1 if body["side"] == "BUY" else -1
            self.positions[body["symbol"]] = self.positions.get(body["symbol"], 0) + sign * qty
        return o

    def route(self, method: str, path: str, q: Dict[str, str], body: Any) -> Any:
        idem = getattr(self._tl, "idem", None)
        with self._lock:
            if method == "GET" and path == "/v1/health":
                return 200, {"status": "ok", "version": "2.0.0", "apiVersion": "v1", "demo": True, "uptimeSeconds": 5}
            if method == "GET" and path == "/v1/meta":
                routes = [("GET", "/v1/ltp"), ("GET", "/v1/quotes"), ("POST", "/v1/orders"), ("GET", "/v1/orders/:orderId"), ("GET", "/v1/tickets")]
                if self.has_to_target:
                    routes.append(("POST", "/v1/orders/to-target"))
                if self.has_batch:
                    routes.append(("POST", "/v1/orders/batch"))
                if self.has_calendar:
                    routes += [("GET", "/v1/calendar/status"), ("GET", "/v1/calendar/holidays")]
                data = {"bridgeVersion": "2.0.0", "apiVersion": "v1", "brokers": ["paper"], "modules": [],
                        "routes": [{"method": m, "path": p, "scope": "admin" if "tickets" in p else "read", "auth": "key"} for m, p in routes] + self.extra_routes}
                return 200, {"data": data, "meta": {}}
            if method == "GET" and path == "/v1/accounts":
                return 200, {"data": [{"id": "paper", "broker": "paper", "label": "Paper", "enabled": True, "session": {"state": "connected"}, "liveAllowedByConfig": False}], "meta": {}}
            if method == "GET" and path == "/v1/quotes":
                syms = [s for s in q.get("symbols", "").split(",") if s]
                bad = [s for s in syms if s.endswith("-NOPE")]
                data = [{"symbol": s, "ltp": self.price(s), "open": self.price(s) - 1, "high": self.price(s) + 2, "low": self.price(s) - 2, "close": self.price(s) - 0.5, "volume": 1000, "bid": self.price(s) - 0.05,
                         "ask": self.price(s) + 0.05, "freshness": self.freshness(s)} for s in syms if s not in bad]
                return 200, {"data": data, "errors": [{"code": "SYMBOL_NOT_FOUND", "message": "%s unknown" % s, "symbol": s} for s in bad], "meta": {"requestId": "req_1"}}
            if method == "GET" and path == "/v1/positions":
                if self.positions_fail:
                    return self.problem(503, "BROKER_UNAVAILABLE", "positions down")
                return 200, {"data": [{"symbol": s, "product": "CNC", "netQty": n, "avgPrice": 100, "pnl": 0} for s, n in self.positions.items() if n != 0], "meta": {}}
            if method == "GET" and path == "/v1/funds":
                return 200, {"data": {"availableCash": 100000, "usedMargin": 0}, "meta": {}}
            if method == "GET" and path.startswith("/v1/instruments/") and path != "/v1/instruments/search":
                return 200, {"data": {"symbol": urllib.parse.unquote(path.split("/")[-1]), "exchange": "NFO", "kind": "FUT", "underlying": "NIFTY", "lotSize": self.lot, "tickSize": 0.05, "expiry": EXPIRY}, "meta": {}}
            if method == "GET" and path == "/v1/sources":
                return 200, {"data": [{"id": "paper", "name": "Paper", "kind": "broker", "tier": "builtin", "enabled": True, "configured": True, "class": "realtime", "delaySec": 0, "official": True,
                                       "capabilities": ["quotes"], "health": {"state": "ok"}, "needsKey": False}], "meta": {}}
            if method == "POST" and path == "/v1/stream/token":
                return 200, {"data": {"token": "tok_%d" % len(self.requests), "expiresAt": "2026-10-30T10:01:00+05:30"}, "meta": {}}
            if method == "POST" and path == "/v1/orders/preview":
                return 200, {"data": {"ok": True, "mode": body.get("mode", "paper"), "checks": [], "requiresHumanConfirmation": False, "quantity": body.get("quantity"), "ltp": self.price(body["symbol"]), "ticketId": None}, "meta": {}}
            if method == "GET" and path == "/v1/tickets":
                rows = self.rejected_tickets if q.get("state") == "rejected" else self.tickets
                return 200, {"data": rows, "meta": {}}
            if method == "GET" and path.startswith("/v1/orders/by-client-id/"):
                cid = urllib.parse.unquote(path.rsplit("/", 1)[1])
                for o in self.orders:
                    if o.get("clientOrderId") == cid:
                        return 200, {"data": o, "meta": {}}
                return self.problem(404, "ORDER_NOT_FOUND", "no such order")
            if method == "GET" and path.startswith("/v1/orders/") and path != "/v1/orders/preview":
                oid = urllib.parse.unquote(path.rsplit("/", 1)[1])
                for o in self.orders:
                    if o["orderId"] == oid:
                        return 200, {"data": o, "meta": {}}
                return self.problem(404, "ORDER_NOT_FOUND", "no such order")
            if method == "DELETE" and path.startswith("/v1/orders/"):
                oid = urllib.parse.unquote(path.rsplit("/", 1)[1])
                for o in self.orders:
                    if o["orderId"] == oid:
                        o["status"] = "cancelled"
                        return 200, {"data": o, "meta": {}}
                return self.problem(404, "ORDER_NOT_FOUND", "no such order")
            if method == "POST" and path == "/v1/orders/to-target" and self.has_to_target:
                cur = self.positions.get(body["symbol"], 0)
                tgt = body.get("targetQuantity", body.get("targetLots", 0) * self.lot)
                delta = tgt - cur
                if delta == 0:
                    return 200, {"data": {"currentQuantity": cur, "targetQuantity": tgt, "delta": 0, "action": "NONE", "order": None}, "meta": {}}
                o = self.order_record({"account": body["account"], "symbol": body["symbol"], "side": "BUY" if delta > 0 else "SELL", "quantity": abs(delta), "orderType": body.get("orderType", "MARKET"), "mode": body.get("mode")})
                return 200, {"data": {"currentQuantity": cur, "targetQuantity": tgt, "delta": delta, "action": "BUY" if delta > 0 else "SELL", "order": o}, "meta": {}}
            if method == "POST" and path == "/v1/orders/batch" and self.has_batch:
                results = []
                for i, od in enumerate(body["orders"]):
                    if od.get("quantity") == 0:
                        results.append({"index": i, "ok": False, "error": {"code": "INVALID_ORDER", "message": "zero"}})
                    else:
                        results.append({"index": i, "ok": True, "order": self.order_record(dict(od, account=body["account"]))})
                return 200, {"data": {"results": results}, "meta": {"batchId": "batch_1"}}
            if method == "POST" and path == "/v1/orders":
                if idem and idem in self.idem:
                    return 200, dict(self.idem[idem], _replayed=True)
                if self.kill_switch:
                    return self.problem(423, "KILL_SWITCH_ACTIVE", "The kill switch is on.")
                lots = body.get("lots")
                if lots is not None and lots > self.max_lots:
                    return self.problem(422, "INVALID_ORDER", "%d lots is more than maxLotsPerOrder %d." % (lots, self.max_lots))
                qty = body.get("quantity") or lots * self.lot
                self._seq += 1
                o = {
                    "orderId": "PAPER-%06d" % self._seq, "clientOrderId": body.get("clientOrderId"), "accountId": body["account"], "mode": body.get("mode", "paper"),
                    "symbol": body["symbol"], "side": body["side"], "quantity": qty, "filledQuantity": qty, "avgPrice": self.price(body["symbol"]),
                    "status": "filled", "orderType": body["orderType"], "placedAt": "2026-10-30T10:00:%02d.000+05:30" % (self._seq % 60),
                }
                self.orders.append(o)
                if body.get("clientOrderId") in self.hold_orders:
                    o["status"], o["filledQuantity"], o["avgPrice"] = "open", 0, None
                else:
                    sign = 1 if body["side"] == "BUY" else -1
                    self.positions[body["symbol"]] = self.positions.get(body["symbol"], 0) + sign * qty
                out = {"data": o, "meta": {}}
                if idem:
                    self.idem[idem] = out
                return 200, out
            if method == "GET" and path == "/v1/orders":
                return 200, {"data": [o for o in reversed(self.orders) if o["accountId"] == q.get("account")], "meta": {"nextCursor": None}}
            if method == "GET" and path == "/v1/ltp":
                syms = q.get("symbols", "").split(",")
                return 200, {"data": [{"symbol": s, "ltp": self.price(s), "freshness": self.freshness(s)} for s in syms if s], "errors": [], "meta": {}}
            if method == "GET" and path == "/v1/expiries":
                return 200, {"data": {"underlying": q.get("underlying"), "expiries": ["2026-10-27", EXPIRY, "2026-11-09"]}, "meta": {}}
            if method == "GET" and path == "/v1/optionchain":
                rows = chain_rows(self.spot, pcr=self.pcr)
                return 200, {"data": {"underlying": "NIFTY", "expiry": q.get("expiry"), "underlyingLtp": self.spot, "atmStrike": round(self.spot / 50) * 50, "lotSize": self.lot, "rows": rows}, "meta": {}}
            if method == "GET" and path == "/v1/instruments/search":
                return 200, {"data": [{"symbol": "NFO:NIFTY-2026-12-29-FUT", "underlying": "NIFTY", "expiry": "2026-12-29"}, {"symbol": "NFO:NIFTY-2026-11-23-FUT", "underlying": "NIFTY", "expiry": "2026-11-23"}], "meta": {}}
            if method == "GET" and path == "/v1/history" and self.history_ok:
                n = int(q.get("countback") or 3)
                base = 1700000000 - 1700000000 % 86400 - 19800
                cs = [{"time": base + i * 86400, "open": 100 + i, "high": 102 + i, "low": 99 + i, "close": 101 + i, "volume": 1000 + i} for i in range(n)]
                return 200, {"data": {"symbol": q["symbol"], "interval": q["interval"], "candles": cs, "freshness": self.freshness(q["symbol"]), "partial": False}, "meta": {}}
            if method == "GET" and path == "/v1/history":
                return 503, {"status": 503, "code": "BROKER_UNAVAILABLE", "detail": "No data account for this key.", "retryable": False}
            return self.problem(404, "NOT_FOUND", path)

    def find(self, method: str, path: str) -> List[Dict[str, Any]]:
        return [r for r in self.requests if r["method"] == method and r["path"] == path]


def tick(symbol: str, ltp: float, ms: float, **kw: Any) -> Dict[str, Any]:
    return dict({"type": "tick", "symbol": symbol, "ltp": ltp, "receivedAt": ms}, **kw)


def order_event(order: Dict[str, Any], **changes: Any) -> Dict[str, Any]:
    return {"type": "order", "order": dict(order, **changes)}


def maybe(d: Optional[Dict[str, Any]], k: str) -> Any:
    return (d or {}).get(k)
