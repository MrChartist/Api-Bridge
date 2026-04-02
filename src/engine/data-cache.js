/**
 * 💾 DataCache
 * 
 * In-memory store for the latest market data ticks.
 * Provides instant access for all connected clients.
 */

export class DataCache {
  constructor() {
    this.cache = new Map(); // symbol -> lastTick
    this.history = new Map(); // symbol -> [recentTicks]
    this.stats = {
      totalTicks: 0,
      lastTickTime: 0,
      tickRate: 0,
      startTime: Date.now()
    };
    
    // For tick rate calculation
    this.tickCountInWindow = 0;
    this.tickRateInterval = setInterval(() => this._calculateTickRate(), 5000);
  }

  /**
   * Update the cache with a new tick
   */
  update(tick) {
    if (!tick || !tick.symbol) return;
    
    // Update last known state
    const current = this.cache.get(tick.symbol) || {};
    const updated = { ...current, ...tick };
    this.cache.set(tick.symbol, updated);
    
    // Update global stats
    this.stats.totalTicks++;
    this.stats.lastTickTime = Date.now();
    this.tickCountInWindow++;
    
    return updated;
  }

  /**
   * Get the last tick for a symbol
   */
  get(symbol) {
    return this.cache.get(symbol);
  }

  /**
   * Get all cached symbols
   */
  getAll() {
    return Array.from(this.cache.values());
  }

  /**
   * Get multiple symbols at once
   */
  getBatch(symbols) {
    if (!symbols || !Array.isArray(symbols)) return this.getAll();
    return symbols.map(s => this.cache.get(s)).filter(Boolean);
  }

  /**
   * Internal: Calculate messages per second
   */
  _calculateTickRate() {
    this.stats.tickRate = Math.round(this.tickCountInWindow / 5);
    this.tickCountInWindow = 0;
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      ...this.stats,
      uptime: Math.round((Date.now() - this.stats.startTime) / 1000),
      cachedSymbols: this.cache.size
    };
  }

  /**
   * Clear old data
   */
  clear() {
    this.cache.clear();
    this.history.clear();
  }
}
