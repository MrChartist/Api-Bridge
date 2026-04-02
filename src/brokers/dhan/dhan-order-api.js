/**
 * 📈 DhanOrderApi
 * 
 * Handles REST API interactions with Dhan for trading operations.
 * Supports MOCK mode for development/testing without live credentials.
 */

const DHAN_BASE_URL = 'https://api.dhan.co/v2';

export class DhanOrderApi {
  constructor({ token, clientId, mock = false }) {
    this.token = token;
    this.clientId = clientId;
    this.mock = mock;
    if (mock) console.log('[DHAN ORDER] 🎭 Mock mode — all trading APIs return simulated data');
  }

  async _fetch(endpoint, method = 'GET', body = null) {
    // Mock mode — return simulated data
    if (this.mock) return this._mockResponse(endpoint, method, body);

    const url = `${DHAN_BASE_URL}${endpoint}`;
    const options = {
      method,
      headers: {
        'access-token': this.token,
        'client-id': this.clientId,
        'Content-Type': 'application/json'
      }
    };
    if (body) options.body = JSON.stringify(body);

    try {
      const res = await fetch(url, options);
      const data = await res.json();
      if (!res.ok) throw new Error(`Dhan API Error: ${data.message || res.statusText}`);
      return data;
    } catch (e) {
      console.error(`[DHAN API] Error on ${endpoint}: ${e.message}`);
      throw e;
    }
  }

  // ── Mock Response Generator ──
  _mockResponse(endpoint, method, body) {
    const now = new Date().toISOString();
    const mockId = 'MOCK_' + Date.now();

    // Orders
    if (endpoint === '/orders' && method === 'POST') {
      return { orderId: mockId, orderStatus: 'PENDING', tradingSymbol: body?.tradingSymbol || 'MOCK', transactionType: body?.transactionType || 'BUY', quantity: body?.quantity || 0, price: body?.price || 0, orderType: body?.orderType || 'MARKET', createTime: now };
    }
    if (endpoint.startsWith('/orders/') && method === 'PUT') {
      return { orderId: endpoint.split('/').pop(), orderStatus: 'MODIFIED', message: 'Order modified (mock)' };
    }
    if (endpoint.startsWith('/orders/') && method === 'DELETE') {
      return { orderId: endpoint.split('/').pop(), orderStatus: 'CANCELLED', message: 'Order cancelled (mock)' };
    }
    if (endpoint === '/orders' && method === 'GET') {
      return [
        { orderId: 'MOCK_001', tradingSymbol: 'NIFTY 03APR 24000 CE', transactionType: 'BUY', orderType: 'MARKET', quantity: 50, price: 0, orderStatus: 'TRADED', createTime: now, exchangeSegment: 'NSE_FNO' },
        { orderId: 'MOCK_002', tradingSymbol: 'BANKNIFTY 03APR 51000 PE', transactionType: 'SELL', orderType: 'LIMIT', quantity: 15, price: 245.50, orderStatus: 'PENDING', createTime: now, exchangeSegment: 'NSE_FNO' }
      ];
    }

    // Trades
    if (endpoint === '/trades') {
      return [
        { orderId: 'MOCK_001', tradingSymbol: 'NIFTY 03APR 24000 CE', transactionType: 'BUY', tradedQuantity: 50, tradedPrice: 112.30, exchangeSegment: 'NSE_FNO', tradedTime: now }
      ];
    }

    // Positions 
    if (endpoint === '/positions') {
      return [
        { tradingSymbol: 'NIFTY 03APR 24000 CE', positionType: 'LONG', netQty: 50, costPrice: 112.30, ltp: 118.45, realizedProfit: 0, unrealizedProfit: 307.50, exchangeSegment: 'NSE_FNO', productType: 'INTRADAY' },
        { tradingSymbol: 'BANKNIFTY 03APR 51000 PE', positionType: 'SHORT', netQty: -15, costPrice: 280.00, ltp: 265.20, realizedProfit: 0, unrealizedProfit: 222.00, exchangeSegment: 'NSE_FNO', productType: 'INTRADAY' }
      ];
    }

    // Holdings
    if (endpoint === '/holdings') {
      return [
        { tradingSymbol: 'RELIANCE', exchange: 'NSE', totalQty: 10, avgCostPrice: 2450.00, ltp: 2520.80, unrealizedProfit: 708.00, isin: 'INE002A01018' },
        { tradingSymbol: 'TCS', exchange: 'NSE', totalQty: 5, avgCostPrice: 3680.00, ltp: 3745.50, unrealizedProfit: 327.50, isin: 'INE467B01029' },
        { tradingSymbol: 'INFY', exchange: 'NSE', totalQty: 20, avgCostPrice: 1580.00, ltp: 1610.25, unrealizedProfit: 605.00, isin: 'INE009A01021' }
      ];
    }

    // Funds
    if (endpoint === '/fundlimit') {
      return {
        availableBalance: 247832.50,
        availablecash: 247832.50,
        collateralAmount: 45000.00,
        collateral: 45000.00,
        utilisedDebits: 89250.00,
        utiliseddebits: 89250.00,
        sodLimit: 382082.50,
        openingBalance: 382082.50,
        m2munrealized: 1237.50,
        unrealizedProfit: 1237.50,
        receivables: 0,
        blockedPayoutAmount: 0
      };
    }

    // Option Chain
    if (endpoint === '/optionchain') {
      return { data: [] };
    }
    if (endpoint === '/optionchain/expirylist') {
      return { data: [] };
    }

    // Charts (History)
    if (endpoint.startsWith('/charts/')) {
      const n = 20;
      const base = 24000;
      return {
        open: Array.from({length:n}, (_,i) => base + Math.sin(i)*100),
        high: Array.from({length:n}, (_,i) => base + Math.sin(i)*100 + 80),
        low: Array.from({length:n}, (_,i) => base + Math.sin(i)*100 - 60),
        close: Array.from({length:n}, (_,i) => base + Math.sin(i)*100 + 20),
        volume: Array.from({length:n}, () => Math.floor(Math.random()*1000000) + 500000),
        timestamp: Array.from({length:n}, (_,i) => Math.floor(Date.now()/1000) - (n-i)*86400)
      };
    }

    return { status: 'mock', message: `Mock: ${method} ${endpoint}` };
  }

  // ── Order Operations ──
  async placeOrder(order) { return this._fetch('/orders', 'POST', order); }
  async modifyOrder(orderId, params) { return this._fetch(`/orders/${orderId}`, 'PUT', params); }
  async cancelOrder(orderId) { return this._fetch(`/orders/${orderId}`, 'DELETE'); }

  // ── Book Operations ──
  async getOrders() { return this._fetch('/orders', 'GET'); }
  async getTrades() { return this._fetch('/trades', 'GET'); }
  async getPositions() { return this._fetch('/positions', 'GET'); }
  async getHoldings() { return this._fetch('/holdings', 'GET'); }

  // ── Fund Operations ──
  async getFunds() { return this._fetch('/fundlimit', 'GET'); }

  // ── Market Data (REST fallback) ──
  async getOptionChain({ symbol, expiry, instrumentType = 'OPTIDX' }) {
    return this._fetch('/optionchain', 'POST', { underlyingSymbol: symbol, expiryDate: expiry, instrumentType });
  }
  async getExpiryList(symbol, instrumentType = 'OPTIDX') {
    return this._fetch('/optionchain/expirylist', 'POST', { underlyingSymbol: symbol, instrumentType });
  }
}
