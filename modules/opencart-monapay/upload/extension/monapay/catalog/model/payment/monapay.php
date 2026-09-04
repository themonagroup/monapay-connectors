<?php
namespace Opencart\Catalog\Model\Extension\Monapay\Payment;

class Monapay extends \Opencart\System\Engine\Model
{
    public function getMethods(array $address = []): array
    {
        unset($address);

        if (!$this->config->get('payment_monapay_status') || ($this->session->data['currency'] ?? '') !== 'VND') {
            return [];
        }

        $title = (string) ($this->config->get('payment_monapay_title') ?: 'Thanh toán qua MONA Pay');

        return [
            'code' => 'monapay',
            'name' => $title,
            'option' => [
                'monapay' => [
                    'code' => 'monapay.monapay',
                    'name' => $title,
                ],
            ],
            'sort_order' => (int) $this->config->get('payment_monapay_sort_order'),
        ];
    }

    public function createCheckout(array $payload, string $idempotencyKey): array
    {
        return $this->request('POST', '/api/v1/checkouts', $payload, $idempotencyKey);
    }

    public function getCheckout(string $checkoutId): array
    {
        $checkoutId = trim($checkoutId);
        if ($checkoutId === '') {
            throw new \RuntimeException('Mã phiên thanh toán MONA Pay không hợp lệ.');
        }

        return $this->request('GET', '/api/v1/checkouts/' . rawurlencode($checkoutId));
    }

    private function request(string $method, string $path, ?array $payload = null, string $idempotencyKey = ''): array
    {
        $token = $this->accessToken();
        $headers = [
            'Accept: application/json',
            'Authorization: Bearer ' . $token,
        ];

        if ($method !== 'GET') {
            $headers[] = 'Content-Type: application/json';
            $headers[] = 'X-Client-Secret: ' . $this->required('client_secret');
        }

        if ($idempotencyKey !== '') {
            $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
        }

        return $this->call($method, $path, $payload, $headers);
    }

    private function accessToken(): string
    {
        $data = $this->call(
            'POST',
            '/api/v1/oauth/token',
            [
                'grant_type' => 'client_credentials',
                'client_id' => $this->required('client_id'),
                'client_secret' => $this->required('client_secret'),
            ],
            ['Accept: application/json', 'Content-Type: application/json']
        );

        $token = $data['access_token'] ?? '';
        if (!is_string($token) || $token === '') {
            throw new \RuntimeException('MONA Pay không trả access_token.');
        }

        return $token;
    }

    private function call(string $method, string $path, ?array $payload, array $headers): array
    {
        if (!function_exists('curl_init')) {
            throw new \RuntimeException('PHP cURL is required.');
        }

        $curl = curl_init($this->baseUrl() . $path);
        $options = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_HTTPHEADER => $headers,
        ];

        if ($payload !== null) {
            $encoded = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($encoded === false) {
                throw new \RuntimeException('Không thể mã hoá request MONA Pay.');
            }
            $options[CURLOPT_POSTFIELDS] = $encoded;
        }

        curl_setopt_array($curl, $options);
        $raw = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
        $error = curl_error($curl);
        curl_close($curl);

        if ($raw === false) {
            throw new \RuntimeException('Lỗi kết nối MONA Pay: ' . $error);
        }

        $body = json_decode($raw, true);
        if ($status < 200 || $status >= 300 || !is_array($body) || (isset($body['success']) && !$body['success']) || !is_array($body['data'] ?? null)) {
            $message = is_array($body) ? ($body['message'] ?? $body['detail'] ?? 'invalid response') : 'invalid JSON';
            throw new \RuntimeException('MONA Pay API error (' . $status . '): ' . (is_string($message) ? $message : 'validation failed'));
        }

        return $body['data'];
    }

    private function required(string $key): string
    {
        $value = trim((string) $this->config->get('payment_monapay_' . $key));
        if ($value === '') {
            throw new \RuntimeException('Thiếu cấu hình MONA Pay: ' . $key);
        }

        return $value;
    }

    private function baseUrl(): string
    {
        return rtrim((string) preg_replace('#/api/v1/?$#i', '', $this->required('base_url')), '/');
    }
}
