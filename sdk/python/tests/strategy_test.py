"""pytest: the strategy API (mrchartist_bridge/strategy.py) and the four shipped examples, against a fake Bridge.

Run from the repository root:  pytest sdk/python/tests/strategy_test.py
"""

from __future__ import annotations

import io
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SDK = HERE.parent
sys.path.insert(0, str(SDK))
sys.path.insert(0, str(HERE))

from fake_bridge import EXPIRY, KEY, FakeBridge, order_event, tick  # noqa: E402
from mrchartist_bridge import BridgeClient  # noqa: E402
from mrchartist_bridge.errors import BridgeApiError  # noqa: E402
from mrchartist_bridge.strategy import (  # noqa: E402
    IST,
    PROTOCOL_PREFIX,
    Bar,
    BarBuilder,
    ConfigError,
    Param,
    Strategy,
    StrategyLogger,
    build_book,
    chain_legs,
    describe_file,
    load_strategy_class,
    option_parts,
    resolve_params,
)

EXAMPLES = SDK / "examples" / "strategies"
T0 = datetime(2026, 10, 30, 10, 0, tzinfo=IST).timestamp()


class Clock:
    def __init__(self, t: float = T0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


class FakeStream:
    """Stands in for BridgeStream: messages put() here come out of iteration; close() ends it."""

    def __init__(self) -> None:
        self.q: "queue.Queue" = queue.Queue()
        self.subscribed = []
        self.closed = False

    def put(self, msg):
        self.q.put(msg)

    def subscribe(self, symbols, mode="ltp"):
        self.subscribed.extend(symbols)

    def close(self):
        self.closed = True
        self.q.put(None)

    def __iter__(self):
        while True:
            m = self.q.get()
            if m is None:
                return
            yield m


@pytest.fixture()
def bridge():
    fb = FakeBridge()
    yield fb
    fb.close()


def make(cls, fb, params=None, *, clock=None, sid="t", out=None, runner=True):
    out = out if out is not None else io.StringIO()
    client = BridgeClient(fb.url, KEY, max_retries=0)
    return cls(client, account="demo-paper", params=params, strategy_id=sid, run_id="run001", logger=StrategyLogger(out, runner=runner), clock=clock or Clock()), out


def messages(out):
    return [json.loads(line[len(PROTOCOL_PREFIX):]) for line in out.getvalue().splitlines() if line.startswith(PROTOCOL_PREFIX)]


def logs(out):
    return [m["msg"] for m in messages(out) if m["t"] == "log"]


# ── params ──


def test_param_types_and_checks():
    assert Param(1).kind == "int" and Param(0.5).kind == "float" and Param(True).kind == "bool" and Param("x").kind == "str"
    assert Param("a", choices=["a", "b"]).kind == "choice"
    p = Param(1, min=1, max=10)
    assert p.coerce("4") == 4
    with pytest.raises(ValueError, match="at most 10"):
        p.coerce(11)
    with pytest.raises(ValueError, match="whole number"):
        p.coerce(1.5)
    with pytest.raises(ValueError, match="a number"):
        p.coerce(True)
    assert Param(True).coerce("false") is False
    with pytest.raises(ValueError):
        Param("a", choices=["b"])
    with pytest.raises(TypeError):
        Param([1])
    values, problems = resolve_params({"lots": p, "on": Param(True)}, {"lots": 3, "nope": 1})
    assert values == {"lots": 3, "on": True}
    assert problems == ["nope: not a param of this strategy"]


def test_bad_params_refuse_to_construct(bridge):
    class S(Strategy):
        params = {"lots": Param(1, min=1, max=5)}

    with pytest.raises(ValueError, match="lots: must be at most 5"):
        make(S, bridge, {"lots": 9})


# ── describe (never runs the file) ──


def test_describe_reads_literals_without_running(tmp_path):
    f = tmp_path / "s.py"
    f.write_text('import sys\nsys.exit(9)\nfrom mrchartist_bridge.strategy import Strategy, Param\nclass A(Strategy):\n    """Doc line."""\n    name = "A thing"\n    symbols = ["NSE:NIFTY"]\n    timeframes = ["1m"]\n    timer_seconds = 5\n    params = {"lots": Param(2, min=1, max=9, help="Lots"), "u": Param("NIFTY", choices=["NIFTY", "BANKNIFTY"])}\n')
    d = describe_file(str(f))
    assert d == {"className": "A", "name": "A thing", "description": "Doc line.", "symbols": ["NSE:NIFTY"], "timeframes": ["1m"], "timerSeconds": 5, "params": [{"name": "lots", "kind": "int", "default": 2, "min": 1, "max": 9, "help": "Lots"}, {"name": "u", "kind": "choice", "default": "NIFTY", "choices": ["NIFTY", "BANKNIFTY"]}]}
    f.write_text('from mrchartist_bridge.strategy import Strategy, Param\nclass A(Strategy):\n    params = {"x": Param(open("/etc/passwd").read())}\n')
    with pytest.raises(ValueError, match="literal values only") as e:
        describe_file(str(f))
    assert e.value.line == 3
    f.write_text("class A: pass\n")
    with pytest.raises(ValueError, match="exactly one class"):
        describe_file(str(f))
    f.write_text('from mrchartist_bridge.strategy import Strategy\nclass A(Strategy):\n    timeframes = ["7m"]\n')
    with pytest.raises(ValueError, match="Unknown timeframe"):
        describe_file(str(f))


def test_describe_cli_reports_the_line_of_a_problem(tmp_path):
    env = dict(os.environ, PYTHONPATH=str(SDK))
    f = tmp_path / "s.py"
    f.write_text("from mrchartist_bridge.strategy import Strategy\n\nclass A(Strategy)\n    pass\n")
    r = subprocess.run([sys.executable, "-m", "mrchartist_bridge", "strategy", "describe", str(f)], capture_output=True, text=True, env=env, cwd=str(SDK), timeout=30)
    d = json.loads(r.stdout)
    assert r.returncode == 3 and d["ok"] is False and d["line"] == 3 and d["error"].startswith("SyntaxError")
    f.write_text('from mrchartist_bridge.strategy import Strategy, Param\nclass A(Strategy):\n    timeframes = ["1m"]\n    params = {\n        "a": Param(1),\n        "b": Param(1, colour=2),\n    }\n')
    d = json.loads(subprocess.run([sys.executable, "-m", "mrchartist_bridge", "strategy", "describe", str(f)], capture_output=True, text=True, env=env, cwd=str(SDK), timeout=30).stdout)
    assert d["line"] == 6 and "unknown option colour" in d["error"]


def test_describe_cli_and_examples_and_template():
    env = dict(os.environ, PYTHONPATH=str(SDK))
    for f in sorted(EXAMPLES.glob("*.py")):
        r = subprocess.run([sys.executable, "-m", "mrchartist_bridge", "strategy", "describe", str(f)], capture_output=True, text=True, env=env, cwd=str(SDK), timeout=30)
        assert r.returncode == 0, r.stdout + r.stderr
        d = json.loads(r.stdout)
        assert d["ok"] and d["strategy"]["params"], f.name
        assert d["strategy"]["description"]
    # The dashboard's "How to write one" template describes and loads too.
    js = (SDK.parent.parent / "server" / "bridge" / "dashboard" / "algo-core.js").read_text()
    template = re.search(r"export const TEMPLATE = `([\s\S]*?)`;", js).group(1)
    tmp = HERE / "_template_check.py"
    try:
        tmp.write_text(template)
        d = describe_file(str(tmp))
        assert [p["name"] for p in d["params"]] == ["lots", "max_trades"]
        assert issubclass(load_strategy_class(str(tmp)), Strategy)
    finally:
        tmp.unlink()


# ── bars and the book ──


def test_bar_builder_finishes_a_bar_on_the_next_bucket():
    b = BarBuilder(["15s", "1m"])
    t = 1_793_340_000_000  # a whole minute
    assert b.add("X", 10, t) == []
    assert b.add("X", 12, t + 5000) == []
    assert b.add("X", 9, t + 10_000) == []
    done = b.add("X", 11, t + 16_000)
    assert len(done) == 1 and (done[0].open, done[0].high, done[0].low, done[0].close, done[0].ticks, done[0].timeframe) == (10, 12, 9, 9, 3, "15s")
    done = b.add("X", 11, t + 61_000)
    assert [x.timeframe for x in done] == ["15s", "1m"]
    with pytest.raises(ValueError):
        BarBuilder(["7m"])


def test_build_book_matches_the_runner_rule():
    o = lambda side, q, px, t: {"symbol": "S", "side": side, "filledQuantity": q, "avgPrice": px, "placedAt": t, "orderId": t}  # noqa: E731
    b = build_book([o("SELL", 65, 100, "1"), o("SELL", 65, 110, "2"), o("BUY", 65, 90, "3")], {"S": 95})
    assert b["positions"]["S"]["qty"] == -65 and b["positions"]["S"]["avg"] == 105
    assert (b["realised"], b["unrealised"], b["total"]) == (975.0, 650.0, 1625.0)


def test_option_helpers():
    assert option_parts("NFO:NIFTY-2026-11-03-26100-CE") == {"exchange": "NFO", "underlying": "NIFTY", "expiry": "2026-11-03", "strike": 26100, "right": "CE"}
    assert option_parts("NFO:NIFTY-2026-11-23-FUT") is None
    legs = chain_legs({"rows": [{"strike": 100, "ce": {"symbol": "A", "delta": 0.5}, "pe": {"symbol": "B", "delta": -0.5}}]})
    assert legs["A"]["right"] == "CE" and legs["B"]["strike"] == 100


# ── orders always go through the Bridge's REST API, on the strategy's own account ──


def test_orders_use_the_rest_api_with_key_idempotency_account_mode_and_prefix(bridge):
    class S(Strategy):
        pass

    s, out = make(S, bridge, sid="my_algo")
    o = s.buy("NFO:NIFTY-2026-11-03-26000-CE", lots=2)
    assert o["status"] == "filled"
    req = bridge.find("POST", "/v1/orders")[0]
    assert req["auth"] == "Bearer " + KEY
    assert re.match(r"^[0-9a-f-]{36}$", req["idem"])
    assert req["body"] == {"account": "demo-paper", "symbol": "NFO:NIFTY-2026-11-03-26000-CE", "side": "BUY", "product": "MARGIN", "orderType": "MARKET", "mode": "paper", "clientOrderId": "A-my_algo-run001-1", "lots": 2}
    s.sell("NFO:NIFTY-2026-11-03-26000-PE", quantity=65, order_type="LIMIT", price=100.5)
    assert bridge.find("POST", "/v1/orders")[1]["body"]["price"] == 100.5
    assert s.positions() == {"NFO:NIFTY-2026-11-03-26000-CE": 130, "NFO:NIFTY-2026-11-03-26000-PE": -65}
    assert any("BUY 2 lots" in m for m in logs(out))
    assert any(m["t"] == "order" for m in messages(out))


def test_a_refused_order_raises_is_logged_and_counted(bridge):
    class S(Strategy):
        pass

    s, out = make(S, bridge)
    with pytest.raises(BridgeApiError) as e:
        s.buy("NFO:NIFTY-2026-11-03-26000-CE", lots=50)
    assert e.value.code == "INVALID_ORDER"
    assert s.counts["refused"] == 1 and s.positions() == {}
    assert any("Order refused" in m and "INVALID_ORDER" in m for m in logs(out))


def test_exit_closes_only_this_strategys_position(bridge):
    class S(Strategy):
        pass

    s, _ = make(S, bridge, sid="a")
    other, _ = make(S, bridge, sid="b")
    other.buy("NFO:NIFTY-2026-11-03-26000-CE", lots=3)
    s.sell("NFO:NIFTY-2026-11-03-26000-CE", lots=1)
    s.buy("NFO:NIFTY-2026-11-03-26100-PE", lots=1)
    sent = s.exit_all()
    assert [o["side"] for o in sent] == ["BUY", "SELL"]  # shorts bought back first
    assert s.positions() == {} and other.positions() == {"NFO:NIFTY-2026-11-03-26000-CE": 195}
    assert s.exit("NFO:NIFTY-2026-11-03-26000-CE") is None


def test_positions_survive_a_restart_from_the_bridge_and_pnl_prices_them(bridge):
    class S(Strategy):
        pass

    s, _ = make(S, bridge, sid="keep")
    s.sell("NFO:NIFTY-2026-11-03-26000-CE", lots=1)
    again, _ = make(S, bridge, sid="keep")
    again.refresh_orders()
    assert again.positions() == {"NFO:NIFTY-2026-11-03-26000-CE": -65}
    bridge.prices["NFO:NIFTY-2026-11-03-26000-CE"] = 100.0
    p = again.pnl()
    assert p["unrealised"] == round(-65 * (100 - 120), 2)


def test_order_updates_go_only_to_the_owner(bridge):
    seen = []

    class S(Strategy):
        def on_order_update(self, order):
            seen.append((order["orderId"], order["status"]))

    s, _ = make(S, bridge, sid="own")
    o = s.buy("NFO:NIFTY-2026-11-03-26000-CE", lots=1)
    s.dispatch(order_event(o, status="cancelled"))
    s.dispatch(order_event(dict(o, orderId="X", clientOrderId="A-other-1-1"), status="filled"))
    s.dispatch(order_event(dict(o, orderId="Y", clientOrderId="A-own_x-1-1"), status="filled"))
    assert seen == [(o["orderId"], "cancelled")]


# ── callbacks and the run loop ──


def test_ticks_feed_on_tick_and_bars(bridge):
    got = {"ticks": 0, "bars": []}

    class S(Strategy):
        timeframes = ["15s"]

        def on_tick(self, q):
            got["ticks"] += 1
            assert q.ltp == q["ltp"]

        def on_bar(self, bar, tf):
            got["bars"].append((bar.close, tf))

    s, _ = make(S, bridge)
    t = 1_793_340_000_000
    s.dispatch({"type": "snapshot", "ticks": [{"symbol": "NSE:NIFTY", "ltp": 1.0, "receivedAt": t}]})
    for i, px in enumerate([10, 11, 12, 13]):
        s.dispatch(tick("NSE:NIFTY", px, t + i * 8000))
    assert got["ticks"] == 4
    assert got["bars"] == [(11, "15s")]
    assert s.quote("NSE:NIFTY").ltp == 13


def test_an_exception_in_a_callback_is_logged_and_too_many_in_a_row_stop_it(bridge):
    class S(Strategy):
        max_consecutive_errors = 3

        def on_tick(self, q):
            raise KeyError("missing")

    s, out = make(S, bridge)
    s.dispatch(tick("X", 1, 1))
    s.dispatch(tick("X", 1, 2))
    assert any("KeyError in on_tick" in m for m in logs(out))
    with pytest.raises(RuntimeError, match="3 errors in a row"):
        s.dispatch(tick("X", 1, 3))


def run_in_thread(s, stream):
    box = {}
    th = threading.Thread(target=lambda: box.setdefault("code", s.run(stream=stream, install_signals=False, watch_stdin=False)), daemon=True)
    th.start()
    return th, box


def test_run_loop_hello_heartbeat_timer_stop_and_on_stop(bridge):
    calls = []

    class S(Strategy):
        timer_seconds = 0.05

        def on_start(self):
            calls.append("start")

        def on_timer(self):
            calls.append("timer")

        def on_stop(self):
            calls.append("stop")

    s, out = make(S, bridge, clock=time.time)
    stream = FakeStream()
    th, box = run_in_thread(s, stream)
    time.sleep(0.4)
    stream.put(tick("NSE:NIFTY", 5, time.time() * 1000))
    time.sleep(0.2)
    s.stop("test over")
    th.join(5)
    assert box["code"] == 0
    assert calls[0] == "start" and "timer" in calls and calls[-1] == "stop"
    kinds = [m["t"] for m in messages(out)]
    assert kinds[0] == "hello" and "heartbeat" in kinds and kinds[-1] == "bye"
    assert messages(out)[-1]["reason"] == "test over" and stream.closed


def test_a_crash_in_on_start_exits_1_and_a_config_error_exits_3(bridge):
    class Crash(Strategy):
        def on_start(self):
            raise RuntimeError("boom")

    class Conf(Strategy):
        def on_start(self):
            raise ConfigError("fast must be shorter than slow")

    s, out = make(Crash, bridge)
    assert s.run(stream=FakeStream(), install_signals=False, watch_stdin=False) == 1
    assert any("Crashed: RuntimeError: boom" in m for m in logs(out))
    s, out = make(Conf, bridge)
    assert s.run(stream=FakeStream(), install_signals=False, watch_stdin=False) == 3
    assert any("Settings problem" in m for m in logs(out))


def test_the_stream_ending_counts_as_a_crash(bridge):
    class S(Strategy):
        pass

    s, out = make(S, bridge)
    stream = FakeStream()
    stream.close()
    assert s.run(stream=stream, install_signals=False, watch_stdin=False) == 1
    assert any("live stream ended" in m for m in logs(out))


def test_sigterm_runs_on_stop_in_a_real_process(bridge, tmp_path):
    f = tmp_path / "s.py"
    f.write_text("from mrchartist_bridge.strategy import Strategy\nclass S(Strategy):\n    def on_start(self):\n        self.buy('NFO:NIFTY-%s-26000-CE', lots=1)\n    def on_stop(self):\n        self.exit_all()\n" % EXPIRY)
    env = dict(os.environ, PYTHONPATH=str(SDK), MCB_BRIDGE_URL=bridge.url, MCB_API_KEY=KEY, MCB_STRATEGY_ACCOUNT="demo-paper", MCB_STRATEGY_ID="sig", MCB_STRATEGY_RUNNER="1", MCB_STRATEGY_PARAMS="{}")
    # No real stream in the fake: the run fails to open one, which is a crash (exit 1) unless SIGTERM came first.
    p = subprocess.Popen([sys.executable, "-u", "-m", "mrchartist_bridge", "strategy", "run", str(f)], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    lines = []
    for line in p.stdout:
        lines.append(line)
        if "BUY 1 lot" in line:
            break
    p.terminate()
    rest, err = p.communicate(timeout=20)
    text = "".join(lines) + rest
    assert '"t":"hello"' in text
    sides = [r["body"]["side"] for r in bridge.find("POST", "/v1/orders")]
    assert sides[0] == "BUY" and "SELL" in sides, text + err


def test_load_errors_exit_3(tmp_path):
    f = tmp_path / "broken.py"
    f.write_text("this is not python\n")
    env = dict(os.environ, PYTHONPATH=str(SDK), MCB_STRATEGY_RUNNER="1", MCB_STRATEGY_ACCOUNT="x", MCB_API_KEY=KEY)
    r = subprocess.run([sys.executable, "-m", "mrchartist_bridge", "strategy", "run", str(f)], env=env, capture_output=True, text=True, timeout=30)
    assert r.returncode == 3
    assert "Could not load broken.py" in r.stdout


# ── the four examples place orders against the fake Bridge ──


def load(name):
    return load_strategy_class(str(EXAMPLES / name))


def test_short_straddle_sells_both_legs_and_takes_the_stop_loss(bridge):
    s, out = make(load("short_straddle.py"), bridge, {"stop_loss_pct": 10}, sid="short_straddle")
    s.on_start()
    assert sorted(o["side"] for o in s.orders()) == ["SELL", "SELL"]
    assert all(o["symbol"].endswith(("-26000-CE", "-26000-PE")) for o in s.orders())
    for sym in s.legs:
        bridge.prices[sym] = 200.0  # 120 + 120 -> 400: past the 10 % stop
    s.on_timer()
    assert s.positions() == {} and s.stopping
    assert any("stop loss" in m for m in logs(out))


def test_ema_crossover_trades_an_option_on_the_cross(bridge):
    s, out = make(load("ema_crossover.py"), bridge, {"timeframe": "15s", "fast": 2, "slow": 3}, sid="ema_crossover")
    s.on_start()
    fut = s.future
    assert fut == "NFO:NIFTY-2026-11-23-FUT"
    t0 = 1_793_340_000_000
    prices = [100, 101, 102, 103, 104, 90, 80, 70, 60]
    for i, px in enumerate(prices):
        s.dispatch(tick(fut, px, t0 + i * 15_000))
    sides = [(o["side"], o["symbol"][-2:]) for o in s.orders()]
    assert sides[0] == ("BUY", "CE")  # entered long when ready
    assert ("SELL", "CE") in sides and sides[-1] == ("BUY", "PE")  # reversed on the cross down
    assert any("going short" in m for m in logs(out))


def test_ema_crossover_future_mode_meets_the_bridge_limit(bridge):
    bridge.max_lots = 0
    s, out = make(load("ema_crossover.py"), bridge, {"timeframe": "15s", "fast": 2, "slow": 3, "trade": "future"}, sid="ema_f")
    s.on_start()
    for i in range(6):
        s.dispatch(tick(s.future, 100 + i, 1_793_340_000_000 + i * 15_000))
    assert s.orders() == [] and s.counts["refused"] == 1
    with pytest.raises(ConfigError):
        make(load("ema_crossover.py"), bridge, {"fast": 9, "slow": 9})[0].on_start()


def test_iron_condor_opens_four_legs_wings_first_and_rolls_on_delta(bridge):
    s, out = make(load("iron_condor.py"), bridge, {"adjust_delta": 0.05}, sid="iron_condor")
    s.on_start()
    first = [(o["side"], o["symbol"][-2:]) for o in s.orders()]
    assert first == [("BUY", "CE"), ("SELL", "CE"), ("BUY", "PE"), ("SELL", "PE")]
    assert len([q for q in s.positions().values() if q]) == 4
    bridge.spot = 26300.0  # the market runs up: short call tested, net delta negative
    s.on_timer()
    assert s.adjustments == 1
    assert any("rolling the PE side" in m for m in logs(out))
    assert len([q for q in s.positions().values() if q]) == 4


def test_oi_walls_follows_the_pcr_and_buys_back_on_a_break(bridge):
    s, out = make(load("oi_walls.py"), bridge, sid="oi_walls")
    s.on_start()  # PCR 1.0: both sides at the walls below and above the spot
    held = {k: v for k, v in s.positions().items() if v}
    assert sorted(k[-8:] for k in held) == ["25850-PE", "26200-CE"]
    bridge.pcr = 1.5  # bullish: only the put
    s.on_timer()
    assert [k[-2:] for k, v in s.positions().items() if v] == ["PE"]
    bridge.spot = 25800.0  # breaks the 25850 support
    s.on_timer()
    assert any("broke the 25850 support" in m for m in logs(out))


def test_a_refusal_that_a_restart_cannot_fix_exits_4(bridge):
    class S(Strategy):
        def on_start(self):
            self.buy("NFO:NIFTY-2026-11-03-26000-CE", lots=1)

    bridge.kill_switch = True
    s, out = make(S, bridge)
    assert s.run(stream=FakeStream(), install_signals=False, watch_stdin=False) == 4
    assert any("Not restarted" in m for m in logs(out))
    bridge.kill_switch = False
    bridge.max_lots = 0  # INVALID_ORDER stays a crash: the runner restarts it with back-off
    s, out = make(S, bridge)
    assert s.run(stream=FakeStream(), install_signals=False, watch_stdin=False) == 1


def refuse_when(bridge, test, code="DAILY_LIMIT_REACHED"):
    real = bridge.route

    def route(method, path, q, body):
        if method == "POST" and path == "/v1/orders" and test(body):
            return 403, {"status": 403, "code": code, "detail": "refused", "retryable": False}
        return real(method, path, q, body)

    bridge.route = route


def test_short_straddle_never_keeps_half_a_straddle(bridge):
    refuse_when(bridge, lambda b: b["symbol"].endswith("-PE") and b["side"] == "SELL")
    s, out = make(load("short_straddle.py"), bridge, sid="half")
    s.on_start()
    assert [(o["side"], o["symbol"][-2:]) for o in s.orders()] == [("SELL", "CE"), ("BUY", "CE")]
    assert s.positions() == {} and s.stopping


def test_iron_condor_closes_a_partial_condor(bridge):
    refuse_when(bridge, lambda b: b["symbol"].endswith("-PE") and b["side"] == "SELL" and "lots" in b)  # the entry, not the exit
    s, out = make(load("iron_condor.py"), bridge, sid="half_ic")
    s.on_start()
    assert s.positions() == {} and s.stopping
    assert any("refused a leg" in m for m in logs(out))


# ── a whole run of each example stays inside its order budget (no re-entry churn) ──


def walk(n, start=26000.0, step=6.0, seed=7):
    import random

    r = random.Random(seed)
    x = start
    out = []
    for _ in range(n):
        x += r.uniform(-step, step)
        out.append(round(x, 2))
    return out


def full_run(s, bridge, spots, *, symbol="NSE:NIFTY", every_tick=None):
    """on_start, then one tick (and, for timer strategies, one on_timer) per spot, then on_stop: a run in fast time."""
    s.on_start()
    t0 = 1_793_340_000_000
    for i, x in enumerate(spots):
        if s.stopping:
            break
        bridge.spot = x
        s.dispatch(tick(every_tick or symbol, x + (100 if every_tick else 0), t0 + i * 15_000))
        if type(s).timer_seconds:
            s._call(s.on_timer)
    s.on_stop()
    return s.orders()


def test_short_straddle_run_places_two_entries_and_two_exits_at_most(bridge):
    s, _ = make(load("short_straddle.py"), bridge, {"max_entries": 5}, sid="budget_sd")
    orders = full_run(s, bridge, walk(400))
    assert [o["side"] for o in orders].count("SELL") == 2
    assert len(orders) <= 4 and s.positions() == {}


def test_short_straddle_after_its_exit_does_not_enter_again_in_the_same_run(bridge):
    s, _ = make(load("short_straddle.py"), bridge, {"max_entries": 5, "stop_loss_pct": 5}, sid="budget_sd2")
    s.on_start()
    for sym in s.legs:
        bridge.prices[sym] = 400.0  # the premium jumps: stop loss
    for _ in range(50):
        if not s.stopping:
            s.on_timer()
        s.dispatch(tick("NSE:NIFTY", 26000, 1_793_340_000_000))
    s.on_stop()
    assert len(s.orders()) == 4 and s.stopping


def test_iron_condor_run_stays_inside_entry_plus_rolls_plus_exit(bridge):
    s, _ = make(load("iron_condor.py"), bridge, {"adjust_delta": 0.02, "max_adjustments": 3}, sid="budget_ic")
    orders = full_run(s, bridge, walk(400, step=25, seed=3))
    assert len(orders) <= 4 + 4 * 3 + 4, len(orders)
    assert s.adjustments <= 4  # 3 rolls, plus the one "used up" notice


def test_iron_condor_does_not_roll_a_side_that_is_already_at_short_delta(bridge):
    s, out = make(load("iron_condor.py"), bridge, {"adjust_delta": 0.02}, sid="budget_ic2")
    s.on_start()
    bridge.spot += 40  # net delta passes 0.02, but the put side is still near 0.2 delta
    for _ in range(20):
        s.on_timer()
    assert len(s.orders()) == 4
    assert any("nothing to roll" in m for m in logs(out))


def test_ema_crossover_holds_each_side_and_ignores_noise_inside_the_band(bridge):
    s, out = make(load("ema_crossover.py"), bridge, {"timeframe": "15s", "fast": 3, "slow": 8, "hold_bars": 3, "band_pct": 0.02}, sid="budget_ema")
    s.on_start()
    fut = s.future
    t0 = 1_793_340_000_000
    # Noise of +-2 points around 26100 (under 0.01 %): after the first entry nothing may flip.
    noise = [26100 + (2 if i % 2 else -2) for i in range(200)]
    for i, x in enumerate(noise):
        s.dispatch(tick(fut, x, t0 + i * 15_000))
    assert len(s.orders()) <= 1
    # A trending, choppy walk: every reversal is at least hold_bars bars after the last one.
    s2, out2 = make(load("ema_crossover.py"), bridge, {"timeframe": "15s", "fast": 3, "slow": 8, "hold_bars": 3}, sid="budget_ema2")
    s2.on_start()
    flips = []
    for i, x in enumerate(walk(600, step=15, seed=11)):
        before = len(s2.orders())
        s2.dispatch(tick(fut, x, t0 + i * 15_000))
        if len(s2.orders()) > before:
            flips.append(i)
    gaps = [b - a for a, b in zip(flips, flips[1:])]
    assert gaps and min(gaps) >= 3
    assert len(s2.orders()) <= 1 + 2 * (600 // 3)


def test_oi_walls_run_sells_each_wall_once_while_nothing_changes(bridge):
    s, _ = make(load("oi_walls.py"), bridge, sid="budget_oi")
    orders = full_run(s, bridge, walk(300, step=2))  # the spot stays well inside the walls
    sells = [o for o in orders if o["side"] == "SELL"]
    assert len(sells) == 2 and len(orders) == 4  # two entries, two exits on stop


def test_leftover_legs_that_are_not_a_whole_position_are_closed_before_a_fresh_entry(bridge):
    # A lone condor wing left by a cut-short exit: closed, then a whole condor opened.
    seed, _ = make(load("iron_condor.py"), bridge, sid="left_ic")
    seed.buy("NFO:NIFTY-%s-26400-CE" % EXPIRY, lots=1)
    ic, out = make(load("iron_condor.py"), bridge, sid="left_ic")
    ic.refresh_orders()
    ic.on_start()
    assert any("not a whole condor" in m for m in logs(out))
    held = {s: q for s, q in ic.positions().items() if q}
    assert len(held) == 4 and type(ic).whole_condor(held)
    # A lone straddle leg: closed, then both legs sold.
    seed, _ = make(load("short_straddle.py"), bridge, sid="left_sd")
    seed.sell("NFO:NIFTY-%s-26000-PE" % EXPIRY, lots=1)
    sd, out = make(load("short_straddle.py"), bridge, {"max_entries": 5}, sid="left_sd")
    sd.refresh_orders()
    sd.on_start()
    assert any("not a whole straddle" in m for m in logs(out))
    held = {s: q for s, q in sd.positions().items() if q}
    assert sorted(s[-2:] for s in held) == ["CE", "PE"] and all(q < 0 for q in held.values())


def test_a_new_run_says_which_legs_it_resumed_and_places_no_new_entry(bridge):
    first, _ = make(load("iron_condor.py"), bridge, sid="resume_ic")
    first.on_start()  # four legs, left open (no on_stop): the Bridge stopped, say
    again, out = make(load("iron_condor.py"), bridge, sid="resume_ic", clock=Clock())
    again.run_id = "run002"
    ended = FakeStream()
    ended.close()  # the stream ends at once: the run stops (as a crash) right after on_start
    assert again.run(stream=ended, install_signals=False, watch_stdin=False) == 1
    msgs = messages(out)
    assert [m for m in msgs if m["t"] == "resumed"] == [{"t": "resumed", "legs": 4}]
    assert any(m.startswith("Resumed 4 open legs from an earlier run today") for m in logs(out))
    # It placed no entry of its own: on_stop's exits (shorts bought back first) are the only orders of the new run.
    new = [o for o in again.orders() if "-run002-" in o["clientOrderId"]]
    assert len(new) == 4 and {o["side"] for o in new[:2]} == {"BUY"}
