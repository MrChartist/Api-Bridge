/**
 * ⚡ DhanAdapter
 * 
 * Persistent WebSocket integration for Dhan Live Market Feed.
 * Handles binary protocol, auto-reconnection, and multi-mode subscriptions.
 */

import WebSocket from 'ws';
import { BaseBrokerAdapter } from '../base-adapter.js';

// Dhan Feed Protocol Constants
const FEED_REQUEST = {
  SUBSCRIBE_TICKER: 15, UNSUBSCRIBE_TICKER: 16,
  SUBSCRIBE_QUOTE: 17, UNSUBSCRIBE_QUOTE: 18,
  SUBSCRIBE_FULL: 21, UNSUBSCRIBE_FULL: 22,
  DISCONNECT: 12,
};

const FEED_RESPONSE = {
  TICKER: 2, QUOTE: 4, OI: 5, PREV_CLOSE: 6, MARKET_STATUS: 7, FULL: 8, DISCONNECT: 50,
};

const SEGMENT_MAP = { 0: 'NSE_EQ', 1: 'NSE_FNO', 2: 'NSE_CURR', 3: 'BSE_EQ', 4: 'BSE_FNO', 5: 'BSE_CURR', 7: 'MCX_COMM', 8: 'IDX_I' };

export class DhanAdapter extends BaseBrokerAdapter {
  constructor(config) {
    super(config);
    this.name = 'Dhan';
    this.ws = null;
    this.token = config.token;
    this.clientId = config.clientId;
    this.onTick = config.onTick || (() => {});
    
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 100; // VPS should keep trying
    this.instruments = new Map(); // securityId -> info
    this.securityIdMap = new Map();
    this.prevCloseCache = new Map();
  }

  async connect() {
    // Enable Mock Mode if configured (perfect for off-market testing)
    if (process.env.DHAN_MOCK === 'true') {
      console.log(`[DHAN] 🎭 MOCK MODE ENABLED`);
      this.connected = true;
      this._startMockGenerator();
      return true;
    }

    if (!this.token || !this.clientId) {
      console.error('[DHAN] Missing credentials in .env');
      return false;
    }

    const url = `wss://api-feed.dhan.co?version=2&token=${this.token}&clientId=${this.clientId}&authType=2`;
    console.log(`[DHAN] Connecting to live feed...`);
    try {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.on('open', () => {
        console.log(`[DHAN] ✅ Connected to Dhan WebSocket`);
        this.connected = true;
        this.reconnectAttempts = 0;
        
        // Re-subscribe to symbols if we were already subscribed
        if (this.instruments.size > 0) {
          this._resubscribeAll();
        }
      });

      this.ws.on('message', (data) => this._handleBinaryMessage(Buffer.from(data)));

      this.ws.on('close', (code, reason) => {
        console.warn(`[DHAN] ❌ Connection closed (code: ${code}). Reconnecting...`);
        this.connected = false;
        this._scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error(`[DHAN] WebSocket Error: ${err.message}`);
      });

      return true;
    } catch (e) {
      console.error(`[DHAN] Connection failed: ${e.message}`);
      return false;
    }
  }

  _scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000); // Max 60s
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), delay);
  }

  async subscribe(instruments, mode = 'quote') {
    if (!this.connected || !this.ws) return;

    const items = Array.isArray(instruments) ? instruments : [instruments];
    const requestCode = mode === 'ticker' ? FEED_REQUEST.SUBSCRIBE_TICKER : 
                         mode === 'quote' ? FEED_REQUEST.SUBSCRIBE_QUOTE : 
                         FEED_REQUEST.SUBSCRIBE_FULL;

    const list = items.map(inst => ({
      ExchangeSegment: inst.exchangeSegment,
      SecurityId: String(inst.securityId)
    }));

    // Dhan allows max 100 instruments per batch
    for (let i = 0; i < list.length; i += 100) {
      const batch = list.slice(i, i + 100);
      const msg = JSON.stringify({
        RequestCode: requestCode,
        InstrumentCount: batch.length,
        InstrumentList: batch
      });
      this.ws.send(msg);
      
      // Update local maps
      batch.forEach((item, idx) => {
        const info = items[i + idx];
        this.instruments.set(item.SecurityId, info);
        this.securityIdMap.set(parseInt(item.SecurityId), info);
      });
    }
  }

  _resubscribeAll() {
    const all = Array.from(this.instruments.values());
    this.subscribe(all, 'quote');
  }

  _handleBinaryMessage(buf) {
    if (buf.length < 8) return;

    const responseCode = buf.readUInt8(0);
    const securityId = buf.readInt32LE(4);
    const info = this.securityIdMap.get(securityId);

    if (!info) return;

    switch (responseCode) {
      case FEED_RESPONSE.TICKER:
        this._parseTicker(buf, securityId, info);
        break;
      case FEED_RESPONSE.QUOTE:
        this._parseQuote(buf, securityId, info);
        break;
      case FEED_RESPONSE.OI:
        this._parseOI(buf, securityId, info);
        break;
      case FEED_RESPONSE.PREV_CLOSE:
        this._parsePrevClose(buf, securityId, info);
        break;
      case FEED_RESPONSE.DISCONNECT:
        console.error(`[DHAN] Server forced disconnect. Check concurrent sessions.`);
        break;
    }
  }

  _parseTicker(buf, securityId, info) {
    if (buf.length < 16) return;
    const ltp = buf.readFloatLE(8);
    this.onTick(this.normalizeTick({ type: 'TICK', securityId, ltp, info }));
  }

  _parseQuote(buf, securityId, info) {
    if (buf.length < 50) return;
    const ltp = buf.readFloatLE(8);
    const volume = buf.readInt32LE(22);
    const open = buf.readFloatLE(34);
    const close = buf.readFloatLE(38); // prev close
    const high = buf.readFloatLE(42);
    const low = buf.readFloatLE(46);

    this.onTick(this.normalizeTick({ type: 'QUOTE', securityId, ltp, volume, open, close, high, low, info }));
  }

  _parseOI(buf, securityId, info) {
    if (buf.length < 12) return;
    const oi = buf.readInt32LE(8);
    this.onTick(this.normalizeTick({ type: 'OI', securityId, oi, info }));
  }

  _parsePrevClose(buf, securityId, info) {
    if (buf.length < 16) return;
    const prevClose = buf.readFloatLE(8);
    const prevOI = buf.readInt32LE(12);
    this.prevCloseCache.set(securityId, { price: prevClose, oi: prevOI });
  }

  normalizeTick(data) {
    const { info, securityId, ltp, volume, open, close, high, low, oi } = data;
    const prev = this.prevCloseCache.get(securityId) || { price: close || 0, oi: 0 };
    
    const change = ltp ? ltp - prev.price : 0;
    const changePct = prev.price > 0 ? (change / prev.price) * 100 : 0;

    return {
      symbol: info.symbol,
      securityId: securityId,
      ltp: ltp ? Number(ltp.toFixed(2)) : undefined,
      open: open ? Number(open.toFixed(2)) : undefined,
      high: high ? Number(high.toFixed(2)) : undefined,
      low: low ? Number(low.toFixed(2)) : undefined,
      close: prev.price ? Number(prev.price.toFixed(2)) : undefined,
      volume: volume,
      oi: oi || undefined,
      oiChange: oi ? oi - prev.oi : undefined,
      change: Number(change.toFixed(2)),
      changePct: Number(changePct.toFixed(2)),
      timestamp: Date.now(),
      source: 'dhan'
    };
  }

  _startMockGenerator() {
    const symbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'INDIA VIX'];
    const pPrices = { 'NIFTY': 24000, 'BANKNIFTY': 52000, 'FINNIFTY': 23000, 'MIDCPNIFTY': 12000, 'SENSEX': 79000, 'INDIA VIX': 12.5 };
    
    this.mockInterval = setInterval(() => {
      if (!this.connected) return;
      
      const symbol = symbols[Math.floor(Math.random() * symbols.length)];
      const current = pPrices[symbol];
      const change = (Math.random() - 0.5) * 5; 
      pPrices[symbol] = current + change;
      
      this.onTick({
        symbol,
        securityId: 0,
        ltp: Number(pPrices[symbol].toFixed(2)),
        change: Number(change.toFixed(2)),
        changePct: Number(((change / current) * 100).toFixed(2)),
        timestamp: Date.now(),
        source: 'mock'
      });
    }, 1000);
  }
}
