# 🌉 Mr. Chartist API Bridge

**Unified multi-broker API bridge for the Mr. Chartist trading ecosystem**

A high-performance, VPS-persistent middleware that serves as the central source of truth for trading operations, order management, real-time market data, and TradingView webhook signal execution across OptionsDesk, Scanner Pro, Algo Engine, and the entire Mr. Chartist ecosystem.

![Node.js](https://img.shields.io/badge/Node.js-18+-green?style=flat-square&logo=node.js)
![License](https://img.shields.io/badge/License-Proprietary-blue?style=flat-square)
![Brokers](https://img.shields.io/badge/Brokers-4-purple?style=flat-square)
![Endpoints](https://img.shields.io/badge/Endpoints-32-orange?style=flat-square)

---

## ✨ Features

### Multi-Broker Architecture
- **Dhan** — Full WebSocket + REST integration (production-ready)
- **AngelOne** — SmartAPI adapter with mock mode
- **Fyers** — FyersV3 adapter with mock mode
- **Zerodha** — KiteConnect adapter with mock mode

### Real-Time Data Engine
- **WebSocket Server** (port 4501) — High-fidelity tick broadcasting with reference-counted subscriptions
- **Instrument Master** — 245K+ row CSV parser with SQLite cache (9,300+ underlyings, 194K+ option contracts)
- **Option Chain Service** — ATM-centered chains with ITM/OTM labeling
- **Data Cache** — In-memory tick store with thread-safe access

### TradingView Webhook Receiver
- **JSON & text-based signal parsing** — Compatible with TradingView alerts and Pine Script `{{...}}` variables
- **Smart order execution** — Single orders, basket/multi-leg, close-all, cancel-all
- **Signal log & stats** — In-memory ring buffer with dashboard-integrated monitoring
- **Telegram notifications** — Real-time forwarding of executed/failed signals
- **Secret-based authentication** — Optional `X-Webhook-Secret` header validation

### Web Dashboard (14 pages)
- Dashboard, Positions, Orders, Trades, Holdings, Funds
- Symbol Search, Option Chain, Option Greeks, Historical Data
- WebSocket Test, Webhook Signals, API Explorer, Health Monitor
- **Brand-aligned** — True black theme, Mr. Chartist violet (#7C3AED), Outfit/Inter/JetBrains Mono fonts
- **Zero build step** — Pure HTML/CSS/JS served directly by Express

### Production-Grade Security
- **Helmet** — HTTP security headers (XSS, clickjacking, MIME-sniff protection)
- **Rate Limiting** — Global 150 req/min + Trading 30 req/min per IP
- **CORS Lockdown** — Configurable origin whitelist for production
- **API Key Auth** — Optional `X-API-Key` header enforcement
- **Graceful shutdown** — SIGTERM/SIGINT with broker disconnect, DB close
- **Health monitoring** — Memory thresholds and Telegram alerts
- **PM2 ecosystem config** — Auto-restart, log rotation, memory limits

---

## 🚀 Quick Start

```bash
# Clone
git clone https://github.com/MrChartist/api-bridge.git
cd api-bridge

# Install
npm install

# Configure
cp .env.template .env
# Edit .env with your broker credentials

# Run (development)
npm run dev

# Run (production with PM2)
npm run start:prod
```

Open **http://localhost:4500** for the dashboard.

---

## 📡 API Endpoints (32)

### Market Data
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/quotes` | Get cached quotes for symbols |
| `GET` | `/api/v1/search?q=NIFTY` | Search instruments |
| `GET` | `/api/v1/instruments/:symbol` | Instrument details + expiries |
| `GET` | `/api/v1/expirylist/:symbol` | Expiry dates for F&O symbol |
| `GET` | `/api/v1/optionchain/:symbol/:expiry` | Live option chain |
| `GET` | `/api/v1/fno-symbols` | All F&O eligible symbols |
| `POST` | `/api/v1/depth` | Market depth (Level 2) |

### Trading
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/order` | Place order |
| `PUT` | `/api/v1/order/:orderId` | Modify order |
| `DELETE` | `/api/v1/order/:orderId` | Cancel order |
| `GET` | `/api/v1/orders` | Order book |
| `GET` | `/api/v1/trades` | Trade book |
| `GET` | `/api/v1/positions` | Open positions |
| `GET` | `/api/v1/holdings` | Holdings |
| `GET` | `/api/v1/funds` | Funds & margin |

### Smart & Automatic Orders
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/smartorder` | Smart order (auto-split for freeze qty) |
| `POST` | `/api/v1/basket` | Multi-leg basket order |
| `POST` | `/api/v1/positions/close-all` | Close all open positions |
| `POST` | `/api/v1/orders/cancel-all` | Cancel all pending orders |
| `GET` | `/api/v1/freeze-quantities` | Exchange freeze qty limits |

### Webhook (TradingView / External)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/webhook` | JSON webhook receiver |
| `POST` | `/api/v1/webhook/tradingview` | TradingView-specific (text/plain) |
| `GET` | `/api/v1/webhook/log` | Signal log (last N signals) |
| `GET` | `/api/v1/webhook/stats` | Webhook execution stats |

### Advanced Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/history` | Historical OHLCV candles |
| `GET` | `/api/v1/intervals` | Supported chart intervals |
| `POST` | `/api/v1/greeks` | Option Greeks (Black-76) |
| `POST` | `/api/v1/greeks/batch` | Batch Greeks for chain |

### System
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/health` | System health & broker status |
| `GET` | `/api/v1/status` | WS clients, cache stats |
| `GET` | `/api/v1/brokers` | Active & supported brokers |
| `POST` | `/api/v1/instruments/refresh` | Force re-download master |

### WebSocket (ws://localhost:4501)
```json
// Subscribe
{"action": "subscribe", "symbols": ["NIFTY", "BANKNIFTY"]}

// Unsubscribe
{"action": "unsubscribe", "symbols": ["NIFTY"]}

// Tick response
{"type": "tick", "data": {"symbol": "NIFTY", "ltp": 24002.88, "change": 45.2, "changePct": 0.19}}
```

---

## 🔒 Security

| Layer | Feature | Details |
|-------|---------|---------|
| **HTTP Headers** | Helmet | XSS, clickjacking, MIME-sniff, referrer policy |
| **Rate Limiting** | express-rate-limit | Global: 150/min, Trading: 30/min per IP |
| **CORS** | Origin whitelist | `ALLOWED_ORIGINS` env var (locked in production) |
| **Auth** | API key | `REQUIRE_AUTH=true` + `X-API-Key` header |
| **Webhooks** | Secret validation | `WEBHOOK_SECRET` env var + `X-Webhook-Secret` header |
| **Body** | Size limit | `express.json({ limit: '1mb' })` |
| **Process** | Crash recovery | `uncaughtException` + `unhandledRejection` handlers |

---

## 🏗️ Project Structure

```
api-bridge/
├── src/
│   ├── server.js                  # Express + WS orchestrator
│   ├── brokers/
│   │   ├── broker-registry.js     # Factory pattern registry
│   │   ├── order-api-factory.js   # Dynamic order API wiring
│   │   ├── base-adapter.js        # Abstract adapter interface
│   │   ├── dhan/
│   │   │   ├── dhan-adapter.js    # WebSocket + REST adapter
│   │   │   └── dhan-order-api.js  # Order management
│   │   ├── angel/                 # AngelOne (SmartAPI)
│   │   ├── fyers/                 # Fyers v3
│   │   └── zerodha/               # Zerodha (KiteConnect)
│   ├── engine/
│   │   ├── data-cache.js          # In-memory tick store
│   │   ├── instrument-manager.js  # CSV parser + SQLite
│   │   ├── subscription-manager.js # Debounced WS subs
│   │   ├── option-chain-service.js # ATM chain builder
│   │   ├── greeks-calculator.js   # Black-76 Greeks + IV
│   │   ├── history-service.js     # OHLCV with SQLite cache
│   │   ├── smart-order.js         # Freeze-qty splits + baskets
│   │   └── webhook-engine.js      # TradingView signal processor
│   ├── monitor/
│   │   └── health-checker.js      # Memory + staleness alerts
│   └── public/                    # Dashboard SPA (14 pages)
│       ├── index.html
│       ├── css/style.css
│       └── js/app.js
├── scripts/
│   ├── init-db.js                 # Database setup
│   └── test-client.js             # Full endpoint tests
├── data/                          # SQLite + instrument cache
├── logs/                          # PM2 log files
├── ecosystem.config.cjs           # PM2 deployment
├── .env.template                  # Environment template
├── package.json
└── README.md
```

---

## ⚙️ Environment Variables

```env
# Environment
NODE_ENV=development          # development | production

# Broker Selection
ACTIVE_BROKER=dhan            # dhan | angel | fyers | zerodha

# Server
PORT=4500
WS_PORT=4501

# Dhan
DHAN_CLIENT_ID=your_client_id
DHAN_ACCESS_TOKEN=your_token
DHAN_MOCK=true                # Set false for live trading

# Security
REQUIRE_AUTH=false             # true to enforce API key
INTERNAL_API_KEY=change_me
WEBHOOK_SECRET=your_secret    # For webhook auth
ALLOWED_ORIGINS=https://optionsdesk.mrchartist.com,https://scanner.mrchartist.com

# Monitoring (optional)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

---

## 🖥️ VPS Deployment

```bash
# Install PM2 globally
npm install -g pm2

# Start in production
npm run start:prod

# Monitor
npm run logs:prod

# Stop
npm run stop:prod

# Auto-restart on reboot
pm2 save
pm2 startup
```

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Set all `*_MOCK=false`
- [ ] Set a strong `WEBHOOK_SECRET`
- [ ] Set `REQUIRE_AUTH=true` + strong `INTERNAL_API_KEY`
- [ ] Set `ALLOWED_ORIGINS` to your frontend domains
- [ ] Configure Telegram alerts (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)
- [ ] Verify rate limits are active (check startup console)

---

## 🧪 Testing

```bash
# Run full test suite (server must be running)
npm test
```

Tests all 32 REST endpoints + WebSocket connection.

---

## 📊 Performance

| Metric | Value |
|--------|-------|
| Instruments loaded | 9,346 underlyings |
| Option contracts | 195,952 |
| F&O symbols | 1,607 |
| Memory footprint | ~41MB heap |
| Startup time | <3s |
| Dependencies | 7 (express, ws, dotenv, better-sqlite3, jsonwebtoken, helmet, express-rate-limit) |

---

## 🔗 Ecosystem Integration

This bridge powers the entire Mr. Chartist ecosystem:

- **[OptionsDesk](https://optionsdesk.mrchartist.com)** — Live option chain & trading
- **[Scanner Pro](https://scanner.mrchartist.com)** — Technical scanner
- **[Corporate Decode](https://decode.mrchartist.com)** — Fundamental analysis
- **[Algo Engine](https://algo.mrchartist.com)** — Algorithmic trading

---

**Built with ❤️ by Mr. Chartist (Investology) — SEBI Registered RA (INH000015297)**
