import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  normalizeShop,
  verifyOAuthHmac,
  verifySessionToken,
  verifyWebhookHmac,
} from '../shopify.js';

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

test('normalizeShop chỉ nhận myshopify domain an toàn', () => {
  assert.equal(normalizeShop('Demo-Shop.myshopify.com'), 'demo-shop.myshopify.com');
  assert.equal(normalizeShop('demo.myshopify.com.evil.test'), null);
  assert.equal(normalizeShop('https://demo.myshopify.com'), null);
});

test('verify OAuth và webhook HMAC Shopify', () => {
  const secret = 'shopify-secret';
  const params = new URLSearchParams({ code: 'abc', shop: 'demo.myshopify.com', state: 'xyz', timestamp: '1' });
  const message = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&');
  params.set('hmac', createHmac('sha256', secret).update(message).digest('hex'));
  assert.equal(verifyOAuthHmac(params, secret), true);

  const raw = Buffer.from('{"id":123}');
  const hmac = createHmac('sha256', secret).update(raw).digest('base64');
  assert.equal(verifyWebhookHmac(raw, hmac, secret), true);
  assert.equal(verifyWebhookHmac(raw, 'bad', secret), false);
});

test('verify Shopify session token HS256, audience và dest', () => {
  const secret = 'shopify-secret';
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({
    aud: 'api-key',
    dest: 'https://demo.myshopify.com/admin',
    exp: 2_000_000_000,
    nbf: 1_000_000_000,
  });
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  const result = verifySessionToken(`${header}.${payload}.${signature}`, {
    apiKey: 'api-key',
    secret,
    now: () => 1_900_000_000,
  });

  assert.equal(result.shop, 'demo.myshopify.com');
});
