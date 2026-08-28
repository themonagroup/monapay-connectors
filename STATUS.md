# CONNECTORS STATUS — 2026-08-29

## Trạng thái

Đã hoàn thành scaffold trong `connectors/`, Node.js 18+ zero-dependency, dùng trực tiếp `../sdk/node/dist`.

- `core/`: nhận `POST /webhooks/monapay`, verify MONA HMAC trên raw body, chỉ xử lý `income`, map `orderId`/`description`, retry tối đa 3 attempt, JSON log, idempotency theo `transaction_code`, `GET /healthz`, Dockerfile non-root và hướng dẫn VPS bind `127.0.0.1` sau Nginx.
- `adapters/`: đủ Shopify, Haravan, Sapo, KiotViet Retail, Nhanh.vn v3, Pancake POS và WooCommerce; mỗi adapter có một file code + README nguồn chính thức/chỗ cần xác minh.
- `shopify-app/`: OAuth install/callback có state + HMAC, route webhook `orders/create` có raw-body HMAC, tạo VietQR động qua MONA SDK, local JSON store atomic mode `600`, API đọc QR có Shopify session-token verify, và hướng dẫn thank-you extension.
- Không cài bất kỳ dependency nào, không gọi API production và không tạo VA/QR thật khi làm gate.

## Mức độ xác minh adapter

- **Shopify:** endpoint/mutation `orderMarkAsPaid` đã đối chiếu Shopify Admin GraphQL docs. Cần test positive outstanding/manual-payment trên development store và chốt API version.
- **Haravan:** `POST /com/orders/{id}/transactions.json` đã đối chiếu Haravan Transaction docs. Cần chốt `Sale` hay `Capture` theo trạng thái order thực của shop.
- **Sapo:** `POST /admin/orders/{id}/transactions.json`, Private App Basic Auth và transaction kinds đã đối chiếu docs Sapo. Cần test quyền/flow trên shop thật.
- **KiotViet:** `POST /payments` payload `Transfer` đã đối chiếu Public API Retail chính thức. Cần ID tài khoản ngân hàng và xác nhận shop thuộc Retail; FnB/Salon/Hotel có API khác.
- **Nhanh.vn:** dùng API v3 hiện hành `/v3.0/order/edit`, ghi `payment.transferAmount` + `payment.code`. Không hard-code paid status; cần Mon chốt status ID nếu workflow phải đổi trạng thái cùng lúc.
- **WooCommerce:** `PUT /wp-json/wc/v3/orders/{id}` với `set_paid: true` đã đối chiếu REST API docs. Cần staging test các email/automation hook của shop.
- **Pancake POS:** tài liệu public chưa lộ đủ endpoint/payload đánh dấu thanh toán. Adapter là cấu trúc gọi có cấu hình và cố ý fail startup nếu chưa điền schema đã xác minh. `TODO: kiểm với tài liệu Pancake POS/Partner account` trước khi dùng.

## Cần Mon cung cấp / thực hiện

1. Shopify Partner account, app credentials, development store; chạy `shopify app` CLI để sinh/deploy Checkout UI thank-you extension và chốt manifest/API version.
2. Token/test shop của từng nền tảng, một order chưa thanh toán và expected status sau webhook để smoke test adapter mà không ảnh hưởng đơn thật.
3. Pancake POS Partner/Open API access để xác nhận URL, method, auth, body và success response.
4. Mapping nội dung QR → internal order/invoice ID của từng shop (`ORDER_ID_REGEX`), đặc biệt KiotViet dùng invoice ID.
5. Production database/queue: thay idempotency cache trong memory và Shopify JSON store bằng unique constraint trên `transaction_code`, Shopify webhook ID và shop/order ID; mã hóa OAuth token.

## Gate đã chạy

- `node --test connectors` — **PASS, 10/10 test**.
- `find connectors -type f -name '*.js' -print0 | xargs -0 -n1 node --check` — **PASS**.

Test bao phủ SDK HMAC verify qua core, mapping mặc định/custom, adapter mock, retry đúng 3 attempt, invalid signature, duplicate transaction, bỏ qua non-income, healthcheck, Shopify OAuth/webhook HMAC và Shopify session token.
