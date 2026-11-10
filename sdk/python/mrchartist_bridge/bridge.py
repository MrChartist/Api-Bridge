"""``Bridge``: connect in one line, get typed answers.

    from mrchartist_bridge import Bridge

    bridge = Bridge()                              # URL and key found for you (arguments, environment, local files)
    print(bridge.ping())                           # Ping(ok=True, latency_ms=3.1, ...)
    nifty = bridge.price("NSE:NIFTY")              # Ltp(symbol=..., ltp=24820.4, freshness=Freshness(...))
    nifty.require_realtime()                       # raises NotRealtime for delayed, end-of-day or stale data
    order = bridge.orders.place("NSE:RELIANCE", "BUY", quantity=1, product="CNC", price=1400)   # paper
    bridge.orders.wait_for_fill(order)

``Bridge`` wraps the plain dict-returning ``BridgeClient`` (``bridge.client``): use that for any route this class has
no method for, or ``bridge.get("/v1/...")``. Standard library only.
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union

from .client import BridgeClient, Response
from .discovery import Settings, discover
from .errors import (
    BridgeApiError,
    BridgeConnectionError,
    ConfigurationError,
    FeatureUnavailable,
    NotFound,
    ScopeRequired,
    Unauthenticated,
    error_from_problem,
)
from .data import Collections, Datasets, Downloads, Recordings, SavedCalls, Subscriptions
from .events import Events
from .longhistory import HistoryIter
from .namespaces import Calendar, Hooks, Symbols, Xl
from .orders import Orders, Tickets
from .records import (
    IST,
    Account,
    Depth,
    Funds,
    Health,
    History,
    Holding,
    Ltp,
    Ping,
    Position,
    Quote,
    Result,
    Source,
    Trade,
    problems_from,
)

_KEY_PLACES = "the api_key argument, the MCB_API_KEY environment variable, MCB_API_KEY_FILE, or client.json in the Bridge folder (python -m mrchartist_bridge login)"


def _route_key(method: str, path: str) -> Tuple[str, str]:
    """Route identity that ignores the parameter names: ``/v1/orders/:orderId`` and ``/v1/orders/{id}`` are the same."""
    parts = []
    for seg in path.split("?")[0].split("/"):
        parts.append(":" if (seg.startswith(":") or (seg.startswith("{") and seg.endswith("}"))) else seg)
    return method.upper(), "/".join(parts)


class _Transport(BridgeClient):
    """A ``BridgeClient`` whose errors say how to fix themselves (it knows where the key came from)."""

    owner: Optional["Bridge"] = None

    def _explain(self, err: BridgeApiError, method: str, path: str) -> BridgeApiError:
        b = self.owner
        if b is None:
            return err
        s = b.settings
        if isinstance(err, Unauthenticated):
            if not self.has_api_key:
                return err.with_hint("No API key was found. Give one with %s. Create a key with: mc-bridge keys create --label py --scope read,paper" % _KEY_PLACES)
            return err.with_hint("The Bridge at %s did not accept the key from %s: check it is complete and not revoked, and that the URL is the right Bridge (mc-bridge keys list)." % (self.base_url, s.key_source))
        if isinstance(err, ScopeRequired):
            need = b._scope_of(method, path)
            if need:
                return err.with_hint("%s %s needs a key with the %r scope%s. Create one: mc-bridge keys create --label py --scope %s" % (method, path, need, " (and the call must come from the Bridge's own computer)" if need == "admin" else "", need))
            return err
        if type(err) is NotFound and path.startswith("/v1/"):
            f = b._get_features()
            if f is not None and f.serves(method, path):
                return err  # the route exists on this Bridge: it is the thing you asked for that is missing, and the error says which
            return err.with_hint("This Bridge has no %s %s. It may be older than this library: check bridge.features().bridge_version." % (method, path))
        return err


class Features:
    """What this Bridge serves (from ``GET /v1/meta``)."""

    def __init__(self, bridge_version: str, api_version: str, routes: Sequence[Mapping[str, Any]], brokers: Sequence[str] = ()) -> None:
        self.bridge_version = bridge_version
        self.api_version = api_version
        self.brokers = tuple(brokers)
        self._routes: Dict[Tuple[str, str], Optional[str]] = {_route_key(str(r.get("method")), str(r.get("path"))): r.get("scope") for r in routes}

    def has(self, method: str, path: str) -> bool:
        return _route_key(method, path) in self._routes

    def scope_of(self, method: str, path: str) -> Optional[str]:
        return self._routes.get(_route_key(method, path))

    def serves(self, method: str, path: str) -> bool:
        """Does a route of this Bridge match this real path (``/v1/collections/nope`` matches ``/v1/collections/:name``)?"""
        want = [x for x in path.split("?")[0].split("/") if x]
        for (m, pattern) in self._routes:
            if m != method.upper():
                continue
            have = [x for x in pattern.split("/") if x]
            if len(have) == len(want) and all(h == ":" or h == w for h, w in zip(have, want)):
                return True
        return False

    def __repr__(self) -> str:
        return "Features(bridge_version=%r, routes=%d)" % (self.bridge_version, len(self._routes))


class Bridge:
    """A connection to your local Bridge with typed results. See the module docstring.

    ``Bridge()`` needs no arguments: the URL and key are discovered (``mrchartist_bridge.discovery``). Nothing is
    sent until you call something, so creating one never fails on a missing key; the first call that needs a key says
    how to get one.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        *,
        account: Optional[str] = None,
        timeout: float = 15.0,
        max_retries: int = 2,
        retry_base: float = 0.25,
        settings: Optional[Settings] = None,
        client: Optional[BridgeClient] = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        env: Optional[Mapping[str, str]] = None,
    ) -> None:
        try:
            self.settings = settings or discover(base_url, api_key, account=account, env=env)
        except ValueError as e:
            raise ConfigurationError(str(e)) from e
        if client is None:
            t = _Transport(self.settings.base_url, self.settings.api_key, timeout=timeout, max_retries=max_retries, retry_base=retry_base, sleep=sleep)
            t.owner = self
            client = t
        self.client: BridgeClient = client
        self._account = account or self.settings.account
        self._sleep = sleep
        self._clock = clock
        self._features: Optional[Features] = None
        self._features_tried = False
        self._accounts_cache: Optional[List[Account]] = None
        self.orders = Orders(self)
        self.tickets = Tickets(self)
        self.symbols = Symbols(self)
        self.calendar = Calendar(self)
        self.hooks = Hooks(self)
        self.xl = Xl(self)
        self.downloads = Downloads(self)
        self.datasets = Datasets(self)
        self.recordings = Recordings(self)
        self.collections = Collections(self)
        self.subscriptions = Subscriptions(self)
        self.events = Events(self)

    # ── construction helpers ──

    @classmethod
    def demo(cls, base_url: Optional[str] = None, api_key: Optional[str] = None, **kw: Any) -> "Bridge":
        """Connect to a Bridge that must be in demo mode (``mc-bridge start --demo``: sample prices, no broker, orders
        paper only) and check it is. Raises ``ConfigurationError`` with the command to run when it is not running, or is
        a Bridge with real accounts. A key is still needed (``mc-bridge keys create --label demo --scope read,paper``)."""
        b = cls(base_url, api_key, **kw)
        try:
            h = b.health()
        except BridgeConnectionError as e:
            raise ConfigurationError("No demo Bridge at %s. Start one with: mc-bridge start --demo   (then create a key: mc-bridge keys create --label demo --scope read,paper)" % b.client.base_url) from e
        if not h.demo:
            raise ConfigurationError("The Bridge at %s is not in demo mode, so Bridge.demo() will not use it (it may hold real broker accounts). Use Bridge(...) for it, or start a demo Bridge on another port: MCB_PORT=4301 mc-bridge start --demo" % b.client.base_url)
        return b

    def __enter__(self) -> "Bridge":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        """Nothing to release today (every call opens its own connection); kept so ``with Bridge() as b:`` is future-proof."""

    def __repr__(self) -> str:
        return "Bridge(%r, key=%s)" % (self.client.base_url, "set" if self.client.has_api_key else "unset")

    # ── helpers shared with the namespaces ──

    def now(self) -> datetime:
        return datetime.now(IST)

    @property
    def base_url(self) -> str:
        return self.client.base_url

    def account_for(self, live: bool = False) -> str:
        """The account to use when the call names none: the ``account`` given to ``Bridge``, ``MCB_ACCOUNT``, or the only
        paper account (for a paper call) / the only live-enabled account (for a live call). Raises ``ConfigurationError``
        listing the choices when it cannot tell."""
        if self._account:
            return self._account
        accts = self.accounts_list()
        pool = [a for a in accts if a.enabled and a.live_allowed] if live else [a for a in accts if a.enabled and a.is_paper]
        if len(pool) == 1:
            return pool[0].id
        ids = ", ".join(a.id for a in accts) or "none"
        raise ConfigurationError("Say which account to use: pass account=... (Bridge(account=...) sets it for every call; or MCB_ACCOUNT). Accounts on this Bridge: %s." % ids)

    def accounts_list(self) -> List[Account]:
        if self._accounts_cache is None:
            self._accounts_cache = list(self.accounts())
        return self._accounts_cache

    def _scope_of(self, method: str, path: str) -> Optional[str]:
        f = self._get_features()
        return f.scope_of(method, path) if f else None

    # ── system ──

    def health(self) -> Health:
        """``GET /v1/health``: needs no key."""
        return Health.from_dict(self.client.health())

    def saved_calls(self) -> SavedCalls:
        """Broker calls the Bridge did not make today because the data was already stored, streamed, cached or shared
        (``GET /v1/limits?explain=1``, ``savedCalls``). ``total`` counts reads served from datasets and recordings;
        ``total_today`` adds the scheduler's own savings (stream, cache, shared calls)."""
        r = self.client.limits(explain=True)
        d = r.get("data") if isinstance(r, dict) and "data" in r else r
        return SavedCalls.from_dict(d.get("savedCalls") if isinstance(d, dict) else None)

    def ping(self, *, check_key: bool = True) -> Ping:
        """Is the Bridge up, how fast, and (with ``check_key``) does it accept the key? Raises a typed error with a fix."""
        t0 = time.perf_counter()
        h = self.health()
        ms = (time.perf_counter() - t0) * 1000.0
        authed: Optional[bool] = None
        if check_key:
            self.client.meta()  # needs a read key
            authed = True
        return Ping(h.ok, round(ms, 2), h.version, h.api_version, h.demo, self.client.base_url, authed)

    @property
    def is_demo(self) -> bool:
        return self.health().demo

    def features(self) -> Features:
        """The routes this Bridge serves (cached; ``refresh_features()`` reloads)."""
        f = self._get_features()
        if f is None:
            raise FeatureUnavailable("This Bridge's route list could not be read (GET /v1/meta needs a read key).")
        return f

    def refresh_features(self) -> Features:
        self._features = None
        self._features_tried = False
        return self.features()

    def _get_features(self) -> Optional[Features]:
        if self._features is None and not self._features_tried:
            self._features_tried = True  # set first: a 404 on /v1/meta itself asks for the features again while it explains the error
            try:
                d = self.client.meta()
                data = d.get("data", d) if isinstance(d, dict) else {}
                self._features = Features(str(data.get("bridgeVersion")), str(data.get("apiVersion")), data.get("routes") or [], data.get("brokers") or [])
            except (BridgeApiError, BridgeConnectionError):
                self._features = None
            self._features_tried = True
        return self._features

    def supports(self, method: str, path: str) -> Optional[bool]:
        """Does this Bridge serve the route? ``True`` or ``False``; ``None`` when it cannot be told (meta unreadable)."""
        f = self._get_features()
        return None if f is None else f.has(method, path)

    def require_route(self, method: str, path: str, what: str) -> None:
        """Raise ``FeatureUnavailable`` (a plain sentence) when the Bridge lacks the route."""
        if self.supports(method, path) is False:
            raise FeatureUnavailable("This Bridge does not have %s (%s %s). Update the Bridge (it is newer than the Bridge you run), or use the dict-based bridge.client." % (what, method, path), method=method, path=path)

    # ── raw access ──

    def get(self, path: str, **query: Any) -> Any:
        """``GET`` any route; returns the parsed body (the envelope for /v1 routes)."""
        return self.client.request("GET", path, query=query or None).body

    def post(self, path: str, body: Any = None) -> Any:
        return self.client.request("POST", path, body=body).body

    def request(self, method: str, path: str, **kw: Any) -> Response:
        return self.client.request(method, path, **kw)

    # ── accounts ──

    def accounts(self) -> Result[Account]:
        r = self.client.accounts()
        return Result([Account.from_dict(a) for a in r.get("data") or []], r.get("meta"), problems_from(r.get("errors")))

    # ── market data ──

    def ltp(self, symbols: Union[str, Sequence[str]], *, account: Optional[str] = None, max_age_ms: Optional[int] = None) -> Result[Ltp]:
        """Last prices of up to 200 symbols. Symbols that failed are in ``result.errors``; the rest are returned."""
        r = self.client.ltp(symbols, account=account, max_age_ms=max_age_ms)
        return Result([Ltp.from_dict(i) for i in r.get("data") or []], r.get("meta"), problems_from(r.get("errors")))

    def price(self, symbol: str, **kw: Any) -> Ltp:
        """The last price of one symbol (raises ``SymbolNotFound``-style errors if it cannot be had)."""
        res = self.ltp([symbol], **kw)
        if not len(res):
            e = res.errors[0] if res.errors else None
            raise error_from_problem({"status": 404, "code": e.code if e else "SYMBOL_NOT_FOUND", "detail": e.message if e else "No price for %s." % symbol})
        return res[0]

    def quotes(self, symbols: Union[str, Sequence[str]], *, account: Optional[str] = None, max_age_ms: Optional[int] = None) -> Result[Quote]:
        r = self.client.quotes(symbols, account=account, max_age_ms=max_age_ms)
        return Result([Quote.from_dict(i) for i in r.get("data") or []], r.get("meta"), problems_from(r.get("errors")))

    def quote(self, symbol: str, **kw: Any) -> Quote:
        res = self.quotes([symbol], **kw)
        if not len(res):
            e = res.errors[0] if res.errors else None
            raise error_from_problem({"status": 404, "code": e.code if e else "SYMBOL_NOT_FOUND", "detail": e.message if e else "No quote for %s." % symbol})
        return res[0]

    def depth(self, symbol: str, *, account: Optional[str] = None, max_age_ms: Optional[int] = None) -> Depth:
        return Depth.from_dict(self.client.depth(symbol, account=account, max_age_ms=max_age_ms)["data"])

    def history(self, symbol: str, interval: str, *, countback: Optional[int] = None, from_: Optional[Union[str, int]] = None, to: Optional[Union[str, int]] = None, account: Optional[str] = None,
                local_first: Optional[bool] = None, dataset: Optional[str] = None) -> History:
        """Candles (ascending) with their label. Needs ``countback``, or ``from_`` and ``to``. The data may be delayed or
        end-of-day when a free source served it: read ``history.freshness`` before using it for anything but analysis.
        ``local_first=True`` serves bars the Bridge already stored (``dataset="name"`` for one dataset) and asks the broker only for the rest."""
        r = self.client.history(symbol, interval, from_=from_, to=to, countback=countback, account=account, local_first=local_first, dataset=dataset)
        return History.from_dict(r["data"])

    def history_all(self, symbol: str, interval: str, from_: Any, to: Any = None, *, chunk_days: Optional[int] = None, local_first: bool = False, dataset: Optional[str] = None,
                    account: Optional[str] = None, backup: Optional[bool] = None) -> HistoryIter:
        """Candles over any length of time: iterate for typed ``Candle`` objects (oldest first, no duplicates), or call
        ``.to_dataframe()``, ``.to_history()``, ``.to_csv(path)``, ``.to_parquet(path)``. Windows that fit the Bridge's
        per-call limit are fetched one after another (nothing is fetched until you iterate). ``local_first=True`` reads
        what the Bridge already stored and fetches only the missing part, saving API calls. See ``mrchartist_bridge.longhistory``."""
        return HistoryIter(self, symbol, interval, from_, to, chunk_days=chunk_days, local_first=local_first, dataset=dataset, account=account, backup=backup)

    def expiries(self, underlying: str, *, exchange: Optional[str] = None, account: Optional[str] = None) -> List[str]:
        d = self.client.expiries(underlying, exchange=exchange, account=account).get("data") or {}
        return list(d.get("expiries") or [])

    def option_chain(self, underlying: str, expiry: str, *, strikes: Optional[int] = None, greeks: Optional[bool] = None, account: Optional[str] = None) -> Dict[str, Any]:
        """The option chain as the Bridge's dict (``rows``, ``freshness`` ...); a typed chain is not modelled yet."""
        return self.client.option_chain(underlying, expiry, strikes=strikes, greeks=greeks, account=account)["data"]

    # ── portfolio ──

    def positions(self, account: Optional[str] = None, *, mode: Optional[str] = None) -> Result[Position]:
        r = self.client.positions(account or self.account_for(mode == "live"), mode=mode)
        return Result([Position.from_dict(p) for p in r.get("data") or []], r.get("meta"), problems_from(r.get("errors")))

    def holdings(self, account: Optional[str] = None) -> Result[Holding]:
        r = self.client.holdings(account or self.account_for(True))
        return Result([Holding.from_dict(p) for p in r.get("data") or []], r.get("meta"), problems_from(r.get("errors")))

    def funds(self, account: Optional[str] = None, *, mode: Optional[str] = None) -> Funds:
        return Funds.from_dict(self.client.funds(account or self.account_for(mode == "live"), mode=mode)["data"])

    def trades(self, *, account: Optional[str] = None, mode: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None) -> Result[Trade]:
        r = self.client.trades(account=account, mode=mode, limit=limit, cursor=cursor)
        return Result([Trade.from_dict(t) for t in r.get("data") or []], r.get("meta"), problems_from(r.get("errors")))

    # ── sources ──

    def sources(self) -> Result[Source]:
        """Where market data comes from (your broker accounts, free providers, plugins) and how each is labelled."""
        r = self.client._get("/v1/sources")
        return Result([Source.from_dict(s) for s in r.get("data") or []], r.get("meta"), problems_from(r.get("errors")))

    # ── many symbols ──

    def ltp_many(self, symbols: Sequence[str], *, chunk: int = 200, pause: float = 0.0, **kw: Any) -> Result[Ltp]:
        """Prices of any number of symbols: split into requests of ``chunk`` (the Bridge allows 200), waiting when
        rate-limited (honouring ``Retry-After`` and ``RateLimited.scope``). See ``mrchartist_bridge.batching``."""
        from .batching import fetch_many

        return fetch_many(self, symbols, self.ltp, chunk=chunk, pause=pause, **kw)

    def quotes_many(self, symbols: Sequence[str], *, chunk: int = 200, pause: float = 0.0, **kw: Any) -> Result[Quote]:
        from .batching import fetch_many

        return fetch_many(self, symbols, self.quotes, chunk=chunk, pause=pause, **kw)

    # ── streaming ──

    def stream(self, symbols: Sequence[str] = (), *, mode: str = "ltp", orders: Union[bool, Sequence[str]] = False, **kw: Any) -> Any:
        """A live stream (see ``mrchartist_bridge.stream.BridgeStream``): reconnects, re-subscribes, detects gaps."""
        return self.client.stream(symbols, mode=mode, orders=orders, **kw)
