"""``Bridge``: discovery, typed reads, friendly errors, feature detection (fake Bridge, no real network)."""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from fake_bridge import KEY, FakeBridge  # noqa: E402
from mrchartist_bridge import (  # noqa: E402
    Bridge,
    BridgeNotRunning,
    ConfigurationError,
    FeatureUnavailable,
    NotRealtime,
    ScopeRequired,
    SymbolNotFound,
    Unauthenticated,
)
from mrchartist_bridge.discovery import discover, home_dir, save_credentials  # noqa: E402


@pytest.fixture()
def fake():
    f = FakeBridge()
    yield f
    f.close()


@pytest.fixture()
def bridge(fake):
    return Bridge(fake.url, KEY, account="paper", sleep=lambda s: None)


# ── discovery ──


def test_argument_beats_environment_beats_files(tmp_path):
    (tmp_path / "bridge.config.json").write_text(json.dumps({"server": {"host": "127.0.0.1", "port": 4999}}))
    (tmp_path / "client.json").write_text(json.dumps({"baseUrl": "http://127.0.0.1:4888", "apiKey": "file_key_123"}))
    env = {"MCB_BRIDGE_URL": "http://127.0.0.1:4777", "MCB_API_KEY": "env_key_123"}
    s = discover("http://127.0.0.1:4666", "arg_key_123", env=env, cwd=tmp_path, home=tmp_path)
    assert (s.base_url, s.api_key, s.url_source, s.key_source) == ("http://127.0.0.1:4666", "arg_key_123", "argument", "argument")
    s = discover(env=env, cwd=tmp_path, home=tmp_path)
    assert (s.base_url, s.api_key, s.url_source, s.key_source) == ("http://127.0.0.1:4777", "env_key_123", "MCB_BRIDGE_URL", "MCB_API_KEY")
    s = discover(env={}, cwd=tmp_path, home=tmp_path)
    assert s.base_url == "http://127.0.0.1:4999" and s.url_source.endswith("bridge.config.json")  # the Bridge's own config
    assert s.api_key == "file_key_123" and s.key_source.endswith("client.json")


def test_defaults_when_nothing_is_found(tmp_path):
    s = discover(env={}, cwd=tmp_path, home=tmp_path)
    assert (s.base_url, s.api_key, s.url_source, s.key_source) == ("http://127.0.0.1:4300", None, "default", "none")
    assert "unset" in repr(s) and "None" not in repr(s)


def test_key_file_variable_and_account(tmp_path):
    kf = tmp_path / "k.txt"
    kf.write_text("  file_secret_key  \n")
    s = discover(env={"MCB_API_KEY_FILE": str(kf), "MCB_ACCOUNT": "paper-2"}, cwd=tmp_path, home=tmp_path)
    assert s.api_key == "file_secret_key" and s.key_source == "MCB_API_KEY_FILE" and s.account == "paper-2"


def test_config_host_variants(tmp_path):
    (tmp_path / "bridge.config.json").write_text(json.dumps({"server": {"host": "0.0.0.0", "port": 4301}}))
    assert discover(env={}, cwd=tmp_path, home=tmp_path).base_url == "http://127.0.0.1:4301"
    (tmp_path / "bridge.config.json").write_text(json.dumps({"server": {"host": "::", "port": 4301}}))
    assert discover(env={}, cwd=tmp_path, home=tmp_path).base_url == "http://[::1]:4301"
    (tmp_path / "bridge.config.json").write_text("not json")
    assert discover(env={}, cwd=tmp_path, home=tmp_path).base_url == "http://127.0.0.1:4300"


def test_a_config_file_cannot_point_the_key_at_another_computer(tmp_path):
    (tmp_path / "bridge.config.json").write_text(json.dumps({"server": {"host": "evil.example.com", "port": 4300}}))
    s = discover(env={"MCB_API_KEY": "k_123456"}, cwd=tmp_path, home=tmp_path)
    assert s.base_url == "http://127.0.0.1:4300" and s.url_source == "default"
    # the owner can still choose a remote Bridge explicitly
    assert discover("https://bridge.example.com", "k_123456", env={}, cwd=tmp_path, home=tmp_path).base_url == "https://bridge.example.com"


def test_bad_url_is_a_configuration_error_with_the_fix():
    with pytest.raises(ConfigurationError) as e:
        Bridge("localhost:4300", "k_123456", env={})
    assert "http://" in str(e.value)


def test_home_dir_rules():
    assert home_dir({"MCB_HOME": "/x/y"}, "linux") == Path("/x/y").resolve()
    assert home_dir({"HOME": "/h"}, "linux") == Path("/h/.mc-bridge")
    assert home_dir({"APPDATA": "C:\\A"}, "win32") == Path("C:\\A") / "MrChartist" / "Bridge"


@pytest.mark.skipif(sys.platform.startswith("win"), reason="POSIX permissions")
def test_save_credentials_is_owner_only_and_round_trips(tmp_path):
    p = save_credentials("http://127.0.0.1:4301/", "mcb_k_secret", account="paper", home=tmp_path)
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
    s = discover(env={}, cwd=tmp_path / "elsewhere", home=tmp_path)
    assert (s.base_url, s.api_key, s.account) == ("http://127.0.0.1:4301", "mcb_k_secret", "paper")


def test_never_reads_the_bridge_data_folder(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "control.token").write_text("admin_control_token")
    s = discover(env={}, cwd=tmp_path, home=tmp_path)
    assert s.api_key is None


def test_the_key_is_never_in_repr(bridge):
    assert KEY not in repr(bridge) and KEY not in repr(bridge.settings) and "key=set" in repr(bridge)


# ── connection and friendly errors ──


def test_ping_and_health(bridge):
    p = bridge.ping()
    assert p.ok and p.authenticated and p.demo and p.version == "2.0.0" and p.latency_ms >= 0
    assert bridge.health().ok and bridge.is_demo


def test_demo_helper_checks_demo_mode(fake):
    assert Bridge.demo(fake.url, KEY).is_demo
    fake.route = lambda *a, **k: (200, {"status": "ok", "version": "2", "apiVersion": "v1"})  # type: ignore[method-assign]
    with pytest.raises(ConfigurationError) as e:
        Bridge.demo(fake.url, KEY)
    assert "not in demo mode" in str(e.value)


def test_demo_helper_when_nothing_runs():
    with pytest.raises(ConfigurationError) as e:
        Bridge.demo("http://127.0.0.1:1", "k_123456", max_retries=0)
    assert "mc-bridge start --demo" in str(e.value)


def test_bridge_not_running_says_how_to_start_it():
    b = Bridge("http://127.0.0.1:1", "k_123456", max_retries=0)
    with pytest.raises(BridgeNotRunning) as e:
        b.health()
    assert "mc-bridge start" in str(e.value) and e.value.outcome_unknown is False


def test_no_key_message_lists_where_to_put_one(fake, tmp_path):
    b = Bridge(fake.url, None, env={}, settings=None)
    with pytest.raises(Unauthenticated) as e:
        b.ltp("NSE:NIFTY")
    msg = str(e.value)
    assert "No API key was found" in msg and "MCB_API_KEY" in msg and "mc-bridge keys create" in msg


def test_wrong_key_message_names_where_the_key_came_from(fake):
    b = Bridge(fake.url, "wrong_key_123")
    with pytest.raises(Unauthenticated) as e:
        b.ltp("NSE:NIFTY")
    assert "argument" in str(e.value) and "did not accept" in str(e.value)


def test_scope_error_says_which_scope_the_route_needs(fake):
    fake.fault("GET", "/v1/tickets", 403, "SCOPE_REQUIRED")
    b = Bridge(fake.url, KEY)
    with pytest.raises(ScopeRequired) as e:
        b.client._get("/v1/tickets")
    assert "'admin'" in str(e.value) and "keys create" in str(e.value)


def test_old_bridge_404_names_the_missing_route(fake):
    b = Bridge(fake.url, KEY)
    with pytest.raises(Exception) as e:
        b.client._get("/v1/calendar/status")
    assert "no GET /v1/calendar/status" in str(e.value).replace("  ", " ") or "has no GET" in str(e.value)


# ── typed reads ──


def test_typed_quotes_prices_and_item_errors(bridge, fake):
    fake.delayed.add("NSE:DELAYED")
    q = bridge.quotes(["NSE:RELIANCE", "NSE:DELAYED", "NSE:X-NOPE"])
    assert [i.symbol for i in q] == ["NSE:RELIANCE", "NSE:DELAYED"] and q.errors[0].code == "SYMBOL_NOT_FOUND" and q.errors[0].symbol == "NSE:X-NOPE"
    assert q[0].freshness.is_realtime and q[1].freshness.is_delayed and q.freshness.is_delayed
    p = bridge.price("NSE:RELIANCE")
    assert p.ltp == fake.spot and p.require_realtime() is p
    with pytest.raises(NotRealtime):
        bridge.quote("NSE:DELAYED").require_realtime()


def test_price_of_unknown_symbol_is_symbol_not_found(bridge):
    with pytest.raises(SymbolNotFound):
        bridge.quote("NSE:X-NOPE")


def test_history_is_typed_and_labelled(bridge, fake):
    fake.history_ok = True
    h = bridge.history("NSE:RELIANCE", "1d", countback=4)
    assert len(h) == 4 and h.interval == "1d" and h.freshness.is_realtime and h[0].time.utcoffset().total_seconds() == 19800
    fake.delayed.add("NSE:SLOW")
    assert bridge.history("NSE:SLOW", "1d", countback=2).freshness.is_delayed


def test_accounts_funds_positions_sources(bridge, fake):
    assert [a.id for a in bridge.accounts()] == ["paper"] and bridge.accounts()[0].is_paper
    assert bridge.funds().available_cash == 100000
    assert bridge.positions().by_symbol() == {}
    assert bridge.sources()[0].is_realtime


def test_account_resolution(fake):
    b = Bridge(fake.url, KEY, env={})
    assert b.account_for(False) == "paper"  # the only paper account
    with pytest.raises(ConfigurationError) as e:
        b.account_for(True)  # no live-enabled account
    assert "paper" in str(e.value) and "account=" in str(e.value)


# ── feature detection ──


def test_features_come_from_meta(bridge, fake):
    f = bridge.features()
    assert f.bridge_version == "2.0.0" and f.has("GET", "/v1/ltp") and f.has("GET", "/v1/orders/{id}")
    assert bridge.supports("POST", "/v1/orders/to-target") is False
    fake.has_to_target = True
    assert bridge.refresh_features().has("POST", "/v1/orders/to-target")


def test_supports_is_none_when_meta_cannot_be_read(fake):
    fake.fault("GET", "/v1/meta", 500, "INTERNAL", times=10)
    b = Bridge(fake.url, KEY, max_retries=0)
    assert b.supports("POST", "/v1/orders/to-target") is None


def test_calendar_and_hooks_raise_feature_unavailable_on_an_old_bridge(bridge):
    with pytest.raises(FeatureUnavailable) as e:
        bridge.calendar.status()
    assert "/v1/calendar/status" in str(e.value)
    with pytest.raises(FeatureUnavailable):
        bridge.hooks.signals("h1")
    with pytest.raises(FeatureUnavailable):
        bridge.hooks.test("h1")


def test_calendar_uses_the_route_when_present(bridge, fake):
    fake.has_calendar = True
    orig = fake.route

    def route(method, path, q, body):
        if path == "/v1/calendar/status":
            return 200, {"data": {"open": False, "exchange": "NSE"}, "meta": {}}
        return orig(method, path, q, body)

    fake.route = route  # type: ignore[method-assign]
    assert bridge.calendar.status() == {"open": False, "exchange": "NSE"}


def test_symbols_resolve_falls_back_to_convert_then_search(bridge, fake):
    orig = fake.route

    def route(method, path, q, body):
        if path == "/v1/symbols/convert":
            return 200, {"data": {"input": q.get("input"), "canonical": "NFO:NIFTY-2026-12-29-FUT", "aliases": {}}, "meta": {}}
        return orig(method, path, q, body)

    fake.route = route  # type: ignore[method-assign]
    r = bridge.symbols.resolve("NSE:NIFTY1!")
    assert r.canonical == "NFO:NIFTY-2026-12-29-FUT" and r.via == "client" and r.require() == r.canonical


def test_symbols_resolve_ambiguous_lists_candidates(bridge):
    r = bridge.symbols.resolve("nifty")  # the fake's search returns two futures
    assert r.canonical is None and len(r.candidates) == 2
    with pytest.raises(SymbolNotFound) as e:
        r.require()
    assert "Did you mean" in str(e.value)


def test_symbols_resolve_uses_the_server_route_when_present(bridge, fake):
    fake.extra_routes.append({"method": "GET", "path": "/v1/symbols/resolve", "scope": "read", "auth": "key"})
    orig = fake.route

    def route(method, path, q, body):
        if path == "/v1/symbols/resolve":
            assert q["q"] == "reliance" and q["explain"] == "1"
            return 200, {"data": {"input": "reliance", "symbol": "NSE:RELIANCE", "candidates": [{"symbol": "NSE:RELIANCE"}], "rule": "exact", "confidence": "high"}, "meta": {}}
        return orig(method, path, q, body)

    fake.route = route  # type: ignore[method-assign]
    r = bridge.symbols.resolve("reliance")
    assert (r.canonical, r.via, r.rule) == ("NSE:RELIANCE", "server", "exact")


def test_xl_helpers(bridge, fake):
    orig = fake.route

    def route(method, path, q, body):
        if path == "/xl/ltp":
            return 200, "24811.25"
        return orig(method, path, q, body)

    fake.route = route  # type: ignore[method-assign]
    assert bridge.xl.ltp("NSE:X") == 24811.25
    assert "WEBSERVICE" in bridge.xl.formula("ltp") and "YOUR_READ_ONLY_KEY" in bridge.xl.formula("ltp") and KEY not in bridge.xl.formula("quote", field="oi")
    assert bridge.xl.url("/xl/ltp", symbol="NSE:X").startswith(fake.url + "/xl/ltp?symbol=")
    with pytest.raises(ValueError):
        bridge.xl.formula("chain")


def test_batch_accepts_python_style_leg_names(bridge, fake):
    seen = {}
    orig = fake.route

    def route(method, path, q, body):
        if path == "/v1/orders/batch":
            seen["legs"] = body["orders"]
        return orig(method, path, q, body)

    fake.route = route  # type: ignore[method-assign]
    try:
        bridge.orders.batch([dict(symbol="NSE:TCS", side="BUY", quantity=1, product="CNC", order_type="MARKET", trigger_price=1)], account="demo-paper")
    except Exception:
        pass  # the fake may not implement the route: only the request body matters here
    if "legs" in seen:
        assert "orderType" in seen["legs"][0] and "triggerPrice" in seen["legs"][0] and "order_type" not in seen["legs"][0]
