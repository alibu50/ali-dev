/**
 * Perfume Linker — Cloudflare Worker.
 *
 * Serves everything the app needs at the edge:
 *   GET  /api/config?store=<id>   public widget config (storefront snippet)
 *   GET  /api/admin/config        dashboard read
 *   POST /api/admin/config        dashboard write
 *   POST /webhook                 Salla app events (verified)
 *   POST /settings/validate       Salla native-settings validation hook
 *   GET  /dashboard               embedded dashboard UI (static asset)
 *
 * Storage: Workers KV (binding PL_KV).
 * Secrets: SALLA_WEBHOOK_SECRET, SALLA_WEBHOOK_STRATEGY ("signature" | "token" | "none").
 */

const KEY = (id) => `store:${id}`;

/* ---------- helpers ---------- */

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra }
  });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type'
};

function defaultConfig(storeId, platform = 'salla') {
  return {
    storeId: String(storeId),
    platform,
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
    const out = { ...base };
    for (const k of Object.keys(patch)) {
      out[k] =
        base && typeof base[k] === 'object' && !Array.isArray(base[k])
          ? deepMerge(base[k], patch[k])
          : patch[k];
    }
    return out;
  }
  return patch;
}

const getStore = async (env, id) => JSON.parse((await env.PL_KV.get(KEY(id))) || 'null');
const putStore = async (env, id, obj) => {
  await env.PL_KV.put(KEY(id), JSON.stringify(obj));
  return obj;
};

async function upsertStore(env, id, patch, platform) {
  const existing = (await getStore(env, id)) || defaultConfig(id, platform);
  return putStore(env, id, deepMerge(existing, patch || {}));
}

/* ---------- webhook verification (Salla contract) ---------- */

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, rawBody) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `signature` → x-salla-signature is HMAC-SHA256 of the RAW body.
 * `token`     → Authorization header equals the secret verbatim.
 * Fails closed when a secret is configured but the delivery doesn't match.
 */
async function verifyWebhook(req, rawBody, env) {
  const strategy = env.SALLA_WEBHOOK_STRATEGY || 'signature';
  const secret = env.SALLA_WEBHOOK_SECRET;
  if (strategy === 'none') return true;
  if (!secret) return false; // configured to verify but no secret → reject

  if (strategy === 'token') {
    return timingSafeEqual(req.headers.get('authorization') || '', secret);
  }
  const sent = req.headers.get('x-salla-signature') || '';
  if (!sent) return false;
  return timingSafeEqual(sent, await hmacHex(secret, rawBody));
}

/* ---------- worker ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const storeParam = url.searchParams.get('store');

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (path === '/' && request.method === 'GET') {
      return new Response('Perfume Linker — ok', { headers: { 'content-type': 'text/plain' } });
    }

    /* public widget config — hit on every product page view, so cache at the edge */
    if (path === '/api/config' && request.method === 'GET') {
      if (!storeParam) return json({ error: 'store required' }, 400, CORS);
      const s = await getStore(env, storeParam);
      if (!s || !s.active) return json({ active: false }, 200, { ...CORS, 'cache-control': 'public, max-age=60' });
      return json(
        {
          storeId: s.storeId,
          widget: s.widget,
          popup: { ...s.popup },
          rows: (s.rows || []).filter((r) => r.enabled)
        },
        200,
        { ...CORS, 'cache-control': 'public, max-age=60' }
      );
    }

    /* dashboard read/write
       TODO(auth): verify the signed Salla embedded context instead of trusting ?store= */
    if (path === '/api/admin/config') {
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      const storeId = storeParam || body.store;
      if (!storeId) return json({ error: 'store required' }, 400);

      const existing = await getStore(env, storeId);
      if (!existing) return json({ error: 'store not installed' }, 404);

      if (request.method === 'GET') {
        const { token, ...safe } = existing;
        return json(safe);
      }
      if (request.method === 'POST') {
        const patch = body.config;
        if (!patch || typeof patch !== 'object') return json({ error: 'config required' }, 400);
        delete patch.token;
        delete patch.storeId;
        const updated = await upsertStore(env, storeId, patch);
        const { token, ...safe } = updated;
        return json({ ok: true, config: safe });
      }
      return json({ error: 'method not allowed' }, 405);
    }

    /* Salla app events */
    if (path === '/webhook' && request.method === 'POST') {
      const raw = await request.text();
      if (!(await verifyWebhook(request, raw, env))) {
        return json({ error: 'unauthorized' }, 401);
      }
      let body = {};
      try { body = JSON.parse(raw); } catch (e) { /* keep 200, nothing to do */ }

      const event = body.event;
      const storeId = body.merchant || body.data?.merchant;
      try {
        if (event === 'app.store.authorize') {
          const token = body.data?.access_token || body.data?.token;
          if (storeId && token) await upsertStore(env, storeId, { token, active: true }, 'salla');
        } else if (event === 'app.installed') {
          if (storeId) await upsertStore(env, storeId, { active: true }, 'salla');
        } else if (event === 'app.uninstalled') {
          if (storeId) await upsertStore(env, storeId, { active: false });
        }
      } catch (e) { /* always 200 — Salla retries otherwise */ }
      return json({ ok: true });
    }

    if (path === '/settings/validate' && request.method === 'POST') {
      return json({ success: true });
    }


    /* embedded dashboard UI */
    if (path === '/dashboard' || path.startsWith('/dashboard/')) {
      return env.ASSETS.fetch(new Request(new URL('/dashboard.html', request.url), request));
    }

    return json({ error: 'not found' }, 404);
  }
};
