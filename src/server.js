/**
 * 🌉 Mr. Chartist API Bridge — Unified Trading Middleware
 * 
 * Central nervous system for the Mr. Chartist ecosystem.
 * Handles market data, order routing, option chains, and system monitoring.
 */

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// ── Global Error Handlers (catch unhandled crashes) ──
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] Uncaught Exception: ${err.message}`);
  console.error(err.stack);
  // Don't exit — let health checker detect and alert
});
process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL] Unhandled Rejection: ${reason}`);
});

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

// Internal modules
import { BrokerRegistry } from './brokers/broker-registry.js';
import { OrderApiFactory } from './brokers/order-api-factory.js';
import { DataCache } from './engine/data-cache.js';
import { InstrumentManager } from './engine/instrument-manager.js';
import { SubscriptionManager } from './engine/subscription-manager.js';
import { OptionChainService } from './engine/option-chain-service.js';
import { HealthChecker } from './monitor/health-checker.js';
import { GreeksCalculator } from './engine/greeks-calculator.js';
import { HistoryService } from './engine/history-service.js';
import { SmartOrderRouter } from './engine/smart-order.js';
import { WebhookEngine } from './engine/webhook-engine.js';

// Setup paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4500;
const WS_PORT = process.env.WS_PORT || 4501;
const ACTIVE_BROKER = process.env.ACTIVE_BROKER || 'dhan';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ═══════════════════════════════════════════
//  Component Initialization
// ═══════════════════════════════════════════

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ port: WS_PORT });

const cache = new DataCache();
const instrumentManager = new InstrumentManager({
  dbPath: path.join(__dirname, '..', 'data', 'bridge.db')
});

// Dynamic broker from registry (dhan | angel | fyers | zerodha)
console.log(`[SYSTEM] Active broker: ${ACTIVE_BROKER}`);
const broker = BrokerRegistry.createFromEnv(ACTIVE_BROKER, (tick) => handleIncomingTick(tick));

// Order API — dynamically wired per ACTIVE_BROKER
const isMock = process.env[`${ACTIVE_BROKER.toUpperCase()}_MOCK`] === 'true' || process.env.DHAN_MOCK === 'true';
const orders = OrderApiFactory.createFromEnv(ACTIVE_BROKER);

const subManager = new SubscriptionManager({ broker, cache, instrumentManager });
const optionChain = new OptionChainService({ cache, instrumentManager, subManager, orders });
const monitor = new HealthChecker({ broker, cache, subManager });

// Phase 2: Advanced services
const greeks = new GreeksCalculator({ cache, instrumentManager });
const history = new HistoryService({
  dbPath: path.join(__dirname, '..', 'data', 'history.db'),
  token: process.env.DHAN_ACCESS_TOKEN,
  clientId: process.env.DHAN_CLIENT_ID,
  instrumentManager,
  mock: isMock
});
const smartOrder = new SmartOrderRouter({ orderApi: orders, instrumentManager, cache });
const webhook = new WebhookEngine({ smartOrder, orders, cache, instrumentManager });

// Global client tracking
const clients = new Map(); // ws -> { id, subscriptions: Set }

// ═══════════════════════════════════════════
//  Core Engine
// ═══════════════════════════════════════════

/**
 * Handle incoming ticks from broker adapters
 */
function handleIncomingTick(tick) {
  if (!tick || !tick.symbol) return;
  const updatedTick = cache.update(tick);
  broadcastToSubscribers(updatedTick);
}

/**
 * Broadcast tick to all subscribed WebSocket clients
 */
function broadcastToSubscribers(tick) {
  if (!tick) return;
  const msg = JSON.stringify({ type: 'tick', data: tick });

  for (const [ws, clientInfo] of clients.entries()) {
    if (ws.readyState !== 1) continue; // skip non-open
    if (clientInfo.subscriptions.has(tick.symbol) || subManager.alwaysActive.has(tick.symbol)) {
      ws.send(msg);
    }
  }
}

// ═══════════════════════════════════════════
//  WebSocket Server (for OptionsDesk, etc.)
// ═══════════════════════════════════════════

// ── WebSocket Heartbeat (detect dead connections every 30s) ──
const WS_HEARTBEAT_MS = 30000;
setInterval(() => {
  for (const [ws, info] of clients.entries()) {
    if (ws._mcAlive === false) {
      console.log(`[WS] Terminating stale client: ${info.id}`);
      subManager.unsubscribeAll(info.id);
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    ws._mcAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, WS_HEARTBEAT_MS);

wss.on('connection', (ws, req) => {
  const clientId = `client_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 5)}`;
  ws._mcAlive = true;
  ws.on('pong', () => { ws._mcAlive = true; });
  const remoteIp = req.socket.remoteAddress;

  console.log(`[WS] Client connected: ${clientId} (${remoteIp})`);
  clients.set(ws, { id: clientId, subscriptions: new Set(), connectedAt: Date.now() });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      const clientInfo = clients.get(ws);
      if (!clientInfo) return;

      switch (data.action) {
        case 'subscribe': {
          if (!data.symbols || !Array.isArray(data.symbols)) break;
          data.symbols.forEach(s => clientInfo.subscriptions.add(s));
          await subManager.subscribe(clientId, data.symbols);

          // Send cached snapshot immediately
          const snapshot = cache.getBatch(data.symbols);
          if (snapshot.length > 0) {
            ws.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
          }
          console.log(`[WS] ${clientId} subscribed to: ${data.symbols.join(', ')}`);
          break;
        }

        case 'unsubscribe': {
          if (!data.symbols || !Array.isArray(data.symbols)) break;
          data.symbols.forEach(s => clientInfo.subscriptions.delete(s));
          await subManager.unsubscribe(clientId, data.symbols);
          break;
        }

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        default:
          ws.send(JSON.stringify({ type: 'error', message: `Unknown action: ${data.action}` }));
      }
    } catch (e) {
      console.error(`[WS] Message error: ${e.message}`);
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${clientId}`);
    subManager.unsubscribeAll(clientId);
    clients.delete(ws);
  });

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    bridge: 'Mr. Chartist API Bridge',
    version: '1.0.0',
    broker: ACTIVE_BROKER,
    connected: broker.connected
  }));
});

// ═══════════════════════════════════════════
//  HTTP API Routes
// ═══════════════════════════════════════════

// ── Security Headers (helmet) ──
app.use(helmet({
  contentSecurityPolicy: false,  // Disable CSP — dashboard SPA uses inline scripts
  crossOriginEmbedderPolicy: false,
}));

// ── CORS — lock to allowed origins in production ──
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : null;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (IS_PRODUCTION && ALLOWED_ORIGINS) {
    // Only allow whitelisted origins in production
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (!origin) {
      // Allow non-browser requests (curl, server-to-server)
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
    }
    // Else: no CORS header — browser will reject
  } else {
    // Development: wide open
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Webhook-Secret');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '1mb' }));

// ── Rate Limiters ──
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute
  max: IS_PRODUCTION ? 150 : 1000,  // Generous in dev
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', error: 'Too many requests — try again in a minute' },
  keyGenerator: (req) => req.ip || req.socket.remoteAddress,
});

const tradingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: IS_PRODUCTION ? 30 : 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', error: 'Trading rate limit hit — max 30 order requests per minute' },
  keyGenerator: (req) => req.ip || req.socket.remoteAddress,
});

// Apply global limiter to all API routes
app.use('/api/', globalLimiter);

// Apply stricter limiter to sensitive trading & webhook endpoints
app.use('/api/v1/order', tradingLimiter);
app.use('/api/v1/smartorder', tradingLimiter);
app.use('/api/v1/basket', tradingLimiter);
app.use('/api/v1/webhook', tradingLimiter);
app.use('/api/v1/positions/close-all', tradingLimiter);
app.use('/api/v1/orders/cancel-all', tradingLimiter);

// ── Request Logger ──
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      if (ms > 500 || res.statusCode >= 400) {
        console.log(`[API] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
      }
    });
  }
  next();
});

// ── API Key Auth (optional — only enforced if REQUIRE_AUTH=true) ──
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';
const API_KEY = process.env.INTERNAL_API_KEY;
if (REQUIRE_AUTH && API_KEY) {
  app.use('/api/', (req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.apiKey;
    if (key !== API_KEY) {
      return res.status(401).json({ status: 'error', error: 'Invalid or missing API key' });
    }
    next();
  });
  console.log('[AUTH] API key authentication enabled');
}

// Serve static dashboard files
app.use(express.static(path.join(__dirname, 'public')));

// ── Root — serve the dashboard SPA ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Broker Management ──
app.get('/api/v1/brokers', (req, res) => {
  res.json({
    status: 'success',
    active: ACTIVE_BROKER,
    connected: broker.connected,
    supported: BrokerRegistry.list()
  });
});

// ── System & Status ──
app.get('/api/v1/health', (req, res) => {
  const mem = process.memoryUsage();
  const cacheStats = cache.getStats();
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    broker: {
      name: broker.name,
      type: ACTIVE_BROKER,
      connected: broker.connected,
      mock: isMock
    },
    engine: {
      ...cacheStats,
      activeSubscriptions: subManager.getActiveSymbols().length,
      fnoSymbols: instrumentManager.cache?.fnoList?.length || 0,
      instrumentsLoaded: instrumentManager.cache ? Object.keys(instrumentManager.cache.instrumentMap || {}).length : 0
    },
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024)
    },
    wsClients: wss.clients.size,
    nodeVersion: process.version,
    pid: process.pid
  });
});

app.get('/api/v1/status', (req, res) => {
  res.json({
    status: 'success',
    activeClients: wss.clients.size,
    activeBroker: ACTIVE_BROKER,
    brokerConnected: broker.connected,
    activeSubscriptions: subManager.getActiveSymbols(),
    stats: cache.getStats()
  });
});

app.post('/api/v1/quotes', (req, res) => {
  const { symbols } = req.body;
  if (!symbols || !Array.isArray(symbols)) {
    return res.status(400).json({ error: 'symbols array required' });
  }
  const quotes = cache.getBatch(symbols);
  res.json({ status: 'success', count: quotes.length, data: quotes });
});

// ── Trading Endpoints ──
app.post('/api/v1/order', async (req, res) => {
  try {
    const data = await orders.placeOrder(req.body);
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/v1/positions', async (req, res) => {
  try {
    const data = await orders.getPositions();
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/v1/orders', async (req, res) => {
  try {
    const data = await orders.getOrders();
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/v1/funds', async (req, res) => {
  try {
    const data = await orders.getFunds();
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ── Option Chain Endpoints ──
app.get('/api/v1/optionchain/:symbol/:expiry', async (req, res) => {
  try {
    const { symbol, expiry } = req.params;
    const { strikes = 10 } = req.query;
    const data = await optionChain.getLiveChain(symbol, expiry, parseInt(strikes));
    res.json({ status: 'success', data });
  } catch (err) {
    // Fallback to direct broker API
    try {
      const data = await orders.getOptionChain({ symbol: req.params.symbol, expiry: req.params.expiry });
      res.json({ status: 'success', source: 'broker-direct', data });
    } catch (e) {
      res.status(500).json({ status: 'error', error: e.message });
    }
  }
});

app.get('/api/v1/expirylist/:symbol', async (req, res) => {
  try {
    // Try local cache first (instant, no API call)
    const expiries = await instrumentManager.getExpiries(req.params.symbol.toUpperCase());
    if (expiries && expiries.length > 0) {
      return res.json({ status: 'success', source: 'cache', data: expiries });
    }
    // Fallback to Dhan API
    const data = await orders.getExpiryList(req.params.symbol);
    res.json({ status: 'success', source: 'broker', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/v1/instruments/:symbol', async (req, res) => {
  try {
    const master = await instrumentManager.getMaster();
    const symbol = req.params.symbol.toUpperCase();
    const info = master.instrumentMap[symbol];
    if (info) {
      const expiries = master.expiryMap?.[symbol] || [];
      res.json({ status: 'success', data: { ...info, expiries } });
    } else {
      res.status(404).json({ status: 'error', error: 'Instrument not found' });
    }
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ── FNO Symbol List ──
app.get('/api/v1/fno-symbols', async (req, res) => {
  try {
    const master = await instrumentManager.getMaster();
    res.json({ status: 'success', count: (master.fnoList || []).length, data: master.fnoList || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ── Search Instruments ──
app.get('/api/v1/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.status(400).json({ status: 'error', error: 'Query must be at least 2 characters' });
    const master = await instrumentManager.getMaster();
    const query = q.toUpperCase();
    const results = Object.entries(master.instrumentMap)
      .filter(([sym]) => sym.includes(query))
      .map(([sym, info]) => ({ symbol: sym, ...info }))
      .slice(0, 50);
    res.json({ status: 'success', count: results.length, data: results });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ── Additional Trading Endpoints ──
app.delete('/api/v1/order/:orderId', async (req, res) => {
  try {
    const data = await orders.cancelOrder(req.params.orderId);
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.put('/api/v1/order/:orderId', async (req, res) => {
  try {
    const data = await orders.modifyOrder(req.params.orderId, req.body);
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/v1/trades', async (req, res) => {
  try {
    const data = await orders.getTrades();
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/v1/holdings', async (req, res) => {
  try {
    const data = await orders.getHoldings();
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ── Instrument Master Refresh ──
app.post('/api/v1/instruments/refresh', async (req, res) => {
  try {
    const data = await instrumentManager.refresh();
    res.json({
      status: 'success',
      instruments: Object.keys(data.instrumentMap).length,
      contracts: Object.keys(data.optionContracts).length,
      fnoSymbols: data.fnoList.length
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ═══════════════════════════════════════════
//  Phase 2: Advanced Endpoints
// ═══════════════════════════════════════════

// ── Historical Data ──
app.post('/api/v1/history', async (req, res) => {
  try {
    const { symbol, exchange, interval, startDate, endDate, forceRefresh } = req.body;
    if (!symbol || !startDate || !endDate) {
      return res.status(400).json({ status: 'error', error: 'symbol, startDate, endDate are required' });
    }
    const data = await history.getHistory({ symbol, exchange, interval, startDate, endDate, forceRefresh });
    res.json({ status: 'success', ...data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/v1/intervals', (req, res) => {
  res.json({ status: 'success', data: history.getIntervals() });
});

// ── Option Greeks ──
app.post('/api/v1/greeks', async (req, res) => {
  try {
    const { symbol, exchange, interestRate, forwardPrice, expiryTime } = req.body;
    if (!symbol) return res.status(400).json({ status: 'error', error: 'symbol is required' });
    const data = await greeks.calculate({ symbol, exchange, interestRate, forwardPrice, expiryTime });
    res.json(data);
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.post('/api/v1/greeks/batch', async (req, res) => {
  try {
    const { options } = req.body;
    if (!options || !Array.isArray(options)) return res.status(400).json({ status: 'error', error: 'options array is required' });
    const data = await greeks.calculateBatch(options);
    res.json({ status: 'success', count: data.length, data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ── Smart Order Routing ──
app.post('/api/v1/smartorder', async (req, res) => {
  try {
    const data = await smartOrder.placeSmartOrder(req.body);
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.post('/api/v1/basket', async (req, res) => {
  try {
    const data = await smartOrder.placeBasketOrder(req.body);
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.post('/api/v1/positions/close-all', async (req, res) => {
  try {
    const data = await smartOrder.closeAllPositions(req.body);
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.post('/api/v1/orders/cancel-all', async (req, res) => {
  try {
    const data = await smartOrder.cancelAllOrders();
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/v1/freeze-quantities', (req, res) => {
  res.json({ status: 'success', data: smartOrder.getFreezeQuantities() });
});

// ═══════════════════════════════════════════
//  Webhook Receiver (TradingView / External)
// ═══════════════════════════════════════════

// Primary webhook endpoint — accepts JSON or text payloads
app.post('/api/v1/webhook', async (req, res) => {
  try {
    // Optional secret validation
    const secret = req.headers['x-webhook-secret'] || req.query.secret || req.body?.secret;
    if (!webhook.validateSecret(secret)) {
      webhook.stats.totalRejected++;
      return res.status(403).json({ status: 'error', error: 'Invalid webhook secret' });
    }

    const payload = req.body;
    const meta = {
      ip: req.ip || req.socket.remoteAddress,
      source: req.headers['x-source'] || req.headers['user-agent'] || 'unknown',
      headers: req.headers,
    };

    const result = await webhook.processSignal(payload, meta);
    res.json(result);
  } catch (err) {
    res.status(400).json({ status: 'error', error: err.message });
  }
});

// TradingView-specific endpoint (accepts text/plain too)
app.post('/api/v1/webhook/tradingview', express.text({ type: '*/*' }), async (req, res) => {
  try {
    const secret = req.headers['x-webhook-secret'] || req.query.secret;
    if (!webhook.validateSecret(secret)) {
      webhook.stats.totalRejected++;
      return res.status(403).json({ status: 'error', error: 'Invalid webhook secret' });
    }

    let payload = req.body;
    // TradingView sends text/plain sometimes
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (_) {
        // Keep as text — webhook engine handles text parsing
      }
    }

    const meta = {
      ip: req.ip,
      source: 'tradingview',
    };

    const result = await webhook.processSignal(payload, meta);
    res.json(result);
  } catch (err) {
    res.status(400).json({ status: 'error', error: err.message });
  }
});

// Signal log
app.get('/api/v1/webhook/log', (req, res) => {
  const limit = parseInt(req.query.limit || 50);
  res.json({ status: 'success', data: webhook.getSignalLog(limit) });
});

// Webhook stats
app.get('/api/v1/webhook/stats', (req, res) => {
  res.json({ status: 'success', data: webhook.getStats() });
});

// ── Market Depth ──
app.post('/api/v1/depth', async (req, res) => {
  try {
    const { symbol, exchange } = req.body;
    if (!symbol) return res.status(400).json({ status: 'error', error: 'symbol is required' });
    // Get cached depth data or fallback to snapshot
    const tick = cache.get(symbol.toUpperCase());
    if (tick && tick.depth) {
      res.json({ status: 'success', symbol, exchange, data: tick.depth });
    } else if (tick) {
      // Return basic bid/ask from LTP data
      res.json({ status: 'success', symbol, source: 'ltp-only', data: {
        buy: [{ price: tick.ltp, qty: 0, orders: 0 }],
        sell: [{ price: tick.ltp, qty: 0, orders: 0 }],
        ltp: tick.ltp, open: tick.open, high: tick.high, low: tick.low, close: tick.close
      }});
    } else {
      res.json({ status: 'success', symbol, source: 'no-data', data: null, message: 'Subscribe via WebSocket first for depth data' });
    }
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ═══════════════════════════════════════════
//  Bootstrap
// ═══════════════════════════════════════════

async function bootstrap() {
  console.log('\n' + '='.repeat(50));
  console.log('   MR. CHARTIST API BRIDGE V1.0');
  console.log(`   Broker: ${ACTIVE_BROKER.toUpperCase()}`);
  console.log(`   Mode:   ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  console.log('='.repeat(50) + '\n');

  // ── Production safety checks ──
  if (IS_PRODUCTION) {
    if (isMock) {
      console.warn('\n' + '⚠️'.repeat(20));
      console.warn('[PRODUCTION WARNING] Server is running in MOCK mode!');
      console.warn(`  → ${ACTIVE_BROKER.toUpperCase()}_MOCK=true detected`);
      console.warn('  → NO real orders will be placed. Set *_MOCK=false for live trading.');
      console.warn('⚠️'.repeat(20) + '\n');
    }
    if (!process.env.WEBHOOK_SECRET) {
      console.warn('[PRODUCTION WARNING] WEBHOOK_SECRET is not set — webhooks are unauthenticated!');
    }
    if (!ALLOWED_ORIGINS) {
      console.warn('[PRODUCTION WARNING] ALLOWED_ORIGINS is not set — CORS is unrestricted!');
    }
    console.log(`[SECURITY] Rate limiting: Global 150/min, Trading 30/min`);
    console.log(`[SECURITY] CORS origins: ${ALLOWED_ORIGINS ? ALLOWED_ORIGINS.join(', ') : 'ANY (not recommended)'}`);
    console.log(`[SECURITY] Helmet HTTP headers: ENABLED`);
    console.log(`[SECURITY] API auth: ${REQUIRE_AUTH ? 'ENABLED' : 'DISABLED'}`);
  }

  // 1. Start HTTP first
  await new Promise((resolve, reject) => {
    httpServer.listen(PORT, () => {
      console.log(`[HTTP] REST API    → http://localhost:${PORT}`);
      console.log(`[WS]  WebSocket    → ws://localhost:${WS_PORT}`);
      resolve();
    });
    httpServer.on('error', reject);
  });

  // 2. Connect broker
  try {
    const mockKey = `${ACTIVE_BROKER.toUpperCase()}_MOCK`;
    const mockActive = process.env[mockKey] === 'true' || process.env.DHAN_MOCK === 'true';
    const success = await broker.connect();
    console.log(`[BROKER] ${broker.name} → ${success ? '✅ Connected' : '⚠️ Pending'} (mock=${mockActive})`);
  } catch (err) {
    console.error(`[BROKER] Connect error: ${err.message}`);
  }

  // 3. Instrument master (background - don't block)
  instrumentManager.getMaster()
    .then(master => {
      const contracts = Object.keys(master.optionContracts || {}).length;
      const instruments = Object.keys(master.instrumentMap || {}).length;
      console.log(`[INSTRUMENTS] Loaded: ${instruments} underlyings, ${contracts} option contracts, ${(master.fnoList || []).length} FNO symbols`);

      // Pre-subscribe to indices
      if (broker.connected) {
        const indexSymbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];
        const indices = indexSymbols.map(s => master.instrumentMap[s]).filter(Boolean);
        if (indices.length > 0) {
          broker.subscribe(indices, 'quote');
          console.log(`[SYSTEM] Pre-subscribed to ${indices.length} indices`);
        }
      }
    })
    .catch(err => {
      console.error(`[INSTRUMENTS] Load failed: ${err.message}`);
    });

  console.log(`[SYSTEM] Bridge is LIVE ✅\n`);
}

// ═══════════════════════════════════════════
//  Graceful Shutdown
// ═══════════════════════════════════════════

async function gracefulShutdown(signal) {
  console.log(`\n[SYSTEM] ${signal} received. Shutting down gracefully...`);

  // Stop health monitoring
  monitor.stop();

  // Disconnect broker WebSocket
  try {
    if (broker.disconnect) await broker.disconnect();
  } catch (e) {
    console.error(`[SYSTEM] Broker disconnect error: ${e.message}`);
  }

  // Close WS clients
  for (const [ws, info] of clients) {
    try { ws.close(1001, 'Server shutting down'); } catch (_) {}
  }
  clients.clear();
  wss.close();

  // Close SQLite databases
  try { if (history.db) history.db.close(); } catch (_) {}
  try { if (instrumentManager.db) instrumentManager.db.close(); } catch (_) {}

  // Close HTTP
  httpServer.close(() => {
    console.log('[SYSTEM] HTTP server closed.');
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    console.error('[SYSTEM] Forced shutdown.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start
bootstrap().catch(err => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
