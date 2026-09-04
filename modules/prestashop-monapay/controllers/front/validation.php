<?php

class MonaPayValidationModuleFrontController extends ModuleFrontController
{
    public $ssl = true;
    public $auth = false;
    public $guestAllowed = true;

    public function postProcess()
    {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            Tools::redirect($this->context->link->getPageLink('order', true));
        }

        $cart = $this->context->cart;
        $customer = $this->context->customer;
        if (!$this->module->active
            || !Validate::isLoadedObject($cart)
            || !Validate::isLoadedObject($customer)
            || (int) $cart->id_customer !== (int) $customer->id
        ) {
            Tools::redirect($this->context->link->getPageLink('order', true));
        }

        $currency = new Currency((int) $cart->id_currency);
        $total = (int) round((float) $cart->getOrderTotal(true, Cart::BOTH));
        if (!Validate::isLoadedObject($currency) || $currency->iso_code !== 'VND' || $total < 1000 || $total > 1000000000) {
            $this->module->log('Từ chối tạo checkout: giỏ hàng không phải VND hoặc tổng tiền ngoài giới hạn.', 2);
            Tools::redirect($this->context->link->getPageLink('order', true));
        }

        $idOrder = (int) Order::getIdByCartId((int) $cart->id);
        if ($idOrder > 0) {
            $order = new Order($idOrder);
            if (!Validate::isLoadedObject($order) || $order->module !== $this->module->name) {
                Tools::redirect($this->context->link->getPageLink('order', true));
            }

            $existing = $this->module->getCheckoutByOrderId($idOrder);
            if ($existing && !empty($existing['checkout_url']) && $existing['status'] === 'pending') {
                Tools::redirect((string) $existing['checkout_url']);
            }

            Tools::redirect($this->module->orderConfirmationUrl($order));
        }

        $pendingState = (int) Configuration::get(MonaPay::CONFIG_PENDING_STATE);
        if ($pendingState < 1 || !Validate::isLoadedObject(new OrderState($pendingState))) {
            $this->module->log('Thiếu trạng thái chờ thanh toán MONA Pay.', 3);
            Tools::redirect($this->context->link->getPageLink('order', true));
        }

        $this->module->validateOrder(
            (int) $cart->id,
            $pendingState,
            $total,
            $this->module->displayName,
            null,
            array(),
            (int) $currency->id,
            false,
            (string) $customer->secure_key
        );

        $order = new Order((int) $this->module->currentOrder);
        if (!Validate::isLoadedObject($order)) {
            $this->module->log('PrestaShop không tạo được đơn trước khi mở MONA Pay.', 3);
            Tools::redirect($this->context->link->getPageLink('order', true));
        }

        $attempt = 1;
        $existing = $this->module->getCheckoutByOrderId((int) $order->id);
        if ($existing) {
            $attempt = max(1, (int) $existing['attempt'] + 1);
        }

        try {
            $checkout = $this->module->createHostedCheckout($order, $attempt);
            $this->module->log(
                'Đã tạo checkout ' . (string) $checkout['id'] . ' cho đơn #' . (int) $order->id
                    . ((bool) Configuration::get(MonaPay::CONFIG_SANDBOX) ? ' (sandbox).' : '.'),
                1
            );
            Tools::redirect((string) $checkout['checkout_url']);
        } catch (Throwable $exception) {
            try {
                $this->module->saveCheckoutError((int) $order->id, $attempt, $exception->getMessage());
            } catch (Throwable $storageException) {
                $this->module->log('Không lưu được lỗi checkout đơn #' . (int) $order->id . ': ' . $storageException->getMessage(), 3);
            }
            $this->module->log('Tạo checkout cho đơn #' . (int) $order->id . ' thất bại: ' . $exception->getMessage(), 3);
            Tools::redirect($this->module->orderConfirmationUrl($order, array('monapay_result' => 'failed')));
        }
    }
}
