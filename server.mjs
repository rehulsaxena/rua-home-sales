import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function loadCatalogue(requestPage, requestWcPage = bridgeWcRequest) {
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

const categoryMap = await loadWcCategoryMap(requestWcPage);

const products = [];
  for (const product of await readPages('products')) {
    if (product.type === 'simple') products.push({ ...product, categories: categoryMap.get(product.id) ?? product.categories });
    if (product.type !== 'variable') continue;
    for (const variation of await readPages('products/' + product.id + '/variations')) {
      const inheritsStock = !variation.managing_stock && product.managing_stock;
      products.push({
        ...variation,
        parent_id: product.id,
        categories: categoryMap.get(product.id) ?? product.categories,
        name: product.name + ' \u2014 ' + Object.values(variation.attributes ?? {}).filter(Boolean).join(' / '),
        stock_quantity: inheritsStock ? product.stock_quantity : variation.stock_quantity,
        stock_status: inheritsStock ? product.stock_status : variation.stock_status,
        stock_pool: inheritsStock ? product.id : variation.id,
      });
    }
  }
  return products;
}

async function loadWcCategoryMap(requestWcPage) {
  const map = new Map();
  try {
    for (let page = 1; page <= 100; page++) {
      const items = await requestWcPage(page);
      if (!Array.isArray(items) || items.length === 0) break;
      for (const p of items) map.set(p.id, p.categories ?? []);
      if (items.length < 50) break;
    }
  } catch (err) {
    console.error('Could not load WooCommerce categories (falling back to no categories):', err.message);
  }
  return map;
}

function bridgeWcRequest(page) {
  const { RUA_WP_USER, RUA_WP_APP_PASSWORD } = process.env;
  if (!RUA_WP_USER || !RUA_WP_APP_PASSWORD) throw new Error('Catalogue credentials missing');
  const auth = Buffer.from(RUA_WP_USER + ':' + RUA_WP_APP_PASSWORD).toString('base64');
  return fetch('https://ruahome.in/wp-json/wc/v3/products?per_page=50&page=' + page + '&_fields=id,categories', {
    headers: { Authorization: 'Basic ' + auth },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  }).then(response => {
    if (!response.ok) throw new Error('WooCommerce categories unavailable: HTTP ' + response.status + ' ' + response.statusText);
    return response.json();
  });
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

function staffDirectory() {
  let raw;
  try { raw = JSON.parse(process.env.RUA_STAFF || '[]'); } catch { raw = []; }
  return raw.map(s => ({ id: s.id, name: s.name, passwordHash: createHash('sha256').update(String(s.password)).digest('hex') }));
}

const otpStore = new Map();

function normalizeIndianMobile(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  throw new Error('Invalid phone number: ' + phone);
}

function splitIndianMobile(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return { countryCode: '+91', phoneNumber: digits };
  if (digits.length === 12 && digits.startsWith('91')) return { countryCode: '+91', phoneNumber: digits.slice(2) };
  throw new Error('Invalid phone number: ' + phone);
}

function formatOrderSummary(order) {
  if (!order || !Array.isArray(order.lines) || !order.lines.length) return null;
  const itemLines = order.lines
  .map(l => (l.name || 'Item') + ' x' + l.qty + ' - ' + '\u20B9' + Number(l.total || 0).toFixed(2))
  .join('\n');
  const total = order.lines.reduce((sum, l) => sum + Number(l.total || 0), 0);
  return { itemLines, total: '\u20B9' + total.toFixed(2) };
}

async function sendOtpViaInterakt(phone, code, order) {
  const { INTERAKT_API_KEY, INTERAKT_WA_TEMPLATE_NAME, INTERAKT_WA_ORDER_TEMPLATE_NAME, INTERAKT_WA_LANGUAGE_CODE } = process.env;
  if (!INTERAKT_API_KEY) {
    throw new Error('Interakt credentials missing: set INTERAKT_API_KEY');
  }
  const { countryCode, phoneNumber } = splitIndianMobile(phone);
  const summary = formatOrderSummary(order);
  let template;
  if (summary && INTERAKT_WA_ORDER_TEMPLATE_NAME) {
    template = {
      name: INTERAKT_WA_ORDER_TEMPLATE_NAME,
      languageCode: INTERAKT_WA_LANGUAGE_CODE || 'en',
      bodyValues: [summary.itemLines, summary.total, code],
    };
  } else {
    if (!INTERAKT_WA_TEMPLATE_NAME) {
      throw new Error('Interakt credentials missing: set INTERAKT_WA_TEMPLATE_NAME');
    }
    template = {
      name: INTERAKT_WA_TEMPLATE_NAME,
      languageCode: INTERAKT_WA_LANGUAGE_CODE || 'en',
      bodyValues: [code],
      buttonValues: { '0': [code] },
    };
  }
  const response = await fetch('https://api.interakt.ai/v1/public/message/', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + INTERAKT_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ countryCode, phoneNumber, type: 'Template', template }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error('Interakt send failed: ' + (result.message || ('HTTP ' + response.status)));
  }
  return { sent: true, provider: summary && INTERAKT_WA_ORDER_TEMPLATE_NAME ? 'interakt-whatsapp-order' : 'interakt-whatsapp' };
}

async function sendOtpViaMsg91(phone, code) {
  const { MSG91_AUTH_KEY, MSG91_TEMPLATE_ID, MSG91_OTP_VAR_NAME } = process.env;
  if (!MSG91_AUTH_KEY || !MSG91_TEMPLATE_ID) {
    throw new Error('MSG91 credentials missing: set MSG91_AUTH_KEY and MSG91_TEMPLATE_ID');
  }
  const varName = MSG91_OTP_VAR_NAME || 'OTP';
  const mobile = normalizeIndianMobile(phone);
  const response = await fetch('https://control.msg91.com/api/v5/flow', {
    method: 'POST',
    headers: { authkey: MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template_id: MSG91_TEMPLATE_ID,
      short_url: '0',
      recipients: [{ mobiles: mobile, [varName]: code }],
    }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.type === 'error') {
    throw new Error('MSG91 send failed: ' + (result.message || ('HTTP ' + response.status)));
  }
  return { sent: true, provider: 'msg91' };
}

async function sendOtp(phone, order) {
  const code = String(100000 + Math.floor(Math.random() * 900000));
  otpStore.set(phone, { code, expires: Date.now() + 300000 });
  const provider = process.env.OTP_PROVIDER;
  if (!provider || provider === 'console') {
    console.error('SIMULATED OTP for', phone, ':', code);
    return { simulated: true };
  }
  if (provider === 'msg91') {
    return sendOtpViaMsg91(phone, code);
  }
  if (provider === 'interakt') {
    return sendOtpViaInterakt(phone, code, order);
  }
  throw new Error('Unsupported OTP_PROVIDER: ' + provider);
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

async function nextOrderNumber() {
  const orders = await readOrders();
  const year = new Date().getFullYear();
  const countThisYear = orders.filter(o => new Date(o.receivedAt || 0).getFullYear() === year).length;
  return String(countThisYear + 1).padStart(3, '0') + '_' + year;
}

function wcAuthHeader() {
  const { RUA_WP_USER, RUA_WP_APP_PASSWORD } = process.env;
  if (!RUA_WP_USER || !RUA_WP_APP_PASSWORD) throw new Error('WooCommerce credentials missing');
  return 'Basic ' + Buffer.from(RUA_WP_USER + ':' + RUA_WP_APP_PASSWORD).toString('base64');
}

function shopUsername(digits) {
  return 'rua_' + digits;
}

function shopEmail(digits) {
  return 'rua.' + digits + '@shop.ruahome.in';
}

function metaValue(customer, key) {
  const entry = (customer.meta_data || []).find(m => m.key === key);
  return entry ? entry.value : '';
}

function customerToShop(customer) {
  return {
    customerId: customer.id,
    name: customer.first_name || '',
    address: customer.billing?.address_1 || '',
    phone: customer.billing?.phone || '',
    secondaryPhone: metaValue(customer, 'rua_secondary_phone'),
    gst: metaValue(customer, 'rua_gst_number'),
    panUrl: metaValue(customer, 'rua_pan_url'),
    aadhaarUrl: metaValue(customer, 'rua_aadhaar_url'),
  };
}

async function findShopByPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length !== 10) return null;
  const response = await fetch('https://ruahome.in/wp-json/wc/v3/customers?search=' + encodeURIComponent(shopUsername(digits)) + '&per_page=5', {
    headers: { Authorization: wcAuthHeader() },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Shop lookup failed: HTTP ' + response.status);
  const customers = await response.json();
  const match = customers.find(c => c.username === shopUsername(digits));
  return match ? customerToShop(match) : null;
}

async function uploadShopPhoto(dataUrl, filenamePrefix) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Invalid photo data');
  const mimeType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 6 * 1024 * 1024) throw new Error('Photo is too large');
  const ext = (mimeType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filenamePrefix + '-' + Date.now() + '.' + ext);
  const response = await fetch('https://ruahome.in/wp-json/wp/v2/media', {
    method: 'POST',
    headers: { Authorization: wcAuthHeader() },
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('Photo upload failed: HTTP ' + response.status + ' ' + text.slice(0, 300));
  }
  const media = await response.json();
  return media.source_url;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function upsertShop(shop) {
  const digits = String(shop.phone || '').replace(/\D/g, '');
  if (digits.length !== 10) throw badRequest('Enter a valid 10-digit primary phone number');
  if (!shop.name || !shop.name.trim()) throw badRequest('Shop name is required');
  if (!shop.address || !shop.address.trim()) throw badRequest('Shop address is required');

  const existing = await findShopByPhone(digits).catch(() => null);
  const payload = {
    first_name: shop.name,
    billing: { first_name: shop.name, phone: digits, address_1: shop.address },
    meta_data: [
      { key: 'rua_secondary_phone', value: shop.secondaryPhone || '' },
      { key: 'rua_gst_number', value: shop.gst || '' },
      { key: 'rua_pan_url', value: shop.panUrl || '' },
      { key: 'rua_aadhaar_url', value: shop.aadhaarUrl || '' },
    ],
  };
  const auth = wcAuthHeader();
  const response = existing
    ? await fetch('https://ruahome.in/wp-json/wc/v3/customers/' + existing.customerId, {
        method: 'PUT',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      })
    : await fetch('https://ruahome.in/wp-json/wc/v3/customers', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          username: shopUsername(digits),
          email: shopEmail(digits),
          password: createHash('sha256').update(digits + '-rua-shop-' + Date.now()).digest('hex').slice(0, 24),
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('Shop save failed: HTTP ' + response.status + ' ' + text.slice(0, 300));
  }
  return customerToShop(await response.json());
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
    customer_note: 'Order ' + (order.orderNumber || '') + ' booked via RUA Sales App by ' + (order.staffName || ('staff #' + order.staffId)),
    meta_data: [
      { key: 'rua_order_number', value: order.orderNumber ?? '' },
      { key: 'rua_staff_id', value: String(order.staffId ?? '') },
      { key: 'rua_staff_name', value: order.staffName ?? '' },
      { key: 'rua_shop', value: order.shop ?? '' },
      ],
  };
  if (order.shopCustomerId) payload.customer_id = order.shopCustomerId;
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

function readJsonBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > maxBytes) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export function createApp(requestPage = bridgeRequest, requestWcPage = bridgeWcRequest) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('OK');
      return;
    }
    try {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(await readFile(new URL('./index.html', import.meta.url)));
      } else if (req.method === 'GET' && req.url === '/api/catalogue') {
        const products = await loadCatalogue(requestPage, requestWcPage);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(products));
      } else if (req.method === 'GET' && req.url === '/api/staff') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(staffDirectory()));
      } else if (req.method === 'GET' && req.url.startsWith('/api/shop?')) {
        const query = new URL(req.url, 'http://internal');
        const shop = await findShopByPhone(query.searchParams.get('phone'));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(shop || {}));
      } else if (req.method === 'POST' && req.url === '/api/shop') {
        const body = await readJsonBody(req);
        const digits = String(body.phone || '').replace(/\D/g, '');
        const existing = digits.length === 10 ? await findShopByPhone(digits).catch(() => null) : null;
        let panUrl = existing?.panUrl || '';
        let aadhaarUrl = existing?.aadhaarUrl || '';
        if (body.panPhoto) panUrl = await uploadShopPhoto(body.panPhoto, 'pan-' + digits);
        if (body.aadhaarPhoto) aadhaarUrl = await uploadShopPhoto(body.aadhaarPhoto, 'aadhaar-' + digits);
        const shop = await upsertShop({
          name: body.name,
          address: body.address,
          phone: digits,
          secondaryPhone: body.secondaryPhone,
          gst: body.gst,
          panUrl,
          aadhaarUrl,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(shop));
      } else if (req.method === 'POST' && req.url === '/api/otp/send') {
        const body = await readJsonBody(req);
        const order = Array.isArray(body.lines) ? { lines: body.lines } : null;
        const result = await sendOtp(String(body.phone || ''), order);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      } else if (req.method === 'POST' && req.url === '/api/otp/verify') {
        const body = await readJsonBody(req);
        const ok = verifyOtp(String(body.phone || ''), String(body.code || ''));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok }));
      } else if (req.method === 'POST' && req.url === '/api/orders') {
        const body = await readJsonBody(req);
        const orderNumber = await nextOrderNumber();
        const order = { ...body, orderNumber, receivedAt: new Date().toISOString() };
        let wooOrder = null, wooError = null;
        try { wooOrder = await createWooOrder(order); }
        catch (err) { wooError = err.message; console.error('WooCommerce order error:', err); }
        order.wooOrderId = wooOrder?.id ?? null;
        await writeOrder(order);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          ok: true,
          orderNumber,
          synced: !!wooOrder,
          warning: wooError ? 'Order saved locally but could not sync to WooCommerce yet: ' + wooError : undefined,
        }));
      }else {
        res.writeHead(404).end();
      }
    }
    catch(err) {
      console.error('Request error:', err);
      if (res.headersSent) res.end();
      else res.writeHead(err.statusCode || 503, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: err.statusCode ? err.message : 'Catalogue unavailable' }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(process.env.PORT || 3000, process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
}
