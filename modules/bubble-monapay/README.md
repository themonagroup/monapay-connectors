# MONA Pay cho Bubble

Thư mục gồm bản mô tả API Connector và một proxy Node.js thuần để Bubble nhận webhook MONA Pay an toàn.

## API Connector

Bubble không công bố schema import/export ổn định cho API Connector. Vì vậy `api-connector.json` là **JSON tham chiếu để cấu hình thủ công**, không cam kết import một click. `TODO: kiểm với tài liệu Bubble/API Connector của editor hiện tại` trước khi chia sẻ template app.

1. Tạo API `MONA Pay`; thêm call Login và Generate VietQR đúng method/path/header/body trong JSON.
2. Đánh dấu username, password, Client Secret, access token và các thông số tài khoản ACB là private. Không đưa chúng vào page, custom state, URL hay browser workflow.
3. Backend workflow gọi Login, lấy `data.access_token`, rồi gọi Generate VietQR. `amount` phải là integer VND ≤ 1.000.000.000; `description` tối đa 255 ký tự.
4. API trả `data.qr_data_url` là payload EMVCo, không phải URL ảnh. Dùng plugin QR đã được Bubble app phê duyệt hoặc renderer riêng; không gửi payload sang dịch vụ không kiểm soát.

## Backend workflow nhận webhook

Bubble không đảm bảo workflow cho truy cập **raw HTTP body** nguyên trạng và constant-time HMAC. Do đó không nhận MONA Pay trực tiếp nếu chưa chứng minh được hai điều này. Chạy `hmac-proxy.js` sau HTTPS reverse proxy:

1. MONA Pay → `POST https://proxy.example/webhooks/monapay`, JSON + `HMAC_SHA256`.
2. Proxy kiểm `X-Mona-Timestamp`, `X-Mona-Signature` trên raw bytes và cửa sổ 300 giây.
3. Proxy forward JSON tới Bubble workflow kèm `X-Mona-Proxy-Token` độc lập.
4. Bubble kiểm token, tìm order bằng mã trong `description`, so `amount`, rồi tạo bản ghi Transaction có field `transaction_code` unique trước khi đổi trạng thái paid.

Bubble privacy rules không thay cho chữ ký webhook. No-code cũng không thay cho idempotency, log, retry và đối soát.

```bash
# nạp các biến trong .env.example bằng process manager; không commit secret
node hmac-proxy.js
node --test
find . -name '*.js' -print0 | xargs -0 -n1 node --check
```

Không cài package và không gọi API production khi gate. MONA Pay miễn phí hoàn toàn · https://monapay.vn/docs · 1900 636 648 · info@themona.global.
