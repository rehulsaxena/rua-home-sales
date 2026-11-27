import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
  console.error('WP user:', JSON.stringify(RUA_WP_USER), 'pw length:', RUA_WP_APP_PASSWORD ? RUA_WP_APP_PASSWORD.length : 0, 'pw has spaces:', RUA_WP_APP_PASSWORD ? RUA_WP_APP_PASSWORD.includes(' ') : false);
  if (!RUA_WP_USER || !RUA_WP_APP_PASSWORD) throw new Error('Catalogue credentials missing');
  const auth = Buffer.from(RUA_WP_USER + ':' + RUA_WP_APP_PASSWORD).toString('base64');
  return fetch('https://ruahome.in/wp-json/rua-sales/v1/' + path + '?per_page=50&page=' + page, {
    headers: { Authorization: 'Basic ' + auth },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  }).then(response => {
      if (!response.ok) throw new Error('Catalogue unavailable: HTTP ' + response.status + ' ' + response.statusText);   
    return response.json();
  });
}

function hash(value) {
  return createHash('sha256').update(value).digest();
}

function staffDirectory() {
  let raw;
  try { raw = JSON.parse(process.env.RUA_STAFF || '[]'); } catch { raw = []; }
  return raw.map(s => ({ id: s.id, name: s.name, passwordHash: createHash('sha256').update(String(s.password)).digest('hex') }));
}

const otpStore = new Map();

async function sendOtp(phone) {
  const code = String(100000 + Math.floor(Math.random() * 900000));
  otpStore.set(phone, { code, expires: Date.now() + 300000 });
  if (!process.env.OTP_PROVIDER || process.env.OTP_PROVIDER === 'console') {
    console.error('SIMULATED OTP for', phone, ':', code);
    return { simulated: true };
  }
  throw new Error('Unsupported OTP_PROVIDER: ' + process.env.OTP_PROVIDER);
}

function verifyOtp(phone, code) {
  const entry = otpStore.get(phone);
  if (!entry || Date.now() > entry.expires) return false;
  const ok = entry.code === String(code);
  if (ok) otpStore.delete(phone);
  return ok;
}

async function readOrders() {
  try { return JSON.parse(await readFile(new URL('./orders.json', import.meta.url), 'utf8')); } catch { return []; }
}

async function writeOrder(order) {
  const orders = await readOrders();
  orders.push(order);
  await writeFile(new URL('./orders.json', import.meta.url), JSON.stringify(orders, null, 2));
  return orders.length;
}

async function createWooOrder(order) {
  const { RUA_WP_USER, RUA_WP_APP_PASSWORD } = process.env;
  if (!RUA_WP_USER || !RUA_WP_APP_PASSWORD) throw new Error('WooCommerce credentials missing');
  const auth = Buffer.from(RUA_WP_USER + ':' + RUA_WP_APP_PASSWORD).toString('base64');
  const lineItems = (order.lines || []).map(l => {
    const item = { quantity: l.qty, total: Number(l.total).toFixed(2) };
    if (l.parentId) { item.product_id = l.parentId; item.variation_id = l.id; }
    else { item.product_id = l.id; }
    return item;
  });
  const payload = {
    status: 'processing',
    payment_method: 'rua-sales-app',
    payment_method_title: 'RUA Sales App (wholesale)',
    set_paid: false,
    billing: { first_name: order.shop || 'Wholesale customer', phone: order.phone || '' },
    line_items: lineItems,
    customer_note: 'Booked via RUA Sales App by ' + (order.staffName || ('staff #' + order.staffId)),
    meta_data: [
      { key: '_rua_staff_id', value: String(order.staffId ?? '') },
      { key: '_rua_staff_name', value: order.staffName ?? '' },
      { key: '_rua_shop', value: order.shop ?? '' },
      ],
  };
  const response = await fetch('https://ruahome.in/wp-json/wc/v3/orders', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('WooCommerce order create failed: HTTP ' + response.status + ' ' + text.slice(0, 300));
  }
  return response.json();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export function createApp(requestPage = bridgeRequest, password = process.env.RUA_PILOT_PASSWORD) {
  if (!password || password.length < 12) {
    throw new Error('Set RUA_PILOT_PASSWORD to a random password of at least 12 characters');
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
    try {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(await readFile(new URL('./index.html', import.meta.url)));
      } else if (req.method === 'GET' && req.url === '/api/catalogue') {
        const products = await loadCatalogue(requestPage);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(products));
      } else if (req.method === 'GET' && req.url === '/api/staff') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(staffDirectory()));
      } else if (req.method === 'POST' && req.url === '/api/otp/send') {
        const body = await readJsonBody(req);
        const result = await sendOtp(String(body.phone || ''));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      } else if (req.method === 'POST' && req.url === '/api/otp/verify') {
        const body = await readJsonBody(req);
        const ok = verifyOtp(String(body.phone || ''), String(body.code || ''));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok }));
      } else if (req.method === 'POST' && req.url === '/api/orders') {
        const body = await readJsonBody(req);
        const order = { ...body, receivedAt: new Date().toISOString() };
        let wooOrder = null, wooError = null;
        try { wooOrder = await createWooOrder(order); }
        catch (err) { wooError = err.message; console.error('WooCommerce order error:', err); }
        order.wooOrderId = wooOrder?.id ?? null;
        const count = await writeOrder(order);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          ok: true,
          orderNumber: wooOrder?.number ? ('WC-' + wooOrder.number) : ('RH-' + count),
          synced: !!wooOrder,
          warning: wooError ? 'Order saved locally but could not sync to WooCommerce yet: ' + wooError : undefined,
        }));
      }else {
        res.writeHead(404).end();
      }
    }
    catch(err)  {
      console.error('Catalogue error:', err);
      if (res.headersSent) res.end();
      else res.writeHead(503, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'Catalogue unavailable' }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(process.env.PORT || 3000, process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
}
