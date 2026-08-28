<?php
namespace Mona\MonaPay\Controller\Webhook;

use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\Result\JsonFactory;
use Magento\Sales\Model\OrderFactory;
use Magento\Sales\Api\OrderRepositoryInterface;
use Magento\Store\Model\ScopeInterface;
use Mona\MonaPay\Model\WebhookVerifier;

class Index implements HttpPostActionInterface
{
    private RequestInterface $request;
    private JsonFactory $results;
    private ScopeConfigInterface $config;
    private OrderFactory $orderFactory;
    private OrderRepositoryInterface $orders;

    public function __construct(RequestInterface $request, JsonFactory $results, ScopeConfigInterface $config, OrderFactory $orderFactory, OrderRepositoryInterface $orders)
    {
        $this->request = $request;
        $this->results = $results;
        $this->config = $config;
        $this->orderFactory = $orderFactory;
        $this->orders = $orders;
    }

    public function execute()
    {
        $raw = (string) $this->request->getContent();
        $timestamp = (string) $this->request->getHeader('X-Mona-Timestamp');
        $signature = (string) $this->request->getHeader('X-Mona-Signature');
        $secret = (string) $this->config->getValue('payment/monapay/webhook_secret', ScopeInterface::SCOPE_STORE);
        if (!WebhookVerifier::verify($raw, $timestamp, $signature, $secret)) {
            return $this->respond(401, false, 'Chữ ký không hợp lệ.');
        }
        $payload = json_decode($raw, true);
        if (!is_array($payload) || !isset($payload['amount'], $payload['description'], $payload['transaction_code'], $payload['account_number'])) {
            return $this->respond(400, false, 'Payload không hợp lệ.');
        }
        if (($payload['type'] ?? 'income') !== 'income' || !is_numeric($payload['amount']) || !is_string($payload['transaction_code']) || $payload['transaction_code'] === '') {
            return $this->respond(400, false, 'Giao dịch không hợp lệ.');
        }
        if ($payload['transaction_code'] === 'DUMMY123') {
            return $this->respond(200, true, 'Webhook thử hợp lệ.');
        }
        if (!preg_match('/(?:^|[^A-Z0-9])DH\s*#?\s*([0-9]+)(?:$|[^0-9])/i', (string) $payload['description'], $matches)) {
            return $this->respond(200, true, 'Đã nhận; không tìm thấy mã đơn.');
        }
        $order = $this->orderFactory->create()->loadByIncrementId($matches[1]);
        if (!$order->getId() || $order->getPayment()->getMethod() !== 'monapay') {
            return $this->respond(200, true, 'Đã nhận; không tìm thấy đơn MONA Pay.');
        }
        $payment = $order->getPayment();
        $codes = $payment->getAdditionalInformation('monapay_transaction_codes');
        $codes = is_array($codes) ? array_map('strval', $codes) : [];
        $code = $payload['transaction_code'];
        if (in_array($code, $codes, true)) {
            return $this->respond(200, true, 'Giao dịch đã được xử lý.');
        }
        if ((int) round((float) $payload['amount']) < (int) round((float) $order->getGrandTotal())) {
            $order->addCommentToStatusHistory('MONA Pay nhận thiếu tiền; mã ' . $code . '.');
            $this->orders->save($order);
            return $this->respond(200, true, 'Đã nhận; số tiền chưa đủ.');
        }
        $codes[] = $code;
        $payment->setAdditionalInformation('monapay_transaction_codes', array_values(array_unique($codes)));
        $payment->setTransactionId($code)->setIsTransactionClosed(true);
        $payment->registerCaptureNotification((float) $order->getGrandTotal(), true);
        $order->addCommentToStatusHistory('MONA Pay đã xác nhận thanh toán; mã ' . $code . '.');
        $this->orders->save($order);
        return $this->respond(200, true, 'Đã xác nhận thanh toán.');
    }

    private function respond(int $status, bool $success, string $message)
    {
        return $this->results->create()->setHttpResponseCode($status)->setData(['success' => $success, 'message' => $message, 'data' => null]);
    }
}
