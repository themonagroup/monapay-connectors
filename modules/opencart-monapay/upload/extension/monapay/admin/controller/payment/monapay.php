<?php
namespace Opencart\Admin\Controller\Extension\Monapay\Payment;

class Monapay extends \Opencart\System\Engine\Controller
{
    private array $error = [];

    public function index(): void
    {
        $this->load->language('extension/monapay/payment/monapay');
        $this->document->setTitle($this->language->get('heading_title'));
        $this->load->model('setting/setting');

        if (($this->request->server['REQUEST_METHOD'] ?? '') === 'POST' && $this->validate()) {
            $this->model_setting_setting->editSetting('payment_monapay', $this->request->post);
            $this->session->data['success'] = $this->language->get('text_success');
            $this->response->redirect($this->url->link('marketplace/extension', 'user_token=' . $this->session->data['user_token'] . '&type=payment'));
            return;
        }

        $keys = [
            'status',
            'title',
            'base_url',
            'client_id',
            'client_secret',
            'webhook_secret',
            'return_signature_secret',
            'payment_mode',
            'sandbox',
            'order_status_id',
            'sort_order',
        ];

        foreach ($keys as $key) {
            $name = 'payment_monapay_' . $key;
            $data[$name] = $this->request->post[$name] ?? $this->config->get($name);
        }

        foreach ([
            'heading_title',
            'text_edit',
            'text_enabled',
            'text_disabled',
            'text_redirect',
            'entry_status',
            'entry_title',
            'entry_base_url',
            'entry_client_id',
            'entry_client_secret',
            'entry_webhook_secret',
            'entry_return_signature_secret',
            'entry_payment_mode',
            'entry_sandbox',
            'entry_order_status',
            'entry_sort_order',
            'help_webhook',
            'help_return_signature',
            'help_sandbox',
            'button_save',
            'button_cancel',
        ] as $languageKey) {
            $data[$languageKey] = $this->language->get($languageKey);
        }

        $data['error_warning'] = $this->error['warning'] ?? '';
        $data['save'] = $this->url->link('extension/monapay/payment/monapay', 'user_token=' . $this->session->data['user_token']);
        $data['back'] = $this->url->link('marketplace/extension', 'user_token=' . $this->session->data['user_token'] . '&type=payment');
        $data['webhook_url'] = HTTP_CATALOG . 'index.php?route=extension/monapay/payment/monapay.webhook';

        $this->load->model('localisation/order_status');
        $data['order_statuses'] = $this->model_localisation_order_status->getOrderStatuses();
        $data['header'] = $this->load->controller('common/header');
        $data['column_left'] = $this->load->controller('common/column_left');
        $data['footer'] = $this->load->controller('common/footer');

        $this->response->setOutput($this->load->view('extension/monapay/payment/monapay', $data));
    }

    public function install(): void
    {
        if (!$this->user->hasPermission('modify', 'extension/monapay/payment/monapay')) {
            return;
        }

        $this->db->query("CREATE TABLE IF NOT EXISTS `" . DB_PREFIX . "monapay_transaction` (
            `transaction_code` varchar(191) NOT NULL,
            `order_id` int(11) NOT NULL,
            `created_at` datetime NOT NULL,
            PRIMARY KEY (`transaction_code`),
            KEY `order_id` (`order_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $this->db->query("CREATE TABLE IF NOT EXISTS `" . DB_PREFIX . "monapay_checkout` (
            `order_id` int(11) NOT NULL,
            `checkout_id` varchar(64) NOT NULL,
            `checkout_url` text NOT NULL,
            `status` varchar(20) NOT NULL DEFAULT 'pending',
            `sandbox` tinyint(1) NOT NULL DEFAULT '0',
            `date_added` datetime NOT NULL,
            `date_modified` datetime NOT NULL,
            PRIMARY KEY (`order_id`),
            UNIQUE KEY `checkout_id` (`checkout_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    }

    private function validate(): bool
    {
        if (!$this->user->hasPermission('modify', 'extension/monapay/payment/monapay')) {
            $this->error['warning'] = $this->language->get('error_permission');
            return false;
        }

        $required = [
            'payment_monapay_base_url',
            'payment_monapay_client_id',
            'payment_monapay_client_secret',
            'payment_monapay_webhook_secret',
            'payment_monapay_return_signature_secret',
        ];

        foreach ($required as $key) {
            if (trim((string) ($this->request->post[$key] ?? '')) === '') {
                $this->error['warning'] = $this->language->get('error_required');
                break;
            }
        }

        $baseUrl = trim((string) ($this->request->post['payment_monapay_base_url'] ?? ''));
        if ($baseUrl !== '' && !preg_match('#^https://#i', $baseUrl)) {
            $this->error['warning'] = $this->language->get('error_https');
        }

        if (($this->request->post['payment_monapay_payment_mode'] ?? '') !== 'redirect') {
            $this->error['warning'] = $this->language->get('error_payment_mode');
        }

        return !$this->error;
    }
}
