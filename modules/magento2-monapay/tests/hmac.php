<?php
require_once dirname(__DIR__) . '/Model/WebhookVerifier.php';

use Mona\MonaPay\Model\WebhookVerifier;

$body = '{"amount":2500000,"description":"DH123","transaction_code":"FT26240001234","account_number":"MONA00000123","type":"income"}';
$timestamp = '1756355400';
$secret = '0123456789abcdef0123456789abcdef';
$known = 'sha256=c7b09ff9e0e8eaee7d31e9c35f08fb41222543b8d6e793f1c4eed5b23008d28a';
$checks = [
    'known vector' => WebhookVerifier::verify($body, $timestamp, $known, $secret, 1756355400),
    'raw body mutation' => !WebhookVerifier::verify($body . ' ', $timestamp, $known, $secret, 1756355400),
    'stale timestamp' => !WebhookVerifier::verify($body, $timestamp, $known, $secret, 1756355701),
    'bad signature' => !WebhookVerifier::verify($body, $timestamp, 'sha256=' . str_repeat('0', 64), $secret, 1756355400),
];
foreach ($checks as $name => $ok) {
    fwrite($ok ? STDOUT : STDERR, ($ok ? 'PASS ' : 'FAIL ') . $name . PHP_EOL);
}
exit(in_array(false, $checks, true) ? 1 : 0);
