'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { verifyMonaSignature } = require('./hmac');

const MAX_BODY = 1024 * 1024;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function ghostToken(adminKey) {
  const [id, secretHex, ...rest] = adminKey.split(':');
  if (!id || !/^[a-f0-9]+$/i.test(secretHex || '') || rest.length) throw new Error('GHOST_ADMIN_API_KEY must be id:hexsecret');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id }));
  const payload = base64url(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' }));
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', Buffer.from(secretHex, 'hex')).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

async function ghostRequest(origin, adminKey, route, options = {}) {
  const response = await fetch(`${origin.replace(/\/$/, '')}/ghost/api/admin${route}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Accept-Version': 'v5.0',
      Authorization: `Ghost ${ghostToken(adminKey)}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Ghost Admin API ${response.status}: ${body.errors?.[0]?.message || 'request failed'}`);
  return body;
}

function paymentReference(description) {
  const match = String(description || '').match(/(?:^|\s)MEMBER[\s_:#-]+([A-Za-z0-9_-]{1,100})(?:\s|$)/i);
  return match ? match[1] : null;
}

function sendJson(response, status, success, message) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ success, message, data: null }));
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function createHandler(config) {
  return async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/webhooks/monapay') {
      sendJson(response, 404, false, 'Not found.');
      return;
    }
    try {
      const raw = await readBody(request);
      const timestamp = String(request.headers['x-mona-timestamp'] || '');
      const signature = String(request.headers['x-mona-signature'] || '');
      if (!verifyMonaSignature(raw, timestamp, signature, config.webhookSecret)) {
        sendJson(response, 401, false, 'Chữ ký không hợp lệ.');
        return;
      }
      const payload = JSON.parse(raw.toString('utf8'));
      if (!payload || typeof payload !== 'object' || !payload.transaction_code || !payload.description || !Number.isFinite(Number(payload.amount)) || (payload.type || 'income') !== 'income') {
        sendJson(response, 400, false, 'Payload không hợp lệ.');
        return;
      }
      if (payload.transaction_code === 'DUMMY123') {
        sendJson(response, 200, true, 'Webhook thử hợp lệ.');
        return;
      }
      const state = loadJson(config.stateFile, { transactionCodes: {} });
      if (state.transactionCodes[payload.transaction_code]) {
        sendJson(response, 200, true, 'Giao dịch đã được xử lý.');
        return;
      }
      const reference = paymentReference(payload.description);
      const memberMap = loadJson(config.memberMapFile, {});
      const mapping = reference && memberMap[reference];
      const memberId = mapping && typeof mapping === 'object' ? mapping.memberId : '';
      const expectedAmount = mapping && typeof mapping === 'object' ? Number(mapping.expectedAmount) : NaN;
      if (!memberId || !Number.isFinite(expectedAmount) || expectedAmount < 0) {
        sendJson(response, 422, false, 'Không có member mapping hợp lệ.');
        return;
      }
      if (Number(payload.amount) < expectedAmount) {
        sendJson(response, 422, false, 'Số tiền chưa đủ.');
        return;
      }
      const current = await ghostRequest(config.ghostUrl, config.adminKey, `/members/${encodeURIComponent(memberId)}/?include=labels`);
      const member = current.members?.[0];
      if (!member) throw new Error('Ghost did not return the mapped member.');
      const labels = Array.isArray(member.labels) ? member.labels.map(({ name, slug }) => ({ ...(name ? { name } : {}), ...(slug ? { slug } : {}) })) : [];
      if (!labels.some((label) => label.name === config.paidLabel || label.slug === config.paidLabel)) labels.push({ name: config.paidLabel });
      await ghostRequest(config.ghostUrl, config.adminKey, `/members/${encodeURIComponent(memberId)}/`, {
        method: 'PUT',
        body: JSON.stringify({ members: [{ id: memberId, labels }] }),
      });
      state.transactionCodes[payload.transaction_code] = { memberId, receivedAt: new Date().toISOString() };
      saveJson(config.stateFile, state);
      sendJson(response, 200, true, 'Đã gắn nhãn member đã thanh toán.');
    } catch (error) {
      sendJson(response, error.status || 500, false, error.message === 'Unexpected end of JSON input' ? 'JSON không hợp lệ.' : 'Webhook xử lý thất bại.');
    }
  };
}

function configFromEnv() {
  return {
    webhookSecret: required('MONAPAY_WEBHOOK_SECRET'),
    ghostUrl: required('GHOST_URL'),
    adminKey: required('GHOST_ADMIN_API_KEY'),
    memberMapFile: path.resolve(process.env.GHOST_MEMBER_MAP_FILE || './members.json'),
    stateFile: path.resolve(process.env.MONAPAY_STATE_FILE || './data/processed.json'),
    paidLabel: String(process.env.GHOST_PAID_LABEL || 'MONA Pay paid').trim(),
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const server = http.createServer(createHandler(configFromEnv()));
  server.listen(port, '127.0.0.1', () => process.stdout.write(`ghost-monapay listening on 127.0.0.1:${port}\n`));
}

module.exports = { createHandler, ghostToken, paymentReference };
