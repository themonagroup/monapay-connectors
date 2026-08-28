import { compileOrderIdRegex } from './mapping.js';

const PLATFORMS = new Set(['shopify', 'haravan', 'sapo', 'kiotviet', 'nhanh', 'pancake', 'woocommerce']);

function integer(env, key, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} phải là số nguyên từ ${min} đến ${max}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const platform = String(env.CONNECTOR_PLATFORM ?? '').toLowerCase();
  if (!PLATFORMS.has(platform)) {
    throw new Error(`CONNECTOR_PLATFORM phải là một trong: ${[...PLATFORMS].join(', ')}`);
  }
  if (!env.MONA_WEBHOOK_SECRET) throw new Error('Thiếu biến môi trường MONA_WEBHOOK_SECRET');

  const host = env.HOST || '127.0.0.1';
  const loopback = new Set(['127.0.0.1', '::1', 'localhost']);
  if (!loopback.has(host) && env.ALLOW_PUBLIC_BIND !== 'true') {
    throw new Error('Từ chối bind public; dùng HOST=127.0.0.1 hoặc đặt ALLOW_PUBLIC_BIND=true sau khi tự đánh giá rủi ro');
  }

  return {
    platform,
    secret: env.MONA_WEBHOOK_SECRET,
    host,
    port: integer(env, 'PORT', 8787, { max: 65_535 }),
    bodyLimitBytes: integer(env, 'BODY_LIMIT_BYTES', 1_048_576),
    timeoutMs: integer(env, 'PLATFORM_TIMEOUT_MS', 2_000, { max: 2_500 }),
    retryDelayMs: integer(env, 'RETRY_DELAY_MS', 250, { min: 0, max: 500 }),
    idempotencyTtlMs: integer(env, 'IDEMPOTENCY_TTL_MS', 86_400_000),
    idempotencyMaxEntries: integer(env, 'IDEMPOTENCY_MAX_ENTRIES', 10_000),
    orderIdPattern: compileOrderIdRegex(env.ORDER_ID_REGEX),
  };
}
