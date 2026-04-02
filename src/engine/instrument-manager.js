/**
 * 🎫 InstrumentManager
 * 
 * Downloads, parses, and caches the Dhan instrument master (~245K rows).
 * Provides lookup for symbols, security IDs, option contracts, and FNO lists.
 * 
 * Ported from the working OptionsDesk parser — production-tested.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export class InstrumentManager {
  constructor({ dbPath }) {
    this.dbPath = dbPath;

    // Ensure data directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.cache = null;
    this.lastRefreshed = 0;
    this.TTL = 24 * 60 * 60 * 1000; // 24 hours
    this._initDb();
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instrument_cache (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  async getMaster() {
    if (this.cache && (Date.now() - this.lastRefreshed < this.TTL)) {
      return this.cache;
    }

    // Try loading from DB
    const dbCached = this._loadFromDb();
    if (dbCached) {
      this.cache = dbCached.data;
      this.lastRefreshed = dbCached.updated_at;
      if (Date.now() - dbCached.updated_at > this.TTL / 2) {
        this.refresh().catch(err => console.error(`[INSTRUMENTS] Background refresh failed: ${err.message}`));
      }
      return this.cache;
    }

    return await this.refresh();
  }

  async refresh() {
    console.log('[INSTRUMENTS] Downloading Dhan instrument master...');
    try {
      const csvUrl = 'https://images.dhan.co/api-data/api-scrip-master.csv';
      const res = await fetch(csvUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const text = await res.text();
      const lines = text.split('\n');
      if (lines.length < 100) throw new Error(`CSV too small: ${lines.length} lines`);

      console.log(`[INSTRUMENTS] Parsing ${lines.length} rows...`);

      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
      const colIdx = {};
      headers.forEach((h, i) => { colIdx[h] = i; });

      // Column resolution (Dhan CSV column names)
      const segCol = colIdx['SEM_EXM_EXCH_ID'] ?? colIdx['EXCH_ID'] ?? 0;
      const instCol = colIdx['SEM_INSTRUMENT_NAME'] ?? colIdx['INSTRUMENT'] ?? 3;
      const symbolCol = colIdx['SEM_TRADING_SYMBOL'] ?? colIdx['SM_SYMBOL_NAME'] ?? 4;
      const scripCol = colIdx['SEM_SMST_SECURITY_ID'] ?? colIdx['SECURITY_ID'] ?? 2;
      const lotCol = colIdx['SEM_LOT_UNITS'] ?? colIdx['LOT_SIZE'] ?? 7;
      const underlyingCol = colIdx['SEM_CUSTOM_SYMBOL'] ?? colIdx['SM_SYMBOL_NAME'] ?? 15;
      const expiryCol = colIdx['SEM_EXPIRY_DATE'] ?? colIdx['SM_EXPIRY_DATE'] ?? 8;

      // ── Hardcoded Index Scrip IDs (Dhan known values) ──
      const instrumentMap = {
        'NIFTY':      { scrip: 13,   seg: 'IDX_I', symbol: 'NIFTY',      exchangeSegment: 'IDX_I', securityId: 13,   lotSize: 25 },
        'BANKNIFTY':  { scrip: 25,   seg: 'IDX_I', symbol: 'BANKNIFTY',  exchangeSegment: 'IDX_I', securityId: 25,   lotSize: 15 },
        'FINNIFTY':   { scrip: 27,   seg: 'IDX_I', symbol: 'FINNIFTY',   exchangeSegment: 'IDX_I', securityId: 27,   lotSize: 25 },
        'MIDCPNIFTY': { scrip: 442,  seg: 'IDX_I', symbol: 'MIDCPNIFTY', exchangeSegment: 'IDX_I', securityId: 442,  lotSize: 50 },
        'SENSEX':     { scrip: 51,   seg: 'IDX_I', symbol: 'SENSEX',     exchangeSegment: 'IDX_I', securityId: 51,   lotSize: 10 },
        'BANKEX':     { scrip: 58,   seg: 'IDX_I', symbol: 'BANKEX',     exchangeSegment: 'IDX_I', securityId: 58,   lotSize: 15 },
        'INDIA VIX':  { scrip: 26,   seg: 'IDX_I', symbol: 'INDIA VIX',  exchangeSegment: 'IDX_I', securityId: 26,   lotSize: 1  },
      };

      const optionContracts = {};
      const fnoList = new Set(Object.keys(instrumentMap));

      // Parse CSV
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));

        const exchange = cols[segCol] || '';
        const instrument = cols[instCol] || '';
        const tradingSymbol = cols[symbolCol] || '';
        const scrip = parseInt(cols[scripCol] || '0', 10);
        const lotSize = parseInt(cols[lotCol] || '1', 10);
        const underlying = cols[underlyingCol] || '';

        // ── F&O Symbol Discovery ──
        if (
          (exchange === 'NSE' || exchange === 'BSE' || exchange === 'MCX') &&
          (instrument === 'OPTIDX' || instrument === 'OPTSTK' || instrument === 'FUTIDX' ||
           instrument === 'FUTSTK' || instrument === 'OPTCOM' || instrument === 'FUTCOM')
        ) {
          const baseSymbol = underlying.split('-')[0].split(/\d/)[0].replace(/_/g, '');
          if (baseSymbol) fnoList.add(baseSymbol);
        }

        // ── Option Contract Extraction ──
        // Trading symbol format: "BANKNIFTY-Jun2026-65400-CE"
        if (
          (instrument === 'OPTIDX' || instrument === 'OPTSTK' || instrument === 'OPTCOM' || instrument === 'OPTFUT') &&
          scrip > 0
        ) {
          const parts = tradingSymbol.split('-');
          if (parts.length >= 4) {
            const sym = parts[0];
            const strike = parseFloat(parts[parts.length - 2]);
            const optType = parts[parts.length - 1]; // CE or PE

            let iso = '';
            const expiryStr = cols[expiryCol] || '';
            if (expiryStr.includes('-')) {
              iso = expiryStr.split(' ')[0]; // "2026-06-30"
            }

            if (sym && !isNaN(strike) && (optType === 'CE' || optType === 'PE') && iso) {
              const exSeg = exchange === 'MCX' ? 'MCX_FNO' : exchange === 'BSE' ? 'BSE_FNO' : 'NSE_FNO';
              const key = `${sym}|${iso}|${strike}|${optType}`;
              optionContracts[key] = { securityId: scrip, exchangeSegment: exSeg };
            }
          }
        }

        // ── NSE Equity Scrip IDs (for FNO stocks) ──
        if (exchange === 'NSE' && (instrument === 'EQUITY' || instrument === 'EQ')) {
          const sym = tradingSymbol.replace(/-EQ$/, '').replace(/-BE$/, '');
          if (sym && !instrumentMap[sym]) {
            instrumentMap[sym] = {
              scrip, seg: 'NSE_EQ', symbol: sym,
              exchangeSegment: 'NSE_EQ', securityId: scrip,
              lotSize: lotSize || 1
            };
          }
        }
      }

      // ── Known equity scrip ID fallbacks ──
      const knownScrips = {
        RELIANCE: 2885, TCS: 11536, HDFCBANK: 1333, INFY: 1594, ICICIBANK: 4963,
        SBIN: 3045, TATAMOTORS: 3456, BAJFINANCE: 317, ITC: 1660, MARUTI: 10999,
        HINDUNILVR: 1394, BHARTIARTL: 10604, KOTAKBANK: 1922, LT: 11483,
        AXISBANK: 5900, ASIANPAINT: 236, SUNPHARMA: 3351, TITAN: 3506,
        WIPRO: 3787, ULTRACEMCO: 11532, ONGC: 2475, TATASTEEL: 3499,
        HINDALCO: 1363, DLF: 14732, HCLTECH: 7229, HEROMOTOCO: 4668,
        DRREDDY: 881, CIPLA: 694, EICHERMOT: 14143, TECHM: 13538,
        NESTLEIND: 17963, DIVISLAB: 10940, ADANIENT: 25, ADANIPORTS: 15083,
      };

      for (const [sym, scrip] of Object.entries(knownScrips)) {
        if (!instrumentMap[sym]) {
          instrumentMap[sym] = {
            scrip, seg: 'NSE_EQ', symbol: sym,
            exchangeSegment: 'NSE_EQ', securityId: scrip,
            lotSize: 1
          };
        }
      }

      // Build expiry list per symbol
      const expiryMap = {};
      for (const key of Object.keys(optionContracts)) {
        const [sym, expiry] = key.split('|');
        if (!expiryMap[sym]) expiryMap[sym] = new Set();
        expiryMap[sym].add(expiry);
      }

      // Convert expiry sets to sorted arrays
      for (const sym of Object.keys(expiryMap)) {
        expiryMap[sym] = Array.from(expiryMap[sym]).sort();
      }

      const data = {
        instrumentMap,
        optionContracts,
        fnoList: Array.from(fnoList).sort(),
        expiryMap,
        updatedAt: Date.now()
      };

      this._saveToDb(data);
      this.cache = data;
      this.lastRefreshed = Date.now();

      console.log(`[INSTRUMENTS] ✅ Loaded: ${Object.keys(instrumentMap).length} instruments, ${Object.keys(optionContracts).length} option contracts, ${data.fnoList.length} FNO symbols`);
      return data;
    } catch (err) {
      console.error(`[INSTRUMENTS] Refresh failed: ${err.message}`);
      throw err;
    }
  }

  _loadFromDb() {
    try {
      const row = this.db.prepare('SELECT data, updated_at FROM instrument_cache WHERE id = 1').get();
      if (row) return { data: JSON.parse(row.data), updated_at: row.updated_at };
    } catch (e) {}
    return null;
  }

  _saveToDb(data) {
    try {
      this.db.prepare('INSERT OR REPLACE INTO instrument_cache (id, data, updated_at) VALUES (1, ?, ?)')
        .run(JSON.stringify(data), Date.now());
    } catch (e) {
      console.error(`[INSTRUMENTS] DB save error: ${e.message}`);
    }
  }

  async resolveOption(symbol, expiry, strike, type) {
    const master = await this.getMaster();
    const key = `${symbol}|${expiry}|${strike}|${type}`;
    return master.optionContracts[key];
  }

  async getExpiries(symbol) {
    const master = await this.getMaster();
    return (master.expiryMap && master.expiryMap[symbol]) || [];
  }
}
