# Perfume Linker (رابط العطور)

A Salla app for perfume stores. Perfume shops list one fragrance as many separate
products — full bottle, tester, decant (تقسيم), sample (عينة), clone (بديل) — so
shoppers never discover the other formats. Perfume Linker **links every version of a
fragrance by a shared product tag** and shows them together, plus an exit‑intent
popup to recover leaving shoppers, and a merchant dashboard to configure it all.

Built platform‑agnostic: the backend + dashboard are reusable, so the same app
extends to Zid / Shopify later by swapping only the thin storefront layer.

---

## How it works

```
 Shopper on a product page
        │
        ▼
 ┌─────────────────────────┐     reads config      ┌──────────────────────────┐
 │  Storefront snippet      │ ───────────────────▶  │  Backend (/api/config)   │
 │  perfume-linker.js       │                       │  per‑store JSON config   │
 │  (injected by Salla)     │ ◀───────────────────  │                          │
 └─────────────────────────┘                        └──────────────────────────┘
        │                                                       ▲
        │ reads the product's tag id from the theme's           │ saves config
        │ tag link ( /<slug>/tag-<id> ), then fetches           │
        │ sibling products via the storefront API               │
        ▼                                              ┌──────────────────────────┐
 Renders: "other formats" strip  +  exit popup          │  Embedded dashboard      │
                                                        │  backend/public/index... │
                                                        │  (merchant configures)   │
                                                        └──────────────────────────┘
```

**The clever bit — backend‑free tag resolution on the storefront.** Salla's public
storefront API returns a product's tags by *name only* (no id), and won't let you
query products by tag name. But the Twilight theme renders each tag as a link like
`/<slug>/tag-<id>` — so the snippet scrapes the numeric tag id from the DOM, then
fetches all products sharing that tag. No backend call needed for the core feature.

The backend exists for the **merchant dashboard**: custom titles, popup templates,
coupon, and merchant‑built seasonal "rows" (e.g. tag a *summer collection*).

---

## Repository map

| Path | What it is |
|------|-----------|
| `perfume-linker.js` | **The storefront snippet.** Injected into every shop page by Salla. Resolves sibling products by tag, renders the strip + exit popup, reads merchant config from the backend. This exact file is served live at `https://alibu50.github.io/ali-dev/perfume-linker/perfume-linker.js`. |
| `backend/server.js` | Zero‑dependency Node HTTP server: Salla webhooks (token capture), public config API for the snippet, dashboard read/write API, settings‑validation endpoint. |
| `backend/store.js` | Per‑store config persistence (JSON file locally; swappable for a managed store in production). |
| `backend/public/index.html` | **The embedded merchant dashboard** (RTL): widget settings, popup template picker, and the custom‑rows builder. |
| `demo-store/catalog.json` | Demo catalog — 5 fragrance families × 5 formats (25 products), real names/prices/images. |
| `demo-store/seed.js` | Seeds a store with the demo catalog via the Salla Merchant API (categories → tags → products). |
| `demo-store/settings-schema.json` | Native Salla App‑Settings schema (an alternative to the embedded dashboard). |

---

## Status

- ✅ Storefront widget (strip + exit popup) — working, verified on a live demo store
- ✅ Tag‑based linking — resolves siblings from the theme's tag links, no backend needed
- ✅ Backend + embedded dashboard — configure widget/popup, build seasonal rows, saves reliably
- ✅ Demo store seeded with 25 tag‑linked perfume products
- 🔜 Deploy backend to a permanent host (currently dev tunnel), popup template designs,
  render seasonal rows on the storefront, then publish to the Salla App Store

## Tech

Vanilla JS storefront snippet · zero‑dependency Node backend · Salla Partners API,
Merchant API, storefront API, App Snippets, OAuth (Easy Mode).
