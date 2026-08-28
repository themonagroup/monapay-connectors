# MONA Pay Shopify app scaffold

Node.js 18+ zero-dependency scaffold gồm:

- `GET /auth?shop=<shop>.myshopify.com`: bắt đầu OAuth install.
- `GET /auth/callback`: kiểm state + HMAC, đổi code lấy offline Admin API token và lưu local.
- `POST /webhooks/orders-create`: kiểm Shopify HMAC trên raw body, tạo VietQR động qua `../../sdk/node/dist`, lưu QR theo shop/order.
- `GET /api/qr/{orderId}`: trả QR cho extension sau khi kiểm Shopify session token.
- `GET /healthz`: healthcheck nội bộ.

## Chạy scaffold

Không chạy `npm install`; code chỉ dùng Node built-in và MONA SDK đã build trong repo. Truyền các biến ở `.env.example` bằng systemd/runtime rồi:

```bash
node connectors/shopify-app/server.js
```

App phải ở sau HTTPS reverse proxy, process mặc định chỉ bind `127.0.0.1`, và `SHOPIFY_APP_URL` phải đúng public URL. Install URL là:

```text
https://shopify-app.example.com/auth?shop=ten-shop.myshopify.com
```

Sau OAuth, cấu hình subscription `orders/create` về `https://shopify-app.example.com/webhooks/orders-create`. File `shopify.app.toml.example` chỉ là tham khảo; dùng file do CLI hiện hành sinh ra khi triển khai thật.

QR dùng `order.id` làm `orderId` và mô tả `MONA SHOPIFY <order.id>`. Vì vậy connector core Shopify nên dùng:

```dotenv
ORDER_ID_REGEX=MONA\s+SHOPIFY\s+(?<orderId>\d+)
```

## Phần bắt buộc trước production

- Cần Shopify Partner account, app credentials, development store, quyền `read_orders,write_orders` và Admin API version còn hỗ trợ.
- Cần chạy `shopify app` CLI để tạo/deploy thank-you Checkout UI extension; xem `extensions/thank-you/README.md`.
- `data/store.json` chỉ phù hợp một process/demo, dù file/dir được tạo mode `600/700`. Production phải dùng database mã hóa token, unique webhook ID/order ID và cơ chế backup.
- Đăng ký app-uninstalled webhook và xóa token/shop data theo yêu cầu privacy trước khi public app.
- Test đơn VND, amount nguyên và manual payment. Scaffold từ chối currency khác VND hoặc amount vượt giới hạn MONA Pay.
- Shopify có thể retry webhook. Scaffold chống trùng theo webhook ID và order trong file local; production vẫn cần unique constraint trong database.

Tài liệu chính thức:

- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
- https://shopify.dev/docs/apps/build/webhooks/subscribe
- https://shopify.dev/docs/apps/build/webhooks/subscribe/https
- https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens

TODO: đối chiếu manifest, webhook subscription và Checkout UI target bằng Shopify CLI/API version tại thời điểm tạo Partner app; scaffold không tự giả định các phần cần quyền Partner.
