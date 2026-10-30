"""A small in-process fake of the Bridge REST API for the strategy tests (standard library only).

It serves what strategies call: orders (paper fills at the price table, with the Bridge's limits on lots), positions,
LTP, expiries, an option chain, OI analytics and instrument search. Every request is recorded so tests can check the
key, the Idempotency-Key and the body. No stream: tests feed ticks to Strategy.dispatch() directly.
"""

from __future__ import annotations

import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

KEY = "mcb_test_strategy_key"
EXPIRY = "2026-11-03"


def chain_rows(spot: float, step: int = 50, n: int = 8) -> List[Dict[str, Any]]:
    atm = round(spot / step) * step
    rows = []
    for i in range(-n, n + 1):
        k = atm + i * step
        d = max(0.02, min(0.98, 0.5 - (k - spot) / (step * 12)))
        rows.append({
            "strike": k,
            "ce": {"symbol": "NFO:NIFTY-%s-%d-CE" % (EXPIRY, k), "ltp": max(1.0, spot - k + 120), "delta": round(d, 3), "oi": 1000 + i * 10},
            "pe": {"symbol": "NFO:NIFTY-%s-%d-PE" % (EXPIRY, k), "ltp": max(1.0, k - spot + 120), "delta": round(d - 1, 3), "oi": 1000 - i * 10},
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
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:  # quiet
                pass

            def _send(self, status: int, body: Any) -> None:
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json" if status < 400 else "application/problem+json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _handle(self, method: str) -> None:
                u = urllib.parse.urlsplit(self.path)
                q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"null") if n else None
                fake.requests.append({"method": method, "path": u.path, "query": q, "body": body, "auth": self.headers.get("Authorization"), "idem": self.headers.get("Idempotency-Key")})
                if self.headers.get("Authorization") != "Bearer " + KEY:
                    return self._send(401, {"code": "UNAUTHENTICATED", "status": 401, "retryable": False})
                status, out = fake.route(method, u.path, q, body)
                self._send(status, out)

            def do_GET(self) -> None:  # noqa: N802
                self._handle("GET")

            def do_POST(self) -> None:  # noqa: N802
                self._handle("POST")

            def do_DELETE(self) -> None:  # noqa: N802
                self._handle("DELETE")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
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

    def problem(self, status: int, code: str, detail: str) -> Any:
        return status, {"status": status, "code": code, "title": code, "detail": detail, "retryable": False}

    def route(self, method: str, path: str, q: Dict[str, str], body: Any) -> Any:
        with self._lock:
            if method == "POST" and path == "/v1/orders":
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
                return 200, {"data": o, "meta": {}}
            if method == "GET" and path == "/v1/orders":
                return 200, {"data": [o for o in reversed(self.orders) if o["accountId"] == q.get("account")], "meta": {"nextCursor": None}}
            if method == "GET" and path == "/v1/ltp":
                syms = q.get("symbols", "").split(",")
                return 200, {"data": [{"symbol": s, "ltp": self.price(s)} for s in syms if s], "meta": {}}
            if method == "GET" and path == "/v1/expiries":
                return 200, {"data": {"underlying": q.get("underlying"), "expiries": ["2026-10-27", EXPIRY, "2026-11-09"]}, "meta": {}}
            if method == "GET" and path == "/v1/optionchain":
                rows = chain_rows(self.spot)
                return 200, {"data": {"underlying": "NIFTY", "expiry": q.get("expiry"), "underlyingLtp": self.spot, "atmStrike": round(self.spot / 50) * 50, "lotSize": self.lot, "rows": rows}, "meta": {}}
            if method == "GET" and path == "/v1/analytics/oi":
                atm = round(self.spot / 50) * 50
                return 200, {"data": {"underlyingLtp": self.spot, "atmStrike": atm, "pcrOi": self.pcr, "maxPain": atm,
                                      "support": [{"strike": atm + 100, "value": 9}, {"strike": atm - 150, "value": 8}], "resistance": [{"strike": atm + 200, "value": 9}],
                                      "strikes": []}, "meta": {}}
            if method == "GET" and path == "/v1/instruments/search":
                return 200, {"data": [{"symbol": "NFO:NIFTY-2026-12-29-FUT", "underlying": "NIFTY", "expiry": "2026-12-29"}, {"symbol": "NFO:NIFTY-2026-11-23-FUT", "underlying": "NIFTY", "expiry": "2026-11-23"}], "meta": {}}
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
