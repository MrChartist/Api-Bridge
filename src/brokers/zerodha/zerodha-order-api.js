/**
 * 📈 ZerodhaOrderApi (Kite Connect v3)
 * 
 * REST API for trading operations with Zerodha Kite.
 * Mirrors the DhanOrderApi interface for drop-in multi-broker support.
 * API Docs: https://kite.trade/docs/connect/v3/
 * 
 * Note: Kite uses form-urlencoded for POST/PUT, not JSON.
 */

const KITE_BASE_URL = 'https://api.kite.trade';

export class ZerodhaOrderApi {
  constructor({ token, apiKey, mock = false }) {
    this.token = token;
    this.apiKey = apiKey;
    this.mock = mock;
    if (mock) console.log('[ZERODHA ORDER] 🎭 Mock mode — all trading APIs return simulated data');
  }

  async _fetch(endpoint, method = 'GET', body = null) {
    if (this.mock) return this._mockResponse(endpoint, method, body);

    const url = `${KITE_BASE_URL}${endpoint}`;
    const options = {
      method,
      headers: {
        'X-Kite-Version': '3',
        'Authorization': `token ${this.apiKey}:${this.token}`,
      }
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      // Kite uses form-urlencoded, not JSON
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.body = new URLSearchParams(body).toString();
    }

    try {
      const res = await fetch(url, options);
      const data = await res.json();
      if (data.status === 'error') {
        throw new Error(`Kite API Error: ${data.message || res.statusText}`);
      }
      return data.data || data;
    } catch (e) {
      console.error(`[ZERODHA API] Error on ${endpoint}: ${e.message}`);
      throw e;
    }
  }

  // ── Mock Response Generator ──
  _mockResponse(endpoint, method, body) {
    const now = new Date().toISOString();
    const mockId = 'KITE_MOCK_' + Date.now();

    // Place order
    if (endpoint === '/orders/regular' && method === 'POST') {
      return { order_id: mockId };
    }
    // Modify
    if (endpoint.match(/\/orders\/regular\/\w+/) && method === 'PUT') {
      return { order_id: endpoint.split('/').pop() };
    }
    // Cancel
    if (endpoint.match(/\/orders\/regular\/\w+/) && method === 'DELETE') {
      return { order_id: endpoint.split('/').pop() };
    }

    // Order book
    if (endpoint === '/orders' && method === 'GET') {
      return [
        { order_id: 'KMOCK_001', tradingsymbol: 'NIFTY2540324000CE', transaction_type: 'BUY', order_type: 'MARKET', quantity: 50, price: 0, status: 'COMPLETE', order_timestamp: now, exchange: 'NFO', product: 'MIS', filled_quantity: 50, average_price: 112.30 },
        { order_id: 'KMOCK_002', tradingsymbol: 'BANKNIFTY2540351000PE', transaction_type: 'SELL', order_type: 'LIMIT', quantity: 15, price: 245.50, status: 'OPEN', order_timestamp: now, exchange: 'NFO', product: 'MIS', filled_quantity: 0, average_price: 0 }
      ];
    }

    // Trades
    if (endpoint === '/trades') {
      return [
        { trade_id: 'KTRADE_001', order_id: 'KMOCK_001', tradingsymbol: 'NIFTY2540324000CE', transaction_type: 'BUY', quantity: 50, average_price: 112.30, exchange: 'NFO', fill_timestamp: now }
      ];
    }

    // Positions
    if (endpoint === '/portfolio/positions') {
      return {
        net: [
          { tradingsymbol: 'NIFTY2540324000CE', quantity: 50, average_price: 112.30, last_price: 118.45, pnl: 307.50, exchange: 'NFO', product: 'MIS', buy_quantity: 50, sell_quantity: 0 },
          { tradingsymbol: 'BANKNIFTY2540351000PE', quantity: -15, average_price: 280.00, last_price: 265.20, pnl: 222.00, exchange: 'NFO', product: 'MIS', buy_quantity: 0, sell_quantity: 15 }
        ],
        day: []
      };
    }

    // Holdings
    if (endpoint === '/portfolio/holdings') {
      return [
        { tradingsymbol: 'RELIANCE', quantity: 10, average_price: 2450.00, last_price: 2520.80, pnl: 708.00, exchange: 'NSE', isin: 'INE002A01018', t1_quantity: 0 },
        { tradingsymbol: 'TCS', quantity: 5, average_price: 3680.00, last_price: 3745.50, pnl: 327.50, exchange: 'NSE', isin: 'INE467B01029', t1_quantity: 0 },
        { tradingsymbol: 'INFY', quantity: 20, average_price: 1580.00, last_price: 1610.25, pnl: 605.00, exchange: 'NSE', isin: 'INE009A01021', t1_quantity: 0 }
      ];
    }

    // Margins / Funds
    if (endpoint === '/user/margins') {
      return {
        equity: {
          enabled: true,
          net: 382082.50,
          available: { cash: 247832.50, collateral: 45000.00, intraday_payin: 0, adhoc_margin: 0, live_balance: 247832.50 },
          utilised: { debits: 89250.00, m2m_unrealised: 1237.50, m2m_realised: 0, delivery: 0, exposure: 45000.00, span: 44250.00, option_premium: 0 }
        },
        commodity: { enabled: false }
      };
    }

    return { status: 'mock', message: `Mock: ${method} ${endpoint}` };
  }

  // ── Unified Interface (matches DhanOrderApi) ──

  async placeOrder(order) {
    const kiteOrder = {
      tradingsymbol: order.tradingSymbol || order.tradingsymbol || order.symbol,
      exchange: this._mapExchange(order.exchangeSegment || order.exchange || 'NFO'),
      transaction_type: (order.transactionType || order.action || 'BUY').toUpperCase(),
      order_type: (order.orderType || 'MARKET').toUpperCase(),
      product: this._mapProduct(order.productType || order.product || 'INTRADAY'),
      quantity: String(order.quantity || 0),
      price: String(order.price || 0),
      trigger_price: String(order.triggerPrice || 0),
      validity: order.validity || 'DAY',
      disclosed_quantity: '0',
    };
    return this._fetch('/orders/regular', 'POST', kiteOrder);
  }

  async modifyOrder(orderId, params) {
    const kiteParams = {
      order_type: (params.orderType || 'LIMIT').toUpperCase(),
      quantity: String(params.quantity || 0),
      price: String(params.price || 0),
      trigger_price: String(params.triggerPrice || 0),
      validity: params.validity || 'DAY',
      disclosed_quantity: '0',
    };
    return this._fetch(`/orders/regular/${orderId}`, 'PUT', kiteParams);
  }

  async cancelOrder(orderId) {
    return this._fetch(`/orders/regular/${orderId}`, 'DELETE');
  }

  async getOrders() {
    return this._fetch('/orders');
  }

  async getTrades() {
    return this._fetch('/trades');
  }

  async getPositions() {
    const data = await this._fetch('/portfolio/positions');
    // Kite returns { net: [...], day: [...] }, normalize to net
    return data?.net || data || [];
  }

  async getHoldings() {
    return this._fetch('/portfolio/holdings');
  }

  async getFunds() {
    const data = await this._fetch('/user/margins');
    // Normalize Kite margin structure to flat object
    const eq = data?.equity || {};
    return {
      availableBalance: eq.available?.cash || eq.available?.live_balance || 0,
      availablecash: eq.available?.cash || 0,
      collateralAmount: eq.available?.collateral || 0,
      collateral: eq.available?.collateral || 0,
      utilisedDebits: eq.utilised?.debits || 0,
      utiliseddebits: eq.utilised?.debits || 0,
      sodLimit: eq.net || 0,
      openingBalance: eq.net || 0,
      m2munrealized: eq.utilised?.m2m_unrealised || 0,
      unrealizedProfit: eq.utilised?.m2m_unrealised || 0,
    };
  }

  async getOptionChain({ symbol, expiry }) {
    return { data: [] };
  }

  async getExpiryList(symbol) {
    return { data: [] };
  }

  // ── Helpers ──

  _mapExchange(seg) {
    const map = { 'NSE_EQ': 'NSE', 'NSE_FNO': 'NFO', 'BSE_EQ': 'BSE', 'BSE_FNO': 'BFO', 'MCX_COMM': 'MCX', 'MCX_FNO': 'MCX', 'IDX_I': 'NSE' };
    return map[seg] || seg;
  }

  _mapProduct(product) {
    const map = { 'INTRADAY': 'MIS', 'CNC': 'CNC', 'MARGIN': 'MIS', 'NRML': 'NRML', 'CO': 'CO', 'BO': 'BO' };
    return map[product?.toUpperCase()] || 'MIS';
  }
}
