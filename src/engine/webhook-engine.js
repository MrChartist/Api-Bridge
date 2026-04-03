/**
 * 📡 WebhookEngine — TradingView & External Signal Processor
 * 
 * Accepts webhook alerts from TradingView, custom strategies, or any external
 * system and converts them into executable orders via the SmartOrderRouter.
 * 
 * Supported Payload Formats:
 * 
 * 1. JSON Standard:
 *    { "symbol": "NIFTY", "action": "BUY", "quantity": 50, "orderType": "MARKET" }
 * 
 * 2. TradingView Alert (text-based):
 *    "BUY NIFTY 50 MARKET"
 *    "SELL BANKNIFTY 15 LIMIT 51200"
 * 
 * 3. Pine Script {{...}} variables:
 *    { "symbol": "{{ticker}}", "action": "{{strategy.order.action}}", "quantity": {{strategy.order.contracts}} }
 * 
 * 4. Multi-leg (basket):
 *    { "type": "basket", "legs": [...], "tag": "iron_condor" }
 */

export class WebhookEngine {
  constructor({ smartOrder, orders, cache, instrumentManager }) {
    this.smartOrder = smartOrder;
    this.orders = orders;
    this.cache = cache;
    this.instrumentManager = instrumentManager;

    // Signal log — last N webhooks (in-memory ring buffer)
    this.signalLog = [];
    this.MAX_LOG = 200;

    // Secret for webhook validation (optional)
    this.secret = process.env.WEBHOOK_SECRET || '';

    // Telegram forwarding
    this.telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = process.env.TELEGRAM_CHAT_ID;

    // Stats
    this.stats = {
      totalReceived: 0,
      totalExecuted: 0,
      totalFailed: 0,
      totalRejected: 0,
      lastSignalAt: null,
    };
  }

  /**
   * Process an incoming webhook signal
   * @param {Object|string} payload - Raw webhook body
   * @param {Object} meta - { ip, source, headers }
   * @returns {Object} Execution result
   */
  async processSignal(payload, meta = {}) {
    this.stats.totalReceived++;
    this.stats.lastSignalAt = new Date().toISOString();

    const logEntry = {
      id: `sig_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 4)}`,
      receivedAt: this.stats.lastSignalAt,
      source: meta.source || meta.ip || 'unknown',
      rawPayload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      status: 'pending',
      result: null,
    };

    try {
      // 1. Parse the signal
      const signal = this._parseSignal(payload);
      logEntry.parsed = signal;

      // 2. Validate
      this._validateSignal(signal);

      // 3. Execute
      let result;
      if (signal.type === 'basket') {
        result = await this.smartOrder.placeBasketOrder({
          legs: signal.legs,
          tag: signal.tag || 'webhook',
        });
      } else if (signal.type === 'close-all') {
        result = await this.smartOrder.closeAllPositions({ product: signal.product });
      } else if (signal.type === 'cancel-all') {
        result = await this.smartOrder.cancelAllOrders();
      } else {
        // Standard single order
        result = await this.smartOrder.placeSmartOrder({
          symbol: signal.symbol,
          action: signal.action,
          quantity: signal.quantity,
          orderType: signal.orderType || 'MARKET',
          price: signal.price || 0,
          product: signal.product || 'INTRADAY',
          exchange: signal.exchange || 'NSE_FNO',
          splitSize: signal.splitSize,
        });
      }

      logEntry.status = 'executed';
      logEntry.result = result;
      this.stats.totalExecuted++;

      // Telegram notification
      this._notifyTelegram(`✅ EXECUTED: ${signal.action} ${signal.symbol} x${signal.quantity} (${signal.orderType})`);

      return { status: 'success', signalId: logEntry.id, signal, result };

    } catch (err) {
      logEntry.status = 'failed';
      logEntry.error = err.message;
      this.stats.totalFailed++;

      this._notifyTelegram(`❌ FAILED: ${err.message}\nPayload: ${logEntry.rawPayload.substring(0, 200)}`);

      throw err;
    } finally {
      // Add to ring buffer
      this.signalLog.push(logEntry);
      if (this.signalLog.length > this.MAX_LOG) {
        this.signalLog.shift();
      }
    }
  }

  /**
   * Parse incoming payload into a normalized signal object
   */
  _parseSignal(payload) {
    // If string, try to parse as JSON first
    if (typeof payload === 'string') {
      payload = payload.trim();
      
      // Try JSON parse
      try {
        payload = JSON.parse(payload);
      } catch (_) {
        // Not JSON — treat as text command
        return this._parseTextSignal(payload);
      }
    }

    // JSON-based signal
    if (payload.type === 'basket' || payload.legs) {
      return { type: 'basket', legs: payload.legs, tag: payload.tag };
    }

    if (payload.type === 'close-all' || payload.action?.toLowerCase() === 'close-all') {
      return { type: 'close-all', product: payload.product };
    }

    if (payload.type === 'cancel-all' || payload.action?.toLowerCase() === 'cancel-all') {
      return { type: 'cancel-all' };
    }

    return {
      type: 'order',
      symbol: (payload.symbol || payload.ticker || payload.tradingsymbol || '').toUpperCase(),
      action: (payload.action || payload.side || payload.transactionType || 'BUY').toUpperCase(),
      quantity: parseInt(payload.quantity || payload.qty || payload.contracts || 0),
      orderType: (payload.orderType || payload.order_type || 'MARKET').toUpperCase(),
      price: parseFloat(payload.price || payload.limitPrice || 0),
      triggerPrice: parseFloat(payload.triggerPrice || payload.stopPrice || 0),
      product: (payload.product || payload.productType || 'INTRADAY').toUpperCase(),
      exchange: (payload.exchange || payload.exchangeSegment || 'NSE_FNO').toUpperCase(),
      splitSize: payload.splitSize,
      tag: payload.tag || payload.strategy || '',
    };
  }

  /**
   * Parse text-based TradingView alert
   * Format: "ACTION SYMBOL QUANTITY [ORDERTYPE] [PRICE]"
   * Examples:
   *   "BUY NIFTY 50"
   *   "SELL BANKNIFTY 15 LIMIT 51200"
   *   "BUY RELIANCE 10 SL 2400"
   *   "CLOSE-ALL"
   */
  _parseTextSignal(text) {
    const upper = text.toUpperCase().trim();

    if (upper === 'CLOSE-ALL' || upper === 'CLOSEALL' || upper === 'EXIT ALL') {
      return { type: 'close-all' };
    }
    if (upper === 'CANCEL-ALL' || upper === 'CANCELALL') {
      return { type: 'cancel-all' };
    }

    const parts = upper.split(/\s+/);
    if (parts.length < 3) {
      throw new Error(`Cannot parse text signal: "${text}". Expected format: ACTION SYMBOL QUANTITY [ORDERTYPE] [PRICE]`);
    }

    return {
      type: 'order',
      action: parts[0], // BUY or SELL
      symbol: parts[1],
      quantity: parseInt(parts[2]),
      orderType: parts[3] || 'MARKET',
      price: parseFloat(parts[4] || 0),
      product: 'INTRADAY',
      exchange: 'NSE_FNO',
    };
  }

  /**
   * Validate a parsed signal
   */
  _validateSignal(signal) {
    if (signal.type === 'close-all' || signal.type === 'cancel-all') return;

    if (signal.type === 'basket') {
      if (!signal.legs || !Array.isArray(signal.legs) || signal.legs.length === 0) {
        throw new Error('Basket signal requires non-empty legs array');
      }
      return;
    }

    if (!signal.symbol) throw new Error('Signal missing required field: symbol');
    if (!signal.action || !['BUY', 'SELL'].includes(signal.action)) {
      throw new Error(`Invalid action: "${signal.action}". Must be BUY or SELL`);
    }
    if (!signal.quantity || signal.quantity <= 0) {
      throw new Error(`Invalid quantity: ${signal.quantity}. Must be positive integer`);
    }
    if (!['MARKET', 'LIMIT', 'SL', 'SL-M'].includes(signal.orderType)) {
      throw new Error(`Invalid orderType: "${signal.orderType}". Supported: MARKET, LIMIT, SL, SL-M`);
    }
    if ((signal.orderType === 'LIMIT' || signal.orderType === 'SL') && !signal.price) {
      throw new Error(`Price required for ${signal.orderType} orders`);
    }
  }

  /**
   * Validate webhook secret (if configured)
   */
  validateSecret(provided) {
    if (!this.secret) return true; // No secret = allow all
    return provided === this.secret;
  }

  /**
   * Get signal log (most recent first)
   */
  getSignalLog(limit = 50) {
    return [...this.signalLog].reverse().slice(0, limit);
  }

  /**
   * Get webhook stats
   */
  getStats() {
    return {
      ...this.stats,
      logSize: this.signalLog.length,
      secretConfigured: !!this.secret,
    };
  }

  /**
   * Telegram notification (non-blocking)
   */
  async _notifyTelegram(message) {
    if (!this.telegramToken || !this.telegramChatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.telegramChatId,
          text: `📡 MC Bridge Webhook:\n${message}`,
          parse_mode: 'HTML'
        })
      });
    } catch (_) {}
  }
}
