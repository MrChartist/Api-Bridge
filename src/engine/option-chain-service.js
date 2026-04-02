/**
 * 📈 OptionChainService
 * 
 * Manages live option chain logic:
 * - ATM strike calculation
 * - Dynamic strike range resolution
 * - Auto-subscription of chain members
 * - Real-time chain snapshot generation
 */


export class OptionChainService {
  constructor({ cache, instrumentManager, subManager, orders }) {
    this.cache = cache;
    this.instrumentManager = instrumentManager;
    this.subManager = subManager;
    this.orders = orders;
    
    // Active chains being monitored: symbol|expiry -> { strikeCount, lastAtm }
    this.activeChains = new Map();
  }

  /**
   * Get a live snapshot of the option chain
   */
  async getLiveChain(symbol, expiry, strikeCount = 10) {
    const master = await this.instrumentManager.getMaster();
    
    // 1. Get underlying LTP
    let underlying = this.cache.get(symbol);
    if (!underlying || !underlying.ltp) {
      console.log(`[OPTIONS] Underlying ${symbol} not in cache, subscribing now...`);
      
      // Auto-subscribe to underlying if missing
      const info = master.instrumentMap[symbol];
      if (info) {
        await this.subManager.broker.subscribe([info], 'quote');
      }
      
      // Wait briefly for first tick
      await new Promise(resolve => setTimeout(resolve, 500));
      underlying = this.cache.get(symbol);
    }

    const ltp = underlying?.ltp || 0;
    
    // 2. Find ATM Strike
    // Dhan symbols are often indexed. We need to find the strikes from the master.
    // Master format: optionContracts["NIFTY|2026-04-30|24000|CE"]
    const availableStrikes = this._getAvailableStrikes(master, symbol, expiry);
    if (availableStrikes.length === 0) {
      throw new Error(`No strikes found for ${symbol} on ${expiry}`);
    }

    const atmIndex = this._getATMIndex(ltp, availableStrikes);
    const atmStrike = availableStrikes[atmIndex];
    
    // 3. Select Range
    const start = Math.max(0, atmIndex - strikeCount);
    const end = Math.min(availableStrikes.length - 1, atmIndex + strikeCount);
    const selectedStrikes = availableStrikes.slice(start, end + 1);

    // 4. Build Chain & Extract Symbols for Subscription
    const chain = [];
    const symbolsToSub = [];

    selectedStrikes.forEach((strike, idx) => {
      const strikeIndex = start + idx;
      const ceKey = `${symbol}|${expiry}|${strike}|CE`;
      const peKey = `${symbol}|${expiry}|${strike}|PE`;
      
      const ceInfo = master.optionContracts[ceKey];
      const peInfo = master.optionContracts[peKey];

      const ceData = ceInfo ? this.cache.get(`${symbol}${strike}CE`) || { symbol: `${symbol}${strike}CE`, ltp: 0 } : null;
      const peData = peInfo ? this.cache.get(`${symbol}${strike}PE`) || { symbol: `${symbol}${strike}PE`, ltp: 0 } : null;

      chain.push({
        strike,
        ce: ceInfo ? { ...ceData, securityId: ceInfo.securityId, label: this._getLabel(strikeIndex, atmIndex, 'CE') } : null,
        pe: peInfo ? { ...peData, securityId: peInfo.securityId, label: this._getLabel(strikeIndex, atmIndex, 'PE') } : null
      });

      if (ceInfo) symbolsToSub.push({ symbol: `${symbol}${strike}CE`, securityId: ceInfo.securityId, exchangeSegment: 'NSE_FNO' });
      if (peInfo) symbolsToSub.push({ symbol: `${symbol}${strike}PE`, securityId: peInfo.securityId, exchangeSegment: 'NSE_FNO' });
    });

    // 5. Ensure these are subscribed on the bridge
    // We use a dummy client ID for systematic background subscriptions
    this.subManager.broker.subscribe(symbolsToSub, 'quote');

    return {
      underlying: symbol,
      ltp,
      atmStrike,
      expiry,
      chain
    };
  }

  _getAvailableStrikes(master, symbol, expiry) {
    const strikes = new Set();
    const prefix = `${symbol}|${expiry}|`;
    for (const key of Object.keys(master.optionContracts)) {
      if (key.startsWith(prefix)) {
        const strike = parseFloat(key.split('|')[2]);
        strikes.add(strike);
      }
    }
    return Array.from(strikes).sort((a, b) => a - b);
  }

  _getATMIndex(ltp, strikes) {
    if (ltp === 0) return Math.floor(strikes.length / 2);
    let minDiff = Infinity;
    let index = 0;
    for (let i = 0; i < strikes.length; i++) {
      const diff = Math.abs(strikes[i] - ltp);
      if (diff < minDiff) {
        minDiff = diff;
        index = i;
      }
    }
    return index;
  }

  _getLabel(strikeIndex, atmIndex, type) {
    if (strikeIndex === atmIndex) return 'ATM';
    const diff = Math.abs(strikeIndex - atmIndex);
    if (type === 'CE') {
      return strikeIndex < atmIndex ? `ITM${diff}` : `OTM${diff}`;
    } else {
      return strikeIndex > atmIndex ? `ITM${diff}` : `OTM${diff}`;
    }
  }
}
