// GET/POST /api/admin/config?store=<id> — read/write config from the dashboard.
// NOTE: still trusts the store id. Before public launch this must verify the
// signed Salla embedded-app context instead.
const store = require('../../lib/store');

module.exports = async function handler(req, res) {
  const storeId = req.query.store || (req.body && req.body.store);
  if (!storeId) return res.status(400).json({ error: 'store required' });

  try {
    const existing = await store.getStore(storeId);
    if (!existing) return res.status(404).json({ error: 'store not installed' });

    if (req.method === 'GET') {
      const safe = Object.assign({}, existing);
      delete safe.token;
      return res.status(200).json(safe);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const patch = body.config;
      if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'config required' });
      delete patch.token; delete patch.storeId;
      const updated = await store.upsertStore(storeId, patch);
      const safe = Object.assign({}, updated);
      delete safe.token;
      return res.status(200).json({ ok: true, config: safe });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'config operation failed' });
  }
};
