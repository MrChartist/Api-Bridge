"""Tables from Bridge records: pandas DataFrames (optional extra) and CSV (standard library).

    pip install "mrchartist-bridge[pandas]"

    df = bridge.history("NSE:RELIANCE", "1d", countback=250).to_dataframe()
    df.index          # DatetimeIndex, tz Asia/Kolkata, named "time"
    df.columns        # open high low close volume [oi] source data_class delay_sec official confidence

Every frame carries the freshness columns (``source``, ``data_class``, ``delay_sec``, ``official``, ``confidence``) so
a delayed or end-of-day frame stays labelled after you merge or export it. Pass ``freshness=False`` to leave them out
(only for data you have already checked). ``df.attrs["freshness"]`` holds the full label.

``pandas`` is imported only when a ``to_dataframe`` call needs it; the CSV helpers need nothing.

Parquet is optional too: ``to_parquet(obj, "x.parquet")`` and ``csv_to_parquet("x.csv", "x.parquet")`` work only when
``pyarrow`` is installed (``pip install pyarrow``); without it they raise ``ImportError`` saying so, and nothing else in
this package needs it. The freshness label is stored in the file's metadata so the data class travels with the file.

Plain records (a list of dicts) come from ``records(obj)`` and ``parse_table(text)``; ``records_to_dataframe`` makes a
frame of them (the ``time`` column becomes an IST index).
"""

from __future__ import annotations

import csv
import io
import json
from dataclasses import fields, is_dataclass
from datetime import datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

from .records import Freshness, History, IST, Result, parse_time

_FRESH_COLS = ("source", "data_class", "delay_sec", "official", "confidence")
_SKIP = {"raw", "legs"}


def _pandas() -> Any:
    try:
        import pandas as pd
    except ImportError as e:  # pragma: no cover - depends on the environment
        raise ImportError("This needs pandas: pip install \"mrchartist-bridge[pandas]\"") from e
    return pd


def _fresh(f: Optional[Freshness]) -> Dict[str, Any]:
    if f is None:
        return {}
    return {"source": f.source, "data_class": f.data_class, "delay_sec": f.delay_sec, "official": f.official, "confidence": f.confidence}


def _row(obj: Any, freshness: bool) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for f in fields(obj):
        if f.name in _SKIP:
            continue
        v = getattr(obj, f.name)
        if isinstance(v, Freshness):
            if freshness:
                out.update(_fresh(v))
                out["stale"] = v.stale
                out["as_of"] = v.as_of
                out["age_ms"] = v.age_ms
            continue
        if is_dataclass(v) and not isinstance(v, type):
            for k2, v2 in _row(v, freshness).items():
                out["%s_%s" % (f.name, k2)] = v2
            continue
        if isinstance(v, tuple):
            v = ",".join(str(x) if not is_dataclass(x) else str(getattr(x, "name", x)) for x in v)
        elif isinstance(v, dict):
            v = json.dumps(v, sort_keys=True, default=str)
        out[f.name] = v
    return out


def _index_ist(pd: Any, times: Sequence[datetime]) -> Any:
    idx = pd.DatetimeIndex(times)
    try:
        return idx.tz_convert("Asia/Kolkata")
    except Exception:  # noqa: BLE001 - no tz database (some Windows installs): the fixed +05:30 offset is the same thing
        return idx.tz_convert(IST)


def to_dataframe(obj: Any, *, freshness: bool = True) -> Any:
    """A pandas DataFrame from a ``History``, a ``Result`` of records (quotes, prices, positions, holdings, orders,
    trades, accounts, sources ...) or any single record. See the module docstring."""
    pd = _pandas()
    if isinstance(obj, History):
        times = [c.time for c in obj.candles]
        data: Dict[str, List[Any]] = {"open": [c.open for c in obj.candles], "high": [c.high for c in obj.candles], "low": [c.low for c in obj.candles],
                                      "close": [c.close for c in obj.candles], "volume": [c.volume for c in obj.candles]}
        if any(c.oi is not None for c in obj.candles):
            data["oi"] = [c.oi for c in obj.candles]
        df = pd.DataFrame(data, index=_index_ist(pd, times) if times else pd.DatetimeIndex([], tz="UTC"))
        df.index.name = "time"
        if freshness:
            for k, v in _fresh(obj.freshness).items():
                df[k] = v
        df.attrs["freshness"] = obj.freshness.to_dict()
        df.attrs["symbol"] = obj.symbol
        df.attrs["interval"] = obj.interval
        df.attrs["partial"] = obj.partial
        return df
    if isinstance(obj, Result):
        rows = [_row(i, freshness) for i in obj]
        df = pd.DataFrame(rows)
        if "symbol" in df.columns:
            df = df.set_index("symbol")
        f = obj.freshness
        if f is not None:
            df.attrs["freshness"] = f.to_dict()
        return df
    if is_dataclass(obj) and not isinstance(obj, type):
        return pd.DataFrame([_row(obj, freshness)])
    if isinstance(obj, Iterable):
        items = list(obj)
        if items and all(is_dataclass(i) for i in items):
            return pd.DataFrame([_row(i, freshness) for i in items])
        return pd.DataFrame(items)
    raise TypeError("cannot make a DataFrame from %s" % type(obj).__name__)


def _csv_value(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return ""
    return v


def rows_to_csv(rows: Sequence[Mapping[str, Any]], columns: Optional[Sequence[str]] = None) -> str:
    """CSV text (with a header, ``\\n`` line ends) from a list of dicts."""
    cols = list(columns) if columns else (list(rows[0].keys()) if rows else [])
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(cols)
    for r in rows:
        w.writerow([_csv_value(r.get(c)) for c in cols])
    return buf.getvalue()


def to_csv(obj: Any, path: Optional[str] = None, *, freshness: bool = True) -> str:
    """CSV text of a ``History`` or a ``Result``/list of records; also written to ``path`` when given.

    Candle times are ISO-8601 with the IST offset (``2026-11-09T09:15:00+05:30``), like ``/v1/history?format=csv``.
    The freshness columns are included by default so exported data stays labelled.
    """
    if isinstance(obj, History):
        has_oi = any(c.oi is not None for c in obj.candles)
        rows = []
        for c in obj.candles:
            r: Dict[str, Any] = {"time": c.time, "open": c.open, "high": c.high, "low": c.low, "close": c.close, "volume": c.volume}
            if has_oi:
                r["oi"] = c.oi
            if freshness:
                r.update(_fresh(obj.freshness))
            rows.append(r)
        cols = ["time", "open", "high", "low", "close", "volume"] + (["oi"] if has_oi else []) + (list(_FRESH_COLS) if freshness else [])
        text = rows_to_csv(rows, cols)
    else:
        items = list(obj) if not isinstance(obj, (Mapping,)) and isinstance(obj, Iterable) else [obj]
        rows = [_row(i, freshness) if is_dataclass(i) else dict(i) for i in items]
        text = rows_to_csv(rows)
    if path:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
    return text


# ── plain records, tables read from files, Parquet ──


def records(obj: Any, *, freshness: bool = True) -> List[Dict[str, Any]]:
    """A list of plain dicts (snake_case keys) from a ``History``, a ``Result`` or list of records, or one record. A
    ``History`` gives one dict per candle (``time`` as an IST datetime) with the freshness columns."""
    if isinstance(obj, History):
        out = []
        for c in obj.candles:
            r: Dict[str, Any] = {"time": c.time, "open": c.open, "high": c.high, "low": c.low, "close": c.close, "volume": c.volume}
            if c.oi is not None:
                r["oi"] = c.oi
            if freshness:
                r.update(_fresh(obj.freshness))
            out.append(r)
        return out
    if is_dataclass(obj) and not isinstance(obj, type):
        return [_row(obj, freshness)]
    if isinstance(obj, Mapping):
        return [dict(obj)]
    return [_row(i, freshness) if is_dataclass(i) else dict(i) for i in obj]


def _coerce(v: str) -> Any:
    if v == "":
        return None
    try:
        return int(v)
    except ValueError:
        pass
    try:
        f = float(v)
        return f if f == f and f not in (float("inf"), float("-inf")) else v
    except ValueError:
        return v


def parse_table(text: str, fmt: str = "csv") -> List[Dict[str, Any]]:
    """Rows of a downloaded or recorded file as dicts: ``fmt`` is ``csv`` or ``jsonl``. In CSV, numbers become int or
    float, empty cells ``None``, everything else (times, symbols) stays text. A leading byte-order mark is ignored."""
    text = text.lstrip("\ufeff")
    if fmt == "jsonl":
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    if fmt != "csv":
        raise ValueError("fmt must be csv or jsonl, not %r" % fmt)
    return [{k: _coerce(v) if isinstance(v, str) else v for k, v in row.items()} for row in csv.DictReader(io.StringIO(text))]


def records_to_dataframe(rows: Sequence[Mapping[str, Any]], *, time_col: str = "time") -> Any:
    """A pandas DataFrame from dict rows. A ``time`` column (ISO text, epoch seconds or datetimes) becomes the index in
    Asia/Kolkata time. Needs pandas."""
    pd = _pandas()
    df = pd.DataFrame(list(rows))
    if time_col in df.columns and len(df):
        times = [parse_time(v) for v in df[time_col]]
        if all(t is not None for t in times):
            df.index = _index_ist(pd, times)
            df.index.name = time_col
            df = df.drop(columns=[time_col])
    return df


def parquet_available() -> bool:
    """True when ``pyarrow`` can be imported (Parquet output is then available)."""
    try:
        import pyarrow  # noqa: F401
        import pyarrow.parquet  # noqa: F401
    except ImportError:
        return False
    return True


def _pyarrow() -> Any:
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as e:
        raise ImportError("Parquet output needs pyarrow: pip install pyarrow (it is optional; CSV and DataFrames need nothing extra)") from e
    return pa, pq


def _write_parquet(rows: List[Dict[str, Any]], path: str, meta: Optional[Mapping[str, Any]]) -> str:
    pa, pq = _pyarrow()
    table = pa.Table.from_pylist(rows)
    if meta:
        table = table.replace_schema_metadata({b"mcb": json.dumps(meta, default=str).encode("utf-8")})
    pq.write_table(table, path)
    return path


def to_parquet(obj: Any, path: str, *, freshness: bool = True) -> str:
    """Write a ``History``, ``Result`` or list of records to a Parquet file (needs ``pyarrow``; ``ImportError`` says so
    when it is missing). The freshness label goes into the file metadata under ``mcb``. Returns ``path``."""
    _pyarrow()
    meta: Dict[str, Any] = {}
    f = getattr(obj, "freshness", None)
    if isinstance(f, Freshness):
        meta["freshness"] = f.to_dict()
    if isinstance(obj, History):
        meta.update({"symbol": obj.symbol, "interval": obj.interval, "partial": obj.partial})
    return _write_parquet(records(obj, freshness=freshness), path, meta)


def csv_to_parquet(src: str, dest: Optional[str] = None, *, fmt: str = "csv", meta: Optional[Mapping[str, Any]] = None) -> str:
    """Convert a downloaded or recorded CSV (or JSON-lines) file to Parquet next to it (or at ``dest``). Needs ``pyarrow``."""
    _pyarrow()
    with open(src, "r", encoding="utf-8", newline="") as f:
        rows = parse_table(f.read(), fmt)
    out = dest or (src.rsplit(".", 1)[0] + ".parquet")
    return _write_parquet(rows, out, dict(meta or {}, source_file=src.replace("\\", "/").rsplit("/", 1)[-1]))
