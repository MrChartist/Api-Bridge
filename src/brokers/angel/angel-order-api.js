/**
 * 📈 AngelOrderApi (AngelOne SmartAPI)
 * 
 * REST API for trading operations with AngelOne.
 * Mirrors the DhanOrderApi interface for drop-in multi-broker support.
 * API Docs: https://smartapi.angelone.in/docs
 */

const ANGEL_BASE_URL = 'https://apiconnect.angelone.in';

export class AngelOrderApi {
  constructor({ token, apiKey, clientCode, mock = false }) {
    this.token = token;
    this.apiKey = apiKey;
    this.clientCode = clientCode;
    this.mock = mock;
    if (mock) console.log('[ANGEL ORDER] 🎭 Mock mode — all trading APIs return simulated data');
  }

  async _fetch(endpoint, method = 'GET', body = null) {
    if (this.mock) return this._mockResponse(endpoint, method, body);

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
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': '00:00:00:00:00:00',
      }
    };
    if (body) options.body = JSON.stringify(body);

    try {
      const res = await fetch(url, options);
      const data = await res.json();
      if (!res.ok || data.status === false) {
        throw new Error(`Angel API Error: ${data.message || res.statusText}`);
      }
      return data.data || data;
    } catch (e) {
      console.error(`[ANGEL API] Error on ${endpoint}: ${e.message}`);
      throw e;
    }
  }

  // ── Mock Response Generator ──
  _mockResponse(endpoint, method, body) {
    const now = new Date().toISOString();
    const mockId = 'ANGEL_MOCK_' + Date.now();

    // Orders
    if (endpoint.includes('/placeOrder') && method === 'POST') {
      return { orderid: mockId, uniqueorderid: mockId, script: body?.tradingsymbol || 'MOCK', message: 'Order placed (mock)' };
    }
    if (endpoint.includes('/modifyOrder') && method === 'POST') {
      return { orderid: body?.orderid || mockId, message: 'Order modified (mock)' };
    }
    if (endpoint.includes('/cancelOrder') && method === 'POST') {
      return { orderid: body?.orderid || mockId, message: 'Order cancelled (mock)' };
    }
    if (endpoint.includes('/getOrderBook')) {
      return [
        { orderid: 'AMOCK_001', tradingsymbol: 'NIFTY03APR2524000CE', transactiontype: 'BUY', ordertype: 'MARKET', quantity: 50, price: '0', status: 'complete', updatetime: now, exchange: 'NFO', producttype: 'INTRADAY' },
        { orderid: 'AMOCK_002', tradingsymbol: 'BANKNIFTY03APR2551000PE', transactiontype: 'SELL', ordertype: 'LIMIT', quantity: 15, price: '245.50', status: 'open', updatetime: now, exchange: 'NFO', producttype: 'INTRADAY' }
      ];
    }

    // Trades
    if (endpoint.includes('/getTradeBook')) {
      return [
        { orderid: 'AMOCK_001', tradingsymbol: 'NIFTY03APR2524000CE', transactiontype: 'BUY', fillsize: 50, fillprice: '112.30', exchange: 'NFO', filltime: now }
      ];
    }

    // Positions
    if (endpoint.includes('/getPosition')) {
      return [
        { tradingsymbol: 'NIFTY03APR2524000CE', symbolname: 'NIFTY', transactiontype: 'BUY', netqty: '50', buyavgprice: '112.30', ltp: '118.45', pnl: '307.50', exchange: 'NFO', producttype: 'INTRADAY' },
        { tradingsymbol: 'BANKNIFTY03APR2551000PE', symbolname: 'BANKNIFTY', transactiontype: 'SELL', netqty: '-15', sellavgprice: '280.00', ltp: '265.20', pnl: '222.00', exchange: 'NFO', producttype: 'INTRADAY' }
      ];
    }

    // Holdings
    if (endpoint.includes('/getAllHolding')) {
      return [
        { tradingsymbol: 'RELIANCE-EQ', symbolname: 'RELIANCE', quantity: 10, averageprice: '2450.00', ltp: '2520.80', profitandloss: '708.00', exchange: 'NSE', isin: 'INE002A01018' },
        { tradingsymbol: 'TCS-EQ', symbolname: 'TCS', quantity: 5, averageprice: '3680.00', ltp: '3745.50', profitandloss: '327.50', exchange: 'NSE', isin: 'INE467B01029' },
        { tradingsymbol: 'INFY-EQ', symbolname: 'INFY', quantity: 20, averageprice: '1580.00', ltp: '1610.25', profitandloss: '605.00', exchange: 'NSE', isin: 'INE009A01021' }
      ];
    }

    // Funds / RMS
    if (endpoint.includes('/getRMS')) {
      return {
        availablecash: '247832.50',
        availableintradaypayin: '247832.50',
        collateral: '45000.00',
        utiliseddebits: '89250.00',
        net: '382082.50',
        m2munrealized: '1237.50',
        m2mrealized: '0',
      };
    }

    return { status: 'mock', message: `Mock: ${method} ${endpoint}` };
  }

  // ── Unified Interface (matches DhanOrderApi) ──

  async placeOrder(order) {
    // Normalize to Angel format
    const angelOrder = {
      variety: order.variety || 'NORMAL',
      tradingsymbol: order.tradingSymbol || order.tradingsymbol || order.symbol,
      symboltoken: order.symboltoken || order.securityId || '',
      transactiontype: (order.transactionType || order.action || 'BUY').toUpperCase(),
      exchange: this._mapExchange(order.exchangeSegment || order.exchange || 'NFO'),
      ordertype: (order.orderType || 'MARKET').toUpperCase(),
      producttype: this._mapProduct(order.productType || order.product || 'INTRADAY'),
      duration: order.validity || 'DAY',
      price: String(order.price || 0),
      squareoff: '0',
      stoploss: '0',
      quantity: String(order.quantity || 0),
      triggerprice: String(order.triggerPrice || 0),
    };
    return this._fetch('/rest/secure/angelbroking/order/v1/placeOrder', 'POST', angelOrder);
  }

  async modifyOrder(orderId, params) {
    const angelParams = {
      variety: params.variety || 'NORMAL',
      orderid: orderId,
      ordertype: (params.orderType || 'LIMIT').toUpperCase(),
      producttype: this._mapProduct(params.productType || params.product || 'INTRADAY'),
      duration: params.validity || 'DAY',
      price: String(params.price || 0),
      quantity: String(params.quantity || 0),
      tradingsymbol: params.tradingSymbol || params.symbol || '',
      symboltoken: params.symboltoken || params.securityId || '',
      exchange: this._mapExchange(params.exchangeSegment || params.exchange || 'NFO'),
      triggerprice: String(params.triggerPrice || 0),
    };
    return this._fetch('/rest/secure/angelbroking/order/v1/modifyOrder', 'POST', angelParams);
  }

  async cancelOrder(orderId) {
    return this._fetch('/rest/secure/angelbroking/order/v1/cancelOrder', 'POST', {
      variety: 'NORMAL',
      orderid: orderId,
    });
  }

  async getOrders() { return this._fetch('/rest/secure/angelbroking/order/v1/getOrderBook'); }
  async getTrades() { return this._fetch('/rest/secure/angelbroking/order/v1/getTradeBook'); }
  async getPositions() { return this._fetch('/rest/secure/angelbroking/order/v1/getPosition'); }
  async getHoldings() { return this._fetch('/rest/secure/angelbroking/portfolio/v1/getAllHolding'); }
  async getFunds() { return this._fetch('/rest/secure/angelbroking/user/v1/getRMS'); }

  async getOptionChain({ symbol, expiry }) {
    // Angel doesn't have a direct option chain REST API — return empty for now
    return { data: [] };
  }

  async getExpiryList(symbol) {
    return { data: [] };
  }

  // ── Helpers ──

  _mapExchange(seg) {
    const map = { 'NSE_EQ': 'NSE', 'NSE_FNO': 'NFO', 'BSE_EQ': 'BSE', 'BSE_FNO': 'BFO', 'MCX_COMM': 'MCX', 'MCX_FNO': 'MCX' };
    return map[seg] || seg;
  }

  _mapProduct(product) {
    const map = { 'INTRADAY': 'INTRADAY', 'CNC': 'DELIVERY', 'MARGIN': 'MARGIN', 'CO': 'CO', 'BO': 'BO' };
    return map[product?.toUpperCase()] || product;
  }
}
