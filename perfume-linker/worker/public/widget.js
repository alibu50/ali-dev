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
    backendBase: 'https://perfume-linker.hjr-apps.workers.dev', // config source (embedded dashboard); swap for Vercel URL in prod
    apiBase: 'https://api.salla.dev/store/v1',

    // 'tags'    → source-value is [tagId] (production mode)
    // 'selected'→ source-value is [productId, ...] (demo / fallback mode)
    source: 'tags',
    sourceValue: null,

    forceProductPage: false,
    currentProductId: null,

    limit: 8,
    title: 'متوفر أيضاً بمقاسات وخيارات أخرى',
    subtitle: 'اختر المقاس أو النوع الأنسب لك',
    popupTitle: 'قبل أن تغادر…',
    popupSubtitle: 'نفس القطعة متوفرة بخيارات ومقاسات أخرى — ألقِ نظرة:',
    exitIntent: true,
    exitCooldownHours: 24,
    couponCode: '',
    anchorSelector: null
  }, window.PerfumeLinkerConfig || {});

  var COOLDOWN_KEY = 'pl_exit_shown_at';

  function log() {
    if (CONFIG.debug) console.log.apply(console, ['[perfume-linker]'].concat([].slice.call(arguments)));
  }

  // Multi-language App Settings come back as an object, e.g. { ar: '...', en: '...' }.
  // Resolve to a plain string using the STORE's active language
  // (salla.config.get('language_code')) — not the shopper's device locale.
  function localize(v) {
    if (v && typeof v === 'object') {
      var lang = (window.salla && salla.config && salla.config.get('language_code', 'ar')) || 'ar';
      return v[lang] || v.ar || v.en || '';
    }
    return v;
  }

  // Read a merchant-configured App Setting (public fields only) with a fallback.
  // Salla exposes public settings on the storefront as salla.config.get('app.<id>').
  function setting(key, fallback) {
    try {
      var v = window.salla && salla.config && salla.config.get('app.' + key, '');
      v = localize(v);
      if (v === undefined || v === null || v === '') return fallback;
      return v;
    } catch (e) { return fallback; }
  }

  function settingBool(key, fallback) {
    var v = setting(key, null);
    if (v === null) return fallback;
    return v === true || v === '1' || v === 1 || v === 'true';
  }

  // Merge merchant App Settings over the defaults (explicit window config wins,
  // so the local demo still overrides everything).
  function applyMerchantSettings() {
    if (window.PerfumeLinkerConfig) return; // demo/local config takes precedence
    CONFIG.title = setting('widget_title', CONFIG.title);
    CONFIG.popupTitle = setting('popup_title', CONFIG.popupTitle);
    CONFIG.popupSubtitle = setting('popup_subtitle', CONFIG.popupSubtitle);
    CONFIG.exitIntent = settingBool('exit_popup_enabled', CONFIG.exitIntent);
    CONFIG.couponCode = setting('coupon_code', CONFIG.couponCode);
    CONFIG.anchorSelector = setting('placement_selector', CONFIG.anchorSelector) || null;
    var cd = parseInt(setting('popup_cooldown_hours', ''), 10);
    if (!isNaN(cd)) CONFIG.exitCooldownHours = cd;
    var lim = parseInt(setting('products_limit', ''), 10);
    if (!isNaN(lim)) CONFIG.limit = lim;
    if (settingBool('widget_enabled', true) === false) CONFIG.disabled = true;
  }

  // Preferred config source: our backend (driven by the embedded dashboard).
  // Falls back silently to native App Settings / defaults if unreachable.
  function fetchBackendConfig() {
    if (window.PerfumeLinkerConfig) return Promise.resolve(); // demo/local wins
    if (!CONFIG.backendBase) return Promise.resolve();
    var sid = storeId();
    if (!sid) return Promise.resolve();
    return fetch(CONFIG.backendBase + '/api/config?store=' + encodeURIComponent(sid))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg || cfg.active === false) return;
        var w = cfg.widget || {}, p = cfg.popup || {};
        if (w.enabled === false) CONFIG.disabled = true;
        if (w.title) CONFIG.title = w.title;
        if (w.limit) CONFIG.limit = w.limit;
        if (w.placement === 'after_description') CONFIG.anchorSelector = '.product-details, .product__description';
        else if (w.placement === 'custom' && cfg.widget.placementSelector) CONFIG.anchorSelector = cfg.widget.placementSelector;
        CONFIG.exitIntent = p.enabled !== false;
        if (p.title) CONFIG.popupTitle = p.title;
        if (p.subtitle) CONFIG.popupSubtitle = p.subtitle;
        if (p.template) CONFIG.popupTemplate = p.template;
        if (typeof p.cooldownHours === 'number') CONFIG.exitCooldownHours = p.cooldownHours;
        CONFIG.couponCode = p.coupon || CONFIG.couponCode;
        CONFIG.rows = cfg.rows || [];
        log('backend config applied', cfg);
      })
      .catch(function (e) { log('backend config unreachable, using fallback', e); });
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

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Fragrance-droplet mark — the signature accent tying the section to perfume.
  var DROP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.2s6.4 6.8 6.4 11.4a6.4 6.4 0 1 1-12.8 0C5.6 9 12 2.2 12 2.2z"/></svg>';

  // Self-contained theme, injected once. Namespaced so it can't leak into the store.
  var STYLE_ID = 'pl-styles';
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '#perfume-linker-strip,#perfume-linker-popup{',
        '--pl-ink:#241c15;--pl-muted:#8c8177;--pl-line:rgba(36,28,21,.10);',
        '--pl-accent:#b06a30;--pl-accent-ink:#8a4f21;--pl-accent-soft:#f6ecdf;',
        'font-family:inherit;-webkit-font-smoothing:antialiased;box-sizing:border-box}',
      '#perfume-linker-strip *,#perfume-linker-popup *{box-sizing:border-box}',
      '.pl-panel{margin:26px auto;max-width:1180px;background:linear-gradient(180deg,#fbf7f1,#fff 44%);',
        'border:1px solid var(--pl-line);border-radius:18px;padding:20px 20px 22px;position:relative;overflow:hidden}',
      '.pl-panel::before{content:"";position:absolute;inset-block-start:0;inset-inline:0;height:3px;',
        'background:linear-gradient(90deg,var(--pl-accent),#e3b98c)}',
      '.pl-eyebrow{display:inline-flex;align-items:center;gap:7px;font-size:.72rem;font-weight:800;',
        'color:var(--pl-accent-ink);background:var(--pl-accent-soft);padding:5px 11px;border-radius:999px;margin:0 0 11px}',
      '.pl-eyebrow svg{width:13px;height:13px;flex:none}',
      '.pl-title{margin:0;font-size:1.15rem;font-weight:800;color:var(--pl-ink);line-height:1.35}',
      '.pl-sub{margin:5px 0 0;font-size:.86rem;color:var(--pl-muted)}',
      '.pl-row{display:flex;gap:12px;overflow-x:auto;padding:16px 2px 6px;scrollbar-width:thin;scroll-snap-type:x proximity}',
      '.pl-row::-webkit-scrollbar{height:6px}.pl-row::-webkit-scrollbar-thumb{background:var(--pl-line);border-radius:99px}',
      '.pl-card{flex:0 0 170px;scroll-snap-align:start;text-decoration:none;color:inherit;background:#fff;',
        'border:1px solid var(--pl-line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;',
        'transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;opacity:0}',
      '.pl-card:hover{transform:translateY(-4px);box-shadow:0 12px 26px rgba(36,28,21,.14);border-color:rgba(176,106,48,.42)}',
      '.pl-card:focus-visible{outline:2px solid var(--pl-accent);outline-offset:2px}',
      '.pl-thumb{position:relative;aspect-ratio:1;background:#f2ede6 center/cover no-repeat}',
      '.pl-thumb::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.30),transparent 44%)}',
      '.pl-badge{position:absolute;inset-block-start:8px;inset-inline-start:8px;z-index:1;font-size:.68rem;font-weight:800;',
        'color:#fff;background:rgba(36,28,21,.62);padding:3px 9px;border-radius:999px}',
      '.pl-oos{position:absolute;inset:0;display:grid;place-items:center;z-index:1;background:rgba(255,255,255,.68);',
        'font-size:.78rem;font-weight:800;color:#8a2b22}',
      '.pl-body{padding:11px 12px 13px;display:flex;flex-direction:column;gap:7px;flex:1}',
      '.pl-name{font-size:.85rem;line-height:1.45;color:var(--pl-ink);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.pl-price{margin-top:auto;font-size:.92rem;font-weight:800;color:var(--pl-ink)}',
      '.pl-price.pl-sale{color:var(--pl-accent-ink)}',
      '.pl-price .pl-was{font-weight:600;font-size:.8em;color:var(--pl-muted);text-decoration:line-through;margin-inline-start:5px}',
      '@keyframes pl-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
      '.pl-anim{animation:pl-in .45s ease forwards}',
      '#perfume-linker-popup{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;',
        'padding:16px;background:rgba(28,20,14,.55);animation:pl-fade .2s ease}',
      '@keyframes pl-fade{from{opacity:0}to{opacity:1}}',
      '.pl-modal{position:relative;width:100%;max-width:720px;max-height:86vh;overflow:auto;background:#fff;border-radius:20px;',
        'padding:26px 22px 22px;box-shadow:0 30px 70px rgba(28,20,14,.4);animation:pl-pop .28s cubic-bezier(.2,.8,.3,1)}',
      '@keyframes pl-pop{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}',
      '.pl-modal::before{content:"";position:absolute;inset-block-start:0;inset-inline:0;height:4px;',
        'background:linear-gradient(90deg,var(--pl-accent),#e3b98c)}',
      '.pl-x{position:absolute;inset-block-start:14px;inset-inline-end:14px;border:0;background:#f4efe8;color:var(--pl-ink);',
        'width:32px;height:32px;border-radius:50%;font-size:15px;cursor:pointer;line-height:1}',
      '.pl-x:hover{background:#eae2d7}',
      '.pl-ptitle{margin:2px 0 4px;font-size:1.3rem;font-weight:800;color:var(--pl-ink);padding-inline-end:42px}',
      '.pl-psub{margin:0 0 16px;font-size:.9rem;color:var(--pl-muted)}',
      '.pl-coupon{display:inline-flex;align-items:center;gap:9px;margin:0 0 16px;padding:9px 14px;cursor:pointer;',
        'border:1px dashed var(--pl-accent);border-radius:12px;background:var(--pl-accent-soft);color:var(--pl-accent-ink);font-weight:800;font-size:.92rem}',
      '.pl-cp-hint{font-weight:600;font-size:.78rem;opacity:.75}',
      /* --- popup templates (merchant picks one in the dashboard) --- */
      /* bold: dark, high-contrast, for brands that want the popup to shout */
      '#perfume-linker-popup.pl-tpl-bold{background:rgba(10,7,4,.72)}',
      '.pl-tpl-bold .pl-modal{background:#17110c;color:#f6efe6;box-shadow:0 30px 80px rgba(0,0,0,.6)}',
      '.pl-tpl-bold .pl-modal::before{height:5px;background:linear-gradient(90deg,#d98b3f,#f0c48a)}',
      '.pl-tpl-bold .pl-ptitle{color:#fff;font-size:1.45rem}',
      '.pl-tpl-bold .pl-psub{color:#c9bdaf}',
      '.pl-tpl-bold .pl-x{background:#2a2018;color:#f6efe6}',
      '.pl-tpl-bold .pl-x:hover{background:#3a2c20}',
      '.pl-tpl-bold .pl-card{background:#211812;border-color:rgba(255,255,255,.10)}',
      '.pl-tpl-bold .pl-name{color:#eee5d9}',
      '.pl-tpl-bold .pl-price{color:#fff}',
      '.pl-tpl-bold .pl-price.pl-sale{color:#f0c48a}',
      '.pl-tpl-bold .pl-was{color:#9c8e7f}',
      '.pl-tpl-bold .pl-coupon{background:#2a2018;border-color:#d98b3f;color:#f0c48a}',
      '.pl-tpl-bold .pl-thumb{background-color:#2a2018}',
      /* minimal: quiet, no accent bar, hairline borders */
      '#perfume-linker-popup.pl-tpl-minimal{background:rgba(28,20,14,.38)}',
      '.pl-tpl-minimal .pl-modal{border-radius:10px;box-shadow:0 18px 44px rgba(28,20,14,.20);border:1px solid var(--pl-line)}',
      '.pl-tpl-minimal .pl-modal::before{display:none}',
      '.pl-tpl-minimal .pl-ptitle{font-size:1.12rem;font-weight:700}',
      '.pl-tpl-minimal .pl-psub{font-size:.85rem}',
      '.pl-tpl-minimal .pl-x{background:transparent;border:1px solid var(--pl-line)}',
      '.pl-tpl-minimal .pl-card{border-radius:8px;box-shadow:none}',
      '.pl-tpl-minimal .pl-card:hover{transform:none;box-shadow:0 4px 12px rgba(28,20,14,.10)}',
      '.pl-tpl-minimal .pl-badge{background:rgba(36,28,21,.45);font-weight:700}',
      '.pl-tpl-minimal .pl-coupon{border-style:solid;background:transparent}',
      '@media (max-width:520px){.pl-card{flex-basis:150px}}',
      '@media (prefers-reduced-motion:reduce){.pl-card,.pl-anim,#perfume-linker-popup,.pl-modal{animation:none!important;opacity:1!important}}'
    ].join('');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  // Turn "duplicate listings" into an explicit format choice — the app's core value.
  function formatLabel(name) {
    var n = String(name || '');
    if (/تستر|tester/i.test(n)) return 'تستر';
    if (/تقسيم|decant/i.test(n)) {
      var m = n.match(/(\d+(?:[.,]\d+)?)\s*مل/);
      return m ? ('تقسيم · ' + m[1] + ' مل') : 'تقسيم';
    }
    if (/عينة|sample/i.test(n)) return 'عينة';
    if (/بديل|كلون|clone/i.test(n)) return 'بديل';
    if (/عبوة|كامل|(^|\s)عطر\s/.test(n)) return 'عبوة كاملة';
    return '';
  }

  function priceHtml(p) {
    var cur = p.currency || 'SAR';
    var unit = cur === 'SAR' ? 'ر.س' : cur;
    if (p.sale_price) {
      return '<span class="pl-price pl-sale">' + esc(p.sale_price) + ' ' + unit +
        '<span class="pl-was">' + esc(p.price) + ' ' + unit + '</span></span>';
    }
    return '<span class="pl-price">' + esc(p.price) + ' ' + unit + '</span>';
  }

  function renderCards(container, products) {
    injectStyles();
    var row = document.createElement('div');
    row.className = 'pl-row';
    products.slice(0, CONFIG.limit).forEach(function (p, i) {
      var a = document.createElement('a');
      a.className = 'pl-card pl-anim';
      a.href = p.url;
      a.style.animationDelay = (i * 55) + 'ms';
      var img = (p.image && p.image.url) || p.original_image || '';
      var badge = formatLabel(p.name);
      a.innerHTML =
        '<div class="pl-thumb" style="background-image:url(' + esc(img) + ')">' +
          (badge ? '<span class="pl-badge">' + esc(badge) + '</span>' : '') +
          (p.is_out_of_stock ? '<span class="pl-oos">غير متوفر</span>' : '') +
        '</div>' +
        '<div class="pl-body">' +
          '<div class="pl-name">' + esc(p.name) + '</div>' +
          priceHtml(p) +
        '</div>';
      row.appendChild(a);
    });
    container.appendChild(row);
  }

  function renderProducts(container, products) {
    // We already hold the resolved sibling products, so render our own
    // theme-agnostic cards directly (fast, consistent across all themes).
    renderCards(container, products);
  }

  /* ---------- inline strip ---------- */

  // Returns { el, mode } — mode 'after' inserts as a sibling right after el,
  // 'append' adds the strip as el's last child. Ordered from most to least
  // specific; deliberately excludes <body>/<html> so the strip can never land
  // below the footer.
  function findAnchor() {
    if (CONFIG.anchorSelector) {
      var custom = document.querySelector(CONFIG.anchorSelector);
      if (custom) return { el: custom, mode: 'after' };
    }
    var afterSelectors = [
      'salla-product-options',
      '.product-form',
      'salla-add-product-button',
      '.product__price, .price-wrapper',
      '.product-details, .product__description'
    ];
    for (var i = 0; i < afterSelectors.length; i++) {
      var a = document.querySelector(afterSelectors[i]);
      // skip matches that are the body/html element (some themes tag body)
      if (a && a !== document.body && a !== document.documentElement) {
        return { el: a, mode: 'after' };
      }
    }
    var main = document.querySelector('main');
    if (main) return { el: main, mode: 'append' };
    return { el: document.body, mode: 'append' };
  }

  function renderStrip(products) {
    if (document.getElementById('perfume-linker-strip')) return;
    injectStyles();
    var wrap = document.createElement('section');
    wrap.id = 'perfume-linker-strip';
    wrap.className = 'pl-panel';
    wrap.setAttribute('dir', 'rtl');
    wrap.innerHTML =
      '<span class="pl-eyebrow">' + DROP_ICON + 'نفس العطر · إصدارات أخرى</span>' +
      '<h3 class="pl-title">' + esc(CONFIG.title) + '</h3>' +
      (CONFIG.subtitle ? '<p class="pl-sub">' + esc(CONFIG.subtitle) + '</p>' : '');
    renderProducts(wrap, products);
    var anchor = findAnchor();
    if (anchor.mode === 'append') {
      anchor.el.appendChild(wrap);
    } else if (anchor.el.parentNode) {
      anchor.el.parentNode.insertBefore(wrap, anchor.el.nextSibling);
    } else {
      anchor.el.appendChild(wrap);
    }
    log('strip rendered with', products.length, 'products near', anchor.el.tagName, anchor.mode);
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

    injectStyles();
    var overlay = document.createElement('div');
    overlay.id = 'perfume-linker-popup';
    overlay.setAttribute('dir', 'rtl');
    // merchant-selected look: classic (default) | bold | minimal
    var tpl = CONFIG.popupTemplate;
    if (tpl === 'bold' || tpl === 'minimal') overlay.className = 'pl-tpl-' + tpl;

    var card = document.createElement('div');
    card.className = 'pl-modal';

    var close = document.createElement('button');
    close.className = 'pl-x';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'إغلاق');
    close.onclick = function () { overlay.remove(); };

    var h = document.createElement('h3');
    h.className = 'pl-ptitle';
    h.textContent = CONFIG.popupTitle;
    var p = document.createElement('p');
    p.className = 'pl-psub';
    p.textContent = CONFIG.popupSubtitle;

    card.appendChild(close);
    card.appendChild(h);
    card.appendChild(p);

    // Optional merchant coupon: click-to-copy chip
    if (CONFIG.couponCode) {
      var coupon = document.createElement('button');
      coupon.type = 'button';
      coupon.className = 'pl-coupon';
      var codeSpan = document.createElement('span');
      codeSpan.textContent = 'كوبون: ' + CONFIG.couponCode;
      var hint = document.createElement('span');
      hint.className = 'pl-cp-hint';
      hint.textContent = 'نسخ';
      coupon.appendChild(codeSpan);
      coupon.appendChild(hint);
      coupon.onclick = function () {
        try { navigator.clipboard.writeText(CONFIG.couponCode); } catch (e) {}
        hint.textContent = '✓ تم النسخ';
      };
      card.appendChild(coupon);
    }

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

  function run(attempt) {
    attempt = attempt || 0;
    if (!isProductPage()) { log('not a product page — skipping'); return; }
    if (document.getElementById('perfume-linker-strip')) return;
    resolveSiblings().then(function (products) {
      log('resolved', products.length, 'sibling products (attempt ' + attempt + ')');
      if (!products.length) {
        // Newly-created products lag Salla's storefront search index; retry.
        if (attempt < 6) setTimeout(function () { run(attempt + 1); }, 2000);
        return;
      }
      renderStrip(products);
      armExitIntent(products);
    }).catch(function (e) {
      log('failed:', e);
      if (attempt < 6) setTimeout(function () { run(attempt + 1); }, 2000);
    });
  }

  // The theme renders tag links client-side, so the DOM may not have them yet
  // at first paint. Poll briefly until tag links (or the demo sourceValue) exist.
  function boot() {
    // Backend (dashboard) config first, then native App Settings, then defaults.
    fetchBackendConfig().then(function () {
      applyMerchantSettings();
      bootAfterConfig();
    });
  }

  function bootAfterConfig() {
    if (CONFIG.disabled) { log('widget disabled by merchant setting'); return; }
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

  // Debug-only hooks for local theme previews (no effect in production).
  if (CONFIG.debug) {
    window.__plRenderStrip = renderStrip;
    window.__plShowPopup = showPopup;
    window.__plConfig = CONFIG;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
