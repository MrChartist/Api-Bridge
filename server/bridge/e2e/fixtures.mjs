/**
 * End-to-end fixtures: a stub broker registry whose adapters follow the strict broker contract (contract.mjs) and
 * count every call, a drivable streaming feed, and helpers to boot the REAL Bridge (every built-in module, real
 * services, real HTTP listener on an ephemeral 127.0.0.1 port) in-process. No network beyond loopback, no live
 * broker, no sleeps longer than a few batching windows.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";

/** Monday 19 October 2026, 10:00 IST: NSE is open, so safety and paper rules behave as on a trading day. */
export const TRADING_DAY_10AM_IST = Date.parse("2026-10-19T10:00:00+05:30");

/**
 * A clock that runs in real time but starts at `start`, so timers and timeouts behave normally while the date and
 * time of day are fixed for the test.
 */
export function shiftedClock(start = TRADING_DAY_10AM_IST) {
  const offset = start - Date.now();
  return { now: () => Date.now() + offset };
}

/** Instruments every stub broker publishes (contract Instrument rows). Tokens differ per broker prefix. */
export const STOCKS = Object.freeze([
  { symbol: "RELIANCE", token: "2885", price: 1402.5 },
  { symbol: "INFY", token: "1594", price: 1510.25 },
  { symbol: "TCS", token: "11536", price: 3105.0 },
  { symbol: "HDFCBANK", token: "1333", price: 1650.75 },
  { symbol: "SBIN", token: "3045", price: 812.4 },
  { symbol: "ITC", token: "1660", price: 428.15 },
  { symbol: "LT", token: "11483", price: 3550.0 },
  { symbol: "AXISBANK", token: "5900", price: 1120.6 },
]);

const priceByToken = new Map(STOCKS.map((s) => [s.token, s.price]));

/**
 * One stub adapter for broker `id`. Calls are recorded in `calls` with the account they were made for (identified
 * by the access token the account connected with, which the test chooses).
 */
export function stubBroker(id, { quoteDelayMs = 0 } = {}) {
  const calls = [];
  const feeds = [];
  const accountOf = (creds) => String(creds?.accessToken ?? "").replace(/^token-/, "");
  const quote = (ref) => {
    const ltp = priceByToken.get(ref.token) ?? 100;
    return { token: ref.token, exchange: ref.exchange, ltp, open: ltp - 2, high: ltp + 5, low: ltp - 6, close: ltp - 3, volume: 125000, oi: null, bid: ltp - 0.05, ask: ltp + 0.05 };
  };
  const adapter = {
    id,
    credentialFields: ["apiKey", "accessToken"],
    capabilities: {
      auth: { kind: "apiKeyToken" },
      testConnection: true,
      instruments: true,
      expiries: true,
      optionChain: true,
      ltp: true,
      quotes: true,
      depth: true,
      historical: { intervals: ["1m", "5m", "15m", "60m", "1d"] },
      feed: true,
    },
    async testConnection(creds) {
      calls.push({ method: "testConnection", account: accountOf(creds) });
      return { status: "success", message: "Connected to the stub broker." };
    },
    async fetchInstruments(creds) {
      calls.push({ method: "fetchInstruments", account: accountOf(creds) });
      return {
        status: "success",
        data: STOCKS.map((s) => ({ token: s.token, exchange: "NSE", tradingSymbol: s.symbol, underlying: s.symbol, instrumentType: "EQ", expiry: null, strike: null, optionType: null, lotSize: 1, tickSize: 0.05 })),
      };
    },
    async fetchQuotes(creds, refs) {
      calls.push({ method: "fetchQuotes", account: accountOf(creds), tokens: refs.map((r) => r.token) });
      if (quoteDelayMs) await new Promise((r) => setTimeout(r, quoteDelayMs));
      return { status: "success", data: refs.map(quote) };
    },
    async fetchLTP(creds, symbol) {
      calls.push({ method: "fetchLTP", account: accountOf(creds), symbol });
      return { status: "success", data: { last_price: 100 } };
    },
    async fetchDepth(creds, ref) {
      calls.push({ method: "fetchDepth", account: accountOf(creds), token: ref.token });
      const ltp = priceByToken.get(ref.token) ?? 100;
      return { status: "success", data: { bids: [{ price: ltp - 0.05, qty: 100, orders: 3 }], asks: [{ price: ltp + 0.05, qty: 120, orders: 4 }] } };
    },
    async fetchHistorical(creds, req) {
      calls.push({ method: "fetchHistorical", account: accountOf(creds), interval: req.interval, from: req.from, to: req.to });
      const ltp = priceByToken.get(req.instrument.token) ?? 100;
      const fromS = Math.floor(Date.parse(req.from) / 1000);
      const toS = Math.floor(Date.parse(req.to) / 1000);
      const day = 86_400;
      const out = [];
      // Daily bars stamped at 09:15 IST of each weekday in range.
      for (let t = Math.floor((fromS + 19_800) / day) * day - 19_800 + 33_300; t <= toS; t += day) {
        const dow = new Date((t + 19_800) * 1000).getUTCDay();
        if (dow === 0 || dow === 6 || t < fromS) continue;
        out.push({ time: t, open: ltp - 4, high: ltp + 6, low: ltp - 8, close: ltp, volume: 1_000_000 });
      }
      return { status: "success", data: out };
    },
    async fetchExpiryList(creds) {
      calls.push({ method: "fetchExpiryList", account: accountOf(creds) });
      return { status: "success", data: [] };
    },
    async fetchOptionChain(creds) {
      calls.push({ method: "fetchOptionChain", account: accountOf(creds) });
      return { status: "success", data: { oc: {}, last_price: 0 } };
    },
    createFeed(creds, handlers) {
      const feed = {
        account: accountOf(creds),
        subs: new Map(),
        subscribeCalls: [],
        closed: false,
        subscribe(refs) {
          this.subscribeCalls.push(refs.map((r) => r.token));
          for (const r of refs) this.subs.set(r.token, r);
        },
        unsubscribe(refs) {
          for (const r of refs) this.subs.delete(r.token);
        },
        close() {
          this.closed = true;
        },
        tick(token, ltp) {
          handlers.onTick({ ...quote({ token, exchange: "NSE" }), ltp });
        },
      };
      feeds.push(feed);
      // The broker socket "connects" on the next turn, like a real one.
      setImmediate(() => handlers.onStatus({ connected: true }));
      return feed;
    },
  };
  return { adapter, calls, feeds };
}

/** A registry over stub brokers, with the same surface as server/brokers/registry.mjs. */
export function stubRegistry(brokers) {
  const map = new Map(Object.entries(brokers).map(([id, b]) => [id, b.adapter]));
  return {
    has: (id) => map.has(id),
    get(id) {
      const a = map.get(id);
      if (!a) throw new Error(`Unknown broker: ${id}`);
      return a;
    },
    list: () => [...map.keys()],
  };
}

/**
 * Boot the real Bridge on 127.0.0.1:<ephemeral> with every built-in module.
 * @param {{ raw: object, brokers: Record<string, ReturnType<typeof stubBroker>>, clock?: { now(): number }, withConfigFile?: boolean }} opts
 */
export async function bootBridge({ raw, brokers, clock = shiftedClock(), withConfigFile = false }) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-e2e-"));
  const full = { dataDir, logging: { level: "silent" }, server: { port: 0 }, ...raw };
  // withConfigFile: the config is a real bridge.config.json loaded from its path and passed as the file to save
  // to, the way the CLI starts the Bridge (routes that edit the config write it).
  let configFile = null;
  if (withConfigFile) {
    configFile = join(dataDir, "bridge.config.json");
    writeFileSync(configFile, `${JSON.stringify(full, null, 2)}\n`);
  }
  const { config } = configFile ? loadConfig({ path: configFile, env: {} }) : loadConfig({ raw: full, env: {} });
  const app = await createApp({ config, logger: createNullLogger(), clock, brokers: stubRegistry(brokers), configFile });
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  /**
   * @param {string} path
   * @param {{ method?: string, key?: string, body?: unknown, headers?: Record<string, string> }} [o]
   */
  const http = async (path, { method = "GET", key, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (key) h.Authorization = `Bearer ${key}`;
    if (body !== undefined && typeof body !== "string") h["Content-Type"] = "application/json";
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, text, json };
  };
  return { app, deps: app.deps, port, base, http, dataDir, configFile, close: () => app.close() };
}

/**
 * Open a WebSocket to the Bridge and collect messages.
 * @returns {Promise<{ ws: WebSocket, messages: object[], send(o: object): void, waitFor(pred: (m: any) => boolean, ms?: number): Promise<any>, close(): void }>}
 */
export function openStream(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    const waiters = [];
    ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      messages.push(m);
      for (const w of [...waiters]) if (w.pred(m)) w.done(m);
    });
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`WebSocket upgrade refused: ${res.statusCode}`)));
    ws.once("open", () =>
      resolve({
        ws,
        messages,
        send: (o) => ws.send(JSON.stringify(o)),
        waitFor(pred, ms = 3000) {
          const hit = messages.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((res, rej) => {
            const w = {
              pred,
              done: (m) => {
                clearTimeout(timer);
                waiters.splice(waiters.indexOf(w), 1);
                res(m);
              },
            };
            const timer = setTimeout(() => {
              waiters.splice(waiters.indexOf(w), 1);
              rej(new Error(`timed out waiting for a stream message; got ${JSON.stringify(messages.slice(-5))}`));
            }, ms);
            waiters.push(w);
          });
        },
        close: () => ws.close(),
      }),
    );
  });
}

/** Poll `fn` until it returns a truthy value (or throw after `ms`). */
export async function eventually(fn, { ms = 3000, every = 20 } = {}) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`condition not met in ${ms} ms (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}
