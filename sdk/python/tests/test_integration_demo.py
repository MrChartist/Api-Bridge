"""Integration: the library against a real Bridge in demo mode (a Node subprocess on a free local port).

Skipped when Node, the repository's Bridge or its dependencies are not available, or the Bridge does not start in time.
Nothing leaves this computer: demo mode generates its own sample prices and places paper orders only.
Run on its own:  python -m pytest sdk/python/tests/test_integration_demo.py -q -m integration
"""

from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
REPO = HERE.parents[2]
CLI = REPO / "bin" / "mc-bridge.mjs"

from mrchartist_bridge import AsyncBridge, Bridge, LiveNotConfirmed, PaperOnly, Tick  # noqa: E402

pytestmark = pytest.mark.integration


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def demo():
    node = shutil.which("node")
    if not node or not CLI.exists() or not (REPO / "node_modules").exists():
        pytest.skip("node or the Bridge's dependencies are not available")
    home = tempfile.mkdtemp(prefix="mcb-py-demo-")
    port = _free_port()
    env = dict(os.environ, MCB_HOME=home, MCB_PORT=str(port), NO_COLOR="1")
    for k in ("MCB_API_KEY", "MCB_BRIDGE_URL", "MCB_ACCOUNT", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        env.pop(k, None)
    proc = subprocess.Popen([node, str(CLI), "start", "--demo"], cwd=str(REPO), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = "http://127.0.0.1:%d" % port
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        end = time.time() + 40
        while time.time() < end:
            if proc.poll() is not None:
                pytest.skip("the demo Bridge exited at start")
            try:
                with opener.open(base + "/v1/health", timeout=1) as r:
                    if r.status == 200:
                        break
            except OSError:
                time.sleep(0.25)
        else:
            pytest.skip("the demo Bridge did not start in time")
        out = subprocess.run([node, str(CLI), "keys", "create", "--label", "py-test", "--scope", "read,paper,admin"], cwd=str(REPO), env=env, capture_output=True, text=True, timeout=60).stdout
        m = re.search(r"mcb_[A-Za-z0-9]+_[A-Za-z0-9_-]+", out)
        if not m:
            pytest.skip("could not create a key: " + out[:200])
        yield {"url": base, "key": m.group(0), "home": home}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(home, ignore_errors=True)


@pytest.fixture()
def bridge(demo):
    return Bridge(demo["url"], demo["key"], account="demo-paper")


def test_ping_and_demo_helper(demo, bridge):
    p = bridge.ping()
    assert p.ok and p.demo and p.authenticated
    assert Bridge.demo(demo["url"], demo["key"]).is_demo


def test_typed_market_data_with_freshness(bridge):
    q = bridge.quotes(["NSE:NIFTY", "NSE:RELIANCE"])
    assert len(q) == 2 and all(i.freshness.is_realtime and i.freshness.official for i in q)
    assert q[0].require_realtime() is q[0]
    h = bridge.history("NSE:RELIANCE", "1d", countback=5)
    assert len(h) == 5 and h[0].time.utcoffset().total_seconds() == 19800
    assert bridge.symbols.resolve("NSE:NIFTY1!").canonical.startswith("NFO:NIFTY-")
    assert any(s.id == "demo" for s in bridge.sources())


def test_paper_order_round_trip(bridge):
    q = bridge.quote("NSE:RELIANCE")
    o = bridge.orders.place("NSE:RELIANCE", "BUY", quantity=1, product="CNC", price=q)
    done = bridge.orders.wait_for_fill(o, timeout=15)
    assert done.is_filled and done.mode == "paper" and done.client_order_id == o.client_order_id
    again = bridge.orders.place("NSE:RELIANCE", "BUY", quantity=1, product="CNC", price=q, idempotency_key=o.idempotency_key, client_order_id=o.client_order_id)
    assert again.replayed and again.order_id == o.order_id
    t = bridge.orders.to_target("NSE:RELIANCE", target_quantity=0, product="CNC", order_type="MARKET")
    assert t.action in ("SELL", "NONE")


def test_live_is_refused_on_a_paper_account(bridge):
    with pytest.raises(PaperOnly):
        bridge.orders.place("NSE:RELIANCE", "BUY", quantity=1, product="CNC", order_type="MARKET", live=True)
    with pytest.raises(LiveNotConfirmed):
        bridge.orders.place_request({"account": "demo-paper", "symbol": "NSE:RELIANCE", "side": "BUY", "quantity": 1, "product": "CNC", "orderType": "MARKET", "mode": "live"})


def test_tickets_listing_needs_admin_from_this_computer(bridge):
    assert isinstance(bridge.tickets.list(), list)


def test_live_stream_delivers_ticks(bridge):
    with bridge.stream(["NSE:NIFTY"], mode="ltp") as st:
        seen = None
        for ev in st.events():
            if isinstance(ev, Tick):
                seen = ev
                break
    assert seen is not None and seen.symbol == "NSE:NIFTY" and seen.ltp > 0


def test_async_bridge_against_the_demo(demo):
    import asyncio

    async def main():
        async with AsyncBridge(demo["url"], demo["key"], account="demo-paper") as ab:
            return await asyncio.gather(ab.price("NSE:NIFTY"), ab.price("NSE:RELIANCE"))

    a, b = asyncio.run(main())
    assert a.ltp > 0 and b.ltp > 0


def test_the_dataframe_helper_on_real_history(bridge):
    pytest.importorskip("pandas")
    df = bridge.history("NSE:RELIANCE", "1d", countback=5).to_dataframe()
    assert len(df) == 5 and df["data_class"].eq("realtime").all()


@pytest.mark.parametrize("script,args,needs_pandas", [("prices.py", [], False), ("paper_order.py", [], False), ("stream_reconnect.py", ["3"], False), ("sources_freshness.py", [], False), ("history_dataframe.py", [], True)])
def test_the_shipped_examples_run_against_the_demo(demo, script, args, needs_pandas, tmp_path):
    if needs_pandas:
        pytest.importorskip("pandas")
    env = dict(os.environ, MCB_BRIDGE_URL=demo["url"], MCB_API_KEY=demo["key"], MCB_ACCOUNT="demo-paper", MCB_HOME=str(tmp_path), PYTHONPATH=str(HERE.parent))
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        env.pop(k, None)
    r = subprocess.run([sys.executable, str(HERE.parent / "examples" / script), *args], env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr[-800:]
    assert r.stdout.strip()


# ── downloads, datasets, recordings against the real data modules ──


def test_a_real_download_end_to_end(bridge, tmp_path):
    import datetime as dt

    today = dt.date.today()
    first = (today - dt.timedelta(days=5)).isoformat()
    est = bridge.downloads.estimate(["NSE:RELIANCE", "NSE:TCS"], "5m", from_=first, dataset="py-e2e-5m")
    assert est.items == 2 and est.broker_calls >= 2 and est.rows > 0 and est.fits_disk and est.budget_share > 0
    assert not any(j.name == "py e2e" for j in bridge.downloads.list())  # the estimate started nothing
    saved_before = bridge.saved_calls()
    job = bridge.downloads.create(["NSE:RELIANCE", "NSE:TCS"], "5m", from_=first, dataset="py-e2e-5m", name="py e2e")
    done = bridge.downloads.wait(job, timeout=60, poll=0.2)
    assert done.is_done and done.data_class == "realtime" and done.progress.done == 2
    files = bridge.downloads.files(done)
    assert {f.symbol for f in files} == {"NSE:RELIANCE", "NSE:TCS"}
    saved = bridge.downloads.save(done, str(tmp_path))  # every file is checked against the Bridge's SHA-256
    assert len(saved) == 2 and (tmp_path / "manifest.json").exists()
    rows = bridge.downloads.read(done, files[0].name)
    assert len(rows) == files[0].rows > 20 and rows[0]["symbol"] == files[0].symbol
    # updating a dataset that is already up to date makes no broker call and counts the saving
    upd = bridge.datasets.update("py-e2e-5m", wait=True, timeout=60, poll=0.2)
    assert upd.is_done and upd.raw["callsSaved"] >= 1
    assert bridge.saved_calls().total > saved_before.total
    ds = bridge.datasets.get("py-e2e-5m")
    assert ds.rows == sum(f.rows for f in files)
    bridge.downloads.delete(done)


def test_download_and_recording_settings_round_trip(bridge):
    d = bridge.downloads.settings()
    r = bridge.recordings.settings()
    assert 0.05 <= d.max_budget_share <= 0.8 and d.after_hours_only is False and r.after_hours_only is None
    try:
        assert bridge.downloads.set_settings(max_budget_share=0.5).max_budget_share == 0.5
        assert bridge.recordings.set_settings(max_budget_share=0.45).max_budget_share == 0.45
        assert bridge.downloads.settings().changed == ("maxBudgetShare",) and bridge.recordings.status().budget_share == 0.45
    finally:
        bridge.downloads.set_settings(max_budget_share=d.max_budget_share)
        bridge.recordings.set_settings(max_budget_share=r.max_budget_share)


def test_a_real_recording_writes_files_and_presets_list(bridge):
    assert bridge.recordings.status().line
    assert [p.id for p in bridge.recordings.presets()] == ["index-option-chains", "my-watchlist"]
    rec = bridge.recordings.create("quotes", ["NSE:RELIANCE"], every_sec=1, session_only=False, name="py e2e quotes")
    try:
        deadline = time.time() + 15
        files = []
        while time.time() < deadline and not files:
            time.sleep(0.5)
            files = bridge.recordings.files(rec)
        assert files and files[0].symbol == "NSE:RELIANCE" and files[0].rows >= 1
        rows = bridge.recordings.read(rec, files[0].name)
        assert rows[0]["symbol"] == "NSE:RELIANCE" and rows[0]["class"] == "realtime"
    finally:
        bridge.recordings.stop(rec)
        bridge.recordings.delete(rec)
