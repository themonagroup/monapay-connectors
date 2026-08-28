import { fetchJson, PlatformApiError, required, safeBaseUrl } from '../../core/http.js';

export function createAdapter({ env = process.env, fetch = globalThis.fetch, timeoutMs } = {}) {
  const baseUrl = safeBaseUrl(required(env, 'SAPO_STORE_URL'), 'SAPO_STORE_URL');
  const apiKey = required(env, 'SAPO_API_KEY');
  const apiSecret = required(env, 'SAPO_API_SECRET');
  const kind = env.SAPO_TRANSACTION_KIND || 'sale';
  if (!['sale', 'capture'].includes(kind)) throw new Error('SAPO_TRANSACTION_KIND chỉ nhận sale hoặc capture');
  const authorization = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;

  return {
    name: 'sapo',
    async markOrderPaid({ orderId, payment }) {
      const body = await fetchJson(`${baseUrl}/admin/orders/${encodeURIComponent(orderId)}/transactions.json`, {
        fetchImpl: fetch,
        timeoutMs,
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ transaction: { kind, amount: String(payment.amount) } }),
      });
      if (!body?.transaction || (body.transaction.status && body.transaction.status !== 'success')) {
        throw new PlatformApiError('Sapo không trả transaction thành công', { body });
      }
      return body.transaction;
    },
  };
}
