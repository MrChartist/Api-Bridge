/**
 * 🏭 OrderApiFactory
 * 
 * Creates the correct Order API instance based on the active broker.
 * Each order API implements a unified interface:
 *   placeOrder, modifyOrder, cancelOrder,
 *   getOrders, getTrades, getPositions, getHoldings, getFunds,
 *   getOptionChain, getExpiryList
 */

import { DhanOrderApi } from './dhan/dhan-order-api.js';
import { AngelOrderApi } from './angel/angel-order-api.js';
import { FyersOrderApi } from './fyers/fyers-order-api.js';
import { ZerodhaOrderApi } from './zerodha/zerodha-order-api.js';

export class OrderApiFactory {

  /**
   * Create an order API instance from environment variables
   * @param {string} brokerName - 'dhan' | 'angel' | 'fyers' | 'zerodha'
   * @returns Order API instance with unified interface
   */
  static createFromEnv(brokerName) {
    const name = brokerName.toLowerCase();
    const isMock = process.env[`${brokerName.toUpperCase()}_MOCK`] === 'true';

    switch (name) {
      case 'dhan':
        return new DhanOrderApi({
          token: process.env.DHAN_ACCESS_TOKEN,
          clientId: process.env.DHAN_CLIENT_ID,
          mock: isMock || process.env.DHAN_MOCK === 'true',
        });

      case 'angel':
        return new AngelOrderApi({
          token: process.env.ANGEL_ACCESS_TOKEN,
          apiKey: process.env.ANGEL_API_KEY,
          clientCode: process.env.ANGEL_CLIENT_CODE,
          mock: isMock || process.env.ANGEL_MOCK === 'true',
        });

      case 'fyers':
        return new FyersOrderApi({
          token: process.env.FYERS_ACCESS_TOKEN,
          appId: process.env.FYERS_APP_ID,
          mock: isMock || process.env.FYERS_MOCK === 'true',
        });

      case 'zerodha':
        return new ZerodhaOrderApi({
          token: process.env.ZERODHA_ACCESS_TOKEN,
          apiKey: process.env.ZERODHA_API_KEY,
          mock: isMock || process.env.ZERODHA_MOCK === 'true',
        });

      default:
        throw new Error(`Unknown broker "${brokerName}". Supported: dhan, angel, fyers, zerodha`);
    }
  }
}
