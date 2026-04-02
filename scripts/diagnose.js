/**
 * 🔍 Diagnostic Boot Test
 * Tests each component individually to find startup issues.
 */

import dotenv from 'dotenv';
dotenv.config();

console.log('=== DIAGNOSTIC BOOT ===');
console.log('ENV loaded. DHAN_MOCK =', process.env.DHAN_MOCK);
console.log('PORT =', process.env.PORT);
console.log('WS_PORT =', process.env.WS_PORT);
console.log('');

// Step 1: Test DataCache
try {
  const { DataCache } = await import('./src/engine/data-cache.js');
  const cache = new DataCache();
  cache.update({ symbol: 'TEST', ltp: 100 });
  console.log('[PASS] DataCache works. Test get:', cache.get('TEST'));
} catch (e) {
  console.error('[FAIL] DataCache:', e.message);
}

// Step 2: Test InstrumentManager (without network)
try {
  const { InstrumentManager } = await import('./src/engine/instrument-manager.js');
  const im = new InstrumentManager({ dbPath: './data/bridge.db' });
  console.log('[PASS] InstrumentManager initialized');
} catch (e) {
  console.error('[FAIL] InstrumentManager:', e.message);
}

// Step 3: Test DhanAdapter (mock mode)
try {
  const { DhanAdapter } = await import('./src/brokers/dhan/dhan-adapter.js');
  const adapter = new DhanAdapter({
    token: 'test',
    clientId: 'test',
    onTick: (tick) => {}
  });
  
  // Force mock
  process.env.DHAN_MOCK = 'true';
  const result = await adapter.connect();
  console.log('[PASS] DhanAdapter mock connect:', result, '| connected:', adapter.connected);
  
  // Wait for a tick
  await new Promise(r => setTimeout(r, 1500));
  console.log('[PASS] Mock ticks are flowing');
  
  // Cleanup
  if (adapter.mockInterval) clearInterval(adapter.mockInterval);
} catch (e) {
  console.error('[FAIL] DhanAdapter:', e.message);
}

// Step 4: Test Express
try {
  const express = (await import('express')).default;
  const { createServer } = await import('http');
  
  const app = express();
  const server = createServer(app);
  
  app.get('/test', (req, res) => {
    res.json({ status: 'ok' });
  });
  
  await new Promise((resolve, reject) => {
    server.listen(4000, () => {
      console.log('[PASS] Express listening on port 4000');
      resolve();
    });
    server.on('error', (e) => {
      console.error('[FAIL] Express port error:', e.message);
      reject(e);
    });
  });
  
  server.close();
  console.log('[PASS] Express closed cleanly');
} catch (e) {
  console.error('[FAIL] Express:', e.message);
}

// Step 5: Test WebSocket server
try {
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ port: 4001 });
  console.log('[PASS] WebSocket server on port 4001');
  wss.close();
  console.log('[PASS] WebSocket closed cleanly');
} catch (e) {
  console.error('[FAIL] WebSocket:', e.message);
}

console.log('\n=== ALL DIAGNOSTICS COMPLETE ===');
process.exit(0);
