import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createShopifyApp } from '../server.js';
import { SHOP_COOKIE_NAME, createSignedShopCookie, csrfTokenForCookie } from '../shopify.js';

const SHOP = 'demo.myshopify.com';
const SHOPIFY_SECRET = 'shopify-app-secret';
const MONA_WEBHOOK_SECRET = 'mona-webhook-secret';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function fixture(fetchMock) {
  const dataDir = await mkdtemp(join(tmpdir(), 'monapay-shopify-'));
  const app = createShopifyApp({
    env: {
      HOST: '127.0.0.1',
      PORT: '8793',
      SHOPIFY_APP_URL: 'https://shopify.monapay.vn',
      SHOPIFY_API_KEY: 'shopify-api-key',
      SHOPIFY_API_SECRET: SHOPIFY_SECRET,
      SHOPIFY_API_VERSION: '2026-07',
      SHOPIFY_SCOPES: 'read_orders,write_orders',
      APP_SECRET_KEY: 'test-app-secret-key-with-at-least-32-characters',
      MONAPAY_API_BASE: 'https://api.monapay.vn',
      DATA_DIR: dataDir,
      OUTBOUND_TIMEOUT_MS: '1000',
    },
    fetch: fetchMock,
  });
  return app;
}

async function dispatch(app, path, { method = 'GET', headers = {}, body = '' } = {}) {
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  request.url = path;
  request.method = method;
  request.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const chunks = [];
  const responseHeaders = {};
  const response = {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) { responseHeaders[String(name).toLowerCase()] = value; },
    writeHead(status, values = {}) {
      this.statusCode = status;
      this.headersSent = true;
      for (const [key, value] of Object.entries(values)) responseHeaders[key.toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.headersSent = true;
    },
  };
  await app.handler(request, response);
  const text = Buffer.concat(chunks).toString('utf8');
  return {
    status: response.statusCode,
    headers: responseHeaders,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function shopifyHeaders(raw, topic, webhookId = 'wh-1') {
  return {
    'content-type': 'application/json',
    'x-shopify-topic': topic,
    'x-shopify-shop-domain': SHOP,
    'x-shopify-webhook-id': webhookId,
    'x-shopify-hmac-sha256': createHmac('sha256', SHOPIFY_SECRET).update(raw).digest('base64'),
  };
}

async function installShop(store) {
  await store.saveShop(SHOP, {
    accessToken: 'shpat_test',
    merchant: {
      clientId: 'mona-client-id',
      clientSecret: 'mona-client-secret',
      webhookSecret: MONA_WEBHOOK_SECRET,
      webhookId: 'mona-wh-1',
      sandbox: true,
    },
  });
}

function sessionToken(shop = SHOP) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    aud: 'shopify-api-key',
    dest: `https://${shop}/admin`,
    exp: Math.floor(Date.now() / 1000) + 300,
  })).toString('base64url');
  const signature = createHmac('sha256', SHOPIFY_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

test('settings lưu MONA credentials, tự tạo webhook và không lộ secret ra HTML', async () => {
  const calls = [];
  let shopifyWebhookId = 10;
  const app = await fixture(async (url, init) => {
    calls.push({ url: String(url), init });
    const href = String(url);
    if (href.endsWith('/api/v1/oauth/token')) {
      return json({ success: true, data: { access_token: 'mona-token', expires_in: 3600 } });
    }
    if (href.endsWith('/api/v1/client/me')) return json({ success: true, data: { name: 'Shop Demo' } });
    if (href.endsWith('/api/v1/client-webhooks') && init.method === 'POST') {
      return json({ success: true, data: { id: 'mona-webhook-id' } }, 201);
    }
    if (href.endsWith('/admin/api/2026-07/webhooks.json') && init.method === 'GET') {
      return json({ webhooks: [] });
    }
    if (href.endsWith('/admin/api/2026-07/webhooks.json') && init.method === 'POST') {
      shopifyWebhookId += 1;
      return json({ webhook: { id: shopifyWebhookId } }, 201);
    }
    throw new Error(`Unexpected fetch: ${init.method} ${url}`);
  });
  await app.store.saveShop(SHOP, { accessToken: 'shpat_test' });
  const cookie = createSignedShopCookie(SHOP, SHOPIFY_SECRET);
  const form = new URLSearchParams({
    csrf: csrfTokenForCookie(cookie, SHOPIFY_SECRET),
    client_id: 'client-public-id',
    client_secret: 'client-private-secret',
    sandbox: 'on',
  }).toString();
  const response = await dispatch(app, `/settings/save?shop=${SHOP}`, {
    method: 'POST',
    headers: {
      cookie: `${SHOP_COOKIE_NAME}=${cookie}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.doesNotMatch(html, /client-private-secret|mona-webhook-secret/);
  const stored = await app.store.getShop(SHOP);
  assert.equal(stored.merchant.clientId, 'client-public-id');
  assert.equal(stored.merchant.clientSecret, 'client-private-secret');
  assert.equal(stored.merchant.webhookId, 'mona-webhook-id');
  assert.equal(stored.merchant.sandbox, true);
  assert.equal(stored.shopifyWebhookIds.length, 2);

  const webhookCall = calls.find((call) => call.url.endsWith('/api/v1/client-webhooks'));
  const webhookBody = JSON.parse(webhookCall.init.body);
  assert.equal(webhookBody.webhook_url, 'https://shopify.monapay.vn/webhooks/monapay');
  assert.equal(webhookBody.auth_type, 'HMAC_SHA256');
  assert.equal(webhookBody.secret_key, stored.merchant.webhookSecret);
});

test('orders/create tạo hosted checkout, ghi link và chống trùng', async () => {
  const calls = [];
  const app = await fixture(async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/v1/oauth/token')) {
      return json({ success: true, data: { access_token: 'mona-token', expires_in: 3600 } });
    }
    if (String(url).endsWith('/api/v1/checkouts')) {
      return json({ success: true, data: {
        id: 'checkout-1',
        token: 'checkout-token',
        checkout_url: 'https://pay.monapay.vn/c/checkout-token',
        qr_image_url: 'https://api.monapay.vn/api/v1/checkouts/public/checkout-token/qr.png',
        qr_data_url: 'data:image/png;base64,AA',
        order_code: 'SP1001',
        amount: 150000,
        expires_at: '2026-09-05T00:00:00Z',
      } }, 201);
    }
    if (String(url).includes(`/admin/api/2026-07/orders/123.json`) && init.method === 'PUT') {
      return json({ order: { id: 123 } });
    }
    throw new Error(`Unexpected fetch: ${init.method} ${url}`);
  });
  await installShop(app.store);

  const raw = JSON.stringify({
    id: 123,
    name: '#1001',
    order_number: 1001,
    financial_status: 'pending',
    payment_gateway_names: ['Chuyển khoản MONA Pay'],
    currency: 'VND',
    current_total_price: '150000',
    order_status_url: 'https://demo.myshopify.com/123/orders/status-token',
    note_attributes: [{ name: 'Kênh', value: 'Website' }],
    tags: 'vip',
  });
  const first = await dispatch(app, '/webhooks/orders-create', {
    method: 'POST', headers: shopifyHeaders(raw, 'orders/create'), body: raw,
  });
  assert.equal(first.status, 201);

  const checkoutCall = calls.find((call) => call.url.endsWith('/api/v1/checkouts'));
  const checkoutBody = JSON.parse(checkoutCall.init.body);
  assert.deepEqual(checkoutBody, {
    order_code: 'SP1001',
    amount: 150000,
    return_url: 'https://demo.myshopify.com/123/orders/status-token',
    metadata: { shop: SHOP, order_id: '123' },
    expires_in: 86400,
    sandbox: true,
  });
  const checkoutHeaders = new Headers(checkoutCall.init.headers);
  assert.equal(checkoutHeaders.get('x-client-secret'), 'mona-client-secret');
  assert.equal(checkoutHeaders.get('idempotency-key'), `shopify-${SHOP}-123`);

  const updateCall = calls.find((call) => call.url.includes('/orders/123.json'));
  const updateBody = JSON.parse(updateCall.init.body).order;
  assert.deepEqual(updateBody.note_attributes.at(-1), {
    name: 'MONA Pay link', value: 'https://pay.monapay.vn/c/checkout-token',
  });
  assert.match(updateBody.tags, /monapay-pending/);

  const beforeDuplicate = calls.length;
  const duplicate = await dispatch(app, '/webhooks/orders-create', {
    method: 'POST', headers: shopifyHeaders(raw, 'orders/create'), body: raw,
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(calls.length, beforeDuplicate);
});

test('CHECKOUT_PAID dùng GraphQL orderMarkAsPaid, cập nhật tag/note và chống trùng transaction_code', async () => {
  const calls = [];
  const app = await fixture(async (url, init) => {
    calls.push({ url: String(url), init });
    const href = String(url);
    if (href.endsWith('/graphql.json') && init.method === 'POST') {
      return json({
        data: {
          orderMarkAsPaid: {
            order: { id: 'gid://shopify/Order/123', displayFinancialStatus: 'PAID' },
            userErrors: [],
          },
        },
      });
    }
    if (href.includes('/orders/123.json?fields=id,tags,note_attributes,financial_status') && init.method === 'GET') {
      return json({
        order: {
          id: 123,
          tags: 'vip, monapay-pending',
          note_attributes: [{ name: 'MONA Pay link', value: 'https://pay.monapay.vn/c/token' }],
          financial_status: 'paid',
        },
      });
    }
    if (href.endsWith('/orders/123.json') && init.method === 'PUT') return json({ order: { id: 123 } });
    throw new Error(`Unexpected fetch: ${init.method} ${url}`);
  });
  await installShop(app.store);
  await app.store.saveOrder(SHOP, '123', {
    shop: SHOP,
    orderId: '123',
    orderCode: 'SP1001',
    checkoutId: 'checkout-1',
    checkoutUrl: 'https://pay.monapay.vn/c/token',
    amount: 150000,
    currency: 'VND',
    tags: ['vip', 'monapay-pending'],
    status: 'pending',
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({
    event: 'CHECKOUT_PAID',
    checkout_id: 'checkout-1',
    order_code: 'SP1001',
    status: 'paid',
    amount: 150000,
    currency: 'VND',
    paid_amount: 150000,
    paid_at: '2026-09-04T12:00:00Z',
    transaction_code: 'TX-001',
    metadata: { shop: SHOP, order_id: '123' },
  });
  const signature = createHmac('sha256', MONA_WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest('hex');
  const headers = {
    'content-type': 'application/json',
    'x-mona-timestamp': timestamp,
    'x-mona-signature': `sha256=${signature}`,
  };
  const paid = await dispatch(app, '/webhooks/monapay', { method: 'POST', headers, body: payload });
  assert.equal(paid.status, 200);

  const graphqlCall = calls.find((call) => call.url.endsWith('/graphql.json'));
  const graphqlBody = JSON.parse(graphqlCall.init.body);
  assert.match(graphqlBody.query, /orderMarkAsPaid\s*\(input:\s*\$input\)/);
  assert.deepEqual(graphqlBody.variables, {
    input: { id: 'gid://shopify/Order/123' },
  });
  assert.equal(new Headers(graphqlCall.init.headers).get('x-shopify-access-token'), 'shpat_test');
  assert.equal(calls.some((call) => call.url.endsWith('/transactions.json')), false);

  const tagCall = calls.find((call) => call.url.endsWith('/orders/123.json') && call.init.method === 'PUT');
  const orderUpdate = JSON.parse(tagCall.init.body).order;
  assert.equal(orderUpdate.tags, 'vip, monapay-paid');
  assert.deepEqual(orderUpdate.note_attributes, [
    { name: 'MONA Pay link', value: 'https://pay.monapay.vn/c/token' },
    { name: 'MONA Pay transaction', value: 'TX-001' },
  ]);
  assert.equal((await app.store.getOrder(SHOP, '123')).status, 'paid');

  const beforeDuplicate = calls.length;
  const duplicate = await dispatch(app, '/webhooks/monapay', { method: 'POST', headers, body: payload });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(calls.length, beforeDuplicate);
});

test('CHECKOUT_PAID bỏ qua fallback khi Shopify báo đơn đã PAID', async () => {
  const calls = [];
  const app = await fixture(async (url, init) => {
    calls.push({ url: String(url), init });
    const href = String(url);
    if (href.endsWith('/graphql.json') && init.method === 'POST') {
      return json({
        data: {
          orderMarkAsPaid: {
            order: { id: 'gid://shopify/Order/123', displayFinancialStatus: 'PAID' },
            userErrors: [{ field: ['id'], message: 'Order cannot be marked as paid.' }],
          },
        },
      });
    }
    if (href.includes('/orders/123.json?fields=id,tags,note_attributes,financial_status') && init.method === 'GET') {
      return json({ order: { id: 123, tags: 'monapay-paid', note_attributes: [], financial_status: 'paid' } });
    }
    if (href.endsWith('/orders/123.json') && init.method === 'PUT') return json({ order: { id: 123 } });
    throw new Error(`Unexpected fetch: ${init.method} ${url}`);
  });
  await installShop(app.store);
  await app.store.saveOrder(SHOP, '123', {
    shop: SHOP,
    orderId: '123',
    orderCode: 'SP1001',
    checkoutId: 'checkout-1',
    checkoutUrl: 'https://pay.monapay.vn/c/token',
    amount: 150000,
    currency: 'VND',
    tags: ['monapay-pending'],
    status: 'pending',
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({
    event: 'CHECKOUT_PAID',
    checkout_id: 'checkout-1',
    order_code: 'SP1001',
    status: 'paid',
    amount: 150000,
    currency: 'VND',
    paid_amount: 150000,
    transaction_code: 'TX-ALREADY-PAID',
    metadata: { shop: SHOP, order_id: '123' },
  });
  const signature = createHmac('sha256', MONA_WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest('hex');
  const response = await dispatch(app, '/webhooks/monapay', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mona-timestamp': timestamp,
      'x-mona-signature': `sha256=${signature}`,
    },
    body: payload,
  });
  assert.equal(response.status, 200);
  assert.equal(calls.some((call) => call.url.endsWith('/transactions.json')), false);
  assert.equal((await app.store.getOrder(SHOP, '123')).status, 'paid');
});

test('CHECKOUT_PAID fallback REST từ GraphQL userErrors: capture pending rồi sale nếu capture lỗi', async () => {
  const calls = [];
  const app = await fixture(async (url, init) => {
    calls.push({ url: String(url), init });
    const href = String(url);
    if (href.endsWith('/graphql.json') && init.method === 'POST') {
      return json({
        data: {
          orderMarkAsPaid: {
            order: null,
            userErrors: [{ field: ['id'], message: 'Could not mark order as paid' }],
          },
        },
      });
    }
    if (href.endsWith('/orders/123/transactions.json') && init.method === 'GET') {
      return json({
        transactions: [{ id: 88, kind: 'sale', status: 'pending', amount: '150000', currency: 'VND' }],
      });
    }
    if (href.endsWith('/orders/123/transactions.json') && init.method === 'POST') {
      const transaction = JSON.parse(init.body).transaction;
      if (transaction.kind === 'capture') return json({ errors: 'Capture is not supported' }, 422);
      return json({ transaction: { id: 89, ...transaction } }, 201);
    }
    if (href.includes('/orders/123.json?fields=id,tags,note_attributes,financial_status') && init.method === 'GET') {
      return json({ order: { id: 123, tags: 'monapay-pending', note_attributes: [] } });
    }
    if (href.endsWith('/orders/123.json') && init.method === 'PUT') return json({ order: { id: 123 } });
    throw new Error(`Unexpected fetch: ${init.method} ${url}`);
  });
  await installShop(app.store);
  await app.store.saveOrder(SHOP, '123', {
    shop: SHOP,
    orderId: '123',
    orderCode: 'SP1001',
    checkoutId: 'checkout-1',
    checkoutUrl: 'https://pay.monapay.vn/c/token',
    amount: 150000,
    currency: 'VND',
    tags: ['monapay-pending'],
    status: 'pending',
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({
    event: 'CHECKOUT_PAID',
    checkout_id: 'checkout-1',
    order_code: 'SP1001',
    status: 'paid',
    amount: 150000,
    currency: 'VND',
    paid_amount: 150000,
    paid_at: '2026-09-04T12:00:00Z',
    transaction_code: 'TX-FALLBACK',
    metadata: { shop: SHOP, order_id: '123' },
  });
  const signature = createHmac('sha256', MONA_WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest('hex');
  const response = await dispatch(app, '/webhooks/monapay', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mona-timestamp': timestamp,
      'x-mona-signature': `sha256=${signature}`,
    },
    body: payload,
  });
  assert.equal(response.status, 200);

  const transactionCalls = calls.filter((call) => (
    call.url.endsWith('/orders/123/transactions.json') && call.init.method === 'POST'
  ));
  assert.equal(transactionCalls.length, 2);
  assert.deepEqual(JSON.parse(transactionCalls[0].init.body), {
    transaction: {
      kind: 'capture',
      parent_id: 88,
      amount: '150000',
      currency: 'VND',
    },
  });
  assert.deepEqual(JSON.parse(transactionCalls[1].init.body), {
    transaction: {
      kind: 'sale',
      status: 'success',
      parent_id: 88,
    },
  });
  const stored = await app.store.getOrder(SHOP, '123');
  assert.equal(stored.status, 'paid');
  assert.equal(stored.transactionCode, 'TX-FALLBACK');
});

test('api/pay-link chỉ trả checkout cho Shopify session token hợp lệ', async () => {
  const app = await fixture(async () => { throw new Error('Không được gọi API ngoài'); });
  await app.store.saveOrder(SHOP, '123', {
    shop: SHOP,
    orderId: '123',
    orderCode: 'SP1001',
    checkoutId: 'checkout-1',
    checkoutToken: 'secret-token-not-returned',
    checkoutUrl: 'https://pay.monapay.vn/c/token',
    qrImageUrl: 'https://api.monapay.vn/qr.png',
    qrDataUrl: 'qr-data',
    amount: 150000,
    currency: 'VND',
    status: 'pending',
  });
  const gid = encodeURIComponent('gid://shopify/Order/123');
  const response = await dispatch(app, `/api/pay-link/${gid}`, {
    headers: { authorization: `Bearer ${sessionToken()}` },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.checkout_url, 'https://pay.monapay.vn/c/token');
  assert.equal(body.checkoutToken, undefined);

  const unauthorized = await dispatch(app, '/api/pay-link/123', {
    headers: { authorization: 'Bearer invalid' },
  });
  assert.equal(unauthorized.status, 401);
});

test('compliance webhooks trả 200; app/uninstalled và shop/redact xóa dữ liệu shop', async () => {
  const app = await fixture(async () => { throw new Error('Không được gọi API ngoài'); });
  await installShop(app.store);

  for (const [path, topic] of [
    ['customers-data-request', 'customers/data_request'],
    ['customers-redact', 'customers/redact'],
  ]) {
    const raw = JSON.stringify({ shop_domain: SHOP });
    const response = await dispatch(app, `/webhooks/${path}`, {
      method: 'POST', headers: shopifyHeaders(raw, topic, `wh-${path}`), body: raw,
    });
    assert.equal(response.status, 200);
  }
  assert.ok(await app.store.getShop(SHOP));

  const forged = await dispatch(app, '/webhooks/shop-redact', {
    method: 'POST',
    headers: {
      ...shopifyHeaders('{}', 'shop/redact', 'wh-forged'),
      'x-shopify-hmac-sha256': 'forged',
    },
    body: '{}',
  });
  assert.equal(forged.status, 401);
  assert.ok(await app.store.getShop(SHOP));

  const uninstallRaw = JSON.stringify({ id: 1, domain: SHOP });
  const uninstall = await dispatch(app, '/webhooks/app-uninstalled', {
    method: 'POST', headers: shopifyHeaders(uninstallRaw, 'app/uninstalled', 'wh-uninstall'), body: uninstallRaw,
  });
  assert.equal(uninstall.status, 200);
  assert.equal(await app.store.getShop(SHOP), null);

  await installShop(app.store);
  const redactRaw = JSON.stringify({ shop_id: 1, shop_domain: SHOP });
  const redact = await dispatch(app, '/webhooks/shop-redact', {
    method: 'POST', headers: shopifyHeaders(redactRaw, 'shop/redact', 'wh-shop-redact'), body: redactRaw,
  });
  assert.equal(redact.status, 200);
  assert.equal(await app.store.getShop(SHOP), null);
});
