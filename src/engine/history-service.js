/**
 * 📊 Historical Data Service
 * 
 * Fetches OHLCV candle data from broker APIs with SQLite caching.
 * Supports: 1m, 5m, 15m, 30m, 1h, 1D, 1W, 1M intervals.
 * 
 * Dhan API: /v2/charts/intraday (for intraday), /v2/charts/historical (for D/W/M)
 */

import Database from 'better-sqlite3';
import path from 'path';

const DHAN_BASE = 'https://api.dhan.co/v2';

// Map our intervals to Dhan's chart format
const INTERVAL_MAP = {
  '1m':  { type: 'intraday', resolution: '1'  },
  '5m':  { type: 'intraday', resolution: '5'  },
  '15m': { type: 'intraday', resolution: '15' },
  '25m': { type: 'intraday', resolution: '25' },
  '30m': { type: 'intraday', resolution: '30' },
  '1h':  { type: 'intraday', resolution: '60' },
  '1D':  { type: 'historical', resolution: 'D' },
  '1W':  { type: 'historical', resolution: 'W' },
  '1M':  { type: 'historical', resolution: 'M' },
};

export class HistoryService {
  constructor({ dbPath, token, clientId, instrumentManager, mock = false }) {
    this.token = token;
    this.clientId = clientId;
    this.instrumentManager = instrumentManager;
    this.mock = mock;
    this.dbPath = dbPath || path.join(process.cwd(), 'data', 'history.db');
    this.db = null;
    this._initDB();
    if (mock) console.log('[HISTORY] 🎭 Mock mode — chart data is simulated');
  }

  _initDB() {
    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('cache_size = -16000'); // 16MB cache

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS candles (
          symbol TEXT NOT NULL,
          interval TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          open REAL, high REAL, low REAL, close REAL, volume INTEGER,
          PRIMARY KEY (symbol, interval, timestamp)
        );
        CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles(symbol, interval, timestamp);

        CREATE TABLE IF NOT EXISTS cache_meta (
          key TEXT PRIMARY KEY,
          fetched_at INTEGER,
          count INTEGER
        );
      `);

      this._insertStmt = this.db.prepare(`
        INSERT OR REPLACE INTO candles (symbol, interval, timestamp, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this._queryStmt = this.db.prepare(`
        SELECT timestamp, open, high, low, close, volume
        FROM candles
        WHERE symbol = ? AND interval = ? AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp ASC
      `);

      this._metaSet = this.db.prepare(`INSERT OR REPLACE INTO cache_meta (key, fetched_at, count) VALUES (?, ?, ?)`);
      this._metaGet = this.db.prepare(`SELECT fetched_at, count FROM cache_meta WHERE key = ?`);

      console.log('[HISTORY] SQLite cache initialized');
    } catch (err) {
      console.error(`[HISTORY] DB init error: ${err.message}`);
    }
  }

  /**
   * Get historical candle data
   * @param {Object} params
   * @param {string} params.symbol - Trading symbol (e.g. "NIFTY", "RELIANCE")
   * @param {string} params.exchange - Exchange segment (e.g. "NSE_EQ", "IDX_I")
   * @param {string} params.interval - Candle interval (1m, 5m, 15m, 1h, 1D)
   * @param {string} params.startDate - Start date YYYY-MM-DD
   * @param {string} params.endDate - End date YYYY-MM-DD
   * @param {boolean} params.forceRefresh - Skip cache and fetch from broker
   */
  async getHistory({ symbol, exchange, interval = '1D', startDate, endDate, forceRefresh = false }) {
    const iConfig = INTERVAL_MAP[interval];
    if (!iConfig) {
      throw new Error(`Invalid interval: ${interval}. Supported: ${Object.keys(INTERVAL_MAP).join(', ')}`);
    }

    const startTs = new Date(startDate + 'T00:00:00+05:30').getTime() / 1000;
    const endTs = new Date(endDate + 'T23:59:59+05:30').getTime() / 1000;

    // Check cache first (for non-intraday, data doesn't change)
    if (!forceRefresh && this.db) {
      const cacheKey = `${symbol}:${interval}:${startDate}:${endDate}`;
      const meta = this._metaGet.get(cacheKey);
      
      // Cache valid for: daily data = 24h, intraday = 5min
      const maxAge = iConfig.type === 'historical' ? 86400000 : 300000;
      if (meta && (Date.now() - meta.fetched_at) < maxAge) {
        const rows = this._queryStmt.all(symbol, interval, startTs, endTs);
        if (rows.length > 0) {
          return {
            symbol, exchange, interval, source: 'cache',
            count: rows.length,
            data: rows.map(r => ({
              timestamp: r.timestamp,
              date: new Date(r.timestamp * 1000).toISOString(),
              open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume
            }))
          };
        }
      }
    }

    // Resolve securityId from instrument manager
    let securityId;
    try {
      const master = await this.instrumentManager.getMaster();
      const info = master.instrumentMap[symbol.toUpperCase()];
      if (info?.securityId) {
        securityId = info.securityId;
      }
    } catch (e) { /* ignore */ }

    if (!securityId) {
      throw new Error(`Cannot resolve securityId for ${symbol}. Check if the symbol exists.`);
    }

    // Determine exchange segment ID for Dhan
    const exchSegment = this._resolveExchange(exchange || 'NSE_EQ');

    // Fetch from Dhan
    const endpoint = iConfig.type === 'intraday' ? '/charts/intraday' : '/charts/historical';
    const body = {
      securityId: String(securityId),
      exchangeSegment: exchSegment,
      instrument: 'EQUITY',
    };

    if (iConfig.type === 'intraday') {
      body.interval = iConfig.resolution;
      body.fromDate = startDate;
      body.toDate = endDate;
    } else {
      body.interval = iConfig.resolution; 
      body.fromDate = startDate;
      body.toDate = endDate;
      body.expiryCode = 0;
    }

    const response = await this._dhanFetch(endpoint, body);

    // Parse Dhan response (arrays: open, high, low, close, volume, timestamp)
    const candles = [];
    if (response && response.open && Array.isArray(response.open)) {
      for (let i = 0; i < response.open.length; i++) {
        candles.push({
          timestamp: response.timestamp?.[i] || 0,
          date: response.timestamp?.[i] ? new Date(response.timestamp[i] * 1000).toISOString() : '',
          open: response.open[i],
          high: response.high[i],
          low: response.low[i],
          close: response.close[i],
          volume: response.volume?.[i] || 0
        });
      }
    }

    // Cache to SQLite
    if (candles.length > 0 && this.db) {
      const insert = this.db.transaction((rows) => {
        for (const c of rows) {
          this._insertStmt.run(symbol, interval, c.timestamp, c.open, c.high, c.low, c.close, c.volume);
        }
        this._metaSet.run(`${symbol}:${interval}:${startDate}:${endDate}`, Date.now(), rows.length);
      });
      insert(candles);
    }

    return {
      symbol, exchange: exchange || 'NSE_EQ', interval, source: 'broker',
      count: candles.length,
      data: candles
    };
  }

  /**
   * Get available intervals
   */
  getIntervals() {
    return Object.entries(INTERVAL_MAP).map(([key, val]) => ({
      interval: key,
      type: val.type,
      description: key.endsWith('m') ? `${key.slice(0,-1)} minute` : key.endsWith('h') ? `${key.slice(0,-1)} hour` : key === '1D' ? 'Daily' : key === '1W' ? 'Weekly' : 'Monthly'
    }));
  }

  _resolveExchange(exchange) {
    const map = {
      'NSE_EQ': 'NSE_EQ', 'NSE': 'NSE_EQ', 'BSE_EQ': 'BSE_EQ', 'BSE': 'BSE_EQ',
      'NSE_FNO': 'NSE_FNO', 'NFO': 'NSE_FNO', 'MCX': 'MCX_COMM',
      'IDX_I': 'IDX_I', 'NSE_INDEX': 'IDX_I', 'INDEX': 'IDX_I',
      'BSE_INDEX': 'IDX_I',
    };
    return map[exchange.toUpperCase()] || exchange;
  }

  async _dhanFetch(endpoint, body) {
    // Mock mode — generate synthetic data
    if (this.mock) {
      const n = 30;
      const base = 24000;
      return {
        open: Array.from({length:n}, (_,i) => +(base + Math.sin(i/3)*200 + Math.random()*50).toFixed(2)),
        high: Array.from({length:n}, (_,i) => +(base + Math.sin(i/3)*200 + 80 + Math.random()*40).toFixed(2)),
        low: Array.from({length:n}, (_,i) => +(base + Math.sin(i/3)*200 - 60 - Math.random()*40).toFixed(2)),
        close: Array.from({length:n}, (_,i) => +(base + Math.sin(i/3)*200 + 20 + Math.random()*30).toFixed(2)),
        volume: Array.from({length:n}, () => Math.floor(Math.random()*1000000) + 500000),
        timestamp: Array.from({length:n}, (_,i) => Math.floor(Date.now()/1000) - (n-i)*86400)
      };
    }

    const url = `${DHAN_BASE}${endpoint}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'access-token': this.token,
          'client-id': this.clientId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      return await res.json();
    } catch (err) {
      console.error(`[HISTORY] Dhan API error: ${err.message}`);
      throw err;
    }
  }
}
