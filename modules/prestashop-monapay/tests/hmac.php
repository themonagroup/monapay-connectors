<?php

require_once dirname(__DIR__) . '/classes/MonaPayHmac.php';

$body = '{"event":"CHECKOUT_PAID","checkout_id":"checkout-1","order_code":"DH123","transaction_code":"FT26240001234"}';
$timestamp = '1788487200';
$secret = '0123456789abcdef0123456789abcdef';
$webhookSignature = 'sha256=3904d5f78c01a5d69ee82106c988d3da8a2ec7efe7f96b99fadd3517b62d4a94';
$returnSignature = '13f7f3d8ac58e6ba5709391fa3c99985fe1668c9329ac7e57760eca05becafc2';

$checks = array(
    'webhook known vector' => MonaPayHmac::verifyWebhook($body, $timestamp, $webhookSignature, $secret, 1788487200),
    'webhook raw body mutation' => !MonaPayHmac::verifyWebhook($body . ' ', $timestamp, $webhookSignature, $secret, 1788487200),
    'webhook timestamp boundary' => MonaPayHmac::verifyWebhook($body, $timestamp, $webhookSignature, $secret, 1788487500),
    'webhook timestamp expired' => !MonaPayHmac::verifyWebhook($body, $timestamp, $webhookSignature, $secret, 1788487501),
    'webhook bad prefix' => !MonaPayHmac::verifyWebhook($body, $timestamp, substr($webhookSignature, 7), $secret, 1788487200),
    'return valid' => MonaPayHmac::verifyReturn('checkout-1', 'DH123', 'paid', $timestamp, $returnSignature, $secret, 1788487200),
    'return changed order' => !MonaPayHmac::verifyReturn('checkout-1', 'DH124', 'paid', $timestamp, $returnSignature, $secret, 1788487200),
    'return unsigned cancel rejected' => !MonaPayHmac::verifyReturn('checkout-1', 'DH123', 'cancelled', $timestamp, $returnSignature, $secret, 1788487200),
    'return sha256 prefix rejected' => !MonaPayHmac::verifyReturn('checkout-1', 'DH123', 'paid', $timestamp, 'sha256=' . $returnSignature, $secret, 1788487200),
);

foreach ($checks as $name => $ok) {
    fwrite($ok ? STDOUT : STDERR, ($ok ? 'PASS ' : 'FAIL ') . $name . PHP_EOL);
}

exit(in_array(false, $checks, true) ? 1 : 0);
