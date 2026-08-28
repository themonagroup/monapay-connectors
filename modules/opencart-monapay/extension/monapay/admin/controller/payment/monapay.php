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
        if ($this->request->server['REQUEST_METHOD'] === 'POST' && $this->validate()) {
            $this->model_setting_setting->editSetting('payment_monapay', $this->request->post);
            $this->session->data['success'] = $this->language->get('text_success');
            $this->response->redirect($this->url->link('marketplace/extension', 'user_token=' . $this->session->data['user_token'] . '&type=payment'));
            return;
        }
        $keys = ['status', 'title', 'base_url', 'username', 'password', 'client_secret', 'webhook_secret', 'owner_number', 'owner_type', 'merchant_id', 'terminal_id', 'va_prefix', 'beneficiary_name', 'order_status_id'];
        foreach ($keys as $key) {
            $name = 'payment_monapay_' . $key;
            $data[$name] = $this->request->post[$name] ?? $this->config->get($name);
        }
        $data['error_warning'] = $this->error['warning'] ?? '';
        $data['save'] = $this->url->link('extension/monapay/payment/monapay', 'user_token=' . $this->session->data['user_token']);
        $data['back'] = $this->url->link('marketplace/extension', 'user_token=' . $this->session->data['user_token'] . '&type=payment');
        $data['header'] = $this->load->controller('common/header');
        $data['column_left'] = $this->load->controller('common/column_left');
        $data['footer'] = $this->load->controller('common/footer');
        $this->load->model('localisation/order_status');
        $data['order_statuses'] = $this->model_localisation_order_status->getOrderStatuses();
        $this->response->setOutput($this->load->view('extension/monapay/payment/monapay', $data));
    }

    public function install(): void
    {
        if (!$this->user->hasPermission('modify', 'extension/monapay/payment/monapay')) {
            return;
        }
        $this->db->query("CREATE TABLE IF NOT EXISTS `" . DB_PREFIX . "monapay_transaction` (`transaction_code` varchar(191) NOT NULL, `order_id` int(11) NOT NULL, `created_at` datetime NOT NULL, PRIMARY KEY (`transaction_code`), KEY `order_id` (`order_id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    }

    private function validate(): bool
    {
        if (!$this->user->hasPermission('modify', 'extension/monapay/payment/monapay')) {
            $this->error['warning'] = $this->language->get('error_permission');
        }
        return !$this->error;
    }
}
