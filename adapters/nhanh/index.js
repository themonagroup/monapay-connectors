import { fetchJson, PlatformApiError, required, safeBaseUrl } from '../../core/http.js';

function positiveInteger(value, key) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${key} phải là số nguyên dương`);
  return parsed;
}

export function createAdapter({ env = process.env, fetch = globalThis.fetch, timeoutMs } = {}) {
  const appId = positiveInteger(required(env, 'NHANH_APP_ID'), 'NHANH_APP_ID');
  const businessId = positiveInteger(required(env, 'NHANH_BUSINESS_ID'), 'NHANH_BUSINESS_ID');
  const accessToken = required(env, 'NHANH_ACCESS_TOKEN');
  const baseUrl = safeBaseUrl(env.NHANH_API_BASE_URL || 'https://pos.open.nhanh.vn', 'NHANH_API_BASE_URL');
  const transferAccountId = env.NHANH_TRANSFER_ACCOUNT_ID
    ? positiveInteger(env.NHANH_TRANSFER_ACCOUNT_ID, 'NHANH_TRANSFER_ACCOUNT_ID')
    : undefined;
  const paidStatus = env.NHANH_PAID_STATUS_ID
    ? positiveInteger(env.NHANH_PAID_STATUS_ID, 'NHANH_PAID_STATUS_ID')
    : undefined;

  return {
    name: 'nhanh',
    async markOrderPaid({ orderId, payment }) {
      const info = { id: positiveInteger(orderId, 'Nhanh orderId') };
      if (paidStatus) info.status = paidStatus;
      const paymentData = {
        transferAmount: payment.amount,
        code: payment.transaction_code,
      };
      if (transferAccountId) paymentData.transferAccountId = transferAccountId;
      const url = new URL('/v3.0/order/edit', baseUrl);
      url.searchParams.set('appId', appId);
      url.searchParams.set('businessId', businessId);
      const body = await fetchJson(url, {
        fetchImpl: fetch,
        timeoutMs,
        method: 'POST',
        headers: {
          authorization: accessToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ info, payment: paymentData }),
      });
      if (body?.code !== 1) throw new PlatformApiError('Nhanh.vn không xác nhận cập nhật đơn', { body });
      return body.data;
    },
  };
}
