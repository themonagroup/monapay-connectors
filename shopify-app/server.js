import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MonaPay } from '../../sdk/node/dist/index.js';
import { fetchJson, required, safeBaseUrl } from '../core/http.js';
import { JsonStore } from './store.js';
import {
  normalizeShop,
  parseCookies,
  verifyOAuthHmac,
  verifySessionToken,
  verifyWebhookHmac,
} from './shopify.js';

const APP_DIR = dirname(fileURLToPath(import.meta.url));

function integer(value, key, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${key} không hợp lệ`);
  return parsed;
}

export function loadConfig(env = process.env) {
  const appUrl = safeBaseUrl(required(env, 'SHOPIFY_APP_URL'), 'SHOPIFY_APP_URL');
  const apiVersion = required(env, 'SHOPIFY_API_VERSION');
  if (!/^\d{4}-\d{2}$/.test(apiVersion)) throw new Error('SHOPIFY_API_VERSION phải có dạng YYYY-MM');
  const ownerType = required(env, 'MONA_OWNER_TYPE');
  if (!['PER', 'ORG'].includes(ownerType)) throw new Error('MONA_OWNER_TYPE phải là PER hoặc ORG');
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && env.ALLOW_PUBLIC_BIND !== 'true') {
    throw new Error('Từ chối bind public; dùng HOST=127.0.0.1 sau Nginx');
  }
  return {
    host,
    port: integer(env.PORT || 8790, 'PORT', { max: 65_535 }),
    appUrl,
    apiKey: required(env, 'SHOPIFY_API_KEY'),
    apiSecret: required(env, 'SHOPIFY_API_SECRET'),
    apiVersion,
    scopes: env.SHOPIFY_SCOPES || 'read_orders,write_orders',
    dataFile: resolve(env.SHOPIFY_DATA_FILE || `${APP_DIR}/data/store.json`),
    mona: {
      baseUrl: env.MONA_BASE_URL,
      username: required(env, 'MONA_USERNAME'),
      password: required(env, 'MONA_PASSWORD'),
      clientSecret: required(env, 'MONA_CLIENT_SECRET'),
      ownerNumber: required(env, 'MONA_OWNER_NUMBER'),
      ownerType,
      merchantId: required(env, 'MONA_MERCHANT_ID'),
      terminalId: required(env, 'MONA_TERMINAL_ID'),
      virtualAccountPrefix: required(env, 'MONA_VA_PREFIX'),
      beneficiaryName: required(env, 'MONA_BENEFICIARY_NAME'),
      timeoutMs: integer(env.MONA_TIMEOUT_MS || 2_000, 'MONA_TIMEOUT_MS', { max: 2_200 }),
    },
  };
}

function sendJson(response, status, body, extraHeaders = {}) {
  const content = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(content);
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  });
  response.end(html);
}

async function readRawBody(request, limit = 1_048_576) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body quá lớn');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function bearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  return match?.[1];
}

function publicQr(qr) {
  return {
    qr_data_url: qr?.qr_data_url,
    qr_code: qr?.qr_code,
    amount: qr?.amount,
    description: qr?.description,
  };
}

export function createShopifyApp({ env = process.env, fetch = globalThis.fetch } = {}) {
  const config = loadConfig(env);
  const store = new JsonStore(config.dataFile);
  const monaFetch = async (url, init = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.mona.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };
  const mona = new MonaPay({
    baseUrl: config.mona.baseUrl,
    username: config.mona.username,
    password: config.mona.password,
    clientSecret: config.mona.clientSecret,
    fetch: monaFetch,
  });
  const oauthStates = new Map();
  const orderJobs = new Map();

  function pruneStates() {
    const now = Date.now();
    for (const [state, entry] of oauthStates) if (entry.expiresAt <= now) oauthStates.delete(state);
  }

  async function createOrderQr(shop, order, webhookId) {
    const orderId = String(order.id || '').trim();
    if (!orderId) throw new Error('Shopify webhook thiếu order.id');
    const existing = await store.getOrder(shop, orderId);
    if (existing) {
      return store.saveQrFromWebhook({ shop, orderId, webhookId, record: existing });
    }
    if (String(order.currency || '').toUpperCase() !== 'VND') throw new Error('Scaffold chỉ tạo VietQR cho đơn VND');
    const amount = Number(order.current_total_price ?? order.total_price);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) {
      throw new Error('Tổng tiền Shopify phải là số nguyên VND từ 1 đến 1.000.000.000');
    }
    const description = `MONA SHOPIFY ${orderId}`;
    const qr = await mona.qr.generate({
      ownerNumber: config.mona.ownerNumber,
      ownerType: config.mona.ownerType,
      merchantId: config.mona.merchantId,
      terminalId: config.mona.terminalId,
      orderId,
      virtualAccountPrefix: config.mona.virtualAccountPrefix,
      beneficiaryName: config.mona.beneficiaryName,
      amount,
      description,
    });
    return store.saveQrFromWebhook({
      shop,
      orderId,
      webhookId,
      record: {
        shop,
        orderId,
        orderName: order.name,
        amount,
        description,
        qr,
        createdAt: new Date().toISOString(),
      },
    });
  }

  const handler = async (request, response) => {
    const url = new URL(request.url, config.appUrl);

    if (url.pathname === '/healthz' && request.method === 'GET') {
      sendJson(response, 200, { status: 'ok' });
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
      const callback = `${config.appUrl}/auth/callback`;
      const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
      authorize.searchParams.set('client_id', config.apiKey);
      authorize.searchParams.set('scope', config.scopes);
      authorize.searchParams.set('redirect_uri', callback);
      authorize.searchParams.set('state', state);
      response.writeHead(302, {
        location: authorize.toString(),
        'set-cookie': `shopify_oauth_state=${state}; Path=/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        'cache-control': 'no-store',
      });
      response.end();
      return;
    }

    if (url.pathname === '/auth/callback' && request.method === 'GET') {
      const shop = normalizeShop(url.searchParams.get('shop'));
      const state = url.searchParams.get('state');
      const savedState = oauthStates.get(state);
      const cookieState = parseCookies(request.headers.cookie).shopify_oauth_state;
      if (!shop || !state || !savedState || savedState.expiresAt < Date.now() || savedState.shop !== shop || cookieState !== state) {
        sendJson(response, 401, { error: 'OAuth state không hợp lệ hoặc đã hết hạn' });
        return;
      }
      if (!verifyOAuthHmac(url.searchParams, config.apiSecret)) {
        sendJson(response, 401, { error: 'OAuth HMAC không hợp lệ' });
        return;
      }
      oauthStates.delete(state);
      const token = await fetchJson(`https://${shop}/admin/oauth/access_token`, {
        fetchImpl: fetch,
        timeoutMs: 5_000,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: config.apiKey,
          client_secret: config.apiSecret,
          code: url.searchParams.get('code'),
        }),
      });
      if (!token?.access_token) throw new Error('Shopify không trả access_token');
      await store.saveShop(shop, {
        accessToken: token.access_token,
        scope: token.scope,
      });
      sendHtml(response, 200, '<!doctype html><html lang="vi"><meta charset="utf-8"><title>MONA Pay</title><body><h1>Đã cài MONA Pay</h1><p>Tiếp theo hãy đăng ký webhook <code>orders/create</code> theo README.</p></body></html>');
      return;
    }

    if (url.pathname === '/webhooks/orders-create' && request.method === 'POST') {
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
      if (!await store.getShop(shop)) {
        sendJson(response, 403, { error: 'Shop chưa cài app hoặc token không còn trong store' });
        return;
      }
      if (await store.hasWebhook(webhookId)) {
        sendJson(response, 200, { success: true, duplicate: true });
        return;
      }
      const order = JSON.parse(rawBody.toString('utf8'));
      const jobKey = `${shop}:${order.id}`;
      if (!orderJobs.has(jobKey)) {
        const job = createOrderQr(shop, order, webhookId).finally(() => orderJobs.delete(jobKey));
        orderJobs.set(jobKey, job);
      }
      const record = await orderJobs.get(jobKey);
      sendJson(response, 201, { success: true, orderId: record.orderId });
      return;
    }

    if (url.pathname.startsWith('/api/qr/') && ['GET', 'OPTIONS'].includes(request.method)) {
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
      const rawOrderId = decodeURIComponent(url.pathname.slice('/api/qr/'.length));
      const orderId = rawOrderId.replace(/^gid:\/\/shopify\/Order\//, '');
      const record = await store.getOrder(session.shop, orderId);
      if (!record) {
        sendJson(response, 404, { error: 'QR chưa sẵn sàng' }, cors);
        return;
      }
      sendJson(response, 200, publicQr(record.qr), cors);
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  };

  const server = http.createServer((request, response) => {
    handler(request, response).catch((error) => {
      process.stderr.write(`${JSON.stringify({ level: 'error', event: 'shopify_request_failed', message: error.message })}\n`);
      if (!response.headersSent) sendJson(response, error.status || 500, { error: 'Internal server error' });
      else response.end();
    });
  });
  return { server, config, store };
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
