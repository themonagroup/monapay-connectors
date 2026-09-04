<?php

require_once dirname(__DIR__, 2) . '/classes/MonaPayHmac.php';

class MonaPayWebhookModuleFrontController extends ModuleFrontController
{
    public $ssl = true;
    public $auth = false;
    public $guestAllowed = true;
    public $ajax = true;

    public function postProcess()
    {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->respond(405, false, 'Chỉ chấp nhận POST.');
        }

        $rawBody = file_get_contents('php://input');
        $rawBody = is_string($rawBody) ? $rawBody : '';
        $timestamp = isset($_SERVER['HTTP_X_MONA_TIMESTAMP']) ? trim((string) $_SERVER['HTTP_X_MONA_TIMESTAMP']) : '';
        $signature = isset($_SERVER['HTTP_X_MONA_SIGNATURE']) ? trim((string) $_SERVER['HTTP_X_MONA_SIGNATURE']) : '';
        $secret = trim((string) Configuration::get(MonaPay::CONFIG_WEBHOOK_SECRET));

        if ($secret === '') {
            $this->module->log('Webhook bị từ chối vì chưa cấu hình HMAC secret.', 3);
            $this->respond(503, false, 'Webhook chưa được cấu hình.');
        }

        if (!MonaPayHmac::verifyWebhook($rawBody, $timestamp, $signature, $secret)) {
            $this->module->log('Webhook có timestamp hoặc chữ ký không hợp lệ.', 2);
            $this->respond(401, false, 'Chữ ký không hợp lệ.');
        }

        $payload = json_decode($rawBody, true);
        if (!is_array($payload)) {
            $this->respond(400, false, 'Payload JSON không hợp lệ.');
        }

        $transactionCode = isset($payload['transaction_code']) ? trim((string) $payload['transaction_code']) : '';
        if ($transactionCode === 'DUMMY123') {
            $this->module->log('Đã xác minh webhook thử MONA Pay.', 1);
            $this->respond(200, true, 'Webhook thử hợp lệ.');
        }

        $event = isset($payload['event'])
            ? trim((string) $payload['event'])
            : (isset($payload['event_type']) ? trim((string) $payload['event_type']) : '');
        if ($event !== 'CHECKOUT_PAID') {
            $this->respond(200, true, 'Đã nhận; sự kiện không áp dụng cho hosted checkout.');
        }

        if (!isset($payload['checkout_id'], $payload['order_code'], $payload['amount'], $payload['paid_amount'], $payload['transaction_code'])
            || !is_numeric($payload['amount'])
            || !is_numeric($payload['paid_amount'])
            || (isset($payload['status']) && $payload['status'] !== 'paid')
            || (isset($payload['currency']) && $payload['currency'] !== 'VND')
        ) {
            $this->respond(400, false, 'Payload CHECKOUT_PAID không hợp lệ.');
        }

        $checkoutId = trim((string) $payload['checkout_id']);
        $orderCode = trim((string) $payload['order_code']);
        $idOrder = $this->module->orderIdFromCode($orderCode);
        $order = $idOrder > 0 ? new Order($idOrder) : null;
        $checkout = $this->module->getCheckoutByCheckoutId($checkoutId);

        if (!$order
            || !Validate::isLoadedObject($order)
            || $order->module !== $this->module->name
            || !$checkout
            || (int) $checkout['id_order'] !== (int) $order->id
            || !hash_equals((string) $checkout['checkout_id'], $checkoutId)
        ) {
            $this->module->log('Không tìm thấy đơn khớp CHECKOUT_PAID ' . $orderCode . '.', 2);
            $this->respond(200, true, 'Đã nhận; không tìm thấy đơn MONA Pay tương ứng.');
        }

        $expectedAmount = (int) round((float) $order->total_paid_tax_incl);
        if ((int) round((float) $payload['amount']) !== $expectedAmount) {
            $this->module->log('CHECKOUT_PAID có amount không khớp đơn #' . (int) $order->id . '.', 3);
            $this->respond(409, false, 'Số tiền checkout không khớp đơn hàng.');
        }

        $result = $this->module->completePayment(
            $order,
            $transactionCode,
            $payload['paid_amount'],
            $checkoutId,
            'CHECKOUT_PAID'
        );

        if ($result === 'completed') {
            $this->module->log('Đã xác nhận thanh toán đơn #' . (int) $order->id . ' từ CHECKOUT_PAID.', 1);
            $this->respond(200, true, 'Đã xác nhận thanh toán.');
        }
        if ($result === 'duplicate') {
            $this->respond(200, true, 'Giao dịch đã được xử lý.');
        }

        $this->respond(400, false, 'Không thể áp dụng giao dịch vào đơn hàng.');
    }

    private function respond($status, $success, $message)
    {
        http_response_code((int) $status);
        header('Content-Type: application/json; charset=utf-8');
        if ((int) $status === 405) {
            header('Allow: POST');
        }
        echo json_encode(array(
            'success' => (bool) $success,
            'message' => (string) $message,
            'data' => null,
        ), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
}
