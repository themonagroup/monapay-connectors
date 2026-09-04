<?php
namespace Opencart\System\Library\Extension\Monapay;

final class Hmac
{
    public static function verifyWebhook(string $rawBody, string $timestamp, string $signature, string $secret, ?int $now = null): bool
    {
        if ($secret === '' || !preg_match('/^[0-9]{1,12}$/', $timestamp) || !preg_match('/^sha256=[a-f0-9]{64}$/', $signature)) {
            return false;
        }

        if (abs(($now ?? time()) - (int) $timestamp) > 300) {
            return false;
        }

        $expected = 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
        return hash_equals($expected, $signature);
    }

    public static function verifyReturn(string $checkoutId, string $orderCode, string $status, string $timestamp, string $signature, string $secret, ?int $now = null): bool
    {
        if ($secret === '' || $checkoutId === '' || $orderCode === '' || $status !== 'paid') {
            return false;
        }

        if (!preg_match('/^[0-9]{1,12}$/', $timestamp) || !preg_match('/^[a-f0-9]{64}$/', $signature)) {
            return false;
        }

        if (abs(($now ?? time()) - (int) $timestamp) > 300) {
            return false;
        }

        $message = $checkoutId . '|' . $orderCode . '|paid|' . $timestamp;
        return hash_equals(hash_hmac('sha256', $message, $secret), $signature);
    }
}
