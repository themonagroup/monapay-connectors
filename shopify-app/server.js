import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MonaPayApiError, MonaPayClient, verifyMonaWebhook } from './monapay.js';
import { JsonStore } from './store.js';
import {
  SHOP_COOKIE_NAME,
  createSignedShopCookie,
  csrfTokenForCookie,
  normalizeShop,
  parseCookies,
  verifyOAuthHmac,
  verifySessionToken,
  verifySignedShopCookie,
  verifyWebhookHmac,
} from './shopify.js';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 2 * 1_024 * 1_024;
const SHOP_COOKIE_TTL = 30 * 24 * 60 * 60;

class HttpError extends Error {
  constructor(message, status = 500, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function required(env, key) {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error(`Thiếu biến môi trường ${key}`);
  return value;
}

function safeBaseUrl(value, key) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} phải là URL hợp lệ`);
  }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) throw new Error(`${key} phải dùng HTTPS`);
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`${key} chỉ được chứa origin, không chứa credentials/path`);
  }
  return url.origin;
}

function integer(value, key, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${key} không hợp lệ`);
  return parsed;
}

export function loadConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && env.ALLOW_PUBLIC_BIND !== 'true') {
    throw new Error('Từ chối bind public; dùng HOST=127.0.0.1 sau Nginx');
  }
  const apiVersion = env.SHOPIFY_API_VERSION || '2026-07';
  if (!/^\d{4}-\d{2}$/.test(apiVersion)) throw new Error('SHOPIFY_API_VERSION phải có dạng YYYY-MM');
  const appSecretKey = required(env, 'APP_SECRET_KEY');
  if (appSecretKey.length < 32) throw new Error('APP_SECRET_KEY phải có ít nhất 32 ký tự');
  return {
    host,
    port: integer(env.PORT || 8793, 'PORT', { max: 65_535 }),
    appUrl: safeBaseUrl(required(env, 'SHOPIFY_APP_URL'), 'SHOPIFY_APP_URL'),
    apiKey: required(env, 'SHOPIFY_API_KEY'),
    apiSecret: required(env, 'SHOPIFY_API_SECRET'),
    apiVersion,
    scopes: env.SHOPIFY_SCOPES || 'read_orders,write_orders',
    appSecretKey,
    dataDir: resolve(env.DATA_DIR || `${APP_DIR}/data`),
    monapayApiBase: safeBaseUrl(env.MONAPAY_API_BASE || 'https://api.monapay.vn', 'MONAPAY_API_BASE'),
    outboundTimeoutMs: integer(env.OUTBOUND_TIMEOUT_MS || 5_000, 'OUTBOUND_TIMEOUT_MS', { max: 30_000 }),
  };
}

function sendJson(response, status, body, extraHeaders = {}) {
  const content = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  response.end(content);
}

function sendHtml(response, status, html, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  response.end(html);
}

function redirect(response, location, cookies = []) {
  response.statusCode = 302;
  response.setHeader('location', location);
  response.setHeader('cache-control', 'no-store');
  if (cookies.length) response.setHeader('set-cookie', cookies);
  response.end();
}

async function readRawBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError('Request body quá lớn', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readForm(request) {
  const raw = await readRawBody(request, 65_536);
  return new URLSearchParams(raw.toString('utf8'));
}

function bearerToken(header) {
  return /^Bearer\s+(.+)$/i.exec(String(header || ''))?.[1];
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sameText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ level: 'info', event, ...fields })}\n`);
}

function bodyForLog(body) {
  let text;
  try {
    text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  } catch {
    text = String(body);
  }
  return text.slice(0, 300);
}

function logShopifyRequestFailed(error, fields = {}) {
  process.stderr.write(`${JSON.stringify({
    level: 'error',
    event: 'shopify_request_failed',
    ...fields,
    message: error.message,
    body: bodyForLog(error.body),
  })}\n`);
  error.shopifyRequestLogged = true;
}

async function responseJson(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (cause) {
    const message = cause?.name === 'AbortError' ? `API timeout sau ${timeoutMs}ms` : 'Không gọi được API';
    throw new HttpError(message, 502, cause);
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      const error = new HttpError(`API trả response không phải JSON (HTTP ${response.status})`, 502, text);
      error.upstreamStatus = response.status;
      throw error;
    }
  }
  if (!response.ok) {
    const error = new HttpError(`API trả HTTP ${response.status}`, 502, body);
    error.upstreamStatus = response.status;
    throw error;
  }
  return body;
}

function tagsFrom(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(source.map((tag) => String(tag).trim()).filter(Boolean))];
}

function noteAttributesWithLink(attributes, checkoutUrl) {
  const kept = Array.isArray(attributes)
    ? attributes.filter((item) => item && item.name !== 'MONA Pay link')
    : [];
  return [...kept, { name: 'MONA Pay link', value: checkoutUrl }];
}

function noteAttributesWithTransaction(attributes, transactionCode) {
  const kept = Array.isArray(attributes)
    ? attributes.filter((item) => item && item.name !== 'MONA Pay transaction')
    : [];
  return [...kept, { name: 'MONA Pay transaction', value: transactionCode }];
}

function orderIdFromPath(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  const plain = decoded.replace(/^gid:\/\/shopify\/Order\//, '');
  return /^\d+$/.test(plain) ? plain : null;
}

export function isMonaPayPendingOrder(order) {
  const gateways = [
    ...(Array.isArray(order?.payment_gateway_names) ? order.payment_gateway_names : []),
    order?.gateway,
  ].filter(Boolean);
  return order?.financial_status === 'pending'
    && gateways.some((name) => /MONA\s*Pay/i.test(String(name)));
}

function settingsPage({ shop, merchant, csrf, message, error, webhookRegistrationError }) {
  const hasSecret = Boolean(merchant?.clientSecret);
  const notice = message ? `<div class="notice success">${escapeHtml(message)}</div>` : '';
  const failure = error ? `<div class="notice error">${escapeHtml(error)}</div>` : '';
  const webhookWarning = webhookRegistrationError
    ? '<div class="notice error">Shopify chưa đăng ký đủ webhook. Anh chị hãy lưu lại cấu hình để ứng dụng thử đăng ký lại.</div>'
    : '';
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cài đặt MONA Pay</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f7f8;color:#18212f;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55}
main{max-width:680px;margin:48px auto;padding:0 20px}.card{background:#fff;border:1px solid #dfe3e8;border-radius:14px;padding:28px;box-shadow:0 8px 30px rgba(30,40,55,.06)}
h1{font-size:26px;margin:0 0 8px}p{margin:8px 0 20px;color:#52606d}label{display:block;font-weight:650;margin:18px 0 7px}input[type=text],input[type=password]{width:100%;padding:12px;border:1px solid #b8c2cc;border-radius:8px;font:inherit}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:500}.check input{margin-top:5px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}button{border:0;border-radius:8px;padding:11px 18px;font:inherit;font-weight:700;cursor:pointer;background:#111827;color:#fff}.secondary{background:#e8edf2;color:#18212f}
.notice{padding:12px 14px;border-radius:8px;margin:16px 0}.success{background:#e9f8ef;color:#17673a}.error{background:#fff0f0;color:#a52828}.hint{font-size:14px;color:#687684;margin-top:6px}a{color:#1769aa}</style></head>
<body><main><div class="card"><h1>Kết nối MONA Pay</h1><p>Shop <strong>${escapeHtml(shop)}</strong>. Anh chị lấy Client ID và Client Secret tại my.monapay.vn → API Keys.</p>
${notice}${failure}${webhookWarning}
<form method="post" action="/settings/save?shop=${encodeURIComponent(shop)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="client_id">MONA Client ID</label><input id="client_id" name="client_id" type="text" autocomplete="off" required value="${escapeHtml(merchant?.clientId || '')}">
<label for="client_secret">MONA Client Secret</label><input id="client_secret" name="client_secret" type="password" autocomplete="new-password" ${hasSecret ? '' : 'required'} placeholder="${hasSecret ? 'Giữ trống để dùng secret đang lưu' : 'Dán Client Secret'}">
<div class="hint">Secret được mã hóa AES-256-GCM trước khi ghi xuống máy chủ.</div>
<label class="check"><input name="sandbox" type="checkbox" ${merchant?.sandbox ? 'checked' : ''}><span>Bật sandbox để thử thanh toán, không chuyển tiền thật</span></label>
<div class="actions"><button type="submit">Lưu cấu hình</button><button class="secondary" type="submit" formaction="/settings/test?shop=${encodeURIComponent(shop)}">Kiểm tra</button></div>
</form><p class="hint">Khi lưu, ứng dụng tự đăng ký webhook MONA Pay cho shop này.</p></div></main></body></html>`;
}

export function createShopifyApp({ env = process.env, fetch = globalThis.fetch } = {}) {
  const config = loadConfig(env);
  const store = new JsonStore(config.dataDir, { secretKey: config.appSecretKey });
  const oauthStates = new Map();
  const orderJobs = new Map();
  const transactionJobs = new Map();

  function monaClient(merchant) {
    return new MonaPayClient({
      baseUrl: config.monapayApiBase,
      clientId: merchant.clientId,
      clientSecret: merchant.clientSecret,
      fetch,
      timeoutMs: config.outboundTimeoutMs,
    });
  }

  async function shopifyAdmin(shop, accessToken, method, path, body) {
    try {
      return await responseJson(fetch, `https://${shop}/admin/api/${config.apiVersion}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'X-Shopify-Access-Token': accessToken,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, config.outboundTimeoutMs);
    } catch (error) {
      if (Number.isInteger(error.upstreamStatus) && error.upstreamStatus >= 400) {
        logShopifyRequestFailed(error, {
          shop,
          method,
          path,
          status: error.upstreamStatus,
        });
      }
      throw error;
    }
  }

  async function registerShopifyWebhooks(shop, accessToken) {
    const addresses = [
      { topic: 'orders/create', address: `${config.appUrl}/webhooks/orders-create` },
      { topic: 'app/uninstalled', address: `${config.appUrl}/webhooks/app-uninstalled` },
    ];
    const listed = await shopifyAdmin(shop, accessToken, 'GET', '/webhooks.json');
    const existing = Array.isArray(listed?.webhooks) ? listed.webhooks : [];
    const ids = [];
    for (const item of addresses) {
      const found = existing.find((entry) => entry.topic === item.topic && entry.address === item.address);
      if (found) {
        ids.push(String(found.id));
        continue;
      }
      const created = await shopifyAdmin(shop, accessToken, 'POST', '/webhooks.json', {
        webhook: { ...item, format: 'json' },
      });
      if (created?.webhook?.id) ids.push(String(created.webhook.id));
    }
    return ids;
  }

  function authenticateSettings(request, requestedShop) {
    const bearer = bearerToken(request.headers.authorization);
    if (bearer) {
      let session;
      try {
        session = verifySessionToken(bearer, { apiKey: config.apiKey, secret: config.apiSecret });
      } catch (error) {
        throw new HttpError(error.message, 401);
      }
      if (session.shop !== requestedShop) throw new HttpError('Session token không thuộc shop này', 403);
      return { kind: 'session', shop: session.shop };
    }
    const cookieValue = parseCookies(request.headers.cookie)[SHOP_COOKIE_NAME];
    const cookie = verifySignedShopCookie(cookieValue, config.apiSecret);
    if (!cookie || cookie.shop !== requestedShop) throw new HttpError('Phiên cài đặt đã hết hạn; hãy mở lại ứng dụng từ Shopify', 401);
    return { kind: 'cookie', shop: cookie.shop, cookieValue };
  }

  function verifySettingsCsrf(auth, form) {
    if (auth.kind !== 'cookie') return;
    const expected = csrfTokenForCookie(auth.cookieValue, config.apiSecret);
    if (!sameText(form.get('csrf'), expected)) throw new HttpError('CSRF token không hợp lệ', 403);
  }

  async function renderSettings(response, shop, auth, overrides = {}) {
    const record = await store.getShop(shop);
    if (!record?.accessToken) throw new HttpError('Shop chưa cài ứng dụng', 403);
    const csrf = auth.kind === 'cookie' ? csrfTokenForCookie(auth.cookieValue, config.apiSecret) : '';
    sendHtml(response, overrides.status || 200, settingsPage({
      shop,
      merchant: overrides.merchant || record.merchant,
      csrf,
      webhookRegistrationError: record.shopifyWebhookRegistrationError,
      ...overrides,
    }));
  }

  async function settingsCredentials(form, current) {
    const clientId = String(form.get('client_id') || '').trim();
    const enteredSecret = String(form.get('client_secret') || '').trim();
    const clientSecret = enteredSecret || current?.clientSecret;
    if (!clientId || !clientSecret) throw new HttpError('Anh chị cần nhập đủ MONA Client ID và Client Secret', 400);
    return { clientId, clientSecret, sandbox: form.get('sandbox') === 'on' };
  }

  async function saveMonaSettings(shop, shopRecord, merchant) {
    const client = monaClient(merchant);
    await client.me();
    const webhookSecret = shopRecord.merchant?.webhookSecret || randomBytes(32).toString('base64url');
    const webhookBody = {
      name: `Shopify ${shop}`,
      webhook_url: `${config.appUrl}/webhooks/monapay`,
      auth_type: 'HMAC_SHA256',
      secret_key: webhookSecret,
      payload_format: 'application/json',
    };
    let webhook = null;
    if (shopRecord.merchant?.webhookId) {
      try {
        webhook = await client.updateWebhook(shopRecord.merchant.webhookId, webhookBody);
      } catch (error) {
        if (!(error instanceof MonaPayApiError) || error.status !== 404) throw error;
      }
    }
    webhook ||= await client.createWebhook(webhookBody);
    if (!webhook?.id) throw new HttpError('MONA Pay không trả webhook id', 502);

    let shopifyWebhookIds = shopRecord.shopifyWebhookIds || [];
    let shopifyWebhookRegistrationError = null;
    try {
      shopifyWebhookIds = await registerShopifyWebhooks(shop, shopRecord.accessToken);
    } catch (error) {
      shopifyWebhookRegistrationError = error.message;
      log('shopify_webhook_registration_failed', { shop, message: error.message });
    }
    return store.saveShop(shop, {
      merchant: { ...merchant, webhookSecret, webhookId: String(webhook.id) },
      shopifyWebhookIds,
      shopifyWebhookRegistrationError,
    });
  }

  async function annotatePendingOrder(orderRecord, sourceOrder, shopRecord) {
    const attributes = noteAttributesWithLink(
      sourceOrder?.note_attributes,
      orderRecord.checkoutUrl,
    );
    const tags = tagsFrom(sourceOrder?.tags).filter((tag) => tag !== 'monapay-paid');
    if (!tags.includes('monapay-pending')) tags.push('monapay-pending');
    await shopifyAdmin(orderRecord.shop, shopRecord.accessToken, 'PUT', `/orders/${encodeURIComponent(orderRecord.orderId)}.json`, {
      order: {
        id: Number(orderRecord.orderId),
        note_attributes: attributes,
        tags: tags.join(', '),
      },
    });
    return store.updateOrder(orderRecord.shop, orderRecord.orderId, {
      tags: ['monapay-pending'],
      shopifyAnnotatedAt: new Date().toISOString(),
    });
  }

  async function createOrderCheckout(shop, order, webhookId) {
    const orderId = String(order.id || '').trim();
    const shopRecord = await store.getShop(shop);
    if (!shopRecord?.merchant?.clientSecret) throw new HttpError('Shop chưa cấu hình MONA Pay', 409);
    const existing = await store.getOrder(shop, orderId);
    if (existing) {
      if (!existing.shopifyAnnotatedAt) await annotatePendingOrder(existing, order, shopRecord);
      await store.markWebhook({ shop, orderId, webhookId });
      return store.getOrder(shop, orderId);
    }

    if (String(order.currency || '').toUpperCase() !== 'VND') throw new HttpError('MONA Pay chỉ xử lý đơn VND', 422);
    const amount = Number(order.current_total_price ?? order.total_price);
    if (!Number.isInteger(amount) || amount < 1_000 || amount > 1_000_000_000) {
      throw new HttpError('Tổng tiền phải là số nguyên VND từ 1.000 đến 1.000.000.000', 422);
    }
    const orderNumber = String(order.order_number || '').trim();
    if (!/^\d+$/.test(orderNumber)) throw new HttpError('Shopify order_number không hợp lệ', 422);
    let returnUrl;
    try {
      // Đơn tạo qua Admin API/POS có thể không có order_status_url → quay về trang shop
      returnUrl = new URL(order.order_status_url || `https://${shop}/`);
    } catch {
      throw new HttpError('Shopify order_status_url không hợp lệ', 422);
    }
    if (returnUrl.protocol !== 'https:') throw new HttpError('Shopify order_status_url phải dùng HTTPS', 422);

    const orderCode = `SP${orderNumber}`;
    const checkoutBody = {
      order_code: orderCode,
      amount,
      return_url: returnUrl.toString(),
      metadata: { shop, order_id: orderId },
      expires_in: 86_400,
      ...(shopRecord.merchant.sandbox ? { sandbox: true } : {}),
    };
    const checkout = await monaClient(shopRecord.merchant).createCheckout(
      checkoutBody,
      `shopify-${shop}-${orderId}`,
    );
    if (!checkout?.id || !checkout?.token || !checkout?.checkout_url) {
      throw new HttpError('MONA Pay trả checkout thiếu id/token/url', 502);
    }
    if (checkout.order_code && checkout.order_code !== orderCode) throw new HttpError('MONA Pay trả sai order_code', 502);
    if (checkout.amount != null && Number(checkout.amount) !== amount) throw new HttpError('MONA Pay trả sai amount', 502);

    const gateways = [
      ...(Array.isArray(order.payment_gateway_names) ? order.payment_gateway_names : []),
      order.gateway,
    ].filter(Boolean).map(String);
    const record = await store.saveOrder(shop, orderId, {
      shop,
      orderId,
      orderNumber,
      orderName: order.name,
      orderCode,
      amount,
      currency: 'VND',
      gateway: gateways.find((name) => /MONA\s*Pay/i.test(name)),
      checkoutId: String(checkout.id),
      checkoutToken: String(checkout.token),
      checkoutUrl: String(checkout.checkout_url),
      qrImageUrl: checkout.qr_image_url || null,
      qrDataUrl: checkout.qr_data_url || null,
      expiresAt: checkout.expires_at || null,
      tags: ['monapay-pending'],
      status: 'pending',
      sandbox: Boolean(shopRecord.merchant.sandbox),
      createdAt: new Date().toISOString(),
    });
    await annotatePendingOrder(record, order, shopRecord);
    await store.markWebhook({ shop, orderId, webhookId });
    return store.getOrder(shop, orderId);
  }

  async function markOrderPaidGraphql(order, shopRecord) {
    const gid = `gid://shopify/Order/${order.orderId}`;
    const result = await shopifyAdmin(order.shop, shopRecord.accessToken, 'POST', '/graphql.json', {
      query: `mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
        orderMarkAsPaid(input: $input) {
          order { id displayFinancialStatus }
          userErrors { field message }
        }
      }`,
      variables: { input: { id: gid } },
    });
    const mutation = result?.data?.orderMarkAsPaid;
    const userErrors = Array.isArray(mutation?.userErrors) ? mutation.userErrors : [];
    const graphqlErrors = Array.isArray(result?.errors) ? result.errors : [];
    const displayFinancialStatus = String(mutation?.order?.displayFinancialStatus || '').toUpperCase();

    if (userErrors.length || graphqlErrors.length) {
      if (displayFinancialStatus === 'PAID') {
        log('order_already_paid', { shop: order.shop, orderId: order.orderId, method: 'graphql' });
        return { alreadyPaid: true, method: 'graphql' };
      }
      throw new HttpError('Shopify GraphQL không thể đánh dấu đơn đã thanh toán', 502, {
        errors: graphqlErrors,
        userErrors,
      });
    }
    if (displayFinancialStatus !== 'PAID') {
      throw new HttpError('Shopify GraphQL không trả trạng thái PAID', 502, result);
    }
    log('order_marked_paid', { shop: order.shop, orderId: order.orderId, method: 'graphql' });
    return { alreadyPaid: false, method: 'graphql' };
  }

  async function markOrderPaidRestFallback(order, shopRecord, graphqlError) {
    const transactionPath = `/orders/${encodeURIComponent(order.orderId)}/transactions.json`;
    const listed = await shopifyAdmin(order.shop, shopRecord.accessToken, 'GET', transactionPath);
    const transactions = Array.isArray(listed?.transactions) ? listed.transactions : [];
    const completedAmount = transactions.filter((transaction) => (
      ['sale', 'capture'].includes(String(transaction.kind || '').toLowerCase())
      && String(transaction.status || '').toLowerCase() === 'success'
      && String(transaction.currency || order.currency || '').toUpperCase() === 'VND'
    )).reduce((total, transaction) => {
      const amount = Number(transaction.amount || 0);
      return total + (Number.isFinite(amount) ? amount : 0);
    }, 0);
    if (completedAmount >= order.amount) {
      log('order_already_paid', { shop: order.shop, orderId: order.orderId, method: 'rest_transactions' });
      return { alreadyPaid: true, method: 'rest_transactions' };
    }

    const pendingSale = transactions.find((transaction) => (
      String(transaction.kind || '').toLowerCase() === 'sale'
      && String(transaction.status || '').toLowerCase() === 'pending'
      && transaction.id != null
    ));
    if (!pendingSale) {
      const error = new HttpError('Không tìm thấy Shopify sale transaction đang pending để đánh dấu paid', 502, {
        graphql: graphqlError?.body || graphqlError?.message,
        transactions,
      });
      logShopifyRequestFailed(error, {
        shop: order.shop,
        method: 'POST',
        path: transactionPath,
      });
      throw error;
    }

    try {
      await shopifyAdmin(order.shop, shopRecord.accessToken, 'POST', transactionPath, {
        transaction: {
          kind: 'capture',
          parent_id: pendingSale.id,
          amount: String(order.amount),
          currency: 'VND',
        },
      });
      log('order_marked_paid', { shop: order.shop, orderId: order.orderId, method: 'rest_capture' });
      return { alreadyPaid: false, method: 'rest_capture' };
    } catch {
      await shopifyAdmin(order.shop, shopRecord.accessToken, 'POST', transactionPath, {
        transaction: {
          kind: 'sale',
          status: 'success',
          parent_id: pendingSale.id,
        },
      });
      log('order_marked_paid', { shop: order.shop, orderId: order.orderId, method: 'rest_sale' });
      return { alreadyPaid: false, method: 'rest_sale' };
    }
  }

  async function markOrderPaid(order, shopRecord) {
    try {
      return await markOrderPaidGraphql(order, shopRecord);
    } catch (graphqlError) {
      return markOrderPaidRestFallback(order, shopRecord, graphqlError);
    }
  }

  async function processPaidCheckout(order, payload) {
    const shopRecord = await store.getShop(order.shop);
    if (!shopRecord?.accessToken) throw new HttpError('Shop không còn cài ứng dụng', 410);
    if (String(order.status || '').toLowerCase() === 'paid') {
      log('order_already_paid', { shop: order.shop, orderId: order.orderId, method: 'local_store' });
      return order;
    }

    await markOrderPaid(order, shopRecord);

    const current = await shopifyAdmin(
      order.shop,
      shopRecord.accessToken,
      'GET',
      `/orders/${encodeURIComponent(order.orderId)}.json?fields=id,tags,note_attributes,financial_status`,
    );
    const tags = tagsFrom(current?.order?.tags || order.tags)
      .filter((tag) => tag !== 'monapay-pending' && tag !== 'monapay-paid');
    tags.push('monapay-paid');
    const noteAttributes = noteAttributesWithTransaction(
      current?.order?.note_attributes,
      payload.transaction_code,
    );
    await shopifyAdmin(order.shop, shopRecord.accessToken, 'PUT', `/orders/${encodeURIComponent(order.orderId)}.json`, {
      order: {
        id: Number(order.orderId),
        tags: tags.join(', '),
        note_attributes: noteAttributes,
      },
    });
    return store.markPaid({
      shop: order.shop,
      orderId: order.orderId,
      transactionCode: payload.transaction_code,
      payload,
    });
  }

  async function handleOrdersCreate(request, response) {
    const rawBody = await readRawBody(request);
    if (!verifyWebhookHmac(rawBody, request.headers['x-shopify-hmac-sha256'], config.apiSecret)) {
      sendJson(response, 401, { error: 'Shopify webhook HMAC không hợp lệ' });
      return;
    }
    const topic = request.headers['x-shopify-topic'];
    const shop = normalizeShop(request.headers['x-shopify-shop-domain']);
    const webhookId = String(request.headers['x-shopify-webhook-id'] || '').trim();
    if (topic !== 'orders/create' || !shop || !webhookId) {
      sendJson(response, 400, { error: 'Thiếu/sai Shopify topic, shop hoặc webhook id' });
      return;
    }
    const shopRecord = await store.getShop(shop);
    if (!shopRecord?.accessToken) {
      sendJson(response, 403, { error: 'Shop chưa cài ứng dụng' });
      return;
    }
    if (await store.hasWebhook(shop, webhookId)) {
      sendJson(response, 200, { success: true, duplicate: true });
      return;
    }
    let order;
    try {
      order = JSON.parse(rawBody.toString('utf8'));
    } catch {
      sendJson(response, 400, { error: 'Webhook body không phải JSON' });
      return;
    }
    const orderId = String(order.id || '').trim();
    if (!/^\d+$/.test(orderId)) {
      sendJson(response, 400, { error: 'Webhook thiếu order.id hợp lệ' });
      return;
    }
    if (!isMonaPayPendingOrder(order)) {
      await store.markWebhook({ shop, orderId, webhookId, status: 'skipped' });
      sendJson(response, 200, { success: true, skipped: 'not_pending_monapay_order' });
      return;
    }
    const amount = Number(order.current_total_price ?? order.total_price);
    if (String(order.currency || '').toUpperCase() !== 'VND'
      || !Number.isInteger(amount)
      || amount < 1_000
      || amount > 1_000_000_000) {
      await store.markWebhook({ shop, orderId, webhookId, status: 'skipped' });
      sendJson(response, 200, { success: true, skipped: 'unsupported_currency_or_amount' });
      return;
    }
    const jobKey = `${shop}:${orderId}`;
    if (!orderJobs.has(jobKey)) {
      orderJobs.set(jobKey, createOrderCheckout(shop, order, webhookId).finally(() => orderJobs.delete(jobKey)));
    }
    const record = await orderJobs.get(jobKey);
    if (!await store.hasWebhook(shop, webhookId)) {
      await store.markWebhook({ shop, orderId, webhookId });
    }
    sendJson(response, 201, { success: true, orderId: record.orderId, checkoutId: record.checkoutId });
  }

  async function handleMonaWebhook(request, response) {
    const rawBody = await readRawBody(request);
    let untrusted;
    try {
      untrusted = JSON.parse(rawBody.toString('utf8'));
    } catch {
      sendJson(response, 400, { error: 'Webhook body không phải JSON' });
      return;
    }
    const order = await store.findOrderForMona(untrusted);
    if (!order) {
      sendJson(response, 404, { error: 'Không tìm thấy checkout tương ứng' });
      return;
    }
    const shopRecord = await store.getShop(order.shop);
    if (!shopRecord?.merchant?.webhookSecret) {
      sendJson(response, 401, { error: 'Shop chưa có webhook secret' });
      return;
    }
    const verified = verifyMonaWebhook(rawBody, request.headers, shopRecord.merchant.webhookSecret);
    if (!verified.ok) {
      sendJson(response, 401, { error: 'MONA Pay webhook không hợp lệ', reason: verified.reason });
      return;
    }
    const payload = verified.payload;
    const event = payload.event || payload.event_type;
    if (event !== 'CHECKOUT_PAID') {
      sendJson(response, 200, { success: true, skipped: 'unsupported_event' });
      return;
    }
    const transactionCode = String(payload.transaction_code || '').trim();
    const metadataShop = normalizeShop(payload.metadata?.shop);
    const metadataOrderId = String(payload.metadata?.order_id || '');
    const amount = Number(payload.amount);
    const paidAmount = Number(payload.paid_amount);
    if (!transactionCode
      || String(payload.checkout_id || '') !== order.checkoutId
      || String(payload.order_code || '') !== order.orderCode
      || metadataShop !== order.shop
      || metadataOrderId !== order.orderId
      || !Number.isInteger(amount)
      || amount !== order.amount
      || !Number.isInteger(paidAmount)
      || paidAmount < order.amount
      || payload.status !== 'paid') {
      sendJson(response, 409, { error: 'Dữ liệu checkout không khớp đơn Shopify' });
      return;
    }
    if (await store.hasTransaction(order.shop, transactionCode)) {
      sendJson(response, 200, { success: true, duplicate: true });
      return;
    }
    const jobKey = `${order.shop}:${transactionCode}`;
    if (!transactionJobs.has(jobKey)) {
      transactionJobs.set(jobKey, processPaidCheckout(order, payload).finally(() => transactionJobs.delete(jobKey)));
    }
    await transactionJobs.get(jobKey);
    sendJson(response, 200, { success: true });
  }

  async function handleShopifyLifecycle(request, response, expectedTopic, { eraseShop = false } = {}) {
    const rawBody = await readRawBody(request);
    if (!verifyWebhookHmac(rawBody, request.headers['x-shopify-hmac-sha256'], config.apiSecret)) {
      sendJson(response, 401, { error: 'Shopify webhook HMAC không hợp lệ' });
      return;
    }
    const shop = normalizeShop(request.headers['x-shopify-shop-domain']);
    if (request.headers['x-shopify-topic'] !== expectedTopic || !shop) {
      sendJson(response, 400, { error: 'Thiếu/sai Shopify topic hoặc shop' });
      return;
    }
    if (eraseShop) await store.deleteShop(shop);
    log('shopify_lifecycle_webhook', {
      topic: expectedTopic,
      shop,
      webhookId: String(request.headers['x-shopify-webhook-id'] || ''),
      erased: eraseShop,
    });
    sendJson(response, 200, { success: true });
  }

  function pruneStates() {
    const now = Date.now();
    for (const [state, entry] of oauthStates) if (entry.expiresAt <= now) oauthStates.delete(state);
  }

  const handler = async (request, response) => {
    const url = new URL(request.url, config.appUrl);

    if (url.pathname === '/healthz' && request.method === 'GET') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (url.pathname === '/' && request.method === 'GET') {
      const shop = normalizeShop(url.searchParams.get('shop'));
      if (!shop) {
        sendHtml(response, 200, '<!doctype html><html lang="vi"><meta charset="utf-8"><title>MONA Pay cho Shopify</title><body><main><h1>MONA Pay cho Shopify</h1><p>Mở ứng dụng từ Shopify Admin để tiếp tục.</p></main></body></html>');
        return;
      }
      const cookie = verifySignedShopCookie(parseCookies(request.headers.cookie)[SHOP_COOKIE_NAME], config.apiSecret);
      redirect(response, cookie?.shop === shop ? `/settings?shop=${encodeURIComponent(shop)}` : `/auth?shop=${encodeURIComponent(shop)}`);
      return;
    }

    if (url.pathname === '/auth' && request.method === 'GET') {
      const shop = normalizeShop(url.searchParams.get('shop'));
      if (!shop) {
        sendJson(response, 400, { error: 'shop phải là domain *.myshopify.com' });
        return;
      }
      pruneStates();
      const state = randomBytes(24).toString('hex');
      oauthStates.set(state, { shop, expiresAt: Date.now() + 600_000 });
      const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
      authorize.searchParams.set('client_id', config.apiKey);
      authorize.searchParams.set('scope', config.scopes);
      authorize.searchParams.set('redirect_uri', `${config.appUrl}/auth/callback`);
      authorize.searchParams.set('state', state);
      redirect(response, authorize.toString(), [
        `shopify_oauth_state=${state}; Path=/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      ]);
      return;
    }

    if (url.pathname === '/auth/callback' && request.method === 'GET') {
      const shop = normalizeShop(url.searchParams.get('shop'));
      const state = url.searchParams.get('state');
      const savedState = oauthStates.get(state);
      const cookieState = parseCookies(request.headers.cookie).shopify_oauth_state;
      if (!shop || !state || !savedState || savedState.expiresAt < Date.now()
        || savedState.shop !== shop || cookieState !== state) {
        sendJson(response, 401, { error: 'OAuth state không hợp lệ hoặc đã hết hạn' });
        return;
      }
      if (!verifyOAuthHmac(url.searchParams, config.apiSecret)) {
        sendJson(response, 401, { error: 'OAuth HMAC không hợp lệ' });
        return;
      }
      oauthStates.delete(state);
      const tokenResponse = await responseJson(fetch, `https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: config.apiKey,
          client_secret: config.apiSecret,
          code: url.searchParams.get('code'),
        }),
      }, config.outboundTimeoutMs);
      if (!tokenResponse?.access_token) throw new HttpError('Shopify không trả access_token', 502);
      await store.saveShop(shop, { accessToken: tokenResponse.access_token, scope: tokenResponse.scope });
      try {
        const ids = await registerShopifyWebhooks(shop, tokenResponse.access_token);
        await store.saveShop(shop, { shopifyWebhookIds: ids, shopifyWebhookRegistrationError: null });
      } catch (error) {
        await store.saveShop(shop, { shopifyWebhookRegistrationError: error.message });
        log('shopify_webhook_registration_failed', { shop, message: error.message });
      }
      const shopCookie = createSignedShopCookie(shop, config.apiSecret, { ttlSec: SHOP_COOKIE_TTL });
      redirect(response, `/settings?shop=${encodeURIComponent(shop)}`, [
        'shopify_oauth_state=; Path=/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
        `${SHOP_COOKIE_NAME}=${shopCookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SHOP_COOKIE_TTL}`,
      ]);
      return;
    }

    if (url.pathname === '/settings' && request.method === 'GET') {
      const shop = normalizeShop(url.searchParams.get('shop'));
      if (!shop) throw new HttpError('shop không hợp lệ', 400);
      const auth = authenticateSettings(request, shop);
      await renderSettings(response, shop, auth);
      return;
    }

    if (['/settings/test', '/settings/save'].includes(url.pathname) && request.method === 'POST') {
      const shop = normalizeShop(url.searchParams.get('shop'));
      if (!shop) throw new HttpError('shop không hợp lệ', 400);
      const auth = authenticateSettings(request, shop);
      const form = await readForm(request);
      verifySettingsCsrf(auth, form);
      const record = await store.getShop(shop);
      if (!record?.accessToken) throw new HttpError('Shop chưa cài ứng dụng', 403);
      let merchant;
      try {
        merchant = await settingsCredentials(form, record.merchant);
        if (url.pathname === '/settings/test') {
          const me = await monaClient(merchant).me();
          await renderSettings(response, shop, auth, {
            merchant: { ...merchant, clientSecret: merchant.clientSecret },
            message: `Kết nối thành công${me?.name ? `: ${me.name}` : ''}. Chưa lưu thay đổi.`,
          });
          return;
        }
        await saveMonaSettings(shop, record, merchant);
        await renderSettings(response, shop, auth, { message: 'Đã lưu cấu hình và đăng ký webhook MONA Pay.' });
      } catch (error) {
        await renderSettings(response, shop, auth, {
          status: error.status && error.status < 500 ? error.status : 502,
          merchant: merchant || { clientId: form.get('client_id'), sandbox: form.get('sandbox') === 'on' },
          error: error.message,
        });
      }
      return;
    }

    if (url.pathname === '/webhooks/orders-create' && request.method === 'POST') {
      await handleOrdersCreate(request, response);
      return;
    }
    if (url.pathname === '/webhooks/monapay' && request.method === 'POST') {
      await handleMonaWebhook(request, response);
      return;
    }
    if (url.pathname === '/webhooks/app-uninstalled' && request.method === 'POST') {
      await handleShopifyLifecycle(request, response, 'app/uninstalled', { eraseShop: true });
      return;
    }
    if (url.pathname === '/webhooks/customers-data-request' && request.method === 'POST') {
      await handleShopifyLifecycle(request, response, 'customers/data_request');
      return;
    }
    if (url.pathname === '/webhooks/customers-redact' && request.method === 'POST') {
      await handleShopifyLifecycle(request, response, 'customers/redact');
      return;
    }
    if (url.pathname === '/webhooks/shop-redact' && request.method === 'POST') {
      await handleShopifyLifecycle(request, response, 'shop/redact', { eraseShop: true });
      return;
    }

    if (url.pathname.startsWith('/api/pay-link/') && ['GET', 'OPTIONS'].includes(request.method)) {
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type',
      };
      if (request.method === 'OPTIONS') {
        response.writeHead(204, cors);
        response.end();
        return;
      }
      let session;
      try {
        session = verifySessionToken(bearerToken(request.headers.authorization), {
          apiKey: config.apiKey,
          secret: config.apiSecret,
        });
      } catch (error) {
        sendJson(response, 401, { error: error.message }, cors);
        return;
      }
      const orderId = orderIdFromPath(url.pathname.slice('/api/pay-link/'.length));
      if (!orderId) {
        sendJson(response, 400, { error: 'orderId không hợp lệ' }, cors);
        return;
      }
      const record = await store.getOrder(session.shop, orderId);
      if (!record) {
        sendJson(response, 404, { error: 'Link thanh toán chưa sẵn sàng' }, cors);
        return;
      }
      sendJson(response, 200, {
        checkout_url: record.checkoutUrl,
        qr_image_url: record.qrImageUrl,
        qr_data_url: record.qrDataUrl,
        amount: record.amount,
        currency: record.currency,
        order_code: record.orderCode,
        status: record.status,
        expires_at: record.expiresAt,
      }, cors);
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  };

  const server = http.createServer((request, response) => {
    handler(request, response).catch((error) => {
      if (!error.shopifyRequestLogged) logShopifyRequestFailed(error);
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      sendJson(response, status, { error: status < 500 ? error.message : 'Internal server error' });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return { server, config, store, handler };
}

export function start(options = {}) {
  const { server, config } = createShopifyApp(options);
  server.listen(config.port, config.host, () => {
    process.stdout.write(`${JSON.stringify({ level: 'info', event: 'shopify_app_started', host: config.host, port: config.port })}\n`);
  });
  return server;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    start();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'shopify_app_startup_failed', message: error.message })}\n`);
    process.exitCode = 1;
  }
}
