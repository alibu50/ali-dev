// Seeds the demo store from catalog.json via the Salla Merchant API.
// Usage: node seed.js [tokenFile]
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = process.argv[2] || 'C:/Users/Ali/.salla-demo-token';
const CATALOG = path.join(__dirname, 'catalog.json');
const API = 'https://api.salla.dev/admin/v2';

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));

async function salla(method, pathname, body) {
  const res = await fetch(API + pathname, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json && json.error ? JSON.stringify(json.error) : res.status;
    throw new Error(method + ' ' + pathname + ' → ' + msg);
  }
  return json;
}

async function listAll(pathname) {
  let out = [], page = 1;
  for (;;) {
    const r = await salla('GET', `${pathname}?per_page=65&page=${page}`);
    out = out.concat(r.data || []);
    if (!r.pagination || !r.pagination.currentPage || r.pagination.currentPage >= r.pagination.totalPages) break;
    page++;
  }
  return out;
}

(async () => {
  // 1. Categories — reuse by name if already present (idempotent)
  const existingCats = await listAll('/categories');
  const catByName = {};
  existingCats.forEach((c) => { catByName[c.name] = c.id; });
  const catIds = {};
  for (const c of catalog.categories) {
    if (catByName[c.name]) {
      catIds[c.key] = catByName[c.name];
      console.log('category (exists)', c.name, '->', catIds[c.key]);
    } else {
      const r = await salla('POST', '/categories', { name: c.name });
      catIds[c.key] = r.data.id;
      console.log('category', c.name, '->', r.data.id);
    }
  }

  // 2. Tags (one per fragrance family) — reuse by name if present
  const existingTags = await listAll('/products/tags');
  const tagByName = {};
  existingTags.forEach((t) => { tagByName[t.name] = t.id; });
  const tagIds = {};
  for (const f of catalog.families) {
    if (tagByName[f.tag]) {
      tagIds[f.tag] = tagByName[f.tag];
      console.log('tag (exists)', f.tag, '->', tagIds[f.tag]);
    } else {
      const r = await salla('POST', '/products/tags', { tag_name: f.tag });
      tagIds[f.tag] = r.data.id;
      console.log('tag', f.tag, '->', r.data.id);
    }
  }

  // 3. Products
  let ok = 0, fail = 0;
  for (const f of catalog.families) {
    for (const p of f.products) {
      const body = {
        name: p.name,
        price: p.price,
        product_type: 'product',
        quantity: 25,
        status: 'sale',
        categories: [catIds[p.category]],
        tags: [tagIds[f.tag]],
        description: `من عائلة ${f.title} (${f.brand}). صنف: ${p.category}. منتج تجريبي لاختبار تطبيق Perfume Linker.`,
        images: [{ original: p.image }],
      };
      try {
        const r = await salla('POST', '/products', body);
        console.log('  product', p.name, '->', r.data.id);
        ok++;
      } catch (e) {
        console.log('  FAILED', p.name, ':', e.message);
        fail++;
      }
    }
  }
  console.log(`\ndone. created ${ok} products, ${fail} failed.`);
  console.log('categories:', JSON.stringify(catIds));
  console.log('tags:', JSON.stringify(tagIds));
})();
