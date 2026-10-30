/**
 * Demo live market for the events engine (stream S28, demo mode only). The demo broker's prices are smooth waves
 * (good for charts, too calm for events), so the events page gets its own simulated session: about 50 F&O stocks
 * with their front futures, 5 indices and 90 fictional small caps on the cash list ("(Demo)" in every name), each
 * with a previous day, a gap at the open, a drifting intraday path with regime changes, an intraday volume curve,
 * a few volume surges, and small caps that run into their 2 / 5 / 10 / 20 % circuit and lock (some unlock later).
 * Index and stock chains (±10 strikes on the demo expiry, Black-76 premiums from dashboard/pricing.js on a smile, OI
 * profiles with walls, writing bursts, IV regimes) feed the option detectors.
 *
 * Everything runs through the real detectors: the simulator only produces quotes. It is seeded by the IST date, so a
 * day replays the same way. The session clock starts 75 minutes before the Bridge started, and the first 75 minutes
 * are replayed at once (backfill) so the page opens with a morning of events.
 */
import { black76 } from "../dashboard/pricing.js";
import { DEMO_UNDERLYINGS, demoUnderlying, expiriesFor, hash32 } from "../demo/demoAdapter.mjs";
import { NIFTY50 } from "../scanner/universes.mjs";
import { volumeShareAt } from "./detectors.mjs";
import { istDate } from "./engine.mjs";

export const DEMO_REPLAY_MINUTES = 75;

function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(1e-12, next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return { next, normal, pick: (arr) => arr[Math.floor(next() * arr.length)], range: (lo, hi) => lo + (hi - lo) * next() };
}

const PREFIX = ["Aravali", "Bhoomi", "Chandra", "Deccan", "Ekta", "Ganga", "Himgiri", "Indus", "Jyoti", "Kaveri", "Lotus", "Malabar", "Narmada", "Orion", "Pragati", "Rohini", "Sahyadri", "Tapti", "Udaya", "Vindhya", "Yamuna", "Zenith"];
const SUFFIX = [["Chemicals", "CHEM"], ["Textiles", "TEX"], ["Agro", "AGRO"], ["Infra", "INFRA"], ["Polymers", "POLY"], ["Pharma", "PHARM"], ["Steel", "STEEL"], ["Foods", "FOOD"], ["Cables", "CAB"], ["Ceramics", "CERA"]];
/** 90 fictional small caps (ticker, name), the same every run. */
export const DEMO_CASH = Object.freeze(
  (() => {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < PREFIX.length * SUFFIX.length && out.length < 90; i += 1) {
      const p = PREFIX[i % PREFIX.length];
      const [s, code] = SUFFIX[(i % PREFIX.length + Math.floor(i / PREFIX.length)) % SUFFIX.length];
      const ticker = `${p.slice(0, 5).toUpperCase()}${code}`.slice(0, 12);
      if (seen.has(ticker)) continue;
      seen.add(ticker);
      out.push({ ticker, name: `${p} ${s} (Demo)` });
    }
    return out;
  })(),
);

const tickOf = (price) => (price < 250 ? 0.01 : 0.05);
const onTick = (v, tick) => Math.round(v / tick) * tick;
const r2 = (n) => Math.round(n * 100) / 100;
const INDEX_CHAINS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"];
const STOCK_CHAINS = ["RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "SBIN", "TCS", "BHARTIARTL", "ITC"];

/**
 * @param {{ engine: object, clock: { now(): number }, startMs?: number, scale?: number }} o
 *   scale multiplies the cash list (tests and the perf run use it to push 500+ symbols).
 */
export function createDemoMarket({ engine, clock, startMs = clock.now(), scale = 1 }) {
  const date = istDate(startMs);
  const sessionStart = startMs - DEMO_REPLAY_MINUTES * 60_000;
  const minuteOf = (ms) => (ms - sessionStart) / 60_000;
  const stocks = [];
  const chains = [];

  // ── Universe ──
  const fnoSet = new Set(NIFTY50.map((s) => s.split(":")[1]));
  const addStock = (spec) => {
    const R = rng(hash32(`${date}|${spec.symbol}`));
    const kind = spec.kind ?? "EQ";
    const idx = kind === "INDEX";
    const small = Boolean(spec.small);
    const prev = r2(spec.base * R.range(0.97, 1.03));
    const tick = idx ? 0.05 : tickOf(prev);
    const dVol = idx ? R.range(0.006, 0.011) : small ? R.range(0.025, 0.045) : R.range(0.012, 0.024);
    let gap = R.normal() * dVol * 0.35;
    if (!idx && R.next() < (small ? 0.18 : 0.1)) gap = (R.next() < 0.55 ? 1 : -1) * R.range(0.012, small ? 0.06 : 0.035);
    const avgVol = idx ? 0 : Math.round((small ? R.range(4e4, 6e5) : R.range(8e5, 1.2e7)) / 10) * 10;
    let script = "normal";
    let band = null;
    let lockAt = null;
    let unlockAt = null;
    if (small) {
      const u = R.next();
      if (u < 0.12) script = "uc";
      else if (u < 0.21) script = "lc";
      if (script !== "normal") {
        band = R.pick([2, 5, 5, 5, 10, 10, 20]);
        lockAt = R.range(3, 150);
        unlockAt = R.next() < 0.4 ? lockAt + R.range(10, 90) : null;
        gap = (script === "uc" ? 1 : -1) * Math.min(band / 100 - 0.004, Math.abs(gap) + R.range(0, band / 300));
      }
    }
    const surgeAt = !idx && R.next() < (small ? 0.25 : 0.14) ? R.range(5, 300) : null;
    const s = {
      symbol: `${spec.exchange ?? "NSE"}:${spec.symbol}`,
      ticker: spec.symbol,
      name: spec.name,
      kind,
      small,
      R,
      prev,
      tick,
      dVol,
      open: onTick(prev * (1 + gap), tick),
      price: onTick(prev * (1 + gap), tick),
      hi: null,
      lo: null,
      drift: R.normal() * dVol * 0.6,
      regimeUntil: R.range(20, 90),
      avgVol,
      volume: 0,
      activity: R.range(0.6, 1.5),
      surgeAt,
      surgeX: R.range(3, 8),
      pv: 0,
      vv: 0,
      script,
      band,
      lockAt,
      unlockAt,
      fut: null,
      lastMinute: 0,
    };
    const prevHigh = r2(prev * (1 + R.range(0.003, 0.02)));
    const prevLow = r2(prev * (1 - R.range(0.003, 0.02)));
    const near52 = R.next();
    s.ctx = {
      prevClose: prev,
      prevHigh,
      prevLow,
      prevVolume: idx ? null : Math.round(avgVol * R.range(0.7, 1.3)),
      avgVolume: idx ? null : avgVol,
      high52: r2(near52 < 0.12 ? prev * R.range(1.005, 1.03) : prev * R.range(1.08, 1.6)),
      low52: r2(near52 > 0.9 ? prev * R.range(0.97, 0.995) : prev * R.range(0.55, 0.9)),
      historyFrom: "2016-01-01",
    };
    // Some 52-week highs are also all-time highs (the demo history starts in 2016).
    s.ctx.allTimeHigh = near52 < 0.05 ? s.ctx.high52 : r2(s.ctx.high52 * R.range(1.02, 1.5));
    s.ctx.allTimeLow = near52 > 0.95 ? s.ctx.low52 : r2(s.ctx.low52 * R.range(0.4, 0.95));
    const tags = { fno: Boolean(spec.fno), index: idx, nifty50: Boolean(spec.nifty50), cash: small };
    engine.register({ symbol: s.symbol, name: spec.name, kind: idx ? "INDEX" : "EQ", segment: spec.exchange ?? "NSE", tick, tags });
    engine.setContext(s.symbol, s.ctx);
    if (spec.fno && !idx) {
      const futSym = `NFO:${spec.symbol}-FUT`;
      s.fut = { symbol: futSym, oi: Math.round(R.range(2e6, 3e7) / 100) * 100, carry: R.range(0.002, 0.008), oiDrift: R.normal() * 0.004, oiRegimeUntil: R.range(15, 80), surgeAt: R.next() < 0.3 ? R.range(20, 300) : null };
      s.fut.oiPrev = s.fut.oi;
      engine.register({ symbol: futSym, kind: "FUT", stock: s.symbol, lot: demoUnderlying(spec.symbol)?.lot ?? 1, segment: "NFO", tags: { fno: true } });
    }
    stocks.push(s);
    return s;
  };

  for (const u of DEMO_UNDERLYINGS) {
    if (u.kind === "INDEX") {
      if (u.symbol === "INDIAVIX") continue;
      addStock({ symbol: u.symbol, exchange: u.exchange, name: u.name, base: u.base, kind: "INDEX" });
    } else addStock({ symbol: u.symbol, name: u.name, base: u.base, fno: fnoSet.has(u.symbol) || Boolean(demoUnderlying(u.symbol)?.deriv), nifty50: fnoSet.has(u.symbol) });
  }
  const cash = [];
  for (let k = 0; k < Math.max(1, scale); k += 1) for (const c of DEMO_CASH) cash.push({ ticker: k ? `${c.ticker}${k}` : c.ticker, name: c.name });
  for (const c of cash) {
    const R = rng(hash32(`base|${c.ticker}`));
    addStock({ symbol: c.ticker, name: c.name, base: R.pick([R.range(18, 90), R.range(40, 240), R.range(120, 900)]), small: true });
  }
  const bySymbol = new Map(stocks.map((s) => [s.ticker, s]));

  // ── Chains ──
  const addChain = (ticker) => {
    const s = bySymbol.get(ticker);
    const u = demoUnderlying(ticker);
    if (!s || !u?.step) return;
    const expiry = expiriesFor(ticker, startMs)[0];
    if (!expiry) return;
    const R = rng(hash32(`${date}|chain|${ticker}`));
    const idx = s.kind === "INDEX";
    const step = u.step;
    const n = idx ? 10 : 6;
    const atm0 = Math.round(s.prev / step) * step;
    const exch = u.deriv ?? "NFO";
    const lot = u.lot ?? 1;
    const ivBase = (u.iv ?? 0.18) * 100;
    const c = { ticker, expiry, step, lot, s, R, ivBase, ivLevel: ivBase, ivDrift: 0, ivRegimeUntil: R.range(20, 60), legs: [], basisCarry: R.range(0.0008, 0.003), basisJumpAt: R.range(30, 300) };
    for (let i = -n; i <= n; i += 1) {
      const K = atm0 + i * step;
      if (K <= 0) continue;
      for (const right of ["CE", "PE"]) {
        const dist = (K - atm0) / step;
        const wallBoost = (right === "CE" ? dist > 0 : dist < 0) && Math.abs(dist) % (idx ? 4 : 3) === 0 ? 2.2 : 1;
        const sideBias = right === "CE" ? (dist >= 0 ? 1.3 : 0.5) : dist <= 0 ? 1.3 : 0.5;
        const oi = Math.round((idx ? 60000 : 1500) * Math.exp(-((dist / (n * 0.55)) ** 2)) * sideBias * wallBoost * R.range(0.7, 1.3)) * lot;
        c.legs.push({ K, right, symbol: `${exch}:${ticker}-${expiry}-${K}-${right}`, oi, oiPrev: oi, vol: 0, prem0: null, burstAt: R.next() < (idx ? 0.08 : 0.06) ? R.range(10, 320) : null, burstLots: R.range(idx ? 1500 : 250, idx ? 6000 : 1200) * (R.next() < 0.5 ? 1 : -0.6), burstLen: R.range(2, 6) });
      }
    }
    engine.registerChain(ticker, expiry, { lot, kind: idx ? "INDEX" : "EQ", name: s.name, spotSymbol: s.symbol });
    chains.push(c);
  };
  for (const t of [...INDEX_CHAINS, ...STOCK_CHAINS]) addChain(t);

  // ── Stepping ──
  const yearsAt = (minute) => Math.max(0.5, 3 + (375 - minute) / 375) / 365;

  function stepStock(s, minute, dtSec) {
    const R = s.R;
    if (minute >= s.regimeUntil) {
      s.drift = R.normal() * s.dVol * 0.7;
      s.regimeUntil = minute + R.range(20, 90);
    }
    const sig = (s.dVol / Math.sqrt(22500)) * Math.sqrt(dtSec);
    let px = s.price * Math.exp((s.drift / 22500) * dtSec + sig * R.normal());
    // Circuit scripts: pulled to the band, then locked until (maybe) unlocked.
    let lock = null;
    if (s.band !== null) {
      const up = onTick(s.prev * (1 + s.band / 100), s.tick);
      const lo = onTick(s.prev * (1 - s.band / 100), s.tick);
      const locked = minute >= s.lockAt && (s.unlockAt === null || minute < s.unlockAt);
      if (s.script === "uc") {
        if (locked) {
          px = up;
          lock = "upper";
        } else if (minute < s.lockAt) px = Math.min(up - s.tick, px + (up - px) * Math.min(1, dtSec / Math.max(30, (s.lockAt - minute) * 60)));
        else px = Math.min(up - s.tick * 2, px * (1 - 0.0004 * dtSec));
      } else {
        if (locked) {
          px = lo;
          lock = "lower";
        } else if (minute < s.lockAt) px = Math.max(lo + s.tick, px - (px - lo) * Math.min(1, dtSec / Math.max(30, (s.lockAt - minute) * 60)));
        else px = Math.max(lo + s.tick * 2, px * (1 + 0.0004 * dtSec));
      }
    }
    px = Math.max(s.tick, onTick(px, s.tick));
    s.price = px;
    s.hi = s.hi === null ? Math.max(s.open, px) : Math.max(s.hi, px);
    s.lo = s.lo === null ? Math.min(s.open, px) : Math.min(s.lo, px);
    let bidQty = Math.round(R.range(50, 4000));
    let askQty = Math.round(R.range(50, 4000));
    if (lock === "upper") {
      askQty = 0;
      bidQty = Math.round(R.range(2e4, 4e5));
    } else if (lock === "lower") {
      bidQty = 0;
      askQty = Math.round(R.range(2e4, 4e5));
    }
    if (s.kind !== "INDEX") {
      let act = s.activity;
      if (s.surgeAt !== null && minute >= s.surgeAt) act *= 1 + (s.surgeX - 1) * Math.min(1, (minute - s.surgeAt) / 20);
      if (lock) act *= 1.6;
      const target = s.avgVol * volumeShareAt(minute) * act;
      if (target > s.volume) {
        const dv = Math.round(target - s.volume);
        s.pv += px * dv;
        s.vv += dv;
        s.volume += dv;
      }
    }
    return {
      symbol: s.symbol,
      ltp: px,
      open: s.open,
      high: s.hi,
      low: s.lo,
      close: s.prev,
      volume: s.kind === "INDEX" ? null : s.volume,
      bid: lock === "lower" ? null : r2(px - s.tick),
      ask: lock === "upper" ? null : r2(px + s.tick),
      bidQty: s.kind === "INDEX" ? null : bidQty,
      askQty: s.kind === "INDEX" ? null : askQty,
      avgPrice: s.vv > 0 ? r2(s.pv / s.vv) : null,
      source: "demo",
    };
  }

  function stepFuture(s, minute, dtSec) {
    const f = s.fut;
    const R = s.R;
    if (minute >= f.oiRegimeUntil) {
      f.oiDrift = R.normal() * 0.006;
      f.oiRegimeUntil = minute + R.range(15, 80);
    }
    let g = (f.oiDrift / 60) * dtSec + R.normal() * 0.0003 * Math.sqrt(dtSec);
    if (f.surgeAt !== null && minute >= f.surgeAt && minute < f.surgeAt + 8) g += (0.006 / 60) * dtSec * (s.drift >= 0 ? 1 : 1.2);
    f.oi = Math.max(1000, Math.round((f.oi * (1 + g)) / 100) * 100);
    const ltp = onTick(s.price * (1 + f.carry), 0.05);
    return { symbol: f.symbol, ltp, close: r2(s.prev * (1 + f.carry)), oi: f.oi, oiPrev: f.oiPrev, volume: Math.round(s.volume * 0.4), source: "demo" };
  }

  function chainQuotes(c, minute, dtSec) {
    const R = c.R;
    if (minute >= c.ivRegimeUntil) {
      // IV regimes: mostly calm drift, sometimes a spike or a crush over ~10 minutes.
      const u = R.next();
      c.ivDrift = u < 0.12 ? R.range(0.2, 0.45) : u < 0.22 ? -R.range(0.2, 0.4) : R.normal() * 0.03;
      c.ivRegimeUntil = minute + (Math.abs(c.ivDrift) > 0.15 ? R.range(6, 12) : R.range(20, 60));
    }
    c.ivLevel = Math.max(c.ivBase * 0.6, Math.min(c.ivBase * 1.8, c.ivLevel + (c.ivDrift * dtSec) / 60));
    const spot = c.s.price;
    if (minute >= c.basisJumpAt) {
      c.basisCarry += R.normal() * 0.0012;
      c.basisJumpAt = minute + R.range(40, 200);
    }
    const fwd = spot * (1 + c.basisCarry);
    const T = yearsAt(minute);
    const rows = new Map();
    for (const l of c.legs) {
      const m = Math.log(l.K / fwd);
      const iv = c.ivLevel + 30 * m * m * 100 + (l.right === "PE" ? -6 * m * 100 * 0.1 : 0);
      const prem = Math.max(0.05, r2(black76(fwd, l.K, T, iv, l.right) ?? 0.05));
      if (l.prem0 === null) l.prem0 = prem;
      // OI: slow drift plus writing bursts at one strike.
      let dOi = R.normal() * 0.0006 * l.oi * Math.sqrt(dtSec / 2);
      if (l.burstAt !== null && minute >= l.burstAt && minute < l.burstAt + l.burstLen) dOi += (l.burstLots * c.lot * dtSec) / (l.burstLen * 60);
      l.oi = Math.max(c.lot, Math.round((l.oi + dOi) / c.lot) * c.lot);
      l.vol += Math.round(Math.abs(dOi) * 0.8 + c.lot * R.range(0, 0.6) * dtSec * (Math.abs(m) < 0.02 ? 3 : 1));
      const q = { symbol: l.symbol, ltp: prem, oi: l.oi, oiPrev: l.oiPrev, volume: l.vol, iv: Math.round(iv * 100) / 100, close: l.prem0, upper: r2(Math.max(l.prem0 * 2.2, l.prem0 + 20)), lower: 0.05, source: "demo" };
      if (!rows.has(l.K)) rows.set(l.K, { strike: l.K });
      rows.get(l.K)[l.right === "CE" ? "ce" : "pe"] = q;
    }
    return { underlying: c.ticker, expiry: c.expiry, spot, fut: r2(fwd), lot: c.lot, rows: [...rows.values()] };
  }

  /**
   * Advance every symbol to `ms` (dtSec since the last step) and feed the engine. Returns the number of quotes fed.
   * @param {number} ms
   * @param {{ dtSec?: number, chains?: boolean }} [o]
   */
  function step(ms, { dtSec = 1, withChains = true } = {}) {
    const minute = minuteOf(ms);
    if (minute >= 374) return 0;
    let n = 0;
    for (const s of stocks) {
      engine.ingest(stepStock(s, minute, dtSec), ms);
      n += 1;
      if (s.fut) {
        engine.ingest(stepFuture(s, minute, dtSec), ms);
        n += 1;
      }
    }
    if (withChains) {
      for (const c of chains) {
        const snap = chainQuotes(c, minute, dtSec);
        for (const r of snap.rows) {
          for (const side of ["ce", "pe"]) if (r[side]) (engine.ingest(r[side], ms), (n += 1));
        }
        engine.registerChain(c.ticker, c.expiry).fut = snap.fut;
      }
    }
    engine.flush(ms);
    return n;
  }

  /** Replay the session from the open to `toMs` in `everySec` steps (the morning before the Bridge started). */
  function backfill(toMs = startMs, everySec = 20) {
    let n = 0;
    for (let t = sessionStart + 1000; t <= toMs; t += everySec * 1000) n += step(t, { dtSec: everySec });
    return n;
  }
  /** backfill(), yielding to the event loop every few steps so a starting Bridge keeps answering. */
  async function backfillAsync(toMs = startMs, everySec = 20, isStopped = () => false) {
    let n = 0;
    let i = 0;
    for (let t = sessionStart + 1000; t <= toMs && !isStopped(); t += everySec * 1000) {
      n += step(t, { dtSec: everySec });
      if (++i % 8 === 0) await new Promise((r) => setImmediate(r));
    }
    return n;
  }

  return {
    date,
    sessionStart,
    sessionOf: minuteOf,
    step,
    backfill,
    backfillAsync,
    stocks: () => stocks,
    chains: () => chains,
    /** Universe sizes (status). */
    size: () => ({ stocks: stocks.length, futures: stocks.filter((s) => s.fut).length, chains: chains.length, legs: chains.reduce((a, c) => a + c.legs.length, 0) }),
  };
}
