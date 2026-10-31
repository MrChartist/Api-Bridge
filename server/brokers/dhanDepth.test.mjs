import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createDhanDepthPool, parseDhanDepthFrame, setDhanDepthPool, DHAN_DEPTH20_URL, DHAN_DEPTH200_URL } from "./dhanDepth.mjs";
import * as dhan from "./dhan.mjs";

// ── fixtures built byte by byte from the documented layout ──

/** One bid (41) or ask (51) packet: 12-byte header, then 16 bytes per level (float64 price, uint32 qty, uint32 orders). */
function packet(code, seg, secId, levels, { word = 7, padTo, declared } = {}) {
  const rows = padTo ?? levels.length;
  const buf = Buffer.alloc(12 + rows * 16);
  buf.writeUInt16LE(declared ?? buf.length, 0);
  buf.writeUInt8(code, 2);
  buf.writeUInt8(seg, 3);
  buf.writeInt32LE(secId, 4);
  buf.writeUInt32LE(word, 8);
  levels.forEach(([price, qty, orders], i) => {
    const b = 12 + i * 16;
    buf.writeDoubleLE(price, b);
    buf.writeUInt32LE(qty, b + 8);
    buf.writeUInt32LE(orders, b + 12);
  });
  return buf;
}
function disconnect(reason) {
  const buf = Buffer.alloc(14);
  buf.writeUInt16LE(14, 0);
  buf.writeUInt8(50, 2);
  buf.writeInt16LE(reason, 12);
  return buf;
}
const ladder = (from, step, n, side) => Array.from({ length: n }, (_, i) => [from + (side === "bid" ? -i : i) * step, 100 + i, 1 + i]);

describe("parseDhanDepthFrame", () => {
  it("decodes a 20-level bid packet followed by its ask packet, stacked in one frame", () => {
    const bid = packet(41, 1, 1333, ladder(1612.4, 0.1, 20, "bid"), { word: 987654 });
    const ask = packet(51, 1, 1333, ladder(1612.5, 0.1, 20, "ask"));
    expect(bid.length).toBe(332);
    const out = parseDhanDepthFrame(Buffer.concat([bid, ask]), { levels: 20 });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ code: 41, side: "bid", segment: "NSE_EQ", securityId: "1333" });
    expect(out[0].levels).toHaveLength(20);
    expect(out[0].levels[0]).toEqual({ price: 1612.4, qty: 100, orders: 1 });
    expect(out[0].levels[19]).toEqual({ price: 1610.5, qty: 119, orders: 20 });
    expect(out[1]).toMatchObject({ side: "ask", segment: "NSE_EQ" });
    expect(out[1].levels[0]).toEqual({ price: 1612.5, qty: 100, orders: 1 });
  });

  it("keeps two instruments apart and drops empty (zero-price) levels", () => {
    const a = packet(41, 2, 52175, [[182.3, 650, 3], [182.25, 75, 1]], { padTo: 20 });
    const b = packet(51, 2, 52176, [[90.1, 1300, 9]], { padTo: 20 });
    const out = parseDhanDepthFrame(Buffer.concat([a, b]));
    expect(out.map((p) => [p.segment, p.securityId, p.side, p.levels.length])).toEqual([["NSE_FNO", "52175", "bid", 2], ["NSE_FNO", "52176", "ask", 1]]);
  });

  it("reads the 200-level row count from header bytes 8-11", () => {
    const p = packet(51, 2, 40001, ladder(250, 0.05, 137, "ask"), { word: 137 });
    const [one] = parseDhanDepthFrame(p, { levels: 200 });
    expect(one.levels).toHaveLength(137);
    expect(one.levels[136].price).toBe(256.8);
    // The same word on the 20-level feed is a sequence number, not a row count.
    expect(parseDhanDepthFrame(packet(51, 2, 40001, ladder(250, 0.05, 20, "ask"), { word: 137 }), { levels: 20 })[0].levels).toHaveLength(20);
  });

  it("caps rows at what the packet holds and drops a truncated tail", () => {
    const p = packet(41, 1, 11536, ladder(3900, 0.5, 3, "bid"), { word: 200 });
    expect(parseDhanDepthFrame(p, { levels: 200 })[0].levels).toHaveLength(3);
    const whole = packet(41, 1, 11536, ladder(3900, 0.5, 20, "bid"));
    expect(parseDhanDepthFrame(Buffer.concat([whole, whole.subarray(0, 100)]))).toHaveLength(1);
    expect(parseDhanDepthFrame(Buffer.alloc(5))).toEqual([]);
  });

  it("reads the disconnect reason and skips unknown packets by their length", () => {
    const unknown = Buffer.alloc(16); unknown.writeUInt16LE(16, 0); unknown.writeUInt8(99, 2);
    const out = parseDhanDepthFrame(Buffer.concat([unknown, disconnect(807)]));
    expect(out).toEqual([{ code: 50, segment: "IDX_I", securityId: "0", disconnectCode: 807 }]);
  });
});

// ── pool ──

function fakeWs() {
  const sockets = [];
  class FakeWs extends EventEmitter {
    constructor(url) { super(); this.url = url; this.sent = []; this.readyState = 0; sockets.push(this); }
    send(m) { this.sent.push(JSON.parse(m)); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
    accept() { this.readyState = 1; this.emit("open"); }
  }
  return { FakeWs, sockets };
}
const CREDS = { clientId: "1000000001", accessToken: "tok-secret" };
const bookFrame = (seg, id, n) => Buffer.concat([packet(41, seg, id, ladder(100, 0.05, n, "bid"), { word: n }), packet(51, seg, id, ladder(100.05, 0.05, n, "ask"), { word: n })]);

describe("createDhanDepthPool", () => {
  it("opens one 20-level socket, subscribes with code 23 and answers once both sides arrive", async () => {
    const { FakeWs, sockets } = fakeWs();
    const pool = createDhanDepthPool({ WebSocketImpl: FakeWs });
    const p = pool.book(CREDS, { segment: "NSE_EQ", securityId: "1333" }, 20);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe(`${DHAN_DEPTH20_URL}?token=tok-secret&clientId=1000000001&authType=2`);
    sockets[0].accept();
    expect(sockets[0].sent).toEqual([{ RequestCode: 23, InstrumentCount: 1, InstrumentList: [{ ExchangeSegment: "NSE_EQ", SecurityId: "1333" }] }]);
    sockets[0].emit("message", bookFrame(1, 1333, 20), true);
    const book = await p;
    expect(book.bids).toHaveLength(20);
    expect(book.asks[0]).toEqual({ price: 100.05, qty: 100, orders: 1 });
    // A second instrument shares the socket; a repeat read answers from the live book without a new subscribe.
    pool.book(CREDS, { segment: "NSE_FNO", securityId: "52175" }, 20).catch(() => {});
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent.at(-1).InstrumentList).toEqual([{ ExchangeSegment: "NSE_FNO", SecurityId: "52175" }]);
    await expect(pool.book(CREDS, { segment: "NSE_EQ", securityId: "1333" }, 20)).resolves.toMatchObject({ bids: expect.any(Array) });
    expect(sockets[0].sent).toHaveLength(2);
    pool.close();
  });

  it("uses one socket per 200-level instrument and stays within the socket limit", async () => {
    const { FakeWs, sockets } = fakeWs();
    let t = 0;
    const pool = createDhanDepthPool({ WebSocketImpl: FakeWs, maxSockets: 2, evictAfterMs: 10_000, now: () => t });
    const a = pool.book(CREDS, { segment: "NSE_EQ", securityId: "1" }, 200);
    sockets[0].accept();
    expect(sockets[0].url.startsWith(DHAN_DEPTH200_URL)).toBe(true);
    expect(sockets[0].sent).toEqual([{ RequestCode: 23, ExchangeSegment: "NSE_EQ", SecurityId: "1" }]);
    sockets[0].emit("message", bookFrame(1, 1, 150), true);
    expect((await a).bids).toHaveLength(150);
    pool.book(CREDS, { segment: "NSE_EQ", securityId: "2" }, 200).catch(() => {});
    expect(sockets).toHaveLength(2);
    // Full, and both sockets were used just now: refuse rather than drop a busy one.
    await expect(pool.book(CREDS, { segment: "NSE_EQ", securityId: "3" }, 200)).rejects.toThrow(/in use/);
    // Later the least recently used socket gives up its slot.
    t = 20_000;
    pool.book(CREDS, { segment: "NSE_EQ", securityId: "3" }, 200).catch(() => {});
    expect(sockets).toHaveLength(3);
    expect(sockets[0].readyState).toBe(3);
    expect(Object.values(pool.stats())[0].sockets).toHaveLength(2);
    pool.close();
  });

  it("unsubscribes idle instruments with code 24 and closes empty sockets", async () => {
    const { FakeWs, sockets } = fakeWs();
    let t = 0;
    const pool = createDhanDepthPool({ WebSocketImpl: FakeWs, idleMs: 60_000, now: () => t });
    const a = pool.book(CREDS, { segment: "NSE_EQ", securityId: "1" }, 20);
    sockets[0].accept();
    sockets[0].emit("message", bookFrame(1, 1, 20), true);
    await a;
    t = 50_000;
    const b = pool.book(CREDS, { segment: "NSE_EQ", securityId: "2" }, 20);
    sockets[0].emit("message", bookFrame(1, 2, 20), true);
    await b;
    t = 70_000;
    pool.sweep();
    expect(sockets[0].sent.at(-1)).toEqual({ RequestCode: 24, InstrumentCount: 1, InstrumentList: [{ ExchangeSegment: "NSE_EQ", SecurityId: "1" }] });
    t = 200_000;
    pool.sweep();
    expect(sockets[0].sent.at(-1)).toEqual({ RequestCode: 12 });
    expect(sockets[0].readyState).toBe(3);
    pool.close();
  });

  it("cools down after a disconnect packet and after a failed handshake", async () => {
    const { FakeWs, sockets } = fakeWs();
    let t = 0;
    const pool = createDhanDepthPool({ WebSocketImpl: FakeWs, now: () => t });
    const a = pool.book(CREDS, { segment: "NSE_EQ", securityId: "1" }, 20);
    sockets[0].accept();
    sockets[0].emit("message", disconnect(806), true);
    await expect(a).rejects.toThrow(/code 806/);
    await expect(pool.book(CREDS, { segment: "NSE_EQ", securityId: "1" }, 20)).rejects.toThrow(/code 806/);
    expect(sockets).toHaveLength(1);
    t = 16 * 60_000;
    const b = pool.book(CREDS, { segment: "NSE_EQ", securityId: "1" }, 20);
    sockets[1].close(); // refused before open
    await expect(b).rejects.toThrow();
    await expect(pool.book(CREDS, { segment: "NSE_EQ", securityId: "1" }, 20)).rejects.toThrow(/could not connect/);
    pool.close();
  });

  it("refuses segments Dhan does not stream and times out when no data comes", async () => {
    vi.useFakeTimers();
    try {
      const { FakeWs, sockets } = fakeWs();
      const pool = createDhanDepthPool({ WebSocketImpl: FakeWs, firstDataMs: 3000 });
      await expect(pool.book(CREDS, { segment: "BSE_EQ", securityId: "500325" }, 20)).rejects.toThrow(/not offered/);
      await expect(pool.book(CREDS, { segment: "IDX_I", securityId: "13" }, 200)).rejects.toThrow(/not offered/);
      expect(sockets).toHaveLength(0);
      const p = pool.book(CREDS, { segment: "NSE_EQ", securityId: "1" }, 20);
      sockets[0].accept();
      const check = expect(p).rejects.toThrow(/no data/);
      await vi.advanceTimersByTimeAsync(3001);
      await check;
      // A one-sided book is still an answer.
      const q = pool.book(CREDS, { segment: "NSE_EQ", securityId: "1" }, 20);
      sockets[0].emit("message", packet(41, 1, 1, [[99, 10, 1]], { padTo: 20 }), true);
      await vi.advanceTimersByTimeAsync(3001);
      await expect(q).resolves.toEqual({ bids: [{ price: 99, qty: 10, orders: 1 }], asks: [] });
      pool.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the old sockets when the access token changes", () => {
    const { FakeWs, sockets } = fakeWs();
    const pool = createDhanDepthPool({ WebSocketImpl: FakeWs });
    pool.book(CREDS, { segment: "NSE_EQ", securityId: "1" }, 20).catch(() => {});
    pool.book({ ...CREDS, accessToken: "tok-new" }, { segment: "NSE_EQ", securityId: "1" }, 20).catch(() => {});
    expect(sockets).toHaveLength(2);
    expect(sockets[0].readyState).toBe(3);
    expect(sockets[1].url).toContain("token=tok-new");
    pool.close();
  });
});

describe("dhan.fetchDepth with a levels hint", () => {
  afterEach(() => setDhanDepthPool(null));

  it("answers 20 levels from the depth socket for NSE instruments", async () => {
    const calls = [];
    setDhanDepthPool({ book: async (creds, ref, levels) => { calls.push([ref, levels]); return { bids: [{ price: 1, qty: 1, orders: 1 }], asks: [] }; }, close() {} });
    const r = await dhan.fetchDepth(CREDS, { token: "1333", exchange: "NSE" }, { levels: 20 });
    expect(r).toEqual({ status: "success", data: { bids: [{ price: 1, qty: 1, orders: 1 }], asks: [] } });
    expect(calls).toEqual([[{ segment: "NSE_EQ", securityId: "1333" }, 20]]);
  });

  it("falls back to the five-level REST quote when the socket fails or the segment is not streamed", async () => {
    const book = vi.fn(async () => { throw new Error("socket down"); });
    setDhanDepthPool({ book, close() {} });
    const quote = { data: { NSE_EQ: { 1333: { depth: { buy: [{ price: 10, quantity: 5, orders: 1 }], sell: [{ price: 10.05, quantity: 7, orders: 2 }] } } }, BSE_EQ: { 500325: { depth: { buy: [], sell: [] } } } }, status: "success" };
    const realFetch = globalThis.fetch;
    let restCalls = 0;
    globalThis.fetch = async () => { restCalls++; return new Response(JSON.stringify(quote), { status: 200, headers: { "content-type": "application/json" } }); };
    try {
      const r = await dhan.fetchDepth(CREDS, { token: "1333", exchange: "NSE" }, { levels: 200 });
      expect(r.data).toEqual({ bids: [{ price: 10, qty: 5, orders: 1 }], asks: [{ price: 10.05, qty: 7, orders: 2 }] });
      await dhan.fetchDepth(CREDS, { token: "500325", exchange: "BSE" }, { levels: 20 });
      expect(book).toHaveBeenCalledTimes(1); // BSE never reaches the socket
      expect(restCalls).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
