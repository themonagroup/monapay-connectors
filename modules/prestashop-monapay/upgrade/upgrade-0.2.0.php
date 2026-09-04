<?php

if (!defined('_PS_VERSION_')) {
    exit;
}

function upgrade_module_0_2_0($module)
{
    $engine = _MYSQL_ENGINE_;
    $queries = array(
        'CREATE TABLE IF NOT EXISTS `' . _DB_PREFIX_ . 'monapay_checkout` (
            `id_order` int unsigned NOT NULL,
            `checkout_id` varchar(64) DEFAULT NULL,
            `checkout_token` varchar(64) DEFAULT NULL,
            `checkout_url` text DEFAULT NULL,
            `status` varchar(20) NOT NULL DEFAULT \'pending\',
            `sandbox` tinyint(1) unsigned NOT NULL DEFAULT 0,
            `attempt` int unsigned NOT NULL DEFAULT 1,
            `error_message` text DEFAULT NULL,
            `date_add` datetime NOT NULL,
            `date_upd` datetime NOT NULL,
            PRIMARY KEY (`id_order`),
            UNIQUE KEY `checkout_id` (`checkout_id`)
        ) ENGINE=' . $engine . ' DEFAULT CHARSET=utf8mb4',
        'CREATE TABLE IF NOT EXISTS `' . _DB_PREFIX_ . 'monapay_token` (
            `cache_key` char(64) NOT NULL,
            `access_token` text NOT NULL,
            `expires_at` int unsigned NOT NULL,
            PRIMARY KEY (`cache_key`)
        ) ENGINE=' . $engine . ' DEFAULT CHARSET=utf8mb4',
    );

    foreach ($queries as $query) {
        if (!Db::getInstance()->execute($query)) {
            return false;
        }
    }

    if (!Configuration::hasKey(MonaPay::CONFIG_BASE_URL)) {
        Configuration::updateValue(MonaPay::CONFIG_BASE_URL, 'https://api.monapay.vn');
    }
    if (!Configuration::hasKey(MonaPay::CONFIG_SANDBOX)) {
        Configuration::updateValue(MonaPay::CONFIG_SANDBOX, 1);
    }

    return $module->registerHook('displayPaymentReturn');
}
