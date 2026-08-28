# MONA Pay cho Ghost membership thủ công

Ghost không có payment-provider plugin API để thay checkout Memberships/Portal bằng chuyển khoản ngân hàng. Module này vì vậy gồm hai phần có chủ đích:

- Hướng dẫn nhúng lựa chọn “Thanh toán chuyển khoản” vào một page/card của theme.
- Webhook bridge Node.js thuần để xác minh MONA Pay rồi gắn label `MONA Pay paid` cho member qua Ghost Admin API.

Label này là dấu quản trị, **không biến member thành native paid subscriber**, không tạo Stripe subscription, không mở tự động paid tier của Portal và không xử lý gia hạn/hủy. Nếu nội dung dùng `visibility: paid`, cần một workflow entitlement riêng đã được kiểm với Ghost; `TODO: kiểm với tài liệu Ghost Memberships của phiên bản đang chạy`.

## Luồng thủ công

1. Tạo một page Ghost giải thích cách chuyển khoản/VietQR và form thu email.
2. Backend của anh chị tạo QR MONA Pay với `description` dạng `Thanh toan MEMBER customer-0001` (reference không chứa dữ liệu nhạy cảm).
3. Sau khi xác minh email/member, ghi mapping reference → Ghost member UUID + `expectedAmount` trong `members.json`, theo `members.example.json`. Bridge từ chối giao dịch thiếu tiền.
4. Chạy bridge sau reverse proxy HTTPS. Cấu hình MONA Pay webhook JSON + `HMAC_SHA256` tới `https://bridge.example/webhooks/monapay`.
5. Bridge kiểm raw body + timestamp 300 giây, tra mapping, lấy member hiện tại, giữ labels cũ, thêm label và lưu ledger `transaction_code` mode `0600`.

```bash
cp .env.example .env
# nạp biến môi trường bằng process manager của bạn, không commit .env/members.json/data
node server.js
node --test
find . -name '*.js' -print0 | xargs -0 -n1 node --check
```

Service bind `127.0.0.1` mặc định; đặt Nginx/Caddy phía trước, giới hạn body/rate, đồng bộ đồng hồ và bảo vệ Admin API key. File ledger phù hợp một process nhỏ; production nhiều replica phải thay bằng database có UNIQUE `transaction_code`.

Không gọi API production trong gate và không có dependency npm. MONA Pay miễn phí hoàn toàn · https://monapay.vn/docs · 1900 636 648 · info@themona.global.
