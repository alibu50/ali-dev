// POST /webhook — Salla app events (Easy Mode). Captures the merchant token
// on app.store.authorize and deactivates on uninstall.
const store = require('../lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const event = body.event;
  const storeId = body.merchant || (body.data && body.data.merchant);

  try {
    if (event === 'app.store.authorize') {
      const token = body.data && (body.data.access_token || body.data.token);
      if (storeId && token) await store.setToken(storeId, token, 'salla');
    } else if (event === 'app.installed') {
      if (storeId) await store.upsertStore(storeId, { active: true }, 'salla');
    } else if (event === 'app.uninstalled') {
      if (storeId) await store.setActive(storeId, false);
    }
  } catch (e) {
    // Never fail the webhook — Salla retries and we don't want duplicate churn.
  }
  return res.status(200).json({ ok: true });
};
