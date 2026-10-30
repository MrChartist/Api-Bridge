/**
 * Demo facts for the scanner (demo mode only). The demo broker's prices are smooth waves, too calm for scans, so the
 * scanner gets its own simulated F&O market, like the Live events page has (events/demoMarket.mjs): about 200 F&O
 * stocks, each with a year of daily bars, a live day, near and next futures with OI, a ±10-strike option chain priced
 * with Black-76 on a smile, a stored ATM IV history and an MWPL reading.
 *
 * Every library scan (dashboard/scan-library.js) gets a handful of planted "stories" so it shows realistic hits; the
 * rest is natural noise, so other scans match some symbols too. Stories switch on at a minute of the demo session,
 * so scheduled scans see new hits as the day goes on ("new since last run"). Seeded by the IST date: a day replays
 * the same way. Symbols the demo broker already prices (the NIFTY 50 demo list) keep the demo broker's price, so the
 * Option Chain and quotes agree with the scan; price stories go to the other symbols.
 *
 * The output is the same `raw` shape the live collector builds (facts.mjs buildFacts), so the facts maths is the
 * real one.
 */
import { black76 } from "../dashboard/pricing.js";
import { DEMO_UNDERLYINGS, dailyCloses, demoStrikeStep, expiriesFor, hash32, spotAt } from "../demo/demoAdapter.mjs";
import { FNO_STOCKS, symbolMeta } from "./sectors.mjs";
import { istDay, sessionMinuteOf } from "./facts.mjs";
import { volumeShareAt } from "../events/detectors.mjs";

const DAY_S = 86_400;
const SESSION_MINUTES = 375;
const DEMO_PRICED = new Set(DEMO_UNDERLYINGS.filter((u) => u.kind === "EQ").map((u) => u.symbol));

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
  return { next, normal, range: (lo, hi) => lo + (hi - lo) * next() };
}

const r2 = (v) => Math.round(v * 100) / 100;
const tickOf = (p) => (p < 250 ? 0.05 : 0.1);
const onTick = (v, tick) => Math.round(Math.round(v / tick) * tick * 100) / 100;

/** Stories per group: the library scan they plant hits for. Price stories need a price the demo broker does not set. */
const PRICE_STORIES = ["gap-up", "gap-down", "high-52w", "low-52w", "near-upper-circuit", "near-lower-circuit", "nr7", "inside-day", "pdh-breakout-volume", "pdl-breakdown-volume", "high-20-volume"];
const FNO_STORIES = ["long-buildup", "short-buildup", "short-covering", "long-unwinding", "oi-spike", "near-ban", "pcr-high", "pcr-low", "iv-rank-high", "iv-rank-low", "iv-pctl-high", "iv-pctl-low", "iv-over-hv", "iv-under-hv", "futures-discount", "rollover-high", "cash-futures-arb"];
const CHAIN_STORIES = ["oi-change-strike", "unusual-option-volume", "put-skew-steep", "call-skew-under", "max-pain-far", "straddle-under-move", "straddle-over-move"];
/** Stories that move the futures price and so need a price of their own. */
const PRICE_BOUND_FNO = new Set(["long-buildup", "short-buildup", "short-covering", "long-unwinding"]);
const PER_STORY = 4;

function shuffled(list, seed) {
  const R = rng(seed);
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(R.next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** symbol -> { price, fno, chain } story ids (with their start minutes) for one IST date. */
export function demoStories(date, tickers = FNO_STOCKS) {
  const out = new Map(tickers.map((t) => [t, {}]));
  const free = tickers.filter((t) => !DEMO_PRICED.has(t));
  const assign = (group, stories, pool, seed) => {
    const order = shuffled(pool, hash32(`${date}|scan-stories|${seed}`));
    let i = 0;
    for (const s of stories) {
      for (let k = 0; k < PER_STORY && i < order.length; k += 1, i += 1) {
        const R = rng(hash32(`${date}|${s}|${order[i]}`));
        // The first story of each kind is on from the open; the others switch on during the day.
        out.get(order[i])[group] = { id: s, from: k === 0 ? 0 : Math.round(R.range(20, 330)) };
      }
    }
  };
  assign("price", PRICE_STORIES, free, "price");
  const fnoPool = shuffled(tickers, hash32(`${date}|fno-pool`));
  const priceBound = FNO_STORIES.filter((s) => PRICE_BOUND_FNO.has(s));
  const other = FNO_STORIES.filter((s) => !PRICE_BOUND_FNO.has(s));
  // Build-up stories set the price: only symbols without a price story and not priced by the demo broker.
  assign("fno", priceBound, fnoPool.filter((t) => free.includes(t) && !out.get(t).price), "fno-a");
  assign("fno", other, fnoPool.filter((t) => !out.get(t).fno), "fno-b");
  assign("chain", CHAIN_STORIES, tickers, "chain");
  return out;
}

/**
 * @param {{ now: () => number, bootMs?: number }} o
 */
export function createDemoFacts({ now, bootMs = now() }) {
  const memo = new Map();

  /**
   * The demo session minute: the real one in market hours on a weekday; otherwise a replayed day that started
   * 150 minutes before the Bridge did and runs at real speed to the close.
   */
  function minuteAt(t) {
    const d = new Date(t + 19_800_000);
    const dow = d.getUTCDay();
    const m = sessionMinuteOf(t);
    if (dow !== 0 && dow !== 6 && m > 0 && m < SESSION_MINUTES) return m;
    return Math.min(SESSION_MINUTES, 150 + (t - bootMs) / 60_000);
  }

  function dayOf(t) {
    const date = istDay(t);
    let d = memo.get(date);
    if (!d) {
      d = { date, stories: demoStories(date), base: new Map() };
      memo.clear();
      memo.set(date, d);
    }
    return d;
  }

  /** The static part of a symbol's day: daily bars, levels, futures base, chain shape, IV history. */
  function baseOf(day, ticker, t) {
    let b = day.base.get(ticker);
    if (b) return b;
    const R = rng(hash32(`${day.date}|scan-base|${ticker}`));
    const st = day.stories.get(ticker) ?? {};
    const priced = DEMO_PRICED.has(ticker);
    const prevClose = priced ? (dailyCloses(ticker, t, 1)[0] ?? spotAt(ticker, t)) : r2(Math.exp(R.range(Math.log(90), Math.log(9000))));
    const dv = R.range(0.011, 0.024);
    const price = st.price?.id;
    const drift = price === "high-52w" ? 0.0022 : price === "low-52w" ? -0.0022 : R.normal() * 0.0006;
    // 260 completed days ending at the previous close (anchored at the end).
    const N = 260;
    const rets = Array.from({ length: N }, () => drift + R.normal() * dv);
    const cum = [];
    let c = 0;
    for (const x of rets) cum.push((c += x));
    const lastDayS = Math.floor(Date.parse(`${day.date}T00:00:00+05:30`) / 1000) - DAY_S;
    const avgVol = Math.round(Math.exp(R.range(Math.log(4e5), Math.log(2.5e7))) / 100) * 100;
    const bars = [];
    for (let i = 0; i < N; i += 1) {
      const close = prevClose * Math.exp(cum[i] - cum[N - 1]);
      const prev = i ? bars[i - 1].close : close / Math.exp(rets[0]);
      const open = prev * Math.exp(R.normal() * dv * 0.3);
      const hi = Math.max(open, close) * (1 + Math.abs(R.normal()) * dv * 0.45);
      const lo = Math.min(open, close) * (1 - Math.abs(R.normal()) * dv * 0.45);
      bars.push({ time: lastDayS - (N - 1 - i) * DAY_S, open: r2(open), high: r2(hi), low: r2(lo), close: r2(close), volume: Math.round(avgVol * Math.exp(R.normal() * 0.35)) });
    }
    bars[N - 1].close = r2(prevClose);
    const last = bars[N - 1];
    last.high = r2(Math.max(last.high, last.open, last.close));
    last.low = r2(Math.min(last.low, last.open, last.close));
    if (price === "nr7") {
      const w = (last.high - last.low) * 0.3 || prevClose * 0.003;
      last.high = r2(Math.max(last.open, last.close) + w / 2);
      last.low = r2(Math.min(last.open, last.close) - w / 2);
      for (let i = N - 7; i < N - 1; i += 1) {
        const mid = (bars[i].high + bars[i].low) / 2;
        const need = (last.high - last.low) * R.range(1.4, 2.4);
        if (bars[i].high - bars[i].low < need) {
          bars[i].high = r2(Math.max(bars[i].high, mid + need / 2));
          bars[i].low = r2(Math.min(bars[i].low, mid - need / 2));
        }
      }
    }
    if (price === "inside-day") {
      const p = bars[N - 2];
      p.high = r2(Math.max(p.high, last.high * (1 + R.range(0.004, 0.012))));
      p.low = r2(Math.min(p.low, last.low * (1 - R.range(0.004, 0.012))));
    }
    // Futures and options shape
    const fno = st.fno?.id;
    const chain = st.chain?.id;
    // A year of ATM IV around the stock's own realised vol (IV usually a little over HV), in slow cycles.
    const atmIvBase = (realised(bars) || R.range(19, 42)) * R.range(1.02, 1.15);
    const period = R.range(60, 140);
    const phase0 = R.range(0, 6);
    const hist = Array.from({ length: 252 }, (_, i) => r2(atmIvBase * (1 + 0.2 * Math.sin((2 * Math.PI * i) / period + phase0) + R.normal() * 0.05)));
    b = { R, st, priced, prevClose, bars, avgVol, dv, drift, atmIvBase, hist, gapSeed: R.normal(), driftDay: R.normal() * dv * 0.5, paceNat: Math.exp(R.normal() * 0.3), prevOi: Math.round(Math.exp(R.range(Math.log(2e6), Math.log(8e7))) / 100) * 100, oiNat: R.normal() * 0.018, carry: R.range(0.055, 0.075), mwpl: R.range(4, 62), rollNat: R.range(4, 28), ivPos: R.next(), pcrNat: R.range(0.62, 1.28), skewP: R.range(1, 3), skewC: R.range(-0.9, 0.6), painOff: R.normal() * 0.008, fno, chain, price };
    day.base.set(ticker, b);
    return b;
  }

  const on = (story, minute) => Boolean(story) && minute >= story.from;

  /** The live raw parts of one symbol at time t. */
  function rawOf(symbol, t) {
    const ticker = symbol.split(":").pop();
    const day = dayOf(t);
    const b = baseOf(day, ticker, t);
    const minute = minuteAt(t);
    const frac = minute / SESSION_MINUTES;
    const st = b.st;
    const priceOn = on(st.price, minute) ? st.price.id : null;
    const fnoOn = on(st.fno, minute) ? st.fno.id : null;
    const chainOn = on(st.chain, minute) ? st.chain.id : null;
    const prev = b.prevClose;
    const last = b.bars[b.bars.length - 1];
    const tick = tickOf(prev);
    const wave = Math.sin(minute / 23 + b.gapSeed) * b.dv * 0.15;

    // ── Today's price path ──
    let gap = b.gapSeed * b.dv * 0.3;
    let move = b.driftDay * Math.sqrt(frac) + wave;
    let pace = b.paceNat;
    let high = null;
    let low = null;
    const year = b.bars.slice(-252);
    const h52 = Math.max(...year.map((x) => x.high));
    const l52 = Math.min(...year.map((x) => x.low));
    const h20 = Math.max(...b.bars.slice(-20).map((x) => x.high));
    if (st.price?.id === "gap-up") gap = b.R.range(0.025, 0.045);
    if (st.price?.id === "gap-down") gap = -b.R.range(0.025, 0.045);
    if (priceOn === "high-52w") move = Math.log((h52 * 1.006) / (prev * Math.exp(gap)));
    if (priceOn === "low-52w") move = Math.log((l52 * 0.994) / (prev * Math.exp(gap)));
    if (priceOn === "near-upper-circuit") move = Math.log(1.093 / Math.exp(gap));
    if (priceOn === "near-lower-circuit") move = Math.log(0.907 / Math.exp(gap));
    if (priceOn === "pdh-breakout-volume") {
      move = Math.log((last.high * 1.012) / (prev * Math.exp(gap)));
      pace = 2.4;
    }
    if (priceOn === "pdl-breakdown-volume") {
      move = Math.log((last.low * 0.988) / (prev * Math.exp(gap)));
      pace = 2.4;
    }
    if (priceOn === "high-20-volume") move = Math.log((Math.max(h20, last.high) * 1.01) / (prev * Math.exp(gap)));
    if (fnoOn === "long-buildup" || fnoOn === "short-covering") move = Math.log(1 + b.R.range(0.012, 0.03)) - gap;
    if (fnoOn === "short-buildup" || fnoOn === "long-unwinding") move = Math.log(1 - b.R.range(0.012, 0.03)) - gap;
    let open;
    let ltp;
    if (b.priced) {
      ltp = spotAt(ticker, t);
      open = onTick(prev * Math.exp(gap * 0.3), tick);
    } else {
      open = onTick(prev * Math.exp(gap), tick);
      ltp = onTick(open * Math.exp(move), tick);
    }
    high = Math.max(open, ltp) * (1 + Math.abs(b.gapSeed) * b.dv * 0.12);
    low = Math.min(open, ltp) * (1 - Math.abs(b.driftDay / (b.dv || 1)) * b.dv * 0.12);
    if (priceOn === "near-upper-circuit" || priceOn === "high-52w" || priceOn === "pdh-breakout-volume") high = Math.max(open, ltp);
    if (priceOn === "near-lower-circuit" || priceOn === "low-52w" || priceOn === "pdl-breakdown-volume") low = Math.min(open, ltp);
    // Keep natural paths inside yesterday's 52-week range unless a story says otherwise.
    if (!priceOn && !b.priced) {
      high = Math.min(high, h52 * 0.999);
      low = Math.max(low, l52 * 1.001);
      ltp = Math.min(Math.max(ltp, low), high);
    }
    const share = Math.max(0.02, volumeShareAt(minute));
    let volume = Math.round(b.avgVol * share * pace);
    if (priceOn === "high-20-volume") volume = Math.round(b.avgVol * 2.3);
    const quote = { ltp: onTick(ltp, tick), open, high: onTick(high, tick), low: onTick(low, tick), close: prev, volume, atMs: t, sessionMinute: minute };

    // ── Futures ──
    const [nearExp, nextExp] = expiriesFor("RELIANCE", t, 2);
    const dte = nearExp ? Math.max(1, (Date.parse(`${nearExp}T15:30:00+05:30`) - t) / 86_400_000) : 20;
    let carry = b.carry;
    if (fnoOn === "futures-discount") carry = -b.R.range(0.01, 0.04);
    if (fnoOn === "cash-futures-arb") carry = b.R.range(0.1, 0.13);
    const futPrev = prev * (1 + (b.carry * (dte + 1)) / 365);
    const fut = quote.ltp * (1 + (carry * dte) / 365);
    let oiChg = b.oiNat * Math.sqrt(frac);
    if (fnoOn === "long-buildup" || fnoOn === "short-buildup") oiChg = b.R.range(0.05, 0.14);
    if (fnoOn === "short-covering" || fnoOn === "long-unwinding") oiChg = -b.R.range(0.05, 0.12);
    if (fnoOn === "oi-spike") oiChg = b.R.range(0.12, 0.3);
    // Natural build-ups stay small so the planted ones stand out.
    if (!fnoOn) oiChg = Math.max(-0.028, Math.min(0.028, oiChg));
    const nearOi = Math.round(b.prevOi * (1 + oiChg));
    const roll = fnoOn === "rollover-high" ? b.R.range(0.62, 0.8) : dte < 6 ? b.rollNat / 100 + 0.3 : b.rollNat / 100;
    const nextOi = Math.round((nearOi * roll) / (1 - roll));
    const futRaw = { near: { ltp: r2(fut), close: r2(futPrev), oi: nearOi }, next: { oi: nextOi }, prevOi: b.prevOi, expiry: nearExp ?? null, nextExpiry: nextExp ?? null };

    // ── MWPL ──
    let mwpl = b.mwpl;
    if (fnoOn === "near-ban") mwpl = b.R.range(82, 99);
    const mwplRaw = { mwplPct: r2(mwpl), inBan: mwpl >= 95 };

    // ── Chain and IV ──
    const sorted = [...b.hist].sort((x, y) => x - y);
    const minIv = sorted[0];
    const maxIv = sorted[sorted.length - 1];
    const hv = realised(b.bars);
    let atmIv = minIv + b.ivPos * 0.8 * (maxIv - minIv) + 0.1 * (maxIv - minIv);
    if (fnoOn === "iv-rank-high") atmIv = minIv + b.R.range(0.86, 0.98) * (maxIv - minIv);
    if (fnoOn === "iv-rank-low") atmIv = minIv + b.R.range(0.01, 0.12) * (maxIv - minIv);
    if (fnoOn === "iv-pctl-high") atmIv = sorted[Math.floor(sorted.length * b.R.range(0.93, 0.99))];
    if (fnoOn === "iv-pctl-low") atmIv = sorted[Math.floor(sorted.length * b.R.range(0.01, 0.06))];
    if (fnoOn === "iv-over-hv" && hv) atmIv = hv + b.R.range(9.5, 14);
    if (fnoOn === "iv-under-hv" && hv) atmIv = Math.max(6, hv - b.R.range(4, 7));
    // Natural IV stays within a few points of HV, so the IV-HV scans are not crowded.
    if (hv && !["iv-over-hv", "iv-under-hv", "iv-rank-high", "iv-rank-low", "iv-pctl-high", "iv-pctl-low"].includes(fnoOn)) atmIv = Math.min(Math.max(atmIv, hv - 2), hv + 6);
    let pcr = b.pcrNat;
    if (fnoOn === "pcr-high") pcr = b.R.range(1.6, 2.2);
    if (fnoOn === "pcr-low") pcr = b.R.range(0.3, 0.45);
    let skewP = b.skewP;
    let skewC = b.skewC;
    if (chainOn === "put-skew-steep") skewP = b.R.range(5, 9);
    if (chainOn === "call-skew-under") skewC = -b.R.range(2, 4);
    let painOff = b.painOff;
    if (chainOn === "max-pain-far") painOff = (b.R.next() < 0.5 ? 1 : -1) * b.R.range(0.045, 0.07);
    const straddleFactor = chainOn === "straddle-under-move" ? b.R.range(0.78, 0.88) : chainOn === "straddle-over-move" ? b.R.range(1.22, 1.35) : b.R.range(0.97, 1.06);
    const chainRaw = chainOf({ ticker, spot: quote.ltp, fut, expiry: nearExp, dte, atmIv, skewP, skewC, pcr, painOff, straddleFactor, R: rng(hash32(`${day.date}|chain|${ticker}|${Math.floor(minute / 5)}`)), story: chainOn, frac });
    const ivHistory = b.hist.map((iv, i) => ({ date: `d${i}`, iv }));

    return {
      symbol,
      daily: b.bars,
      quote,
      fut: futRaw,
      chain: chainRaw,
      ivHistory,
      mwpl: mwplRaw,
      meta: { ...symbolMeta(symbol), fno: true },
      source: "demo",
    };
  }

  function realised(bars) {
    const c = bars.slice(-21).map((x) => x.close);
    const r = [];
    for (let i = 1; i < c.length; i += 1) r.push(Math.log(c[i] / c[i - 1]));
    const m = r.reduce((a, x) => a + x, 0) / r.length;
    const v = r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1);
    return Math.sqrt(v * 252) * 100;
  }

  /** A ±10-strike chain: Black-76 on a smile, OI with walls around a max-pain centre, OI change and volume. */
  function chainOf({ spot, fut, expiry, dte, atmIv, skewP, skewC, pcr, painOff, straddleFactor, R, story, frac }) {
    const step = demoStrikeStep(spot);
    const atm = Math.round(spot / step) * step;
    const years = Math.max(dte, 0.25) / 365;
    const centre = spot * (1 + painOff);
    const lot = Math.max(1, Math.round(500000 / spot / 25) * 25);
    const rows = [];
    const oiScale = Math.round(1e6 / lot) * lot;
    const special = Math.floor(R.range(-4, 5));
    for (let i = -10; i <= 10; i += 1) {
      const k = atm + i * step;
      if (k <= 0) continue;
      const m = (k - spot) / spot;
      // Put wing rises as strikes fall; the call wing is flatter. ±5 % gives skewP / skewC exactly.
      const ivPut = atmIv + (m < 0 ? (skewP * -m) / 0.05 : (skewC * m) / 0.05 * 0.5);
      const ivCall = atmIv + (m > 0 ? (skewC * m) / 0.05 : (skewP * -m) / 0.05 * 0.6);
      const isAtm = k === atm;
      const priceOf = (right, iv) => {
        let p = black76(fut, k, years, iv, right) ?? 0;
        if (isAtm) p *= straddleFactor;
        return Math.max(0.05, Math.round(p * 20) / 20);
      };
      const dist = (k - centre) / (step * 4);
      const callOi = oiScale * Math.exp(-((Math.max(0, dist) - 0.6) ** 2)) * (0.6 + 0.8 * R.next()) * (k >= centre ? 1.4 : 0.35);
      const putOi = oiScale * pcr * Math.exp(-((Math.min(0, dist) + 0.6) ** 2)) * (0.6 + 0.8 * R.next()) * (k <= centre ? 1.4 : 0.35);
      const leg = (right, iv, oi) => {
        const o = Math.round(oi / lot) * lot;
        let chgPct = R.normal() * 0.06 * frac;
        if (story === "oi-change-strike" && i === special && right === "PE") chgPct = R.range(0.45, 1.1);
        const prevOi = o / (1 + chgPct);
        let vol = o * R.range(0.05, 0.6) * Math.max(0.1, frac);
        if (story === "unusual-option-volume" && i === special + 1 && right === "CE") vol = o * R.range(2.2, 4.5);
        return { ltp: priceOf(right, iv), iv: Math.round(iv * 100) / 100, oi: o, oiChange: Math.round(o - prevOi), volume: Math.round(vol / lot) * lot };
      };
      rows.push({ strike: k, ce: leg("CE", ivCall, callOi), pe: leg("PE", ivPut, putOi) });
    }
    return { underlying: null, expiry, underlyingLtp: spot, atmStrike: atm, lotSize: lot, rows };
  }

  return {
    /** Raw parts for each symbol (same shape as the live collector). Only the F&O list is simulated. */
    raw(symbols, t = now()) {
      const out = new Map();
      for (const s of symbols) {
        const ticker = String(s).split(":").pop();
        if (!FNO_STOCKS.includes(ticker)) continue;
        out.set(s, rawOf(s, t));
      }
      return out;
    },
    minuteAt,
    stories: (t = now()) => dayOf(t).stories,
  };
}
