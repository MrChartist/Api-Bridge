/**
 * 🌉 Mr. Chartist API Bridge — Dashboard SPA
 * Brand-aligned frontend with live data, WebSocket, option chain.
 */

const API = '';
const WS_URL = `ws://${location.hostname}:4501`;

const state = { health: null, funds: null, ws: null, ticks: {}, fnoCount: 0, page: 'dashboard' };

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.sb-item[data-page]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); nav(el.dataset.page); closeMobile(); });
  });
  document.getElementById('overlay')?.addEventListener('click', closeMobile);
  nav(location.hash.slice(1) || 'dashboard');
  healthLoop();
});

function closeMobile() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('overlay')?.classList.remove('on');
}

function nav(page) {
  state.page = page;
  location.hash = page;
  document.querySelectorAll('.sb-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.sb-item[data-page="${page}"]`)?.classList.add('active');
  const T = { dashboard:'Dashboard', positions:'Positions', orders:'Order Book', trades:'Trade Book', holdings:'Holdings', funds:'Funds', search:'Symbol Search', optionchain:'Option Chain', websocket:'WebSocket Test', api:'API Explorer', health:'Health Monitor', history:'Historical Data', greeks:'Option Greeks' };
  document.getElementById('pageTitle').textContent = T[page] || 'Dashboard';
  render(page);
}

function render(p) {
  const c = document.getElementById('pageContainer');
  ({ dashboard: pgDash, positions: pgPos, orders: pgOrd, trades: pgTrd, holdings: pgHld, funds: pgFunds, search: pgSearch, optionchain: pgOC, websocket: pgWS, api: pgApi, health: pgHealth, history: pgHistory, greeks: pgGreeks }[p] || pgDash)(c);
}

// ── API ──
async function get(ep) { try { return await (await fetch(API + ep)).json(); } catch(e) { return { status:'error', error: e.message }; } }
async function post(ep, b) { try { return await (await fetch(API + ep, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b) })).json(); } catch(e) { return { status:'error', error: e.message }; } }

function healthLoop() {
  const fn = async () => { state.health = await get('/api/v1/health'); updateBroker(); if (state.page === 'dashboard') updateDashStats(); if (state.page === 'health') pgHealth(document.getElementById('pageContainer')); };
  fn(); setInterval(fn, 8000);
}

function updateBroker() {
  const h = state.health; if (!h) return;
  const d = document.getElementById('brokerDot');
  const n = document.getElementById('brokerName');
  if (d) d.className = 'dot' + (h.broker?.connected ? '' : ' off');
  if (n) n.textContent = `${h.broker?.name || '—'} · ${h.broker?.connected ? 'Live' : 'Offline'}`;
}

// ══════════════════ Dashboard ══════════════════

async function pgDash(el) {
  el.innerHTML = `
    <div class="stats stagger" id="fundRow">
      ${statHTML('Available Balance', '—', '--bullish')} ${statHTML('Collateral', '—', '--primary')} ${statHTML('Unrealized P&L', '—', '--cyan')} ${statHTML('Used Margin', '—', '--warning')} ${statHTML('F&O Symbols', '—', '--indigo')}
    </div>
    <div class="stats stagger" id="sysRow">
      ${statHTML('Master Contract', '⏳', '--primary')} ${statHTML('Total Ticks', '—', '--cyan')} ${statHTML('Memory', '—', '--pink')} ${statHTML('Uptime', '—', '--bullish')} ${statHTML('WS Clients', '—', '--amber')}
    </div>
    <h2 style="font-size:1.1rem;margin:1.25rem 0 0.75rem">Quick Access</h2>
    <div class="qgrid stagger">
      ${qHTML('🔍','rgba(124,58,237,0.12)','Symbol Search','Find any stock, index or F&O','search')}
      ${qHTML('⛓️','rgba(139,92,246,0.12)','Option Chain','ATM-centered live option chain','optionchain')}
      ${qHTML('📐','rgba(99,102,241,0.12)','Option Greeks','Black-76 Delta, Gamma, Theta, IV','greeks')}
      ${qHTML('📈','rgba(6,182,212,0.1)','Historical Data','OHLCV candles with SQLite cache','history')}
      ${qHTML('📊','rgba(34,197,94,0.1)','Positions','Open positions with live P&L','positions')}
      ${qHTML('📋','rgba(245,158,11,0.1)','Order Book','All orders — pending, completed','orders')}
      ${qHTML('⚡','rgba(6,182,212,0.1)','WebSocket Test','Subscribe to live market ticks','websocket')}
      ${qHTML('🧩','rgba(236,72,153,0.1)','API Explorer','Test all 28 REST endpoints','api')}
    </div>`;
  const [f, fno] = await Promise.all([get('/api/v1/funds'), get('/api/v1/fno-symbols')]);
  state.funds = f?.data; state.fnoCount = fno?.count || 0; updateDashStats();
}

function statHTML(lbl, val, accent) { return `<div class="stat animate-in" style="--stat-accent:var(${accent})"><div class="stat-lbl">${lbl}</div><div class="stat-val ${val === '—' ? 'shimmer' : ''}">${val}</div></div>`; }
function qHTML(icon, bg, lbl, desc, pg) { return `<div class="qcard animate-in" onclick="nav('${pg}')"><div class="qi" style="background:${bg}">${icon}</div><div><div class="ql">${lbl}</div><div class="qd">${desc}</div></div></div>`; }

function updateDashStats() {
  const f = state.funds || {}, h = state.health;
  const fr = document.querySelectorAll('#fundRow .stat');
  if (!fr.length) return;
  setStatVal(fr[0], inr(f.availableBalance || f.availablecash || 0));
  setStatVal(fr[1], inr(f.collateralAmount || f.collateral || 0));
  const pnl = parseFloat(f.m2munrealized || f.unrealizedProfit || 0);
  setStatVal(fr[2], inr(pnl), pnl >= 0 ? 'profit' : 'loss');
  setStatVal(fr[3], inr(f.utilisedDebits || f.utiliseddebits || 0));
  setStatVal(fr[4], state.fnoCount.toLocaleString());
  if (h) {
    const sr = document.querySelectorAll('#sysRow .stat');
    if (!sr.length) return;
    setStatVal(sr[0], h.engine?.cachedSymbols > 0 ? '✅ Ready' : '⏳ Loading');
    setStatVal(sr[1], (h.engine?.totalTicks || 0).toLocaleString());
    setStatVal(sr[2], (h.memory?.heapUsedMB || 0) + ' MB');
    setStatVal(sr[3], uptime(h.uptime || 0));
    setStatVal(sr[4], String(h.wsClients || 0));
  }
}

function setStatVal(el, val, cls) {
  const v = el?.querySelector('.stat-val'); if (!v) return;
  v.textContent = val; v.classList.remove('shimmer');
  if (cls) { v.classList.remove('profit','loss'); v.classList.add(cls); }
}

// ══════════════════ Data Pages ══════════════════

async function pgPos(el) { el.innerHTML = loading('positions'); const d = await get('/api/v1/positions'); const r = arr(d); if (!r.length) { el.innerHTML = empty('📊','No open positions','Positions will appear during market hours'); return; } el.innerHTML = card('Open Positions', r.length, tbl(['Symbol','Type','Qty','Avg Price','LTP','P&L'], r.map(x => { const p = pf(x.realizedProfit || x.dayPnl || x.pnl || 0); return [bold(x.tradingSymbol || x.symbol), badge(x.positionType || (pf(x.netQty) > 0 ? 'LONG':'SHORT'), pf(x.netQty) > 0 ? 'green':'red'), x.netQty || x.quantity, fix(x.costPrice || x.averagePrice), fix(x.ltp || x.lastPrice), `<span class="${p>=0?'profit':'loss'}" style="font-weight:600">${inr(p)}</span>`]; }))); }
async function pgOrd(el) { el.innerHTML = loading('orders'); const d = await get('/api/v1/orders'); const r = arr(d); if (!r.length) { el.innerHTML = empty('📋','No orders today','Place orders to see them here'); return; } el.innerHTML = card('Order Book', r.length, tbl(['Time','Symbol','Side','Type','Qty','Price','Status'], r.map(x => { const b = (x.transactionType||x.orderSide||'').toUpperCase().includes('BUY'); const s = x.orderStatus||x.status||'?'; return [x.createTime||x.orderTimestamp||'—', bold(x.tradingSymbol||x.symbol), badge(b?'BUY':'SELL',b?'green':'red'), x.orderType||'—', x.quantity||0, fix(x.price), badge(s, s==='TRADED'||s==='COMPLETE'?'green':s==='REJECTED'?'red':'amber')]; }))); }
async function pgTrd(el) { el.innerHTML = loading('trades'); const d = await get('/api/v1/trades'); const r = arr(d); if (!r.length) { el.innerHTML = empty('💰','No trades today','Executed trades appear here'); return; } el.innerHTML = card('Trade Book', r.length, tbl(['Time','Symbol','Side','Qty','Price','Exchange'], r.map(x => { const b = (x.transactionType||'').toUpperCase().includes('BUY'); return [x.tradedTime||x.tradeTimestamp||'—', bold(x.tradingSymbol||x.symbol), badge(b?'BUY':'SELL',b?'green':'red'), x.tradedQuantity||x.quantity||0, fix(x.tradedPrice||x.price), x.exchangeSegment||x.exchange||'—']; }))); }
async function pgHld(el) { el.innerHTML = loading('holdings'); const d = await get('/api/v1/holdings'); const r = arr(d); if (!r.length) { el.innerHTML = empty('🏦','No holdings','Holdings from your demat appear here'); return; } el.innerHTML = card('Holdings', r.length, tbl(['Symbol','Qty','Avg Cost','LTP','Value','P&L'], r.map(x => { const p = pf(x.unrealizedProfit||x.pnl||0); return [bold(x.tradingSymbol||x.symbol), x.totalQty||x.quantity||0, fix(x.avgCostPrice||x.averagePrice), fix(x.ltp||x.lastPrice), inr(pf(x.ltp||0)*parseInt(x.totalQty||0)), `<span class="${p>=0?'profit':'loss'}" style="font-weight:600">${inr(p)}</span>`]; }))); }

async function pgFunds(el) {
  el.innerHTML = loading('funds');
  const d = await get('/api/v1/funds'); const f = d.data || {};
  el.innerHTML = `
    <div class="stats stagger">
      ${statHTML('Available Cash',inr(f.availableBalance||f.availablecash||0),'--bullish')}
      ${statHTML('Collateral',inr(f.collateralAmount||f.collateral||0),'--primary')}
      ${statHTML('Used Margin',inr(f.utilisedDebits||f.utiliseddebits||0),'--warning')}
      ${statHTML('Opening Balance',inr(f.sodLimit||f.openingBalance||0),'--cyan')}
    </div>
    <div class="card"><div class="card-head"><h3>Raw Funds Data</h3></div><div class="card-body"><pre class="mono" style="font-size:0.75rem;color:var(--text-secondary);white-space:pre-wrap">${JSON.stringify(f, null, 2)}</pre></div></div>`;
}

// ══════════════════ Search ══════════════════

function pgSearch(el) {
  el.innerHTML = `<div class="card" style="margin-bottom:0.75rem"><div class="card-body" style="display:flex;gap:0.75rem;align-items:center"><input type="text" id="sInput" placeholder="Search symbols (NIFTY, RELIANCE, TCS...)" style="flex:1" autofocus /><button class="btn btn-primary" onclick="doSearch()">Search</button></div></div><div id="sRes"></div>`;
  document.getElementById('sInput').addEventListener('keydown', e => { if (e.key==='Enter') doSearch(); });
}

async function doSearch() {
  const q = document.getElementById('sInput').value.trim(); if (q.length < 2) return;
  const r = document.getElementById('sRes'); r.innerHTML = loading('instruments');
  const d = await get(`/api/v1/search?q=${encodeURIComponent(q)}`); const rows = d.data || [];
  if (!rows.length) { r.innerHTML = empty('🔍','No results',`No instruments match "${q}"`); return; }
  r.innerHTML = card('Results', d.count, tbl(['Symbol','Security ID','Exchange','Segment'], rows.map(i => [bold(i.symbol), `<span class="mono">${i.securityId||'—'}</span>`, i.exchangeSegment||'—', badge(i.segment||'—','blue')])));
}

// ══════════════════ Option Chain ══════════════════

function pgOC(el) {
  el.innerHTML = `<div class="card" style="margin-bottom:0.75rem"><div class="card-body" style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap">
    <select id="ocSym" style="width:150px"><option>NIFTY</option><option>BANKNIFTY</option><option>FINNIFTY</option><option>MIDCPNIFTY</option><option>SENSEX</option></select>
    <select id="ocExp" style="width:170px"><option value="">Loading...</option></select>
    <input type="number" id="ocN" value="10" min="1" max="30" style="width:70px" />
    <button class="btn btn-primary" onclick="loadOC()">Load</button>
  </div></div><div id="ocRes"></div>`;
  document.getElementById('ocSym').addEventListener('change', loadExp);
  loadExp();
}

async function loadExp() {
  const s = document.getElementById('ocSym').value, sel = document.getElementById('ocExp');
  sel.innerHTML = '<option value="">Loading...</option>';
  const d = await get(`/api/v1/expirylist/${s}`);
  sel.innerHTML = (d.data || []).map((dt, i) => `<option value="${dt}" ${i===0?'selected':''}>${dt}</option>`).join('');
}

async function loadOC() {
  const sym = document.getElementById('ocSym').value, exp = document.getElementById('ocExp').value, n = document.getElementById('ocN').value;
  if (!exp) return;
  const r = document.getElementById('ocRes'); r.innerHTML = loading('chain');
  const d = await get(`/api/v1/optionchain/${sym}/${exp}?strikes=${n}`);
  if (d.status !== 'success' || !d.data?.chain) { r.innerHTML = `<div class="card"><div class="card-body" style="color:var(--bearish)">Error: ${d.error||'No chain data'}</div></div>`; return; }
  const c = d.data.chain;
  r.innerHTML = `
    <div class="stats stagger" style="margin-bottom:0.75rem">
      <div class="stat animate-in" style="--stat-accent:var(--cyan)"><div class="stat-lbl">Spot LTP</div><div class="stat-val">${fix(d.data.ltp)}</div></div>
      <div class="stat animate-in" style="--stat-accent:var(--warning)"><div class="stat-lbl">ATM Strike</div><div class="stat-val">${d.data.atmStrike}</div></div>
      <div class="stat animate-in" style="--stat-accent:var(--primary)"><div class="stat-lbl">Strikes</div><div class="stat-val">${c.length}</div></div>
    </div>
    <div class="card"><div class="tbl-wrap"><table>
      <thead><tr><th style="text-align:right">CE OI</th><th style="text-align:right">CE LTP</th><th style="text-align:center;color:var(--warning)">Strike</th><th>PE LTP</th><th>PE OI</th></tr></thead>
      <tbody>${c.map(row => {
        const atm = row.strike === d.data.atmStrike;
        return `<tr style="${atm ? 'background:rgba(124,58,237,0.06)' : ''}">
          <td style="text-align:right;font-variant-numeric:tabular-nums">${(row.ce?.oi||0).toLocaleString()}</td>
          <td style="text-align:right;font-weight:600;color:var(--bullish)">${fix(row.ce?.ltp)}</td>
          <td style="text-align:center;font-weight:700;color:${atm?'var(--warning)':'var(--text-primary)'}">${row.strike}</td>
          <td style="font-weight:600;color:var(--bearish)">${fix(row.pe?.ltp)}</td>
          <td style="font-variant-numeric:tabular-nums">${(row.pe?.oi||0).toLocaleString()}</td></tr>`;
      }).join('')}</tbody></table></div></div>`;
}

// ══════════════════ WebSocket ══════════════════

function pgWS(el) {
  el.innerHTML = `<div class="card" style="margin-bottom:0.75rem"><div class="card-body" style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap">
    <input type="text" id="wsS" value="NIFTY,BANKNIFTY" placeholder="Symbols" style="flex:1" />
    <button class="btn btn-primary" id="wsBtn" onclick="wsConn()">Connect</button>
    <button class="btn btn-ghost" onclick="wsDc()">Disconnect</button>
  </div></div>
  <div class="stats" id="wsSt"></div>
  <div class="card"><div class="card-head"><h3>Live Feed</h3><button class="btn btn-sm btn-ghost" onclick="document.getElementById('wsLog').innerHTML=''">Clear</button></div><div class="card-body"><div class="ws-log" id="wsLog"></div></div></div>`;
}

function wsConn() {
  if (state.ws?.readyState === WebSocket.OPEN) wsDc();
  const syms = document.getElementById('wsS').value.split(',').map(s => s.trim()).filter(Boolean);
  state.ws = new WebSocket(WS_URL);
  wl('Connecting to ' + WS_URL + '...', 'ws-out');
  state.ws.onopen = () => { wl('✅ Connected', 'ws-in'); state.ws.send(JSON.stringify({action:'subscribe',symbols:syms})); wl('→ Subscribed: ' + syms.join(', '), 'ws-out'); document.getElementById('wsBtn').textContent = '● Live'; };
  state.ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'tick') { const t = msg.data; state.ticks[t.symbol] = t; wl(`${t.symbol} @ ₹${t.ltp} (${t.change>=0?'+':''}${t.change})`, t.change>=0?'ws-in':'ws-err'); renderWS(); }
    else if (msg.type === 'snapshot') { wl(`Snapshot: ${msg.data.length} symbols`, 'ws-in'); msg.data.forEach(t => { state.ticks[t.symbol] = t; }); renderWS(); }
    else if (msg.type === 'welcome') { wl(`Welcome — broker: ${msg.broker}`, 'ws-in'); }
    else wl(JSON.stringify(msg), 'ws-dim');
  };
  state.ws.onclose = () => { wl('Disconnected', 'ws-err'); document.getElementById('wsBtn').textContent = 'Connect'; };
}

function wsDc() { if (state.ws) { state.ws.close(); state.ws = null; } }
function renderWS() { const el = document.getElementById('wsSt'); if (!el) return; el.innerHTML = Object.values(state.ticks).map(t => `<div class="stat animate-in" style="--stat-accent:${t.change>=0?'var(--bullish)':'var(--bearish)'}"><div class="stat-lbl">${t.symbol}</div><div class="stat-val">${pf(t.ltp||0).toFixed(2)}</div><div class="stat-sub ${t.change>=0?'profit':'loss'}">${t.change>=0?'+':''}${pf(t.change||0).toFixed(2)} (${pf(t.changePct||0).toFixed(2)}%)</div></div>`).join(''); }
function wl(msg, cls='ws-dim') { const el = document.getElementById('wsLog'); if (!el) return; el.innerHTML += `<div class="${cls}"><span style="color:var(--text-dim)">[${new Date().toLocaleTimeString()}]</span> ${msg}</div>`; el.scrollTop = el.scrollHeight; }

// ══════════════════ API Explorer ══════════════════

function pgApi(el) {
  const eps = [
    ['GET','/api/v1/health','System health & broker status'],['GET','/api/v1/status','Clients, subscriptions, cache'],['GET','/api/v1/brokers','Supported brokers'],
    ['POST','/api/v1/quotes','Cached quotes for symbols'],['GET','/api/v1/fno-symbols','All F&O eligible symbols'],['GET','/api/v1/search?q=NIFTY','Search instruments'],
    ['GET','/api/v1/instruments/NIFTY','Instrument details'],['GET','/api/v1/expirylist/NIFTY','Expiry dates'],
    ['GET','/api/v1/optionchain/NIFTY/2026-04-07?strikes=5','Live option chain'],
    ['POST','/api/v1/order','Place order'],['PUT','/api/v1/order/:orderId','Modify order'],['DELETE','/api/v1/order/:orderId','Cancel order'],
    ['GET','/api/v1/orders','Order book'],['GET','/api/v1/trades','Trade book'],['GET','/api/v1/positions','Positions'],['GET','/api/v1/holdings','Holdings'],
    ['GET','/api/v1/funds','Funds & margin'],['POST','/api/v1/instruments/refresh','Force refresh master'],
    ['POST','/api/v1/history','Historical OHLCV candles'],['GET','/api/v1/intervals','Supported chart intervals'],
    ['POST','/api/v1/greeks','Option Greeks (Black-76)'],['POST','/api/v1/greeks/batch','Batch Greeks for chain'],
    ['POST','/api/v1/smartorder','Smart order (auto-split)'],['POST','/api/v1/basket','Multi-leg basket order'],
    ['POST','/api/v1/positions/close-all','Close all positions'],['POST','/api/v1/orders/cancel-all','Cancel all pending orders'],
    ['GET','/api/v1/freeze-quantities','Exchange freeze qty limits'],
    ['POST','/api/v1/depth','Market depth (Level 2)']
  ];
  el.innerHTML = `<div class="card" style="margin-bottom:0.75rem"><div class="card-head"><h3>REST Endpoints (${eps.length})</h3></div><div class="card-body">${eps.map(([m,p,d]) => `<div class="ep" onclick="testEp('${m}','${p}')"><span class="method m-${m==='DELETE'?'del':m.toLowerCase()}">${m}</span><span class="ep-path">${p}</span><span class="ep-desc">${d}</span></div>`).join('')}</div></div>
  <div class="card"><div class="card-head"><h3>Response</h3></div><div class="card-body"><pre id="apiOut" class="mono" style="font-size:0.75rem;color:var(--text-secondary);max-height:400px;overflow:auto;white-space:pre-wrap">Click any endpoint above to test</pre></div></div>`;
}

async function testEp(m, p) {
  const o = document.getElementById('apiOut'); o.textContent = `${m} ${p}...`;
  try {
    const opt = { method: m };
    if (m === 'POST') {
      opt.headers = {'Content-Type':'application/json'};
      if (p.includes('quotes')) opt.body = JSON.stringify({symbols:['NIFTY','BANKNIFTY']});
      else if (p.includes('history')) opt.body = JSON.stringify({symbol:'NIFTY',exchange:'IDX_I',interval:'1D',startDate:'2026-03-01',endDate:'2026-04-03'});
      else if (p.includes('greeks/batch')) opt.body = JSON.stringify({options:[{symbol:'NIFTY03APR2524000CE'},{symbol:'NIFTY03APR2524000PE'}]});
      else if (p.includes('greeks')) opt.body = JSON.stringify({symbol:'NIFTY03APR2524000CE',forwardPrice:24000});
      else if (p.includes('depth')) opt.body = JSON.stringify({symbol:'NIFTY'});
    }
    const r = await fetch(p, opt); o.textContent = JSON.stringify(await r.json(), null, 2);
  } catch(e) { o.textContent = 'Error: ' + e.message; }
}

// ══════════════════ Health Monitor ══════════════════

function pgHealth(el) {
  const h = state.health; if (!h) { el.innerHTML = loading('health'); return; }
  el.innerHTML = `<div class="stats stagger">
    <div class="stat animate-in" style="--stat-accent:${h.broker?.connected?'var(--bullish)':'var(--bearish)'}"><div class="stat-lbl">Broker</div><div class="stat-val">${h.broker?.name||'—'}</div><div class="stat-sub"><span class="dot ${h.broker?.connected?'':'off'}" style="width:6px;height:6px;display:inline-block;margin-right:4px;vertical-align:middle"></span>${h.broker?.connected?'Connected':'Offline'}</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--cyan)"><div class="stat-lbl">Uptime</div><div class="stat-val">${uptime(h.uptime||0)}</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--primary)"><div class="stat-lbl">Heap</div><div class="stat-val">${h.memory?.heapUsedMB||0} MB</div><div class="stat-sub">of ${h.memory?.heapTotalMB||0} MB</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--pink)"><div class="stat-lbl">RSS</div><div class="stat-val">${h.memory?.rssMB||0} MB</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--amber)"><div class="stat-lbl">WS Clients</div><div class="stat-val">${h.wsClients||0}</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--indigo)"><div class="stat-lbl">Total Ticks</div><div class="stat-val">${(h.engine?.totalTicks||0).toLocaleString()}</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--bullish)"><div class="stat-lbl">Cached Symbols</div><div class="stat-val">${h.engine?.cachedSymbols||0}</div></div>
  </div>
  <div class="card"><div class="card-head"><h3>Raw Health Data</h3></div><div class="card-body"><pre class="mono" style="font-size:0.75rem;color:var(--text-secondary);white-space:pre-wrap">${JSON.stringify(h,null,2)}</pre></div></div>`;
}

// ══════════════════ Helpers ══════════════════

function inr(v) { const n = parseFloat(v)||0, a = Math.abs(n); let s; if (a>=1e7) s=(a/1e7).toFixed(2)+' Cr'; else if (a>=1e5) s=(a/1e5).toFixed(2)+' L'; else s=a.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); return (n<0?'-':'')+'₹'+s; }
function uptime(s) { if (s<60) return s+'s'; if (s<3600) return Math.floor(s/60)+'m '+s%60+'s'; return Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m'; }
function pf(v) { return parseFloat(v)||0; }
function fix(v) { return pf(v).toFixed(2); }
function bold(v) { return `<span style="color:var(--text-primary);font-weight:600">${v||'—'}</span>`; }
function badge(t, c) { return `<span class="badge badge-${c}">${t}</span>`; }
function arr(d) { return Array.isArray(d?.data) ? d.data : []; }
function loading(what) { return `<div style="text-align:center;padding:2.5rem;color:var(--text-muted)"><div class="shimmer" style="display:inline-block;font-size:0.85rem">Loading ${what}...</div></div>`; }
function empty(icon, title, sub) { return `<div class="card"><div class="empty"><div class="empty-icon">${icon}</div><div class="empty-text">${title}</div><div class="empty-sub">${sub}</div></div></div>`; }
function card(title, count, inner) { return `<div class="card"><div class="card-head"><h3>${title} (${count})</h3></div>${inner}</div>`; }
function tbl(heads, rows) { return `<div class="tbl-wrap"><table><thead><tr>${heads.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; }

// ══════════════════ Historical Data ══════════════════

function pgHistory(el) {
  const today = new Date().toISOString().split('T')[0];
  const month = new Date(Date.now() - 30*86400000).toISOString().split('T')[0];
  el.innerHTML = `<div class="card" style="margin-bottom:0.75rem"><div class="card-body" style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap">
    <input type="text" id="hSym" value="NIFTY" placeholder="Symbol" style="width:120px" />
    <select id="hExch" style="width:120px"><option value="IDX_I">Index</option><option value="NSE_EQ">NSE Equity</option><option value="NSE_FNO">NSE F&O</option><option value="BSE_EQ">BSE Equity</option></select>
    <select id="hInt" style="width:80px"><option value="1D">1D</option><option value="1h">1H</option><option value="15m">15m</option><option value="5m">5m</option><option value="1m">1m</option></select>
    <input type="date" id="hFrom" value="${month}" style="width:140px" />
    <input type="date" id="hTo" value="${today}" style="width:140px" />
    <button class="btn btn-primary" onclick="loadHistory()">Fetch</button>
  </div></div><div id="hRes"></div>`;
}

async function loadHistory() {
  const sym = document.getElementById('hSym').value.trim().toUpperCase();
  const r = document.getElementById('hRes'); r.innerHTML = loading('candles');
  const d = await post('/api/v1/history', {
    symbol: sym, exchange: document.getElementById('hExch').value,
    interval: document.getElementById('hInt').value,
    startDate: document.getElementById('hFrom').value,
    endDate: document.getElementById('hTo').value
  });
  if (d.status !== 'success' || !d.data?.length) { r.innerHTML = empty('📈','No data',d.error||'No candles returned'); return; }
  const candles = d.data;
  r.innerHTML = `<div class="stats stagger" style="margin-bottom:0.75rem">
    <div class="stat animate-in" style="--stat-accent:var(--primary)"><div class="stat-lbl">Candles</div><div class="stat-val">${candles.length}</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--bullish)"><div class="stat-lbl">High</div><div class="stat-val">${fix(Math.max(...candles.map(c=>c.high)))}</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--bearish)"><div class="stat-lbl">Low</div><div class="stat-val">${fix(Math.min(...candles.map(c=>c.low)))}</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--cyan)"><div class="stat-lbl">Source</div><div class="stat-val">${d.source}</div></div>
  </div>` + card(`${sym} · ${d.interval}`, candles.length, tbl(
    ['Date','Open','High','Low','Close','Volume'],
    candles.slice(-50).reverse().map(c => [
      c.date ? new Date(c.date).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'}) : '—',
      fix(c.open), `<span class="profit">${fix(c.high)}</span>`, `<span class="loss">${fix(c.low)}</span>`,
      `<span style="font-weight:600">${fix(c.close)}</span>`, (c.volume||0).toLocaleString()
    ])
  ));
}

// ══════════════════ Option Greeks ══════════════════

function pgGreeks(el) {
  el.innerHTML = `<div class="card" style="margin-bottom:0.75rem"><div class="card-head"><h3>Black-76 Greeks Calculator</h3></div><div class="card-body">
    <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem">
      <input type="text" id="gSym" value="NIFTY03APR2524000CE" placeholder="Option symbol" style="flex:1;min-width:200px" />
      <input type="number" id="gFwd" placeholder="Forward price (optional)" style="width:160px" step="0.01" />
      <input type="number" id="gRate" value="7" placeholder="Interest rate %" style="width:100px" step="0.1" />
      <button class="btn btn-primary" onclick="calcGreeks()">Calculate</button>
    </div>
    <div style="font-size:0.72rem;color:var(--text-muted)">Format: SYMBOL + DD + MON + YY + STRIKE + CE/PE — e.g. NIFTY03APR2524000CE</div>
  </div></div><div id="gRes"></div>`;
}

async function calcGreeks() {
  const sym = document.getElementById('gSym').value.trim();
  const fwd = parseFloat(document.getElementById('gFwd').value) || undefined;
  const rate = parseFloat(document.getElementById('gRate').value) || 7;
  const r = document.getElementById('gRes'); r.innerHTML = loading('greeks');
  const d = await post('/api/v1/greeks', { symbol: sym, interestRate: rate, forwardPrice: fwd });
  if (d.status !== 'success') { r.innerHTML = `<div class="card"><div class="card-body" style="color:var(--bearish)">Error: ${d.error||'Calculation failed'}</div></div>`; return; }
  const g = d.greeks;
  r.innerHTML = `<div class="stats stagger" style="margin-bottom:0.75rem">
    <div class="stat animate-in" style="--stat-accent:var(--primary)"><div class="stat-lbl">IV</div><div class="stat-val">${d.iv}%</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--cyan)"><div class="stat-lbl">Delta</div><div class="stat-val">${g.delta}</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--indigo)"><div class="stat-lbl">Gamma</div><div class="stat-val">${g.gamma}</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--bearish)"><div class="stat-lbl">Theta</div><div class="stat-val">${g.theta}</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--bullish)"><div class="stat-lbl">Vega</div><div class="stat-val">${g.vega}</div></div>
    <div class="stat animate-in" style="--stat-accent:var(--warning)"><div class="stat-lbl">Rho</div><div class="stat-val">${g.rho}</div></div>
  </div>
  <div class="card"><div class="card-head"><h3>Full Result</h3></div><div class="card-body">
    <div class="tbl-wrap"><table><tbody>
      <tr><td style="color:var(--text-muted)">Symbol</td><td style="font-weight:600">${d.symbol}</td></tr>
      <tr><td style="color:var(--text-muted)">Underlying</td><td>${d.underlying}</td></tr>
      <tr><td style="color:var(--text-muted)">Strike</td><td>${d.strike}</td></tr>
      <tr><td style="color:var(--text-muted)">Type</td><td>${badge(d.type, d.type==='CE'?'green':'red')}</td></tr>
      <tr><td style="color:var(--text-muted)">Expiry</td><td>${d.expiryDate}</td></tr>
      <tr><td style="color:var(--text-muted)">Days to Expiry</td><td>${d.daysToExpiry}</td></tr>
      <tr><td style="color:var(--text-muted)">Forward Price</td><td>₹${fix(d.forwardPrice)}</td></tr>
      <tr><td style="color:var(--text-muted)">Market Price</td><td>₹${fix(d.optionPrice)}</td></tr>
      <tr><td style="color:var(--text-muted)">Theoretical Price</td><td>₹${fix(d.theoreticalPrice)}</td></tr>
      <tr><td style="color:var(--text-muted)">Interest Rate</td><td>${d.interestRate}%</td></tr>
    </tbody></table></div>
  </div></div>`;
}
