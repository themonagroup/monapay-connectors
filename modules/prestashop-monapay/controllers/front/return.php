<?php

require_once dirname(__DIR__, 2) . '/classes/MonaPayHmac.php';

class MonaPayReturnModuleFrontController extends ModuleFrontController
{
    public $ssl = true;
    public $auth = false;
    public $guestAllowed = true;

    public function postProcess()
    {
        $checkoutId = trim((string) Tools::getValue('monapay_checkout'));
        $orderCode = trim((string) Tools::getValue('order_code'));
        $status = trim((string) Tools::getValue('status'));
        $timestamp = trim((string) Tools::getValue('ts'));
        $signature = trim((string) Tools::getValue('sig'));

        $checkout = $this->module->getCheckoutByCheckoutId($checkoutId);
        if ($status === 'cancelled') {
            if ($checkout) {
                $order = new Order((int) $checkout['id_order']);
                if (Validate::isLoadedObject($order) && $order->module === $this->module->name) {
                    $this->module->markCheckoutStatus((int) $order->id, 'cancelled');
                    Tools::redirect($this->module->orderConfirmationUrl($order, array('monapay_result' => 'cancelled')));
                }
            }
            Tools::redirect($this->context->link->getPageLink('index', true));
        }

        $secret = trim((string) Configuration::get(MonaPay::CONFIG_RETURN_SECRET));
        if (!MonaPayHmac::verifyReturn($checkoutId, $orderCode, $status, $timestamp, $signature, $secret)) {
            $this->module->log('Return MONA Pay có chữ ký hoặc timestamp không hợp lệ.', 2);
            $this->redirectInvalidReturn();
        }

        $idOrder = $this->module->orderIdFromCode($orderCode);
        $order = $idOrder > 0 ? new Order($idOrder) : null;
        if (!$checkout
            || !$order
            || !Validate::isLoadedObject($order)
            || $order->module !== $this->module->name
            || (int) $checkout['id_order'] !== (int) $order->id
            || !hash_equals((string) $checkout['checkout_id'], $checkoutId)
        ) {
            $this->module->log('Return MONA Pay không khớp checkout/đơn hàng.', 2);
            $this->redirectInvalidReturn();
        }

        try {
            $remote = $this->module->getApiClient()->getCheckout($checkoutId);
            $remoteAmount = isset($remote['amount']) && is_numeric($remote['amount'])
                ? (int) round((float) $remote['amount'])
                : 0;
            $paidAmount = isset($remote['paid_amount']) && is_numeric($remote['paid_amount'])
                ? (int) round((float) $remote['paid_amount'])
                : 0;
            $transactionCode = isset($remote['transaction_code']) ? trim((string) $remote['transaction_code']) : '';
            $matches = isset($remote['status'], $remote['order_code'])
                && $remote['status'] === 'paid'
                && (string) $remote['order_code'] === $orderCode
                && $remoteAmount === (int) round((float) $order->total_paid_tax_incl)
                && $paidAmount >= $remoteAmount
                && $transactionCode !== '';

            if ($matches) {
                $result = $this->module->completePayment(
                    $order,
                    $transactionCode,
                    $paidAmount,
                    $checkoutId,
                    'RETURN_RECONCILED'
                );
                if ($result === 'completed' || $result === 'duplicate') {
                    Tools::redirect($this->module->orderConfirmationUrl($order, array('monapay_result' => 'paid')));
                }
            }

            $this->module->log('Return đã ký nhưng API chưa xác nhận checkout paid cho đơn #' . (int) $order->id . '.', 2);
        } catch (Throwable $exception) {
            $this->module->log('Đối soát return đơn #' . (int) $order->id . ' thất bại: ' . $exception->getMessage(), 3);
        }

        Tools::redirect($this->module->orderConfirmationUrl($order, array('monapay_result' => 'pending')));
    }

    private function redirectInvalidReturn()
    {
        Tools::redirect($this->context->link->getPageLink('index', true, null, array('monapay_result' => 'invalid')));
    }
}
