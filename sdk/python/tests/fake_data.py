"""The data routes of the fake Bridge: downloads, datasets, recordings and their rules, collections, subscriptions,
the event stream and long-range history (standard library only). Used by ``FakeBridge`` (fake_bridge.py).

The shapes follow the wave plan (docs/openapi.yaml for what exists; the rest are the natural shapes the SDK assumes).
Tests steer it through plain attributes: ``job_polls`` (polls before a job is done), ``job_fail`` (reason: the job
fails), ``tamper`` (file name -> bytes served instead of the real ones, to test checksums), ``events`` (the event log),
``sse_drop_after`` (close each event connection after N events, to test reconnects), ``history_series`` (symbol ->
candles), ``history_max_days`` (a window longer than this comes back partial), ``local_range`` ((from, to) epoch
seconds the Bridge "already stored").
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

DAY = 86400


class Raw:
    """A non-JSON reply (a file)."""

    def __init__(self, body: bytes, content_type: str = "text/csv; charset=utf-8", status: int = 200, headers: Optional[Dict[str, str]] = None) -> None:
        self.body, self.content_type, self.status, self.headers = body, content_type, status, headers or {}


class Frames:
    """A Server-Sent Events reply: the frames are written, then the connection is closed."""

    def __init__(self, frames: List[bytes]) -> None:
        self.frames = frames


def bars(start: int, n: int, step: int = 300, base: float = 100.0) -> List[Dict[str, Any]]:
    return [{"time": start + i * step, "open": base + i, "high": base + i + 1, "low": base + i - 1, "close": base + i + 0.5, "volume": 100 + i} for i in range(n)]


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


class DataRoutes:
    def __init__(self, fake: Any) -> None:
        self.fake = fake
        self.reset()

    def reset(self) -> None:
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self.job_files: Dict[str, Dict[str, bytes]] = {}
        self.job_gets: Dict[str, int] = {}
        self.datasets: Dict[str, Dict[str, Any]] = {}
        self.recordings: Dict[str, Dict[str, Any]] = {}
        self.rules: Dict[str, Dict[str, Any]] = {}
        self.collections: Dict[str, Dict[str, Any]] = {}
        self.subs: Dict[str, Dict[str, Any]] = {}
        self.dead: Dict[str, List[Dict[str, Any]]] = {}
        self.events: List[Dict[str, Any]] = []
        self.seq = 0
        self.job_polls = 2
        self.job_fail: Optional[str] = None
        self.tamper: Dict[str, bytes] = {}
        self.sse_drop_after: Optional[int] = None
        self.sse_fail_first = 0
        self.events_oldest = 1
        self.history_series: Dict[str, List[Dict[str, Any]]] = {}
        self.history_max_days: Optional[float] = None
        self.local_range: Optional[Tuple[int, int]] = None
        self.history_log: List[Dict[str, Any]] = []
        self.atm_delayed = False
        self.dl_settings: Dict[str, Any] = {"maxBudgetShare": 0.3, "afterHoursOnly": False}
        self.rec_settings: Dict[str, Any] = {"maxBudgetShare": 0.3}
        self.auto_on = False
        self.saved_calls: Dict[str, Any] = {"day": "2026-11-09", "total": 120, "byReason": {"dataset-incremental": 100, "local-history": 20}}
        self.saved_scheduler: Dict[str, int] = {"servedFromStream": 5, "servedFromCache": 3, "coalesced": 2, "batched": 0}
        self.requests: List[Tuple[str, str]] = []

    # ── helpers ──

    def _id(self, prefix: str) -> str:
        self.seq += 1
        return "%s_%04d" % (prefix, self.seq)

    def emit(self, topic: str, data: Dict[str, Any]) -> Dict[str, Any]:
        ev = {"id": str(len(self.events) + 1), "topic": topic, "time": "2026-11-09T04:30:00.000Z", "apiVersion": "v1", "data": data}
        self.events.append(ev)
        return ev

    def ok(self, data: Any, status: int = 200, **meta: Any) -> Tuple[int, Any]:
        return status, {"data": data, "meta": dict({"requestId": "req_1"}, **meta)}

    def nf(self, what: str) -> Tuple[int, Any]:
        return self.fake.problem(404, "NOT_FOUND", "No %s." % what)

    def resolve_symbols(self, name: str) -> Tuple[List[str], Dict[str, Any]]:
        c = self.collections[name]
        if c["kind"] == "option-universe":
            u = c["universe"]
            atm = 26000
            n = (u.get("strikes") or {}).get("count", 2)
            syms = ["NSE:" + u["underlying"]] if u.get("includeUnderlying") else []
            for k in range(atm - 50 * n, atm + 50 * n + 1, 50):
                for side in u.get("sides", ["CE", "PE"]):
                    syms.append("NFO:%s-2026-11-12-%d-%s" % (u["underlying"], k, side))
            return syms, {"rule": "current-weekly 2026-11-12, ATM %d +/- %d" % (atm, n), "atm": atm}
        return list(c["symbols"]), {}

    # ── routing ──

    def route(self, method: str, path: str, q: Dict[str, str], body: Any, headers: Any) -> Optional[Tuple[int, Any]]:
        parts = [urllib.parse.unquote(p) for p in path.split("/")[2:]]  # after "/v1"
        if not path.startswith("/v1/") or not parts:
            return None
        head = parts[0]
        self.requests.append((method, path + ("?" + urllib.parse.urlencode(q) if q else "")))
        if path == "/v1/limits" and method == "GET":
            data: Dict[str, Any] = {"safety": {}, "brokers": {}, "client": {"perSecond": 10, "burst": 20, "remaining": 20}, "accounts": []}
            if q.get("explain") in ("1", "true"):
                data["pools"], data["consumers"] = [], []
                data["savedCalls"] = dict(self.saved_calls, scheduler=dict(self.saved_scheduler), totalToday=self.saved_calls["total"] + sum(self.saved_scheduler.values()))
            return self.ok(data)
        if head == "downloads":
            return self.downloads(method, parts[1:], q, body)
        if head == "datasets":
            return self.datasets_route(method, parts[1:], q, body)
        if head == "recordings":
            return self.recordings_route(method, parts[1:], q, body)
        if head == "collections":
            return self.collections_route(method, parts[1:], q, body)
        if head == "subscriptions":
            return self.subs_route(method, parts[1:], q, body)
        if head == "events" and parts[1:] == ["stream"] and method == "GET":
            return self.event_stream(q, headers)
        if head == "events" and parts[1:] == ["topics"] and method == "GET":
            return self.ok([{"topic": "download.done", "scope": "read", "accountScoped": False, "description": "A data download finished"}])
        if head == "events" and len(parts) == 1 and method == "GET":
            return self.events_poll(q)
        if path == "/v1/instruments/export" and method == "GET":
            rows = "symbol,exchange,kind\nNSE:RELIANCE,NSE,EQ\nNSE:TCS,NSE,EQ\n"
            return 200, Raw(rows.encode())
        if path == "/v1/history" and method == "GET" and (q.get("symbol") in self.history_series):
            return self.history(q)
        return None

    # ── downloads ──

    def make_files(self, req: Dict[str, Any]) -> Dict[str, bytes]:
        files: Dict[str, bytes] = {}
        fmt = req.get("format") or "csv"
        syms = req.get("symbols") or self.resolve_symbols(req["collection"])[0]
        for s in syms:
            for iv in req["intervals"]:
                rows = bars(1760000000, 3)
                if fmt == "jsonl":
                    text = "".join(json.dumps(dict(r, symbol=s)) + "\n" for r in rows)
                else:
                    buf = io.StringIO()
                    w = csv.writer(buf, lineterminator="\n")
                    w.writerow(["time", "open", "high", "low", "close", "volume"])
                    for r in rows:
                        w.writerow([r["time"], r["open"], r["high"], r["low"], r["close"], r["volume"]])
                    text = buf.getvalue()
                files["%s_%s.%s" % (s.replace(":", "-"), iv, "jsonl" if fmt == "jsonl" else "csv")] = text.encode()
        return files

    def file_rows(self, name: str, content: bytes, req: Dict[str, Any]) -> Dict[str, Any]:
        sym = name.rsplit("_", 1)[0].replace("-", ":", 1)
        return {"name": name, "symbol": sym, "interval": name.rsplit("_", 1)[1].split(".")[0], "rows": 3, "bytes": len(content), "firstBar": "2025-10-09T14:23:20+05:30",
                "lastBar": "2025-10-09T14:33:20+05:30", "sha256": sha(content)}

    def job_view(self, job: Dict[str, Any]) -> Dict[str, Any]:
        jid = job["id"]
        n = self.job_gets.get(jid, 0)
        status = job["status"]
        if status in ("queued", "running"):
            if self.job_fail and n >= 1:
                job["status"], job["reason"] = "failed", self.job_fail
                job["failure"] = {"code": "SESSION_EXPIRED", "message": self.job_fail, "fix": "Log in to your broker again on the Accounts page, then resume the job.",
                                  "symbol": job["items"][0]["symbol"], "interval": job["items"][0]["interval"], "failedItems": len(job["items"])}
                self.emit("download.failed", {"id": jid, "reason": self.job_fail})
            elif n >= self.job_polls:
                self.finish(job)
            elif n >= 1:
                job["status"] = "running"
            self.job_gets[jid] = n + 1
        total = len(job["items"])
        done = total if job["status"] == "done" else (1 if job["status"] == "running" else 0)
        out = dict(job)
        out["progress"] = {"total": total, "done": done, "failed": total if job["status"] == "failed" else 0, "rows": 3 * done, "bytes": 90 * done, "etaSec": None if done == total else 5,
                           "current": {"symbol": job["items"][0]["symbol"], "interval": job["items"][0]["interval"]} if job["status"] == "running" else None}
        out["items"] = [dict(i, status="done" if job["status"] == "done" else i["status"], rows=3 if job["status"] == "done" else 0) for i in job["items"]]
        if job["status"] == "failed":
            out["items"] = [dict(i, status="failed", error={"code": "SESSION_EXPIRED", "message": job["reason"], "fix": job["failure"]["fix"]}) for i in out["items"]]
        if job["status"] == "done":
            out["files"] = [self.file_rows(n_, c, job["request"]) for n_, c in self.job_files[jid].items()]
        return out

    def finish(self, job: Dict[str, Any]) -> None:
        jid = job["id"]
        job["status"] = "done"
        job["finishedAt"] = "2026-11-09T10:05:00+05:30"
        self.job_files[jid] = self.make_files(job["request"])
        ds = job["request"].get("dataset")
        if ds:
            d = self.datasets.setdefault(ds, {"name": ds, "tags": [], "title": None, "dataClass": job["dataClass"], "source": job["source"], "official": job["official"], "delaySec": job["delaySec"], "files": [], "updates": 0})
            d["updates"] += 1
            merged = {f["name"]: f for f in d["files"]}
            merged.update({n_: self.file_rows(n_, c, job["request"]) for n_, c in self.job_files[jid].items()})
            d["files"] = list(merged.values())
            for f in d["files"]:  # the real server keeps the bars per file, not on the dataset
                f["firstBar"], f["lastBar"] = "2025-10-09T14:23:20+05:30", "2025-10-09T14:33:20+05:30"
            d["updatedAt"] = "2026-11-09T10:05:00+05:30"
            d["request"] = {"symbols": sorted({f["symbol"] for f in d["files"]}), "intervals": sorted({f["interval"] for f in d["files"]}), "from": job["request"].get("from")}
            d["gaps"] = 0
            d["rows"], d["bytes"] = sum(f.get("rows") or 0 for f in d["files"]), sum(f.get("bytes") or 0 for f in d["files"])
        self.emit("download.done", {"id": jid})

    def settings_view(self, current: Dict[str, Any], default_share: float = 0.3) -> Dict[str, Any]:
        return dict(current, defaults={"maxBudgetShare": default_share}, limits={"minBudgetShare": 0.05, "maxBudgetShare": 0.8}, changed=[])

    def settings_route(self, method: str, current: Dict[str, Any], body: Any, allowed: Tuple[str, ...]) -> Tuple[int, Any]:
        if method == "GET":
            return self.ok(self.settings_view(current))
        b = dict(body or {})
        bad = [k for k in b if k not in allowed]
        if bad or not b:
            return self.fake.problem(400, "VALIDATION_FAILED", "Send %s." % " and/or ".join(allowed))
        share = b.get("maxBudgetShare")
        if share is not None and not (isinstance(share, (int, float)) and 0.05 <= share <= 0.8):
            return self.fake.problem(400, "VALIDATION_FAILED", "maxBudgetShare must be from 0.05 to 0.8.")
        current.update(b)
        return self.ok(self.settings_view(current))

    def estimate(self, req: Dict[str, Any], syms: List[str]) -> Tuple[int, Any]:
        days = 3
        rows = len(syms) * len(req["intervals"]) * days * 75
        stored = int(req.get("dataset") in self.datasets) * 40
        calls = max(0, len(syms) * len(req["intervals"]) - stored)
        return self.ok({"symbols": len(syms), "intervals": len(req["intervals"]), "items": len(syms) * len(req["intervals"]), "brokerCalls": calls, "callsSaved": stored, "rows": rows, "rowsToFetch": rows,
                        "bytes": rows * 62, "bytesPerRow": 62, "etaSec": calls * 4, "budgetShare": self.dl_settings["maxBudgetShare"], "account": "paper", "alreadyStored": False,
                        "disk": {"usedBytes": 0, "maxBytes": 5000 * 1024 * 1024, "wouldExceed": False}, "notes": ["Rows assume every trading minute has a bar."]}, dryRun=True)

    def downloads(self, method: str, parts: List[str], q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        if parts == ["settings"]:
            return self.settings_route(method, self.dl_settings, body, ("maxBudgetShare", "afterHoursOnly"))
        if not parts:
            if method == "POST":
                req = dict(body or {})
                syms = req.get("symbols") or (self.resolve_symbols(req["collection"])[0] if req.get("collection") in self.collections else None)
                if not syms or not req.get("intervals"):
                    return self.fake.problem(400, "VALIDATION_FAILED", "symbols (or collection) and intervals are required")
                if len(syms) > 500:
                    return self.fake.problem(400, "VALIDATION_FAILED", "at most 500 symbols")
                if q.get("dryRun") in ("1", "true"):
                    return self.estimate(req, syms)
                jid = self._id("dl")
                delayed = bool(req.get("backup"))
                job = {"id": jid, "name": req.get("name") or jid, "status": "queued", "request": req, "tags": req.get("tags") or [], "dataClass": "delayed" if delayed else "realtime",
                       "source": "yahoo" if delayed else "paper", "official": not delayed, "delaySec": 900 if delayed else 0, "createdAt": "2026-11-09T10:00:00+05:30", "startedAt": None, "finishedAt": None,
                       "manifestUrl": "/v1/downloads/%s/files" % jid, "items": [{"symbol": s, "interval": iv, "status": "queued"} for s in syms for iv in req["intervals"]], "notes": []}
                self.jobs[jid] = job
                return self.ok(dict(job, progress={"total": len(job["items"]), "done": 0, "failed": 0, "rows": 0, "bytes": 0, "etaSec": None, "current": None}), 202)
            rows = [self.job_view(j) for j in reversed(list(self.jobs.values())) if not q.get("status") or j["status"] == q["status"]]
            return self.ok(rows, nextCursor=None)
        jid = parts[0]
        job = self.jobs.get(jid)
        if job is None:
            return self.fake.problem(404, "NOT_FOUND", "No download %s." % jid)
        rest = parts[1:]
        if not rest:
            if method == "GET":
                return self.ok(self.job_view(job))
            if method == "DELETE":
                self.jobs.pop(jid)
                self.job_files.pop(jid, None)
                return self.ok({"deleted": jid})
            if method == "PATCH":
                for k in ("name", "tags"):
                    if k in (body or {}):
                        job[k] = body[k]
                return self.ok(self.job_view(job))
        if method == "POST" and rest in (["pause"], ["resume"], ["cancel"]):
            job["status"] = {"pause": "paused", "resume": "running", "cancel": "cancelled"}[rest[0]]
            return self.ok(self.job_view(job))
        if method == "GET" and rest == ["files"]:
            if job["status"] != "done":
                return self.ok([])
            return self.ok([self.file_rows(n_, c, job["request"]) for n_, c in self.job_files[jid].items()])
        if method == "GET" and len(rest) == 2 and rest[0] == "files":
            content = self.job_files.get(jid, {}).get(rest[1])
            if content is None:
                return self.fake.problem(404, "NOT_FOUND", "No such file.")
            return 200, Raw(self.tamper.get(rest[1], content))
        return self.nf("route")

    # ── datasets ──

    def datasets_route(self, method: str, parts: List[str], q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        if not parts:
            rows = [{k: v for k, v in d.items() if k != "files"} for d in self.datasets.values() if not q.get("tag") or q["tag"] in d["tags"]]  # the list has no files
            return self.ok(rows)
        d = self.datasets.get(parts[0])
        if d is None:
            return self.fake.problem(404, "NOT_FOUND", "No dataset %s." % parts[0])
        if method == "GET" and len(parts) == 1:
            return self.ok(d)
        if method == "PATCH" and len(parts) == 1:
            new = (body or {}).get("name")
            if "tags" in (body or {}):
                d["tags"] = body["tags"]
            if "title" in (body or {}):
                d["title"] = body["title"]
            unknown = set(body or {}) - {"name", "tags", "title"}
            if unknown:
                return self.fake.problem(400, "VALIDATION_FAILED", 'Unrecognized key: "%s"' % sorted(unknown)[0])
            if new:
                self.datasets.pop(d["name"])
                d["name"] = new
                self.datasets[new] = d
            return self.ok(d)
        if method == "POST" and parts[1:] == ["update"]:
            jid = self._id("dl")
            req = {"symbols": sorted({f["symbol"] for f in d["files"]}), "intervals": sorted({f["interval"] for f in d["files"]}), "dataset": d["name"], "from": max(f["lastBar"] for f in d["files"])}
            job = {"id": jid, "name": "update " + d["name"], "status": "queued", "request": req, "tags": [], "dataClass": d["dataClass"], "source": d["source"], "official": d["official"], "delaySec": d["delaySec"],
                   "createdAt": "2026-11-09T10:10:00+05:30", "manifestUrl": "/v1/downloads/%s/files" % jid, "items": [{"symbol": s, "interval": iv, "status": "queued"} for s in req["symbols"] for iv in req["intervals"]], "notes": []}
            self.jobs[jid] = job
            return self.ok(dict(job, progress={"total": len(job["items"]), "done": 0, "failed": 0, "rows": 0, "bytes": 0, "etaSec": None, "current": None}), 202)
        return self.nf("route")

    # ── recordings and rules ──

    def recordings_route(self, method: str, parts: List[str], q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        if parts[:1] == ["rules"]:
            return self.rules_route(method, parts[1:], body)
        if parts == ["settings"]:
            return self.settings_route(method, self.rec_settings, body, ("maxBudgetShare",))
        if parts == ["status"] and method == "GET":
            running = [r for r in self.recordings.values() if r["status"] in ("running", "recording")]
            rows = sum(r["rows"] for r in self.recordings.values())
            return self.ok({"line": "Recording today: %d recordings, %d rows." % (len(running), rows) if running else "Recording is off. Nothing is being saved.", "enabled": True,
                            "auto": {"enabled": self.auto_on, "rules": len(self.rules), "activeRules": len(self.rules) if self.auto_on else 0},
                            "today": {"date": "2026-11-09", "recordings": len(running), "rules": 0, "manual": len(running), "symbols": 0, "rows": rows, "bytes": rows * 40, "lastWriteAt": None, "gaps": 0, "openGaps": 0},
                            "recordings": {"total": len(self.recordings), "running": len(running)}, "disk": {"usedBytes": rows * 40, "limitMb": 5000}, "apiCalls": {"made": 0, "saved": 7},
                            "budgetShare": self.rec_settings["maxBudgetShare"], "dataClass": "realtime"})
        if parts == ["presets"] and method == "GET":
            return self.ok([{"id": "index-option-chains", "title": "Record index option chains", "about": "NIFTY and BANKNIFTY option chains.", "needs": "a connected broker login",
                             "rule": {"name": "Index option chains", "kind": "chain", "underlying": ["NIFTY", "BANKNIFTY"], "everySec": 30, "schedule": "market-hours", "format": "csv"}},
                            {"id": "my-watchlist", "title": "Record my watchlist", "about": "Every symbol of your watchlist.", "needs": "a collection called watchlist",
                             "rule": {"name": "My watchlist", "kind": "quotes", "collection": "watchlist", "everySec": 1, "schedule": "market-hours", "format": "csv"}}])
        if len(parts) == 3 and parts[0] == "presets" and parts[2] == "apply" and method == "POST":
            if parts[1] not in ("index-option-chains", "my-watchlist"):
                return self.nf("preset")
            existing = next((r for r in self.rules.values() if r.get("preset") == parts[1]), None)
            rule = existing or dict({"name": parts[1], "kind": "chain" if parts[1].startswith("index") else "quotes", "everySec": 30, "schedule": "market-hours", "preset": parts[1],
                                     "collection": (body or {}).get("collection", "watchlist") if parts[1] == "my-watchlist" else None}, id=self._id("rule"), enabled=True)
            self.rules[rule["id"]] = rule
            self.auto_on = True
            return self.ok({"preset": parts[1], "created": existing is None, "rule": rule, "auto": {"enabled": True, "rules": len(self.rules), "activeRules": len(self.rules)}}, 200 if existing else 201)
        if not parts:
            if method == "POST":
                b = dict(body or {})
                if b.get("everySec", 0) < (15 if b.get("kind") == "chain" else 1):
                    return self.fake.problem(400, "VALIDATION_FAILED", "everySec is too small")
                rid = self._id("rec")
                target = {k: b[k] for k in ("symbols", "collection", "underlying", "expiry") if b.get(k)}
                n = len(b.get("symbols") or [])
                rec = {"id": rid, "name": b.get("name") or rid, "kind": b["kind"], "status": "recording", "statusText": "Recording.", "auto": False, "ruleId": None, "target": target,
                       "everySec": b["everySec"], "sessionOnly": b.get("sessionOnly", True), "schedule": "market-hours", "format": b.get("format", "csv"), "createdAt": "2026-11-09T10:00:00.000+05:30",
                       "dataClass": "realtime", "delaySec": 0, "source": "this Bridge's own live feed and broker reads (real-time class only; delayed and end-of-day data is refused)",
                       "symbols": {"count": n, "sample": (b.get("symbols") or [])[:5], "resolvedAt": None, "rule": None, "via": None, "notes": [], "stale": False, "problem": None, "onLiveFeed": n, "notOnLiveFeed": 0},
                       "rows": 0, "bytes": 0, "today": {"date": None, "rows": 0, "bytes": 0, "gaps": 0}, "lastWriteAt": None, "gaps": {"total": 0, "today": 0, "open": None},
                       "refused": {"total": 0, "last": None}, "apiCalls": {"madeToday": 0, "savedToday": 0},
                       "disk": {"usedBytes": 0, "limitMb": None, "totalUsedBytes": 0, "totalLimitMb": 5000, "blocked": None}, "keepDays": None, "nextStartAt": None, "issue": None, "filesUrl": "/v1/recordings/%s/files" % rid}
                self.recordings[rid] = rec
                self.emit("recording.started", {"id": rid})
                return self.ok(rec, 201)
            return self.ok([r for r in self.recordings.values() if not q.get("status") or r["status"] == q["status"]])
        rec = self.recordings.get(parts[0])
        if rec is None:
            return self.fake.problem(404, "NOT_FOUND", "No recording %s." % parts[0])
        rest = parts[1:]
        if not rest and method == "GET":
            return self.ok(rec)
        if not rest and method == "DELETE":
            self.recordings.pop(parts[0])
            return self.ok({"deleted": parts[0]})
        if method == "POST" and rest in (["pause"], ["resume"], ["stop"]):
            rec["status"] = {"pause": "paused", "resume": "recording", "stop": "stopped"}[rest[0]]
            if rest[0] == "stop":
                self.emit("recording.stopped", {"id": rec["id"]})
            return self.ok(rec)
        if method == "GET" and rest == ["files"]:
            return self.ok([self.rec_file(rec)])
        if method == "GET" and len(rest) == 2 and rest[0] == "files":
            return 200, Raw(self.rec_bytes(rec))
        return self.nf("route")

    def rec_bytes(self, rec: Dict[str, Any]) -> bytes:
        sym = (rec["target"].get("symbols") or ["NSE:X"])[0]
        return ("time,symbol,ltp\n2026-11-09T09:15:00+05:30,%s,100.5\n2026-11-09T09:15:30+05:30,%s,100.75\n" % (sym, sym)).encode()

    def rec_file(self, rec: Dict[str, Any]) -> Dict[str, Any]:
        b = self.rec_bytes(rec)
        return {"name": "%s_2026-11-09.csv" % rec["id"], "day": "2026-11-09", "rows": 2, "bytes": len(b), "sha256": sha(b)}

    def rules_route(self, method: str, parts: List[str], body: Any) -> Tuple[int, Any]:
        if not parts:
            if method == "POST":
                b = dict(body or {})
                if not b.get("name") or not b.get("kind"):
                    return self.fake.problem(400, "VALIDATION_FAILED", "name and kind are required")
                rid = self._id("rule")
                rule = dict(b, id=rid, enabled=b.get("enabled", True))
                self.rules[rid] = rule
                return self.ok(rule, 201)
            return self.ok(list(self.rules.values()))
        rule = self.rules.get(parts[0])
        if rule is None:
            return self.fake.problem(404, "NOT_FOUND", "No rule %s." % parts[0])
        if method == "PATCH":
            rule.update(body or {})
            return self.ok(rule)
        if method == "DELETE":
            self.rules.pop(parts[0])
            return self.ok({"deleted": parts[0]})
        return self.ok(rule)

    # ── collections ──

    def collections_route(self, method: str, parts: List[str], q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        if not parts:
            if method == "POST":
                b = dict(body or {})
                if not b.get("name"):
                    return self.fake.problem(400, "VALIDATION_FAILED", "name is required")
                if b["name"] in self.collections:
                    return self.fake.problem(409, "STATE_CONFLICT", "A collection called %s exists." % b["name"])
                c = {"id": self._id("col"), "name": b["name"], "description": b.get("description"), "tags": b.get("tags") or [], "kind": b.get("kind", "static"), "symbols": b.get("symbols") or [], "universe": b.get("universe"),
                     "updatedAt": "2026-11-09T10:00:00+05:30"}
                self.collections[b["name"]] = c
                return self.ok(c, 201)
            rows = [c for c in self.collections.values() if (not q.get("tag") or q["tag"] in c["tags"]) and (not q.get("kind") or c["kind"] == q["kind"])]
            return self.ok(rows)
        name = parts[0]
        c = self.collections.get(name)
        if c is None:
            return self.fake.problem(404, "NOT_FOUND", "No collection %s." % name)
        rest = parts[1:]
        if not rest and method == "GET":
            return self.ok(c)
        if not rest and method == "PATCH":
            b = dict(body or {})
            new = b.pop("name", None)
            c.update(b)
            if new:
                self.collections.pop(name)
                c["name"] = new
                self.collections[new] = c
            return self.ok(c)
        if not rest and method == "DELETE":
            self.collections.pop(name)
            return self.ok({"deleted": name})
        if rest == ["resolve"]:
            syms, info = self.resolve_symbols(name)
            out = dict({"name": name, "symbols": syms, "resolvedAt": "2026-11-09T10:00:00+05:30"}, **info)
            if c["kind"] == "option-universe":
                out["atmSource"] = "stream"
            if c["kind"] == "option-universe" and self.atm_delayed == "delayed":
                return self.fake.problem(422, "VALIDATION_FAILED", "The underlying price is delayed: an ATM from it would be wrong.")
            if c["kind"] == "option-universe" and self.atm_delayed == "stale":
                if q.get("allowStale") != "1":
                    return self.fake.problem(503, "UPSTREAM_ERROR", "The underlying price is stale.")
                out["warnings"] = ["The underlying price is stale (45 s old); ATM may have moved."]
                out["atmSource"] = "cache"
                out["freshness"] = {"source": "cache", "class": "realtime", "delaySec": 0, "official": True, "stale": True, "ageMs": 45000}
            return self.ok(out)
        if rest == ["usage"]:
            used = [j["id"] for j in self.jobs.values() if j["request"].get("collection") == name]
            return self.ok({"downloads": used, "recordings": [], "datasets": []})
        if rest == ["estimate"]:
            syms, _ = self.resolve_symbols(name)
            days = int(q.get("days") or 1)
            n = len(syms) * max(1, len((q.get("intervals") or "5m").split(","))) * days
            return self.ok({"symbols": len(syms), "rows": n * 75, "bytes": n * 75 * 40, "brokerCalls": n // 30 + 1})
        return self.nf("route")

    # ── subscriptions ──

    def subs_route(self, method: str, parts: List[str], q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        if not parts:
            if method == "POST":
                b = dict(body or {})
                sid = self._id("sub")
                s = {"id": sid, "url": b["url"], "topics": b["topics"], "active": b.get("active", True), "label": b.get("label"), "host": "example.org", "state": "unverified"}
                self.subs[sid] = dict(s, secret=b.get("secret"))
                return self.ok(s, 201)
            return self.ok([{k: v for k, v in s.items() if k != "secret"} for s in self.subs.values()])
        s = self.subs.get(parts[0])
        if s is None:
            return self.fake.problem(404, "NOT_FOUND", "No subscription.")
        if method == "PATCH" and len(parts) == 1:
            s.update(body or {})
            return self.ok({k: v for k, v in s.items() if k != "secret"})
        if method == "DELETE" and len(parts) == 1:
            self.subs.pop(parts[0])
            return self.ok({"deleted": parts[0]})
        if method == "POST" and parts[1:] == ["test"]:
            return self.ok({"delivered": True, "status": 200})
        if method == "GET" and parts[1:] == ["deliveries"]:
            rows = [{"id": "d1", "outcome": "delivered", "attempts": 1, "status": 200}, {"id": "d2", "outcome": "dead", "attempts": 8, "status": 503}]
            return self.ok([r for r in rows if not q.get("outcome") or r["outcome"] == q["outcome"]])
        if method == "GET" and len(parts) == 1:
            return self.ok({k: v for k, v in s.items() if k != "secret"})
        if parts[1:2] == ["dead-letters"]:
            dead = self.dead.setdefault(parts[0], [{"id": "del_1", "eventId": "7", "topic": "download.done", "reason": "http_5xx"}, {"id": "del_2", "eventId": "8", "topic": "download.failed", "reason": "timeout"}])
            if method == "GET" and len(parts) == 2:
                return self.ok(list(dead))
            if method == "DELETE" and len(parts) == 2:
                n = len(dead)
                dead.clear()
                return self.ok({"removed": n})
            if method == "POST" and len(parts) == 4 and parts[3] == "retry":
                hit = [d for d in dead if d["id"] == parts[2]]
                if not hit:
                    return self.fake.problem(404, "NOT_FOUND", "No such dead letter.")
                dead.remove(hit[0])
                return self.ok({"id": parts[2], "queued": True}, 202)
        return self.nf("route")

    # ── events ──

    def event_stream(self, q: Dict[str, str], headers: Any) -> Tuple[int, Any]:
        if self.sse_fail_first > 0:
            self.sse_fail_first -= 1
            return self.fake.problem(503, "BROKER_UNAVAILABLE", "events are starting up")
        since = q.get("since") or (headers.get("Last-Event-ID") if headers else None)
        topics = [t for t in (q.get("topics") or "").split(",") if t]
        latest = len(self.events)
        gap, reason = False, None
        if since is not None and int(since) > latest:
            gap, reason = True, "cursor_ahead"
        if since is not None and self.events_oldest > 1 and int(since) < self.events_oldest - 1:
            gap, reason = True, "retention"
        ready = {"cursor": str(latest), "oldest": str(self.events_oldest), "replayed": 0, "gap": gap, "gapReason": reason, "topics": topics or ["*"]}
        out: List[bytes] = [("event: ready\ndata: %s\n\n" % json.dumps(ready)).encode()]
        sent = 0
        for ev in self.events:
            if since is not None and int(ev["id"]) <= int(since):
                continue
            if topics and not any(t == ev["topic"] or (t.endswith(".*") and ev["topic"].startswith(t[:-1])) or t == "*" for t in topics):
                continue
            out.append(("id: %s\nevent: %s\ndata: %s\n\n" % (ev["id"], ev["topic"], json.dumps(ev))).encode())
            sent += 1
            if self.sse_drop_after is not None and sent >= self.sse_drop_after:
                break
            out.append(b": heartbeat\n\n")
        return 200, Frames(out)

    def events_poll(self, q: Dict[str, str]) -> Tuple[int, Any]:
        since = q.get("since")
        topics = [t for t in (q.get("topics") or "").split(",") if t]
        rows = [e for e in self.events if (since is None or int(e["id"]) > int(since)) and (not topics or any(t == "*" or t == e["topic"] or (t.endswith(".*") and e["topic"].startswith(t[:-1])) for t in topics))]
        rows = rows[: int(q.get("limit") or 100)]
        gap = since is not None and int(since) > len(self.events)
        return self.ok(rows, cursor=rows[-1]["id"] if rows else (since or str(len(self.events))), latest=str(len(self.events)), gap=gap, gapReason="cursor_ahead" if gap else None, hasMore=False)

    # ── history ──

    def history(self, q: Dict[str, str]) -> Tuple[int, Any]:
        sym = q["symbol"]
        a, b = int(float(q["from"])), int(float(q["to"]))
        self.history_log.append({"from": a, "to": b, "localFirst": q.get("localFirst"), "dataset": q.get("dataset")})
        series = [c for c in self.history_series[sym] if a <= c["time"] <= b]
        partial = False
        if self.history_max_days is not None and (b - a) > self.history_max_days * DAY:
            keep_from = b - int(self.history_max_days * DAY)
            series = [c for c in series if c["time"] >= keep_from]
            partial = True
        source = "broker"
        fr = {"source": "broker", "asOf": "2026-11-09T10:00:00.000+05:30", "ageMs": 12, "stale": False, "class": "realtime", "delaySec": 0, "official": True, "confidence": "high", "flags": []}
        if q.get("localFirst") == "true" and self.local_range:
            l0, l1 = self.local_range
            if a >= l0 and b <= l1:
                source = "local"
            elif b >= l0 and a <= l1:
                source = "mixed"
            if source != "broker":
                fr = dict(fr, source="local")
        if q.get("backup") == "true":
            fr = dict(fr, source="backup", **{"class": "delayed", "delaySec": 900, "official": False, "confidence": "low"})
        return 200, {"data": {"symbol": sym, "interval": q["interval"], "candles": series, "freshness": fr, "partial": partial}, "meta": {"requestId": "req_h", "source": source}}
