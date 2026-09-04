<?php

if (!defined('_PS_VERSION_')) {
    exit;
}

use PrestaShop\PrestaShop\Core\Payment\PaymentOption;

require_once __DIR__ . '/classes/MonaPayApi.php';
require_once __DIR__ . '/classes/MonaPayHmac.php';

class MonaPay extends PaymentModule
{
    const CONFIG_BASE_URL = 'MONAPAY_BASE_URL';
    const CONFIG_CLIENT_ID = 'MONAPAY_CLIENT_ID';
    const CONFIG_CLIENT_SECRET = 'MONAPAY_CLIENT_SECRET';
    const CONFIG_WEBHOOK_SECRET = 'MONAPAY_WEBHOOK_SECRET';
    const CONFIG_RETURN_SECRET = 'MONAPAY_RETURN_SIGNATURE_SECRET';
    const CONFIG_SANDBOX = 'MONAPAY_SANDBOX';
    const CONFIG_PENDING_STATE = 'MONAPAY_OS_PENDING';

    private static $configurationKeys = array(
        self::CONFIG_BASE_URL,
        self::CONFIG_CLIENT_ID,
        self::CONFIG_CLIENT_SECRET,
        self::CONFIG_WEBHOOK_SECRET,
        self::CONFIG_RETURN_SECRET,
        self::CONFIG_SANDBOX,
    );

    public function __construct()
    {
        $this->name = 'monapay';
        $this->tab = 'payments_gateways';
        $this->version = '0.2.0';
        $this->author = 'The MONA Group';
        $this->need_instance = 0;
        $this->bootstrap = true;
        $this->currencies = true;
        $this->currencies_mode = 'checkbox';
        $this->controllers = array('validation', 'webhook', 'return');

        parent::__construct();

        $this->displayName = $this->l('MONA Pay');
        $this->description = $this->l('Thanh toán VND qua trang thanh toán bảo mật của MONA Pay.');
        $this->confirmUninstall = $this->l('Gỡ module? Dữ liệu đối soát đơn hàng sẽ được giữ lại.');
        $this->ps_versions_compliancy = array('min' => '8.0.0', 'max' => '8.99.99');
    }

    public function install()
    {
        return parent::install()
            && Configuration::updateValue(self::CONFIG_BASE_URL, 'https://api.monapay.vn')
            && Configuration::updateValue(self::CONFIG_SANDBOX, 1)
            && $this->installTables()
            && $this->installPendingState()
            && $this->registerHook('paymentOptions')
            && $this->registerHook('displayPaymentReturn');
    }

    public function uninstall()
    {
        MonaPayApi::clearTokenCache();
        Db::getInstance()->execute('DROP TABLE IF EXISTS `' . _DB_PREFIX_ . 'monapay_token`');

        foreach (self::$configurationKeys as $key) {
            Configuration::deleteByName($key);
        }

        // Checkout and transaction tables are audit data and are intentionally preserved.
        return parent::uninstall();
    }

    public function getContent()
    {
        $output = '';

        if (Tools::isSubmit('submitMonaPay')) {
            $clientSecret = trim((string) Tools::getValue(self::CONFIG_CLIENT_SECRET));
            $webhookSecret = trim((string) Tools::getValue(self::CONFIG_WEBHOOK_SECRET));
            $returnSecret = trim((string) Tools::getValue(self::CONFIG_RETURN_SECRET));
            $values = array(
                self::CONFIG_BASE_URL => rtrim((string) Tools::getValue(self::CONFIG_BASE_URL), '/'),
                self::CONFIG_CLIENT_ID => trim((string) Tools::getValue(self::CONFIG_CLIENT_ID)),
                self::CONFIG_CLIENT_SECRET => $clientSecret !== '' ? $clientSecret : (string) Configuration::get(self::CONFIG_CLIENT_SECRET),
                self::CONFIG_WEBHOOK_SECRET => $webhookSecret !== '' ? $webhookSecret : (string) Configuration::get(self::CONFIG_WEBHOOK_SECRET),
                self::CONFIG_RETURN_SECRET => $returnSecret !== '' ? $returnSecret : (string) Configuration::get(self::CONFIG_RETURN_SECRET),
                self::CONFIG_SANDBOX => (int) ((bool) Tools::getValue(self::CONFIG_SANDBOX)),
            );

            $errors = $this->validateConfiguration($values);
            if ($errors) {
                foreach ($errors as $error) {
                    $output .= $this->displayError($error);
                }
            } else {
                foreach ($values as $key => $value) {
                    Configuration::updateValue($key, $value);
                }
                MonaPayApi::clearTokenCache();
                $output .= $this->displayConfirmation($this->l('Đã lưu cấu hình MONA Pay.'));
            }
        }

        return $output . $this->renderForm();
    }

    public function hookPaymentOptions($params)
    {
        if (!$this->active || !$this->isConfigured()) {
            return array();
        }

        if (!isset($this->context->currency) || $this->context->currency->iso_code !== 'VND') {
            return array();
        }

        $option = new PaymentOption();
        $option->setModuleName($this->name)
            ->setCallToActionText($this->l('Thanh toán qua MONA Pay'))
            ->setAction($this->context->link->getModuleLink($this->name, 'validation', array(), true))
            ->setAdditionalInformation(
                $this->l('Bạn sẽ được chuyển sang trang MONA Pay để quét VietQR. Đơn được xác nhận tự động sau khi thanh toán đủ.')
            );

        return array($option);
    }

    public function hookDisplayPaymentReturn($params)
    {
        $order = isset($params['order']) ? $params['order'] : null;
        if (!$order || $order->module !== $this->name) {
            return '';
        }

        $checkout = $this->getCheckoutByOrderId((int) $order->id);
        $status = $checkout ? (string) $checkout['status'] : 'pending';
        $this->context->smarty->assign(array(
            'monapay_status' => $status,
            'monapay_checkout_url' => $checkout ? (string) $checkout['checkout_url'] : '',
            'monapay_error' => $checkout ? (string) $checkout['error_message'] : '',
            'monapay_sandbox' => $checkout ? (bool) $checkout['sandbox'] : (bool) Configuration::get(self::CONFIG_SANDBOX),
        ));

        return $this->fetch('module:monapay/views/templates/hook/payment_return.tpl');
    }

    public function getApiClient()
    {
        return new MonaPayApi(
            (string) Configuration::get(self::CONFIG_BASE_URL),
            (string) Configuration::get(self::CONFIG_CLIENT_ID),
            (string) Configuration::get(self::CONFIG_CLIENT_SECRET)
        );
    }

    public function createHostedCheckout(Order $order, $attempt)
    {
        $currency = new Currency((int) $order->id_currency);
        if (!Validate::isLoadedObject($currency) || $currency->iso_code !== 'VND') {
            throw new RuntimeException('MONA Pay chỉ hỗ trợ đơn hàng VND.');
        }

        $amount = (int) round((float) $order->total_paid_tax_incl);
        if ($amount < 1000 || $amount > 1000000000) {
            throw new RuntimeException('Tổng đơn phải từ 1.000 đến 1.000.000.000 VND.');
        }

        $orderCode = $this->orderCode((int) $order->id);
        $returnUrl = $this->context->link->getModuleLink($this->name, 'return', array(), true);
        $payload = array(
            'amount' => $amount,
            'order_code' => $orderCode,
            'description' => 'Thanh toan don hang ' . $orderCode,
            'return_url' => $returnUrl,
            'cancel_url' => $returnUrl,
            'expires_in' => 900,
            'metadata' => array(
                'prestashop_order_id' => (int) $order->id,
                'prestashop_shop_id' => (int) $order->id_shop,
            ),
        );

        $customer = new Customer((int) $order->id_customer);
        if (Validate::isLoadedObject($customer)) {
            if (Validate::isEmail($customer->email)) {
                $payload['payer_email'] = (string) $customer->email;
            }
            $payerName = trim((string) $customer->firstname . ' ' . (string) $customer->lastname);
            if ($payerName !== '') {
                $payload['payer_name'] = function_exists('mb_substr')
                    ? mb_substr($payerName, 0, 255)
                    : substr($payerName, 0, 255);
            }
        }

        $sandbox = (bool) Configuration::get(self::CONFIG_SANDBOX);
        if ($sandbox) {
            $payload['sandbox'] = true;
        }

        $idempotencyKey = 'prestashop-' . (int) $order->id_shop . '-' . (int) $order->id . '-' . (int) $attempt;
        $checkout = $this->getApiClient()->createCheckout($payload, $idempotencyKey);
        $checkoutId = isset($checkout['id']) ? trim((string) $checkout['id']) : '';
        $checkoutToken = isset($checkout['token']) ? trim((string) $checkout['token']) : '';
        $checkoutUrl = isset($checkout['checkout_url']) ? trim((string) $checkout['checkout_url']) : '';

        if ($checkoutId === '' || $checkoutToken === '' || !$this->isHttpsUrl($checkoutUrl)) {
            throw new RuntimeException('Response tạo checkout thiếu id, token hoặc checkout_url HTTPS hợp lệ.');
        }

        $this->saveCheckout(array(
            'id_order' => (int) $order->id,
            'checkout_id' => $checkoutId,
            'checkout_token' => $checkoutToken,
            'checkout_url' => $checkoutUrl,
            'status' => 'pending',
            'sandbox' => $sandbox ? 1 : 0,
            'attempt' => (int) $attempt,
            'error_message' => null,
        ));

        return $checkout;
    }

    public function saveCheckoutError($idOrder, $attempt, $message)
    {
        $message = function_exists('mb_substr') ? mb_substr((string) $message, 0, 1000) : substr((string) $message, 0, 1000);
        $this->saveCheckout(array(
            'id_order' => (int) $idOrder,
            'checkout_id' => null,
            'checkout_token' => null,
            'checkout_url' => null,
            'status' => 'failed',
            'sandbox' => (int) ((bool) Configuration::get(self::CONFIG_SANDBOX)),
            'attempt' => (int) $attempt,
            'error_message' => $message,
        ));
    }

    public function getCheckoutByOrderId($idOrder)
    {
        $row = Db::getInstance()->getRow(
            'SELECT * FROM `' . _DB_PREFIX_ . 'monapay_checkout` WHERE `id_order` = ' . (int) $idOrder . '',
            false
        );

        return is_array($row) ? $row : false;
    }

    public function getCheckoutByCheckoutId($checkoutId)
    {
        $checkoutId = trim((string) $checkoutId);
        if ($checkoutId === '') {
            return false;
        }

        $row = Db::getInstance()->getRow(
            'SELECT * FROM `' . _DB_PREFIX_ . "monapay_checkout` WHERE `checkout_id` = '" . pSQL($checkoutId) . "'",
            false
        );

        return is_array($row) ? $row : false;
    }

    public function markCheckoutStatus($idOrder, $status, $errorMessage = null)
    {
        $allowed = array('pending', 'paid', 'cancelled', 'expired', 'failed');
        if (!in_array($status, $allowed, true)) {
            return false;
        }

        return Db::getInstance()->update(
            'monapay_checkout',
            array(
                'status' => pSQL($status),
                'error_message' => $errorMessage === null ? null : pSQL((string) $errorMessage, true),
                'date_upd' => date('Y-m-d H:i:s'),
            ),
            '`id_order` = ' . (int) $idOrder,
            0,
            true,
            true
        );
    }

    public function completePayment(Order $order, $transactionCode, $paidAmount, $checkoutId, $event)
    {
        $transactionCode = trim((string) $transactionCode);
        $checkoutId = trim((string) $checkoutId);
        $event = trim((string) $event);
        $paidAmount = is_numeric($paidAmount) ? (int) round((float) $paidAmount) : 0;
        $expectedAmount = (int) round((float) $order->total_paid_tax_incl);

        if (!Validate::isLoadedObject($order)
            || $order->module !== $this->name
            || $transactionCode === ''
            || strlen($transactionCode) > 191
            || $checkoutId === ''
            || strlen($checkoutId) > 64
            || !in_array($event, array('CHECKOUT_PAID', 'RETURN_RECONCILED'), true)
            || $paidAmount < $expectedAmount
        ) {
            return 'invalid';
        }

        $checkout = $this->getCheckoutByOrderId((int) $order->id);
        if (!$checkout || !hash_equals((string) $checkout['checkout_id'], $checkoutId)) {
            return 'invalid';
        }

        $db = Db::getInstance();
        $db->execute('START TRANSACTION');

        try {
            $existingRows = $db->executeS(
                'SELECT `id_order` FROM `' . _DB_PREFIX_ . "monapay_transaction` WHERE `transaction_code` = '" . pSQL($transactionCode) . "' FOR UPDATE",
                true
            );
            $existing = (is_array($existingRows) && count($existingRows)) ? $existingRows[0] : false;
            if ($existing && (int) $existing['id_order'] !== (int) $order->id) {
                throw new RuntimeException('Mã giao dịch đã thuộc một đơn hàng khác.');
            }

            if ($existing) {
                $order = new Order((int) $order->id);
                if (!Validate::isLoadedObject($order) || $order->module !== $this->name) {
                    throw new RuntimeException('Không thể tải lại đơn hàng MONA Pay.');
                }
            }

            if (!$existing) {
                $inserted = $db->insert('monapay_transaction', array(
                    'transaction_code' => pSQL($transactionCode),
                    'id_order' => (int) $order->id,
                    'created_at' => date('Y-m-d H:i:s'),
                ));
                if (!$inserted) {
                    throw new RuntimeException('Không thể lưu mã giao dịch MONA Pay.');
                }

                if (!$order->addOrderPayment($expectedAmount, $this->displayName, $transactionCode)) {
                    throw new RuntimeException('Không thể ghi nhận payment MONA Pay vào đơn hàng.');
                }
            }

            if ((int) $order->current_state !== (int) Configuration::get('PS_OS_PAYMENT')) {
                $history = new OrderHistory();
                $history->id_order = (int) $order->id;
                $history->changeIdOrderState((int) Configuration::get('PS_OS_PAYMENT'), $order, true);
                // Không gắn thanh toán với việc gửi email: mail lỗi (SMTP) vẫn phải đổi trạng thái đơn.
                if (!$history->add()) {
                    throw new RuntimeException('Không thể cập nhật trạng thái đơn hàng.');
                }
                try {
                    $history->sendEmail($order, array('{transaction_id}' => $transactionCode));
                } catch (Throwable $mailError) {
                    $this->log('Không gửi được email trạng thái đơn #' . (int) $order->id . ': ' . $mailError->getMessage(), 2);
                }
            }

            if (!$this->markCheckoutStatus((int) $order->id, 'paid')) {
                throw new RuntimeException('Không thể cập nhật trạng thái checkout.');
            }

            $db->execute('COMMIT');
        } catch (Throwable $exception) {
            $db->execute('ROLLBACK');
            $this->log('Không thể xác nhận thanh toán đơn #' . (int) $order->id . ': ' . $exception->getMessage(), 3);
            return 'invalid';
        }

        return $existing ? 'duplicate' : 'completed';
    }

    public function orderCode($idOrder)
    {
        return 'DH' . (int) $idOrder;
    }

    public function orderIdFromCode($orderCode)
    {
        if (!preg_match('/^DH([1-9][0-9]*)$/', (string) $orderCode, $matches)) {
            return 0;
        }

        return (int) $matches[1];
    }

    public function orderConfirmationUrl(Order $order, array $extra = array())
    {
        $customer = new Customer((int) $order->id_customer);
        $params = array_merge(array(
            'id_cart' => (int) $order->id_cart,
            'id_module' => (int) $this->id,
            'id_order' => (int) $order->id,
            'key' => Validate::isLoadedObject($customer) ? (string) $customer->secure_key : '',
        ), $extra);

        return $this->context->link->getPageLink('order-confirmation', true, (int) $order->id_lang, $params);
    }

    public function log($message, $severity = 1)
    {
        PrestaShopLogger::addLog('[MONA Pay] ' . (string) $message, (int) $severity, null, 'Order', null, true);
    }

    private function isConfigured()
    {
        foreach (array(self::CONFIG_BASE_URL, self::CONFIG_CLIENT_ID, self::CONFIG_CLIENT_SECRET, self::CONFIG_WEBHOOK_SECRET, self::CONFIG_RETURN_SECRET) as $key) {
            if (trim((string) Configuration::get($key)) === '') {
                return false;
            }
        }

        return $this->isHttpsUrl((string) Configuration::get(self::CONFIG_BASE_URL));
    }

    private function validateConfiguration(array $values)
    {
        $errors = array();
        if (!$this->isHttpsUrl($values[self::CONFIG_BASE_URL])) {
            $errors[] = $this->l('Base URL phải là địa chỉ HTTPS hợp lệ.');
        }

        foreach (array(
            self::CONFIG_CLIENT_ID => $this->l('Client ID'),
            self::CONFIG_CLIENT_SECRET => $this->l('Client Secret'),
            self::CONFIG_WEBHOOK_SECRET => $this->l('Webhook Secret'),
            self::CONFIG_RETURN_SECRET => $this->l('Return Signature Secret'),
        ) as $key => $label) {
            if (trim((string) $values[$key]) === '') {
                $errors[] = sprintf($this->l('%s không được để trống.'), $label);
            }
        }

        return $errors;
    }

    private function isHttpsUrl($url)
    {
        if (!filter_var((string) $url, FILTER_VALIDATE_URL)) {
            return false;
        }

        $parts = parse_url((string) $url);
        return is_array($parts)
            && isset($parts['scheme'], $parts['host'])
            && strtolower($parts['scheme']) === 'https'
            && !isset($parts['user'])
            && !isset($parts['pass']);
    }

    private function saveCheckout(array $data)
    {
        $idOrder = (int) $data['id_order'];
        $checkoutId = $data['checkout_id'] === null ? 'NULL' : "'" . pSQL((string) $data['checkout_id']) . "'";
        $checkoutToken = $data['checkout_token'] === null ? 'NULL' : "'" . pSQL((string) $data['checkout_token']) . "'";
        $checkoutUrl = $data['checkout_url'] === null ? 'NULL' : "'" . pSQL((string) $data['checkout_url'], true) . "'";
        $errorMessage = $data['error_message'] === null ? 'NULL' : "'" . pSQL((string) $data['error_message'], true) . "'";

        $sql = 'INSERT INTO `' . _DB_PREFIX_ . 'monapay_checkout` '
            . '(`id_order`, `checkout_id`, `checkout_token`, `checkout_url`, `status`, `sandbox`, `attempt`, `error_message`, `date_add`, `date_upd`) VALUES ('
            . $idOrder . ', ' . $checkoutId . ', ' . $checkoutToken . ', ' . $checkoutUrl . ", '" . pSQL((string) $data['status']) . "', "
            . (int) $data['sandbox'] . ', ' . (int) $data['attempt'] . ', ' . $errorMessage . ', NOW(), NOW()) '
            . 'ON DUPLICATE KEY UPDATE `checkout_id` = VALUES(`checkout_id`), `checkout_token` = VALUES(`checkout_token`), '
            . '`checkout_url` = VALUES(`checkout_url`), `status` = VALUES(`status`), `sandbox` = VALUES(`sandbox`), '
            . '`attempt` = VALUES(`attempt`), `error_message` = VALUES(`error_message`), `date_upd` = NOW()';

        if (!Db::getInstance()->execute($sql)) {
            throw new RuntimeException('Không thể lưu phiên thanh toán MONA Pay.');
        }
    }

    private function installTables()
    {
        $engine = _MYSQL_ENGINE_;
        $queries = array(
            'CREATE TABLE IF NOT EXISTS `' . _DB_PREFIX_ . 'monapay_checkout` (
                `id_order` int unsigned NOT NULL,
                `checkout_id` varchar(64) DEFAULT NULL,
                `checkout_token` varchar(64) DEFAULT NULL,
                `checkout_url` text DEFAULT NULL,
                `status` varchar(20) NOT NULL DEFAULT \'pending\',
                `sandbox` tinyint(1) unsigned NOT NULL DEFAULT 0,
                `attempt` int unsigned NOT NULL DEFAULT 1,
                `error_message` text DEFAULT NULL,
                `date_add` datetime NOT NULL,
                `date_upd` datetime NOT NULL,
                PRIMARY KEY (`id_order`),
                UNIQUE KEY `checkout_id` (`checkout_id`)
            ) ENGINE=' . $engine . ' DEFAULT CHARSET=utf8mb4',
            'CREATE TABLE IF NOT EXISTS `' . _DB_PREFIX_ . 'monapay_transaction` (
                `transaction_code` varchar(191) NOT NULL,
                `id_order` int unsigned NOT NULL,
                `created_at` datetime NOT NULL,
                PRIMARY KEY (`transaction_code`),
                KEY `id_order` (`id_order`)
            ) ENGINE=' . $engine . ' DEFAULT CHARSET=utf8mb4',
            'CREATE TABLE IF NOT EXISTS `' . _DB_PREFIX_ . 'monapay_token` (
                `cache_key` char(64) NOT NULL,
                `access_token` text NOT NULL,
                `expires_at` int unsigned NOT NULL,
                PRIMARY KEY (`cache_key`)
            ) ENGINE=' . $engine . ' DEFAULT CHARSET=utf8mb4',
        );

        foreach ($queries as $query) {
            if (!Db::getInstance()->execute($query)) {
                return false;
            }
        }

        return true;
    }

    private function installPendingState()
    {
        $existingId = (int) Configuration::get(self::CONFIG_PENDING_STATE);
        if ($existingId > 0 && Validate::isLoadedObject(new OrderState($existingId))) {
            return true;
        }

        $state = new OrderState();
        $state->send_email = false;
        $state->module_name = $this->name;
        $state->color = '#0057B8';
        $state->unremovable = false;
        $state->hidden = false;
        $state->logable = false;
        $state->paid = false;
        $state->shipped = false;
        $state->delivery = false;

        foreach (Language::getLanguages(false) as $language) {
            $state->name[(int) $language['id_lang']] = $language['iso_code'] === 'vi'
                ? 'Chờ thanh toán MONA Pay'
                : 'Awaiting MONA Pay payment';
        }

        return $state->add() && Configuration::updateValue(self::CONFIG_PENDING_STATE, (int) $state->id);
    }

    private function renderForm()
    {
        $webhookUrl = $this->context->link->getModuleLink($this->name, 'webhook', array(), true);
        $returnUrl = $this->context->link->getModuleLink($this->name, 'return', array(), true);

        $form = array(
            'form' => array(
                'legend' => array('title' => $this->l('Cấu hình MONA Pay')),
                'description' => $this->l('Webhook HMAC:') . ' ' . htmlspecialchars($webhookUrl, ENT_QUOTES, 'UTF-8')
                    . '<br>' . $this->l('Return URL (module tự gửi khi tạo checkout):') . ' '
                    . htmlspecialchars($returnUrl, ENT_QUOTES, 'UTF-8'),
                'input' => array(
                    array('type' => 'text', 'label' => $this->l('Base URL'), 'name' => self::CONFIG_BASE_URL, 'required' => true),
                    array('type' => 'text', 'label' => $this->l('Client ID'), 'name' => self::CONFIG_CLIENT_ID, 'required' => true),
                    array('type' => 'password', 'label' => $this->l('Client Secret'), 'name' => self::CONFIG_CLIENT_SECRET, 'desc' => $this->l('Để trống khi lưu để giữ secret hiện tại.')),
                    array('type' => 'password', 'label' => $this->l('Webhook Secret'), 'name' => self::CONFIG_WEBHOOK_SECRET, 'desc' => $this->l('Secret HMAC của cấu hình webhook. Để trống để giữ giá trị hiện tại.')),
                    array('type' => 'password', 'label' => $this->l('Return Signature Secret'), 'name' => self::CONFIG_RETURN_SECRET, 'desc' => $this->l('Secret trong hồ sơ Trang thanh toán. Đây không phải webhook secret.')),
                    array(
                        'type' => 'switch',
                        'label' => $this->l('Chế độ sandbox'),
                        'name' => self::CONFIG_SANDBOX,
                        'is_bool' => true,
                        'values' => array(
                            array('id' => 'sandbox_on', 'value' => 1, 'label' => $this->l('Bật')),
                            array('id' => 'sandbox_off', 'value' => 0, 'label' => $this->l('Tắt')),
                        ),
                    ),
                ),
                'submit' => array('title' => $this->l('Lưu cấu hình')),
            ),
        );

        $helper = new HelperForm();
        $helper->show_toolbar = false;
        $helper->table = $this->table;
        $helper->module = $this;
        $helper->default_form_language = (int) Configuration::get('PS_LANG_DEFAULT');
        $helper->allow_employee_form_lang = (int) Configuration::get('PS_BO_ALLOW_EMPLOYEE_FORM_LANG');
        $helper->identifier = $this->identifier;
        $helper->submit_action = 'submitMonaPay';
        $helper->currentIndex = AdminController::$currentIndex . '&configure=' . $this->name;
        $helper->token = Tools::getAdminTokenLite('AdminModules');
        $helper->tpl_vars = array('fields_value' => array());

        foreach (self::$configurationKeys as $key) {
            $helper->tpl_vars['fields_value'][$key] = in_array($key, array(
                self::CONFIG_CLIENT_SECRET,
                self::CONFIG_WEBHOOK_SECRET,
                self::CONFIG_RETURN_SECRET,
            ), true) ? '' : Configuration::get($key);
        }

        return $helper->generateForm(array($form));
    }
}
