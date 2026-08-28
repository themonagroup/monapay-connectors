import { fetchJson, PlatformApiError, required } from '../../core/http.js';

const mutation = `
  mutation MarkOrderPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order { id displayFinancialStatus }
      userErrors { field message }
    }
  }
`;

export function createAdapter({ env = process.env, fetch = globalThis.fetch, timeoutMs } = {}) {
  const shop = required(env, 'SHOPIFY_SHOP');
  const accessToken = required(env, 'SHOPIFY_ACCESS_TOKEN');
  const apiVersion = required(env, 'SHOPIFY_API_VERSION');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) throw new Error('SHOPIFY_SHOP phải là domain *.myshopify.com');
  if (!/^\d{4}-\d{2}$/.test(apiVersion)) throw new Error('SHOPIFY_API_VERSION phải có dạng YYYY-MM');
  const endpoint = `https://${shop.toLowerCase()}/admin/api/${apiVersion}/graphql.json`;

  return {
    name: 'shopify',
    async markOrderPaid({ orderId }) {
      const id = String(orderId).startsWith('gid://shopify/Order/')
        ? String(orderId)
        : `gid://shopify/Order/${orderId}`;
      const body = await fetchJson(endpoint, {
        fetchImpl: fetch,
        timeoutMs,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-access-token': accessToken,
        },
        body: JSON.stringify({ query: mutation, variables: { input: { id } } }),
      });
      if (body?.errors?.length) {
        throw new PlatformApiError(`Shopify GraphQL: ${body.errors.map((item) => item.message).join('; ')}`, { body });
      }
      const payload = body?.data?.orderMarkAsPaid;
      if (!payload || payload.userErrors?.length) {
        const message = payload?.userErrors?.map((item) => item.message).join('; ') || 'Thiếu payload orderMarkAsPaid';
        throw new PlatformApiError(`Shopify không đánh dấu được đơn đã trả: ${message}`, { body });
      }
      return payload.order;
    },
  };
}
