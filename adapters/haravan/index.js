import { fetchJson, PlatformApiError, required, safeBaseUrl } from '../../core/http.js';

export function createAdapter({ env = process.env, fetch = globalThis.fetch, timeoutMs } = {}) {
  const token = required(env, 'HARAVAN_ACCESS_TOKEN');
  const baseUrl = safeBaseUrl(env.HARAVAN_API_BASE_URL || 'https://apis.haravan.com', 'HARAVAN_API_BASE_URL');
  const kind = env.HARAVAN_TRANSACTION_KIND || 'Sale';
  if (!['Sale', 'Capture'].includes(kind)) throw new Error('HARAVAN_TRANSACTION_KIND chỉ nhận Sale hoặc Capture');

  return {
    name: 'haravan',
    async markOrderPaid({ orderId, payment }) {
      const body = await fetchJson(`${baseUrl}/com/orders/${encodeURIComponent(orderId)}/transactions.json`, {
        fetchImpl: fetch,
        timeoutMs,
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          transaction: {
            amount: payment.amount,
            kind,
          },
        }),
      });
      if (!body?.transaction || (body.transaction.status && body.transaction.status !== 'success')) {
        throw new PlatformApiError('Haravan không trả transaction thành công', { body });
      }
      return body.transaction;
    },
  };
}
