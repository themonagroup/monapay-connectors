# MONA Pay cho PrestaShop (scaffold P2)

Module PrestaShop 1.7.8+/8 thêm lựa chọn thanh toán VietQR cho đơn VND, tạo order ở trạng thái chờ, gọi MONA Pay để tạo QR và nhận webhook tại `/module/monapay/webhook`.

## Cài đặt

1. Đặt thư mục này tại `modules/monapay` (đổi tên từ `prestashop-monapay`), rồi cài trong Module Manager.
2. Configure: nhập Base URL, username/password, Client Secret, HMAC secret và sáu trường QR ACB. Không commit các giá trị này.
3. Tạo webhook MONA Pay JSON + `HMAC_SHA256` tới URL HTTPS do form config hiển thị, dùng cùng secret.
4. Test trên staging: đơn VND, payload thử `DUMMY123`, thiếu tiền và gửi lại cùng mã giao dịch.

Module tạo hai bảng riêng: QR theo order và ledger có primary key `transaction_code`; uninstall cố ý giữ dữ liệu audit. Webhook ký raw body, giới hạn 300 giây, dùng `hash_equals`, chỉ nhận `income` và không đổi trạng thái nếu thiếu tiền.

`qr_data_url` là payload EMVCo chứ không phải URL ảnh. Template payment-return hiển thị payload/VA. `TODO: kiểm với theme/renderer QR PrestaShop đang dùng` trước production. Cũng cần kiểm hook order-confirmation, email transition và multi-shop trên đúng phiên bản PrestaShop của cửa hàng.

```bash
find . -name '*.php' -print0 | xargs -0 -n1 php -l
php tests/hmac.php
```

Không chạy API production trong gate. MONA Pay miễn phí hoàn toàn · https://monapay.vn/docs · 1900 636 648 · info@themona.global.
