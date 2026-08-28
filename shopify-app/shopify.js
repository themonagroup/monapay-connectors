import { createHmac, timingSafeEqual } from 'node:crypto';

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizeShop(value) {
  const shop = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) return null;
  return shop;
}

export function verifyOAuthHmac(searchParams, secret) {
  const received = searchParams.get('hmac');
  if (!received || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const message = [...searchParams.entries()]
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const expected = createHmac('sha256', secret).update(message).digest('hex');
  return safeEqual(received, expected);
}

export function verifyWebhookHmac(rawBody, received, secret) {
  if (!received) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeEqual(received, expected);
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url');
}

export function verifySessionToken(token, { apiKey, secret, now = () => Math.floor(Date.now() / 1_000) }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Shopify session token không hợp lệ');
  let header;
  let payload;
  try {
    header = JSON.parse(decodeBase64Url(parts[0]).toString('utf8'));
    payload = JSON.parse(decodeBase64Url(parts[1]).toString('utf8'));
  } catch {
    throw new Error('Shopify session token không đọc được');
  }
  if (header.alg !== 'HS256') throw new Error('Shopify session token phải dùng HS256');
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const received = decodeBase64Url(parts[2]);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new Error('Chữ ký Shopify session token không hợp lệ');
  }
  const currentTime = now();
  if (!Number.isFinite(payload.exp) || payload.exp < currentTime) throw new Error('Shopify session token đã hết hạn');
  if (payload.nbf && payload.nbf > currentTime + 5) throw new Error('Shopify session token chưa có hiệu lực');
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(apiKey)) throw new Error('Shopify session token sai audience');
  let shop;
  try {
    shop = normalizeShop(new URL(payload.dest).hostname);
  } catch {
    shop = null;
  }
  if (!shop) throw new Error('Shopify session token thiếu dest hợp lệ');
  return { ...payload, shop };
}

export function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return [part.trim(), ''];
    const rawValue = part.slice(index + 1).trim();
    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      // Cookie malformed: giữ raw value để request bị từ chối bởi bước so sánh state.
    }
    return [part.slice(0, index).trim(), value];
  }).filter(([key]) => key));
}
