<?php
namespace Mona\MonaPay\Block;

use Magento\Checkout\Model\Session;
use Magento\Framework\View\Element\Template;
use Magento\Sales\Api\OrderRepositoryInterface;
use Mona\MonaPay\Model\ApiClient;

class Success extends Template
{
    private Session $checkoutSession;
    private OrderRepositoryInterface $orders;
    private ApiClient $api;
    private ?array $result = null;

    public function __construct(Template\Context $context, Session $checkoutSession, OrderRepositoryInterface $orders, ApiClient $api, array $data = [])
    {
        parent::__construct($context, $data);
        $this->checkoutSession = $checkoutSession;
        $this->orders = $orders;
        $this->api = $api;
    }

    public function getPaymentData(): array
    {
        if ($this->result !== null) {
            return $this->result;
        }
        $order = $this->checkoutSession->getLastRealOrder();
        if (!$order || $order->getPayment()->getMethod() !== 'monapay') {
            return $this->result = [];
        }
        $payment = $order->getPayment();
        $cached = $payment->getAdditionalInformation('monapay_qr');
        if (is_array($cached) && !empty($cached['qr_data_url'])) {
            return $this->result = $cached;
        }
        try {
            $qr = $this->api->generateQr($order);
            $payment->setAdditionalInformation('monapay_qr', $qr);
            $this->orders->save($order);
            return $this->result = $qr;
        } catch (\Throwable $exception) {
            return $this->result = ['error' => $exception->getMessage()];
        }
    }
}
