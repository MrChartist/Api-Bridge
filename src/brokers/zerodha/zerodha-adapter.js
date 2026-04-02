/**
 * ⚡ ZerodhaAdapter (Kite Connect)
 * 
 * WebSocket + REST adapter for Zerodha Kite Connect API v3.
 * API Docs: https://kite.trade/docs/connect/v3/
 */

import WebSocket from 'ws';
import { BaseBrokerAdapter } from '../base-adapter.js';

const KITE_BASE_URL = 'https://api.kite.trade';
const KITE_WS_URL = 'wss://ws.kite.trade';

// Kite Exchange Identifiers
const KITE_EXCHANGE = {
  'NSE': 'NSE',
  'BSE': 'BSE',
  'NFO': 'NFO',
  'BFO': 'BFO',
  'MCX': 'MCX',
  'CDS': 'CDS',
};

export class ZerodhaAdapter extends BaseBrokerAdapter {
  constructor(config) {
    super(config);
    this.name = 'Zerodha';
    this.ws = null;
    this.apiKey = config.apiKey;
    this.token = config.token;    // access_token
    this.onTick = config.onTick || (() => {});
    
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.tokenMap = new Map(); // instrument_token -> info
  }

  async connect() {
    if (process.env.ZERODHA_MOCK === 'true') {
      console.log(`[ZERODHA] 🎭 MOCK MODE ENABLED`);
      this.connected = true;
      this._startMockGenerator();
      return true;
    }

    if (!this.token || !this.apiKey) {
      console.log('[ZERODHA] Missing API key or access token');
      return false;
    }

    try {
      const wsUrl = `${KITE_WS_URL}?api_key=${this.apiKey}&access_token=${this.token}`;
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.on('open', () => {
        console.log(`[ZERODHA] ✅ Connected to Kite WebSocket`);
        this.connected = true;
        this.reconnectAttempts = 0;
        
        if (this.instruments.size > 0) {
          this._resubscribeAll();
        }
      });

      this.ws.on('message', (data) => this._handleBinaryMessage(Buffer.from(data)));

      this.ws.on('close', (code) => {
        console.log(`[ZERODHA] ❌ Connection closed (code: ${code})`);
        this.connected = false;
        this._scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error(`[ZERODHA] WebSocket Error: ${err.message}`);
      });

      return true;
    } catch (e) {
      console.error(`[ZERODHA] Connection failed: ${e.message}`);
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
    const tokens = items.map(inst => {
      const token = inst.instrumentToken || inst.securityId;
      this.tokenMap.set(token, inst);
      return token;
    });

    // Kite subscribe message
    const message = JSON.stringify({
      a: 'subscribe',
      v: tokens
    });
    this.ws.send(message);

    // Set mode
    const modeMap = { 'ticker': 'ltp', 'quote': 'quote', 'depth': 'full' };
    const setMode = JSON.stringify({
      a: 'mode',
      v: [modeMap[mode] || 'quote', tokens]
    });
    this.ws.send(setMode);
  }

  _resubscribeAll() {
    const all = Array.from(this.instruments.values());
    this.subscribe(all, 'quote');
  }

  _handleBinaryMessage(buf) {
    if (buf.length < 2) return;

    // Check for text messages (heartbeat, etc.)
    try {
      const text = buf.toString('utf8');
      if (text.startsWith('{')) {
        // JSON message (error or info)
        return;
      }
    } catch (_) {}

    // Kite binary format: number_of_packets(2) + [packet_length(2) + packet_data]...
    const numPackets = buf.readInt16BE(0);
    let offset = 2;

    for (let i = 0; i < numPackets; i++) {
      if (offset + 2 > buf.length) break;
      const packetLen = buf.readInt16BE(offset);
      offset += 2;

      if (offset + packetLen > buf.length) break;
      const packet = buf.subarray(offset, offset + packetLen);
      offset += packetLen;

      this._parsePacket(packet, packetLen);
    }
  }

  _parsePacket(packet, len) {
    if (len < 8) return;

    const instrumentToken = packet.readInt32BE(0);
    const info = this.tokenMap.get(instrumentToken);
    if (!info) return;

    if (len === 8) {
      // LTP mode: token(4) + ltp(4)
      const ltp = packet.readInt32BE(4) / 100;
      this.onTick({ symbol: info.symbol, securityId: instrumentToken, ltp, timestamp: Date.now(), source: 'zerodha' });
    } else if (len === 44 || len === 184) {
      // Quote mode (44 bytes) or Full mode (184 bytes)
      const ltp = packet.readInt32BE(4) / 100;
      const high = packet.readInt32BE(8) / 100;
      const low = packet.readInt32BE(12) / 100;
      const open = packet.readInt32BE(16) / 100;
      const close = packet.readInt32BE(20) / 100;
      const volume = packet.readUInt32BE(28);
      
      const change = ltp - close;
      const changePct = close > 0 ? (change / close) * 100 : 0;

      this.onTick({
        symbol: info.symbol,
        securityId: instrumentToken,
        ltp, open, high, low, close, volume,
        change: Number(change.toFixed(2)),
        changePct: Number(changePct.toFixed(2)),
        timestamp: Date.now(),
        source: 'zerodha'
      });
    }
  }

  // --- REST API ---
  
  async _fetch(endpoint, method = 'GET', body = null) {
    const url = `${KITE_BASE_URL}${endpoint}`;
    const options = {
      method,
      headers: {
        'X-Kite-Version': '3',
        'Authorization': `token ${this.apiKey}:${this.token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    };
    if (body) {
      options.body = new URLSearchParams(body).toString();
    }
    const res = await fetch(url, options);
    return res.json();
  }

  async placeOrder(order) { return this._fetch('/orders/regular', 'POST', order); }
  async getPositions() { return this._fetch('/portfolio/positions'); }
  async getOrderBook() { return this._fetch('/orders'); }
  async getHoldings() { return this._fetch('/portfolio/holdings'); }
  async getFunds() { return this._fetch('/user/margins'); }

  _startMockGenerator() {
    const symbols = ['NIFTY', 'BANKNIFTY', 'INFY', 'WIPRO'];
    const prices = { 'NIFTY': 24000, 'BANKNIFTY': 52000, 'INFY': 1550, 'WIPRO': 450 };
    
    this.mockInterval = setInterval(() => {
      if (!this.connected) return;
      const symbol = symbols[Math.floor(Math.random() * symbols.length)];
      const current = prices[symbol];
      const change = (Math.random() - 0.5) * 5;
      prices[symbol] = current + change;
      this.onTick({
        symbol, securityId: 0,
        ltp: Number(prices[symbol].toFixed(2)),
        change: Number(change.toFixed(2)),
        changePct: Number(((change / current) * 100).toFixed(2)),
        timestamp: Date.now(), source: 'zerodha-mock'
      });
    }, 1000);
  }
}
