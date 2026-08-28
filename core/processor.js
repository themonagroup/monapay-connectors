import { verifyWebhook } from '../../sdk/node/dist/index.js';

import { IdempotencyCache } from './idempotency.js';
import { mapOrderId } from './mapping.js';
import { retry } from './retry.js';

function response(status, body) {
  return { status, body };
}

export function createWebhookProcessor({
  secret,
  adapter,
  orderIdPattern,
  retryDelayMs = 250,
  logger,
  sleep,
  idempotency = new IdempotencyCache(),
} = {}) {
  if (!secret) throw new Error('MONA_WEBHOOK_SECRET là bắt buộc');
  if (!adapter || typeof adapter.markOrderPaid !== 'function') {
    throw new TypeError('Adapter phải có markOrderPaid()');
  }

  const inFlight = new Map();

  return async function processWebhook({ rawBody, headers }) {
    const verified = verifyWebhook({ rawBody, headers, secret });
    if (!verified.ok) {
      logger?.warn('webhook_rejected', { reason: verified.reason });
      return response(401, { success: false, message: 'Chữ ký webhook không hợp lệ' });
    }

    const payment = verified.payload;
    if (payment.type && String(payment.type).toLowerCase() !== 'income') {
      logger?.info('webhook_ignored', { reason: 'not_income', transactionCode: payment.transaction_code });
      return response(202, { success: true, message: 'Bỏ qua giao dịch không phải tiền vào' });
    }

    const transactionCode = String(payment.transaction_code ?? '').trim();
    const amount = Number(payment.amount);
    if (!transactionCode || !Number.isFinite(amount) || amount <= 0) {
      return response(422, { success: false, message: 'Webhook thiếu transaction_code hoặc amount hợp lệ' });
    }

    const orderId = mapOrderId(payment, { pattern: orderIdPattern });
    if (!orderId) {
      logger?.warn('order_mapping_failed', { transactionCode });
      return response(422, { success: false, message: 'Không tìm thấy mã đơn hàng trong orderId/description' });
    }

    if (idempotency.has(transactionCode)) {
      logger?.info('webhook_duplicate', { transactionCode, orderId });
      return response(200, { success: true, duplicate: true, orderId });
    }

    if (inFlight.has(transactionCode)) {
      try {
        await inFlight.get(transactionCode);
        return response(200, { success: true, duplicate: true, orderId });
      } catch {
        return response(502, { success: false, message: 'Nền tảng chưa xác nhận thanh toán; MONA Pay có thể gửi lại webhook' });
      }
    }

    const job = retry(
      () => adapter.markOrderPaid({ orderId, payment: { ...payment, amount } }),
      {
        attempts: 3,
        delayMs: retryDelayMs,
        sleep,
        onRetry: (error, attempt) => logger?.warn('adapter_retry', {
          transactionCode,
          orderId,
          attempt,
          error,
        }),
      },
    );
    inFlight.set(transactionCode, job);

    try {
      await job;
      idempotency.add(transactionCode);
      logger?.info('order_marked_paid', { transactionCode, orderId, amount });
      return response(200, { success: true, orderId });
    } catch (error) {
      logger?.error('adapter_failed', { transactionCode, orderId, error });
      return response(502, { success: false, message: 'Nền tảng chưa xác nhận thanh toán; MONA Pay có thể gửi lại webhook' });
    } finally {
      inFlight.delete(transactionCode);
    }
  };
}
