# MONA Pay cho OpenCart 4 (scaffold P2)

Extension payment tạo VietQR động cho đơn VND và nhận webhook có chữ ký. Không có dependency Composer/npm và không gọi dịch vụ dựng QR bên thứ ba.

## Cài đặt

1. Đóng gói `install.json` cùng thư mục `extension/` thành file `.ocmod.zip`, rồi cài tại Extensions → Installer.
2. Cài và mở Payment → MONA Pay VietQR. Nhập Base URL `https://api.monapay.vn`, credentials, Client Secret, HMAC secret và đủ giá trị QR ACB. Chọn trạng thái đơn đã thanh toán.
3. Tạo webhook MONA Pay dạng JSON + `HMAC_SHA256` tới `index.php?route=extension/monapay/payment/monapay.webhook` và dùng cùng secret.
4. Test đơn VND trên staging, thử webhook `DUMMY123`, webhook thiếu tiền và gửi lại cùng `transaction_code`.

Webhook kiểm raw body, cửa sổ 300 giây, `hash_equals`, chỉ nhận `income`, so tiền và chống trùng bằng primary key `transaction_code`. Extension chỉ khớp mã `DH{order_id}` trong nội dung.

OpenCart 4 có khác biệt route checkout/theme giữa các bản phân phối. `TODO: kiểm với tài liệu OpenCart 4 và checkout theme của shop` cho cấu trúc `payment_method.code`, route confirm và renderer QR. API trả `qr_data_url` là payload EMVCo; template hiện payload/VA để xác minh luồng, chưa tự giả vờ đó là URL ảnh.

```bash
find . -name '*.php' -print0 | xargs -0 -n1 php -l
php tests/hmac.php
```

Chưa gọi production hoặc tạo QR thật. Tài liệu MONA Pay: https://monapay.vn/docs · 1900 636 648 · info@themona.global.
