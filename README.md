# MONA Pay platform connectors

Lớp nối nhận webhook MONA Pay và đồng bộ trạng thái thanh toán sang nền tảng bán hàng, Node.js 18+ và không có dependency bên thứ ba.

- `core/`: webhook server, HMAC verify bằng MONA SDK, mapping order, retry 3 attempt, idempotency trong process, healthcheck và Docker/VPS guide.
- `adapters/`: Shopify, Haravan, Sapo, KiotViet Retail, Nhanh.vn v3, Pancake POS (template chờ xác minh) và WooCommerce.
- `shopify-app/`: OAuth app scaffold, webhook `orders/create`, tạo/lưu VietQR và backend cho thank-you extension.

Chạy gate:

```bash
node --test connectors
```

Đọc `STATUS.md` trước khi live. Đặc biệt, mỗi nền tảng cần credential/test shop riêng và mapping `ORDER_ID_REGEX` khớp nội dung QR mà shop tạo ra.
