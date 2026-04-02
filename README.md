# 🌉 Mr. Chartist API Bridge

**Unified multi-broker API bridge for the Mr. Chartist trading ecosystem**

A high-performance, VPS-persistent middleware that serves as the central source of truth for trading operations, order management, and real-time market data across OptionsDesk, Scanner Pro, Algo Engine, and the entire Mr. Chartist ecosystem.

![Node.js](https://img.shields.io/badge/Node.js-18+-green?style=flat-square&logo=node.js)
![License](https://img.shields.io/badge/License-Proprietary-blue?style=flat-square)
![Brokers](https://img.shields.io/badge/Brokers-4-purple?style=flat-square)

---

## ✨ Features

### Multi-Broker Architecture
- **Dhan** — Full WebSocket + REST integration (production-ready)
- **AngelOne** — SmartAPI adapter (template ready)
- **Fyers** — FyersV3 adapter (template ready)
- **Zerodha** — KiteConnect adapter (template ready)

### Real-Time Data Engine
- **WebSocket Server** (port 4501) — High-fidelity tick broadcasting with reference-counted subscriptions
- **Instrument Master** — 245K+ row CSV parser with SQLite cache (9,300+ underlyings, 194K+ option contracts)
- **Option Chain Service** — ATM-centered chains with ITM/OTM labeling
- **Data Cache** — In-memory tick store with thread-safe access

### Web Dashboard
- **11-page SPA** — Dashboard, Positions, Orders, Trades, Holdings, Funds, Search, Option Chain, WebSocket Test, API Explorer, Health Monitor
- **Brand-aligned** — True black theme, Mr. Chartist violet (#7C3AED), Outfit/Inter/JetBrains Mono fonts
- **Zero build step** — Pure HTML/CSS/JS served directly by Express

### Production Infrastructure
- **Graceful shutdown** with SIGTERM/SIGINT handling
- **Health monitoring** with memory thresholds and Telegram alerts
- **PM2 ecosystem config** for VPS deployment
- **Minimal footprint** — only 5 production dependencies

---

## 🚀 Quick Start

```bash
# Clone
git clone https://github.com/YourOrg/api-bridge.git
cd api-bridge

# Install
npm install

# Configure
cp .env.template .env
# Edit .env with your broker credentials

# Run
node src/server.js
```

Open **http://localhost:4500** for the dashboard.

---

## 📡 API Endpoints

### Market Data
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/quotes` | Get cached quotes for symbols |
| `GET` | `/api/v1/search?q=NIFTY` | Search instruments |
| `GET` | `/api/v1/instruments/:symbol` | Instrument details + expiries |
| `GET` | `/api/v1/expirylist/:symbol` | Expiry dates for F&O symbol |
| `GET` | `/api/v1/optionchain/:symbol/:expiry` | Live option chain |
| `GET` | `/api/v1/fno-symbols` | All F&O eligible symbols |

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

### System
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/health` | System health |
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

## 🏗️ Project Structure

```
api-bridge/
├── src/
│   ├── server.js                  # Express + WS orchestrator
│   ├── brokers/
│   │   ├── broker-registry.js     # Factory pattern registry
│   │   ├── dhan/
│   │   │   ├── dhan-adapter.js    # WebSocket + REST adapter
│   │   │   └── dhan-order-api.js  # Order management
│   │   ├── angel/                 # AngelOne adapter
│   │   ├── fyers/                 # Fyers adapter
│   │   └── zerodha/               # Zerodha adapter
│   ├── engine/
│   │   ├── data-cache.js          # In-memory tick store
│   │   ├── instrument-manager.js  # CSV parser + SQLite
│   │   ├── subscription-manager.js # Debounced WS subs
│   │   └── option-chain-service.js # ATM chain builder
│   ├── monitor/
│   │   └── health-checker.js      # Memory + staleness alerts
│   └── public/                    # Dashboard SPA
│       ├── index.html
│       ├── css/style.css
│       └── js/app.js
├── scripts/
│   ├── init-db.js                 # Database setup
│   └── test-client.js             # Full endpoint tests
├── data/                          # SQLite + instrument cache
├── ecosystem.config.cjs           # PM2 deployment
├── .env.template                  # Environment template
├── package.json
└── README.md
```

---

## ⚙️ Environment Variables

```env
# Broker Selection
ACTIVE_BROKER=dhan          # dhan | angel | fyers | zerodha

# Server
HTTP_PORT=4500
WS_PORT=4501

# Dhan
DHAN_CLIENT_ID=your_client_id
DHAN_ACCESS_TOKEN=your_token
DHAN_MOCK=true              # Set false for live trading

# AngelOne
ANGEL_CLIENT_ID=
ANGEL_PASSWORD=
ANGEL_MPIN=
ANGEL_TOTP_SECRET=

# Fyers
FYERS_APP_ID=
FYERS_ACCESS_TOKEN=

# Zerodha
ZERODHA_API_KEY=
ZERODHA_ACCESS_TOKEN=
```

---

## 🖥️ VPS Deployment

```bash
# Using PM2
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

---

## 🧪 Testing

```bash
# Run full test suite (server must be running)
npm test
```

Tests all 18 REST endpoints + WebSocket connection.

---

## 📊 Performance

| Metric | Value |
|--------|-------|
| Instruments loaded | 9,322 underlyings |
| Option contracts | 194,213 |
| F&O symbols | 1,608 |
| Memory footprint | ~45MB heap |
| Startup time | <3s |
| Dependencies | 5 (express, ws, dotenv, better-sqlite3, jsonwebtoken) |

---

## 🔗 Ecosystem Integration

This bridge powers the entire Mr. Chartist ecosystem:

- **[OptionsDesk](https://optionsdesk.mrchartist.com)** — Live option chain & trading
- **[Scanner Pro](https://scanner.mrchartist.com)** — Technical scanner
- **[Corporate Decode](https://decode.mrchartist.com)** — Fundamental analysis
- **[Algo Engine](https://algo.mrchartist.com)** — Algorithmic trading

---

**Built with ❤️ by Mr. Chartist (Investology) — SEBI Registered RA (INH000015297)**
