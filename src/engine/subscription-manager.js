/**
 * 🛰️ SubscriptionManager
 * 
 * Manages reference counts for market data subscriptions.
 * Ensures we only occupy broker WebSocket bandwidth when a client needs it.
 * Uses debounced batching to avoid rapid subscribe/unsubscribe churn.
 */

export class SubscriptionManager {
  constructor({ broker, cache, instrumentManager }) {
    this.broker = broker;
    this.cache = cache;
    this.instrumentManager = instrumentManager;
    
    // symbol -> Set of client IDs
    this.subscriptions = new Map();
    
    // Always active symbols (indices — never unsubscribed)
    this.alwaysActive = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'INDIA VIX', 'SENSEX']);
    
    // Pending broker operations (debounced)
    this._pendingSub = new Set();
    this._pendingUnsub = new Set();
    this._flushTimer = null;
  }

  /**
   * Add a client subscription for a list of symbols
   */
  async subscribe(clientId, symbols, mode = 'quote') {
    if (!symbols || !Array.isArray(symbols)) return;

    const newSymbols = [];
    for (const symbol of symbols) {
      if (!this.subscriptions.has(symbol)) {
        this.subscriptions.set(symbol, new Set());
        newSymbols.push(symbol);
      }
      this.subscriptions.get(symbol).add(clientId);
    }

    if (newSymbols.length > 0) {
      newSymbols.forEach(s => this._pendingSub.add(s));
      this._scheduleFlush(mode);
    }
  }

  /**
   * Remove a client subscription
   */
  async unsubscribe(clientId, symbols) {
    if (!symbols || !Array.isArray(symbols)) return;

    for (const symbol of symbols) {
      if (this.alwaysActive.has(symbol)) continue;
      
      const clients = this.subscriptions.get(symbol);
      if (clients) {
        clients.delete(clientId);
        if (clients.size === 0) {
          this.subscriptions.delete(symbol);
          this._pendingUnsub.add(symbol);
        }
      }
    }

    if (this._pendingUnsub.size > 0) {
      this._scheduleFlush();
    }
  }

  /**
   * Remove all subscriptions for a client (on disconnect)
   */
  async unsubscribeAll(clientId) {
    const toUnsub = [];
    for (const [symbol, clients] of this.subscriptions.entries()) {
      if (this.alwaysActive.has(symbol)) continue;
      
      if (clients.has(clientId)) {
        clients.delete(clientId);
        if (clients.size === 0) {
          toUnsub.push(symbol);
          this.subscriptions.delete(symbol);
        }
      }
    }

    if (toUnsub.length > 0) {
      toUnsub.forEach(s => this._pendingUnsub.add(s));
      this._scheduleFlush();
    }
  }

  /**
   * Debounce broker operations — batch up sub/unsub changes over 200ms
   */
  _scheduleFlush(mode = 'quote') {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this._flushToBroker(mode), 200);
  }

  /**
   * Execute pending broker operations
   */
  async _flushToBroker(mode = 'quote') {
    // Process subscribes
    if (this._pendingSub.size > 0) {
      const symbols = Array.from(this._pendingSub);
      this._pendingSub.clear();

      try {
        const master = await this.instrumentManager.getMaster();
        const instruments = symbols
          .map(symbol => master.instrumentMap[symbol])
          .filter(Boolean);

        if (instruments.length > 0) {
          console.log(`[SUBS] Subscribing: ${instruments.map(i => i.symbol).join(', ')}`);
          await this.broker.subscribe(instruments, mode);
        }
      } catch (err) {
        console.error(`[SUBS] Subscribe error: ${err.message}`);
      }
    }

    // Process unsubscribes
    if (this._pendingUnsub.size > 0) {
      const symbols = Array.from(this._pendingUnsub);
      this._pendingUnsub.clear();

      try {
        if (this.broker.unsubscribe) {
          const master = await this.instrumentManager.getMaster();
          const instruments = symbols
            .map(symbol => master.instrumentMap[symbol])
            .filter(Boolean);
          
          if (instruments.length > 0) {
            console.log(`[SUBS] Unsubscribing: ${instruments.map(i => i.symbol).join(', ')}`);
            await this.broker.unsubscribe(instruments);
          }
        }
      } catch (err) {
        console.error(`[SUBS] Unsubscribe error: ${err.message}`);
      }
    }
  }

  /**
   * Get active subscriptions
   */
  getActiveSymbols() {
    return Array.from(this.subscriptions.keys());
  }

  /**
   * Get subscriber count for a symbol
   */
  getSubscriberCount(symbol) {
    return this.subscriptions.get(symbol)?.size || 0;
  }
}
