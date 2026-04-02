/**
 * 🏭 BrokerRegistry
 * 
 * Factory for creating broker adapters by name.
 * Allows dynamic broker selection from .env configuration.
 * 
 * Usage:
 *   const broker = BrokerRegistry.create('dhan', { token, clientId, onTick });
 */

import { DhanAdapter } from './dhan/dhan-adapter.js';
import { AngelAdapter } from './angel/angel-adapter.js';
import { FyersAdapter } from './fyers/fyers-adapter.js';
import { ZerodhaAdapter } from './zerodha/zerodha-adapter.js';

const BROKER_MAP = {
  dhan:     { Adapter: DhanAdapter,    label: 'Dhan',            envPrefix: 'DHAN' },
  angel:    { Adapter: AngelAdapter,   label: 'AngelOne',        envPrefix: 'ANGEL' },
  fyers:    { Adapter: FyersAdapter,   label: 'Fyers',           envPrefix: 'FYERS' },
  zerodha:  { Adapter: ZerodhaAdapter, label: 'Zerodha (Kite)',  envPrefix: 'ZERODHA' },
};

export class BrokerRegistry {

  /**
   * Get list of all supported brokers
   */
  static list() {
    return Object.entries(BROKER_MAP).map(([key, val]) => ({
      id: key,
      label: val.label,
      envPrefix: val.envPrefix,
    }));
  }

  /**
   * Create a broker adapter by name
   * @param {string} brokerName - 'dhan', 'angel', 'fyers', 'zerodha'
   * @param {object} config - Broker-specific config (token, clientId, onTick, etc.)
   */
  static create(brokerName, config) {
    const entry = BROKER_MAP[brokerName.toLowerCase()];
    if (!entry) {
      throw new Error(`Unknown broker "${brokerName}". Supported: ${Object.keys(BROKER_MAP).join(', ')}`);
    }
    return new entry.Adapter(config);
  }

  /**
   * Create a broker adapter from environment variables
   * @param {string} brokerName - 'dhan', 'angel', 'fyers', 'zerodha'
   * @param {Function} onTick - Callback for incoming ticks
   */
  static createFromEnv(brokerName, onTick) {
    const entry = BROKER_MAP[brokerName.toLowerCase()];
    if (!entry) {
      throw new Error(`Unknown broker "${brokerName}". Supported: ${Object.keys(BROKER_MAP).join(', ')}`);
    }

    const prefix = entry.envPrefix;

    // Build config from env vars based on broker
    const config = { onTick };

    switch (brokerName.toLowerCase()) {
      case 'dhan':
        config.token = process.env.DHAN_ACCESS_TOKEN;
        config.clientId = process.env.DHAN_CLIENT_ID;
        break;
      case 'angel':
        config.apiKey = process.env.ANGEL_API_KEY;
        config.clientCode = process.env.ANGEL_CLIENT_CODE;
        config.token = process.env.ANGEL_ACCESS_TOKEN;
        config.feedToken = process.env.ANGEL_FEED_TOKEN;
        break;
      case 'fyers':
        config.appId = process.env.FYERS_APP_ID;
        config.token = process.env.FYERS_ACCESS_TOKEN;
        break;
      case 'zerodha':
        config.apiKey = process.env.ZERODHA_API_KEY;
        config.token = process.env.ZERODHA_ACCESS_TOKEN;
        break;
    }

    return new entry.Adapter(config);
  }
}
