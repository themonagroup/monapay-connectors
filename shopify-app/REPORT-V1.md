# REPORT V1 — Shopify app MONA Pay

Ngày hoàn tất: 04/09/2026  
Phạm vi: `/Users/themon/MONApay/connectors/shopify-app`  
Trạng thái git: không commit.

## Kết quả

Đã thay scaffold VietQR cũ bằng Shopify app v1 dùng hosted checkout MONA Pay:

- OAuth authorization-code flow lấy offline Admin API token, kiểm state + cookie + Shopify HMAC.
- Token Shopify được lưu trong JSON store bằng AES-256-GCM.
- Sau OAuth, app đăng ký idempotent `orders/create` và `app/uninstalled` qua Admin REST API version `2026-07`.
- Trang `/settings?shop=` xác thực bằng Shopify session token hoặc cookie HMAC sau OAuth, có CSRF cho form cookie.
- Settings cho nhập MONA Client ID/Client Secret, kiểm tra qua OAuth client credentials + `/client/me`, bật sandbox và lưu secret mã hóa.
- Khi lưu settings, app tự sinh HMAC webhook secret, tạo/cập nhật `/api/v1/client-webhooks` trỏ về `/webhooks/monapay`, rồi lưu webhook ID.
- `orders/create` chỉ nhận order `financial_status=pending`, gateway có tên chứa `MONA Pay`, VND và amount nguyên hợp lệ.
- Checkout dùng `order_code=SP<order_number>`, `return_url=order_status_url`, metadata `{shop,order_id}`, hạn 86.400 giây và `sandbox:true` khi merchant bật.
- App lưu checkout ID/token/URL/QR, cập nhật Shopify order `note_attributes` tên `MONA Pay link`, giữ các attributes hiện có và thêm tag `monapay-pending`.
- `/api/pay-link/{orderId}` kiểm Shopify session token rồi trả hosted link + QR cho đúng shop/order.
- `/webhooks/monapay` kiểm HMAC-SHA256 trên `<timestamp>.<raw_body>`, chặn lệch quá 300 giây, đối chiếu checkout ID, order code, metadata, amount, paid amount và status.
- `CHECKOUT_PAID` tạo Shopify transaction `kind=sale`, `status=success`, `gateway=MONA Pay`, đổi tag sang `monapay-paid`.
- Chống trùng theo Shopify webhook ID + order ID, MONA `transaction_code`, in-process job map và dò transaction Shopify bằng authorization trước khi POST lại.
- Có đủ handler `app/uninstalled`, `customers/data_request`, `customers/redact`, `shop/redact`; invalid HMAC trả 401. Uninstall/shop redact xóa shop, orders, webhook receipts và transaction receipts trong local store.

## Storage và bảo mật

`store.js` hiện có:

- AES-256-GCM envelope cho Shopify access token, MONA Client Secret và MONA webhook secret.
- Key 256-bit dẫn xuất SHA-256 từ `APP_SECRET_KEY`; env bị từ chối nếu key ngắn dưới 32 ký tự.
- File mode `0600`, directory/lock mode `0700`/`0600`.
- Atomic write bằng temporary file + rename.
- Lock file `wx`, timeout và dọn stale lock, cộng thêm write queue trong process.
- Không lưu tên, email, địa chỉ hoặc customer ID của Shopify.

## File bàn giao

- `server.js`: HTTP app, OAuth, settings, Shopify/MONA webhooks, Admin API và pay-link API.
- `monapay.js`: zero-dependency MONA client, OAuth cache/retry và webhook verifier.
- `shopify.js`: Shopify HMAC/session token/signed-cookie helpers.
- `store.js`: encrypted atomic JSON store.
- `.env.example`: biến production theo brief, port `8793` và data dir `/var/lib/monapay-shopify`.
- `shopify.app.toml`: App URL/redirect/scopes và 5 webhook topics, gồm 3 `compliance_topics`, API `2026-07`.
- `deploy/monapay-shopify.service`: chạy user non-root, hardening systemd, chỉ cho ghi data dir.
- `deploy/nginx-shopify.monapay.vn.conf`: TLS reverse proxy về `127.0.0.1:8793`, body limit 2 MB, webhook raw-body pass-through.
- `README.md`: hướng dẫn merchant 5 bước, dev/deploy, sandbox dev-store flow và App Store checklist.
- `extensions/thank-you/README.md`: contract endpoint + flow triển khai Checkout UI extension.

## Kiểm thử

Lệnh chạy:

```text
npm test
```

Kết quả:

```text
tests 9
pass 9
fail 0
```

Các ca đã phủ:

1. Shopify OAuth/webhook HMAC và session JWT.
2. MONA Pay HMAC hợp lệ và timestamp quá 5 phút.
3. Signed shop cookie chống giả mạo.
4. AES-256-GCM round-trip và xác nhận file không chứa plaintext secret.
5. Settings kiểm/lưu credentials, tự tạo MONA webhook, đăng ký hai Shopify webhook và không render secret ra HTML.
6. `orders/create` tạo đúng hosted checkout, có `X-Client-Secret`, idempotency key, order note attribute/tag và chống gửi lại.
7. `CHECKOUT_PAID` tạo sale transaction, đổi tag và chống trùng transaction code.
8. Session-protected `/api/pay-link` với Order GID.
9. Ba compliance topics trả 200; invalid HMAC trả 401; uninstall/shop redact xóa data.

Kiểm tra bổ sung đã chạy xanh:

```text
node --check cho từng file JS nguồn và test
python3 tomllib parse shopify.app.toml
git diff --check -- shopify-app
npm test tại connectors/: 16 pass, 0 fail
```

Node `v22.22.0` trong workspace không quét directory với cú pháp `node --test test/` mà coi `test/` là module và trả `MODULE_NOT_FOUND`. Vì vậy `package.json` dùng cú pháp tương đương hoạt động đúng: `node --test test/app.test.js test/crypto.test.js`. File `test/shopify.test.js` được giữ làm entry point tương thích cho suite cấp `connectors/`.

## Việc cần làm trên hạ tầng thật

Không thực hiện deploy, OAuth thật hoặc tạo đơn trên `monapay-dev.myshopify.com` vì workspace không có Partner/app credentials, MONA merchant credentials và không có DNS/network outbound. Checklist chạy thật đã ghi đầy đủ trong README:

1. Thay client ID placeholder trong `shopify.app.toml`, deploy app configuration bằng Shopify CLI.
2. Cấp TLS và deploy service/Nginx tại `shopify.monapay.vn`.
3. Cài app vào `monapay-dev.myshopify.com`, tạo manual method **Chuyển khoản MONA Pay**.
4. Bật sandbox, tạo order, bắn sandbox transaction và xác nhận order chuyển `paid`.
5. Deploy thank-you Checkout UI extension đã liên kết với Partner app.

## Gate trước App Store

Shopify ghi rõ REST Admin API là legacy và public app mới phải dùng GraphQL Admin API. Brief v1 yêu cầu trực tiếp `POST /webhooks.json`, `PUT /orders/{id}.json` và `POST /orders/{id}/transactions.json`, nên code hiện giữ đúng các endpoint đó và phù hợp để chạy dev store theo brief.

Trước khi nộp App Store cần xác nhận con đường được Shopify chấp thuận hoặc chuyển các thao tác còn lại sang GraphQL tương ứng. Đây là gate còn mở; không nên mô tả bản v1 hiện tại là đã sẵn sàng qua review App Store cho đến khi xử lý xong.

## v1.1 — Vá luồng đánh dấu đơn PAID

Ngày hoàn tất: 04/09/2026  
Trạng thái git: không commit.

- `CHECKOUT_PAID` nay gọi GraphQL Admin API `orderMarkAsPaid` với Shopify Order GID; thành công phát event `order_marked_paid`.
- Nếu GraphQL lỗi hoặc trả `userErrors`, app đọc REST transactions, tìm `sale/pending`, thử tạo `capture` có `parent_id`, `amount`, `currency=VND`; nếu capture lỗi mới thử `sale/success` cùng `parent_id`.
- Nếu local order đã paid, GraphQL trả `displayFinancialStatus=PAID`, hoặc tổng REST sale/capture thành công đã đủ giá trị đơn, app bỏ qua thao tác paid và ghi log info `order_already_paid`.
- Sau khi xác nhận paid, app đổi `monapay-pending` thành `monapay-paid` và upsert note attribute `MONA Pay transaction` bằng `transaction_code`, vẫn giữ các note attributes khác.
- Lỗi Shopify HTTP từ 400 trở lên ghi event `shopify_request_failed` kèm status, method, path và response body được cắt tối đa 300 ký tự.
- Test đã cập nhật cho GraphQL success, already-paid idempotency và chuỗi fallback REST `capture → sale`.

Kiểm thử v1.1:

```text
shopify-app/npm test: 11 pass, 0 fail
connectors/npm test: 18 pass, 0 fail
node --check toàn bộ shopify-app/*.js và shopify-app/test/*.js: pass
git diff --check -- shopify-app: pass
```
