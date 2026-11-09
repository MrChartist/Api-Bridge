"""Python SDK tests against the local fake Bridge (sdk/node/test/fakeServer.mjs, started as a subprocess).

Run from the repository root:  python3 -m unittest discover -s sdk/python/tests -t sdk/python
Skipped when Node or the fake server's `ws` dependency is not available. No broker or real Bridge is involved.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import unittest
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from mrchartist_bridge import (  # noqa: E402
    BridgeApiError,
    BridgeClient,
    BridgeConnectionError,
    WebSocket,
    new_idempotency_key,
    to_query,
)

FAKE = HERE.parent.parent / "node" / "test" / "fakeServer.mjs"
KEY = "mcb_test_key"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
ORDER = {"account": "dhan-main", "symbol": "NSE:RELIANCE", "side": "BUY", "quantity": 1, "product": "CNC", "orderType": "LIMIT", "price": 2900}

_proc = None
BASE = None
_direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def setUpModule():  # noqa: N802
    global _proc, BASE
    node = shutil.which("node")
    if not node or not FAKE.exists():
        raise unittest.SkipTest("node or the fake server is not available")
    _proc = subprocess.Popen([node, str(FAKE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    line = _proc.stdout.readline()
    m = re.match(r"PORT=(\d+)", line or "")
    if not m:
        err = _proc.stderr.read() if _proc.poll() is not None else ""
        _proc.kill()
        raise unittest.SkipTest("fake server did not start: %s %s" % (line, err[:300]))
    BASE = "http://127.0.0.1:%s" % m.group(1)


def tearDownModule():  # noqa: N802
    if _proc is not None:
        _proc.terminate()
        try:
            _proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _proc.kill()
        for f in (_proc.stdin, _proc.stdout, _proc.stderr):
            if f:
                f.close()


def control(name, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + "/__test/" + name, data=data, method="GET" if name == "requests" else "POST", headers={"Content-Type": "application/json"})
    with _direct.open(req, timeout=5) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def requests():
    return control("requests")


def script(method, path, responses):
    control("script", {"method": method, "path": path, "responses": responses})


def busy(code="UPSTREAM_RATE_LIMITED", retry_after="2"):
    return {"status": 429, "body": {"type": "x", "title": "busy", "status": 429, "code": code, "retryable": True}, "headers": {"Content-Type": "application/problem+json", "Retry-After": retry_after}}


class Base(unittest.TestCase):
    def setUp(self):
        control("reset")
        self.waits = []

    def client(self, **kw):
        kw.setdefault("api_key", KEY)
        kw.setdefault("sleep", self.waits.append)
        return BridgeClient(BASE, **kw)


class ReadTests(Base):
    def test_envelope_freshness_and_item_errors(self):
        r = self.client().ltp(["NSE:NIFTY", "NSE:NOPE"], account="dhan-main", max_age_ms=0)
        self.assertEqual(r["data"][0]["ltp"], 25000.5)
        self.assertEqual(r["data"][0]["freshness"]["source"], "stream")
        self.assertEqual([e["code"] for e in r["errors"]], ["SYMBOL_NOT_FOUND"])
        req = requests()[0]
        self.assertEqual(req["query"], {"symbols": "NSE:NIFTY,NSE:NOPE", "account": "dhan-main", "maxAgeMs": "0"})
        self.assertEqual(req["authorization"], "present")
        self.assertTrue(req["userAgent"].startswith("mrchartist-bridge-python/"))

    def test_history_chain_quotes(self):
        c = self.client()
        self.assertEqual(len(c.history("NSE:NIFTY", "5m", countback=2)["data"]["candles"]), 2)
        self.assertTrue(c.history("NSE:NIFTY", "5m", countback=2, format="csv").startswith("time,open"))
        self.assertEqual(c.option_chain("NIFTY", "2026-10-27", strikes=5, greeks=False)["data"]["atmStrike"], 25000)
        self.assertEqual(requests()[-1]["query"]["greeks"], "false")
        self.assertEqual(c.quotes("NSE:RELIANCE")["data"][0]["bid"], 99.95)

    def test_paginate(self):
        c = self.client()
        ids = [o["orderId"] for o in c.paginate(c.orders, account="dhan-main")]
        self.assertEqual(ids, ["PAPER-%d" % i for i in range(1, 7)])

    def test_key_not_in_repr(self):
        c = self.client()
        self.assertNotIn(KEY, repr(c))
        self.assertNotIn(KEY, json.dumps({k: str(v) for k, v in vars(c).items() if not k.endswith("__api_key")}))

    def test_bad_key_not_retried(self):
        with self.assertRaises(BridgeApiError) as cm:
            self.client(api_key="wrong").ltp("NSE:NIFTY")
        self.assertEqual((cm.exception.status, cm.exception.code, cm.exception.retryable), (401, "UNAUTHENTICATED", False))
        self.assertEqual(len(requests()), 1)

    def test_to_query(self):
        self.assertEqual(to_query({"a": None, "c": ["x", "y"], "d": 0, "e": False}), "?c=x%2Cy&d=0&e=false")
        self.assertEqual(to_query({}), "")
        self.assertRegex(new_idempotency_key(), UUID_RE)

    def test_ignores_proxy_environment(self):
        old = {k: os.environ.get(k) for k in ("HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy")}
        try:
            os.environ["HTTP_PROXY"] = os.environ["http_proxy"] = "http://127.0.0.1:9"
            os.environ.pop("NO_PROXY", None)
            os.environ.pop("no_proxy", None)
            self.assertEqual(self.client().ltp("NSE:NIFTY")["data"][0]["ltp"], 25000.5)
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


class IdempotencyTests(Base):
    def test_default_key_and_replay(self):
        c = self.client()
        first = c.place_order(ORDER)
        self.assertRegex(first["idempotency_key"], UUID_RE)
        self.assertFalse(first["replayed"])
        self.assertEqual(first["data"]["orderId"], "PAPER-1")
        again = c.place_order(ORDER, idempotency_key=first["idempotency_key"])
        self.assertTrue(again["replayed"])
        self.assertEqual(again["data"]["orderId"], "PAPER-1")
        second = c.place_order(ORDER)
        self.assertNotEqual(second["idempotency_key"], first["idempotency_key"])
        self.assertEqual(second["data"]["orderId"], "PAPER-2")

    def test_modify_cancel_cancel_all_carry_keys(self):
        c = self.client()
        c.modify_order("PAPER-9", {"price": 2901})
        c.cancel_order("PAPER-9")
        self.assertEqual(c.cancel_all_orders(account="dhan-main", mode="paper")["data"]["cancelled"], ["PAPER-1"])
        reqs = requests()
        self.assertEqual([r["method"] for r in reqs], ["PATCH", "DELETE", "POST"])
        for r in reqs:
            self.assertRegex(r["idempotencyKey"], UUID_RE)
        self.assertEqual(reqs[2]["body"], {"account": "dhan-main", "mode": "paper"})

    def test_preview_has_no_key(self):
        self.assertTrue(self.client().preview_order(ORDER)["data"]["ok"])
        self.assertIsNone(requests()[0]["idempotencyKey"])


class RetryTests(Base):
    def test_retryable_after_retry_after(self):
        script("GET", "/v1/ltp", [busy(), busy()])
        self.assertEqual(self.client().ltp("NSE:NIFTY")["data"][0]["ltp"], 25000.5)
        self.assertEqual(len(requests()), 3)
        self.assertEqual(self.waits, [2.0, 2.0])

    def test_gives_up_after_max_retries(self):
        script("GET", "/v1/ltp", [busy(), busy(), busy()])
        with self.assertRaises(BridgeApiError) as cm:
            self.client(max_retries=1).ltp("NSE:NIFTY")
        self.assertTrue(cm.exception.retryable)
        self.assertEqual(len(requests()), 2)

    def test_non_retryable_not_retried(self):
        script("POST", "/v1/orders", [{"status": 422, "body": {"type": "x", "title": "bad", "status": 422, "code": "INVALID_ORDER", "retryable": False, "detail": "Lot size 75."}, "headers": {"Content-Type": "application/problem+json"}}])
        with self.assertRaises(BridgeApiError) as cm:
            self.client().place_order(ORDER)
        self.assertEqual((cm.exception.code, cm.exception.detail), ("INVALID_ORDER", "Lot size 75."))
        self.assertRegex(cm.exception.idempotency_key, UUID_RE)
        self.assertEqual(len(requests()), 1)

    def test_outcome_unknown_never_retried(self):
        script("POST", "/v1/orders", [{"status": 504, "body": {"type": "x", "title": "unknown", "status": 504, "code": "OUTCOME_UNKNOWN", "retryable": False}, "headers": {"Content-Type": "application/problem+json"}}])
        with self.assertRaises(BridgeApiError) as cm:
            self.client().place_order(ORDER)
        self.assertEqual(cm.exception.code, "OUTCOME_UNKNOWN")
        self.assertEqual(len(requests()), 1)

    def test_retryable_write_keeps_the_same_key(self):
        script("POST", "/v1/orders", [busy("ORDER_RATE_LIMITED", "1")])
        r = self.client().place_order(ORDER)
        keys = [q["idempotencyKey"] for q in requests()]
        self.assertEqual(len(keys), 2)
        self.assertEqual(keys[0], keys[1])
        self.assertEqual(r["idempotency_key"], keys[0])
        self.assertEqual(self.waits, [1.0])

    def test_read_retried_after_dropped_connection(self):
        script("GET", "/v1/ltp", [{"destroy": True}])
        self.assertEqual(len(self.client().ltp("NSE:NIFTY")["data"]), 1)
        self.assertEqual(len(self.waits), 1)

    def test_write_without_reply_is_outcome_unknown(self):
        script("POST", "/v1/orders", [{"destroy": True}])
        with self.assertRaises(BridgeConnectionError) as cm:
            self.client().place_order(ORDER)
        e = cm.exception
        self.assertTrue(e.outcome_unknown)
        self.assertRegex(e.idempotency_key, UUID_RE)
        self.assertIn("same Idempotency-Key", str(e))
        self.assertEqual(len(requests()), 1)

    def test_write_timeout_not_retried(self):
        script("POST", "/v1/orders", [{"delayMs": 600, "status": 201, "body": {}}])
        with self.assertRaises(BridgeConnectionError) as cm:
            self.client(timeout=0.2).place_order(ORDER)
        self.assertTrue(cm.exception.outcome_unknown)
        self.assertTrue(cm.exception.timed_out)
        time.sleep(0.5)
        self.assertEqual(len(requests()), 1)

    def test_plain_text_error_uses_x_error_code(self):
        script("GET", "/v1/ltp", [{"status": 404, "body": "#N/A", "headers": {"Content-Type": "text/plain", "X-Error-Code": "SYMBOL_NOT_FOUND"}}])
        with self.assertRaises(BridgeApiError) as cm:
            self.client().ltp("NSE:X")
        self.assertEqual((cm.exception.code, cm.exception.status, cm.exception.retryable), ("SYMBOL_NOT_FOUND", 404, False))

    def test_bridge_not_running(self):
        c = BridgeClient("http://127.0.0.1:1", api_key=KEY, max_retries=1, sleep=self.waits.append)
        with self.assertRaises(BridgeConnectionError) as cm:
            c.health()
        self.assertFalse(cm.exception.outcome_unknown)
        self.assertEqual(len(self.waits), 1)


class SafetyTests(Base):
    def test_kill_switch_engage_only(self):
        self.assertTrue(self.client().engage_kill_switch("test")["data"]["engaged"])
        self.assertEqual(requests()[0]["body"], {"reason": "test", "cancelOpenOrders": False})
        self.assertFalse(hasattr(BridgeClient, "release_kill_switch"))


class StreamTests(Base):
    def test_stream_url_uses_token_not_key(self):
        url = self.client().stream_url()
        self.assertRegex(url, r"^ws://127\.0\.0\.1:\d+/v1/stream\?token=st_")
        self.assertNotIn(KEY, url)

    def test_raw_websocket_handshake_and_ping(self):
        ws = WebSocket(self.client().stream_url(), timeout=5)
        try:
            self.assertEqual(json.loads(ws.recv())["type"], "heartbeat")
            ws.send_text(json.dumps({"op": "ping", "id": "p1"}))
            msg = json.loads(ws.recv())
            self.assertEqual((msg["type"], msg["id"], msg["seq"]), ("heartbeat", "p1", 2))
        finally:
            ws.close()

    def test_subscribe_tick_reconnect_resubscribe(self):
        s = self.client().stream(["NSE:NIFTY"], mode="ltp", recv_timeout=5)
        s._sleep = lambda _w: None  # reconnect immediately in tests
        seen = []
        snapshots = []

        def run():
            for msg in s:
                seen.append(msg)
                if msg["type"] == "snapshot":
                    snapshots.append(msg["symbols"])
                    if len(snapshots) == 1:
                        control("tick", {"symbol": "NSE:NIFTY", "ltp": 25001})
                        control("tick", {"symbol": "NSE:BANKNIFTY", "ltp": 1})
                    elif len(snapshots) == 2:
                        control("drop")
                    elif len(snapshots) == 3:
                        control("tick", {"symbol": "NSE:RELIANCE", "ltp": 2900})
                if msg["type"] == "tick" and msg["symbol"] == "NSE:NIFTY":
                    s.subscribe(["NSE:RELIANCE"], "quote")
                if msg["type"] == "tick" and msg["symbol"] == "NSE:RELIANCE":
                    s.close()

        t = threading.Thread(target=run, daemon=True)
        t.start()
        t.join(timeout=10)
        self.assertFalse(t.is_alive(), "stream did not finish")
        ticks = [(m["symbol"], m["ltp"]) for m in seen if m["type"] == "tick"]
        self.assertEqual(ticks, [("NSE:NIFTY", 25001), ("NSE:RELIANCE", 2900)])
        self.assertGreaterEqual(s.reconnects, 1)
        # The fake filters ticks by each connection's own subscriptions, so the RELIANCE tick arriving on the new
        # connection proves the stream re-subscribed after the drop.
        self.assertGreaterEqual(len(snapshots), 3)
        self.assertTrue(set(sum(snapshots[2:], [])) <= {"NSE:NIFTY", "NSE:RELIANCE"})
        self.assertEqual(len([r for r in requests() if r["path"] == "/v1/stream/token"]), 2)

    def test_bad_key_stops_the_stream(self):
        s = self.client(api_key="wrong").stream(["NSE:NIFTY"])
        with self.assertRaises(BridgeApiError) as cm:
            for _ in s:
                pass
        self.assertEqual(cm.exception.code, "UNAUTHENTICATED")
        self.assertTrue(s.closed)


if __name__ == "__main__":
    unittest.main()
