"""Build, check, sign and test alert messages for a Bridge hook (PROVISIONAL).

Status: the alert message format of a ``generic`` hook is the JSON in ``docs/guides/webhooks.md`` (``symbol``, ``side``,
``quantity`` or ``lots``, ``price``, ``orderType``, ``product``, ``id``, ``time``), and a newer Bridge may extend it.
This module is deliberately small and follows that document; ``ALERT_SCHEMA_STATUS`` says so in code. When the
Bridge's OpenAPI defines the message, trust that and update this file.

    msg = AlertMessage(symbol="NSE:RELIANCE", side="BUY", lots=1, price=1402.5, id="brk-0001")
    msg.problems()                         # [] when it is well formed
    print(msg.to_json())                   # paste into a TradingView alert's message box
    check_against_hook(msg, hook)          # would this hook accept it? (no network)
    bridge.hooks.test(hook_id, msg)        # the Bridge's own dry run, on a Bridge that has the route
    send(hook_url, msg, secret=SECRET)     # posts it for real: a PAPER hook places a paper order

Placeholders such as ``{{close}}`` or ``{{ticker}}`` in any value are passed through untouched (a charting site fills
them in), and are skipped by the local checks.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Union

ALERT_SCHEMA_STATUS = "provisional"

_SYMBOL_RE = re.compile(r"^[A-Za-z]{2,5}:[A-Za-z0-9&._-]+$")
_PLACEHOLDER = re.compile(r"\{\{.*\}\}")


def _ph(v: Any) -> bool:
    return isinstance(v, str) and bool(_PLACEHOLDER.search(v))


@dataclass
class AlertMessage:
    """One alert for a ``generic`` hook. Give ``quantity`` or ``lots`` (not both); ``price`` for LIMIT hooks."""

    symbol: str
    side: Optional[str] = None
    quantity: Optional[Union[int, str]] = None
    lots: Optional[Union[int, str]] = None
    price: Optional[Union[float, str]] = None
    order_type: Optional[str] = None
    product: Optional[str] = None
    id: Optional[str] = None
    """Same-day de-duplication: reusing an id never creates a second order."""
    time: Optional[str] = None
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"symbol": self.symbol}
        for wire, v in (("side", self.side), ("quantity", self.quantity), ("lots", self.lots), ("price", self.price), ("orderType", self.order_type), ("product", self.product), ("id", self.id), ("time", self.time)):
            if v is not None:
                d[wire] = v
        d.update(self.extra)
        return d

    def to_json(self, indent: Optional[int] = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)

    def problems(self, *, limit_needs_price: bool = False) -> List[str]:
        """Things wrong with the message by itself (empty list when fine). ``limit_needs_price``: the hook places LIMIT orders."""
        out: List[str] = []
        if not _ph(self.symbol) and not _SYMBOL_RE.match(self.symbol or ""):
            out.append("symbol %r is not in the form EXCHANGE:NAME (for example NSE:RELIANCE)" % self.symbol)
        if self.side is not None and not _ph(self.side) and self.side.upper() not in ("BUY", "SELL"):
            out.append("side must be BUY or SELL")
        if self.quantity is not None and self.lots is not None:
            out.append("give quantity or lots, not both")
        if self.quantity is None and self.lots is None:
            out.append("give quantity or lots")
        for name in ("quantity", "lots"):
            v = getattr(self, name)
            if v is not None and not _ph(v) and (not isinstance(v, int) or isinstance(v, bool) or v < 1):
                out.append("%s must be a whole number of 1 or more" % name)
        if self.price is not None and not _ph(self.price) and (isinstance(self.price, bool) or not isinstance(self.price, (int, float)) or self.price <= 0):
            out.append("price must be a number above 0")
        if (limit_needs_price or (self.order_type or "").upper() == "LIMIT") and self.price is None:
            out.append("a LIMIT alert must carry a price")
        if self.id is not None and not _ph(self.id) and not re.match(r"^[A-Za-z0-9_.:-]{1,64}$", self.id):
            out.append("id may use letters, digits and _ . : - only (up to 64)")
        return out


def check_against_hook(message: Union[AlertMessage, Mapping[str, Any]], hook: Mapping[str, Any]) -> List[str]:
    """Would ``hook`` (a dict from ``bridge.hooks.list()``) accept this message? Local check, nothing is sent.

    Mirrors the rules the Bridge documents for hooks (fixed side, allowed symbols, lot cap, LIMIT needs a price). The
    Bridge's own answer is final: use ``bridge.hooks.test`` where it exists.
    """
    m = message.to_dict() if isinstance(message, AlertMessage) else dict(message)
    out: List[str] = []
    allowed = hook.get("allowedSymbols") or []
    if allowed and m.get("symbol") not in allowed and not _ph(m.get("symbol")):
        out.append("%s is not in the hook's allowedSymbols" % m.get("symbol"))
    fixed = hook.get("side")
    if fixed and m.get("side") and not _ph(m.get("side")) and str(m["side"]).upper() != fixed:
        out.append("the hook is fixed to %s but the alert says %s" % (fixed, m["side"]))
    cap = hook.get("maxLotsPerSignal")
    lots = m.get("lots", m.get("quantity"))
    if cap and isinstance(lots, int) and lots > cap:
        out.append("%d is more than the hook's maxLotsPerSignal (%d); it would be refused, not trimmed" % (lots, cap))
    if hook.get("orderType") == "LIMIT" and m.get("price") is None:
        out.append("this hook places LIMIT orders, so the alert needs a price")
    if not hook.get("product") and not m.get("product"):
        out.append("the hook has no product, so the alert must carry one")
    return out


def sign(secret: str, body: Union[str, bytes], *, t: Optional[int] = None) -> str:
    """The ``X-MCB-Signature`` header value for a signed ``generic`` hook: ``t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>``."""
    raw = body.encode("utf-8") if isinstance(body, str) else body
    ts = str(int(time.time()) if t is None else int(t))
    mac = hmac.new(secret.encode("utf-8"), ts.encode("ascii") + b"." + raw, hashlib.sha256).hexdigest()
    return "t=%s,v1=%s" % (ts, mac)


@dataclass(frozen=True)
class AlertReply:
    status: int
    body: Any

    @property
    def accepted(self) -> bool:
        return self.status == 202 and isinstance(self.body, dict) and bool(self.body.get("accepted"))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a: Any, **k: Any) -> None:  # type: ignore[override]
        return None


def send(hook_url: str, message: Union[AlertMessage, Mapping[str, Any], str], *, secret: Optional[str] = None, timeout: float = 10.0) -> AlertReply:
    """POST an alert to a hook URL, exactly as an alert service would.

    **This is a real alert**: a hook places an order (a paper order on a paper hook, a live one on a live hook, or waits
    for your approval when it asks for confirmation). Use ``bridge.hooks.test`` for a dry run where the Bridge has it.
    ``secret`` is the hook's ``signingSecret`` (needed for ``generic`` hooks). The URL holds the hook's secret token:
    do not log it.
    """
    if isinstance(message, str):
        body = message.encode("utf-8")
        ctype = "text/plain"
        try:
            json.loads(message)
            ctype = "application/json"
        except ValueError:
            pass
    else:
        d = message.to_dict() if isinstance(message, AlertMessage) else dict(message)
        body = json.dumps(d).encode("utf-8")
        ctype = "application/json"
    headers = {"Content-Type": ctype, "User-Agent": "mrchartist-bridge-python"}
    if secret:
        headers["X-MCB-Signature"] = sign(secret, body)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    req = urllib.request.Request(hook_url, data=body, headers=headers, method="POST")
    try:
        with opener.open(req, timeout=timeout) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
        e.close()
    try:
        parsed: Any = json.loads(raw.decode("utf-8")) if raw else None
    except ValueError:
        parsed = raw.decode("utf-8", errors="replace")
    return AlertReply(status, parsed)
