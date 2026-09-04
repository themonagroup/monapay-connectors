<?php
namespace Opencart\Catalog\Controller\Extension\Monapay\Payment;

use Opencart\System\Library\Extension\Monapay\Hmac;

class Monapay extends \Opencart\System\Engine\Controller
{
    public function index(): string
    {
        $data['confirm'] = $this->url->link(
            'extension/monapay/payment/monapay.confirm',
            'language=' . $this->config->get('config_language'),
            true
        );

        return $this->load->view('extension/monapay/payment/monapay', $data);
    }

    public function confirm(): void
    {
        $json = [];

        try {
            $orderId = (int) ($this->session->data['order_id'] ?? 0);
            if ($orderId < 1) {
                throw new \RuntimeException('Không tìm thấy đơn checkout.');
            }

            $this->load->model('checkout/order');
            $this->load->model('extension/monapay/payment/monapay');
            $order = $this->model_checkout_order->getOrder($orderId);

            if (!$order || !$this->isMonapayOrder($order)) {
                throw new \RuntimeException('Đơn hàng không dùng MONA Pay.');
            }

            if (($order['currency_code'] ?? '') !== 'VND') {
                throw new \RuntimeException('MONA Pay chỉ nhận đơn VND.');
            }

            if ($this->config->get('payment_monapay_payment_mode') !== 'redirect') {
                throw new \RuntimeException('Module MONA Pay hiện chỉ hỗ trợ hosted checkout redirect.');
            }

            $amount = (int) round((float) $order['total']);
            if ($amount < 1000 || $amount > 1000000000) {
                throw new \RuntimeException('Tổng đơn phải từ 1.000 đến 1.000.000.000 VND.');
            }

            $orderCode = 'DH' . $orderId;
            $payload = [
                'amount' => $amount,
                'order_code' => $orderCode,
                'description' => 'Thanh toan don hang ' . $orderCode,
                'return_url' => $this->url->link('extension/monapay/payment/monapay.callback', '', true),
                'cancel_url' => $this->url->link('checkout/checkout', '', true),
                'expires_in' => 900,
                'metadata' => ['opencart_order_id' => $orderId],
            ];

            if (!empty($order['email'])) {
                $payload['payer_email'] = (string) $order['email'];
            }

            $payerName = trim((string) (($order['firstname'] ?? '') . ' ' . ($order['lastname'] ?? '')));
            if ($payerName !== '') {
                $payload['payer_name'] = function_exists('mb_substr') ? mb_substr($payerName, 0, 255) : substr($payerName, 0, 255);
            }

            $sandbox = (bool) $this->config->get('payment_monapay_sandbox');
            if ($sandbox) {
                $payload['sandbox'] = true;
            }

            $checkout = $this->model_extension_monapay_payment_monapay->createCheckout($payload, 'opencart-' . $orderId);
            $checkoutId = trim((string) ($checkout['id'] ?? ''));
            $checkoutUrl = trim((string) ($checkout['checkout_url'] ?? ''));

            if ($checkoutId === '' || !filter_var($checkoutUrl, FILTER_VALIDATE_URL) || stripos($checkoutUrl, 'https://') !== 0) {
                throw new \RuntimeException('Response tạo checkout thiếu id hoặc checkout_url hợp lệ.');
            }

            $this->saveCheckout($orderId, $checkoutId, $checkoutUrl, $sandbox);
            $this->model_checkout_order->addHistory(
                $orderId,
                (int) $this->config->get('config_order_status_id'),
                'Đã tạo trang thanh toán MONA Pay' . ($sandbox ? ' (sandbox).' : '.'),
                false
            );

            $json['redirect'] = $checkoutUrl;
        } catch (\Throwable $exception) {
            $json['error'] = $exception->getMessage();
        }

        $this->response->addHeader('Content-Type: application/json');
        $this->response->setOutput(json_encode($json, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    }

    public function callback(): void
    {
        try {
            $checkoutId = trim((string) ($this->request->get['monapay_checkout'] ?? ''));
            $orderCode = trim((string) ($this->request->get['order_code'] ?? ''));
            $status = trim((string) ($this->request->get['status'] ?? ''));
            $timestamp = trim((string) ($this->request->get['ts'] ?? ''));
            $signature = trim((string) ($this->request->get['sig'] ?? ''));

            if (!Hmac::verifyReturn(
                $checkoutId,
                $orderCode,
                $status,
                $timestamp,
                $signature,
                (string) $this->config->get('payment_monapay_return_signature_secret')
            )) {
                throw new \RuntimeException('Chữ ký quay lại từ MONA Pay không hợp lệ.');
            }

            $orderId = $this->orderIdFromCode($orderCode);
            $this->load->model('checkout/order');
            $this->load->model('extension/monapay/payment/monapay');
            $order = $this->model_checkout_order->getOrder($orderId);

            if (!$order || !$this->isMonapayOrder($order) || !$this->checkoutMatches($orderId, $checkoutId)) {
                throw new \RuntimeException('Không tìm thấy đơn MONA Pay tương ứng.');
            }

            $checkout = $this->model_extension_monapay_payment_monapay->getCheckout($checkoutId);
            if (($checkout['status'] ?? '') !== 'paid' || ($checkout['order_code'] ?? '') !== $orderCode) {
                throw new \RuntimeException('Phiên MONA Pay chưa được xác nhận thanh toán.');
            }

            $transactionCode = trim((string) ($checkout['transaction_code'] ?? ''));
            if ($transactionCode === '') {
                throw new \RuntimeException('Phiên MONA Pay đã paid nhưng thiếu mã giao dịch.');
            }

            $result = $this->completePayment(
                $order,
                $transactionCode,
                $checkout['paid_amount'] ?? $checkout['amount'] ?? 0,
                $checkoutId
            );

            if (!in_array($result, ['completed', 'duplicate'], true)) {
                throw new \RuntimeException($result === 'underpaid' ? 'Phiên MONA Pay chưa thanh toán đủ.' : 'Dữ liệu thanh toán MONA Pay không hợp lệ.');
            }

            $this->response->redirect($this->url->link('checkout/success', '', true));
        } catch (\Throwable $exception) {
            $this->response->addHeader('HTTP/1.1 400 Bad Request');
            $this->response->addHeader('Content-Type: text/plain; charset=utf-8');
            $this->response->setOutput($exception->getMessage());
        }
    }

    public function webhook(): void
    {
        $raw = file_get_contents('php://input') ?: '';
        $timestamp = (string) ($this->request->server['HTTP_X_MONA_TIMESTAMP'] ?? '');
        $signature = (string) ($this->request->server['HTTP_X_MONA_SIGNATURE'] ?? '');

        if (!Hmac::verifyWebhook($raw, $timestamp, $signature, (string) $this->config->get('payment_monapay_webhook_secret'))) {
            $this->respond(401, false, 'Chữ ký không hợp lệ.');
            return;
        }

        $payload = json_decode($raw, true);
        if (!is_array($payload)) {
            $this->respond(400, false, 'Payload không hợp lệ.');
            return;
        }

        if (($payload['transaction_code'] ?? '') === 'DUMMY123') {
            $this->respond(200, true, 'Webhook thử hợp lệ.');
            return;
        }

        $event = (string) ($payload['event'] ?? $payload['event_type'] ?? 'TRANSACTION_IN');

        if ($event === 'CHECKOUT_PAID') {
            $this->handleCheckoutPaid($payload);
            return;
        }

        if ($event === 'TRANSACTION_IN' || $event === '') {
            $this->handleTransactionIn($payload);
            return;
        }

        $this->respond(200, true, 'Đã bỏ qua event không liên quan.');
    }

    private function handleCheckoutPaid(array $payload): void
    {
        $paidAmount = $payload['paid_amount'] ?? $payload['amount'] ?? null;
        if (
            ($payload['status'] ?? 'paid') !== 'paid'
            || !isset($payload['checkout_id'], $payload['order_code'], $payload['transaction_code'])
            || trim((string) $payload['transaction_code']) === ''
            || !is_numeric($paidAmount)
        ) {
            $this->respond(400, false, 'Payload CHECKOUT_PAID thiếu trường bắt buộc.');
            return;
        }

        try {
            $orderId = $this->orderIdFromCode((string) $payload['order_code']);
        } catch (\Throwable $exception) {
            $this->respond(200, true, 'Đã nhận; mã đơn không hợp lệ.');
            return;
        }

        $this->load->model('checkout/order');
        $order = $this->model_checkout_order->getOrder($orderId);
        if (!$order || !$this->isMonapayOrder($order) || !$this->checkoutMatches($orderId, (string) $payload['checkout_id'])) {
            $this->respond(200, true, 'Đã nhận; không tìm thấy đơn MONA Pay.');
            return;
        }

        $result = $this->completePayment(
            $order,
            (string) $payload['transaction_code'],
            $paidAmount,
            (string) $payload['checkout_id']
        );
        $this->respond(200, true, $result === 'duplicate' ? 'Giao dịch đã được xử lý.' : ($result === 'underpaid' ? 'Đã nhận; số tiền chưa đủ.' : 'Đã xác nhận thanh toán.'));
    }

    private function handleTransactionIn(array $payload): void
    {
        if (
            !isset($payload['amount'], $payload['description'], $payload['transaction_code'])
            || !is_numeric($payload['amount'])
            || trim((string) $payload['transaction_code']) === ''
            || ($payload['type'] ?? 'income') !== 'income'
        ) {
            $this->respond(400, false, 'Giao dịch không hợp lệ.');
            return;
        }

        if (!preg_match('/(?:^|[^A-Z0-9])DH\s*#?\s*([0-9]+)(?:$|[^0-9])/i', (string) $payload['description'], $matches)) {
            $this->respond(200, true, 'Đã nhận; không tìm thấy mã đơn.');
            return;
        }

        $this->load->model('checkout/order');
        $order = $this->model_checkout_order->getOrder((int) $matches[1]);
        if (!$order || !$this->isMonapayOrder($order)) {
            $this->respond(200, true, 'Đã nhận; không tìm thấy đơn MONA Pay.');
            return;
        }

        $result = $this->completePayment($order, (string) $payload['transaction_code'], $payload['amount']);
        $this->respond(200, true, $result === 'duplicate' ? 'Giao dịch đã được xử lý.' : ($result === 'underpaid' ? 'Đã nhận; số tiền chưa đủ.' : 'Đã xác nhận thanh toán.'));
    }

    private function completePayment(array $order, string $transactionCode, mixed $paidAmount, string $checkoutId = ''): string
    {
        $transactionCode = trim($transactionCode);
        if ($transactionCode === '' || !is_numeric($paidAmount)) {
            return 'invalid';
        }

        if ((int) round((float) $paidAmount) < (int) round((float) $order['total'])) {
            return 'underpaid';
        }

        $escaped = $this->db->escape($transactionCode);
        $orderId = (int) $order['order_id'];
        $this->db->query("INSERT IGNORE INTO `" . DB_PREFIX . "monapay_transaction` SET `transaction_code` = '" . $escaped . "', `order_id` = '" . $orderId . "', `created_at` = NOW()");
        if ($this->db->countAffected() < 1) {
            return 'duplicate';
        }

        if ($checkoutId !== '') {
            $this->db->query("UPDATE `" . DB_PREFIX . "monapay_checkout` SET `status` = 'paid', `date_modified` = NOW() WHERE `order_id` = '" . $orderId . "' AND `checkout_id` = '" . $this->db->escape($checkoutId) . "'");
        }

        $statusId = (int) $this->config->get('payment_monapay_order_status_id');
        if ($statusId < 1) {
            $statusId = (int) $this->config->get('config_order_status_id');
        }
        if ($statusId < 1) {
            $statusId = 5;
        }

        $this->load->model('checkout/order');
        $this->model_checkout_order->addHistory($orderId, $statusId, 'MONA Pay: ' . $transactionCode, true);
        return 'completed';
    }

    private function saveCheckout(int $orderId, string $checkoutId, string $checkoutUrl, bool $sandbox): void
    {
        $this->db->query("INSERT INTO `" . DB_PREFIX . "monapay_checkout` SET
            `order_id` = '" . $orderId . "',
            `checkout_id` = '" . $this->db->escape($checkoutId) . "',
            `checkout_url` = '" . $this->db->escape($checkoutUrl) . "',
            `status` = 'pending',
            `sandbox` = '" . (int) $sandbox . "',
            `date_added` = NOW(),
            `date_modified` = NOW()
            ON DUPLICATE KEY UPDATE
            `checkout_id` = VALUES(`checkout_id`),
            `checkout_url` = VALUES(`checkout_url`),
            `status` = VALUES(`status`),
            `sandbox` = VALUES(`sandbox`),
            `date_modified` = NOW()");
    }

    private function checkoutMatches(int $orderId, string $checkoutId): bool
    {
        $query = $this->db->query("SELECT `checkout_id` FROM `" . DB_PREFIX . "monapay_checkout` WHERE `order_id` = '" . $orderId . "' AND `checkout_id` = '" . $this->db->escape($checkoutId) . "' LIMIT 1");
        return $query->num_rows > 0;
    }

    private function orderIdFromCode(string $orderCode): int
    {
        if (!preg_match('/^DH([1-9][0-9]*)$/', $orderCode, $matches)) {
            throw new \RuntimeException('Mã đơn MONA Pay không hợp lệ.');
        }

        return (int) $matches[1];
    }

    private function isMonapayOrder(array $order): bool
    {
        $paymentMethod = $order['payment_method'] ?? '';
        $code = is_array($paymentMethod) ? ($paymentMethod['code'] ?? '') : $paymentMethod;
        return in_array($code, ['monapay', 'monapay.monapay'], true);
    }

    private function respond(int $status, bool $success, string $message): void
    {
        $statusText = [200 => 'OK', 400 => 'Bad Request', 401 => 'Unauthorized'][$status] ?? 'OK';
        $this->response->addHeader('HTTP/1.1 ' . $status . ' ' . $statusText);
        $this->response->addHeader('Content-Type: application/json');
        $this->response->setOutput(json_encode(['success' => $success, 'message' => $message, 'data' => null], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    }
}
