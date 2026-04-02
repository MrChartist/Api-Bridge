/**
 * ⚡ FyersAdapter
 * 
 * WebSocket + REST adapter for Fyers API v3.
 * API Docs: https://myapi.fyers.in/docsv3
 */

import WebSocket from 'ws';
import { BaseBrokerAdapter } from '../base-adapter.js';

const FYERS_BASE_URL = 'https://api-t1.fyers.in/api/v3';
const FYERS_WS_URL = 'wss://socket.fyers.in/hsm/v3/feeds';
const FYERS_DATA_URL = 'https://api-t2.fyers.in/data';

export class FyersAdapter extends BaseBrokerAdapter {
  constructor(config) {
    super(config);
    this.name = 'Fyers';
    this.ws = null;
    this.appId = config.appId;
    this.token = config.token;      // access_token  
    this.onTick = config.onTick || (() => {});
    
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.symbolMap = new Map();
  }

  async connect() {
    if (process.env.FYERS_MOCK === 'true') {
      console.log(`[FYERS] 🎭 MOCK MODE ENABLED`);
      this.connected = true;
      this._startMockGenerator();
      return true;
    }

    if (!this.token) {
      console.log('[FYERS] Missing access token');
      return false;
    }

    try {
      // Fyers uses a data URL endpoint for WebSocket auth
      const wsUrl = `${FYERS_WS_URL}?access_token=${this.appId}:${this.token}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log(`[FYERS] ✅ Connected to Fyers WebSocket`);
        this.connected = true;
        this.reconnectAttempts = 0;
        
        if (this.instruments.size > 0) {
          this._resubscribeAll();
        }
      });

      this.ws.on('message', (data) => this._handleMessage(data));

      this.ws.on('close', (code) => {
        console.log(`[FYERS] ❌ Connection closed (code: ${code})`);
        this.connected = false;
        this._scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error(`[FYERS] WebSocket Error: ${err.message}`);
      });

      return true;
    } catch (e) {
      console.error(`[FYERS] Connection failed: ${e.message}`);
      return false;
    }
  }

  _scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), delay);
  }

  async subscribe(instruments, mode = 'quote') {
    if (!this.connected || !this.ws) return;

    const items = Array.isArray(instruments) ? instruments : [instruments];
    
    // Fyers uses format: NSE:NIFTY50-INDEX, NSE:RELIANCE-EQ
    const symbols = items.map(inst => {
      const fyersSymbol = inst.fyersSymbol || `NSE:${inst.symbol}-EQ`;
      this.symbolMap.set(fyersSymbol, inst);
      return fyersSymbol;
    });

    const payload = JSON.stringify({
      T: 'SUB',
      L: symbols,
      SUB_T: mode === 'depth' ? 2 : 1, // 1=LTP/Quote, 2=Depth
    });

    this.ws.send(payload);
  }

  _resubscribeAll() {
    const all = Array.from(this.instruments.values());
    this.subscribe(all, 'quote');
  }

  _handleMessage(rawData) {
    try {
      const data = JSON.parse(rawData.toString());
      
      if (data.d && Array.isArray(data.d)) {
        data.d.forEach(tick => {
          const info = this.symbolMap.get(tick.n) || { symbol: tick.n };
          
          this.onTick({
            symbol: info.symbol || tick.n,
            securityId: tick.n,
            ltp: tick.v?.lp || 0,
            open: tick.v?.open_price || 0,
            high: tick.v?.high_price || 0,
            low: tick.v?.low_price || 0,
            close: tick.v?.prev_close_price || 0,
            volume: tick.v?.volume || 0,
            change: tick.v?.ch || 0,
            changePct: tick.v?.chp || 0,
            timestamp: Date.now(),
            source: 'fyers'
          });
        });
      }
    } catch (e) {
      // Binary data handling
    }
  }

  // --- REST API ---

  async _fetch(endpoint, method = 'GET', body = null) {
    const url = `${FYERS_BASE_URL}${endpoint}`;
    const options = {
      method,
      headers: {
        'Authorization': `${this.appId}:${this.token}`,
        'Content-Type': 'application/json',
      }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(url, options);
    return res.json();
  }

  async placeOrder(order) { return this._fetch('/orders/sync', 'POST', order); }
  async getPositions() { return this._fetch('/positions'); }
  async getOrderBook() { return this._fetch('/orders'); }
  async getHoldings() { return this._fetch('/holdings'); }
  async getFunds() { return this._fetch('/funds'); }

  _startMockGenerator() {
    const symbols = ['NIFTY', 'BANKNIFTY', 'SBIN', 'HDFC'];
    const prices = { 'NIFTY': 24000, 'BANKNIFTY': 52000, 'SBIN': 780, 'HDFC': 1650 };
    
    this.mockInterval = setInterval(() => {
      if (!this.connected) return;
      const symbol = symbols[Math.floor(Math.random() * symbols.length)];
      const current = prices[symbol];
      const change = (Math.random() - 0.5) * 5;
      prices[symbol] = current + change;
      this.onTick({
        symbol, securityId: '0',
        ltp: Number(prices[symbol].toFixed(2)),
        change: Number(change.toFixed(2)),
        changePct: Number(((change / current) * 100).toFixed(2)),
        timestamp: Date.now(), source: 'fyers-mock'
      });
    }, 1000);
  }
}
