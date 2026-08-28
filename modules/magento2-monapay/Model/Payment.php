<?php
namespace Mona\MonaPay\Model;

use Magento\Payment\Model\Method\AbstractMethod;
use Magento\Sales\Model\Order;

class Payment extends AbstractMethod
{
    protected $_code = 'monapay';
    protected $_isOffline = true;

    public function initialize($paymentAction, $stateObject)
    {
        $stateObject->setState(Order::STATE_PENDING_PAYMENT);
        $stateObject->setStatus(Order::STATE_PENDING_PAYMENT);
        $stateObject->setIsNotified(false);
        return $this;
    }
}
