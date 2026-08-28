import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { mapOrderId } from '../mapping.js';
import { createWebhookProcessor } from '../processor.js';
import { createRequestHandler } from '../server.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function sign(rawBody, secret, timestamp) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

function request(rawBody, secret = 'connector-test-secret') {
  const timestamp = Math.floor(Date.now() / 1_000);
  return {
    rawBody,
    headers: {
      'x-mona-timestamp': String(timestamp),
      'x-mona-signature': sign(rawBody, secret, timestamp),
    },
  };
}

test('mapping ưu tiên orderId và đọc description mặc định/custom', () => {
  assert.equal(mapOrderId({ orderId: 123 }), '123');
  assert.equal(mapOrderId({ description: 'Thanh toan MONA SHOPIFY 98765' }), '98765');
  assert.equal(mapOrderId({ description: 'CK cho DH10234' }), 'DH10234');
  assert.equal(mapOrderId(
    { description: 'INV #AB-12' },
    { pattern: /INV\s+#(?<orderId>[A-Z]+-\d+)/iu },
  ), 'AB-12');
  assert.equal(mapOrderId({ description: 'khong co ma don' }), null);
});

test('processor verify HMAC, map order và gọi adapter mock', async () => {
  const calls = [];
  const processor = createWebhookProcessor({
    secret: 'connector-test-secret',
    adapter: { markOrderPaid: async (input) => calls.push(input) },
    logger,
    sleep: async () => {},
  });
  const rawBody = JSON.stringify({
    amount: 2500000,
    description: 'MONA SHOPIFY 12345',
    transaction_code: 'FT-VERIFY-1',
    type: 'income',
  });
  const result = await processor(request(rawBody));

  assert.equal(result.status, 200);
  assert.equal(result.body.orderId, '12345');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].orderId, '12345');
  assert.equal(calls[0].payment.amount, 2500000);
});

test('processor retry đúng tối đa 3 attempt rồi thành công', async () => {
  let attempts = 0;
  const processor = createWebhookProcessor({
    secret: 'connector-test-secret',
    adapter: {
      async markOrderPaid() {
        attempts += 1;
        if (attempts < 3) throw new Error('temporary');
      },
    },
    logger,
    sleep: async () => {},
  });
  const rawBody = JSON.stringify({
    amount: 100000,
    orderId: 'ORDER-3',
    transaction_code: 'FT-RETRY-3',
    type: 'income',
  });
  const result = await processor(request(rawBody));

  assert.equal(result.status, 200);
  assert.equal(attempts, 3);
});

test('processor từ chối chữ ký sai và không gọi adapter', async () => {
  let calls = 0;
  const processor = createWebhookProcessor({
    secret: 'connector-test-secret',
    adapter: { markOrderPaid: async () => { calls += 1; } },
    logger,
  });
  const result = await processor({
    rawBody: '{}',
    headers: {
      'x-mona-timestamp': String(Math.floor(Date.now() / 1_000)),
      'x-mona-signature': `sha256=${'0'.repeat(64)}`,
    },
  });

  assert.equal(result.status, 401);
  assert.equal(calls, 0);
});

test('processor chống xử lý trùng transaction_code', async () => {
  let calls = 0;
  const processor = createWebhookProcessor({
    secret: 'connector-test-secret',
    adapter: { markOrderPaid: async () => { calls += 1; } },
    logger,
  });
  const rawBody = JSON.stringify({
    amount: 90000,
    orderId: '123',
    transaction_code: 'FT-DUPLICATE',
    type: 'income',
  });
  assert.equal((await processor(request(rawBody))).status, 200);
  const duplicate = await processor(request(rawBody));

  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(calls, 1);
});

test('processor không đánh dấu paid cho giao dịch không phải income', async () => {
  let calls = 0;
  const processor = createWebhookProcessor({
    secret: 'connector-test-secret',
    adapter: { markOrderPaid: async () => { calls += 1; } },
    logger,
  });
  const rawBody = JSON.stringify({
    amount: 50000,
    orderId: '123',
    transaction_code: 'FT-OUT',
    type: 'outcome',
  });
  const result = await processor(request(rawBody));

  assert.equal(result.status, 202);
  assert.equal(calls, 0);
});

test('healthcheck trả 200 mà không gọi processor', async () => {
  let processorCalls = 0;
  const handler = createRequestHandler({
    processor: async () => { processorCalls += 1; },
  });
  const result = {};
  await handler(
    { method: 'GET', url: '/healthz' },
    {
      writeHead(status, headers) {
        result.status = status;
        result.headers = headers;
      },
      end(body) {
        result.body = body;
      },
    },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { status: 'ok' });
  assert.equal(processorCalls, 0);
});
