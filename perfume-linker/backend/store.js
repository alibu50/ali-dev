/**
 * Tiny persistence layer. Local dev = one JSON file keyed by store id.
 * Swap this module for Vercel KV / Postgres in production without touching
 * the rest of the app (same get/set/list interface).
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.PL_DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'stores.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '{}', 'utf8');
}

function readAll() {
  ensure();
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function writeAll(obj) {
  ensure();
  fs.writeFileSync(DB_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

// Default config a store starts with the first time we see it.
function defaultConfig(storeId, platform) {
  return {
    storeId: String(storeId),
    platform: platform || 'salla',
    token: null,
    active: true,
    widget: {
      enabled: true,
      mode: 'tags',                 // link product variants by shared tag
      title: 'متوفر أيضاً بمقاسات وخيارات أخرى',
      limit: 8,
      placement: 'after_buybox'     // after_buybox | after_description | custom
    },
    popup: {
      enabled: true,
      template: 'classic',          // template id from the dashboard gallery
      title: 'قبل أن تغادر…',
      subtitle: 'نفس القطعة متوفرة بخيارات ومقاسات أخرى — ألقِ نظرة:',
      cooldownHours: 24,
      coupon: ''
    },
    // Merchant-built curated rows, e.g. a "summer collection" keyed by a tag.
    rows: []
  };
}

function getStore(storeId) {
  const all = readAll();
  return all[String(storeId)] || null;
}

function upsertStore(storeId, patch, platform) {
  const all = readAll();
  const key = String(storeId);
  const existing = all[key] || defaultConfig(storeId, platform);
  all[key] = deepMerge(existing, patch || {});
  writeAll(all);
  return all[key];
}

function setToken(storeId, token, platform) {
  return upsertStore(storeId, { token, active: true }, platform);
}

function setActive(storeId, active) {
  const s = getStore(storeId);
  if (!s) return null;
  return upsertStore(storeId, { active: !!active });
}

// public config the storefront snippet is allowed to see (never the token)
function publicConfig(storeId) {
  const s = getStore(storeId);
  if (!s || !s.active) return null;
  return {
    storeId: s.storeId,
    widget: s.widget,
    popup: { ...s.popup },
    rows: (s.rows || []).filter(function (r) { return r.enabled; })
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

module.exports = {
  defaultConfig, getStore, upsertStore, setToken, setActive, publicConfig
};
