"""Data you keep: downloads, datasets, recordings, collections (``bridge.downloads`` and friends).

    job = bridge.downloads.create(["NSE:RELIANCE", "NSE:TCS"], "5m", from_="2024-01-01", dataset="large-caps-5m")
    job = bridge.downloads.wait(job, on_progress=lambda j: print(j.progress.done, "of", j.progress.total))
    bridge.downloads.save(job, "data/")                          # files checked against the manifest's SHA-256
    bridge.datasets.update("large-caps-5m")                      # later: only the bars after the last one are fetched
    rows = bridge.downloads.read(job)                            # list of dicts; .read(job, as_dataframe=True) for pandas

    rec = bridge.recordings.create("chain", underlying="NIFTY", expiry="2026-11-12", every_sec=30)
    bridge.recordings.rules.create("Index chains", "chain", every_sec=30, collection="index-options")

    bridge.collections.create("nifty-near", universe=option_universe("NIFTY", "current-weekly", count=10))
    bridge.collections.resolve("nifty-near").symbols             # the concrete symbols right now

What the Bridge does for you: jobs run in the background at the lowest priority so they never slow live reads or
orders, survive a restart, and stop with a stated reason on a kill switch or a lost login. Every file and answer says
its data class (``realtime``, ``delayed``, ``eod``), source and delay: they are on the job (``job.data_class``,
``job.source``, ``job.delay_sec``) and in the manifest ``save()`` writes next to the files. Delayed and end-of-day
files are for analysis only: nothing in the Bridge uses them for orders, risk, paper fills or alerts, and neither
should you.

Request and reply shapes follow ``docs/openapi.yaml`` and the wave plan; fields the Bridge adds later stay in ``raw``.
The routes need a Bridge that has them (older ones answer 404, and the error says so). Standard library only; pandas
and pyarrow are used only when you ask for a DataFrame or Parquet.
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import os
import re
import urllib.parse
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import TYPE_CHECKING, Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple, Union

from .errors import BridgeApiError, DownloadFailed, NotFound, WaitTimeout
from .records import Freshness, ItemProblem, Result, _d, _int, _num, parse_time, problems_from

if TYPE_CHECKING:  # pragma: no cover
    from .bridge import Bridge

TERMINAL_JOB_STATUSES = frozenset({"done", "failed", "cancelled"})
"""Job states that cannot change any more. ``paused`` is not terminal: a person (or you) resumes it."""

DOWNLOAD_FORMATS = ("csv", "jsonl", "amibroker")
DOWNLOAD_LAYOUTS = ("per-symbol", "combined")
RECORDING_KINDS = ("quotes", "chain")
MIN_EVERY_SEC = {"quotes": 1, "chain": 15}


# ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────


def iso(v: Any) -> Optional[str]:
    """A date or time as the text the Bridge takes: ``date`` and ``datetime`` become ISO text, text and numbers pass through."""
    if v is None:
        return None
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return str(v)


def _camel(key: str) -> str:
    head, *rest = key.rstrip("_").split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def _wire(d: Mapping[str, Any]) -> Dict[str, Any]:
    """Top-level snake_case keys to the Bridge's camelCase; None values dropped. Nested values are left as given."""
    return {_camel(k): v for k, v in d.items() if v is not None}


def _list(v: Union[str, Sequence[str], None]) -> List[str]:
    if v is None:
        return []
    return [v] if isinstance(v, str) else [str(x) for x in v]


def _id_of(obj: Any, attr: str = "id") -> str:
    return str(obj if isinstance(obj, (str, int)) else getattr(obj, attr))


def _data(reply: Any) -> Any:
    return reply.get("data") if isinstance(reply, Mapping) and "data" in reply else reply


def _rows(reply: Any, key: str = "files") -> List[Any]:
    d = _data(reply)
    if isinstance(d, Mapping):
        d = d.get(key) or []
    return list(d or [])


def _safe_name(name: str) -> str:
    """A file name from the Bridge, reduced to a plain name: it can never write outside the folder you chose."""
    base = os.path.basename(str(name).replace("\\", "/"))
    if not base or base in (".", ".."):
        raise ValueError("the Bridge sent an unusable file name: %r" % name)
    return base


def _label(data_class: str, source: Optional[str], delay_sec: Optional[int]) -> str:
    if data_class == "realtime":
        return "real-time data from %s" % (source or "the Bridge")
    if data_class == "eod":
        return "end-of-day data from %s" % (source or "a free source")
    return "delayed data from %s (about %s s behind)" % (source or "a free source", delay_sec if delay_sec is not None else "unknown")


def _fresh_fields(d: Mapping[str, Any]) -> Tuple[str, Optional[str], Optional[int], bool]:
    cls = str(d.get("dataClass") or d.get("class") or _d(d.get("freshness")).get("class") or "realtime")
    src = d.get("source")
    if isinstance(src, Mapping):
        src = src.get("id") or src.get("name")
    delay = _int(d.get("delaySec"))
    official = d.get("official")
    return cls, (str(src) if src is not None else None), delay, bool(official) if official is not None else cls == "realtime"


# ── records ────────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DataFile:
    """One file of a download, dataset or recording, as the manifest lists it."""

    name: str
    symbol: Optional[str] = None
    interval: Optional[str] = None
    rows: Optional[int] = None
    bytes: Optional[int] = None
    first_bar: Optional[datetime] = None
    last_bar: Optional[datetime] = None
    sha256: Optional[str] = None
    day: Optional[str] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Union[Mapping[str, Any], str]) -> "DataFile":
        if isinstance(d, str):
            return cls(name=d, raw={"name": d})
        return cls(str(d.get("name")), d.get("symbol"), d.get("interval"), _int(d.get("rows")), _int(d.get("bytes") if d.get("bytes") is not None else d.get("size")),
                   parse_time(d.get("firstBar")), parse_time(d.get("lastBar")), d.get("sha256"), d.get("day") or d.get("date"), dict(d))

    @property
    def format(self) -> str:
        n = self.name.lower()
        if n.endswith(".gz"):
            n = n[:-3]
        return "jsonl" if n.endswith((".jsonl", ".ndjson")) else "csv" if n.endswith((".csv", ".txt")) else n.rsplit(".", 1)[-1]


@dataclass(frozen=True)
class DownloadProgress:
    total: int = 0
    done: int = 0
    failed: int = 0
    rows: int = 0
    bytes: int = 0
    eta_sec: Optional[float] = None
    current_symbol: Optional[str] = None
    current_interval: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Optional[Mapping[str, Any]]) -> "DownloadProgress":
        d = _d(d)
        cur = _d(d.get("current"))
        return cls(_int(d.get("total")) or 0, _int(d.get("done")) or 0, _int(d.get("failed")) or 0, _int(d.get("rows")) or 0, _int(d.get("bytes")) or 0, _num(d.get("etaSec")), cur.get("symbol"), cur.get("interval"))

    @property
    def fraction(self) -> float:
        """0.0 to 1.0 (items finished or failed over the total)."""
        return 0.0 if not self.total else min(1.0, (self.done + self.failed) / self.total)


@dataclass(frozen=True)
class DownloadItem:
    """One symbol and interval of a job."""

    symbol: str
    interval: str
    status: str
    rows: int = 0
    error: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "DownloadItem":
        err = d.get("error")
        if isinstance(err, Mapping):
            err = err.get("message") or err.get("code")
        return cls(str(d.get("symbol")), str(d.get("interval")), str(d.get("status")), _int(d.get("rows")) or 0, str(err) if err else None)


@dataclass(frozen=True)
class DownloadJob:
    """A download job (``GET /v1/downloads/{id}``). ``status`` is queued, running, paused, done, failed or cancelled."""

    id: str
    name: Optional[str]
    status: str
    progress: DownloadProgress
    items: Tuple[DownloadItem, ...]
    request: Mapping[str, Any]
    data_class: str
    source: Optional[str]
    official: bool
    delay_sec: Optional[int]
    created_at: Optional[datetime]
    started_at: Optional[datetime]
    finished_at: Optional[datetime]
    manifest_url: Optional[str]
    reason: Optional[str] = None
    """Why a job stopped when it did not finish on its own (kill switch, login lost, disk full ...)."""
    files: Tuple[DataFile, ...] = ()
    tags: Tuple[str, ...] = ()
    dataset: Optional[str] = None
    notes: Tuple[str, ...] = ()
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "DownloadJob":
        cls_, src, delay, official = _fresh_fields(d)
        req = _d(d.get("request"))
        reason = d.get("reason") or d.get("error") or d.get("stoppedBecause")
        if isinstance(reason, Mapping):
            reason = reason.get("message") or reason.get("code")
        return cls(
            str(d.get("id")), d.get("name"), str(d.get("status")), DownloadProgress.from_dict(d.get("progress")), tuple(DownloadItem.from_dict(i) for i in d.get("items") or [] if isinstance(i, Mapping)),
            dict(req), cls_, src, official, delay, parse_time(d.get("createdAt")), parse_time(d.get("startedAt")), parse_time(d.get("finishedAt")), d.get("manifestUrl"), str(reason) if reason else None,
            tuple(DataFile.from_dict(f) for f in d.get("files") or []), tuple(str(t) for t in d.get("tags") or ()), d.get("dataset") or req.get("dataset"), tuple(str(n) for n in d.get("notes") or ()), dict(d),
        )

    @property
    def is_final(self) -> bool:
        return self.status in TERMINAL_JOB_STATUSES

    @property
    def is_done(self) -> bool:
        return self.status == "done"

    @property
    def is_active(self) -> bool:
        return self.status in ("queued", "running")

    @property
    def is_realtime(self) -> bool:
        return self.data_class == "realtime"

    @property
    def label(self) -> str:
        """The data class in a plain sentence, for logs and file names: ``delayed data from yahoo (about 900 s behind)``."""
        return _label(self.data_class, self.source, self.delay_sec)

    @property
    def failed_items(self) -> Tuple[DownloadItem, ...]:
        return tuple(i for i in self.items if i.status == "failed")

    def to_dict(self) -> Dict[str, Any]:
        return dict(self.raw)


@dataclass(frozen=True)
class SavedFile:
    """A file ``downloads.save`` or ``recordings.save`` put on your disk. ``skipped`` is True when an identical file
    (same SHA-256) was already there, so nothing was fetched again."""

    name: str
    path: str
    bytes: int
    sha256: str
    skipped: bool = False


@dataclass(frozen=True)
class Dataset:
    """A named, growing set of downloaded bars (``GET /v1/datasets/{name}``).

    ``title`` is the Bridge's free-text label (``description`` is the same text, kept as an older name). The first and
    last bar are the earliest and latest over the files; the list route (``datasets.list``) has no files, so there they
    are ``None`` until you ``get()`` the dataset."""

    name: str
    description: Optional[str]
    tags: Tuple[str, ...]
    data_class: str
    source: Optional[str]
    official: bool
    delay_sec: Optional[int]
    symbols: Tuple[str, ...]
    intervals: Tuple[str, ...]
    rows: Optional[int]
    bytes: Optional[int]
    first_bar: Optional[datetime]
    last_bar: Optional[datetime]
    updated_at: Optional[datetime]
    files: Tuple[DataFile, ...] = ()
    collection: Optional[str] = None
    gaps: int = 0
    """How many stretches with missing bars the dataset has (over all files)."""
    format: Optional[str] = None
    last_job_id: Optional[str] = None
    active_job_id: Optional[str] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Dataset":
        cls_, src, delay, official = _fresh_fields(d)
        files = tuple(DataFile.from_dict(f) for f in d.get("files") or [])
        req = _d(d.get("request"))
        symbols = tuple(str(s) for s in d.get("symbols") or req.get("symbols") or ()) or tuple(dict.fromkeys(f.symbol for f in files if f.symbol))
        intervals = tuple(str(s) for s in d.get("intervals") or req.get("intervals") or ()) or tuple(dict.fromkeys(f.interval for f in files if f.interval))
        firsts = [f.first_bar for f in files if f.first_bar is not None]
        lasts = [f.last_bar for f in files if f.last_bar is not None]
        first = parse_time(d.get("firstBar")) or (min(firsts) if firsts else None)
        last = parse_time(d.get("lastBar")) or (max(lasts) if lasts else None)
        title = d.get("title") if d.get("title") is not None else d.get("description")
        gaps = d.get("gaps")
        return cls(str(d.get("name")), title, tuple(str(t) for t in d.get("tags") or ()), cls_, src, official, delay, symbols, intervals,
                   _int(d.get("rows")) if d.get("rows") is not None else (sum(f.rows or 0 for f in files) if files else None),
                   _int(d.get("bytes")) if d.get("bytes") is not None else (sum(f.bytes or 0 for f in files) if files else None),
                   first, last, parse_time(d.get("updatedAt")), files, d.get("collection") or req.get("collection"),
                   (_int(gaps) or 0) if not isinstance(gaps, (list, tuple)) else len(gaps), d.get("format"), d.get("lastJobId"), d.get("activeJobId"), dict(d))

    @property
    def title(self) -> Optional[str]:
        return self.description

    @property
    def label(self) -> str:
        return _label(self.data_class, self.source, self.delay_sec)


RECORDING_STATUSES = ("recording", "waiting", "paused", "stopped", "blocked")
"""What the Bridge reports for a recording. ``waiting``: outside the session, or no login yet. ``blocked``: a disk limit was reached."""


@dataclass(frozen=True)
class Recording:
    """A recording of quotes or option chains saved going forward from this Bridge's own live data.

    ``status`` is one of ``RECORDING_STATUSES``. ``symbols`` are what the recording was asked to record (``target.symbols``),
    or, for a collection or an option universe, the symbols it resolved to at last look (a sample, see ``symbol_count``);
    ``underlying``, ``expiry`` and ``collection`` come from ``target`` too."""

    id: str
    name: Optional[str]
    kind: str
    status: str
    symbols: Tuple[str, ...]
    underlying: Optional[str]
    expiry: Optional[str]
    every_sec: Optional[float]
    session_only: bool
    format: Optional[str]
    rows: int
    bytes: int
    last_write_at: Optional[datetime]
    gaps: Tuple[Mapping[str, Any], ...]
    disk_bytes: Optional[int]
    data_class: str
    source: Optional[str]
    rule_id: Optional[str] = None
    collection: Optional[str] = None
    files: Tuple[DataFile, ...] = ()
    status_text: Optional[str] = None
    symbol_count: int = 0
    gap_total: int = 0
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Recording":
        cls_, src, _delay, _official = _fresh_fields(d)
        target = _d(d.get("target"))
        status_obj = d.get("symbols") if isinstance(d.get("symbols"), Mapping) else {}
        listed = target.get("symbols") if isinstance(target.get("symbols"), list) else (d.get("symbols") if isinstance(d.get("symbols"), list) else None)
        syms = tuple(str(s) for s in (listed if listed is not None else status_obj.get("sample") or ()))
        underlying = target.get("underlying", d.get("underlying"))
        if isinstance(underlying, (list, tuple)):
            underlying = ", ".join(str(u) for u in underlying)
        gaps = d.get("gaps")
        if isinstance(gaps, Mapping):
            gap_rows: Tuple[Mapping[str, Any], ...] = ()
            gap_total = _int(gaps.get("total")) or 0
        else:
            gap_rows = tuple(g if isinstance(g, Mapping) else {"count": g} for g in (gaps if isinstance(gaps, list) else ([] if gaps is None else [gaps])) if g is not None)
            gap_total = sum(int(g.get("count", 1)) if isinstance(g.get("count", 1), (int, float)) else 1 for g in gap_rows)
        disk = d.get("disk")
        disk_bytes = _int(disk.get("usedBytes")) if isinstance(disk, Mapping) else _int(d.get("diskBytes") if d.get("diskBytes") is not None else disk)
        return cls(str(d.get("id")), d.get("name"), str(d.get("kind")), str(d.get("status")), syms, underlying, target.get("expiry", d.get("expiry")), _num(d.get("everySec")),
                   bool(d.get("sessionOnly", True)), d.get("format"), _int(d.get("rows")) or 0, _int(d.get("bytes")) or 0, parse_time(d.get("lastWriteAt")), gap_rows,
                   disk_bytes, cls_, src, d.get("ruleId"), target.get("collection", d.get("collection")),
                   tuple(DataFile.from_dict(f) for f in d.get("files") or []), d.get("statusText"), _int(status_obj.get("count")) or len(syms), gap_total, dict(d))

    @property
    def is_running(self) -> bool:
        """Writing rows now (``status == "recording"``)."""
        return self.status == "recording"

    @property
    def is_active(self) -> bool:
        """Running or waiting for the next session: it will write by itself (not paused, stopped or blocked)."""
        return self.status in ("recording", "waiting")

    @property
    def gap_count(self) -> int:
        """How many times the feed was silent while this recording was due to write."""
        return self.gap_total


@dataclass(frozen=True)
class RecordingRule:
    """An auto-record rule: the Bridge starts and stops the recording by itself on trading days."""

    id: str
    name: Optional[str]
    enabled: bool
    kind: str
    every_sec: Optional[float]
    schedule: Any
    collection: Optional[str]
    symbols: Tuple[str, ...]
    underlying: Optional[str]
    universe: Optional[Mapping[str, Any]]
    keep_days: Optional[int]
    format: Optional[str]
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "RecordingRule":
        uni = d.get("universe")
        return cls(str(d.get("id")), d.get("name"), bool(d.get("enabled", True)), str(d.get("kind")), _num(d.get("everySec")), d.get("schedule"), d.get("collection"),
                   tuple(str(s) for s in d.get("symbols") or ()), d.get("underlying"), dict(uni) if isinstance(uni, Mapping) else None, _int(d.get("keepDays")), d.get("format"), dict(d))


@dataclass(frozen=True)
class DownloadEstimate:
    """What a download would cost, before it starts (``downloads.estimate``): nothing is queued."""

    symbols: int
    intervals: int
    items: int
    broker_calls: int
    calls_saved: int
    rows: int
    rows_to_fetch: int
    bytes: int
    eta_sec: Optional[float]
    budget_share: Optional[float]
    account: Optional[str]
    already_stored: bool
    fits_disk: bool
    notes: Tuple[str, ...]
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "DownloadEstimate":
        disk = d.get("disk") if isinstance(d.get("disk"), Mapping) else {}
        return cls(_int(d.get("symbols")) or 0, _int(d.get("intervals")) or 0, _int(d.get("items")) or 0, _int(d.get("brokerCalls")) or 0, _int(d.get("callsSaved")) or 0, _int(d.get("rows")) or 0,
                   _int(d.get("rowsToFetch")) or 0, _int(d.get("bytes")) or 0, _num(d.get("etaSec")), _num(d.get("budgetShare")), d.get("account"), bool(d.get("alreadyStored")),
                   not bool(disk.get("wouldExceed")), tuple(str(n) for n in d.get("notes") or ()), dict(d))


@dataclass(frozen=True)
class BudgetSettings:
    """The share of an account's spare API budget background work may use, as the Bridge applies it now.

    ``after_hours_only`` is for downloads; recordings have no such switch (it is ``None`` there). ``defaults`` are the
    values in ``bridge.config.json``; ``changed`` lists what was changed at run time."""

    max_budget_share: float
    after_hours_only: Optional[bool]
    default_share: Optional[float]
    min_share: float
    max_share: float
    changed: Tuple[str, ...]
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "BudgetSettings":
        lim = d.get("limits") if isinstance(d.get("limits"), Mapping) else {}
        dfl = d.get("defaults") if isinstance(d.get("defaults"), Mapping) else {}
        after = d.get("afterHoursOnly")
        return cls(_num(d.get("maxBudgetShare")) or 0.0, None if after is None else bool(after), _num(dfl.get("maxBudgetShare")), _num(lim.get("minBudgetShare")) or 0.05, _num(lim.get("maxBudgetShare")) or 0.8,
                   tuple(str(c) for c in d.get("changed") or ()), dict(d))


@dataclass(frozen=True)
class RecordingStatus:
    """``recordings.status()``: one plain line about today's recording ("Recording today: 3 rules, 41 symbols, ...")."""

    line: str
    enabled: bool
    auto_enabled: bool
    rows_today: int
    bytes_today: int
    symbols_today: int
    gaps_today: int
    last_write_at: Optional[str]
    disk_used_bytes: Optional[int]
    budget_share: Optional[float]
    calls_made: int
    calls_saved: int
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "RecordingStatus":
        today = d.get("today") if isinstance(d.get("today"), Mapping) else {}
        disk = d.get("disk") if isinstance(d.get("disk"), Mapping) else {}
        auto = d.get("auto") if isinstance(d.get("auto"), Mapping) else {}
        api = d.get("apiCalls") if isinstance(d.get("apiCalls"), Mapping) else {}
        return cls(str(d.get("line") or ""), bool(d.get("enabled", True)), bool(auto.get("enabled")), _int(today.get("rows")) or 0, _int(today.get("bytes")) or 0, _int(today.get("symbols")) or 0,
                   _int(today.get("gaps")) or 0, today.get("lastWriteAt"), _int(disk.get("usedBytes")), _num(d.get("budgetShare")), _int(api.get("made")) or 0, _int(api.get("saved")) or 0, dict(d))


@dataclass(frozen=True)
class RecordingPreset:
    """A ready-made auto-record rule ("Record index option chains", "Record my watchlist")."""

    id: str
    title: str
    about: str
    needs: Optional[str]
    rule: Mapping[str, Any]

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "RecordingPreset":
        return cls(str(d.get("id")), str(d.get("title") or d.get("id")), str(d.get("about") or ""), d.get("needs"), dict(d.get("rule") or {}))


@dataclass(frozen=True)
class PresetResult:
    """What applying a preset did: the rule (new, or the one already there) and whether auto-record is now on."""

    preset: str
    created: bool
    rule: RecordingRule
    auto_enabled: bool

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "PresetResult":
        auto = d.get("auto") if isinstance(d.get("auto"), Mapping) else {}
        return cls(str(d.get("preset")), bool(d.get("created")), RecordingRule.from_dict(d.get("rule") or {}), bool(auto.get("enabled")))


@dataclass(frozen=True)
class SavedCalls:
    """Broker calls this Bridge did not make today because the data was already on disk, in the stream, in the cache or shared
    (``bridge.saved_calls()``, from ``GET /v1/limits?explain=1``)."""

    day: Optional[str]
    total: int
    by_reason: Mapping[str, int]
    scheduler: Mapping[str, int]
    total_today: int
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Optional[Mapping[str, Any]]) -> "SavedCalls":
        d = d if isinstance(d, Mapping) else {}
        by = {str(k): _int(v) or 0 for k, v in (d.get("byReason") or {}).items()}
        sch = {str(k): _int(v) or 0 for k, v in (d.get("scheduler") or {}).items()}
        total = _int(d.get("total")) or 0
        return cls(d.get("day"), total, by, sch, _int(d.get("totalToday")) if d.get("totalToday") is not None else total + sum(sch.values()), dict(d))


@dataclass(frozen=True)
class Collection:
    """A named, tagged list of instruments. ``kind`` is ``static`` (a list of symbols) or ``option-universe`` (a rule
    that is resolved to symbols each time it is used)."""

    name: str
    description: Optional[str]
    tags: Tuple[str, ...]
    kind: str
    symbols: Tuple[str, ...]
    universe: Optional[Mapping[str, Any]]
    updated_at: Optional[datetime] = None
    id: Optional[str] = None
    """Stable ``col_`` id: a renamed collection keeps it (the old name still resolves, with a warning)."""
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Collection":
        uni = d.get("universe")
        syms = tuple(str(s.get("symbol") if isinstance(s, Mapping) else s) for s in d.get("symbols") or ())
        kind = str(d.get("kind") or ("option-universe" if uni else "static"))
        return cls(str(d.get("name")), d.get("description"), tuple(str(t) for t in d.get("tags") or ()), kind, syms, dict(uni) if isinstance(uni, Mapping) else None, parse_time(d.get("updatedAt")), d.get("id"), dict(d))

    @property
    def is_dynamic(self) -> bool:
        return self.kind == "option-universe"

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"name": self.name, "description": self.description, "tags": list(self.tags), "kind": self.kind}
        if self.is_dynamic:
            out["universe"] = dict(self.universe or {})
        else:
            out["symbols"] = list(self.symbols)
        return {k: v for k, v in out.items() if v is not None}


@dataclass(frozen=True)
class Resolution:
    """The concrete symbols of a collection at one moment. ``rule`` says how an option universe was worked out (which
    expiry, which ATM strike and from what price). When the price was delayed or missing, the Bridge says so in
    ``warnings`` and ``freshness``: it never uses a stale ATM silently, and neither should you."""

    name: str
    symbols: Tuple[str, ...]
    resolved_at: Optional[datetime]
    rule: Any
    atm: Optional[float]
    freshness: Optional[Freshness]
    warnings: Tuple[str, ...]
    atm_source: Optional[str] = None
    """Where the price behind the ATM came from (as the Bridge reports it)."""
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, name: str, d: Mapping[str, Any]) -> "Resolution":
        syms = tuple(str(s.get("symbol") if isinstance(s, Mapping) else s) for s in d.get("symbols") or ())
        fr = d.get("freshness")
        warn = d.get("warnings") or d.get("notes") or ()
        return cls(str(d.get("name") or name), syms, parse_time(d.get("resolvedAt")), d.get("rule"), _num(d.get("atm") if d.get("atm") is not None else d.get("atmStrike")),
                   Freshness.from_dict(fr) if isinstance(fr, Mapping) else None, tuple(str(w) for w in ([warn] if isinstance(warn, str) else warn)),
                   (str(d["atmSource"]) if isinstance(d.get("atmSource"), (str, int)) else (json.dumps(d["atmSource"], sort_keys=True) if d.get("atmSource") is not None else None)), dict(d))

    def __iter__(self) -> Iterator[str]:
        return iter(self.symbols)

    def __len__(self) -> int:
        return len(self.symbols)

    @property
    def is_reliable(self) -> bool:
        """False when the Bridge flagged the price behind this resolution as delayed, stale or unavailable."""
        if self.warnings:
            return False
        return self.freshness is None or self.freshness.is_fresh


@dataclass(frozen=True)
class Subscription:
    """An outbound webhook subscription. The secret is never returned, and the Bridge shows the target without its path
    (``url`` is that display form; ``host`` is the host alone)."""

    id: str
    url: str
    topics: Tuple[str, ...]
    active: bool
    label: Optional[str] = None
    host: Optional[str] = None
    state: Optional[str] = None
    """``ok``, ``unverified``, ``failing``, ``paused`` or ``needs-secret``, as the Bridge reports it."""
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Subscription":
        return cls(str(d.get("id")), str(d.get("url") or d.get("target") or d.get("host") or ""), tuple(str(t) for t in d.get("topics") or ()), bool(d.get("active", True)), d.get("label"), d.get("host"), d.get("state"), dict(d))


def option_universe(
    underlying: str,
    expiries: Union[str, Sequence[str]] = "current-weekly",
    *,
    count: Optional[int] = 10,
    from_strike: Optional[float] = None,
    to_strike: Optional[float] = None,
    sides: Sequence[str] = ("CE", "PE"),
    include_underlying: bool = True,
    include_future: bool = False,
) -> Dict[str, Any]:
    """The body of an option-universe collection (a dynamic rule, not a fixed list).

    ``expiries`` is ``current-weekly``, ``next-weekly``, ``current-monthly``, ``all-weekly`` or a list of ISO dates.
    Strikes are ``count`` either side of the at-the-money strike (the default) or a fixed ``from_strike`` to
    ``to_strike``. The Bridge recomputes ATM and rolling expiries each time the universe is resolved."""
    if from_strike is not None or to_strike is not None:
        if from_strike is None or to_strike is None:
            raise ValueError("give both from_strike and to_strike, or neither (then count strikes around ATM are used)")
        strikes: Dict[str, Any] = {"from": from_strike, "to": to_strike}
    else:
        if count is None or count < 0:
            raise ValueError("count must be 0 or more")
        strikes = {"around": "atm", "count": int(count)}
    bad = [s for s in sides if s not in ("CE", "PE")]
    if bad:
        raise ValueError("sides are CE and PE, not %r" % bad)
    return {"underlying": underlying, "expiries": expiries if isinstance(expiries, str) else list(expiries), "strikes": strikes, "sides": list(sides),
            "includeUnderlying": bool(include_underlying), "includeFuture": bool(include_future)}


# ── namespaces ─────────────────────────────────────────────────────────────────────────────────────────────────


class _Ns:
    def __init__(self, bridge: "Bridge") -> None:
        self._b = bridge

    @property
    def _c(self) -> Any:
        return self._b.client


def _result(reply: Any, make: Callable[[Mapping[str, Any]], Any]) -> Result[Any]:
    reply = reply if isinstance(reply, Mapping) else {"data": reply}
    return Result([make(i) for i in (reply.get("data") or []) if isinstance(i, Mapping)], reply.get("meta"), problems_from(reply.get("errors")))


class _Files:
    """Listing, saving and reading the files of a job or recording. Subclasses give the route names."""

    _files_path = ""  # "/v1/downloads/{}/files"

    def _file_list(self, owner: Any) -> List[DataFile]:  # pragma: no cover - overridden
        raise NotImplementedError

    def _save(self, c: Any, owner_id: str, files: Sequence[DataFile], directory: str, *, overwrite: bool, verify: bool, names: Optional[Sequence[str]], manifest: Optional[Mapping[str, Any]]) -> List[SavedFile]:
        os.makedirs(directory, exist_ok=True)
        wanted = set(names) if names else None
        saved: List[SavedFile] = []
        for f in files:
            if wanted is not None and f.name not in wanted:
                continue
            name = _safe_name(f.name)
            dest = os.path.join(directory, name)
            if os.path.isfile(dest) and not overwrite and f.sha256 and _sha256_of(dest) == f.sha256.lower():
                saved.append(SavedFile(name, dest, os.path.getsize(dest), f.sha256.lower(), True))
                continue
            r = c.download_to(self._files_path.format(urllib.parse.quote(owner_id, safe="")) + "/" + urllib.parse.quote(f.name, safe=""), dest, expect_sha256=(f.sha256 if verify else None))
            saved.append(SavedFile(name, dest, r["bytes"], r["sha256"]))
        if manifest is not None and not os.path.exists(os.path.join(directory, "manifest.json")):
            with open(os.path.join(directory, "manifest.json"), "w", encoding="utf-8") as fh:
                json.dump(manifest, fh, indent=2, sort_keys=True, default=str)
                fh.write("\n")
        return saved

    def _read(self, c: Any, owner_id: str, files: Sequence[DataFile], names: Optional[Sequence[str]], as_dataframe: bool) -> Any:
        from . import frames

        out: List[Dict[str, Any]] = []
        for f in files:
            if names is not None and f.name not in names:
                continue
            fmt = f.format
            if fmt not in ("csv", "jsonl"):
                raise ValueError("%s is a %s file: read() understands csv and jsonl. Use save() to keep it, then open it in the program it was made for." % (f.name, fmt))
            with c.open_stream("GET", self._files_path.format(urllib.parse.quote(owner_id, safe="")) + "/" + urllib.parse.quote(f.name, safe="")) as res:
                raw = res.read()
            if f.name.lower().endswith(".gz") or raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            rows = frames.parse_table(raw.decode("utf-8", errors="replace"), fmt)
            if f.symbol or f.interval:
                for r in rows:
                    if f.symbol and "symbol" not in r:
                        r["symbol"] = f.symbol
                    if f.interval and "interval" not in r:
                        r["interval"] = f.interval
            out.extend(rows)
        return frames.records_to_dataframe(out) if as_dataframe else out


def _sha256_of(path: str) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 16), b""):
            h.update(block)
    return h.hexdigest()


class Downloads(_Ns, _Files):
    """``bridge.downloads``: ask the Bridge to fetch history for many symbols and keep it as files."""

    _files_path = "/v1/downloads/{}/files"

    def _body(
        self,
        symbols: Union[str, Sequence[str], None] = None,
        intervals: Union[str, Sequence[str], None] = None,
        from_: Union[str, date, datetime, None] = None,
        to: Union[str, date, datetime, None] = None,
        *,
        name: Optional[str] = None,
        format: Optional[str] = None,  # noqa: A002
        layout: Optional[str] = None,
        dataset: Optional[str] = None,
        collection: Optional[str] = None,
        account: Optional[str] = None,
        backup: Optional[bool] = None,
        tags: Optional[Sequence[str]] = None,
    ) -> Dict[str, Any]:
        """The request body for a download (shared by ``create`` and ``estimate``).

        Give ``symbols`` (canonical, up to 500) or the name of a ``collection``; ``intervals`` (``"5m"`` or a list);
        ``from_`` (and ``to``, default now). With ``dataset="name"`` the job continues that dataset from its last stored
        bar. ``format`` is ``csv`` (default), ``jsonl`` or ``amibroker``; ``layout`` ``per-symbol`` or ``combined``.
        ``backup=True`` lets a free source serve it (labelled delayed or end-of-day on the job and in every file).
        """
        syms, ivs = _list(symbols), _list(intervals)
        if bool(syms) == bool(collection):
            raise ValueError("give either symbols or collection=<name>, not both and not neither")
        if not ivs:
            raise ValueError("intervals is required, for example \"5m\" or [\"5m\", \"1d\"]")
        if from_ is None and not dataset:
            raise ValueError("from_ is required (an ISO date such as \"2024-01-01\"), unless dataset=<name> continues an existing dataset")
        if format is not None and format not in DOWNLOAD_FORMATS:
            raise ValueError("format must be one of %s" % ", ".join(DOWNLOAD_FORMATS))
        if layout is not None and layout not in DOWNLOAD_LAYOUTS:
            raise ValueError("layout must be one of %s" % ", ".join(DOWNLOAD_LAYOUTS))
        body: Dict[str, Any] = {"name": name, "symbols": syms or None, "collection": collection, "intervals": ivs, "from": iso(from_), "to": iso(to), "format": format, "layout": layout,
                                "dataset": dataset, "account": account, "backup": backup, "tags": list(tags) if tags else None}
        return {k: v for k, v in body.items() if v is not None}

    def create(
        self,
        symbols: Union[str, Sequence[str], None] = None,
        intervals: Union[str, Sequence[str], None] = None,
        from_: Union[str, date, datetime, None] = None,
        to: Union[str, date, datetime, None] = None,
        *,
        name: Optional[str] = None,
        format: Optional[str] = None,  # noqa: A002
        layout: Optional[str] = None,
        dataset: Optional[str] = None,
        collection: Optional[str] = None,
        account: Optional[str] = None,
        backup: Optional[bool] = None,
        tags: Optional[Sequence[str]] = None,
    ) -> DownloadJob:
        """Queue a download (``POST /v1/downloads``) and return the job at once; it runs in the background.

        Give ``symbols`` (canonical, up to 500) or the name of a ``collection``; ``intervals`` (``"5m"`` or a list);
        ``from_`` (and ``to``, default now). With ``dataset="name"`` the job continues that dataset from its last stored
        bar. ``format`` is ``csv`` (default), ``jsonl`` or ``amibroker``; ``layout`` ``per-symbol`` or ``combined``.
        ``backup=True`` lets a free source serve it (labelled delayed or end-of-day on the job and in every file).
        Use ``estimate`` with the same arguments first to see the cost.
        """
        return DownloadJob.from_dict(_data(self._c.create_download(self._body(symbols, intervals, from_, to, name=name, format=format, layout=layout, dataset=dataset, collection=collection, account=account, backup=backup, tags=tags))))

    def estimate(
        self,
        symbols: Union[str, Sequence[str], None] = None,
        intervals: Union[str, Sequence[str], None] = None,
        from_: Union[str, date, datetime, None] = None,
        to: Union[str, date, datetime, None] = None,
        *,
        name: Optional[str] = None,
        format: Optional[str] = None,  # noqa: A002
        layout: Optional[str] = None,
        dataset: Optional[str] = None,
        collection: Optional[str] = None,
        account: Optional[str] = None,
        backup: Optional[bool] = None,
        tags: Optional[Sequence[str]] = None,
    ) -> DownloadEstimate:
        """What this download would cost, without starting it (``POST /v1/downloads?dryRun=1``): broker calls, calls saved
        by data already stored on this computer, rows, bytes, the time at your budget share and whether it fits the disk.
        Takes the same arguments as ``create``."""
        return DownloadEstimate.from_dict(_data(self._c.create_download(self._body(symbols, intervals, from_, to, name=name, format=format, layout=layout, dataset=dataset, collection=collection, account=account, backup=backup, tags=tags), dry_run=True)))

    def settings(self) -> BudgetSettings:
        """The budget share and after-hours switch downloads use now (``GET /v1/downloads/settings``)."""
        return BudgetSettings.from_dict(_data(self._c.download_settings()))

    def set_settings(self, *, max_budget_share: Optional[float] = None, after_hours_only: Optional[bool] = None) -> BudgetSettings:
        """Change them while the Bridge runs (an admin key from this computer). The share is 0.05 to 0.8; it applies at once
        to running jobs and is kept across restarts."""
        body = _wire({"max_budget_share": max_budget_share, "after_hours_only": after_hours_only})
        if not body:
            raise ValueError("give max_budget_share and/or after_hours_only")
        return BudgetSettings.from_dict(_data(self._c.set_download_settings(body)))

    def get(self, job: Union[str, DownloadJob]) -> DownloadJob:
        return DownloadJob.from_dict(_data(self._c.download(_id_of(job))))

    def list(self, *, status: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None) -> Result[DownloadJob]:
        """Jobs, newest first."""
        return _result(self._c.downloads(status=status, limit=limit, cursor=cursor), DownloadJob.from_dict)

    def pause(self, job: Union[str, DownloadJob]) -> DownloadJob:
        return DownloadJob.from_dict(_data(self._c.pause_download(_id_of(job))))

    def resume(self, job: Union[str, DownloadJob]) -> DownloadJob:
        return DownloadJob.from_dict(_data(self._c.resume_download(_id_of(job))))

    def cancel(self, job: Union[str, DownloadJob]) -> DownloadJob:
        return DownloadJob.from_dict(_data(self._c.cancel_download(_id_of(job))))

    def delete(self, job: Union[str, DownloadJob]) -> None:
        """Remove the job and its files from the Bridge's disk (files you saved elsewhere are untouched)."""
        self._c.delete_download(_id_of(job))

    def rename(self, job: Union[str, DownloadJob], name: Optional[str] = None, *, tags: Optional[Sequence[str]] = None) -> DownloadJob:
        """Change a job's name or tags."""
        if name is None and tags is None:
            raise ValueError("give a new name or tags")
        return DownloadJob.from_dict(_data(self._c.edit_download(_id_of(job), {k: v for k, v in {"name": name, "tags": list(tags) if tags is not None else None}.items() if v is not None})))

    def wait(
        self,
        job: Union[str, DownloadJob],
        *,
        timeout: Optional[float] = None,
        poll: float = 1.0,
        on_progress: Optional[Callable[[DownloadJob], Any]] = None,
        raise_on_failure: bool = True,
    ) -> DownloadJob:
        """Poll until the job is ``done``, ``failed`` or ``cancelled`` and return it.

        ``on_progress(job)`` is called after every poll. A job that ends failed or cancelled raises ``DownloadFailed``
        (with ``job.reason``) unless ``raise_on_failure=False``. A paused job keeps waiting (resume it). Running out of
        ``timeout`` seconds raises ``WaitTimeout``: the job carries on in the Bridge, look again with ``get()``."""
        jid = _id_of(job)
        t0 = self._b._clock()
        while True:
            cur = self.get(jid)
            if on_progress is not None:
                on_progress(cur)
            if cur.is_final:
                if raise_on_failure and not cur.is_done:
                    raise DownloadFailed("Download %s ended %s%s." % (jid, cur.status, (": " + cur.reason) if cur.reason else ""), cur)
                return cur
            if timeout is not None and self._b._clock() - t0 >= timeout:
                raise WaitTimeout("Download %s is still %s after %.0f s (%d of %d items). It keeps running in the Bridge: look again with bridge.downloads.get(%r)." % (jid, cur.status, timeout, cur.progress.done, cur.progress.total, jid), cur)
            self._b._sleep(poll)

    def files(self, job: Union[str, DownloadJob]) -> List[DataFile]:
        """The job's files with rows, bytes, first and last bar and SHA-256 (the manifest's list)."""
        return [DataFile.from_dict(f) for f in _rows(self._c.download_files(_id_of(job)))]

    def manifest(self, job: Union[str, DownloadJob]) -> Dict[str, Any]:
        """The manifest as a dict: the job's label (data class, source, delay) plus its file list."""
        j = job if isinstance(job, DownloadJob) and job.raw else self.get(_id_of(job))
        return self._manifest(j, self.files(j.id))

    @staticmethod
    def _manifest(job: DownloadJob, files: Sequence[DataFile]) -> Dict[str, Any]:
        out = {k: v for k, v in dict(job.raw).items() if k not in ("progress", "items")}
        out["files"] = [dict(f.raw) for f in files]
        return out

    def save(self, job: Union[str, DownloadJob], directory: str, *, names: Optional[Sequence[str]] = None, overwrite: bool = False, verify: bool = True) -> List[SavedFile]:
        """Download the job's files into ``directory`` (created if needed) and write ``manifest.json`` beside them.

        Each file is streamed to a ``.part`` file, checked against the manifest's SHA-256 and renamed only when it
        matches (``ChecksumMismatch`` otherwise). A file already there with the same checksum is not fetched again, so
        an interrupted save can simply be run again. ``names`` limits it to some files."""
        jid = _id_of(job)
        j = job if isinstance(job, DownloadJob) and job.raw else self.get(jid)
        files = self.files(jid)
        return self._save(self._c, jid, files, directory, overwrite=overwrite, verify=verify, names=names, manifest=self._manifest(j, files))

    def read(self, job: Union[str, DownloadJob], name: Optional[str] = None, *, as_dataframe: bool = False) -> Any:
        """The rows of one file (or of all files, with ``symbol`` and ``interval`` columns added) as a list of dicts, or a
        pandas DataFrame with ``as_dataframe=True``. For csv and jsonl files; big sets belong on disk: use ``save()``."""
        jid = _id_of(job)
        return self._read(self._c, jid, self.files(jid), [name] if name else None, as_dataframe)

    def export_instruments(self, dest: Optional[str] = None, *, exchange: Optional[str] = None, kind: Optional[str] = None, format: str = "csv") -> Any:  # noqa: A002
        """The Bridge's instrument master (``GET /v1/instruments/export``): saved to ``dest`` when given (returns the
        path) or returned as text. ``format`` is ``csv`` or ``jsonl``."""
        if format not in ("csv", "jsonl"):
            raise ValueError("format must be csv or jsonl")
        q = {"exchange": exchange, "kind": kind, "format": format}
        if dest:
            return self._c.download_to("/v1/instruments/export", dest, query=q)["path"]
        with self._c.open_stream("GET", "/v1/instruments/export", query=q) as res:
            return res.read().decode("utf-8", errors="replace")


class Datasets(_Ns):
    """``bridge.datasets``: named sets of bars that grow by update instead of being downloaded again."""

    def list(self, *, tag: Optional[str] = None) -> Result[Dataset]:
        return _result(self._c.datasets(tag=tag), Dataset.from_dict)

    def get(self, name: str) -> Dataset:
        return Dataset.from_dict(_data(self._c.dataset(name)))

    def update(self, name: str, *, wait: bool = False, **wait_kw: Any) -> DownloadJob:
        """Fetch only what is new since the dataset's last stored bar (``POST /v1/datasets/{name}/update``). Returns
        the job; with ``wait=True`` waits for it (``wait_kw`` go to ``downloads.wait``)."""
        job = DownloadJob.from_dict(_data(self._c.update_dataset(name)))
        return self._b.downloads.wait(job, **wait_kw) if wait else job

    def edit(self, name: str, *, new_name: Optional[str] = None, tags: Optional[Sequence[str]] = None, title: Optional[str] = None, description: Optional[str] = None) -> Dataset:
        """Rename a dataset, or change its tags or title (``description`` is an older name for ``title``)."""
        label = title if title is not None else description
        ch = {k: v for k, v in {"name": new_name, "tags": list(tags) if tags is not None else None, "title": label}.items() if v is not None}
        if not ch:
            raise ValueError("give new_name, tags or title")
        return Dataset.from_dict(_data(self._c.edit_dataset(name, ch)))

    def read(self, name: str, symbol: Optional[str] = None, interval: Optional[str] = None, from_: Union[str, date, datetime, None] = None, to: Union[str, date, datetime, None] = None, *,
             as_dataframe: bool = False, account: Optional[str] = None) -> Any:
        """The bars of one symbol and interval of a dataset, from the Bridge's own disk (no broker call for bars it has).

        Reads ``GET /v1/history?dataset=<name>``: the Bridge serves stored bars (``meta.source = "local"``) and asks the
        broker only for a missing tail. Without ``symbol`` and ``interval`` the dataset must hold exactly one pair.
        Returns a ``History`` (typed candles and the data-class label; ``.to_dataframe()``); ``as_dataframe=True``
        returns the DataFrame directly (its ``attrs["freshness"]`` keeps the label). ``from_`` defaults to the dataset's
        first bar and ``to`` to its last."""
        ds = self.get(name)
        pairs = list(dict.fromkeys((f.symbol, f.interval) for f in ds.files if f.symbol and f.interval)) or [(s, i) for s in ds.symbols for i in ds.intervals]
        if symbol is None or interval is None:
            cand = [p for p in pairs if (symbol is None or p[0] == symbol) and (interval is None or p[1] == interval)]
            if len(cand) != 1:
                raise ValueError("dataset %r holds %d symbol/interval pairs; say which one: symbol=... and interval=... (%s)" % (name, len(pairs), ", ".join("%s %s" % p for p in pairs[:8])))
            symbol, interval = cand[0]
        start = from_ if from_ is not None else ds.first_bar
        if start is None:
            raise ValueError("dataset %r has no bars yet: run an update first" % name)
        hist = self._b.history_all(symbol, interval, start, to if to is not None else ds.last_bar, local_first=True, dataset=name, account=account).to_history()
        return hist.to_dataframe() if as_dataframe else hist

    def read_all(self, name: str, *, from_: Union[str, date, datetime, None] = None, to: Union[str, date, datetime, None] = None) -> Dict[Tuple[str, str], Any]:
        """Every symbol and interval of a dataset as ``{(symbol, interval): History}``."""
        ds = self.get(name)
        pairs = list(dict.fromkeys((f.symbol, f.interval) for f in ds.files if f.symbol and f.interval)) or [(s, i) for s in ds.symbols for i in ds.intervals]
        return {p: self.read(name, p[0], p[1], from_, to) for p in pairs}


class RecordingRules(_Ns):
    """``bridge.recordings.rules``: recording that starts by itself ("every trading day, record ...")."""

    def list(self) -> Result[RecordingRule]:
        return _result(self._c.recording_rules(), RecordingRule.from_dict)

    def get(self, rule_id: str) -> RecordingRule:
        for r in self.list():
            if r.id == rule_id or r.name == rule_id:
                return r
        raise NotFound({"status": 404, "code": "NOT_FOUND", "detail": "No recording rule %r." % rule_id})

    def create(
        self,
        name: str,
        kind: str,
        every_sec: float,
        *,
        collection: Optional[str] = None,
        symbols: Optional[Sequence[str]] = None,
        underlying: Optional[str] = None,
        universe: Optional[Mapping[str, Any]] = None,
        schedule: Union[str, Mapping[str, Any]] = "market-hours",
        enabled: bool = True,
        keep_days: Optional[int] = None,
        format: Optional[str] = None,  # noqa: A002
    ) -> RecordingRule:
        """Add a rule. Name the instruments with ``collection``, ``symbols`` or ``underlying`` plus ``universe``.
        ``schedule`` is ``"market-hours"`` (trading days, from the calendar) or ``{"days": [...], "start": "09:15",
        "end": "15:30"}`` (IST). ``keep_days`` deletes older files."""
        if kind not in RECORDING_KINDS:
            raise ValueError("kind must be one of %s" % ", ".join(RECORDING_KINDS))
        if every_sec < MIN_EVERY_SEC[kind]:
            raise ValueError("every_sec must be at least %d for %s recordings" % (MIN_EVERY_SEC[kind], kind))
        if sum(1 for x in (collection, symbols, underlying) if x) != 1:
            raise ValueError("name the instruments with exactly one of collection, symbols or underlying (with universe)")
        body = _wire({"name": name, "enabled": enabled, "kind": kind, "collection": collection, "symbols": list(symbols) if symbols else None, "underlying": underlying, "universe": dict(universe) if universe else None,
                      "every_sec": every_sec, "schedule": schedule if isinstance(schedule, str) else dict(schedule), "keep_days": keep_days, "format": format})
        return RecordingRule.from_dict(_data(self._c.create_recording_rule(body)))

    def update(self, rule_id: str, **changes: Any) -> RecordingRule:
        """Change fields of a rule by name (``enabled=False``, ``every_sec=60``, ``keep_days=30`` ...)."""
        if not changes:
            raise ValueError("nothing to change")
        return RecordingRule.from_dict(_data(self._c.update_recording_rule(rule_id, _wire(changes))))

    def enable(self, rule_id: str) -> RecordingRule:
        return self.update(rule_id, enabled=True)

    def disable(self, rule_id: str) -> RecordingRule:
        return self.update(rule_id, enabled=False)

    def delete(self, rule_id: str) -> None:
        self._c.delete_recording_rule(rule_id)


class Recordings(_Ns, _Files):
    """``bridge.recordings``: save quotes and option chains going forward from the Bridge's own real-time data.

    The Bridge refuses to record delayed or end-of-day sources. Brokers do not give history for chains, open-interest
    snapshots or ticks, which is why this exists. One file per trading day (rolled at IST midnight)."""

    _files_path = "/v1/recordings/{}/files"

    def __init__(self, bridge: "Bridge") -> None:
        super().__init__(bridge)
        self.rules = RecordingRules(bridge)

    def create(
        self,
        kind: str,
        symbols: Union[str, Sequence[str], None] = None,
        *,
        every_sec: float,
        collection: Optional[str] = None,
        underlying: Optional[str] = None,
        expiry: Optional[str] = None,
        session_only: Optional[bool] = None,
        format: Optional[str] = None,  # noqa: A002
        name: Optional[str] = None,
    ) -> Recording:
        """Start a recording (``POST /v1/recordings``). ``kind`` is ``quotes`` (``symbols`` or ``collection``; at least 1 s
        apart) or ``chain`` (``underlying`` and ``expiry``, or a ``collection`` option universe; at least 15 s apart).
        ``session_only`` (default true) records inside market hours only."""
        if kind not in RECORDING_KINDS:
            raise ValueError("kind must be one of %s" % ", ".join(RECORDING_KINDS))
        if every_sec < MIN_EVERY_SEC[kind]:
            raise ValueError("every_sec must be at least %d for %s recordings" % (MIN_EVERY_SEC[kind], kind))
        syms = _list(symbols)
        if kind == "quotes" and bool(syms) == bool(collection):
            raise ValueError("a quotes recording needs symbols or collection=<name> (not both)")
        if kind == "chain" and not (underlying or collection):
            raise ValueError("a chain recording needs underlying (and expiry) or collection=<name>")
        if format is not None and format not in ("csv", "jsonl"):
            raise ValueError("format must be csv or jsonl")
        body = _wire({"name": name, "kind": kind, "symbols": syms or None, "collection": collection, "underlying": underlying, "expiry": expiry, "every_sec": every_sec, "session_only": session_only, "format": format})
        return Recording.from_dict(_data(self._c.create_recording(body)))

    def get(self, recording: Union[str, Recording]) -> Recording:
        return Recording.from_dict(_data(self._c.recording(_id_of(recording))))

    def status(self) -> RecordingStatus:
        """One plain line about today's recording and the numbers behind it (``GET /v1/recordings/status``)."""
        return RecordingStatus.from_dict(_data(self._c.recording_status()))

    def settings(self) -> BudgetSettings:
        """The budget share recordings may use now (``GET /v1/recordings/settings``). Recordings have no after-hours switch."""
        return BudgetSettings.from_dict(_data(self._c.recording_settings()))

    def set_settings(self, *, max_budget_share: float) -> BudgetSettings:
        """Change the share while the Bridge runs (an admin key from this computer; 0.05 to 0.8)."""
        return BudgetSettings.from_dict(_data(self._c.set_recording_settings({"maxBudgetShare": max_budget_share})))

    def presets(self) -> List[RecordingPreset]:
        """The one-click rules: ``index-option-chains`` and ``my-watchlist``."""
        return [RecordingPreset.from_dict(p) for p in _rows(self._c.recording_presets(), "data")]

    def apply_preset(self, preset: Union[str, RecordingPreset], *, collection: Optional[str] = None) -> PresetResult:
        """Make the preset's rule (once) and turn auto-record on (an admin key from this computer).
        ``collection`` picks the collection for ``my-watchlist`` (default ``watchlist``)."""
        body = {"collection": collection} if collection else {}
        return PresetResult.from_dict(_data(self._c.apply_recording_preset(_id_of(preset), body)))

    def list(self, *, status: Optional[str] = None) -> Result[Recording]:
        return _result(self._c.recordings(status=status), Recording.from_dict)

    def pause(self, recording: Union[str, Recording]) -> Recording:
        return Recording.from_dict(_data(self._c.pause_recording(_id_of(recording))))

    def resume(self, recording: Union[str, Recording]) -> Recording:
        return Recording.from_dict(_data(self._c.resume_recording(_id_of(recording))))

    def stop(self, recording: Union[str, Recording]) -> Recording:
        return Recording.from_dict(_data(self._c.stop_recording(_id_of(recording))))

    def delete(self, recording: Union[str, Recording]) -> None:
        """Delete a recording and its files from the Bridge's disk."""
        self._c.delete_recording(_id_of(recording))

    def files(self, recording: Union[str, Recording]) -> List[DataFile]:
        return [DataFile.from_dict(f) for f in _rows(self._c.recording_files(_id_of(recording)))]

    def save(self, recording: Union[str, Recording], directory: str, *, names: Optional[Sequence[str]] = None, overwrite: bool = False, verify: bool = True) -> List[SavedFile]:
        """Download the recording's day files into ``directory`` (same rules as ``downloads.save``)."""
        rid = _id_of(recording)
        rec = recording if isinstance(recording, Recording) else self.get(rid)
        return self._save(self._c, rid, self.files(rid), directory, overwrite=overwrite, verify=verify, names=names, manifest={k: v for k, v in dict(rec.raw).items() if k != "files"})

    def read(self, recording: Union[str, Recording], name: Optional[str] = None, *, as_dataframe: bool = False) -> Any:
        """Rows of one day file (or all) as dicts or a DataFrame."""
        rid = _id_of(recording)
        return self._read(self._c, rid, self.files(rid), [name] if name else None, as_dataframe)


class Collections(_Ns):
    """``bridge.collections``: named, tagged lists of instruments that downloads, recordings and sheets can share."""

    def list(self, *, tag: Optional[str] = None, kind: Optional[str] = None) -> Result[Collection]:
        return _result(self._c.collections(tag=tag, kind=kind), Collection.from_dict)

    def get(self, name: str) -> Collection:
        return Collection.from_dict(_data(self._c.collection(name)))

    def create(
        self,
        name: str,
        symbols: Optional[Sequence[str]] = None,
        *,
        universe: Optional[Mapping[str, Any]] = None,
        description: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
    ) -> Collection:
        """A static list (``symbols=[...]``) or an option universe (``universe=option_universe("NIFTY", ...)``)."""
        if bool(symbols) == bool(universe):
            raise ValueError("give either symbols (a fixed list) or universe (an option universe), not both and not neither")
        body = {"name": name, "description": description, "tags": list(tags or []), "kind": "option-universe" if universe else "static"}
        if universe:
            body["universe"] = dict(universe)
        else:
            body["symbols"] = list(symbols or [])
        return Collection.from_dict(_data(self._c.create_collection({k: v for k, v in body.items() if v is not None})))

    def update(self, name: str, *, symbols: Optional[Sequence[str]] = None, universe: Optional[Mapping[str, Any]] = None, description: Optional[str] = None, tags: Optional[Sequence[str]] = None,
               new_name: Optional[str] = None) -> Collection:
        ch: Dict[str, Any] = {"name": new_name, "description": description, "tags": list(tags) if tags is not None else None, "symbols": list(symbols) if symbols is not None else None,
                              "universe": dict(universe) if universe is not None else None}
        ch = {k: v for k, v in ch.items() if v is not None}
        if not ch:
            raise ValueError("nothing to change")
        return Collection.from_dict(_data(self._c.update_collection(name, ch)))

    def rename(self, name: str, new_name: str) -> Collection:
        return self.update(name, new_name=new_name)

    def tag(self, name: str, *tags: str, remove: Sequence[str] = ()) -> Collection:
        """Add tags to a collection (and drop the ones in ``remove``)."""
        cur = self.get(name)
        new = [t for t in cur.tags if t not in set(remove)]
        new += [t for t in tags if t not in new]
        return self.update(name, tags=new)

    def duplicate(self, name: str, new_name: str) -> Collection:
        """A copy under a new name (same symbols or universe, description and tags)."""
        c = self.get(name)
        return self.create(new_name, list(c.symbols) if not c.is_dynamic else None, universe=c.universe if c.is_dynamic else None, description=c.description, tags=c.tags)

    def delete(self, name: str) -> None:
        self._c.delete_collection(name)

    def resolve(self, name: str, *, allow_stale: bool = False) -> Resolution:
        """The concrete symbols now. An option universe is recomputed on each call (rolling expiry, moving ATM). The
        Bridge refuses to work out an ATM from a delayed or end-of-day price (422) or a stale one (503): that raises the
        usual typed error. ``allow_stale=True`` accepts a stale price; the answer is then labelled (``warnings``,
        ``atm_source``, ``freshness``): read them, and never trade on such a resolution silently."""
        return Resolution.from_dict(name, _data(self._c.resolve_collection(name, allow_stale=True if allow_stale else None)) or {})

    def symbols(self, name: str, *, allow_stale: bool = False) -> List[str]:
        """Shortcut for ``resolve(name).symbols`` as a list."""
        return list(self.resolve(name, allow_stale=allow_stale).symbols)

    def usage(self, name: str) -> Dict[str, Any]:
        """Which downloads, recordings and datasets use the collection (as the Bridge reports it)."""
        return dict(_data(self._c.collection_usage(name)) or {})

    def estimate(self, name: str, *, intervals: Union[str, Sequence[str], None] = None, days: Optional[int] = None) -> Dict[str, Any]:
        """Size estimate: symbols x intervals x days (rows, bytes and the broker calls it would cost, as reported)."""
        return dict(_data(self._c.collection_estimate(name, intervals=intervals, days=days)) or {})

    def export(self, name: str, format: str = "json", path: Optional[str] = None) -> str:  # noqa: A002
        """The collection as JSON text or CSV text (a ``symbol`` column; for an option universe the current resolved
        symbols), also written to ``path`` when given."""
        c = self.get(name)
        if format == "json":
            text = json.dumps(c.to_dict(), indent=2, sort_keys=True) + "\n"
        elif format == "csv":
            syms = self.resolve(name).symbols if c.is_dynamic else c.symbols
            buf = io.StringIO()
            w = csv.writer(buf, lineterminator="\n")
            w.writerow(["symbol"])
            for s in syms:
                w.writerow([s])
            text = buf.getvalue()
        else:
            raise ValueError("format must be json or csv")
        if path:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(text)
        return text

    def import_(self, source: str, name: Optional[str] = None, *, format: Optional[str] = None, tags: Optional[Sequence[str]] = None, description: Optional[str] = None) -> Collection:
        """Create a collection from a file path or text: JSON (the shape ``export`` writes, or a plain list of symbols) or
        CSV (a ``symbol`` column, or one symbol per line). ``name`` is needed unless the JSON carries one."""
        text = source
        if "\n" not in source and len(source) < 4096 and os.path.isfile(source):
            with open(source, "r", encoding="utf-8") as f:
                text = f.read()
            format = format or ("json" if source.lower().endswith(".json") else "csv")
        text = text.lstrip("﻿")
        format = format or ("json" if text.lstrip()[:1] in ("{", "[") else "csv")
        if format == "json":
            doc = json.loads(text)
            if isinstance(doc, list):
                doc = {"symbols": doc}
            cname = name or doc.get("name")
            if not cname:
                raise ValueError("give name=..., the JSON has none")
            uni = doc.get("universe")
            return self.create(cname, None if uni else [str(s.get("symbol") if isinstance(s, Mapping) else s) for s in doc.get("symbols") or []], universe=uni, description=description or doc.get("description"), tags=tags or doc.get("tags"))
        if not name:
            raise ValueError("give name=... for a CSV import")
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        syms: List[str] = []
        if lines and re.match(r"^[\"']?symbols?[\"']?(,|$)", lines[0], re.I):
            syms = [row["symbol" if "symbol" in row else "symbols"].strip() for row in csv.DictReader(io.StringIO("\n".join(lines)), skipinitialspace=True) if row.get("symbol" if "symbol" in row else "symbols")]
        else:
            syms = [ln.split(",")[0].strip().strip("\"'") for ln in lines]
        return self.create(name, syms, description=description, tags=tags)


class Subscriptions(_Ns):
    """``bridge.subscriptions``: signed outbound webhooks (the Bridge posts events to your URL). Needs an admin key from
    the Bridge's computer. Verify each delivery with ``mrchartist_bridge.verify_signature``. Delivery is at least once:
    de-duplicate on the ``id`` in the verified body (the ``X-Bridge-Event-Id`` header is not signed)."""

    def list(self) -> Result[Subscription]:
        return _result(self._c.subscriptions(), Subscription.from_dict)

    def get(self, subscription_id: str) -> Subscription:
        return Subscription.from_dict(_data(self._c.subscription(subscription_id)))

    def create(self, url: str, topics: Sequence[str], *, secret: str, active: bool = True, label: Optional[str] = None, accounts: Union[str, Sequence[str], None] = None) -> Subscription:
        """Add a subscription. ``secret`` (16 to 256 characters) is write-only: the Bridge never shows it again. The URL
        must be https unless the Bridge's config allows a private target. ``accounts`` limits the events to some accounts."""
        if not topics:
            raise ValueError("topics is required, for example [\"download.done\"]")
        body = {"url": url, "topics": list(topics), "secret": secret, "active": active, "label": label, "accounts": accounts if isinstance(accounts, str) or accounts is None else list(accounts)}
        return Subscription.from_dict(_data(self._c.create_subscription({k: v for k, v in body.items() if v is not None})))

    def update(self, subscription_id: str, *, url: Optional[str] = None, topics: Optional[Sequence[str]] = None, secret: Optional[str] = None, active: Optional[bool] = None, label: Optional[str] = None) -> Subscription:
        ch = {k: v for k, v in {"url": url, "topics": list(topics) if topics is not None else None, "secret": secret, "active": active, "label": label}.items() if v is not None}
        if not ch:
            raise ValueError("nothing to change")
        return Subscription.from_dict(_data(self._c.update_subscription(subscription_id, ch)))

    def delete(self, subscription_id: str) -> None:
        self._c.delete_subscription(subscription_id)

    def test(self, subscription_id: str) -> Dict[str, Any]:
        """Send one signed ``subscription.test`` event to the URL now and return the outcome (not queued, not retried)."""
        return dict(_data(self._c.test_subscription(subscription_id)) or {})

    def deliveries(self, subscription_id: str, *, limit: Optional[int] = None, outcome: Optional[str] = None) -> Result[Dict[str, Any]]:
        """The delivery log, newest first (time, outcome, HTTP status, a short code, duration). ``outcome`` filters:
        delivered, retry, dead or failed."""
        if outcome is not None and outcome not in ("delivered", "retry", "dead", "failed"):
            raise ValueError("outcome is delivered, retry, dead or failed")
        r = self._c.subscription_deliveries(subscription_id, limit=limit, outcome=outcome)
        return Result([dict(i) for i in (r.get("data") or []) if isinstance(i, Mapping)], r.get("meta"), problems_from(r.get("errors")))

    def dead_letters(self, subscription_id: str) -> Result[Dict[str, Any]]:
        """Events that could not be delivered (a refused target, or up to 8 failed attempts). Fix the cause, then
        ``retry_dead_letter`` or ``clear_dead_letters``."""
        r = self._c.subscription_dead_letters(subscription_id)
        return Result([dict(i) for i in (r.get("data") or []) if isinstance(i, Mapping)], r.get("meta"), problems_from(r.get("errors")))

    def retry_dead_letter(self, subscription_id: str, delivery_id: Union[str, Mapping[str, Any]]) -> Dict[str, Any]:
        """Send one dead letter again (``delivery_id`` is its ``id``, or the dead-letter dict itself)."""
        did = delivery_id.get("id") or delivery_id.get("deliveryId") if isinstance(delivery_id, Mapping) else delivery_id
        return dict(_data(self._c.retry_dead_letter(subscription_id, str(did))) or {})

    def retry_all_dead_letters(self, subscription_id: str) -> List[Dict[str, Any]]:
        """Send every waiting dead letter again; returns the answers."""
        return [self.retry_dead_letter(subscription_id, d) for d in self.dead_letters(subscription_id)]

    def clear_dead_letters(self, subscription_id: str) -> int:
        """Forget the dead letters; returns how many were removed."""
        d = _data(self._c.clear_dead_letters(subscription_id)) or {}
        return int(d.get("removed") or 0) if isinstance(d, Mapping) else 0
