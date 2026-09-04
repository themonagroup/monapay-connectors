# MONA Pay cho OpenCart 4.1

Payment extension dùng hosted checkout của MONA Pay. Khi xác nhận đơn VND, extension lấy token bằng OAuth client credentials, gọi `POST /api/v1/checkouts` và chuyển khách sang `https://pay.monapay.vn/c/<token>`.

Phiên thanh toán hỗ trợ `sandbox: true`, redirect quay lại có chữ ký HMAC và webhook `CHECKOUT_PAID`. Webhook được kiểm bằng `X-Mona-Signature = sha256=<HMAC_SHA256(secret, "<timestamp>.<raw_body>")>`, chỉ chấp nhận timestamp lệch tối đa 300 giây và chống xử lý trùng theo `transaction_code`.

## Phiên bản và cấu trúc

- Mục tiêu: OpenCart `4.1.0.4`, PHP 8.1 trở lên.
- Cây `upload/` dùng để chép trực tiếp vào web root. Sau khi chép, controller nằm tại `extension/monapay/admin/controller/payment/monapay.php`.
- OpenCart 4 Installer tạo namespace extension từ tên file `.ocmod.zip`. Khi đóng gói để upload bằng admin, đặt `install.json` và ba thư mục `admin/`, `catalog/`, `system/` bên trong `upload/extension/monapay/` ở ngay root của zip; không đưa tầng `upload/extension/monapay` vào zip.

Demo Docker ở `handoff/opencart-demo` cài bằng cách chép cây `upload/`, thêm package `code=monapay` vào `extension_install`, thêm record `extension=monapay, type=payment, code=monapay` vào `extension`, cấp quyền cho Top Administrator và tạo hai bảng riêng của module.

## Cấu hình

- API base URL: `https://api.monapay.vn`
- Client ID và Client Secret: API key trên `my.monapay.vn`
- Webhook HMAC secret: secret của webhook JSON + `HMAC_SHA256`
- Return signature secret: secret của Cài đặt → Trang thanh toán; đây không phải webhook secret
- Payment mode: `redirect`
- Sandbox: khi bật, request tạo checkout gửi JSON boolean `sandbox: true`
- Paid order status: trạng thái OpenCart sau khi xác nhận đủ tiền

Webhook URL:

```text
https://shop.example/index.php?route=extension/monapay/payment/monapay.webhook
```

Return URL được module tự tạo với route `extension/monapay/payment/monapay.callback`. Callback kiểm chữ ký redirect, rồi gọi `GET /api/v1/checkouts/{id}` server-side trước khi cập nhật đơn. Webhook vẫn là nguồn xác nhận chính; callback là lớp đối soát dự phòng cho trải nghiệm quay lại cửa hàng.

## Kiểm tra tĩnh

```bash
find upload tests -name '*.php' -print0 | xargs -0 -n1 php -l
php tests/hmac.php
```

Tài liệu API: https://monapay.vn/docs/api/trang-thanh-toan.md
