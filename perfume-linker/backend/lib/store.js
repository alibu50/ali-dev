/**
 * Storage adapter.
 *   - On Vercel: Upstash Redis over REST (no SDK, plain fetch).
 *   - Locally: a JSON file, so `node server.js` still works with no setup.
 * Same async interface either way.
 */
const fs = require('fs');
const path = require('path');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const useRedis = !!(REDIS_URL && REDIS_TOKEN);

const DATA_DIR = process.env.PL_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'stores.json');
const KEY = (id) => 'pl:store:' + id;

/* ---------- redis (rest) ---------- */
async function redis(cmd) {
  const res = await fetch(REDIS_URL + '/' + cmd.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN }
  });
  if (!res.ok) throw new Error('redis ' + res.status);
  return (await res.json()).result;
}

/* ---------- file ---------- */
function fileAll() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return {}; }
}
function fileWrite(obj) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

/* ---------- shape ---------- */
function defaultConfig(storeId, platform) {
  return {
    storeId: String(storeId),
    platform: platform || 'salla',
    token: null,
    active: true,
    widget: {
      enabled: true,
      mode: 'tags',
      title: 'متوفر أيضاً بمقاسات وخيارات أخرى',
      limit: 8,
      placement: 'after_buybox'
    },
    popup: {
      enabled: true,
      template: 'classic',
      title: 'قبل أن تغادر…',
      subtitle: 'نفس القطعة متوفرة بخيارات ومقاسات أخرى — ألقِ نظرة:',
      cooldownHours: 24,
      coupon: ''
    },
    rows: []
  };
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch && typeof patch === 'object') {
    const out = Object.assign({}, base);
    for (const k of Object.keys(patch)) {
      out[k] = (base && typeof base[k] === 'object' && !Array.isArray(base[k]))
        ? deepMerge(base[k], patch[k])
        : patch[k];
    }
    return out;
  }
  return patch;
}

/* ---------- api ---------- */
async function getStore(storeId) {
  if (useRedis) {
    const raw = await redis(['get', KEY(storeId)]);
    return raw ? JSON.parse(raw) : null;
  }
  return fileAll()[String(storeId)] || null;
}

async function putStore(storeId, obj) {
  if (useRedis) {
    await redis(['set', KEY(storeId), JSON.stringify(obj)]);
    return obj;
  }
  const all = fileAll();
  all[String(storeId)] = obj;
  fileWrite(all);
  return obj;
}

async function upsertStore(storeId, patch, platform) {
  const existing = (await getStore(storeId)) || defaultConfig(storeId, platform);
  return putStore(storeId, deepMerge(existing, patch || {}));
}

async function setToken(storeId, token, platform) {
  return upsertStore(storeId, { token, active: true }, platform);
}

async function setActive(storeId, active) {
  if (!(await getStore(storeId))) return null;
  return upsertStore(storeId, { active: !!active });
}

// What the storefront snippet may see — never the merchant token.
async function publicConfig(storeId) {
  const s = await getStore(storeId);
  if (!s || !s.active) return null;
  return {
    storeId: s.storeId,
    widget: s.widget,
    popup: Object.assign({}, s.popup),
    rows: (s.rows || []).filter((r) => r.enabled)
  };
}

module.exports = {
  defaultConfig, getStore, upsertStore, setToken, setActive, publicConfig,
  backend: useRedis ? 'redis' : 'file'
};
