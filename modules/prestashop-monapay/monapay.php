<?php

if (!defined('_PS_VERSION_')) {
    exit;
}

use PrestaShop\PrestaShop\Core\Payment\PaymentOption;

class MonaPay extends PaymentModule
{
    private const KEYS = [
        'MONAPAY_BASE_URL', 'MONAPAY_USERNAME', 'MONAPAY_PASSWORD', 'MONAPAY_CLIENT_SECRET',
        'MONAPAY_WEBHOOK_SECRET', 'MONAPAY_OWNER_NUMBER', 'MONAPAY_OWNER_TYPE',
        'MONAPAY_MERCHANT_ID', 'MONAPAY_TERMINAL_ID', 'MONAPAY_VA_PREFIX', 'MONAPAY_BENEFICIARY_NAME',
    ];

    public function __construct()
    {
        $this->name = 'monapay';
        $this->tab = 'payments_gateways';
        $this->version = '0.1.0';
        $this->author = 'The MONA Group';
        $this->need_instance = 0;
        $this->bootstrap = true;
        $this->currencies = true;
        $this->currencies_mode = 'checkbox';
        parent::__construct();
        $this->displayName = $this->l('MONA Pay VietQR');
        $this->description = $this->l('Dynamic VietQR and signed payment webhooks from MONA Pay.');
        $this->ps_versions_compliancy = ['min' => '1.7.8.0', 'max' => _PS_VERSION_];
    }

    public function install()
    {
        return parent::install()
            && $this->registerHook('paymentOptions')
            && $this->registerHook('paymentReturn')
            && Configuration::updateValue('MONAPAY_BASE_URL', 'https://api.monapay.vn')
            && Configuration::updateValue('MONAPAY_OWNER_TYPE', 'ORG')
            && $this->installTables()
            && $this->installPendingState();
    }

    public function uninstall()
    {
        foreach (self::KEYS as $key) {
            Configuration::deleteByName($key);
        }
        Configuration::deleteByName('MONAPAY_OS_PENDING');
        // Preserve payment/audit tables intentionally. Remove them manually only after exporting records.
        return parent::uninstall();
    }

    public function getContent()
    {
        $output = '';
        if (Tools::isSubmit('submitMonaPay')) {
            foreach (self::KEYS as $key) {
                Configuration::updateValue($key, trim((string) Tools::getValue($key)));
            }
            $output .= $this->displayConfirmation($this->l('Settings saved.'));
        }
        return $output . $this->renderForm();
    }

    public function hookPaymentOptions($params)
    {
        if (!$this->active || $this->context->currency->iso_code !== 'VND') {
            return [];
        }
        $option = new PaymentOption();
        $option->setCallToActionText($this->l('Pay by MONA Pay VietQR'))
            ->setAction($this->context->link->getModuleLink($this->name, 'validation', [], true))
            ->setAdditionalInformation($this->l('A VietQR with the exact order amount will be generated after you confirm.'));
        return [$option];
    }

    public function hookPaymentReturn($params)
    {
        $order = $params['order'] ?? null;
        if (!$order || $order->module !== $this->name) {
            return '';
        }
        $row = Db::getInstance()->getRow('SELECT * FROM `' . _DB_PREFIX_ . 'monapay_order` WHERE id_order=' . (int) $order->id);
        $this->context->smarty->assign([
            'monapay_qr_payload' => $row['qr_data_url'] ?? '',
            'monapay_va' => $row['virtual_account_number'] ?? '',
            'monapay_error' => $row['error_message'] ?? '',
        ]);
        return $this->fetch('module:monapay/views/templates/hook/payment_return.tpl');
    }

    public function generateQr(Order $order)
    {
        if ($order->id_currency !== (int) Currency::getIdByIsoCode('VND')) {
            throw new RuntimeException('MONA Pay requires a VND order.');
        }
        $orderCode = 'DH' . (int) $order->id;
        $login = $this->apiRequest('/api/v1/client/login', [
            'username' => $this->required('MONAPAY_USERNAME'),
            'password' => $this->required('MONAPAY_PASSWORD'),
        ], false);
        $token = $login['access_token'] ?? '';
        if (!is_string($token) || $token === '') {
            throw new RuntimeException('MONA Pay login did not return access_token.');
        }
        return $this->apiRequest('/api/v1/acb/qr-payment/generate', [
            'ownerNumber' => $this->required('MONAPAY_OWNER_NUMBER'),
            'ownerType' => $this->required('MONAPAY_OWNER_TYPE'),
            'merchantId' => $this->required('MONAPAY_MERCHANT_ID'),
            'terminalId' => $this->required('MONAPAY_TERMINAL_ID'),
            'orderId' => $orderCode,
            'virtualAccountPrefix' => $this->required('MONAPAY_VA_PREFIX'),
            'beneficiaryName' => $this->required('MONAPAY_BENEFICIARY_NAME'),
            'amount' => (int) round((float) $order->total_paid_tax_incl),
            'description' => 'Thanh toan ' . $orderCode,
            'traceNumber' => $orderCode,
        ], true, $token);
    }

    private function apiRequest($path, array $payload, $write, $token = '')
    {
        if (!function_exists('curl_init')) {
            throw new RuntimeException('PHP cURL is required.');
        }
        $headers = ['Accept: application/json', 'Content-Type: application/json'];
        if ($token !== '') {
            $headers[] = 'Authorization: Bearer ' . $token;
        }
        if ($write) {
            $headers[] = 'X-Client-Secret: ' . $this->required('MONAPAY_CLIENT_SECRET');
        }
        $curl = curl_init($this->baseUrl() . $path);
        curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_HTTPHEADER => $headers, CURLOPT_POSTFIELDS => json_encode($payload)]);
        $raw = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
        $error = curl_error($curl);
        curl_close($curl);
        if ($raw === false) {
            throw new RuntimeException('MONA Pay transport error: ' . $error);
        }
        $body = json_decode($raw, true);
        if ($status < 200 || $status >= 300 || !is_array($body) || empty($body['success']) || !is_array($body['data'] ?? null)) {
            $message = is_array($body) ? ($body['message'] ?? $body['detail'] ?? 'invalid response') : 'invalid JSON';
            throw new RuntimeException('MONA Pay API error (' . $status . '): ' . (is_string($message) ? $message : 'validation failed'));
        }
        return $body['data'];
    }

    private function required($key)
    {
        $value = trim((string) Configuration::get($key));
        if ($value === '') {
            throw new RuntimeException('Missing MONA Pay setting: ' . $key);
        }
        return $value;
    }

    private function baseUrl()
    {
        return rtrim(preg_replace('#/api/v1/?$#', '', $this->required('MONAPAY_BASE_URL')), '/');
    }

    private function installTables()
    {
        $engine = _MYSQL_ENGINE_;
        $sql = [
            'CREATE TABLE IF NOT EXISTS `' . _DB_PREFIX_ . 'monapay_transaction` (`transaction_code` varchar(191) NOT NULL, `id_order` int unsigned NOT NULL, `created_at` datetime NOT NULL, PRIMARY KEY (`transaction_code`), KEY `id_order` (`id_order`)) ENGINE=' . $engine . ' DEFAULT CHARSET=utf8mb4',
            'CREATE TABLE IF NOT EXISTS `' . _DB_PREFIX_ . 'monapay_order` (`id_order` int unsigned NOT NULL, `qr_id` varchar(191) DEFAULT NULL, `qr_data_url` text, `virtual_account_number` varchar(191) DEFAULT NULL, `error_message` text, PRIMARY KEY (`id_order`)) ENGINE=' . $engine . ' DEFAULT CHARSET=utf8mb4',
        ];
        foreach ($sql as $query) {
            if (!Db::getInstance()->execute($query)) {
                return false;
            }
        }
        return true;
    }

    private function installPendingState()
    {
        if ((int) Configuration::get('MONAPAY_OS_PENDING') > 0) {
            return true;
        }
        $state = new OrderState();
        $state->send_email = false;
        $state->module_name = $this->name;
        $state->color = '#4169E1';
        $state->unremovable = false;
        $state->hidden = false;
        $state->logable = false;
        $state->paid = false;
        foreach (Language::getLanguages(false) as $language) {
            $state->name[(int) $language['id_lang']] = 'Chờ thanh toán MONA Pay';
        }
        return $state->add() && Configuration::updateValue('MONAPAY_OS_PENDING', (int) $state->id);
    }

    private function renderForm()
    {
        $fields = [];
        foreach (self::KEYS as $key) {
            $secret = in_array($key, ['MONAPAY_PASSWORD', 'MONAPAY_CLIENT_SECRET', 'MONAPAY_WEBHOOK_SECRET'], true);
            $fields[] = ['type' => $secret ? 'password' : 'text', 'label' => $key, 'name' => $key, 'required' => true];
        }
        $helper = new HelperForm();
        $helper->module = $this;
        $helper->name_controller = $this->name;
        $helper->token = Tools::getAdminTokenLite('AdminModules');
        $helper->currentIndex = AdminController::$currentIndex . '&configure=' . $this->name;
        $helper->submit_action = 'submitMonaPay';
        $helper->fields_value = [];
        foreach (self::KEYS as $key) {
            $helper->fields_value[$key] = Configuration::get($key);
        }
        return $helper->generateForm([['form' => [
            'legend' => ['title' => $this->l('MONA Pay settings')],
            'description' => $this->l('Webhook URL: ') . $this->context->link->getModuleLink($this->name, 'webhook', [], true),
            'input' => $fields,
            'submit' => ['title' => $this->l('Save')],
        ]]]);
    }
}
