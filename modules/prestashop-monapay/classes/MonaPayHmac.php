<?php

final class MonaPayHmac
{
    public static function verifyWebhook($rawBody, $timestamp, $signature, $secret, $now = null, $tolerance = 300)
    {
        if (!is_string($rawBody) || !self::validTimestamp($timestamp, $now, $tolerance)) {
            return false;
        }
        if (!is_string($secret) || $secret === '' || !is_string($signature)) {
            return false;
        }
        if (!preg_match('/^sha256=[a-f0-9]{64}$/', $signature)) {
            return false;
        }

        $expected = 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
        return hash_equals($expected, $signature);
    }

    public static function verifyReturn($checkoutId, $orderCode, $status, $timestamp, $signature, $secret, $now = null, $tolerance = 300)
    {
        if (!is_string($checkoutId) || $checkoutId === '' || !is_string($orderCode) || $orderCode === '') {
            return false;
        }
        if ($status !== 'paid' || !self::validTimestamp($timestamp, $now, $tolerance)) {
            return false;
        }
        if (!is_string($secret) || $secret === '' || !is_string($signature)) {
            return false;
        }
        if (!preg_match('/^[a-f0-9]{64}$/', $signature)) {
            return false;
        }

        $message = $checkoutId . '|' . $orderCode . '|paid|' . $timestamp;
        $expected = hash_hmac('sha256', $message, $secret);
        return hash_equals($expected, $signature);
    }

    // Kept as a compatibility alias for integrations that used the 0.1 scaffold.
    public static function verify($rawBody, $timestamp, $signature, $secret, $now = null)
    {
        return self::verifyWebhook($rawBody, $timestamp, $signature, $secret, $now);
    }

    private static function validTimestamp($timestamp, $now, $tolerance)
    {
        if (!is_string($timestamp) || !preg_match('/^[0-9]{1,12}$/', $timestamp)) {
            return false;
        }

        $current = $now === null ? time() : (int) $now;
        return abs($current - (int) $timestamp) <= (int) $tolerance;
    }
}
