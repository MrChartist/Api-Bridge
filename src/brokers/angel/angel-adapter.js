/**
 * ⚡ AngelAdapter (AngelOne / Angel Broking)
 * 
 * WebSocket + REST adapter for AngelOne SmartAPI.
 * API Docs: https://smartapi.angelone.in/docs
 */

import WebSocket from 'ws';
import { BaseBrokerAdapter } from '../base-adapter.js';

const ANGEL_BASE_URL = 'https://apiconnect.angelone.in';
const ANGEL_WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';

// Angel Exchange Type Mapping
const EXCHANGE_MAP = {
  'nse_cm': 1,    // NSE Cash
  'nse_fo': 2,    // NSE F&O
  'bse_cm': 3,    // BSE Cash
  'bse_fo': 4,    // BSE F&O
  'mcx_fo': 5,    // MCX
  'ncx_fo': 7,    // NCDEX
  'cde_fo': 13,   // CDS
};

export class AngelAdapter extends BaseBrokerAdapter {
  constructor(config) {
    super(config);
    this.name = 'Angel';
    this.ws = null;
    this.apiKey = config.apiKey;
    this.clientCode = config.clientCode;
    this.password = config.password;
    this.totp = config.totp;
    this.token = config.token; // JWT auth token
    this.feedToken = config.feedToken;
    this.onTick = config.onTick || (() => {});
    
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.securityIdMap = new Map();
  }

  async connect() {
    // Mock mode
    if (process.env.ANGEL_MOCK === 'true') {
      console.log(`[ANGEL] 🎭 MOCK MODE ENABLED`);
      this.connected = true;
      this._startMockGenerator();
      return true;
    }

    if (!this.token || !this.feedToken) {
      console.log('[ANGEL] Missing auth token or feed token');
      return false;
    }

    try {
      const headers = {
        'Authorization': `Bearer ${this.token}`,
        'x-api-key': this.apiKey,
        'x-client-code': this.clientCode,
        'x-feed-token': this.feedToken,
      };

      this.ws = new WebSocket(ANGEL_WS_URL, { headers });

      this.ws.on('open', () => {
        console.log(`[ANGEL] ✅ Connected to SmartAPI WebSocket`);
        this.connected = true;
        this.reconnectAttempts = 0;
        
        if (this.instruments.size > 0) {
          this._resubscribeAll();
        }
      });

      this.ws.on('message', (data) => this._handleMessage(data));

      this.ws.on('close', (code) => {
        console.log(`[ANGEL] ❌ Connection closed (code: ${code})`);
        this.connected = false;
        this._scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error(`[ANGEL] WebSocket Error: ${err.message}`);
      });

      return true;
    } catch (e) {
      console.error(`[ANGEL] Connection failed: ${e.message}`);
      return false;
    }
  }

  _scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), delay);
  }

  async disconnect() {
    if (this.mockInterval) clearInterval(this.mockInterval);
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.connected = false;
    console.log('[ANGEL] Disconnected.');
  }

  async unsubscribe(instruments) {
    if (!this.connected || !this.ws) return;
    const items = Array.isArray(instruments) ? instruments : [instruments];
    const grouped = {};
    items.forEach(inst => {
      const exchangeType = inst.exchangeType || EXCHANGE_MAP[inst.exchangeSegment] || 1;
      if (!grouped[exchangeType]) grouped[exchangeType] = [];
      grouped[exchangeType].push(String(inst.securityId || inst.token));
      this.securityIdMap.delete(String(inst.securityId || inst.token));
    });
    const tokenList = Object.entries(grouped).map(([exchangeType, tokens]) => ({
      exchangeType: parseInt(exchangeType), tokens
    }));
    const payload = JSON.stringify({
      correlationID: `mc_bridge_unsub_${Date.now()}`,
      action: 0, // 0 = unsubscribe
      params: { mode: 1, tokenList }
    });
    this.ws.send(payload);
  }

  async subscribe(instruments, mode = 'quote') {
    if (!this.connected || !this.ws) return;

    const modeMap = { 'ticker': 1, 'quote': 2, 'depth': 3 };
    const modeCode = modeMap[mode] || 2;

    const items = Array.isArray(instruments) ? instruments : [instruments];
    
    // Group by exchange
    const grouped = {};
    items.forEach(inst => {
      const exchangeType = inst.exchangeType || EXCHANGE_MAP[inst.exchangeSegment] || 1;
      if (!grouped[exchangeType]) grouped[exchangeType] = [];
      grouped[exchangeType].push(String(inst.securityId || inst.token));
      this.securityIdMap.set(String(inst.securityId || inst.token), inst);
    });

    const tokenList = Object.entries(grouped).map(([exchangeType, tokens]) => ({
      exchangeType: parseInt(exchangeType),
      tokens
    }));

    // Angel subscribe payload
    const payload = JSON.stringify({
      correlationID: `mc_bridge_${Date.now()}`,
      action: 1, // 1=subscribe, 0=unsubscribe
      params: {
        mode: modeCode,
        tokenList
      }
    });

    this.ws.send(payload);
  }

  _resubscribeAll() {
    const all = Array.from(this.instruments.values());
    this.subscribe(all, 'quote');
  }

  _handleMessage(rawData) {
    try {
      const buf = Buffer.from(rawData);
      
      // Angel sends binary data for market feed
      if (buf.length < 8) return;

      // Angel binary format: subscription_mode(1) + exchange_type(1) + token(25) + ...
      // Prices are in paise (divide by 100)
      const subscriptionMode = buf.readUInt8(0);
      const exchangeType = buf.readUInt8(1);
      const tokenStr = buf.subarray(2, 27).toString('utf8').replace(/\0/g, '').trim();
      
      const info = this.securityIdMap.get(tokenStr);
      if (!info) return;

      // LTP is at offset 27, 8 bytes (int64)
      if (buf.length >= 35) {
        const ltp = Number(buf.readBigInt64LE(27)) / 100;
        
        let tickData = {
          symbol: info.symbol || tokenStr,
          securityId: tokenStr,
          ltp,
          timestamp: Date.now(),
          source: 'angel'
        };

        // Quote mode has additional fields
        if (subscriptionMode >= 2 && buf.length >= 115) {
          tickData.volume = Number(buf.readBigInt64LE(35));
          tickData.open = Number(buf.readBigInt64LE(83)) / 100;
          tickData.high = Number(buf.readBigInt64LE(91)) / 100;
          tickData.low = Number(buf.readBigInt64LE(99)) / 100;
          tickData.close = Number(buf.readBigInt64LE(107)) / 100;
          
          if (tickData.close > 0) {
            tickData.change = Number((tickData.ltp - tickData.close).toFixed(2));
            tickData.changePct = Number(((tickData.change / tickData.close) * 100).toFixed(2));
          }
        }

        this.onTick(tickData);
      }
    } catch (e) {
      // Try JSON parse for non-binary messages
      try {
        const data = JSON.parse(rawData.toString());
        if (data.last_traded_price) {
          const info = this.securityIdMap.get(String(data.token));
          if (info) {
            this.onTick({
              symbol: info.symbol || data.token,
              ltp: data.last_traded_price / 100,
              volume: data.volume_trade_for_the_day || 0,
              timestamp: Date.now(),
              source: 'angel'
            });
          }
        }
      } catch (_) {}
    }
  }

  // --- REST API Methods ---

  async _fetch(endpoint, method = 'GET', body = null) {
    const url = `${ANGEL_BASE_URL}${endpoint}`;
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-PrivateKey': this.apiKey,
      }
    };
    if (body) options.body = JSON.stringify(body);
    
    const res = await fetch(url, options);
    return res.json();
  }

  async placeOrder(order) {
    return this._fetch('/rest/secure/angelbroking/order/v1/placeOrder', 'POST', order);
  }

  async getPositions() {
    return this._fetch('/rest/secure/angelbroking/order/v1/getPosition');
  }

  async getOrderBook() {
    return this._fetch('/rest/secure/angelbroking/order/v1/getOrderBook');
  }

  async getHoldings() {
    return this._fetch('/rest/secure/angelbroking/portfolio/v1/getAllHolding');
  }

  async getFunds() {
    return this._fetch('/rest/secure/angelbroking/user/v1/getRMS');
  }

  _startMockGenerator() {
    const symbols = ['NIFTY', 'BANKNIFTY', 'RELIANCE', 'TCS'];
    const prices = { 'NIFTY': 24000, 'BANKNIFTY': 52000, 'RELIANCE': 2800, 'TCS': 3500 };
    
    this.mockInterval = setInterval(() => {
      if (!this.connected) return;
      const symbol = symbols[Math.floor(Math.random() * symbols.length)];
      const current = prices[symbol];
      const change = (Math.random() - 0.5) * 5;
      prices[symbol] = current + change;
      
      this.onTick({
        symbol,
        securityId: '0',
        ltp: Number(prices[symbol].toFixed(2)),
        change: Number(change.toFixed(2)),
        changePct: Number(((change / current) * 100).toFixed(2)),
        timestamp: Date.now(),
        source: 'angel-mock'
      });
    }, 1000);
  }
}
