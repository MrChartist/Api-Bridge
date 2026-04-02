/**
 * 🧱 BaseBrokerAdapter
 * 
 * Abstract class defining the required interface for all broker integrations
 * in the Mr. Chartist API Bridge.
 */
export class BaseBrokerAdapter {
  constructor(config) {
    this.config = config;
    this.name = 'Base';
    this.connected = false;
    this.instruments = new Map(); // securityId -> info
  }

  /**
   * Establish connection to broker's WebSocket and initialize REST API
   */
  async connect() {
    throw new Error('connect() must be implemented by broker adapter');
  }

  /**
   * Gracefully close connections
   */
  async disconnect() {
    throw new Error('disconnect() must be implemented by broker adapter');
  }

  /**
   * Subscribe to live market data for a list of symbols
   * @param {Array} symbols List of symbols or security IDs to subscribe to
   * @param {string} mode 'ticker', 'quote', or 'depth'
   */
  async subscribe(symbols, mode = 'quote') {
    throw new Error('subscribe() must be implemented by broker adapter');
  }

  /**
   * Unsubscribe from market data
   */
  async unsubscribe(symbols) {
    throw new Error('unsubscribe() must be implemented by broker adapter');
  }

  /**
   * Order Operations
   */
  async placeOrder(orderParams) {
    throw new Error('placeOrder() must be implemented by broker adapter');
  }

  async modifyOrder(orderId, orderParams) {
    throw new Error('modifyOrder() must be implemented by broker adapter');
  }

  async cancelOrder(orderId) {
    throw new Error('cancelOrder() must be implemented by broker adapter');
  }

  /**
   * Data Fetch Operations
   */
  async getPositions() {
    throw new Error('getPositions() must be implemented by broker adapter');
  }

  async getHoldings() {
    throw new Error('getHoldings() must be implemented by broker adapter');
  }

  async getOrderBook() {
    throw new Error('getOrderBook() must be implemented by broker adapter');
  }

  async getFunds() {
    throw new Error('getFunds() must be implemented by broker adapter');
  }

  /**
   * Helper to normalize data across brokers
   */
  normalizeTick(rawTick) {
    throw new Error('normalizeTick() must be implemented by broker adapter');
  }
}
