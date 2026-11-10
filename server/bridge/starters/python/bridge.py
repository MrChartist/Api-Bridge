"""A small client for the Bridge. Standard library only: Python 3.9 or newer, nothing to install.

What it does for you
  - reads BRIDGE_URL and BRIDGE_KEY from .env (or the environment); the key goes in the Authorization header only
  - turns an error answer (application/problem+json) into a BridgeError with code, retryable and request_id
  - retries what is safe to retry (reads, and writes that carry an idempotency key) on 429 and temporary failures,
    waiting as long as the Bridge says (Retry-After), at most 3 times
  - optional(): a call that tolerates an older Bridge that does not have the route yet

The mrchartist_bridge package in the Bridge's sdk/python folder is a fuller client (typed candles, streaming, data
frames). This file is enough to start and shows what a request looks like.
"""
import json
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# Routes a newer Bridge has and an older one answers with these codes.
MISSING = {"NOT_FOUND", "NOT_IMPLEMENTED", "METHOD_NOT_ALLOWED"}


def load_env(path=os.path.join(HERE, ".env")):
    """KEY=value lines of a .env file; the environment wins over the file."""
    out = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip("'\"")
    except OSError:
        pass
    out.update({k: v for k, v in os.environ.items() if k.startswith(("BRIDGE_", "MCB_"))})
    return out


class BridgeError(Exception):
    """An error answer from the Bridge. `code` is stable: branch on it, never on the message."""

    def __init__(self, problem, status):
        super().__init__(problem.get("detail") or problem.get("title") or f"The Bridge answered {status}")
        self.status = status
        self.code = problem.get("code", "UNKNOWN")
        self.retryable = problem.get("retryable") is True
        self.request_id = problem.get("requestId")
        self.retry_after_ms = problem.get("retryAfterMs")
        self.errors = problem.get("errors") or []
        self.problem = problem

    @property
    def missing(self):
        return self.code in MISSING


class Bridge:
    def __init__(self, base_url=None, key=None, max_retries=3):
        env = load_env()
        self.base_url = (base_url or env.get("BRIDGE_URL") or "http://127.0.0.1:4300").rstrip("/")
        self.key = key if key is not None else env.get("BRIDGE_KEY", "")
        self.max_retries = max_retries

    def _headers(self, extra=None):
        if not self.key:
            raise RuntimeError("No API key. Put BRIDGE_KEY=mcb_... in .env (make one with: mc-bridge keys create --label my-script --scope read).")
        return {"Authorization": f"Bearer {self.key}", "Accept": "application/json", **(extra or {})}

    def request(self, method, path, query=None, body=None, idempotency_key=None, timeout=30):
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        headers = self._headers()
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        # A read can always be repeated. A write only with an idempotency key, so a repeat can never act twice.
        may_retry = method == "GET" or bool(idempotency_key)
        attempt = 0
        while True:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as res:
                    text = res.read().decode()
                    answer = json.loads(text) if text else {}
                    answer["_http_status"] = res.status
                    return answer
            except urllib.error.HTTPError as e:
                text = e.read().decode()
                try:
                    problem = json.loads(text)
                except ValueError:
                    problem = {"title": text[:200]}
                err = BridgeError(problem if isinstance(problem, dict) else {}, e.code)
                temporary = err.retryable or e.code in (502, 503, 504)
                if may_retry and temporary and err.code != "OUTCOME_UNKNOWN" and attempt < self.max_retries:
                    header = e.headers.get("Retry-After")
                    wait = err.retry_after_ms / 1000 if err.retry_after_ms else (float(header) if header else backoff(attempt))
                    time.sleep(wait)
                    attempt += 1
                    continue
                raise err from None
            except (urllib.error.URLError, TimeoutError) as e:
                if may_retry and attempt < self.max_retries:
                    time.sleep(backoff(attempt))
                    attempt += 1
                    continue
                raise RuntimeError(f"Could not reach the Bridge at {self.base_url}. Is it running? ({e})") from None

    def get(self, path, query=None, **kw):
        return self.request("GET", path, query=query, **kw)

    def post(self, path, body=None, **kw):
        return self.request("POST", path, body=body, **kw)

    def optional(self, method, path, **kw):
        """Like request(), but returns None when this Bridge does not have the route (an older Bridge)."""
        try:
            return self.request(method, path, **kw)
        except BridgeError as e:
            if e.missing:
                return None
            raise

    def events(self, path, query=None, seconds=20):
        """Server-sent events as (id, event, data) tuples, for at most `seconds`. Raises BridgeError if the route is missing."""
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        req = urllib.request.Request(url, headers=self._headers({"Accept": "text/event-stream"}))
        deadline = time.time() + seconds
        try:
            res = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as e:
            try:
                problem = json.loads(e.read().decode())
            except ValueError:
                problem = {}
            raise BridgeError(problem, e.code) from None
        with res:
            cur = {}
            while time.time() < deadline:
                try:
                    raw = res.readline()
                except (TimeoutError, OSError):
                    continue  # a quiet stream: keep waiting until the deadline
                if not raw:
                    return
                line = raw.decode().rstrip("\r\n")
                if line == "":
                    if "data" in cur:
                        yield cur.get("id"), cur.get("event", "message"), cur["data"]
                    cur = {}
                elif not line.startswith(":"):
                    field, _, value = line.partition(":")
                    value = value[1:] if value.startswith(" ") else value
                    cur[field] = f"{cur['data']}\n{value}" if field == "data" and "data" in cur else value


def backoff(attempt):
    """0.5 s, 1 s, 2 s ... with some randomness, so many scripts do not come back in the same moment."""
    return 0.5 * 2**attempt * (0.75 + random.random() * 0.5)


def explain(err):
    """An error the way a person needs it: what happened, the code, and the request id to quote."""
    if isinstance(err, BridgeError):
        lines = [f"{err.code}: {err}"]
        lines += [f"  - {e.get('path')}: {e.get('message')}" for e in err.errors]
        if err.code == "UNAUTHENTICATED":
            lines.append("  Check BRIDGE_KEY in .env (a key is shown once; make a new one if it was lost).")
        if err.code == "SCOPE_REQUIRED":
            lines.append("  This key may not do that. Make a key with the scope the route needs (see Developers in the dashboard).")
        if err.request_id:
            lines.append(f"  request id: {err.request_id}")
        return "\n".join(lines)
    return str(err)
