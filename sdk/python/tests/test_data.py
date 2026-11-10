"""Downloads, datasets, recordings (+ rules), collections, subscriptions against the fake Bridge (no real network)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from fake_bridge import KEY, FakeBridge  # noqa: E402
from fake_data import bars  # noqa: E402
from mrchartist_bridge import (  # noqa: E402
    Bridge,
    ChecksumMismatch,
    DownloadFailed,
    NotFound,
    UpstreamError,
    ValidationFailed,
    WaitTimeout,
    option_universe,
)
from mrchartist_bridge.data import _safe_name  # noqa: E402


@pytest.fixture()
def fake():
    f = FakeBridge()
    yield f
    f.close()


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.t += s


@pytest.fixture()
def clock():
    return Clock()


@pytest.fixture()
def bridge(fake, clock):
    return Bridge(fake.url, KEY, account="paper", sleep=clock.sleep, clock=clock.now)


def last_body(fake, method, path):
    return fake.find(method, path)[-1]["body"]


# ── downloads ──


def test_create_sends_the_documented_body(bridge, fake):
    job = bridge.downloads.create(["NSE:RELIANCE", "NSE:TCS"], "5m", from_="2024-01-01", name="large caps", format="csv", layout="per-symbol", dataset="lc-5m", tags=["eq"])
    body = last_body(fake, "POST", "/v1/downloads")
    assert body == {"name": "large caps", "symbols": ["NSE:RELIANCE", "NSE:TCS"], "intervals": ["5m"], "from": "2024-01-01", "format": "csv", "layout": "per-symbol", "dataset": "lc-5m", "tags": ["eq"]}
    assert job.status == "queued" and job.id.startswith("dl_") and job.data_class == "realtime"
    assert job.progress.total == 2 and job.progress.fraction == 0.0


def test_create_accepts_dates_collections_and_backup(bridge, fake):
    import datetime as dt

    bridge.collections.create("tcs-only", ["NSE:TCS"])
    bridge.downloads.create(collection="tcs-only", intervals=["1d", "5m"], from_=dt.date(2024, 1, 2), to=dt.datetime(2024, 2, 1, 15, 30), backup=True)
    body = last_body(fake, "POST", "/v1/downloads")
    assert body["collection"] == "tcs-only" and "symbols" not in body and body["from"] == "2024-01-02" and body["to"] == "2024-02-01T15:30:00" and body["backup"] is True


@pytest.mark.parametrize(
    "kw",
    [
        {"symbols": None, "intervals": "5m", "from_": "2024-01-01"},
        {"symbols": ["NSE:X"], "collection": "c", "intervals": "5m", "from_": "2024-01-01"},
        {"symbols": ["NSE:X"], "intervals": None, "from_": "2024-01-01"},
        {"symbols": ["NSE:X"], "intervals": "5m"},
        {"symbols": ["NSE:X"], "intervals": "5m", "from_": "2024-01-01", "format": "xlsx"},
        {"symbols": ["NSE:X"], "intervals": "5m", "from_": "2024-01-01", "layout": "wide"},
    ],
)
def test_create_checks_arguments_before_sending(bridge, fake, kw):
    with pytest.raises(ValueError):
        bridge.downloads.create(**kw)
    assert not fake.find("POST", "/v1/downloads")


def test_dataset_job_needs_no_from(bridge, fake):
    bridge.downloads.create(["NSE:TCS"], "5m", dataset="x")
    assert "from" not in last_body(fake, "POST", "/v1/downloads")


def test_wait_polls_and_reports_progress(bridge, fake):
    job = bridge.downloads.create(["NSE:RELIANCE"], "5m", from_="2024-01-01")
    seen = []
    done = bridge.downloads.wait(job, poll=0.5, on_progress=lambda j: seen.append((j.status, j.progress.done)))
    assert done.is_done and done.progress.fraction == 1.0
    assert [s for s, _ in seen][-1] == "done" and "running" in [s for s, _ in seen]
    assert len(done.files) == 1 and done.files[0].sha256


def test_wait_raises_with_the_reason_a_job_failed(bridge, fake):
    fake.data.job_fail = "The broker login ended (session lost)."
    job = bridge.downloads.create(["NSE:RELIANCE"], "5m", from_="2024-01-01")
    with pytest.raises(DownloadFailed) as e:
        bridge.downloads.wait(job)
    assert "session lost" in str(e.value) and e.value.job.status == "failed"
    j = bridge.downloads.wait(job, raise_on_failure=False)
    assert j.status == "failed" and j.reason


def test_wait_times_out_without_stopping_the_job(bridge, fake):
    fake.data.job_polls = 10_000
    job = bridge.downloads.create(["NSE:RELIANCE"], "5m", from_="2024-01-01")
    with pytest.raises(WaitTimeout) as e:
        bridge.downloads.wait(job, timeout=5, poll=1)
    assert "keeps running" in str(e.value) and e.value.last.status in ("queued", "running")
    assert bridge.downloads.get(job).status in ("queued", "running")


def test_list_pause_resume_cancel_delete_rename(bridge, fake):
    a = bridge.downloads.create(["NSE:A"], "5m", from_="2024-01-01")
    b = bridge.downloads.create(["NSE:B"], "5m", from_="2024-01-01")
    assert [j.id for j in bridge.downloads.list()] == [b.id, a.id]
    assert bridge.downloads.pause(a).status == "paused" and bridge.downloads.resume(a).status == "running"
    assert bridge.downloads.cancel(b).status == "cancelled"
    assert [j.id for j in bridge.downloads.list(status="cancelled")] == [b.id]
    assert fake.find("GET", "/v1/downloads")[-1]["query"] == {"status": "cancelled"}
    r = bridge.downloads.rename(a, "morning", tags=["a"])
    assert r.name == "morning" and r.tags == ("a",)
    bridge.downloads.delete(b)
    with pytest.raises(NotFound):
        bridge.downloads.get(b)


def test_save_checks_each_file_and_writes_the_manifest(bridge, fake, tmp_path):
    job = bridge.downloads.create(["NSE:RELIANCE", "NSE:TCS"], "5m", from_="2024-01-01", backup=True)
    done = bridge.downloads.wait(job)
    assert done.data_class == "delayed" and "delayed data from yahoo" in done.label
    saved = bridge.downloads.save(done, str(tmp_path / "out"))
    assert sorted(s.name for s in saved) == ["NSE-RELIANCE_5m.csv", "NSE-TCS_5m.csv"] and not any(s.skipped for s in saved)
    assert (tmp_path / "out" / "NSE-TCS_5m.csv").read_text().startswith("time,open,high,low,close,volume")
    manifest = json.loads((tmp_path / "out" / "manifest.json").read_text())
    assert manifest["dataClass"] == "delayed" and manifest["source"] == "yahoo" and manifest["official"] is False and len(manifest["files"]) == 2
    assert not list((tmp_path / "out").glob("*.part"))
    # again: nothing fetched twice
    n = len(fake.find("GET", "/v1/downloads/%s/files/NSE-TCS_5m.csv" % job.id))
    again = bridge.downloads.save(done, str(tmp_path / "out"))
    assert all(s.skipped for s in again)
    assert len(fake.find("GET", "/v1/downloads/%s/files/NSE-TCS_5m.csv" % job.id)) == n


def test_a_file_that_does_not_match_its_checksum_is_not_kept(bridge, fake, tmp_path):
    job = bridge.downloads.wait(bridge.downloads.create(["NSE:RELIANCE"], "5m", from_="2024-01-01"))
    fake.data.tamper["NSE-RELIANCE_5m.csv"] = b"time,open\n1,2\n"
    with pytest.raises(ChecksumMismatch) as e:
        bridge.downloads.save(job, str(tmp_path))
    assert e.value.expected != e.value.actual
    assert os.listdir(tmp_path) == []
    saved = bridge.downloads.save(job, str(tmp_path), verify=False)  # the caller may opt out knowingly
    assert saved[0].bytes == len(b"time,open\n1,2\n")


def test_save_only_the_named_files(bridge, tmp_path):
    job = bridge.downloads.wait(bridge.downloads.create(["NSE:A", "NSE:B"], "5m", from_="2024-01-01"))
    saved = bridge.downloads.save(job, str(tmp_path), names=["NSE-B_5m.csv"])
    assert [s.name for s in saved] == ["NSE-B_5m.csv"]


def test_file_names_from_the_bridge_cannot_escape_the_folder():
    assert _safe_name("../../etc/passwd") == "passwd"
    assert _safe_name("a\\b\\c.csv") == "c.csv"
    for bad in ("", "..", "."):
        with pytest.raises(ValueError):
            _safe_name(bad)


def test_read_returns_rows_with_symbol_and_interval(bridge):
    job = bridge.downloads.wait(bridge.downloads.create(["NSE:A", "NSE:B"], "5m", from_="2024-01-01"))
    rows = bridge.downloads.read(job)
    assert len(rows) == 6 and {r["symbol"] for r in rows} == {"NSE:A", "NSE:B"} and rows[0]["interval"] == "5m"
    assert isinstance(rows[0]["open"], float) or isinstance(rows[0]["open"], int)
    assert len(bridge.downloads.read(job, "NSE-A_5m.csv")) == 3


def test_read_jsonl_and_dataframe(bridge):
    pd = pytest.importorskip("pandas")
    job = bridge.downloads.wait(bridge.downloads.create(["NSE:A"], "5m", from_="2024-01-01", format="jsonl"))
    assert bridge.downloads.read(job)[0]["symbol"] == "NSE:A"
    csvjob = bridge.downloads.wait(bridge.downloads.create(["NSE:A"], "5m", from_="2024-01-01"))
    df = bridge.downloads.read(csvjob, as_dataframe=True)
    assert isinstance(df, pd.DataFrame) and len(df) == 3 and str(df.index.tz) == "Asia/Kolkata" and "close" in df.columns


def test_read_refuses_formats_it_cannot_parse(bridge, fake):
    job = bridge.downloads.wait(bridge.downloads.create(["NSE:A"], "5m", from_="2024-01-01", format="amibroker"))
    # an amibroker file is not a csv the SDK parses: make the fake's file listing say so
    d = fake.data.job_files[job.id]
    d["NSE-A_5m.aqh"] = d.pop("NSE-A_5m.csv")
    with pytest.raises(ValueError, match="read\\(\\) understands csv and jsonl"):
        bridge.downloads.read(job)


def test_export_instruments(bridge, tmp_path):
    text = bridge.downloads.export_instruments(kind="EQ")
    assert text.startswith("symbol,exchange,kind")
    p = bridge.downloads.export_instruments(str(tmp_path / "master.csv"), exchange="NSE")
    assert Path(p).read_text().count("\n") == 3
    with pytest.raises(ValueError):
        bridge.downloads.export_instruments(format="xml")


def test_manifest_has_label_and_files(bridge):
    job = bridge.downloads.wait(bridge.downloads.create(["NSE:A"], "5m", from_="2024-01-01"))
    m = bridge.downloads.manifest(job)
    assert m["dataClass"] == "realtime" and m["files"][0]["name"] == "NSE-A_5m.csv" and "progress" not in m


def test_older_bridge_gets_a_plain_hint(bridge, fake):
    fake.fault("POST", "/v1/downloads", 404, "NOT_FOUND")
    with pytest.raises(NotFound) as e:
        bridge.downloads.create(["NSE:A"], "5m", from_="2024-01-01")
    assert "older than this library" in str(e.value)


def test_job_list_to_dataframe_flattens_progress(bridge):
    pd = pytest.importorskip("pandas")
    bridge.downloads.create(["NSE:A"], "5m", from_="2024-01-01")
    df = bridge.downloads.list().to_dataframe()
    assert isinstance(df, pd.DataFrame) and "progress_total" in df.columns and "status" in df.columns


# ── datasets ──


def test_datasets_update_continues_and_labels(bridge, fake):
    j = bridge.downloads.wait(bridge.downloads.create(["NSE:A"], "5m", from_="2024-01-01", dataset="nifty-5m"))
    assert j.dataset == "nifty-5m"
    ds = bridge.datasets.get("nifty-5m")
    assert ds.symbols == ("NSE:A",) and ds.intervals == ("5m",) and ds.rows == 3 and ds.data_class == "realtime"
    up = bridge.datasets.update("nifty-5m", wait=True)
    assert up.is_done and up.request["dataset"] == "nifty-5m"
    assert fake.find("POST", "/v1/datasets/nifty-5m/update")
    assert bridge.datasets.update("nifty-5m").status == "queued"


def test_datasets_tags_rename_and_filter(bridge, fake):
    bridge.downloads.wait(bridge.downloads.create(["NSE:A"], "5m", from_="2024-01-01", dataset="d1"))
    bridge.downloads.wait(bridge.downloads.create(["NSE:B"], "5m", from_="2024-01-01", dataset="d2"))
    bridge.datasets.edit("d1", tags=["index"], description="five minute bars")
    assert [d.name for d in bridge.datasets.list(tag="index")] == ["d1"]
    assert fake.find("GET", "/v1/datasets")[-1]["query"] == {"tag": "index"}
    r = bridge.datasets.edit("d2", new_name="d2-renamed")
    assert r.name == "d2-renamed" and {d.name for d in bridge.datasets.list()} == {"d1", "d2-renamed"}
    with pytest.raises(ValueError):
        bridge.datasets.edit("d1")
    with pytest.raises(NotFound):
        bridge.datasets.get("nope")


def test_dataset_read_uses_stored_bars_through_history(bridge, fake):
    bridge.downloads.wait(bridge.downloads.create(["NSE:A"], "5m", from_="2024-01-01", dataset="d1"))
    fake.data.history_series["NSE:A"] = bars(1760000000, 50)
    fake.data.local_range = (1759000000, 1770000000)
    h = bridge.datasets.read("d1", from_="2025-10-09", to="2025-10-10")
    assert len(h) > 0 and h.freshness.source == "local"
    q = fake.data.history_log[-1]
    assert q["localFirst"] == "true" and q["dataset"] == "d1"
    with pytest.raises(ValueError, match="which one"):
        bridge.downloads.wait(bridge.downloads.create(["NSE:B"], "5m", from_="2024-01-01", dataset="d1"))
        bridge.datasets.read("d1")


# ── recordings ──


def test_recording_lifecycle(bridge, fake, tmp_path):
    rec = bridge.recordings.create("quotes", ["NSE:A", "NSE:B"], every_sec=1)
    assert last_body(fake, "POST", "/v1/recordings") == {"kind": "quotes", "symbols": ["NSE:A", "NSE:B"], "everySec": 1}
    assert rec.is_running and rec.data_class == "realtime"
    assert bridge.recordings.pause(rec).status == "paused" and bridge.recordings.resume(rec).status == "running"
    assert bridge.recordings.get(rec.id).id == rec.id and len(bridge.recordings.list()) == 1
    files = bridge.recordings.files(rec)
    assert files[0].day == "2026-11-09"
    saved = bridge.recordings.save(rec, str(tmp_path))
    assert saved[0].bytes == files[0].bytes and (tmp_path / "manifest.json").exists()
    rows = bridge.recordings.read(rec)
    assert len(rows) == 2 and rows[0]["ltp"] == 100.5
    assert bridge.recordings.stop(rec).status == "stopped"
    bridge.recordings.delete(rec)
    assert len(bridge.recordings.list()) == 0


def test_recording_chain_and_argument_checks(bridge, fake):
    bridge.recordings.create("chain", underlying="NIFTY", expiry="2026-11-12", every_sec=30, session_only=False, format="jsonl", name="n")
    assert last_body(fake, "POST", "/v1/recordings") == {"name": "n", "kind": "chain", "underlying": "NIFTY", "expiry": "2026-11-12", "everySec": 30, "sessionOnly": False, "format": "jsonl"}
    for kw in (
        dict(kind="chain", underlying="NIFTY", every_sec=10),  # chains: 15 s at least
        dict(kind="quotes", symbols=["NSE:A"], every_sec=0.5),
        dict(kind="quotes", every_sec=1),
        dict(kind="chain", every_sec=30),
        dict(kind="ticks", symbols=["NSE:A"], every_sec=1),
    ):
        with pytest.raises(ValueError):
            bridge.recordings.create(**kw)


def test_recording_rules(bridge, fake):
    r = bridge.recordings.rules.create("Index chains", "chain", 30, collection="index-options", keep_days=30, format="csv")
    assert last_body(fake, "POST", "/v1/recordings/rules") == {"name": "Index chains", "enabled": True, "kind": "chain", "collection": "index-options", "everySec": 30, "schedule": "market-hours", "keepDays": 30, "format": "csv"}
    assert r.enabled and r.keep_days == 30 and r.schedule == "market-hours"
    r2 = bridge.recordings.rules.create("Watchlist", "quotes", 5, symbols=["NSE:A"], schedule={"days": ["MON", "TUE"], "start": "09:15", "end": "15:30"}, enabled=False)
    assert r2.enabled is False and r2.schedule["start"] == "09:15"
    assert [x.name for x in bridge.recordings.rules.list()] == ["Index chains", "Watchlist"]
    assert bridge.recordings.rules.get("Watchlist").id == r2.id
    assert bridge.recordings.rules.disable(r.id).enabled is False and bridge.recordings.rules.enable(r.id).enabled is True
    assert bridge.recordings.rules.update(r.id, every_sec=60, keep_days=7).keep_days == 7
    assert last_body(fake, "PATCH", "/v1/recordings/rules/%s" % r.id) == {"everySec": 60, "keepDays": 7}
    bridge.recordings.rules.delete(r.id)
    assert len(bridge.recordings.rules.list()) == 1
    with pytest.raises(NotFound):
        bridge.recordings.rules.get("zzz")
    for kw in (dict(kind="chain", every_sec=10, collection="c"), dict(kind="chain", every_sec=30), dict(kind="chain", every_sec=30, collection="c", underlying="NIFTY"), dict(kind="bars", every_sec=30, collection="c")):
        with pytest.raises(ValueError):
            bridge.recordings.rules.create("bad", **kw)
    with pytest.raises(ValueError):
        bridge.recordings.rules.update(r2.id)


# ── collections ──


def test_collections_static_and_universe(bridge, fake):
    c = bridge.collections.create("my-watchlist", ["NSE:A", "NSE:B"], description="mine", tags=["watch"])
    assert c.kind == "static" and c.symbols == ("NSE:A", "NSE:B") and c.tags == ("watch",)
    u = bridge.collections.create("nifty-near", universe=option_universe("NIFTY", "current-weekly", count=2, include_future=True))
    body = last_body(fake, "POST", "/v1/collections")
    assert body["kind"] == "option-universe" and body["universe"] == {"underlying": "NIFTY", "expiries": "current-weekly", "strikes": {"around": "atm", "count": 2}, "sides": ["CE", "PE"], "includeUnderlying": True, "includeFuture": True}
    assert u.is_dynamic and "symbols" not in body
    assert {c.name for c in bridge.collections.list()} == {"my-watchlist", "nifty-near"}
    assert [c.name for c in bridge.collections.list(tag="watch")] == ["my-watchlist"]
    assert [c.name for c in bridge.collections.list(kind="option-universe")] == ["nifty-near"]
    with pytest.raises(ValueError):
        bridge.collections.create("x")
    with pytest.raises(ValueError):
        bridge.collections.create("x", ["NSE:A"], universe=option_universe("NIFTY"))


def test_option_universe_builder_checks():
    assert option_universe("NIFTY", ["2026-11-12"], from_strike=25000, to_strike=26000, sides=["CE"], include_underlying=False)["strikes"] == {"from": 25000, "to": 26000}
    with pytest.raises(ValueError):
        option_universe("NIFTY", from_strike=25000)
    with pytest.raises(ValueError):
        option_universe("NIFTY", sides=["XX"])
    with pytest.raises(ValueError):
        option_universe("NIFTY", count=-1)


def test_resolve_follows_the_universe_and_is_honest_about_the_price(bridge, fake):
    c = bridge.collections.create("nifty-near", universe=option_universe("NIFTY", count=1))
    assert c.id and c.id.startswith("col_")
    r = bridge.collections.resolve("nifty-near")
    assert r.symbols[0] == "NSE:NIFTY" and len(r) == 1 + 3 * 2 and r.atm == 26000 and "ATM 26000" in r.rule and r.is_reliable and r.resolved_at is not None and r.atm_source == "stream"
    assert fake.find("GET", "/v1/collections/nifty-near/resolve")[-1]["query"] == {}
    # a delayed price is refused by the Bridge (422): the library raises, it never falls back to a stale ATM
    fake.data.atm_delayed = "delayed"
    with pytest.raises(ValidationFailed):
        bridge.collections.resolve("nifty-near", allow_stale=True)
    # a stale price is refused (503) unless the caller says allow_stale; the answer is then labelled
    fake.data.atm_delayed = "stale"
    with pytest.raises(UpstreamError):
        bridge.collections.resolve("nifty-near")
    r2 = bridge.collections.resolve("nifty-near", allow_stale=True)
    assert fake.find("GET", "/v1/collections/nifty-near/resolve")[-1]["query"] == {"allowStale": "1"}
    assert not r2.is_reliable and "stale" in r2.warnings[0] and r2.atm_source == "cache" and r2.freshness.stale
    assert bridge.collections.symbols("nifty-near", allow_stale=True) == list(r2.symbols)


def test_collection_edit_rename_tag_duplicate_delete(bridge):
    bridge.collections.create("a", ["NSE:A"], tags=["x"])
    assert bridge.collections.tag("a", "y", "x", remove=["z"]).tags == ("x", "y")
    assert bridge.collections.tag("a", remove=["x"]).tags == ("y",)
    assert bridge.collections.update("a", symbols=["NSE:A", "NSE:B"], description="d").symbols == ("NSE:A", "NSE:B")
    assert bridge.collections.rename("a", "b").name == "b"
    with pytest.raises(NotFound):
        bridge.collections.get("a")
    d = bridge.collections.duplicate("b", "b2")
    assert d.name == "b2" and d.symbols == ("NSE:A", "NSE:B") and d.tags == ("y",) and d.description == "d"
    bridge.collections.create("dyn", universe=option_universe("NIFTY"))
    assert bridge.collections.duplicate("dyn", "dyn2").is_dynamic
    bridge.collections.delete("b2")
    assert "b2" not in {c.name for c in bridge.collections.list()}
    with pytest.raises(ValueError):
        bridge.collections.update("b")


def test_collection_export_import_roundtrip(bridge, tmp_path):
    bridge.collections.create("w", ["NSE:A", "NSE:B"], description="my list", tags=["t"])
    js = bridge.collections.export("w", "json", str(tmp_path / "w.json"))
    assert json.loads(js) == {"name": "w", "description": "my list", "tags": ["t"], "kind": "static", "symbols": ["NSE:A", "NSE:B"]}
    csv_text = bridge.collections.export("w", "csv")
    assert csv_text == "symbol\nNSE:A\nNSE:B\n"
    bridge.collections.delete("w")
    back = bridge.collections.import_(str(tmp_path / "w.json"))
    assert back.name == "w" and back.symbols == ("NSE:A", "NSE:B") and back.tags == ("t",)
    (tmp_path / "x.csv").write_text(csv_text)
    c2 = bridge.collections.import_(str(tmp_path / "x.csv"), "from-csv", tags=["imp"])
    assert c2.symbols == ("NSE:A", "NSE:B") and c2.tags == ("imp",)
    c3 = bridge.collections.import_("NSE:A\nNSE:C\n", "plain")
    assert c3.symbols == ("NSE:A", "NSE:C")
    c4 = bridge.collections.import_('["NSE:Z"]', "from-list")
    assert c4.symbols == ("NSE:Z",)
    with pytest.raises(ValueError):
        bridge.collections.import_("NSE:A\n")


def test_universe_export_as_csv_uses_the_resolved_symbols(bridge):
    bridge.collections.create("u", universe=option_universe("NIFTY", count=1, include_underlying=False))
    text = bridge.collections.export("u", "csv")
    assert text.splitlines()[0] == "symbol" and len(text.splitlines()) == 1 + 6
    assert json.loads(bridge.collections.export("u", "json"))["universe"]["underlying"] == "NIFTY"
    with pytest.raises(ValueError):
        bridge.collections.export("u", "xml")


def test_collection_usage_and_estimate(bridge, fake):
    bridge.collections.create("w", ["NSE:A", "NSE:B"])
    bridge.downloads.create(collection="w", intervals="5m", from_="2024-01-01")
    use = bridge.collections.usage("w")
    assert len(use["downloads"]) == 1
    est = bridge.collections.estimate("w", intervals=["5m", "1d"], days=30)
    assert est["symbols"] == 2 and est["rows"] == 2 * 2 * 30 * 75
    assert fake.find("GET", "/v1/collections/w/estimate")[-1]["query"] == {"intervals": "5m,1d", "days": "30"}


# ── subscriptions ──


def test_subscriptions_never_show_the_secret(bridge, fake):
    s = bridge.subscriptions.create("https://example.org/hook", ["download.*"], secret="s3cret-s3cret-s3cret", label="my server")
    assert last_body(fake, "POST", "/v1/subscriptions") == {"url": "https://example.org/hook", "topics": ["download.*"], "secret": "s3cret-s3cret-s3cret", "active": True, "label": "my server"}
    assert "secret" not in s.raw and s.topics == ("download.*",) and s.active and s.label == "my server" and s.host == "example.org"
    assert "secret" not in bridge.subscriptions.list()[0].raw and bridge.subscriptions.get(s.id).id == s.id
    assert bridge.subscriptions.update(s.id, active=False).active is False
    assert bridge.subscriptions.test(s.id)["delivered"] is True
    assert len(bridge.subscriptions.deliveries(s.id)) == 2
    assert [d["id"] for d in bridge.subscriptions.deliveries(s.id, outcome="dead")] == ["d2"]
    assert fake.find("GET", "/v1/subscriptions/%s/deliveries" % s.id)[-1]["query"] == {"outcome": "dead"}
    with pytest.raises(ValueError):
        bridge.subscriptions.deliveries(s.id, outcome="bogus")
    bridge.subscriptions.delete(s.id)
    assert len(bridge.subscriptions.list()) == 0
    with pytest.raises(ValueError):
        bridge.subscriptions.create("https://example.org/h", [], secret="x" * 20)
    with pytest.raises(ValueError):
        bridge.subscriptions.update(s.id)


def test_dead_letters_list_retry_and_clear(bridge, fake):
    s = bridge.subscriptions.create("https://example.org/hook", ["download.*"], secret="s3cret-s3cret-s3cret")
    dead = bridge.subscriptions.dead_letters(s.id)
    assert [d["id"] for d in dead] == ["del_1", "del_2"]
    r = bridge.subscriptions.retry_dead_letter(s.id, dead[0])  # the dead-letter dict or its id
    assert r["queued"] is True and fake.find("POST", "/v1/subscriptions/%s/dead-letters/del_1/retry" % s.id)
    assert [d["id"] for d in bridge.subscriptions.dead_letters(s.id)] == ["del_2"]
    assert len(bridge.subscriptions.retry_all_dead_letters(s.id)) == 1 and len(bridge.subscriptions.dead_letters(s.id)) == 0
    fake.data.dead.clear()
    assert bridge.subscriptions.clear_dead_letters(s.id) == 2
    assert fake.find("DELETE", "/v1/subscriptions/%s/dead-letters" % s.id)
    with pytest.raises(NotFound):
        bridge.subscriptions.retry_dead_letter(s.id, "del_999")


# ── async ──


def test_async_namespaces(fake):
    import asyncio

    from mrchartist_bridge import AsyncBridge

    async def main():
        async with AsyncBridge(fake.url, KEY, account="paper", sleep=lambda s: None) as b:
            job = await b.downloads.create(["NSE:A"], "5m", from_="2024-01-01")
            job = await b.downloads.wait(job, poll=0)
            assert job.is_done
            await b.recordings.rules.create("r", "chain", 30, collection="c")
            assert len(await b.recordings.rules.list()) == 1
            h = await b.history_all("NSE:A", "5m", "2025-10-09", "2025-10-10")
            assert len(h) == 5
            assert b.events.verify_signature("k" * 16, b"x", None) is False

    fake.data.history_series["NSE:A"] = bars(1760000000, 5)
    asyncio.run(main())
