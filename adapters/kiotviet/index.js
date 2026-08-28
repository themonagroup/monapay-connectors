import { fetchJson, PlatformApiError, required, safeBaseUrl } from '../../core/http.js';

function invoiceId(value) {
  if (!/^\d+$/.test(String(value))) throw new Error('KiotViet invoiceId phải là số');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('KiotViet invoiceId vượt giới hạn số an toàn của Node.js');
  return parsed;
}

export function createAdapter({ env = process.env, fetch = globalThis.fetch, timeoutMs } = {}) {
  const clientId = required(env, 'KIOTVIET_CLIENT_ID');
  const clientSecret = required(env, 'KIOTVIET_CLIENT_SECRET');
  const retailer = required(env, 'KIOTVIET_RETAILER');
  const accountId = Number(required(env, 'KIOTVIET_ACCOUNT_ID'));
  if (!Number.isSafeInteger(accountId)) throw new Error('KIOTVIET_ACCOUNT_ID phải là số nguyên');
  const tokenUrl = safeBaseUrl(env.KIOTVIET_TOKEN_URL || 'https://id.kiotviet.vn/connect/token', 'KIOTVIET_TOKEN_URL');
  const apiBaseUrl = safeBaseUrl(env.KIOTVIET_API_BASE_URL || 'https://public.kiotapi.com', 'KIOTVIET_API_BASE_URL');
  let cachedToken;
  let tokenExpiresAt = 0;

  async function accessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken;
    const form = new URLSearchParams({
      scopes: 'PublicApi.Access',
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    const body = await fetchJson(tokenUrl, {
      fetchImpl: fetch,
      timeoutMs: Math.min(timeoutMs || 2_000, 1_000),
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!body?.access_token) throw new PlatformApiError('KiotViet không trả access_token', { body });
    cachedToken = body.access_token;
    tokenExpiresAt = Date.now() + (Number(body.expires_in) || 86_400) * 1_000;
    return cachedToken;
  }

  return {
    name: 'kiotviet',
    async markOrderPaid({ orderId, payment }) {
      const token = await accessToken();
      const body = await fetchJson(`${apiBaseUrl}/payments`, {
        fetchImpl: fetch,
        timeoutMs,
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          retailer,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          amount: payment.amount,
          method: 'Transfer',
          accountId,
          invoiceId: invoiceId(orderId),
        }),
      });
      if (!body?.paymentId) throw new PlatformApiError('KiotViet không trả paymentId', { body });
      return body;
    },
  };
}
