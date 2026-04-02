/**
 * 📈 DhanOrderApi
 * 
 * Handles REST API interactions with Dhan for trading operations:
 * - Order placement, modification, cancellation
 * - Fetching positions, holdings, order book
 * - Margin and funds calculation
 */


const DHAN_BASE_URL = 'https://api.dhan.co/v2';

export class DhanOrderApi {
  constructor({ token, clientId }) {
    this.token = token;
    this.clientId = clientId;
  }

  /**
   * Internal helper to make authorized POST/GET requests to Dhan
   */
  async _fetch(endpoint, method = 'GET', body = null) {
    const url = `${DHAN_BASE_URL}${endpoint}`;
    const options = {
      method,
      headers: {
        'access-token': this.token,
        'client-id': this.clientId,
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    try {
      const res = await fetch(url, options);
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(`Dhan API Error: ${data.message || res.statusText}`);
      }
      
      return data;
    } catch (e) {
      console.error(`[DHAN API] Error on ${endpoint}: ${e.message}`);
      throw e;
    }
  }

  // --- Order Operations ---

  async placeOrder(order) {
    return this._fetch('/orders', 'POST', order);
  }

  async modifyOrder(orderId, modifiedParams) {
    return this._fetch(`/orders/${orderId}`, 'PUT', modifiedParams);
  }

  async cancelOrder(orderId) {
    return this._fetch(`/orders/${orderId}`, 'DELETE');
  }

  // --- Book Operations ---

  async getOrders() {
    return this._fetch('/orders', 'GET');
  }

  async getTrades() {
    return this._fetch('/trades', 'GET');
  }

  async getPositions() {
    return this._fetch('/positions', 'GET');
  }

  async getHoldings() {
    return this._fetch('/holdings', 'GET');
  }

  // --- Fund Operations ---

  async getFunds() {
    return this._fetch('/fundlimit', 'GET');
  }

  // --- Market Data (REST fallback) ---

  async getOptionChain({ symbol, expiry, instrumentType = 'OPTIDX' }) {
    return this._fetch('/optionchain', 'POST', {
      underlyingSymbol: symbol,
      expiryDate: expiry,
      instrumentType
    });
  }

  async getExpiryList(symbol, instrumentType = 'OPTIDX') {
    return this._fetch('/optionchain/expirylist', 'POST', {
      underlyingSymbol: symbol,
      instrumentType
    });
  }
}
