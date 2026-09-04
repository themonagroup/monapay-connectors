# MONA Pay Hosted Checkout cho PrestaShop 8

Payment module cho PrestaShop 8.x. Module tạo đơn VND ở trạng thái **Chờ
thanh toán MONA Pay**, gọi hosted checkout rồi chuyển khách sang
`checkout_url` tại `pay.monapay.vn`.

## Luồng thanh toán

1. `hookPaymentOptions()` thêm phương thức **Thanh toán qua MONA Pay**.
2. `controllers/front/validation.php` tạo order chờ thanh toán, lấy OAuth
   token bằng client credentials, gọi `POST /api/v1/checkouts` với
   `Idempotency-Key` và redirect khách sang `checkout_url`.
3. MONA Pay gọi `/module/monapay/webhook`; module xác minh HMAC-SHA256 trên
   raw body, cửa sổ timestamp 300 giây, chỉ xử lý `CHECKOUT_PAID` khớp đúng
   checkout, mã đơn và số tiền.
4. Module chống trùng bằng primary key `transaction_code`, rồi đổi đơn sang
   trạng thái PrestaShop **Payment accepted**.
5. `/module/monapay/return` xác minh chữ ký redirect, gọi lại
   `GET /api/v1/checkouts/{id}` và chỉ xác nhận đơn khi kết quả server-side là
   `paid`. Webhook/API là nguồn sự thật; query trên trình duyệt không đủ để
   giao hàng.

Module dùng ba bảng:

- `ps_monapay_checkout`: ánh xạ order ↔ hosted checkout và trạng thái.
- `ps_monapay_transaction`: ledger chống xử lý trùng theo
  `transaction_code`.
- `ps_monapay_token`: cache access token OAuth đến trước hạn 60 giây.

Hai bảng đầu được giữ lại khi uninstall để không mất dữ liệu đối soát. Bảng
token và toàn bộ secret cấu hình được xóa.

## Cài đặt

Thư mục cài trong PrestaShop bắt buộc tên `monapay`:

```bash
cp -a prestashop-monapay /var/www/html/modules/monapay
cd /var/www/html
php bin/console prestashop:module install monapay --no-interaction
```

Vào Module Manager → MONA Pay → Configure và nhập:

- Base URL: `https://api.monapay.vn`
- Client ID và Client Secret của API key MONA Pay
- Webhook Secret của cấu hình webhook HMAC
- Return Signature Secret trong Cài đặt → Trang thanh toán
- Sandbox: bật để request tạo checkout có `"sandbox": true`

`Webhook Secret` và `Return Signature Secret` là hai secret khác nhau. Các ô
secret để trống khi lưu sẽ giữ giá trị hiện tại.

Webhook cần đăng ký trên MONA Pay:

```text
https://TEN-MIEN/module/monapay/webhook
```

- Method: `POST`
- Payload: `application/json`
- Auth: `HMAC_SHA256`
- Event cần dùng: `CHECKOUT_PAID`

Return URL được module tự gửi khi tạo checkout:

```text
https://TEN-MIEN/module/monapay/return
```

## Kiểm tra tĩnh

```bash
find . -name '*.php' -print0 | xargs -0 -n1 php -l
php tests/hmac.php
```

Sau đó kiểm thử trên staging: checkout guest, sandbox đủ tiền, thiếu tiền,
gửi lại cùng `transaction_code`, return sai chữ ký và webhook quá 300 giây.

Tài liệu API: https://monapay.vn/docs/api/trang-thanh-toan.md
