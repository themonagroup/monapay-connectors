import { fetchJson, required, safeBaseUrl } from '../../core/http.js';

export function createAdapter({ env = process.env, fetch = globalThis.fetch, timeoutMs } = {}) {
  const baseUrl = safeBaseUrl(required(env, 'WOOCOMMERCE_STORE_URL'), 'WOOCOMMERCE_STORE_URL');
  const consumerKey = required(env, 'WOOCOMMERCE_CONSUMER_KEY');
  const consumerSecret = required(env, 'WOOCOMMERCE_CONSUMER_SECRET');
  const authorization = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`;

  return {
    name: 'woocommerce',
    async markOrderPaid({ orderId }) {
      return fetchJson(`${baseUrl}/wp-json/wc/v3/orders/${encodeURIComponent(orderId)}`, {
        fetchImpl: fetch,
        timeoutMs,
        method: 'PUT',
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ set_paid: true }),
      });
    },
  };
}
