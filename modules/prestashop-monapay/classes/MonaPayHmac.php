<?php

final class MonaPayHmac
{
    public static function verify($rawBody, $timestamp, $signature, $secret, $now = null)
    {
        if (!is_string($rawBody) || !is_string($timestamp) || !is_string($signature) || !is_string($secret) || $secret === '') {
            return false;
        }
        if (!preg_match('/^[0-9]{1,12}$/', $timestamp) || !preg_match('/^sha256=[a-f0-9]{64}$/', $signature)) {
            return false;
        }
        $current = $now === null ? time() : (int) $now;
        if (abs($current - (int) $timestamp) > 300) {
            return false;
        }
        return hash_equals('sha256=' . hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret), $signature);
    }
}
