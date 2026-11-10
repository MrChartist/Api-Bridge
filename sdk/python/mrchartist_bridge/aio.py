"""``AsyncBridge``: the same API for ``asyncio`` programs and notebooks (standard library only).

    import asyncio
    from mrchartist_bridge import AsyncBridge

    async def main():
        async with AsyncBridge() as bridge:
            nifty, banknifty = await asyncio.gather(bridge.price("NSE:NIFTY"), bridge.price("NSE:BANKNIFTY"))
            async with bridge.stream(["NSE:NIFTY"]) as s:
                async for tick in s.events():
                    print(tick)
                    break

    asyncio.run(main())

How it works: each call runs the blocking ``Bridge`` method in a worker thread (``asyncio.to_thread``), so the event
loop is never blocked and there is no extra dependency. Up to ``max_concurrency`` calls run at once (default 8): the
Bridge shares its broker limits among everything that calls it, so a gather over thousands of symbols should go through
``ltp_many`` rather than a thousand parallel requests. Cancelling an awaiting task does not interrupt a call already on
the wire (its own timeout ends it). ``wait_for_fill`` and ``tickets.wait`` hold a worker thread for up to their timeout.

The stream is the same reconnecting stream as the synchronous one, read in a thread and handed to the loop through a
bounded queue (a slow consumer slows the socket, and the Bridge conflates ticks for it).
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Sequence, TypeVar, Union

from .bridge import Bridge
from .events import verify_signature
from .orders import BatchResult, TargetResult
from .records import Account, Depth, Funds, History, Holding, Ltp, Order, Ping, Position, Preview, Quote, Result, Source, TicketOutcome
from .stream import BridgeStream, StreamEvent, parse_event

T = TypeVar("T")


class _Base:
    def __init__(self, owner: "AsyncBridge") -> None:
        self._o = owner

    async def _call(self, fn: Callable[..., T], *a: Any, **kw: Any) -> T:
        return await self._o._call(fn, *a, **kw)


class AsyncOrders(_Base):
    """``bridge.orders`` for asyncio: same names and arguments as ``mrchartist_bridge.orders.Orders``."""

    @property
    def _s(self) -> Any:
        return self._o.sync.orders

    async def place(self, symbol: str, side: str, **kw: Any) -> Order:
        return await self._call(self._s.place, symbol, side, **kw)

    async def place_request(self, order: Dict[str, Any], **kw: Any) -> Order:
        return await self._call(self._s.place_request, order, **kw)

    async def preview(self, symbol: str, side: str, **kw: Any) -> Preview:
        return await self._call(self._s.preview, symbol, side, **kw)

    async def get(self, order_id: str) -> Order:
        return await self._call(self._s.get, order_id)

    async def list(self, **kw: Any) -> Result[Order]:
        return await self._call(self._s.list, **kw)

    async def cancel(self, order: Union[str, Order], **kw: Any) -> Order:
        return await self._call(self._s.cancel, order, **kw)

    async def modify(self, order: Union[str, Order], **kw: Any) -> Order:
        return await self._call(self._s.modify, order, **kw)

    async def cancel_all(self, **kw: Any) -> Dict[str, Any]:
        return await self._call(self._s.cancel_all, **kw)

    async def reconcile(self, client_order_id: str, **kw: Any) -> Optional[Order]:
        return await self._call(self._s.reconcile, client_order_id, **kw)

    async def wait_for_fill(self, order: Union[str, Order], timeout: float = 30.0, **kw: Any) -> Order:
        return await self._call(self._s.wait_for_fill, order, timeout, **kw)

    async def to_target(self, symbol: str, **kw: Any) -> TargetResult:
        return await self._call(self._s.to_target, symbol, **kw)

    async def batch(self, orders: Sequence[Dict[str, Any]], **kw: Any) -> BatchResult:
        return await self._call(self._s.batch, orders, **kw)


class AsyncTickets(_Base):
    """``bridge.tickets`` for asyncio (watching only; approval stays on the Bridge's computer)."""

    async def list(self, state: str = "open") -> List[Any]:
        return await self._call(self._o.sync.tickets.list, state)

    async def status(self, ticket: Any, **kw: Any) -> TicketOutcome:
        return await self._call(self._o.sync.tickets.status, ticket, **kw)

    async def wait(self, ticket: Any, timeout: float = 90.0, **kw: Any) -> TicketOutcome:
        return await self._call(self._o.sync.tickets.wait, ticket, timeout, **kw)


class AsyncNamespace(_Base):
    """Any synchronous namespace (``downloads``, ``datasets``, ``recordings`` and its ``rules``, ``collections``,
    ``subscriptions``) for asyncio: every method has the same name and arguments and is awaited (it runs in a worker
    thread). ``await bridge.downloads.wait(job)`` holds one worker thread until the job ends."""

    def __init__(self, owner: "AsyncBridge", ns: Any) -> None:
        super().__init__(owner)
        self._ns = ns

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        attr = getattr(self._ns, name)
        if hasattr(attr, "_b") and not callable(attr):
            return AsyncNamespace(self._o, attr)
        if callable(attr):
            async def call(*a: Any, **kw: Any) -> Any:
                return await self._call(attr, *a, **kw)

            call.__name__ = name
            call.__doc__ = getattr(attr, "__doc__", None)
            return call
        return attr


class AsyncEvents(_Base):
    """``bridge.events`` for asyncio: ``async for ev in bridge.events.subscribe(...)``; the signature helpers are plain functions."""

    def subscribe(self, topics: Union[str, Sequence[str], None] = None, since: Optional[str] = None, *, queue_size: int = 1000, **kw: Any) -> "AsyncStream":
        return AsyncStream(self._o.sync.events.subscribe(topics, since, **kw), queue_size=queue_size)

    async def wait_for(self, topic: str, predicate: Any = None, **kw: Any) -> Any:
        return await self._call(self._o.sync.events.wait_for, topic, predicate, **kw)

    verify_signature = staticmethod(verify_signature)


class AsyncBridge:
    """``Bridge`` for asyncio. Takes the same arguments as ``Bridge`` plus ``max_concurrency``."""

    def __init__(self, *args: Any, max_concurrency: int = 8, sync: Optional[Bridge] = None, **kw: Any) -> None:
        self.sync = sync if sync is not None else Bridge(*args, **kw)
        self._limit = max_concurrency
        self._sem: Optional[asyncio.Semaphore] = None
        self.orders = AsyncOrders(self)
        self.tickets = AsyncTickets(self)
        self.downloads = AsyncNamespace(self, self.sync.downloads)
        self.datasets = AsyncNamespace(self, self.sync.datasets)
        self.recordings = AsyncNamespace(self, self.sync.recordings)
        self.collections = AsyncNamespace(self, self.sync.collections)
        self.subscriptions = AsyncNamespace(self, self.sync.subscriptions)
        self.events = AsyncEvents(self)

    @classmethod
    def demo(cls, *args: Any, **kw: Any) -> "AsyncBridge":
        """Like ``Bridge.demo`` (blocking check at creation)."""
        return cls(sync=Bridge.demo(*args, **kw))

    async def __aenter__(self) -> "AsyncBridge":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        self.sync.close()

    def __repr__(self) -> str:
        return "Async" + repr(self.sync)

    async def _call(self, fn: Callable[..., T], *a: Any, **kw: Any) -> T:
        if self._sem is None:
            self._sem = asyncio.Semaphore(self._limit)
        async with self._sem:
            return await asyncio.to_thread(fn, *a, **kw)

    # system
    async def health(self) -> Any:
        return await self._call(self.sync.health)

    async def saved_calls(self) -> Any:
        return await self._call(self.sync.saved_calls)

    async def ping(self, **kw: Any) -> Ping:
        return await self._call(self.sync.ping, **kw)

    async def features(self) -> Any:
        return await self._call(self.sync.features)

    async def get(self, path: str, **query: Any) -> Any:
        return await self._call(self.sync.get, path, **query)

    async def post(self, path: str, body: Any = None) -> Any:
        return await self._call(self.sync.post, path, body)

    # data
    async def accounts(self) -> Result[Account]:
        return await self._call(self.sync.accounts)

    async def price(self, symbol: str, **kw: Any) -> Ltp:
        return await self._call(self.sync.price, symbol, **kw)

    async def ltp(self, symbols: Union[str, Sequence[str]], **kw: Any) -> Result[Ltp]:
        return await self._call(self.sync.ltp, symbols, **kw)

    async def quote(self, symbol: str, **kw: Any) -> Quote:
        return await self._call(self.sync.quote, symbol, **kw)

    async def quotes(self, symbols: Union[str, Sequence[str]], **kw: Any) -> Result[Quote]:
        return await self._call(self.sync.quotes, symbols, **kw)

    async def depth(self, symbol: str, **kw: Any) -> Depth:
        return await self._call(self.sync.depth, symbol, **kw)

    async def history(self, symbol: str, interval: str, **kw: Any) -> History:
        return await self._call(self.sync.history, symbol, interval, **kw)

    async def history_all(self, symbol: str, interval: str, from_: Any, to: Any = None, **kw: Any) -> History:
        """All candles of a long range as one ``History`` (see ``Bridge.history_all``; fetched in a worker thread)."""
        return await self._call(lambda: self.sync.history_all(symbol, interval, from_, to, **kw).to_history())

    async def expiries(self, underlying: str, **kw: Any) -> List[str]:
        return await self._call(self.sync.expiries, underlying, **kw)

    async def positions(self, account: Optional[str] = None, **kw: Any) -> Result[Position]:
        return await self._call(self.sync.positions, account, **kw)

    async def holdings(self, account: Optional[str] = None) -> Result[Holding]:
        return await self._call(self.sync.holdings, account)

    async def funds(self, account: Optional[str] = None, **kw: Any) -> Funds:
        return await self._call(self.sync.funds, account, **kw)

    async def sources(self) -> Result[Source]:
        return await self._call(self.sync.sources)

    async def ltp_many(self, symbols: Sequence[str], **kw: Any) -> Result[Ltp]:
        return await self._call(self.sync.ltp_many, symbols, **kw)

    async def quotes_many(self, symbols: Sequence[str], **kw: Any) -> Result[Quote]:
        return await self._call(self.sync.quotes_many, symbols, **kw)

    # streaming
    def stream(self, symbols: Sequence[str] = (), *, mode: str = "ltp", orders: Union[bool, Sequence[str]] = False, queue_size: int = 10000, **kw: Any) -> "AsyncStream":
        """A live stream for ``async with`` / ``async for`` (other keyword arguments as ``BridgeStream``)."""
        return AsyncStream(self.sync.stream(symbols, mode=mode, orders=orders, **kw), queue_size=queue_size)


_END = object()


class AsyncStream:
    """Async wrapper of ``BridgeStream``: ``async for msg in stream`` (dicts) or ``async for ev in stream.events()`` (typed)."""

    def __init__(self, stream: BridgeStream, *, queue_size: int = 10000) -> None:
        self.stream = stream
        self._queue_size = queue_size
        self._queue: Optional["asyncio.Queue[Any]"] = None
        self._thread: Optional[threading.Thread] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    async def __aenter__(self) -> "AsyncStream":
        self._start()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        self.close()

    def _start(self) -> None:
        if self._thread is not None:
            return
        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(self._queue_size)
        loop, q = self._loop, self._queue

        def put(item: Any) -> None:
            if loop.is_closed():
                return
            try:
                asyncio.run_coroutine_threadsafe(q.put(item), loop).result()
            except Exception:  # noqa: BLE001 - the loop went away; stop quietly
                self.stream.close()

        def pump() -> None:
            try:
                for msg in self.stream:
                    put(msg)
            except BaseException as e:  # noqa: BLE001 - handed to the consumer
                put(e)
            finally:
                put(_END)

        self._thread = threading.Thread(target=pump, name="mcb-stream", daemon=True)
        self._thread.start()

    def close(self) -> None:
        """Stop the stream (the iteration ends)."""
        self.stream.close()

    def subscribe(self, symbols: Union[str, Sequence[str]], mode: str = "ltp") -> None:
        self.stream.subscribe(symbols, mode)

    def unsubscribe(self, symbols: Union[str, Sequence[str]]) -> None:
        self.stream.unsubscribe(symbols)

    @property
    def gaps(self) -> int:
        return self.stream.gaps

    @property
    def conflated(self) -> int:
        return self.stream.conflated

    def __aiter__(self) -> AsyncIterator[Dict[str, Any]]:
        self._start()
        return self._iter()

    async def _iter(self) -> AsyncIterator[Dict[str, Any]]:
        assert self._queue is not None
        while True:
            item = await self._queue.get()
            if item is _END:
                return
            if isinstance(item, BaseException):
                raise item
            yield item

    async def events(self) -> AsyncIterator[StreamEvent]:
        """Typed events (``Tick``, ``OrderUpdate``, ``Snapshot``, ``Heartbeat`` ...)."""
        async for msg in self:
            yield parse_event(msg)
