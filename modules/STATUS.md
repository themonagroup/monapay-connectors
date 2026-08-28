# MODULES P2 STATUS — 2026-08-29

## Trạng thái

Đã hoàn thành scaffold P2 trong `connectors/modules/`, không cài dependency và không gọi API production:

- `magento2-monapay/`: registration/module/config, payment model, admin settings, API client login + tạo QR, thank-you block, webhook controller HMAC và test PHP.
- `opencart-monapay/`: package OpenCart 4 có admin controller/view, catalog payment model/controller/view, webhook route, ledger `transaction_code` và test PHP.
- `prestashop-monapay/`: module class, `hookPaymentOptions`, validation/payment-return, webhook controller, order state, hai bảng QR/ledger và test PHP.
- `ghost-monapay/`: service Node thuần kiểm webhook rồi dùng Ghost Admin API gắn label member theo mapping + expected amount; ledger file chống trùng và test Node.
- `bubble-monapay/`: JSON tham chiếu API Connector, hướng dẫn backend workflow và proxy Node thuần xác minh HMAC trước khi forward tới Bubble.

Mọi MONA endpoint trong code đều theo API truth: login `POST /api/v1/client/login`, tạo QR `POST /api/v1/acb/qr-payment/generate`, Bearer cho mọi API request và `X-Client-Secret` cho POST. Webhook dùng raw body, `X-Mona-Timestamp`, `X-Mona-Signature`, tolerance 300 giây và constant-time comparison.

## Giới hạn đã ghi rõ trong README/code

- `qr_data_url` là payload EMVCo, không phải URL ảnh. Magento/OpenCart/PrestaShop giữ/hiển thị payload và có TODO kiểm renderer QR nội bộ của đúng theme; không gửi dữ liệu thanh toán sang dịch vụ QR công cộng.
- Route/hook/payment-method shape của OpenCart 4, hook/email/multi-shop của PrestaShop và order/renderer Magento phải smoke test trên đúng version/theme của shop.
- Ghost không có checkout provider plugin: label `MONA Pay paid` chỉ là dấu quản trị, không tạo native paid subscription hoặc tự mở Ghost paid tier. Mapping bắt buộc có member UUID và `expectedAmount`.
- Bubble không có schema API Connector export ổn định; `api-connector.json` là reference để nhập thủ công. Bubble không được nhận webhook trực tiếp nếu chưa chứng minh truy cập raw body; proxy là trust boundary.
- Ledger file Ghost chỉ dành cho một process nhỏ. Production nhiều replica phải dùng database có UNIQUE `transaction_code`.

## Kết quả gate

- `find connectors/modules devtools/browser-extension -type f -name '*.js' ... node --check`: **PASS**.
- `node --test` cho Ghost, Bubble và browser QR: **PASS, 4/4 test**. Phần module bao phủ vector HMAC đã biết, raw-body mutation, timestamp cũ, chữ ký sai và parser member reference.
- So ma trận QR extension với encoder CLI đã có trong repo trên 3 payload: **PASS**.
- Parse JSON (`composer.json`, OpenCart `install.json`, 2 package.json, Bubble API Connector): **PASS**.
- Parse 5 XML Magento bằng `xmllint --noout`: **PASS**.
- `php -l` toàn bộ PHP: **CHƯA CHẠY — BLOCKED ENV**, máy hiện tại không có `php` CLI.
- `php tests/hmac.php` của Magento/OpenCart/PrestaShop: **CHƯA CHẠY — BLOCKED ENV** vì cùng lý do. Ba script dùng cùng known vector `sha256=c7b09f...08d28a`, cộng các case body/timestamp/signature sai.
- Scan tên nhà cung cấp bị cấm, tài khoản test production, trailing whitespace, `node_modules` và `vendor`: **PASS**, không phát hiện.

Chạy lại PHP gate trên máy có PHP phù hợp trước khi đóng gói:

```bash
find connectors/modules -type f -name '*.php' -print0 | xargs -0 -n1 php -l
php connectors/modules/magento2-monapay/tests/hmac.php
php connectors/modules/opencart-monapay/tests/hmac.php
php connectors/modules/prestashop-monapay/tests/hmac.php
```

## Việc Mon cần làm trước production

1. Cấp staging shop và version chính xác cho từng nền tảng; thử checkout VND, QR render/scan, trạng thái chờ → paid, email/hook và refresh trang thank-you.
2. Tạo webhook dummy tới staging, sau đó thử đủ tiền, thiếu tiền, sai chữ ký, timestamp quá 300 giây và gửi lại cùng `transaction_code`.
3. Chốt renderer QR nội bộ cho ba nền tảng PHP và mapping order/reference không đụng ID ngoài hệ thống.
4. Với Ghost, chốt ý nghĩa entitlement sau label và đưa ledger vào database nếu chạy nhiều process. Với Bubble, đặt proxy sau HTTPS và unique constraint cho Transaction.
5. Chỉ dùng credentials/merchant/terminal thật qua secret/config store của platform; không commit hoặc đưa vào browser HTML/log.
