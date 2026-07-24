/**
 * Perfume Linker backend + embedded dashboard. Zero dependencies (Node http),
 * so it runs anywhere without npm install and deploys trivially.
 *
 * Jobs:
 *   1. Receive Salla app webhooks (authorize → store token, uninstall → deactivate)
 *   2. Serve public widget config to the storefront snippet (GET /api/config)
 *   3. Back the embedded dashboard (GET/POST /api/admin/config)
 *   4. Host the embedded dashboard UI (GET /dashboard)
 *   5. Answer Salla's settings validation URL so the native form can save too
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const store = require('./store');

const PORT = process.env.PORT || 3456;
const PUBLIC_DIR = path.join(__dirname, 'public');

function send(res, status, body, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {});
  res.writeHead(status, h);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise(function (resolve) {
    let data = '';
    req.on('data', function (c) { data += c; if (data.length > 262144) req.destroy(); });
    req.on('end', function () { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
  });
}

function serveStatic(res, rel) {
  const file = rel === '' || rel === '/' ? 'index.html' : rel.replace(/^\//, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) return send(res, 404, 'not found');
  const ext = path.extname(full).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js' ? 'application/javascript; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  res.end(fs.readFileSync(full));
}

const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const q = u.searchParams;

  // CORS preflight for storefront reads
  if (req.method === 'OPTIONS') { cors(res); return send(res, 204, ''); }

  // health
  if (p === '/' && req.method === 'GET') return send(res, 200, 'Perfume Linker backend — ok');

  // Salla webhooks (Easy Mode)
  if (p === '/webhook' && req.method === 'POST') {
    const body = await readBody(req);
    const event = body.event;
    const storeId = body.merchant || (body.data && body.data.merchant);
    try {
      if (event === 'app.store.authorize') {
        const token = body.data && (body.data.access_token || body.data.token);
        if (storeId && token) { store.setToken(storeId, token, 'salla'); console.log('authorized', storeId); }
      } else if (event === 'app.installed') {
        if (storeId) store.upsertStore(storeId, { active: true }, 'salla');
      } else if (event === 'app.uninstalled') {
        if (storeId) store.setActive(storeId, false);
      }
    } catch (e) { console.error('webhook error', e); }
    return send(res, 200, { ok: true });
  }

  // public config for the storefront snippet
  if (p === '/api/config' && req.method === 'GET') {
    cors(res);
    const storeId = q.get('store');
    if (!storeId) return send(res, 400, { error: 'store required' });
    const cfg = store.publicConfig(storeId);
    return send(res, 200, cfg || { active: false });
  }

  // embedded dashboard read
  if (p === '/api/admin/config' && req.method === 'GET') {
    const storeId = q.get('store');
    if (!storeId) return send(res, 400, { error: 'store required' });
    const s = store.getStore(storeId);
    if (!s) return send(res, 404, { error: 'store not installed' });
    const safe = Object.assign({}, s); delete safe.token;
    return send(res, 200, safe);
  }

  // embedded dashboard write
  if (p === '/api/admin/config' && req.method === 'POST') {
    const body = await readBody(req);
    const storeId = q.get('store') || body.store;
    if (!storeId) return send(res, 400, { error: 'store required' });
    if (!store.getStore(storeId)) return send(res, 404, { error: 'store not installed' });
    const patch = body.config;
    if (!patch || typeof patch !== 'object') return send(res, 400, { error: 'config required' });
    delete patch.token; delete patch.storeId;
    const updated = store.upsertStore(storeId, patch);
    const safe = Object.assign({}, updated); delete safe.token;
    return send(res, 200, { ok: true, config: safe });
  }

  // Salla native settings validation URL — returning valid unblocks that save
  if (p === '/settings/validate' && req.method === 'POST') {
    const body = await readBody(req);
    console.log('settings validate for', body && body.merchant);
    return send(res, 200, { success: true });
  }

  // embedded dashboard UI
  if (p === '/dashboard' || p.startsWith('/dashboard/')) {
    return serveStatic(res, p.replace(/^\/dashboard/, '') || '/');
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, function () { console.log('perfume-linker backend on :' + PORT); });
