<?php
namespace Opencart\Catalog\Model\Extension\Monapay\Payment;

class Monapay extends \Opencart\System\Engine\Model
{
    public function getMethods(array $address = []): array
    {
        if (!$this->config->get('payment_monapay_status') || $this->session->data['currency'] !== 'VND') {
            return [];
        }
        $title = (string) ($this->config->get('payment_monapay_title') ?: 'Chuyển khoản VietQR (MONA Pay)');
        return [
            'code' => 'monapay',
            'name' => $title,
            'option' => ['monapay' => ['code' => 'monapay.monapay', 'name' => $title]],
            'sort_order' => 80,
        ];
    }

    public function generateQr(array $order): array
    {
        $orderCode = 'DH' . (int) $order['order_id'];
        $payload = [
            'ownerNumber' => $this->required('owner_number'),
            'ownerType' => $this->required('owner_type'),
            'merchantId' => $this->required('merchant_id'),
            'terminalId' => $this->required('terminal_id'),
            'orderId' => $orderCode,
            'virtualAccountPrefix' => $this->required('va_prefix'),
            'beneficiaryName' => $this->required('beneficiary_name'),
            'amount' => (int) round((float) $order['total']),
            'description' => 'Thanh toan ' . $orderCode,
            'traceNumber' => $orderCode,
        ];
        $login = $this->call('/api/v1/client/login', ['username' => $this->required('username'), 'password' => $this->required('password')], false);
        $token = $login['access_token'] ?? '';
        if (!is_string($token) || $token === '') {
            throw new \RuntimeException('MONA Pay login did not return access_token.');
        }
        return $this->call('/api/v1/acb/qr-payment/generate', $payload, true, $token);
    }

    private function call(string $path, array $payload, bool $write, string $token = ''): array
    {
        if (!function_exists('curl_init')) {
            throw new \RuntimeException('PHP cURL is required.');
        }
        $headers = ['Accept: application/json', 'Content-Type: application/json'];
        if ($token !== '') {
            $headers[] = 'Authorization: Bearer ' . $token;
        }
        if ($write) {
            $headers[] = 'X-Client-Secret: ' . $this->required('client_secret');
        }
        $curl = curl_init($this->baseUrl() . $path);
        curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_HTTPHEADER => $headers, CURLOPT_POSTFIELDS => json_encode($payload)]);
        $raw = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
        $error = curl_error($curl);
        curl_close($curl);
        if ($raw === false) {
            throw new \RuntimeException('MONA Pay transport error: ' . $error);
        }
        $body = json_decode($raw, true);
        if ($status < 200 || $status >= 300 || !is_array($body) || empty($body['success']) || !is_array($body['data'] ?? null)) {
            $message = is_array($body) ? ($body['message'] ?? $body['detail'] ?? 'invalid response') : 'invalid JSON';
            throw new \RuntimeException('MONA Pay API error (' . $status . '): ' . (is_string($message) ? $message : 'validation failed'));
        }
        return $body['data'];
    }

    private function required(string $key): string
    {
        $value = trim((string) $this->config->get('payment_monapay_' . $key));
        if ($value === '') {
            throw new \RuntimeException('Missing MONA Pay setting: ' . $key);
        }
        return $value;
    }

    private function baseUrl(): string
    {
        return rtrim(preg_replace('#/api/v1/?$#', '', $this->required('base_url')), '/');
    }
}
