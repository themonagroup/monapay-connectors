import { fetchJson, PlatformApiError, required, safeBaseUrl } from '../../core/http.js';

function replaceTemplate(value, context) {
  if (Array.isArray(value)) return value.map((item) => replaceTemplate(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTemplate(item, context)]));
  }
  if (value === '{{orderId}}') return context.orderId;
  if (value === '{{amount}}') return context.amount;
  if (value === '{{transactionCode}}') return context.transactionCode;
  if (typeof value === 'string') {
    return value
      .replaceAll('{{orderId}}', context.orderId)
      .replaceAll('{{amount}}', String(context.amount))
      .replaceAll('{{transactionCode}}', context.transactionCode);
  }
  return value;
}

export function createAdapter({ env = process.env, fetch = globalThis.fetch, timeoutMs } = {}) {
  // TODO: kiểm với tài liệu Pancake POS/Partner account trước khi điền endpoint và payload thật.
  const urlTemplate = required(env, 'PANCAKE_MARK_PAID_URL_TEMPLATE');
  const method = required(env, 'PANCAKE_MARK_PAID_METHOD').toUpperCase();
  const authHeader = required(env, 'PANCAKE_AUTH_HEADER');
  const authValue = required(env, 'PANCAKE_AUTH_VALUE');
  const rawBodyTemplate = required(env, 'PANCAKE_MARK_PAID_BODY_TEMPLATE');
  if (!['POST', 'PUT', 'PATCH'].includes(method)) throw new Error('PANCAKE_MARK_PAID_METHOD phải là POST, PUT hoặc PATCH');
  let bodyTemplate;
  try {
    bodyTemplate = JSON.parse(rawBodyTemplate);
  } catch {
    throw new Error('PANCAKE_MARK_PAID_BODY_TEMPLATE phải là JSON hợp lệ');
  }

  return {
    name: 'pancake',
    async markOrderPaid({ orderId, payment }) {
      const context = {
        orderId: String(orderId),
        amount: payment.amount,
        transactionCode: String(payment.transaction_code),
      };
      const endpoint = safeBaseUrl(urlTemplate.replaceAll('{{orderId}}', encodeURIComponent(context.orderId)), 'PANCAKE_MARK_PAID_URL_TEMPLATE');
      const body = await fetchJson(endpoint, {
        fetchImpl: fetch,
        timeoutMs,
        method,
        headers: {
          [authHeader]: authValue,
          'content-type': 'application/json',
        },
        body: JSON.stringify(replaceTemplate(bodyTemplate, context)),
      });
      if (body?.success === false || body?.code === 0) {
        throw new PlatformApiError('Pancake POS không xác nhận cập nhật thanh toán', { body });
      }
      return body;
    },
  };
}
