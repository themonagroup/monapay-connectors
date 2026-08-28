<?php

require_once dirname(__DIR__, 2) . '/classes/MonaPayHmac.php';

class MonaPayWebhookModuleFrontController extends ModuleFrontController
{
    public $ssl = true;

    public function postProcess()
    {
        $raw = file_get_contents('php://input') ?: '';
        $timestamp = isset($_SERVER['HTTP_X_MONA_TIMESTAMP']) ? (string) $_SERVER['HTTP_X_MONA_TIMESTAMP'] : '';
        $signature = isset($_SERVER['HTTP_X_MONA_SIGNATURE']) ? (string) $_SERVER['HTTP_X_MONA_SIGNATURE'] : '';
        if (!MonaPayHmac::verify($raw, $timestamp, $signature, (string) Configuration::get('MONAPAY_WEBHOOK_SECRET'))) {
            $this->respond(401, false, 'Chữ ký không hợp lệ.');
        }
        $payload = json_decode($raw, true);
        if (!is_array($payload) || !isset($payload['amount'], $payload['description'], $payload['transaction_code'], $payload['account_number']) || ($payload['type'] ?? 'income') !== 'income' || !is_numeric($payload['amount'])) {
            $this->respond(400, false, 'Payload không hợp lệ.');
        }
        $code = (string) $payload['transaction_code'];
        if ($code === 'DUMMY123') {
            $this->respond(200, true, 'Webhook thử hợp lệ.');
        }
        if ($code === '' || !preg_match('/(?:^|[^A-Z0-9])DH\s*#?\s*([0-9]+)(?:$|[^0-9])/i', (string) $payload['description'], $matches)) {
            $this->respond(200, true, 'Đã nhận; không tìm thấy mã đơn.');
        }
        $order = new Order((int) $matches[1]);
        if (!Validate::isLoadedObject($order) || $order->module !== 'monapay') {
            $this->respond(200, true, 'Đã nhận; không tìm thấy đơn MONA Pay.');
        }
        if ((int) round((float) $payload['amount']) < (int) round((float) $order->total_paid_tax_incl)) {
            $this->respond(200, true, 'Đã nhận; số tiền chưa đủ.');
        }
        $exists = Db::getInstance()->getValue('SELECT transaction_code FROM `' . _DB_PREFIX_ . 'monapay_transaction` WHERE transaction_code=\'' . pSQL($code) . '\'');
        if ($exists) {
            $this->respond(200, true, 'Giao dịch đã được xử lý.');
        }
        if (!Db::getInstance()->insert('monapay_transaction', ['transaction_code' => pSQL($code), 'id_order' => (int) $order->id, 'created_at' => date('Y-m-d H:i:s')])) {
            $this->respond(500, false, 'Không thể lưu giao dịch.');
        }
        $history = new OrderHistory();
        $history->id_order = (int) $order->id;
        $history->changeIdOrderState((int) Configuration::get('PS_OS_PAYMENT'), (int) $order->id);
        $history->addWithemail(true, ['{transaction_id}' => $code]);
        $this->respond(200, true, 'Đã xác nhận thanh toán.');
    }

    private function respond($status, $success, $message)
    {
        http_response_code((int) $status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['success' => (bool) $success, 'message' => $message, 'data' => null]);
        exit;
    }
}
