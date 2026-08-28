# Thank-you extension — bước triển khai thật

Scaffold backend đã có endpoint `GET /api/qr/{shopifyOrderId}`. Endpoint yêu cầu Shopify session token dạng `Authorization: Bearer <token>`, kiểm chữ ký HS256, `aud`, `exp` và `dest` trước khi trả dữ liệu QR.

Phần UI extension **không thể tạo hoàn chỉnh offline trong repo này** vì Shopify CLI sinh manifest/dependency theo API version và Partner app. Khi có tài khoản Shopify Partner:

1. Cài Shopify CLI theo tài liệu chính thức, đăng nhập Partner account và liên kết app.
2. Tại `connectors/shopify-app`, chạy lệnh generate extension của CLI, chọn Checkout UI extension và target Thank you / Order status phù hợp API version hiện hành.
3. Trong component do CLI sinh, lấy order GID và session token từ API Checkout UI Extension hiện hành.
4. Gọi `GET https://<SHOPIFY_APP_URL>/api/qr/{orderId}` với bearer session token. Nếu nhận `404`, poll ngắn vì webhook `orders/create` có thể hoàn thành sau trang thank-you.
5. Render `qr_data_url`/`qr_code`, số tiền và nội dung chuyển khoản. Không tự tính lại amount ở client.
6. Bật network access cho extension nếu manifest/API version yêu cầu, test bằng development store, rồi deploy qua Shopify CLI.

Pseudocode (tên hook phải lấy từ scaffold mà CLI sinh, không copy nguyên vào production):

```text
orderId = checkoutApi.order.id
token = await checkoutApi.sessionToken.get()
GET /api/qr/{orderId} Authorization: Bearer {token}
404 -> chờ rồi thử lại có giới hạn
200 -> render QR + amount + description
```

Nguồn cần đối chiếu khi triển khai:

- https://shopify.dev/docs/api/checkout-ui-extensions/latest
- https://shopify.dev/docs/apps/build/checkout/thank-you-order-status
- https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens

TODO: cần Shopify Partner account, development store và `shopify app` CLI để khóa target/API version, xin quyền network access và deploy extension thật.
