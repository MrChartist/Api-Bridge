/**
 * 📈 Smart Order Router
 *
 * Handles advanced order operations:
 * - Auto-split large orders by exchange freeze quantity
 * - Basket/multi-leg orders (spreads, straddles, strangles)
 * - Close all positions
 * - Position square-off
 */

// NSE Freeze quantities (lots) for popular indices
const FREEZE_QTY = {
  NIFTY: 1800,
  BANKNIFTY: 900,
  FINNIFTY: 1800,
  MIDCPNIFTY: 2800,
  SENSEX: 1000,
  BANKEX: 900,
  DEFAULT: 1800
};

export class SmartOrderRouter {
  constructor({ orderApi, instrumentManager, cache }) {
    this.orderApi = orderApi;
    this.instrumentManager = instrumentManager;
    this.cache = cache;
  }

  /**
   * Place a smart order — auto-splits if quantity exceeds freeze limit
   */
  async placeSmartOrder({ symbol, action, quantity, orderType = 'MARKET', price = 0, product = 'INTRADAY', exchange = 'NSE_FNO', splitSize }) {
    const freezeQty = splitSize || this._getFreezeQty(symbol);

    // If within freeze limit, place single order
    if (quantity <= freezeQty) {
      return this._placeSingle({ symbol, action, quantity, orderType, price, product, exchange });
    }

    // Split into batches
    const batches = [];
    let remaining = quantity;
    while (remaining > 0) {
      const qty = Math.min(remaining, freezeQty);
      batches.push(qty);
      remaining -= qty;
    }

    console.log(`[SMART] Splitting ${symbol} ${action} ${quantity} into ${batches.length} orders (freeze=${freezeQty})`);

    const results = [];
    for (let i = 0; i < batches.length; i++) {
      try {
        const result = await this._placeSingle({
          symbol, action, quantity: batches[i], orderType, price, product, exchange
        });
        results.push({ batch: i + 1, quantity: batches[i], status: 'success', data: result });
        
        // Small delay between batch orders to avoid rate limiting
        if (i < batches.length - 1) await sleep(200);
      } catch (err) {
        results.push({ batch: i + 1, quantity: batches[i], status: 'error', error: err.message });
      }
    }

    const successful = results.filter(r => r.status === 'success').length;
    return {
      status: successful === batches.length ? 'success' : 'partial',
      totalBatches: batches.length,
      successful,
      failed: batches.length - successful,
      totalQuantity: quantity,
      freezeQty,
      orders: results
    };
  }

  /**
   * Place a basket (multi-leg) order
   * Used for spreads, straddles, strangles, iron condors etc.
   */
  async placeBasketOrder({ legs, tag = '' }) {
    if (!legs || !Array.isArray(legs) || legs.length === 0) {
      throw new Error('legs array is required and must not be empty');
    }

    const results = [];
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      try {
        const result = await this.placeSmartOrder({
          symbol: leg.symbol,
          action: leg.action,
          quantity: leg.quantity,
          orderType: leg.orderType || 'MARKET',
          price: leg.price || 0,
          product: leg.product || 'INTRADAY',
          exchange: leg.exchange || 'NSE_FNO'
        });
        results.push({ leg: i + 1, symbol: leg.symbol, status: 'success', data: result });
      } catch (err) {
        results.push({ leg: i + 1, symbol: leg.symbol, status: 'error', error: err.message });
      }
    }

    return {
      status: results.every(r => r.status === 'success') ? 'success' : 'partial',
      totalLegs: legs.length,
      tag,
      legs: results
    };
  }

  /**
   * Close all open positions
   */
  async closeAllPositions({ product } = {}) {
    let positions;
    try {
      positions = await this.orderApi.getPositions();
    } catch (err) {
      throw new Error(`Failed to fetch positions: ${err.message}`);
    }

    // Filter to only open positions with non-zero quantity
    const open = (Array.isArray(positions) ? positions : [])
      .filter(p => {
        const qty = parseInt(p.netQty || p.quantity || 0);
        if (qty === 0) return false;
        if (product && p.productType !== product && p.product !== product) return false;
        return true;
      });

    if (open.length === 0) {
      return { status: 'success', message: 'No open positions to close', closed: 0 };
    }

    const results = [];
    for (const pos of open) {
      const qty = Math.abs(parseInt(pos.netQty || pos.quantity || 0));
      const action = parseInt(pos.netQty || pos.quantity || 0) > 0 ? 'SELL' : 'BUY';
      const symbol = pos.tradingSymbol || pos.symbol;
      const exch = pos.exchangeSegment || pos.exchange || 'NSE_FNO';
      const prod = pos.productType || pos.product || 'INTRADAY';

      try {
        const result = await this.placeSmartOrder({
          symbol, action, quantity: qty,
          orderType: 'MARKET', product: prod, exchange: exch
        });
        results.push({ symbol, action, quantity: qty, status: 'success', data: result });
      } catch (err) {
        results.push({ symbol, action, quantity: qty, status: 'error', error: err.message });
      }
    }

    return {
      status: results.every(r => r.status === 'success') ? 'success' : 'partial',
      totalPositions: open.length,
      closed: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'error').length,
      results
    };
  }

  /**
   * Cancel all open/pending orders
   */
  async cancelAllOrders() {
    let orders;
    try {
      orders = await this.orderApi.getOrders();
    } catch(err) {
      throw new Error(`Failed to fetch orders: ${err.message}`);
    }

    const pending = (Array.isArray(orders) ? orders : [])
      .filter(o => {
        const status = (o.orderStatus || o.status || '').toUpperCase();
        return status === 'PENDING' || status === 'OPEN' || status === 'TRIGGER_PENDING' || status === 'AMO';
      });

    if (pending.length === 0) {
      return { status: 'success', message: 'No pending orders to cancel', cancelled: 0 };
    }

    const results = [];
    for (const order of pending) {
      const orderId = order.orderId || order.order_id;
      try {
        await this.orderApi.cancelOrder(orderId);
        results.push({ orderId, status: 'cancelled' });
      } catch (err) {
        results.push({ orderId, status: 'error', error: err.message });
      }
    }

    return {
      status: 'success',
      totalPending: pending.length,
      cancelled: results.filter(r => r.status === 'cancelled').length,
      results
    };
  }

  /**
   * Get freeze quantity info
   */
  getFreezeQuantities() {
    return Object.entries(FREEZE_QTY).map(([symbol, qty]) => ({ symbol, freezeQty: qty }));
  }

  // ── Internal ──

  _getFreezeQty(symbol) {
    // Extract underlying from symbol (e.g. NIFTY02APR2524000CE -> NIFTY)
    const underlying = symbol.replace(/\d+.*$/, '');
    return FREEZE_QTY[underlying] || FREEZE_QTY.DEFAULT;
  }

  async _placeSingle({ symbol, action, quantity, orderType, price, product, exchange }) {
    // Map to Dhan order format
    const order = {
      transactionType: action.toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
      exchangeSegment: exchange,
      productType: product.toUpperCase() === 'INTRADAY' ? 'INTRADAY' : 'CNC',
      orderType: orderType.toUpperCase(),
      validity: 'DAY',
      tradingSymbol: symbol,
      quantity: quantity,
      price: orderType === 'LIMIT' ? price : 0,
      triggerPrice: orderType === 'SL' || orderType === 'SL-M' ? price : 0
    };

    // Resolve securityId
    try {
      const master = await this.instrumentManager.getMaster();
      const info = master.instrumentMap[symbol.toUpperCase()];
      if (info?.securityId) {
        order.securityId = String(info.securityId);
      }
    } catch (e) { /* ignore */ }

    return this.orderApi.placeOrder(order);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
