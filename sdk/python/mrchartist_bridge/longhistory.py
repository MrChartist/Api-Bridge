"""``bridge.history_all``: candles over any length of time, as a stream of typed ``Candle`` objects.

    candles = bridge.history_all("NSE:RELIANCE", "5m", "2024-01-01", "2024-12-31")
    for c in candles:                       # fetched window by window, oldest first, no duplicates
        ...
    candles.freshness                       # the least current label of all windows (check it before using the data)
    df = candles.to_dataframe()             # or candles.to_history(), .records(), .to_csv(path), .to_parquet(path)

One ``GET /v1/history`` call can cover only so much: the Bridge splits a long range across the broker's own limits,
but it stops after a fixed number of pieces and then says ``partial``. This helper asks for windows that fit
(``chunk_days``), and halves a window the Bridge reports as partial until it fits or is one day long (a window that
still comes back partial is listed in ``candles.gaps``). Nothing is fetched until you iterate.

``local_first=True`` (with ``dataset="name"`` to read a particular dataset) lets the Bridge answer from the data it
already stored, realtime class and without gaps, and ask the broker only for what is missing: this saves API calls
that a live program needs. ``candles.local_windows`` and ``candles.broker_windows`` say how many windows came from
where, and the freshness label stays honest about bars from a delayed or end-of-day source.
"""

from __future__ import annotations

from collections import Counter
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any, Dict, Iterator, List, Optional, Tuple, Union

from .records import Candle, Freshness, History, IST, least_current, parse_time

if TYPE_CHECKING:  # pragma: no cover
    from .bridge import Bridge

DEFAULT_CHUNK_DAYS = {"intraday": 120, "daily": 1500}
_DAILY = ("1d", "1w", "1M")

_When = Union[str, int, float, date, datetime, None]


def _to_dt(v: _When, *, end: bool = False, now: Optional[datetime] = None) -> datetime:
    """An IST-aware datetime from text, a date, a datetime or epoch seconds. A bare date means the start of that day
    (or its end, when ``end`` is true, so ``to="2024-12-31"`` includes the whole last day)."""
    if v is None:
        return now or datetime.now(IST)
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=IST)
    if isinstance(v, date):
        d = datetime(v.year, v.month, v.day, tzinfo=IST)
        return d + timedelta(days=1) - timedelta(seconds=1) if end else d
    if isinstance(v, str) and len(v.strip()) == 10:
        d = parse_time(v.strip() + "T00:00:00")
        if d is None:
            raise ValueError("not a date: %r" % v)
        return d + timedelta(days=1) - timedelta(seconds=1) if end else d
    d = parse_time(v)
    if d is None:
        raise ValueError("not a date or time: %r" % (v,))
    return d


class HistoryIter:
    """Lazy candles of one symbol and interval over a long range. Iterate once; the statistics are filled as you go."""

    def __init__(
        self,
        bridge: "Bridge",
        symbol: str,
        interval: str,
        from_: _When,
        to: _When = None,
        *,
        chunk_days: Optional[int] = None,
        local_first: bool = False,
        dataset: Optional[str] = None,
        account: Optional[str] = None,
        backup: Optional[bool] = None,
    ) -> None:
        self._b = bridge
        self.symbol = symbol
        self.interval = interval
        now = datetime.now(IST)
        self.start = _to_dt(from_)
        self.end = _to_dt(to, end=True, now=now)
        if self.end < self.start:
            raise ValueError("to is before from")
        self.chunk_days = chunk_days if chunk_days is not None else DEFAULT_CHUNK_DAYS["daily" if interval in _DAILY else "intraday"]
        if self.chunk_days < 1:
            raise ValueError("chunk_days must be at least 1")
        self.local_first = local_first
        self.dataset = dataset
        self.account = account
        self.backup = backup
        self.calls = 0
        self.local_windows = 0
        self.broker_windows = 0
        self.sources: Counter = Counter()
        self.gaps: List[Tuple[datetime, datetime]] = []
        self.partial = False
        self.count = 0
        self._freshness: List[Freshness] = []
        self._buffer: Optional[List[Candle]] = None

    # ── iteration ──

    def __iter__(self) -> Iterator[Candle]:
        if self._buffer is not None:
            return iter(self._buffer)
        return self._walk()

    def _fetch(self, a: datetime, b: datetime) -> Tuple[List[Candle], bool]:
        self.calls += 1
        r = self._b.client.history(self.symbol, self.interval, from_=int(a.timestamp()), to=int(b.timestamp()), account=self.account,
                                   local_first=True if self.local_first else None, dataset=self.dataset, backup=self.backup)
        data = r.get("data") or {}
        meta = r.get("meta") or {}
        src = meta.get("source") or (data.get("freshness") or {}).get("source") or "unknown"
        self.sources[src] += 1
        if src == "local":
            self.local_windows += 1
        else:
            self.broker_windows += 1
        h = History.from_dict(data)
        self._freshness.append(h.freshness)
        return sorted(h.candles, key=lambda c: c.epoch), bool(h.partial)

    def _walk(self) -> Iterator[Candle]:
        step = timedelta(days=self.chunk_days)
        stack: List[Tuple[datetime, datetime]] = []
        cursor = self.start
        last = None  # epoch of the last candle yielded
        while cursor <= self.end or stack:
            if stack:
                a, b = stack.pop()
            else:
                a, b = cursor, min(cursor + step - timedelta(seconds=1), self.end)
                cursor = b + timedelta(seconds=1)
            candles, partial = self._fetch(a, b)
            if partial:
                span = b - a
                if span > timedelta(days=1, seconds=1):
                    mid = a + span / 2
                    mid = mid.replace(microsecond=0)
                    # push the later half first so the earlier half is fetched next (oldest first)
                    stack.append((mid + timedelta(seconds=1), b))
                    stack.append((a, mid))
                    continue
                self.partial = True
                self.gaps.append((a, b))
            for c in candles:
                if last is not None and c.epoch <= last:
                    continue
                last = c.epoch
                self.count += 1
                yield c

    # ── what came back ──

    @property
    def freshness(self) -> Optional[Freshness]:
        """The least current label among the windows fetched so far (None before the first one)."""
        return least_current(self._freshness)

    def to_history(self) -> History:
        """Fetch everything (if not yet) and return one ``History`` with the combined label. Iterating again is then free."""
        if self._buffer is None:
            self._buffer = list(self._walk())
        f = self.freshness or Freshness(source="unknown", data_class="delayed", official=False, confidence="low")
        return History(self.symbol, self.interval, tuple(self._buffer), f, self.partial, {"windows": self.calls, "sources": dict(self.sources), "gaps": [(a.isoformat(), b.isoformat()) for a, b in self.gaps]})

    def to_list(self) -> List[Candle]:
        return list(self.to_history().candles)

    def to_dataframe(self, *, freshness: bool = True) -> Any:
        """pandas DataFrame of all candles with the freshness columns (needs pandas)."""
        from .frames import to_dataframe

        return to_dataframe(self.to_history(), freshness=freshness)

    def records(self, *, freshness: bool = True) -> List[Dict[str, Any]]:
        from .frames import records

        return records(self.to_history(), freshness=freshness)

    def to_csv(self, path: Optional[str] = None, *, freshness: bool = True) -> str:
        from .frames import to_csv

        return to_csv(self.to_history(), path, freshness=freshness)

    def to_parquet(self, path: str) -> str:
        """Write Parquet (needs pyarrow, which is optional)."""
        from .frames import to_parquet

        return to_parquet(self.to_history(), path)

    def require_realtime(self, **kw: Any) -> "HistoryIter":
        """``NotRealtime`` unless every window was real-time (call after iterating or ``to_history()``)."""
        f = self.freshness
        if f is not None:
            f.require_realtime(what="the history of %s" % self.symbol, **kw)
        return self
