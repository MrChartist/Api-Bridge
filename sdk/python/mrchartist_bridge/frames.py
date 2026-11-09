"""Tables from Bridge records: pandas DataFrames (optional extra) and CSV (standard library).

    pip install "mrchartist-bridge[pandas]"

    df = bridge.history("NSE:RELIANCE", "1d", countback=250).to_dataframe()
    df.index          # DatetimeIndex, tz Asia/Kolkata, named "time"
    df.columns        # open high low close volume [oi] source data_class delay_sec official confidence

Every frame carries the freshness columns (``source``, ``data_class``, ``delay_sec``, ``official``, ``confidence``) so
a delayed or end-of-day frame stays labelled after you merge or export it. Pass ``freshness=False`` to leave them out
(only for data you have already checked). ``df.attrs["freshness"]`` holds the full label.

``pandas`` is imported only when a ``to_dataframe`` call needs it; the CSV helpers need nothing.
"""

from __future__ import annotations

import csv
import io
from dataclasses import fields, is_dataclass
from datetime import datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

from .records import Freshness, History, IST, Result

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
        if isinstance(v, tuple):
            v = ",".join(str(x) for x in v)
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
