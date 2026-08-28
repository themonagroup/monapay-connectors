<?php
namespace Mona\MonaPay\Model;

use Magento\Framework\Exception\LocalizedException;
use Magento\Framework\HTTP\Client\Curl;
use Magento\Framework\Serialize\Serializer\Json;
use Magento\Store\Model\ScopeInterface;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Sales\Api\Data\OrderInterface;

class ApiClient
{
    private Curl $curl;
    private Json $json;
    private ScopeConfigInterface $config;
    private ?string $token = null;

    public function __construct(Curl $curl, Json $json, ScopeConfigInterface $config)
    {
        $this->curl = $curl;
        $this->json = $json;
        $this->config = $config;
    }

    public function generateQr(OrderInterface $order): array
    {
        if ($order->getOrderCurrencyCode() !== 'VND') {
            throw new LocalizedException(__('MONA Pay requires VND orders.'));
        }
        $orderCode = 'DH' . $order->getIncrementId();
        return $this->request('/api/v1/acb/qr-payment/generate', [
            'ownerNumber' => $this->value('owner_number'),
            'ownerType' => $this->value('owner_type'),
            'merchantId' => $this->value('merchant_id'),
            'terminalId' => $this->value('terminal_id'),
            'orderId' => $orderCode,
            'virtualAccountPrefix' => $this->value('virtual_account_prefix'),
            'beneficiaryName' => $this->value('beneficiary_name'),
            'amount' => (int) round((float) $order->getGrandTotal()),
            'description' => 'Thanh toan ' . $orderCode,
            'traceNumber' => $orderCode,
        ]);
    }

    private function request(string $path, array $payload, bool $retry = true): array
    {
        $token = $this->accessToken();
        $this->curl->setTimeout(20);
        $this->curl->addHeader('Accept', 'application/json');
        $this->curl->addHeader('Content-Type', 'application/json');
        $this->curl->addHeader('Authorization', 'Bearer ' . $token);
        $this->curl->addHeader('X-Client-Secret', $this->required('client_secret'));
        $this->curl->post($this->baseUrl() . $path, $this->json->serialize($payload));
        $status = $this->curl->getStatus();
        $body = $this->decode($this->curl->getBody());
        if ($status === 401 && $retry) {
            $this->token = null;
            return $this->request($path, $payload, false);
        }
        if ($status < 200 || $status >= 300 || empty($body['success']) || !is_array($body['data'] ?? null)) {
            throw new LocalizedException(__('MONA Pay API error (%1): %2', $status, $this->message($body)));
        }
        return $body['data'];
    }

    private function accessToken(): string
    {
        if ($this->token !== null) {
            return $this->token;
        }
        $this->curl->setTimeout(20);
        $this->curl->addHeader('Accept', 'application/json');
        $this->curl->addHeader('Content-Type', 'application/json');
        $this->curl->post($this->baseUrl() . '/api/v1/client/login', $this->json->serialize([
            'username' => $this->required('username'),
            'password' => $this->required('password'),
        ]));
        $body = $this->decode($this->curl->getBody());
        $token = $body['data']['access_token'] ?? '';
        if ($this->curl->getStatus() < 200 || $this->curl->getStatus() >= 300 || empty($body['success']) || !is_string($token) || $token === '') {
            throw new LocalizedException(__('MONA Pay login failed: %1', $this->message($body)));
        }
        $this->token = $token;
        return $token;
    }

    private function baseUrl(): string
    {
        return rtrim(preg_replace('#/api/v1/?$#', '', $this->required('base_url')), '/');
    }

    private function required(string $key): string
    {
        $value = $this->value($key);
        if ($value === '') {
            throw new LocalizedException(__('MONA Pay setting "%1" is required.', $key));
        }
        return $value;
    }

    private function value(string $key): string
    {
        return trim((string) $this->config->getValue('payment/monapay/' . $key, ScopeInterface::SCOPE_STORE));
    }

    private function decode(string $raw): array
    {
        try {
            $decoded = $this->json->unserialize($raw);
            return is_array($decoded) ? $decoded : [];
        } catch (\InvalidArgumentException $exception) {
            return [];
        }
    }

    private function message(array $body): string
    {
        $message = $body['message'] ?? $body['detail'] ?? 'invalid response';
        return is_string($message) ? $message : 'validation failed';
    }
}
