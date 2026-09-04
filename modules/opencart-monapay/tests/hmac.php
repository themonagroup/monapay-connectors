<?php
require_once dirname(__DIR__) . '/upload/extension/monapay/system/library/hmac.php';

use Opencart\System\Library\Extension\Monapay\Hmac;

$body = '{"amount":2500000,"description":"DH123","transaction_code":"FT26240001234","account_number":"MONA00000123","type":"income"}';
$timestamp = '1756355400';
$secret = '0123456789abcdef0123456789abcdef';
$known = 'sha256=c7b09ff9e0e8eaee7d31e9c35f08fb41222543b8d6e793f1c4eed5b23008d28a';
$checks = [
    'known webhook vector' => Hmac::verifyWebhook($body, $timestamp, $known, $secret, 1756355400),
    'raw body mutation' => !Hmac::verifyWebhook($body . ' ', $timestamp, $known, $secret, 1756355400),
    'timestamp window' => !Hmac::verifyWebhook($body, $timestamp, $known, $secret, 1756355701),
    'bad webhook signature' => !Hmac::verifyWebhook($body, $timestamp, 'sha256=' . str_repeat('0', 64), $secret, 1756355400),
];

$checkoutId = '01f1a785-050e-7294-8f44-e37b23e629bb';
$orderCode = 'DH1001';
$returnTimestamp = '1788433200';
$returnSignature = hash_hmac('sha256', $checkoutId . '|' . $orderCode . '|paid|' . $returnTimestamp, $secret);
$checks['return signature'] = Hmac::verifyReturn($checkoutId, $orderCode, 'paid', $returnTimestamp, $returnSignature, $secret, 1788433200);
$checks['return order mutation'] = !Hmac::verifyReturn($checkoutId, 'DH1002', 'paid', $returnTimestamp, $returnSignature, $secret, 1788433200);
foreach ($checks as $name => $ok) fwrite($ok ? STDOUT : STDERR, ($ok ? 'PASS ' : 'FAIL ') . $name . PHP_EOL);
exit(in_array(false, $checks, true) ? 1 : 0);
