"""AsyncBridge, tables (pandas and CSV), retry and batching, alert messages, the CLI (fake Bridge, no real network)."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import sys
import threading
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from fake_bridge import KEY, FakeBridge  # noqa: E402
from mrchartist_bridge import (  # noqa: E402
    AsyncBridge,
    Bridge,
    BridgeConnectionError,
    OutcomeUnknown,
    RateLimited,
    Unauthenticated,
    error_from_problem,
)
from mrchartist_bridge import alerts, batching, frames  # noqa: E402
from mrchartist_bridge.__main__ import _cli  # noqa: E402


@pytest.fixture()
def fake():
    f = FakeBridge()
    yield f
    f.close()


@pytest.fixture()
def bridge(fake):
    return Bridge(fake.url, KEY, account="paper", sleep=lambda s: None)


# ── asyncio ──


def test_async_bridge_runs_calls_in_threads_and_matches_the_sync_api(fake):
    async def main():
        async with AsyncBridge(fake.url, KEY, account="paper") as ab:
            p, q, accts = await asyncio.gather(ab.price("NSE:RELIANCE"), ab.quotes(["NSE:RELIANCE", "NSE:TCS"]), ab.accounts())
            o = await ab.orders.place("NSE:RELIANCE", "BUY", quantity=1, product="CNC", price=p)
            done = await ab.orders.wait_for_fill(o)
            r = await ab.orders.to_target("NSE:RELIANCE", target_quantity=0, product="CNC", order_type="MARKET")
            return p, q, accts, o, done, r

    p, q, accts, o, done, r = asyncio.run(main())
    assert p.ltp == fake.spot and len(q) == 2 and accts[0].id == "paper" and done.is_filled and r.action == "SELL" and r.order.quantity == 1


def test_async_bridge_does_not_block_the_event_loop_and_limits_concurrency(fake):
    gate = threading.Event()
    active = {"now": 0, "max": 0}
    lock = threading.Lock()
    orig = fake.route

    def route(method, path, q, body):
        if path == "/v1/ltp":
            with lock:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
            gate.wait(0.05)
            with lock:
                active["now"] -= 1
        return orig(method, path, q, body)

    fake.route = route  # type: ignore[method-assign]

    async def main():
        ticks = []

        async def heartbeat():
            for _ in range(5):
                await asyncio.sleep(0.01)
                ticks.append(1)

        ab = AsyncBridge(fake.url, KEY, max_concurrency=2)
        await asyncio.gather(heartbeat(), *[ab.price("NSE:S%d" % i) for i in range(6)])
        return ticks

    assert len(asyncio.run(main())) == 5 and active["max"] <= 2


def test_async_errors_are_the_same_typed_errors(fake):
    async def main():
        await AsyncBridge(fake.url, "wrong_key_123").price("NSE:X")

    with pytest.raises(Unauthenticated):
        asyncio.run(main())


# ── tables ──


def _history(bridge, fake, n=3):
    fake.history_ok = True
    return bridge.history("NSE:RELIANCE", "1d", countback=n)


def test_csv_of_history_has_ist_times_and_freshness_columns(bridge, fake):
    text = frames.to_csv(_history(bridge, fake))
    rows = list(csv.reader(io.StringIO(text)))
    assert rows[0] == ["time", "open", "high", "low", "close", "volume", "source", "data_class", "delay_sec", "official", "confidence"]
    assert rows[1][0].endswith("+05:30") and rows[1][6:] == ["broker", "realtime", "0", "true", "high"]
    assert frames.to_csv(_history(bridge, fake), freshness=False).splitlines()[0] == "time,open,high,low,close,volume"


def test_csv_of_records_and_file(bridge, fake, tmp_path):
    q = bridge.quotes(["NSE:RELIANCE", "NSE:TCS"])
    p = tmp_path / "q.csv"
    text = frames.to_csv(q, str(p))
    assert p.read_text() == text
    header = text.splitlines()[0].split(",")
    assert "symbol" in header and "ltp" in header and "data_class" in header and "raw" not in header
    assert len(text.splitlines()) == 3


def test_delayed_data_stays_labelled_in_csv(bridge, fake):
    fake.delayed.add("NSE:SLOW")
    fake.history_ok = True
    text = frames.to_csv(bridge.history("NSE:SLOW", "1d", countback=1))
    assert text.splitlines()[1].endswith("backup,delayed,900,false,low")


def test_dataframe_of_history_has_an_ist_index_and_freshness(bridge, fake):
    pytest.importorskip("pandas")
    df = _history(bridge, fake, 4).to_dataframe()
    assert df.index.name == "time" and str(df.index.tz) in ("Asia/Kolkata", "UTC+05:30") and df.index[0].utcoffset().total_seconds() == 19800
    assert list(df.columns) == ["open", "high", "low", "close", "volume", "source", "data_class", "delay_sec", "official", "confidence"]
    assert df["data_class"].eq("realtime").all() and df.attrs["freshness"]["class"] == "realtime" and df.attrs["symbol"] == "NSE:RELIANCE"
    assert len(df) == 4 and df["close"].iloc[0] == 101
    assert "source" not in frames.to_dataframe(_history(bridge, fake), freshness=False).columns


def test_dataframes_of_quotes_positions_and_orders(bridge, fake):
    pytest.importorskip("pandas")
    q = bridge.quotes(["NSE:RELIANCE", "NSE:TCS"]).to_dataframe()
    assert list(q.index) == ["NSE:RELIANCE", "NSE:TCS"] and {"ltp", "bid", "ask", "source", "data_class", "as_of", "stale"} <= set(q.columns)
    bridge.orders.place("NSE:X", "BUY", quantity=3, product="CNC", order_type="MARKET")
    pos = bridge.positions().to_dataframe()
    assert pos.loc["NSE:X", "net_qty"] == 3
    od = frames.to_dataframe(bridge.orders.list(account="paper"))
    assert od["status"].tolist() == ["filled"] and "raw" not in od.columns and "legs" not in od.columns


def test_dataframe_without_pandas_says_how_to_install(monkeypatch, bridge, fake):
    monkeypatch.setitem(sys.modules, "pandas", None)
    with pytest.raises(ImportError, match=r"mrchartist-bridge\[pandas\]"):
        _history(bridge, fake).to_dataframe()


# ── retry and batching ──


def rate_limited(scope=None, ms=None):
    p = {"status": 429, "code": "RATE_LIMITED", "retryable": True}
    if scope:
        p["scope"] = scope
    if ms is not None:
        p["retryAfterMs"] = ms
    return error_from_problem(p)


def run_retry(errors, **kw):
    seq = list(errors)
    waits = []

    def fn():
        if seq:
            e = seq.pop(0)
            if isinstance(e, BaseException):
                raise e
        return "ok"

    return batching.retry(fn, sleep=waits.append, **kw), waits


def test_retry_waits_exactly_retry_after_for_a_client_limit():
    out, waits = run_retry([rate_limited("client", 1200)])
    assert out == "ok" and 1.2 <= waits[0] < 1.5


def test_retry_waits_at_least_a_second_for_the_shared_upstream_limit():
    out, waits = run_retry([rate_limited("upstream", 100)])
    assert waits[0] >= 1.0
    out, waits = run_retry([rate_limited("consumer-cap")])
    assert waits[0] >= 1.0


def test_retry_backs_off_when_no_retry_after_is_given():
    out, waits = run_retry([rate_limited("queue"), rate_limited("queue"), rate_limited("queue")], base=0.5)
    assert len(waits) == 3 and waits[0] < waits[1] < waits[2]


def test_retry_gives_up_after_the_attempts_and_raises_the_last_error():
    with pytest.raises(RateLimited):
        run_retry([rate_limited("client", 10)] * 5, attempts=3)


def test_retry_will_not_wait_longer_than_max_wait():
    with pytest.raises(RateLimited):
        run_retry([rate_limited("client", 120000)], max_wait=30)


def test_retry_never_repeats_an_unknown_outcome_or_a_non_retryable_error():
    for err in (error_from_problem({"status": 504, "code": "OUTCOME_UNKNOWN", "retryable": True}), error_from_problem({"status": 401, "code": "UNAUTHENTICATED"}),
                BridgeConnectionError("x", method="POST", path="/v1/orders", outcome_unknown=True)):
        with pytest.raises(type(err)):
            run_retry([err, err])
    assert isinstance(error_from_problem({"status": 504, "code": "OUTCOME_UNKNOWN"}), OutcomeUnknown)


def test_retry_repeats_a_connection_error_whose_outcome_is_known():
    out, waits = run_retry([BridgeConnectionError("x", method="GET", path="/v1/ltp", outcome_unknown=False)])
    assert out == "ok" and len(waits) == 1


def test_fetch_many_chunks_dedupes_and_collects_item_errors(bridge, fake):
    syms = ["NSE:S%d" % i for i in range(450)] + ["NSE:S1", "NSE:S2", "NSE:Z-NOPE"]
    res = bridge.quotes_many(syms, chunk=200)
    reqs = [r for r in fake.requests if r["path"] == "/v1/quotes"]
    assert [len(r["query"]["symbols"].split(",")) for r in reqs] == [200, 200, 51]
    assert len(res) == 450 and res.errors[0].symbol == "NSE:Z-NOPE" and res[0].symbol == "NSE:S0"


def test_fetch_many_waits_when_throttled_and_pauses_between_chunks(fake):
    waits = []
    b = Bridge(fake.url, KEY, account="paper", sleep=waits.append, max_retries=0)
    fake.fault("GET", "/v1/ltp", 429, "RATE_LIMITED", retryable=True, retryAfterMs=2000, scope="client")
    res = b.ltp_many(["NSE:A", "NSE:B", "NSE:C"], chunk=2, pause=0.5)
    assert len(res) == 3 and any(2.0 <= w < 2.3 for w in waits) and 0.5 in waits


def test_fetch_many_clamps_chunk_to_the_bridges_limit(bridge, fake):
    bridge.ltp_many(["NSE:S%d" % i for i in range(250)], chunk=10000)
    assert [len(r["query"]["symbols"].split(",")) for r in fake.requests if r["path"] == "/v1/ltp"] == [200, 50]


# ── alert messages (provisional) ──


def test_alert_message_json_and_checks():
    m = alerts.AlertMessage(symbol="NSE:RELIANCE", side="BUY", lots=1, price=1402.5, order_type="LIMIT", id="brk-0001")
    assert json.loads(m.to_json()) == {"symbol": "NSE:RELIANCE", "side": "BUY", "lots": 1, "price": 1402.5, "orderType": "LIMIT", "id": "brk-0001"}
    assert m.problems() == []
    bad = alerts.AlertMessage(symbol="reliance", side="HOLD", quantity=1, lots=1, price=-1)
    probs = " | ".join(bad.problems())
    assert "EXCHANGE:NAME" in probs and "BUY or SELL" in probs and "not both" in probs and "above 0" in probs
    assert "give quantity or lots" in alerts.AlertMessage(symbol="NSE:X").problems()
    assert "LIMIT alert must carry a price" in " ".join(alerts.AlertMessage(symbol="NSE:X", quantity=1, order_type="LIMIT").problems())


def test_alert_placeholders_pass_through_untouched():
    m = alerts.AlertMessage(symbol="{{exchange}}:{{ticker}}", side="{{strategy.order.action}}", quantity="{{strategy.order.contracts}}", price="{{close}}", id="{{timenow}}")
    assert m.problems() == [] and json.loads(m.to_json())["price"] == "{{close}}"


def test_check_against_hook():
    hook = {"allowedSymbols": ["NSE:RELIANCE"], "side": "BUY", "maxLotsPerSignal": 2, "orderType": "LIMIT", "product": "CNC"}
    ok = alerts.AlertMessage(symbol="NSE:RELIANCE", side="BUY", lots=1, price=10)
    assert alerts.check_against_hook(ok, hook) == []
    msgs = " | ".join(alerts.check_against_hook(alerts.AlertMessage(symbol="NSE:TCS", side="SELL", lots=5), hook))
    assert "allowedSymbols" in msgs and "fixed to BUY" in msgs and "maxLotsPerSignal" in msgs and "needs a price" in msgs


def test_signature_matches_the_documented_scheme():
    import hashlib
    import hmac

    body = b'{"symbol":"NSE:RELIANCE"}'
    header = alerts.sign("topsecret", body, t=1700000000)
    expected = hmac.new(b"topsecret", b"1700000000." + body, hashlib.sha256).hexdigest()
    assert header == "t=1700000000,v1=" + expected


def test_send_posts_a_signed_alert_to_a_local_hook():
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    got = {}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):  # noqa: N802
            n = int(self.headers["Content-Length"])
            got.update(body=json.loads(self.rfile.read(n)), sig=self.headers.get("X-MCB-Signature"), ctype=self.headers["Content-Type"])
            raw = json.dumps({"accepted": True, "signalId": "s1"}).encode()
            self.send_response(202)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=lambda: srv.serve_forever(poll_interval=0.01), daemon=True).start()
    try:
        r = alerts.send("http://127.0.0.1:%d/hooks/generic/tok" % srv.server_address[1], alerts.AlertMessage(symbol="NSE:X", side="BUY", quantity=1, id="a1"), secret="s3cret")
    finally:
        srv.shutdown()
        srv.server_close()
    assert r.accepted and r.status == 202 and got["body"]["symbol"] == "NSE:X" and got["sig"].startswith("t=") and ",v1=" in got["sig"] and got["ctype"] == "application/json"


def test_hooks_test_posts_the_message_when_the_bridge_has_the_route(bridge, fake):
    fake.extra_routes.append({"method": "POST", "path": "/v1/hooks/:hookId/test", "scope": "admin", "auth": "key"})
    orig = fake.route

    def route(method, path, q, body):
        if path == "/v1/hooks/h1/test":
            return 200, {"data": {"wouldPlace": True, "echo": body}, "meta": {}}
        return orig(method, path, q, body)

    fake.route = route  # type: ignore[method-assign]
    out = bridge.hooks.test("h1", alerts.AlertMessage(symbol="NSE:X", side="BUY", quantity=1))
    assert out["wouldPlace"] and out["echo"]["message"]["symbol"] == "NSE:X"


# ── the command line ──


def run_cli(args, capsys, monkeypatch, env=None):
    for k in ("MCB_BRIDGE_URL", "MCB_API_KEY", "MCB_API_KEY_FILE", "MCB_ACCOUNT", "MCB_CONFIG"):
        monkeypatch.delenv(k, raising=False)
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    code = _cli(args)
    cap = capsys.readouterr()
    return code, cap.out, cap.err


def test_cli_ping_and_price(fake, capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("MCB_HOME", str(tmp_path))
    code, out, err = run_cli(["ping", "--url", fake.url, "--key", KEY], capsys, monkeypatch, {"MCB_HOME": str(tmp_path)})
    assert code == 0 and "Ping(ok=True" in out
    code, out, err = run_cli(["price", "NSE:NIFTY", "--url", fake.url, "--key", KEY], capsys, monkeypatch, {"MCB_HOME": str(tmp_path)})
    assert code == 0 and "NSE:NIFTY" in out and "broker realtime" in out


def test_cli_errors_are_one_friendly_line(fake, capsys, monkeypatch, tmp_path):
    code, out, err = run_cli(["price", "NSE:NIFTY", "--url", fake.url], capsys, monkeypatch, {"MCB_HOME": str(tmp_path)})
    assert code == 1 and err.startswith("Error: ") and "No API key was found" in err and "Traceback" not in err


def test_cli_login_saves_the_key_and_it_is_then_found(fake, capsys, monkeypatch, tmp_path):
    code, out, err = run_cli(["login", "--url", fake.url, "--key", KEY, "--account", "paper"], capsys, monkeypatch, {"MCB_HOME": str(tmp_path)})
    assert code == 0 and "Saved to" in out and (tmp_path / "client.json").exists()
    assert KEY not in out
    code, out, err = run_cli(["ping"], capsys, monkeypatch, {"MCB_HOME": str(tmp_path)})
    assert code == 0 and "authenticated=True" in out


def test_cli_usage_and_version_and_strategy_entry_kept(capsys, monkeypatch):
    code, out, err = run_cli([], capsys, monkeypatch)
    assert code == 2 and "strategy describe|run" in err
    code, out, err = run_cli(["version"], capsys, monkeypatch)
    assert code == 0 and out.strip() == "0.3.0"
    code, out, err = run_cli(["bogus"], capsys, monkeypatch)
    assert code == 2
