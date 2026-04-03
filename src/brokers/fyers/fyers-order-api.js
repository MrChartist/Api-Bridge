/**
 * 📈 FyersOrderApi (Fyers API v3)
 * 
 * REST API for trading operations with Fyers.
 * Mirrors the DhanOrderApi interface for drop-in multi-broker support.
 * API Docs: https://myapi.fyers.in/docsv3
 */

const FYERS_BASE_URL = 'https://api-t1.fyers.in/api/v3';

export class FyersOrderApi {
  constructor({ token, appId, mock = false }) {
    this.token = token;
    this.appId = appId;
    this.mock = mock;
    if (mock) console.log('[FYERS ORDER] 🎭 Mock mode — all trading APIs return simulated data');
  }

  async _fetch(endpoint, method = 'GET', body = null) {
    if (this.mock) return this._mockResponse(endpoint, method, body);

    const url = `${FYERS_BASE_URL}${endpoint}`;
    const options = {
      method,
      headers: {
        'Authorization': `${this.appId}:${this.token}`,
        'Content-Type': 'application/json',
      }
    };
    if (body) options.body = JSON.stringify(body);

    try {
      const res = await fetch(url, options);
      const data = await res.json();
      if (data.s !== 'ok' && data.code !== 200) {
        throw new Error(`Fyers API Error: ${data.message || res.statusText}`);
      }
      return data;
    } catch (e) {
      console.error(`[FYERS API] Error on ${endpoint}: ${e.message}`);
      throw e;
    }
  }

  // ── Mock Response Generator ──
  _mockResponse(endpoint, method, body) {
    const now = new Date().toISOString();
    const mockId = 'FYERS_MOCK_' + Date.now();

    // Orders
    if (endpoint === '/orders/sync' && method === 'POST') {
      return { s: 'ok', id: mockId, message: 'Order placed (mock)' };
    }
    if (endpoint.startsWith('/orders/') && method === 'PUT') {
      return { s: 'ok', id: endpoint.split('/').pop(), message: 'Order modified (mock)' };
    }
    if (endpoint.startsWith('/orders/') && method === 'DELETE') {
      return { s: 'ok', id: endpoint.split('/').pop(), message: 'Order cancelled (mock)' };
    }
    if (endpoint === '/orders' && method === 'GET') {
      return {
        s: 'ok',
        orderBook: [
          { id: 'FMOCK_001', symbol: 'NSE:NIFTY2540324000CE', side: 1, type: 2, qty: 50, tradedPrice: 0, status: 2, orderDateTime: now, segment: 11, productType: 'INTRADAY', filledQty: 50, limitPrice: 0 },
          { id: 'FMOCK_002', symbol: 'NSE:BANKNIFTY2540351000PE', side: -1, type: 1, qty: 15, tradedPrice: 245.50, status: 6, orderDateTime: now, segment: 11, productType: 'INTRADAY', filledQty: 0, limitPrice: 245.50 }
        ]
      };
    }

    // Trades
    if (endpoint === '/tradebook') {
      return {
        s: 'ok',
        tradeBook: [
          { id: 'FMOCK_001', symbol: 'NSE:NIFTY2540324000CE', side: 1, tradedQty: 50, tradePrice: 112.30, orderDateTime: now, segment: 11 }
        ]
      };
    }

    // Positions
    if (endpoint === '/positions') {
      return {
        s: 'ok',
        netPositions: [
          { symbol: 'NSE:NIFTY2540324000CE', side: 1, netQty: 50, avgPrice: 112.30, ltp: 118.45, pl: 307.50, segment: 11, productType: 'INTRADAY' },
          { symbol: 'NSE:BANKNIFTY2540351000PE', side: -1, netQty: -15, avgPrice: 280.00, ltp: 265.20, pl: 222.00, segment: 11, productType: 'INTRADAY' }
        ]
      };
    }

    // Holdings
    if (endpoint === '/holdings') {
      return {
        s: 'ok',
        holdings: [
          { symbol: 'NSE:RELIANCE-EQ', quantity: 10, costPrice: 2450.00, ltp: 2520.80, marketVal: 25208, pl: 708.00, isin: 'INE002A01018' },
          { symbol: 'NSE:TCS-EQ', quantity: 5, costPrice: 3680.00, ltp: 3745.50, marketVal: 18727.50, pl: 327.50, isin: 'INE467B01029' },
          { symbol: 'NSE:INFY-EQ', quantity: 20, costPrice: 1580.00, ltp: 1610.25, marketVal: 32205, pl: 605.00, isin: 'INE009A01021' }
        ]
      };
    }

    // Funds
    if (endpoint === '/funds') {
      return {
        s: 'ok',
        fund_limit: [
          { title: 'Total Balance', equityAmount: 382082.50, commodityAmount: 0 },
          { title: 'Utilized Amount', equityAmount: 89250.00, commodityAmount: 0 },
          { title: 'Available Balance', equityAmount: 247832.50, commodityAmount: 0 },
          { title: 'Collateral', equityAmount: 45000.00, commodityAmount: 0 },
          { title: 'Realized P&L', equityAmount: 0, commodityAmount: 0 },
          { title: 'Unrealized P&L', equityAmount: 1237.50, commodityAmount: 0 },
        ]
      };
    }

    return { s: 'ok', message: `Mock: ${method} ${endpoint}` };
  }

  // ── Unified Interface (matches DhanOrderApi) ──

  async placeOrder(order) {
    const fyersOrder = {
      symbol: order.tradingSymbol || order.symbol || '',
      qty: order.quantity || 0,
      type: this._mapOrderType(order.orderType || 'MARKET'),
      side: (order.transactionType || order.action || 'BUY').toUpperCase() === 'BUY' ? 1 : -1,
      productType: this._mapProduct(order.productType || order.product || 'INTRADAY'),
      limitPrice: order.orderType === 'LIMIT' ? (order.price || 0) : 0,
      stopPrice: order.triggerPrice || 0,
      validity: 'DAY',
      disclosedQty: 0,
      offlineOrder: false,
      stopLoss: 0,
      takeProfit: 0,
    };
    return this._fetch('/orders/sync', 'POST', fyersOrder);
  }

  async modifyOrder(orderId, params) {
    const fyersParams = {
      id: orderId,
      type: this._mapOrderType(params.orderType || 'LIMIT'),
      qty: params.quantity || 0,
      limitPrice: params.price || 0,
      stopPrice: params.triggerPrice || 0,
    };
    return this._fetch(`/orders/${orderId}`, 'PUT', fyersParams);
  }

  async cancelOrder(orderId) {
    return this._fetch(`/orders/${orderId}`, 'DELETE');
  }

  async getOrders() {
    const data = await this._fetch('/orders');
    return data.orderBook || [];
  }

  async getTrades() {
    const data = await this._fetch('/tradebook');
    return data.tradeBook || [];
  }

  async getPositions() {
    const data = await this._fetch('/positions');
    return data.netPositions || [];
  }

  async getHoldings() {
    const data = await this._fetch('/holdings');
    return data.holdings || [];
  }

  async getFunds() {
    const data = await this._fetch('/funds');
    // Normalize Fyers fund_limit array into a flat object
    const funds = {};
    if (data.fund_limit) {
      for (const item of data.fund_limit) {
        const key = item.title?.toLowerCase().replace(/\s+/g, '_');
        if (key) funds[key] = item.equityAmount;
      }
    }
    return {
      availableBalance: funds.available_balance || 0,
      availablecash: funds.available_balance || 0,
      collateralAmount: funds.collateral || 0,
      collateral: funds.collateral || 0,
      utilisedDebits: funds.utilized_amount || 0,
      utiliseddebits: funds.utilized_amount || 0,
      sodLimit: funds.total_balance || 0,
      openingBalance: funds.total_balance || 0,
      m2munrealized: funds['unrealized_p&l'] || funds.unrealized_pl || 0,
      unrealizedProfit: funds['unrealized_p&l'] || funds.unrealized_pl || 0,
    };
  }

  async getOptionChain({ symbol, expiry }) {
    return { data: [] };
  }

  async getExpiryList(symbol) {
    return { data: [] };
  }

  // ── Helpers ──

  _mapOrderType(type) {
    const map = { 'MARKET': 2, 'LIMIT': 1, 'SL': 3, 'SL-M': 4 };
    return map[type?.toUpperCase()] || 2;
  }

  _mapProduct(product) {
    const map = { 'INTRADAY': 'INTRADAY', 'CNC': 'CNC', 'MARGIN': 'MARGIN', 'CO': 'CO', 'BO': 'BO' };
    return map[product?.toUpperCase()] || 'INTRADAY';
  }
}
