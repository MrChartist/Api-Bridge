/**
 * 📐 Option Greeks Calculator — Black-76 Model
 * 
 * Calculates Delta, Gamma, Theta, Vega, Rho, and Implied Volatility
 * for options on Indian indices and stocks.
 * 
 * Uses Black-76 model (forward pricing) which is standard for index options.
 */

// ── Normal Distribution Functions ──
function normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normCDF(x) {
  // Abramowitz and Stegun approximation (accurate to 7.5e-8)
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1.0 / (1.0 + p * Math.abs(x));
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Calculate d1 and d2 for Black-76
 */
function calcD1D2(F, K, T, sigma) {
  const d1 = (Math.log(F / K) + (sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return { d1, d2 };
}

/**
 * Black-76 option price
 * @param {string} type - 'CE' or 'PE'
 * @param {number} F - Forward/futures price
 * @param {number} K - Strike price
 * @param {number} T - Time to expiry in years
 * @param {number} r - Risk-free interest rate (annualized, e.g. 0.07 for 7%)
 * @param {number} sigma - Volatility (e.g 0.15 for 15%)
 */
function black76Price(type, F, K, T, r, sigma) {
  if (T <= 0) return Math.max(0, type === 'CE' ? F - K : K - F);
  
  const { d1, d2 } = calcD1D2(F, K, T, sigma);
  const df = Math.exp(-r * T); // discount factor

  if (type === 'CE') {
    return df * (F * normCDF(d1) - K * normCDF(d2));
  } else {
    return df * (K * normCDF(-d2) - F * normCDF(-d1));
  }
}

/**
 * Calculate all Greeks for a given option
 */
function calculateGreeks(type, F, K, T, r, sigma) {
  if (T <= 0) {
    const intrinsic = type === 'CE' ? Math.max(0, F - K) : Math.max(0, K - F);
    return { price: intrinsic, iv: 0, delta: type === 'CE' ? (F > K ? 1 : 0) : (K > F ? -1 : 0), gamma: 0, theta: 0, vega: 0, rho: 0 };
  }

  const { d1, d2 } = calcD1D2(F, K, T, sigma);
  const df = Math.exp(-r * T);
  const sqrtT = Math.sqrt(T);
  const nd1 = normPDF(d1);

  let price, delta;

  if (type === 'CE') {
    price = df * (F * normCDF(d1) - K * normCDF(d2));
    delta = df * normCDF(d1);
  } else {
    price = df * (K * normCDF(-d2) - F * normCDF(-d1));
    delta = -df * normCDF(-d1);
  }

  // Gamma (same for CE and PE)
  const gamma = df * nd1 / (F * sigma * sqrtT);

  // Vega (per 1% move in vol)
  const vega = F * df * nd1 * sqrtT / 100;

  // Theta (per day)
  const thetaAnnual = -(F * df * nd1 * sigma) / (2 * sqrtT);
  const theta = thetaAnnual / 365;

  // Rho (per 1% change in rate)
  let rho;
  if (type === 'CE') {
    rho = -T * price / 100;
  } else {
    rho = -T * price / 100;
  }

  return {
    price: round(price, 4),
    delta: round(delta, 6),
    gamma: round(gamma, 8),
    theta: round(theta, 4),
    vega: round(vega, 4),
    rho: round(rho, 6)
  };
}

/**
 * Calculate Implied Volatility using Newton-Raphson method
 */
function calcIV(type, marketPrice, F, K, T, r, maxIterations = 100, tolerance = 0.0001) {
  if (T <= 0 || marketPrice <= 0) return 0;

  // Intrinsic check
  const intrinsic = type === 'CE' ? Math.max(0, F - K) : Math.max(0, K - F);
  if (marketPrice < intrinsic * Math.exp(-r * T)) return 0;

  // Initial guess using Brenner-Subrahmanyam approximation
  let sigma = Math.sqrt(2 * Math.PI / T) * marketPrice / F;
  if (sigma <= 0 || !isFinite(sigma)) sigma = 0.3;

  for (let i = 0; i < maxIterations; i++) {
    const price = black76Price(type, F, K, T, r, sigma);
    const diff = price - marketPrice;

    if (Math.abs(diff) < tolerance) break;

    // Vega for Newton step
    const { d1 } = calcD1D2(F, K, T, sigma);
    const vega = F * Math.exp(-r * T) * normPDF(d1) * Math.sqrt(T);

    if (vega < 1e-12) break;

    sigma -= diff / vega;

    // Bounds
    if (sigma <= 0.001) sigma = 0.001;
    if (sigma > 5) sigma = 5;
  }

  return round(sigma, 6);
}

function round(v, d) { const m = Math.pow(10, d); return Math.round(v * m) / m; }

/**
 * Calculate time to expiry in years
 * @param {string} expiryDate - 'YYYY-MM-DD' format
 * @param {string} expiryTime - 'HH:MM' format (default '15:30' for NSE)
 */
function timeToExpiry(expiryDate, expiryTime = '15:30') {
  const [h, m] = expiryTime.split(':').map(Number);
  const expiry = new Date(expiryDate + 'T' + expiryTime + ':00+05:30');
  const now = new Date();
  const diffMs = expiry.getTime() - now.getTime();
  const diffYears = diffMs / (365.25 * 24 * 60 * 60 * 1000);
  return Math.max(0, diffYears);
}

/**
 * Parse option symbol to extract underlying, expiry, strike, type
 * E.g. "NIFTY02APR2524000CE" -> { underlying: "NIFTY", strike: 24000, type: "CE", ... }
 */
function parseOptionSymbol(symbol) {
  // Pattern: SYMBOL + DD + MON + YY + STRIKE + CE/PE
  const match = symbol.match(/^([A-Z]+?)(\d{2})([A-Z]{3})(\d{2})(\d+)(CE|PE)$/);
  if (!match) return null;
  
  const [, underlying, day, month, year, strike, type] = match;
  const months = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
  const expiryDate = `20${year}-${months[month]}-${day}`;

  return {
    underlying,
    expiryDate,
    strike: parseInt(strike),
    type,
    symbol
  };
}

export class GreeksCalculator {
  constructor({ cache, instrumentManager }) {
    this.cache = cache;
    this.instrumentManager = instrumentManager;
    this.riskFreeRate = 0.07; // 7% default (India)
  }

  /**
   * Calculate Greeks for a single option
   */
  async calculate({ symbol, exchange, interestRate, forwardPrice, expiryTime }) {
    const r = (interestRate || this.riskFreeRate * 100) / 100;

    // Parse the option symbol
    const parsed = parseOptionSymbol(symbol);
    if (!parsed) {
      throw new Error(`Cannot parse option symbol: ${symbol}. Expected format: NIFTY02APR2524000CE`);
    }

    // Get spot/forward price
    let F = forwardPrice;
    if (!F) {
      const tick = this.cache.get(parsed.underlying);
      if (tick?.ltp) {
        F = tick.ltp;
      } else {
        throw new Error(`No LTP available for ${parsed.underlying}. Subscribe via WebSocket first or provide forwardPrice.`);
      }
    }

    // Time to expiry
    const T = timeToExpiry(parsed.expiryDate, expiryTime || '15:30');
    if (T <= 0) {
      return {
        symbol, underlying: parsed.underlying, strike: parsed.strike,
        type: parsed.type, expiryDate: parsed.expiryDate,
        daysToExpiry: 0, expired: true,
        greeks: { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 },
        iv: 0, theoreticalPrice: Math.max(0, parsed.type === 'CE' ? F - parsed.strike : parsed.strike - F)
      };
    }

    // Get option market price for IV calculation
    let optionPrice = 0;
    const optionTick = this.cache.get(symbol);
    if (optionTick?.ltp) optionPrice = optionTick.ltp;

    // Calculate IV
    const iv = optionPrice > 0 ? calcIV(parsed.type, optionPrice, F, parsed.strike, T, r) : 0.2; // default 20% if no market price

    // Calculate Greeks using IV (or 20% default)
    const sigma = iv > 0 ? iv : 0.2;
    const greeks = calculateGreeks(parsed.type, F, parsed.strike, T, r, sigma);

    return {
      status: 'success',
      symbol,
      underlying: parsed.underlying,
      strike: parsed.strike,
      type: parsed.type,
      expiryDate: parsed.expiryDate,
      daysToExpiry: round(T * 365.25, 1),
      forwardPrice: round(F, 2),
      optionPrice: round(optionPrice, 2),
      interestRate: round(r * 100, 2),
      iv: round(iv * 100, 2), // as percentage
      theoreticalPrice: greeks.price,
      greeks: {
        delta: greeks.delta,
        gamma: greeks.gamma,
        theta: greeks.theta,
        vega: greeks.vega,
        rho: greeks.rho
      }
    };
  }

  /**
   * Calculate Greeks for multiple options at once
   */
  async calculateBatch(options) {
    const results = [];
    for (const opt of options) {
      try {
        const result = await this.calculate(opt);
        results.push(result);
      } catch (err) {
        results.push({ symbol: opt.symbol, status: 'error', error: err.message });
      }
    }
    return results;
  }
}
