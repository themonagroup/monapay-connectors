<?php

final class MonaPayApi
{
    private $baseUrl;
    private $clientId;
    private $clientSecret;

    public function __construct($baseUrl, $clientId, $clientSecret)
    {
        $this->baseUrl = rtrim((string) preg_replace('#/api/v1/?$#i', '', trim((string) $baseUrl)), '/');
        $this->clientId = trim((string) $clientId);
        $this->clientSecret = trim((string) $clientSecret);

        $parts = parse_url($this->baseUrl);
        if (!filter_var($this->baseUrl, FILTER_VALIDATE_URL)
            || !is_array($parts)
            || !isset($parts['scheme'], $parts['host'])
            || strtolower($parts['scheme']) !== 'https'
            || isset($parts['user'])
            || isset($parts['pass'])
            || $this->clientId === ''
            || $this->clientSecret === ''
        ) {
            throw new RuntimeException('Cấu hình API MONA Pay chưa đầy đủ hoặc Base URL không dùng HTTPS.');
        }
    }

    public function createCheckout(array $payload, $idempotencyKey)
    {
        $idempotencyKey = trim((string) $idempotencyKey);
        if ($idempotencyKey === '') {
            throw new RuntimeException('Idempotency-Key không được để trống.');
        }

        return $this->request('POST', '/api/v1/checkouts', $payload, array('Idempotency-Key: ' . $idempotencyKey));
    }

    public function getCheckout($checkoutId)
    {
        $checkoutId = trim((string) $checkoutId);
        if ($checkoutId === '') {
            throw new RuntimeException('Mã checkout MONA Pay không hợp lệ.');
        }

        return $this->request('GET', '/api/v1/checkouts/' . rawurlencode($checkoutId));
    }

    public static function clearTokenCache()
    {
        if (defined('_DB_PREFIX_')) {
            Db::getInstance()->execute('DELETE FROM `' . _DB_PREFIX_ . 'monapay_token`');
        }
    }

    private function request($method, $path, array $payload = null, array $extraHeaders = array(), $retry = true)
    {
        $token = $this->getAccessToken();
        $headers = array_merge(array(
            'Accept: application/json',
            'Authorization: Bearer ' . $token,
            'X-Client-Secret: ' . $this->clientSecret,
        ), $extraHeaders);

        $rawBody = null;
        if ($payload !== null) {
            $rawBody = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if (!is_string($rawBody)) {
                throw new RuntimeException('Không thể mã hóa request MONA Pay.');
            }
            $headers[] = 'Content-Type: application/json';
        }

        list($status, $response) = $this->send($method, $this->baseUrl . $path, $headers, $rawBody);
        if ($status === 401 && $retry) {
            $this->deleteCachedToken();
            return $this->request($method, $path, $payload, $extraHeaders, false);
        }

        return $this->responseData($status, $response);
    }

    private function getAccessToken()
    {
        $cacheKey = $this->tokenCacheKey();
        $row = Db::getInstance()->getRow(
            'SELECT `access_token`, `expires_at` FROM `' . _DB_PREFIX_ . "monapay_token` WHERE `cache_key` = '" . pSQL($cacheKey) . "' LIMIT 1"
        );
        if (is_array($row) && !empty($row['access_token']) && (int) $row['expires_at'] > time()) {
            return (string) $row['access_token'];
        }

        $form = http_build_query(array(
            'grant_type' => 'client_credentials',
            'client_id' => $this->clientId,
            'client_secret' => $this->clientSecret,
        ), '', '&');
        list($status, $response) = $this->send(
            'POST',
            $this->baseUrl . '/api/v1/oauth/token',
            array('Accept: application/json', 'Content-Type: application/x-www-form-urlencoded'),
            $form
        );
        $data = $this->responseData($status, $response);
        $token = isset($data['access_token']) ? trim((string) $data['access_token']) : '';
        if ($token === '') {
            throw new RuntimeException('MONA Pay OAuth không trả access_token.');
        }

        $expiresIn = isset($data['expires_in']) ? max(1, (int) $data['expires_in']) : 3600;
        $buffer = min(60, max(1, (int) floor($expiresIn / 10)));
        $expiresAt = time() + max(1, $expiresIn - $buffer);
        $sql = 'INSERT INTO `' . _DB_PREFIX_ . "monapay_token` (`cache_key`, `access_token`, `expires_at`) VALUES ('"
            . pSQL($cacheKey) . "', '" . pSQL($token, true) . "', " . (int) $expiresAt . ') '
            . 'ON DUPLICATE KEY UPDATE `access_token` = VALUES(`access_token`), `expires_at` = VALUES(`expires_at`)';
        if (!Db::getInstance()->execute($sql)) {
            throw new RuntimeException('Không thể cache access token MONA Pay.');
        }

        return $token;
    }

    private function send($method, $url, array $headers, $body = null)
    {
        if (!function_exists('curl_init')) {
            throw new RuntimeException('PHP cURL là bắt buộc để kết nối MONA Pay.');
        }

        $curl = curl_init($url);
        $options = array(
            CURLOPT_CUSTOMREQUEST => strtoupper((string) $method),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_USERAGENT => 'MONA-Pay-PrestaShop/0.2.0',
        );
        if (defined('CURLOPT_PROTOCOLS') && defined('CURLPROTO_HTTPS')) {
            $options[CURLOPT_PROTOCOLS] = CURLPROTO_HTTPS;
        }
        if ($body !== null) {
            $options[CURLOPT_POSTFIELDS] = $body;
        }

        curl_setopt_array($curl, $options);
        $response = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
        $error = curl_error($curl);
        curl_close($curl);

        if ($response === false) {
            throw new RuntimeException('Không thể kết nối MONA Pay: ' . $error);
        }

        return array($status, (string) $response);
    }

    private function responseData($status, $response)
    {
        $json = json_decode((string) $response, true);
        if ($status < 200 || $status >= 300 || !is_array($json) || (isset($json['success']) && !$json['success'])) {
            $message = 'response không hợp lệ';
            if (is_array($json) && isset($json['message']) && is_string($json['message'])) {
                $message = $json['message'];
            } elseif (is_array($json) && isset($json['detail']) && is_string($json['detail'])) {
                $message = $json['detail'];
            } elseif (is_array($json) && isset($json['detail']) && is_array($json['detail'])) {
                $message = json_encode($json['detail'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            }
            throw new RuntimeException('MONA Pay API lỗi HTTP ' . (int) $status . ': ' . $message);
        }

        return isset($json['data']) && is_array($json['data']) ? $json['data'] : array();
    }

    private function tokenCacheKey()
    {
        return hash('sha256', $this->baseUrl . '|' . $this->clientId);
    }

    private function deleteCachedToken()
    {
        Db::getInstance()->delete('monapay_token', "`cache_key` = '" . pSQL($this->tokenCacheKey()) . "'");
    }
}
