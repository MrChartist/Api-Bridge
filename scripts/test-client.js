/**
 * 🧪 Mr. Chartist API Bridge — Full Test Suite
 * 
 * Tests all REST and WebSocket endpoints.
 * Run: node scripts/test-client.js
 */

const BASE_URL = 'http://127.0.0.1:4500';
const WS_URL = 'ws://127.0.0.1:4501';

const PASS = '✅';
const FAIL = '❌';

let passed = 0;
let failed = 0;

async function testREST(name, path, options = {}) {
  try {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await res.json();
    
    if (res.ok && (data.status === 'ok' || data.status === 'success' || data.name)) {
      console.log(`  ${PASS} ${name} (${res.status})`);
      passed++;
      return data;
    } else {
      console.log(`  ${FAIL} ${name} — ${JSON.stringify(data).substring(0, 100)}`);
      failed++;
      return null;
    }
  } catch (e) {
    console.log(`  ${FAIL} ${name} — ${e.message}`);
    failed++;
    return null;
  }
}

async function testWebSocket() {
  return new Promise(async (resolve) => {
    try {
      const ws_module = await import('ws');
      const WS = ws_module.default || ws_module.WebSocket;
      const ws = new WS(WS_URL);
      let messagesReceived = 0;

      ws.on('open', () => {
        console.log(`  ${PASS} WebSocket connected`);
        passed++;

        // Subscribe to NIFTY
        ws.send(JSON.stringify({ action: 'subscribe', symbols: ['NIFTY', 'BANKNIFTY'] }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        messagesReceived++;

        if (msg.type === 'welcome') {
          console.log(`  ${PASS} Welcome message received (broker: ${msg.broker})`);
          passed++;
        } else if (msg.type === 'snapshot') {
          console.log(`  ${PASS} Snapshot received: ${msg.data.length} symbols`);
          passed++;
        } else if (msg.type === 'tick') {
          console.log(`  ${PASS} Live tick: ${msg.data.symbol} @ ₹${msg.data.ltp}`);
          passed++;
        }

        // After getting a few messages, test ping and close
        if (messagesReceived >= 4) {
          ws.send(JSON.stringify({ action: 'ping' }));
        }
        if (messagesReceived >= 5) {
          ws.close();
        }
      });

      ws.on('close', () => {
        console.log(`  ${PASS} WebSocket closed cleanly`);
        passed++;
        resolve();
      });

      ws.on('error', (err) => {
        console.log(`  ${FAIL} WebSocket error: ${err.message}`);
        failed++;
        resolve();
      });

      // Timeout after 8 seconds
      setTimeout(() => {
        if (ws.readyState === 1) ws.close();
        resolve();
      }, 8000);
    } catch (e) {
      console.log(`  ${FAIL} WebSocket import error: ${e.message}`);
      failed++;
      resolve();
    }
  });
}

async function run() {
  console.log('\n' + '='.repeat(50));
  console.log('  MR. CHARTIST API BRIDGE — TEST SUITE');
  console.log('='.repeat(50) + '\n');

  // 1. REST Endpoints
  console.log('📡 REST API Tests:');
  console.log('-'.repeat(40));

  await testREST('Root endpoint', '/');
  await testREST('Health check', '/api/v1/health');
  await testREST('Status', '/api/v1/status');
  await testREST('Broker list', '/api/v1/brokers');
  await testREST('Quotes (NIFTY, BANKNIFTY)', '/api/v1/quotes', {
    method: 'POST',
    body: { symbols: ['NIFTY', 'BANKNIFTY', 'SENSEX'] }
  });
  await testREST('Funds', '/api/v1/funds');
  await testREST('Positions', '/api/v1/positions');
  await testREST('Orders', '/api/v1/orders');
  await testREST('FNO Symbols', '/api/v1/fno-symbols');

  // 2. WebSocket Test
  console.log('\n🔌 WebSocket Tests:');
  console.log('-'.repeat(40));
  await testWebSocket();

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

run();
