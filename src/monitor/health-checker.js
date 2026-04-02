/**
 * 🏥 HealthChecker
 * 
 * Monitors the system for issues like token expiry, memory leaks, and stale ticks.
 * Integrates with Telegram for proactive alerts on VPS.
 */

export class HealthChecker {
  constructor({ broker, cache, subManager }) {
    this.broker = broker;
    this.cache = cache;
    this.subManager = subManager;
    
    this.config = {
      telegramToken: process.env.TELEGRAM_BOT_TOKEN,
      telegramChatId: process.env.TELEGRAM_CHAT_ID,
      staleThreshold: 120000,  // 2 min no ticks during market hours
      memThresholdMB: 512      // Absolute threshold (512MB)
    };
    
    this.alertCooldown = new Map(); // key -> last alert time
    this.COOLDOWN_MS = 300000;      // 5 min between same alerts
    
    this._startJobs();
  }

  _startJobs() {
    // Tick staleness check every 60s
    this._tickInterval = setInterval(() => this._checkTickStaleness(), 60000);
    
    // Resource check every 5 min
    this._resourceInterval = setInterval(() => this._checkResources(), 300000);
    
    // Broker status check every 3 min
    this._brokerInterval = setInterval(() => this._checkBrokerStatus(), 180000);
    
    // Initial status log at startup (delayed 30s for instruments to load)
    setTimeout(() => this._logStatus(), 30000);
    
    console.log(`[HEALTH] Monitoring started`);
  }

  _checkTickStaleness() {
    if (!this._isMarketOpen()) return;
    if (!this.broker.connected) return;

    const lastTickTime = this.cache.stats.lastTickTime;
    if (lastTickTime === 0) return; // No ticks yet

    const gap = Date.now() - lastTickTime;
    if (gap > this.config.staleThreshold) {
      const msg = `STALE FEED: No ticks in ${Math.round(gap / 1000)}s. Triggering reconnect.`;
      console.warn(`[HEALTH] ${msg}`);
      this._alert('stale', msg);
      this.broker.connect().catch(() => {});
    }
  }

  _checkResources() {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);

    if (heapMB > this.config.memThresholdMB) {
      const msg = `HIGH MEMORY: Heap ${heapMB}MB, RSS ${rssMB}MB`;
      console.warn(`[HEALTH] ${msg}`);
      this._alert('memory', msg);
    }
  }

  _checkBrokerStatus() {
    if (!this.broker.connected) {
      const msg = `Broker ${this.broker.name} is DISCONNECTED`;
      console.error(`[HEALTH] ${msg}`);
      this._alert('broker', msg);
    }
  }

  _logStatus() {
    const stats = this.cache.getStats();
    const mem = process.memoryUsage();
    console.log(`[HEALTH] Status: ${stats.cachedSymbols} symbols cached, ${stats.totalTicks} ticks, ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap`);
  }

  async _alert(key, message) {
    // Cooldown to prevent spam
    const lastAlert = this.alertCooldown.get(key) || 0;
    if (Date.now() - lastAlert < this.COOLDOWN_MS) return;
    this.alertCooldown.set(key, Date.now());

    if (!this.config.telegramToken || !this.config.telegramChatId) return;

    try {
      await fetch(`https://api.telegram.org/bot${this.config.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.telegramChatId,
          text: `🌉 MC Bridge: ${message}`
        })
      });
    } catch (e) {
      console.error(`[HEALTH] Telegram alert failed: ${e.message}`);
    }
  }

  _isMarketOpen() {
    const now = new Date();
    const istOffset = 330;
    const istTime = new Date(now.getTime() + (now.getTimezoneOffset() + istOffset) * 60000);
    
    const day = istTime.getDay();
    if (day === 0 || day === 6) return false;
    
    const totalMinutes = istTime.getHours() * 60 + istTime.getMinutes();
    return totalMinutes >= 555 && totalMinutes <= 930; // 9:15 to 15:30
  }

  stop() {
    clearInterval(this._tickInterval);
    clearInterval(this._resourceInterval);
    clearInterval(this._brokerInterval);
  }
}
