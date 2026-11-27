import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function loadCatalogue(requestPage) {
  async function readPages(path) {
    const items = [];
    for (let page = 1; page <= 100; page++) {
      const result = await requestPage(path, page);
      if (result.page !== page || !Array.isArray(result.items) ||
          !Number.isInteger(result.total_pages) || result.total_pages < 0) {
        throw new Error('Invalid catalogue response');
      }
      items.push(...result.items);
      if (page >= result.total_pages) return items;
    }
    throw new Error('Catalogue exceeded pagination limit');
  }

  const products = [];
  for (const product of await readPages('products')) {
    if (product.type === 'simple') products.push(product);
    if (product.type !== 'variable') continue;
    for (const variation of await readPages('products/' + product.id + '/variations')) {
      const inheritsStock = !variation.managing_stock && product.managing_stock;
      products.push({
        ...variation,
        parent_id: product.id,
        categories: product.categories,
        name: product.name + ' — ' + Object.values(variation.attributes ?? {}).filter(Boolean).join(' / '),
        stock_quantity: inheritsStock ? product.stock_quantity : variation.stock_quantity,
        stock_status: inheritsStock ? product.stock_status : variation.stock_status,
        stock_pool: inheritsStock ? product.id : variation.id,
      });
    }
  }
  return products;
}

function bridgeRequest(path, page) {
  const { RUA_WP_USER, RUA_WP_APP_PASSWORD } = process.env;
  if (!RUA_WP_USER || !RUA_WP_APP_PASSWORD) throw new Error('Catalogue credentials missing');
  const auth = Buffer.from(RUA_WP_USER + ':' + RUA_WP_APP_PASSWORD).toString('base64');
  return fetch('https://ruahome.in/wp-json/rua-sales/v1/' + path + '?per_page=50&page=' + page, {
    headers: { Authorization: 'Basic ' + auth },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  }).then(response => {
    if (!response.ok) throw new Error('Catalogue unavailable');
    return response.json();
  });
}

function hash(value) {
  return createHash('sha256').update(value).digest();
}

export function createApp(requestPage = bridgeRequest, password = process.env.RUA_PILOT_PASSWORD) {
  if (!password || password.length < 24) {
    throw new Error('Set RUA_PILOT_PASSWORD to a random password of at least 24 characters');
  }
  const expected = hash('Basic ' + Buffer.from('pilot:' + password).toString('base64'));
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('OK');
      return;
    }
    if (!timingSafeEqual(hash(req.headers.authorization ?? ''), expected)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="RUA HOME Sales Pilot", charset="UTF-8"' })
        .end('Authentication required');
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    try {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(await readFile(new URL('./index.html', import.meta.url)));
      } else if (req.url === '/api/catalogue') {
        const products = await loadCatalogue(requestPage);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(products));
      } else {
        res.writeHead(404).end();
      }
    } catch {
      if (res.headersSent) res.end();
      else res.writeHead(503, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'Catalogue unavailable' }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(process.env.PORT || 3000, process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
}
