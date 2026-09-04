# Thank-you Checkout UI extension

Backend v1 cung cấp:

```text
GET https://shopify.monapay.vn/api/pay-link/{shopifyOrderId}
Authorization: Bearer <Shopify session token>
```

Response:

```json
{
  "checkout_url": "https://pay.monapay.vn/c/...",
  "qr_image_url": "https://api.monapay.vn/api/v1/checkouts/public/.../qr.png",
  "qr_data_url": "...",
  "amount": 150000,
  "currency": "VND",
  "order_code": "SP1001",
  "status": "pending",
  "expires_at": "2026-09-05T00:00:00Z"
}
```

Extension cần được sinh/liên kết bằng Shopify CLI với Partner app thật, vì target và package Checkout UI phải khớp API version mà Shopify đang cấp cho app:

1. Tại `shopify-app/`, liên kết app thuộc Partner org `5161213` và dev store `monapay-dev.myshopify.com`.
2. Dùng Shopify CLI tạo Checkout UI extension cho Thank you / Order status page.
3. Lấy Order GID và session token từ Checkout UI API. URL-encode GID khi gắn vào path.
4. Gọi endpoint trên. Nếu nhận 404, thử lại có giới hạn vì `orders/create` có thể đang tạo checkout.
5. Khi `status=pending`, render QR và nút **Thanh toán qua MONA Pay** mở `checkout_url`. Không tự tính lại amount hoặc order code ở client.
6. Khi `status=paid`, hiện trạng thái đã nhận tiền và dừng polling.
7. Bật network access tới `https://shopify.monapay.vn` nếu manifest của extension/API version yêu cầu, test accessibility và deploy bằng Shopify CLI.

Pseudocode:

```text
orderId = checkoutApi.order.id
token = await checkoutApi.sessionToken.get()
result = GET /api/pay-link/{encodeURIComponent(orderId)}
         Authorization: Bearer {token}

404 -> chờ 2 giây, thử lại tối đa 10 lần
200 + pending -> hiện qr_image_url và nút checkout_url
200 + paid -> hiện "Đã nhận thanh toán"
401 -> lấy session token mới một lần
```

Không đưa MONA Client Secret, Shopify offline token hoặc webhook secret vào extension.

Nguồn đối chiếu:

- https://shopify.dev/docs/api/checkout-ui-extensions/latest
- https://shopify.dev/docs/apps/build/checkout/thank-you-order-status
- https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens
