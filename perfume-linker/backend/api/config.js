// GET /api/config?store=<id> — public widget config for the storefront snippet.
const store = require('../lib/store');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=60');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const storeId = req.query.store;
  if (!storeId) return res.status(400).json({ error: 'store required' });

  try {
    const cfg = await store.publicConfig(storeId);
    return res.status(200).json(cfg || { active: false });
  } catch (e) {
    return res.status(500).json({ error: 'lookup failed' });
  }
};
