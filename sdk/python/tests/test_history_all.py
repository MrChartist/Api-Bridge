"""``history_all`` (windows, partial answers, local-first), DataFrame/records helpers and optional Parquet (fake Bridge)."""

from __future__ import annotations

import sys
import types
from datetime import date, datetime
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from fake_bridge import KEY, FakeBridge  # noqa: E402
from fake_data import DAY, bars  # noqa: E402
from mrchartist_bridge import Bridge, Candle, NotRealtime  # noqa: E402
from mrchartist_bridge import frames  # noqa: E402
from mrchartist_bridge.longhistory import HistoryIter  # noqa: E402

T0 = 1_760_000_000  # 2025-10-09 08:53:20 UTC


@pytest.fixture()
def fake():
    f = FakeBridge()
    yield f
    f.close()


@pytest.fixture()
def bridge(fake):
    return Bridge(fake.url, KEY, account="paper", sleep=lambda s: None)


def daily(n, start=T0):
    return bars(start, n, step=DAY)


def test_windows_cover_the_range_oldest_first_without_duplicates(bridge, fake):
    fake.data.history_series["NSE:A"] = daily(100)
    it = bridge.history_all("NSE:A", "1d", T0, T0 + 99 * DAY, chunk_days=30)
    assert fake.data.history_log == []  # lazy: nothing fetched yet
    candles = list(it)
    assert len(candles) == 100 and all(isinstance(c, Candle) for c in candles)
    times = [c.epoch for c in candles]
    assert times == sorted(set(times))
    assert it.calls == 4 and len(fake.data.history_log) == 4
    log = fake.data.history_log
    assert [w["from"] for w in log] == sorted(w["from"] for w in log) and log[0]["from"] == T0
    assert all(w["localFirst"] is None for w in log)


def test_a_bar_on_a_window_edge_is_yielded_once(bridge, fake):
    fake.data.history_series["NSE:A"] = bars(T0, 7, step=3600)
    # a window boundary falling exactly on a bar: the overlap must not repeat it
    it = bridge.history_all("NSE:A", "60m", T0, T0 + 6 * 3600, chunk_days=1)
    assert [c.epoch for c in it] == [T0 + i * 3600 for i in range(7)]


def test_a_partial_window_is_split_until_it_fits(bridge, fake):
    fake.data.history_series["NSE:A"] = daily(60)
    fake.data.history_max_days = 10  # the Bridge returns only the newest 10 days of a longer window, flagged partial
    it = bridge.history_all("NSE:A", "1d", T0, T0 + 59 * DAY, chunk_days=60)
    got = [c.epoch for c in it]
    assert got == [T0 + i * DAY for i in range(60)]
    assert it.calls > 1 and not it.partial and it.gaps == []
    last = fake.data.history_log[-1]
    assert last["to"] - last["from"] <= 10 * DAY  # the windows were halved until they fit


def test_a_window_that_stays_partial_is_reported_as_a_gap(bridge, fake):
    fake.data.history_series["NSE:A"] = daily(10)
    fake.data.history_max_days = 0.5  # even a one-day window comes back partial
    it = bridge.history_all("NSE:A", "1d", T0, T0 + 9 * DAY, chunk_days=10)
    list(it)
    assert it.partial and it.gaps
    assert it.to_history().partial is True


def test_to_history_and_frames(bridge, fake):
    pd = pytest.importorskip("pandas")
    fake.data.history_series["NSE:A"] = daily(5)
    it = bridge.history_all("NSE:A", "1d", date(2025, 10, 9), T0 + 4 * DAY)
    h = it.to_history()
    assert len(h) == 5 and h.symbol == "NSE:A" and h.freshness.is_realtime and h.raw["windows"] == 1
    assert len(list(it)) == 5  # iterating again is free (no more calls)
    assert it.calls == 1
    df = it.to_dataframe()
    assert isinstance(df, pd.DataFrame) and len(df) == 5 and df["data_class"].iloc[0] == "realtime" and str(df.index.tz) == "Asia/Kolkata"
    recs = it.records()
    assert recs[0]["open"] == 100 and recs[0]["source"] == "broker" and isinstance(recs[0]["time"], datetime)
    text = it.to_csv()
    assert text.splitlines()[0] == "time,open,high,low,close,volume,source,data_class,delay_sec,official,confidence"
    assert len(text.splitlines()) == 6


def test_freshness_is_the_least_current_of_the_windows(bridge, fake):
    fake.data.history_series["NSE:A"] = daily(5)
    it = bridge.history_all("NSE:A", "1d", T0, T0 + 4 * DAY, backup=True)
    list(it)
    assert fake.data.history_log and it.freshness.is_delayed and not it.freshness.official
    with pytest.raises(NotRealtime):
        it.require_realtime()


def test_local_first_sends_the_flag_and_counts_where_windows_came_from(bridge, fake):
    fake.data.history_series["NSE:A"] = daily(60)
    fake.data.local_range = (T0, T0 + 30 * DAY)  # the Bridge stored the first 30 days
    it = bridge.history_all("NSE:A", "1d", T0, T0 + 59 * DAY, chunk_days=15, local_first=True, dataset="d1")
    assert len(list(it)) == 60
    assert all(w["localFirst"] == "true" and w["dataset"] == "d1" for w in fake.data.history_log)
    assert it.calls == 4 and it.local_windows == 2 and it.broker_windows == 2
    assert it.sources["local"] == 2


def test_arguments(bridge):
    with pytest.raises(ValueError):
        bridge.history_all("NSE:A", "1d", "2025-02-01", "2025-01-01")
    with pytest.raises(ValueError):
        bridge.history_all("NSE:A", "1d", "2025-01-01", chunk_days=0)
    with pytest.raises(ValueError):
        bridge.history_all("NSE:A", "1d", "not a date")
    it = HistoryIter(bridge, "NSE:A", "5m", "2025-01-01", "2025-01-02")
    assert it.chunk_days == 120 and HistoryIter(bridge, "NSE:A", "1d", "2025-01-01").chunk_days == 1500
    # a bare end date covers the whole day
    assert it.end.hour == 23 and it.end.minute == 59


def test_plain_history_takes_local_first_and_dataset(bridge, fake):
    fake.data.history_series["NSE:A"] = daily(3)
    fake.data.local_range = (T0, T0 + 10 * DAY)
    h = bridge.history("NSE:A", "1d", from_=T0, to=T0 + 2 * DAY, local_first=True, dataset="d1")
    assert len(h) == 3 and h.freshness.source == "local"
    assert fake.data.history_log[-1] == {"from": T0, "to": T0 + 2 * DAY, "localFirst": "true", "dataset": "d1"}


# ── parse_table, records, Parquet ──


def test_parse_table_types_and_blanks():
    rows = frames.parse_table("﻿time,open,volume,note\n2026-11-09T09:15:00+05:30,1.5,10,\n2026-11-09T09:20:00+05:30,2,,ok\n")
    assert rows == [{"time": "2026-11-09T09:15:00+05:30", "open": 1.5, "volume": 10, "note": None}, {"time": "2026-11-09T09:20:00+05:30", "open": 2, "volume": None, "note": "ok"}]
    assert frames.parse_table('{"a":1}\n\n{"a":2}\n', "jsonl") == [{"a": 1}, {"a": 2}]
    with pytest.raises(ValueError):
        frames.parse_table("a", "xml")


def test_records_of_results_and_records(bridge, fake):
    q = bridge.quotes(["NSE:A", "NSE:B"])
    rows = frames.records(q)
    assert [r["symbol"] for r in rows] == ["NSE:A", "NSE:B"] and rows[0]["data_class"] == "realtime"
    assert frames.records(q[0])[0]["symbol"] == "NSE:A"


def _fake_pyarrow(monkeypatch):
    written = {}

    class Table:
        def __init__(self, rows):
            self.rows, self.meta = rows, None

        @classmethod
        def from_pylist(cls, rows):
            return cls(rows)

        def replace_schema_metadata(self, meta):
            self.meta = meta
            return self

    def write_table(table, path):
        written[path] = table
        Path(path).write_bytes(b"PAR1")

    pa = types.ModuleType("pyarrow")
    pa.Table = Table
    pq = types.ModuleType("pyarrow.parquet")
    pq.write_table = write_table
    pa.parquet = pq
    monkeypatch.setitem(sys.modules, "pyarrow", pa)
    monkeypatch.setitem(sys.modules, "pyarrow.parquet", pq)
    return written


def test_parquet_is_optional_and_says_so_when_pyarrow_is_missing(bridge, fake, tmp_path, monkeypatch):
    fake.data.history_series["NSE:A"] = daily(3)
    monkeypatch.setitem(sys.modules, "pyarrow", None)  # an import of it fails
    monkeypatch.setitem(sys.modules, "pyarrow.parquet", None)
    assert frames.parquet_available() is False
    with pytest.raises(ImportError, match="pip install pyarrow"):
        bridge.history_all("NSE:A", "1d", T0, T0 + 2 * DAY).to_parquet(str(tmp_path / "x.parquet"))
    assert not (tmp_path / "x.parquet").exists()
    # everything else works without it
    assert len(bridge.history_all("NSE:A", "1d", T0, T0 + 2 * DAY).records()) == 3


def test_parquet_written_with_the_label_in_the_metadata(bridge, fake, tmp_path, monkeypatch):
    import json

    written = _fake_pyarrow(monkeypatch)
    fake.data.history_series["NSE:A"] = daily(3)
    assert frames.parquet_available() is True
    p = str(tmp_path / "a.parquet")
    bridge.history_all("NSE:A", "1d", T0, T0 + 2 * DAY).to_parquet(p)
    t = written[p]
    assert len(t.rows) == 3 and t.rows[0]["data_class"] == "realtime"
    meta = json.loads(t.meta[b"mcb"])
    assert meta["freshness"]["class"] == "realtime" and meta["symbol"] == "NSE:A" and meta["interval"] == "1d"
    # a downloaded file converts too
    src = tmp_path / "f.csv"
    src.write_text("time,open\n2026-11-09T09:15:00+05:30,1\n")
    out = frames.csv_to_parquet(str(src), meta={"dataClass": "delayed"})
    assert out.endswith("f.parquet") and written[out].rows == [{"time": "2026-11-09T09:15:00+05:30", "open": 1}]
    assert json.loads(written[out].meta[b"mcb"]) == {"dataClass": "delayed", "source_file": "f.csv"}


def test_pandas_missing_message_is_plain(monkeypatch):
    monkeypatch.setitem(sys.modules, "pandas", None)
    with pytest.raises(ImportError, match="mrchartist-bridge\\[pandas\\]"):
        frames.records_to_dataframe([{"a": 1}])
