import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyMonaWebhook } from '../monapay.js';
import {
  createSignedShopCookie,
  normalizeShop,
  verifyOAuthHmac,
  verifySessionToken,
  verifySignedShopCookie,
  verifyWebhookHmac,
} from '../shopify.js';
import { JsonStore, SecretBox } from '../store.js';

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

test('HMAC Shopify xác thực OAuth, webhook raw body và session token', () => {
  const secret = 'shopify-secret';
  const params = new URLSearchParams({ code: 'abc', shop: 'demo.myshopify.com', state: 'xyz', timestamp: '1' });
  const message = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&');
  params.set('hmac', createHmac('sha256', secret).update(message).digest('hex'));
  assert.equal(verifyOAuthHmac(params, secret), true);

  const raw = Buffer.from('{"id":123}');
  const hmac = createHmac('sha256', secret).update(raw).digest('base64');
  assert.equal(verifyWebhookHmac(raw, hmac, secret), true);
  assert.equal(verifyWebhookHmac(Buffer.from('{"id":124}'), hmac, secret), false);

  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({ aud: 'api-key', dest: 'https://demo.myshopify.com/admin', exp: 2_000_000_000 });
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  const session = verifySessionToken(`${header}.${payload}.${signature}`, {
    apiKey: 'api-key', secret, now: () => 1_900_000_000,
  });
  assert.equal(session.shop, 'demo.myshopify.com');
});

test('HMAC MONA Pay xác thực timestamp.raw_body và chặn timestamp cũ', () => {
  const raw = Buffer.from('{"event":"CHECKOUT_PAID"}');
  const timestamp = '1900000000';
  const secret = 'mona-webhook-secret';
  const signature = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  const valid = verifyMonaWebhook(raw, {
    'x-mona-timestamp': timestamp,
    'x-mona-signature': `sha256=${signature}`,
  }, secret, { now: () => 1_900_000_100 });
  assert.equal(valid.ok, true);
  assert.equal(valid.payload.event, 'CHECKOUT_PAID');

  assert.deepEqual(verifyMonaWebhook(raw, {
    'x-mona-timestamp': timestamp,
    'x-mona-signature': signature,
  }, secret, { now: () => 1_900_000_301 }), { ok: false, reason: 'timestamp_out_of_tolerance' });
});

test('cookie shop ký HMAC bị từ chối khi giả mạo', () => {
  assert.equal(normalizeShop('Demo-Shop.myshopify.com'), 'demo-shop.myshopify.com');
  const cookie = createSignedShopCookie('demo-shop.myshopify.com', 'secret', { now: () => 100, ttlSec: 60 });
  assert.equal(verifySignedShopCookie(cookie, 'secret', { now: () => 120 }).shop, 'demo-shop.myshopify.com');
  assert.equal(verifySignedShopCookie(`${cookie}x`, 'secret', { now: () => 120 }), null);
});

test('AES-256-GCM round-trip và store không ghi plaintext secret', async () => {
  const key = 'a'.repeat(48);
  const box = new SecretBox(key);
  const encrypted = box.encrypt('shpat_secret');
  assert.notEqual(encrypted, 'shpat_secret');
  assert.equal(box.decrypt(encrypted), 'shpat_secret');

  const directory = await mkdtemp(join(tmpdir(), 'monapay-store-'));
  const store = new JsonStore(directory, { secretKey: key });
  await store.saveShop('demo.myshopify.com', {
    accessToken: 'shpat_secret',
    merchant: {
      clientId: 'client-public',
      clientSecret: 'mona_client_secret',
      webhookSecret: 'mona_webhook_secret',
    },
  });
  const loaded = await store.getShop('demo.myshopify.com');
  assert.equal(loaded.accessToken, 'shpat_secret');
  assert.equal(loaded.merchant.clientSecret, 'mona_client_secret');
  assert.equal(loaded.merchant.webhookSecret, 'mona_webhook_secret');
  const disk = await readFile(join(directory, 'store.json'), 'utf8');
  assert.doesNotMatch(disk, /shpat_secret|mona_client_secret|mona_webhook_secret/);
});
