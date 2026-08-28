'use strict';

const http = require('node:http');
const { verifyMonaSignature } = require('./hmac');

const MAX_BODY = 1024 * 1024;

function configFromEnv() {
  const config = {
    secret: String(process.env.MONAPAY_WEBHOOK_SECRET || '').trim(),
    bubbleUrl: String(process.env.BUBBLE_WORKFLOW_URL || '').trim(),
    bubbleToken: String(process.env.BUBBLE_SHARED_TOKEN || '').trim(),
  };
  if (!config.secret || !config.bubbleUrl || !config.bubbleToken) throw new Error('MONAPAY_WEBHOOK_SECRET, BUBBLE_WORKFLOW_URL and BUBBLE_SHARED_TOKEN are required.');
  const url = new URL(config.bubbleUrl);
  if (url.protocol !== 'https:') throw new Error('BUBBLE_WORKFLOW_URL must use HTTPS.');
  return config;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function respond(response, status, success, message) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ success, message, data: null }));
}

function createHandler(config) {
  return async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/webhooks/monapay') {
      respond(response, 404, false, 'Not found.');
      return;
    }
    try {
      const raw = await readBody(request);
      if (!verifyMonaSignature(raw, String(request.headers['x-mona-timestamp'] || ''), String(request.headers['x-mona-signature'] || ''), config.secret)) {
        respond(response, 401, false, 'Chữ ký không hợp lệ.');
        return;
      }
      const payload = JSON.parse(raw.toString('utf8'));
      if (!payload || typeof payload !== 'object' || !payload.transaction_code || !payload.description || !payload.account_number || !Number.isFinite(Number(payload.amount)) || (payload.type || 'income') !== 'income') {
        respond(response, 400, false, 'Payload không hợp lệ.');
        return;
      }
      if (payload.transaction_code === 'DUMMY123') {
        respond(response, 200, true, 'Webhook thử hợp lệ.');
        return;
      }
      const upstream = await fetch(config.bubbleUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Mona-Proxy-Token': config.bubbleToken },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      });
      if (![200, 201, 202].includes(upstream.status)) throw new Error(`Bubble workflow returned HTTP ${upstream.status}`);
      respond(response, 200, true, 'Đã chuyển webhook hợp lệ tới Bubble.');
    } catch (error) {
      respond(response, error.status || 502, false, error instanceof SyntaxError ? 'JSON không hợp lệ.' : 'Không thể chuyển webhook.');
    }
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8788);
  const server = http.createServer(createHandler(configFromEnv()));
  server.listen(port, '127.0.0.1', () => process.stdout.write(`bubble-monapay proxy listening on 127.0.0.1:${port}\n`));
}

module.exports = { createHandler };
