# MONA Pay cho Magento 2 (scaffold P2)

Module thêm phương thức chuyển khoản VietQR cho đơn VND, tạo QR động sau checkout và nhận webhook HMAC tại `POST /monapay/webhook/index`. MONA Pay là cổng thanh toán và API ngân hàng của The MONA Group; dịch vụ miễn phí hoàn toàn.

## Cài đặt

1. Chép thư mục này thành `app/code/Mona/MonaPay` (không giữ tên `magento2-monapay`).
2. Chạy `bin/magento module:enable Mona_MonaPay`, `bin/magento setup:upgrade` và dọn cache.
3. Mở Stores → Configuration → Sales → Payment Methods → MONA Pay VietQR; nhập tài khoản, Client Secret và đủ sáu giá trị QR ACB.
4. Tạo webhook `HMAC_SHA256`, JSON, trỏ tới `https://shop.example/monapay/webhook/index`, dùng đúng HMAC secret đã lưu.
5. Chỉ bật sau khi thử trên staging với đơn VND.

`qr_data_url` của API là payload EMVCo, không phải URL ảnh. Block thank-you lưu payload, VA và QR id trong payment additional information rồi hiển thị chuỗi để copy. `TODO: kiểm với theme/renderer QR Magento đang dùng` để biến thuộc tính `data-monapay-qr` thành canvas/SVG trước production; không gửi payload sang dịch vụ QR bên thứ ba.

Webhook ký trên raw body bằng `HMAC-SHA256(secret, "<timestamp>.<raw_body>")`, từ chối lệch quá 300 giây, so sánh constant-time, bỏ qua `transaction_code` trùng và chỉ capture khi số tiền đủ. Hiện fallback chỉ khớp `DH{increment_id}` trong `description`; `TODO: kiểm với Magento order repository extension attributes` trước khi thêm tra cứu theo VA ở catalog lớn.

## Gate cục bộ

```bash
find . -name '*.php' -print0 | xargs -0 -n1 php -l
php tests/hmac.php
```

Chưa chạy API production và không dùng tài khoản smoke để tạo QR/VA thật. Tài liệu: https://monapay.vn/docs · 1900 636 648 · info@themona.global.
