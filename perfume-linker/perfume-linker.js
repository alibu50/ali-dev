/**
 * Perfume Linker — storefront snippet
 * Renders a "same fragrance, other formats" strip on product pages
 * (products linked by a shared tag) + an exit-intent popup.
 *
 * Ships later as a Salla App Snippet. In demo mode it is configured
 * via window.PerfumeLinkerConfig.
 *
 * Data flow (no backend required for the core loop):
 *   1. Fetch current product from the storefront API → read its tags
 *   2. Fetch products with source=tags & source_value=[tagId]
 *   3. Render: <salla-products-list> when available (real Twilight theme),
 *      otherwise built-in fallback cards from the same API JSON.
 */
(function () {
  'use strict';

  var CONFIG = Object.assign({
    storeId: null,               // required outside a real storefront
    apiBase: 'https://api.salla.dev/store/v1',

    // 'tags'    → source-value is [tagId] (production mode)
    // 'selected'→ source-value is [productId, ...] (demo / fallback mode)
    source: 'tags',
    sourceValue: null,

    forceProductPage: false,
    currentProductId: null,

    limit: 8,
    title: 'متوفر أيضاً بمقاسات وخيارات أخرى',
    popupTitle: 'قبل أن تغادر…',
    popupSubtitle: 'نفس القطعة متوفرة بخيارات ومقاسات أخرى — ألقِ نظرة:',
    exitIntent: true,
    exitCooldownHours: 24,
    preferWebComponent: true,    // try salla-products-list first on real themes
    anchorSelector: null
  }, window.PerfumeLinkerConfig || {});

  var COOLDOWN_KEY = 'pl_exit_shown_at';

  function log() {
    if (CONFIG.debug) console.log.apply(console, ['[perfume-linker]'].concat([].slice.call(arguments)));
  }

  /* ---------- data ---------- */

  function apiUrl(source, values) {
    var params = values.map(function (v) { return 'source_value[]=' + encodeURIComponent(v); });
    params.unshift('source=' + source);
    var sid = storeId();
    if (sid) params.push('store_id=' + sid);
    return CONFIG.apiBase + '/products?' + params.join('&');
  }

  function fetchProducts(source, values) {
    var sid = storeId();
    return fetch(apiUrl(source, values), {
      headers: sid ? { 'Store-Identifier': String(sid) } : {}
    }).then(function (r) {
      if (!r.ok) throw new Error('storefront api ' + r.status);
      return r.json();
    }).then(function (j) { return j.data || []; });
  }

  // Read this product's tag IDs from the tag links Salla renders on the page
  // (storefront API exposes tag NAME but not ID; the theme's tag links carry
  // the ID as .../<slug>/tag-<id>). This keeps the widget backend-free.
  function tagIdsFromDom() {
    var ids = {};
    var links = document.querySelectorAll('a[href*="/tag-"]');
    for (var i = 0; i < links.length; i++) {
      var m = (links[i].getAttribute('href') || '').match(/\/tag-(\d+)/);
      if (m) ids[m[1]] = true;
    }
    return Object.keys(ids);
  }

  function resolveSiblings() {
    var current = currentProductId();
    if (CONFIG.sourceValue && CONFIG.sourceValue.length) {
      var vals = CONFIG.sourceValue;
      if (CONFIG.source === 'selected' && current) {
        vals = vals.filter(function (id) { return String(id) !== String(current); });
      }
      return fetchProducts(CONFIG.source, vals).then(function (list) {
        return list.filter(function (p) { return String(p.id) !== String(current); });
      });
    }
    // Production path: tag IDs from the page → fetch products by tag
    var tagIds = CONFIG.tagIds && CONFIG.tagIds.length ? CONFIG.tagIds : tagIdsFromDom();
    if (!tagIds.length) { log('no tag links found on page'); return Promise.resolve([]); }
    log('resolving by tag ids', tagIds);
    return fetchProducts('tags', tagIds).then(function (siblings) {
      return siblings.filter(function (p) { return String(p.id) !== String(current); });
    });
  }

  /* ---------- page context ---------- */

  function storeId() {
    if (CONFIG.storeId) return CONFIG.storeId;
    try { return window.salla && salla.config.get('store.id'); } catch (e) { return null; }
  }

  function isProductPage() {
    if (CONFIG.forceProductPage) return true;
    try {
      var slug = window.salla && salla.config.get('page.slug');
      if (slug === 'product' || /product/.test(String(slug || ''))) return true;
    } catch (e) { /* fall through */ }
    // Salla product URLs end with /p<digits>
    return /\/p\d+([/?#]|$)/.test(location.pathname);
  }

  function currentProductId() {
    if (CONFIG.currentProductId) return CONFIG.currentProductId;
    try {
      var id = window.salla && salla.config.get('page.id');
      if (id) return id;
    } catch (e) { /* fall through */ }
    var m = location.pathname.match(/\/p(\d+)([/?#]|$)/);
    return m ? m[1] : null;
  }

  /* ---------- renderers ---------- */

  function money(p) {
    var cur = p.currency || 'SAR';
    if (p.sale_price) {
      return '<span style="color:#0a7d4f;font-weight:800">' + p.sale_price + ' ' + cur + '</span> ' +
             '<s style="opacity:.5;font-size:.85em">' + p.price + ' ' + cur + '</s>';
    }
    return '<span style="font-weight:800">' + p.price + ' ' + cur + '</span>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderCards(container, products) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:12px;overflow-x:auto;padding:4px 0;scrollbar-width:thin;';
    products.slice(0, CONFIG.limit).forEach(function (p) {
      var a = document.createElement('a');
      a.href = p.url;
      a.style.cssText = 'flex:0 0 168px;text-decoration:none;color:inherit;background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:12px;overflow:hidden;transition:box-shadow .15s;';
      a.onmouseenter = function () { a.style.boxShadow = '0 6px 20px rgba(0,0,0,.12)'; };
      a.onmouseleave = function () { a.style.boxShadow = 'none'; };
      var img = (p.image && p.image.url) || (p.original_image) || '';
      a.innerHTML =
        '<div style="aspect-ratio:1;background:#f2efe9 url(' + esc(img) + ') center/cover no-repeat"></div>' +
        '<div style="padding:10px 12px">' +
          '<div style="font-size:.85rem;line-height:1.4;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' + esc(p.name) + '</div>' +
          '<div style="font-size:.9rem">' + money(p) + '</div>' +
          (p.is_out_of_stock ? '<div style="font-size:.75rem;color:#b3261e;margin-top:4px">غير متوفر حالياً</div>' : '') +
        '</div>';
      row.appendChild(a);
    });
    container.appendChild(row);
  }

  function renderWebComponent(container) {
    var list = document.createElement('salla-products-list');
    list.setAttribute('source', CONFIG.source);
    list.setAttribute('source-value', JSON.stringify(CONFIG.sourceValue || []));
    list.setAttribute('limit', String(CONFIG.limit));
    container.appendChild(list);
    return list;
  }

  function renderProducts(container, products) {
    var canUseComponent = CONFIG.preferWebComponent &&
      window.customElements && customElements.get('salla-products-list') &&
      !CONFIG.storeId; // components only resolve the store inside a real storefront
    if (canUseComponent) {
      var el = renderWebComponent(container);
      // Fallback if the component doesn't paint anything
      setTimeout(function () {
        if (!el.innerHTML.length && !(el.shadowRoot && el.shadowRoot.innerHTML.length)) {
          log('web component empty — falling back to built-in cards');
          el.remove();
          renderCards(container, products);
        }
      }, 2500);
    } else {
      renderCards(container, products);
    }
  }

  /* ---------- inline strip ---------- */

  function findAnchor() {
    if (CONFIG.anchorSelector) return document.querySelector(CONFIG.anchorSelector);
    return document.querySelector('salla-product-options')
      || document.querySelector('.product-single, .product__description, [class*="product-details"]')
      || document.querySelector('main')
      || document.body;
  }

  function renderStrip(products) {
    if (document.getElementById('perfume-linker-strip')) return;
    var wrap = document.createElement('section');
    wrap.id = 'perfume-linker-strip';
    wrap.setAttribute('dir', 'rtl');
    wrap.style.cssText = 'margin:24px 0;padding:16px;border:1px solid rgba(0,0,0,.08);border-radius:12px;background:#fff;';
    var h = document.createElement('h3');
    h.textContent = CONFIG.title;
    h.style.cssText = 'margin:0 0 12px;font-size:1.05rem;font-weight:700;';
    wrap.appendChild(h);
    renderProducts(wrap, products);
    var anchor = findAnchor();
    (anchor.parentNode || document.body).insertBefore(wrap, anchor.nextSibling);
    log('strip rendered with', products.length, 'products');
  }

  /* ---------- exit-intent popup ---------- */

  function cooldownActive() {
    try {
      var at = +localStorage.getItem(COOLDOWN_KEY) || 0;
      return Date.now() - at < CONFIG.exitCooldownHours * 3600 * 1000;
    } catch (e) { return false; }
  }

  function markShown() {
    try { localStorage.setItem(COOLDOWN_KEY, String(Date.now())); } catch (e) {}
  }

  function showPopup(products) {
    if (document.getElementById('perfume-linker-popup') || cooldownActive()) return;
    markShown();

    var overlay = document.createElement('div');
    overlay.id = 'perfume-linker-popup';
    overlay.setAttribute('dir', 'rtl');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;';

    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;color:#111;max-width:760px;width:100%;max-height:85vh;overflow:auto;border-radius:16px;padding:24px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.3);';

    var close = document.createElement('button');
    close.textContent = '✕';
    close.setAttribute('aria-label', 'إغلاق');
    close.style.cssText = 'position:absolute;top:12px;inset-inline-start:12px;border:0;background:transparent;font-size:20px;cursor:pointer;';
    close.onclick = function () { overlay.remove(); };

    var h = document.createElement('h3');
    h.textContent = CONFIG.popupTitle;
    h.style.cssText = 'margin:0 0 4px;font-size:1.3rem;font-weight:800;';
    var p = document.createElement('p');
    p.textContent = CONFIG.popupSubtitle;
    p.style.cssText = 'margin:0 0 16px;opacity:.75;';

    card.appendChild(close);
    card.appendChild(h);
    card.appendChild(p);
    renderProducts(card, products);
    overlay.appendChild(card);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
    });

    document.body.appendChild(overlay);
    log('exit popup shown');
  }

  function armExitIntent(products) {
    if (!CONFIG.exitIntent || !products.length) return;
    document.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget && e.clientY <= 0) showPopup(products);
    });
    var hiddenAt = 0;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt < 3000) showPopup(products);
    });
  }

  /* ---------- boot ---------- */

  function run() {
    if (!isProductPage()) { log('not a product page — skipping'); return; }
    resolveSiblings().then(function (products) {
      log('resolved', products.length, 'sibling products');
      if (!products.length) return;
      renderStrip(products);
      armExitIntent(products);
    }).catch(function (e) { log('failed:', e); });
  }

  // The theme renders tag links client-side, so the DOM may not have them yet
  // at first paint. Poll briefly until tag links (or the demo sourceValue) exist.
  function boot() {
    if (document.getElementById('perfume-linker-strip')) return;
    var haveData = (CONFIG.sourceValue && CONFIG.sourceValue.length) ||
      (CONFIG.tagIds && CONFIG.tagIds.length) ||
      tagIdsFromDom().length;
    if (haveData) { run(); return; }
    var tries = 0;
    var t = setInterval(function () {
      if (tagIdsFromDom().length || ++tries > 50) {
        clearInterval(t);
        run();
      }
    }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
