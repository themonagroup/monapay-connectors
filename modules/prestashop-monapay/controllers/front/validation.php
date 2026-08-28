<?php

class MonaPayValidationModuleFrontController extends ModuleFrontController
{
    public function postProcess()
    {
        $cart = $this->context->cart;
        if (!$this->module->active || !$cart->id || !$this->context->customer->isLogged()) {
            Tools::redirect('index.php?controller=order');
        }
        $currency = new Currency((int) $cart->id_currency);
        if ($currency->iso_code !== 'VND') {
            $this->errors[] = 'MONA Pay chỉ hỗ trợ đơn VND.';
            return;
        }
        $state = (int) Configuration::get('MONAPAY_OS_PENDING');
        $total = (float) $cart->getOrderTotal(true, Cart::BOTH);
        $this->module->validateOrder((int) $cart->id, $state, $total, $this->module->displayName, null, [], (int) $currency->id, false, $this->context->customer->secure_key);
        $order = new Order((int) $this->module->currentOrder);
        try {
            $qr = $this->module->generateQr($order);
            Db::getInstance()->execute('INSERT INTO `' . _DB_PREFIX_ . 'monapay_order` (`id_order`,`qr_id`,`qr_data_url`,`virtual_account_number`,`error_message`) VALUES (' . (int) $order->id . ',\'' . pSQL((string) ($qr['id'] ?? '')) . '\',\'' . pSQL((string) ($qr['qr_data_url'] ?? ''), true) . '\',\'' . pSQL((string) ($qr['virtual_account_number'] ?? '')) . '\',NULL) ON DUPLICATE KEY UPDATE qr_id=VALUES(qr_id),qr_data_url=VALUES(qr_data_url),virtual_account_number=VALUES(virtual_account_number),error_message=NULL');
        } catch (Throwable $exception) {
            Db::getInstance()->execute('INSERT INTO `' . _DB_PREFIX_ . 'monapay_order` (`id_order`,`error_message`) VALUES (' . (int) $order->id . ',\'' . pSQL($exception->getMessage(), true) . '\') ON DUPLICATE KEY UPDATE error_message=VALUES(error_message)');
        }
        Tools::redirect($this->context->link->getPageLink('order-confirmation', true, (int) $currency->id, ['id_cart' => (int) $cart->id, 'id_module' => (int) $this->module->id, 'id_order' => (int) $order->id, 'key' => $this->context->customer->secure_key]));
    }
}
