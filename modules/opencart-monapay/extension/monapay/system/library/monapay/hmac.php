<?php
namespace Opencart\System\Library\Monapay;

final class Hmac
{
    public static function verify(string $rawBody, string $timestamp, string $signature, string $secret, ?int $now = null): bool
    {
        if ($secret === '' || !preg_match('/^[0-9]{1,12}$/', $timestamp) || !preg_match('/^sha256=[a-f0-9]{64}$/', $signature)) {
            return false;
        }
        if (abs(($now ?? time()) - (int) $timestamp) > 300) {
            return false;
        }
        return hash_equals('sha256=' . hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret), $signature);
    }
}
