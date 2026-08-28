'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');

function verifyMonaSignature(rawBody, timestamp, signature, secret, now = Math.floor(Date.now() / 1000)) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  if (!secret || !/^[0-9]{1,12}$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(now - Number(timestamp)) > 300) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex')}`;
  return timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(signature, 'ascii'));
}

module.exports = { verifyMonaSignature };
