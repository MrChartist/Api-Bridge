/**
 * 🛠️ init-db.js
 * 
 * Initializes the SQLite database for the API Bridge.
 * Stores configuration, API keys, and historical data snapshots.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '..', 'data', 'bridge.db');
const DATA_DIR = path.join(__dirname, '..', 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

console.log(`📦 Initializing database at ${DB_PATH}...`);

// Table: api_keys
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    tier TEXT DEFAULT 'free',
    active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

// Table: historical_ticks (optional, for DuckDB-like aggregation)
db.exec(`
  CREATE TABLE IF NOT EXISTS tick_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    volume INTEGER,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_symbol_time ON tick_history(symbol, timestamp);
`);

// Insert a default local API key for your own tools (OptionsDesk, etc.)
const defaultKey = 'mc_internal_bridge_default';
const stmt = db.prepare('INSERT OR IGNORE INTO api_keys (api_key, user_id, tier) VALUES (?, ?, ?)');
stmt.run(defaultKey, 'system', 'unlimited');

console.log('✅ Database initialized successfully.');
console.log('🔑 Internal API Key: ' + defaultKey);

db.close();
