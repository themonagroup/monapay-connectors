<?php
namespace Opencart\Catalog\Controller\Extension\Monapay\Payment;

use Opencart\System\Library\Monapay\Hmac;

class Monapay extends \Opencart\System\Engine\Controller
{
    public function index(): string
    {
        $data['confirm'] = $this->url->link('extension/monapay/payment/monapay.confirm', 'language=' . $this->config->get('config_language'));
        return $this->load->view('extension/monapay/payment/monapay', $data);
    }

    public function confirm(): void
    {
        $json = [];
        try {
            $orderId = (int) ($this->session->data['order_id'] ?? 0);
            if ($orderId < 1) {
                throw new \RuntimeException('Missing checkout order.');
            }
            $this->load->model('checkout/order');
            $this->load->model('extension/monapay/payment/monapay');
            $order = $this->model_checkout_order->getOrder($orderId);
            if (!$order || !in_array($order['payment_method']['code'] ?? '', ['monapay', 'monapay.monapay'], true)) {
                throw new \RuntimeException('Order does not use MONA Pay.');
            }
            $json['data'] = $this->model_extension_monapay_payment_monapay->generateQr($order);
        } catch (\Throwable $exception) {
            $json['error'] = $exception->getMessage();
        }
        $this->response->addHeader('Content-Type: application/json');
        $this->response->setOutput(json_encode($json));
    }

    public function webhook(): void
    {
        $raw = file_get_contents('php://input') ?: '';
        $timestamp = (string) ($this->request->server['HTTP_X_MONA_TIMESTAMP'] ?? '');
        $signature = (string) ($this->request->server['HTTP_X_MONA_SIGNATURE'] ?? '');
        if (!Hmac::verify($raw, $timestamp, $signature, (string) $this->config->get('payment_monapay_webhook_secret'))) {
            $this->respond(401, false, 'Chữ ký không hợp lệ.');
            return;
        }
        $payload = json_decode($raw, true);
        if (!is_array($payload) || !isset($payload['amount'], $payload['description'], $payload['transaction_code'], $payload['account_number']) || ($payload['type'] ?? 'income') !== 'income' || !is_numeric($payload['amount'])) {
            $this->respond(400, false, 'Payload không hợp lệ.');
            return;
        }
        $code = (string) $payload['transaction_code'];
        if ($code === 'DUMMY123') {
            $this->respond(200, true, 'Webhook thử hợp lệ.');
            return;
        }
        if ($code === '' || !preg_match('/(?:^|[^A-Z0-9])DH\s*#?\s*([0-9]+)(?:$|[^0-9])/i', (string) $payload['description'], $matches)) {
            $this->respond(200, true, 'Đã nhận; không tìm thấy mã đơn.');
            return;
        }
        $orderId = (int) $matches[1];
        $this->load->model('checkout/order');
        $order = $this->model_checkout_order->getOrder($orderId);
        if (!$order || !in_array($order['payment_method']['code'] ?? '', ['monapay', 'monapay.monapay'], true)) {
            $this->respond(200, true, 'Đã nhận; không tìm thấy đơn MONA Pay.');
            return;
        }
        if ((int) round((float) $payload['amount']) < (int) round((float) $order['total'])) {
            $this->respond(200, true, 'Đã nhận; số tiền chưa đủ.');
            return;
        }
        $escaped = $this->db->escape($code);
        $existing = $this->db->query("SELECT transaction_code FROM `" . DB_PREFIX . "monapay_transaction` WHERE transaction_code='" . $escaped . "' LIMIT 1");
        if ($existing->num_rows > 0) {
            $this->respond(200, true, 'Giao dịch đã được xử lý.');
            return;
        }
        $this->db->query("INSERT INTO `" . DB_PREFIX . "monapay_transaction` SET transaction_code='" . $escaped . "', order_id='" . $orderId . "', created_at=NOW()");
        $statusId = (int) $this->config->get('payment_monapay_order_status_id');
        $this->model_checkout_order->addHistory($orderId, $statusId, 'MONA Pay: ' . $code, true);
        $this->respond(200, true, 'Đã xác nhận thanh toán.');
    }

    private function respond(int $status, bool $success, string $message): void
    {
        $this->response->addHeader('Content-Type: application/json');
        http_response_code($status);
        $this->response->setOutput(json_encode(['success' => $success, 'message' => $message, 'data' => null]));
    }
}
