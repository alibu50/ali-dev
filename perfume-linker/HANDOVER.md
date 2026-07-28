# Handover

Everything needed to take this over. **No secrets are in this repo, and none need to be
sent to you** — every credential below is regenerated on your own accounts.

---

## 1. Accounts you create (nothing to receive)

| Account | What for | Notes |
|---|---|---|
| **Salla Partners** | owns the app | the app is transferred to you (portal → app → transfer, asks for your email) |
| **Cloudflare** (free) | runs the Worker + KV | you create it; nothing carries over |
| **GitHub** | this repo | |

Credentials that regenerate on your side, so never send them over chat/email:

- `SALLA_WEBHOOK_SECRET` — read it from your Partners portal after the transfer
  (app page → the `webhook_secret` field), then `wrangler secret put SALLA_WEBHOOK_SECRET`
- App `client_secret` — visible in your portal under App Keys
- Merchant access tokens — re-delivered by Salla's `app.store.authorize` webhook on install

---

## 2. Reference IDs

| Thing | Value |
|---|---|
| Salla app id | `1980285284` |
| App snippet id | `1267955402` |
| Demo store id | `544126322` |
| Demo storefront | `https://demostore.salla.sa/dev-of5dten0bjsqbsqs` |
| Worker URL (current) | `https://perfume-linker.hjr-apps.workers.dev` |
| KV namespace id | `50579d0a2b0a418e8ae4606a244ccc5d` — **tied to the old account, replace with your own** |

Demo-store tag ids (one per fragrance family, used by the widget):
`xerjoff-don 27309170` · `min-dahab 1401803635` · `bvlgari-opalon 761983612` ·
`amado-seduction 2134315389` · `akro-awake 1226584190`

---

## 3. First-time setup

```bash
cd worker
npx wrangler@3.114.14 login                      # wrangler v4 needs Node 22+; v3 works on 18
npx wrangler@3.114.14 kv namespace create PL_KV  # put the returned id in wrangler.toml
npx wrangler@3.114.14 secret put SALLA_WEBHOOK_SECRET
npx wrangler@3.114.14 deploy
```

Cloudflare requires a **verified email** before a Worker can go live, and a
`workers.dev` subdomain must exist (create one in the dashboard on first visit).

---

## 4. After deploying, re-point four URLs to your Worker

All four currently point at the old Worker. Replace `<WORKER>` with your URL.

| What | Where | Value |
|---|---|---|
| Widget config source | `perfume-linker.js` → `CONFIG.backendBase` | `<WORKER>` |
| Webhook | Partners API `POST /app/{id}/webhooks/url/` | `<WORKER>/webhook` + `webhook_security_strategy: "signature"` |
| Settings validation | Partners API `POST /app/{id}/settings/validation-url` | `<WORKER>/settings/validate` |
| Embedded dashboard | Portal UI → App → الصفحات المضمنة → edit | `<WORKER>/dashboard` |

Then bump the App Snippet so stores pull the new build (see §5).

---

## 5. Deploying a widget change

The Worker serves the widget itself at `/widget.js`. Canonical source:
`worker/public/widget.js`. No third-party hosting is in the chain, so renaming or
moving a repo can never break live stores.

1. Edit `worker/public/widget.js`, then `npx wrangler@3.114.14 deploy`.
2. Bump the App Snippet's `?v=` so stores pull the new build — `PUT`
   `/partners/v1/api/app/{id}/snippets/{snippetId}` with
   `{name, place:"before", tag:"body", c8fbt33yM0:"<js>"}`.
   The content field really is named `c8fbt33yM0`, and it takes **JS, not HTML**.

The whole loader Salla stores is:

```js
(function () {
  var el = document.createElement('script');
  el.defer = true;
  el.src = '<WORKER>/widget.js?v=<timestamp>';
  (document.head || document.body).appendChild(el);
})();
```

Salla caches that wrapper for a few minutes, so storefronts do not update instantly.

> `perfume-linker.js` at the repo root is the old GitHub Pages copy, kept only until
> the live snippet finishes cutting over. Do not edit it.

---

## 6. Platform gotchas (each cost hours to find)

1. **Salla's Embedded SDK crashes in browsers.** `@salla.sa/embedded-sdk@0.2.6` (UMD)
   reads `process.env.NODE_ENV` in its message handler; `process` is undefined in
   browsers and the bundle ships no shim, so every host message throws and the
   handshake never completes. Define `window.process = { env: { NODE_ENV: 'production' } }`
   **before** loading it. (`"production"` keeps their origin allowlist active.)
2. **Salla never sends the store id to an embedded page.** The iframe gets
   `mode, locale, token, app_id, dark`; the token is encrypted; the context message
   carries only `layout`. Use `sdk.auth.introspect()` to resolve the store.
3. **Iframe height is captured once, at init.** `page.resize`/`autoResize` are no-op
   stubs in 0.2.6. Call `ready()` before any slow work, and keep a `min-height` floor.
4. **Tag ids aren't in the storefront API.** Product `tags` come back name-only and
   you can't query by name — but the theme renders `/<slug>/tag-<id>` links, so the
   widget scrapes the id from the DOM. That's why it needs no backend for its core job.
5. **New products lag Salla's storefront search index** by minutes; the widget retries
   6× before giving up.

---

## 7. Known gaps

1. **`/api/admin/config` has no authentication** — it trusts `?store=`, and store ids are
   public. Anyone could read or overwrite a merchant's settings. Fix with
   `auth.introspect()` (the dashboard already proves the store that way).
   **Do this before real merchants.**
2. Custom rows (seasonal collections) save in the dashboard but aren't rendered on the
   storefront yet.
3. The snippet ships unminified.
4. Deploys are manual — no CI.
