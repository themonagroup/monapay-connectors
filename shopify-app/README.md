# MONA Pay cho Shopify

Ứng dụng Node.js 22, không dùng dependency ngoài, nối đơn thanh toán thủ công của Shopify với trang thanh toán hosted MONA Pay.

Luồng chính:

1. Shopify gửi `orders/create` cho đơn `pending` dùng phương thức thủ công có tên chứa `MONA Pay`.
2. Ứng dụng tạo checkout `SP<order_number>` tại MONA Pay, lưu link vào Additional details của đơn và gắn tag `monapay-pending`.
3. Checkout UI extension đọc `GET /api/pay-link/{orderId}` bằng Shopify session token để hiện nút **Thanh toán qua MONA Pay** và QR.
4. MONA Pay gửi `CHECKOUT_PAID`; ứng dụng xác thực HMAC trên raw body, đối chiếu checkout/mã đơn/số tiền, tạo Shopify sale transaction và đổi tag sang `monapay-paid`.

## Cài cho merchant: 5 bước

1. Cài ứng dụng từ Shopify hoặc mở URL cài đặt do MONA cung cấp. Shopify sẽ hỏi quyền `read_orders,write_orders` và đưa anh chị về trang cài đặt của ứng dụng.
2. Trong Shopify Admin, vào **Settings → Payments → Manual payment methods → Create custom payment method**. Đặt tên **Chuyển khoản MONA Pay**. Tên phải chứa đúng cụm `MONA Pay`.
3. Tại my.monapay.vn, vào **API Keys**, tạo key rồi dán **MONA Client ID** và **MONA Client Secret** vào trang cài đặt. Bấm **Kiểm tra**, bật **sandbox** nếu đang thử, sau đó bấm **Lưu cấu hình**. Ứng dụng tự tạo webhook MONA Pay; anh chị không cần chép webhook secret.
4. Tạo một đơn VND, chọn **Chuyển khoản MONA Pay** và để trạng thái thanh toán `pending`. Khi webhook đến, đơn có tag `monapay-pending` và Additional details tên `MONA Pay link`. Trang cảm ơn sẽ lấy cùng link từ backend cho extension.
5. Thử thanh toán và kiểm đơn tự chuyển sang `paid`, tag thành `monapay-paid`. Khi đưa vào dùng thật, bỏ chọn sandbox, lưu lại, rồi thử một khoản nhỏ bằng tài khoản ngân hàng đã nối với MONA Pay.

Không dùng thao tác **Send invoice** cho luồng này. Invoice của Shopify là một luồng thu tiền khác.

## Endpoint

| Method | Path | Mục đích |
| --- | --- | --- |
| `GET` | `/auth?shop=<shop>.myshopify.com` | Bắt đầu OAuth offline token |
| `GET` | `/auth/callback` | Xác thực state/HMAC, đổi token, đăng ký webhook |
| `GET` | `/settings?shop=...` | Trang cấu hình merchant; yêu cầu session token hoặc cookie ký HMAC |
| `POST` | `/settings/test?shop=...` | Kiểm tra MONA credentials, chưa lưu |
| `POST` | `/settings/save?shop=...` | Lưu credentials mã hóa và tự tạo/cập nhật webhook MONA Pay |
| `POST` | `/webhooks/orders-create` | Shopify tạo đơn |
| `POST` | `/webhooks/monapay` | MONA Pay `CHECKOUT_PAID` |
| `POST` | `/webhooks/app-uninstalled` | Xóa token và dữ liệu shop |
| `POST` | `/webhooks/customers-data-request` | Compliance: ứng dụng không lưu dữ liệu khách hàng |
| `POST` | `/webhooks/customers-redact` | Compliance: ứng dụng không lưu dữ liệu khách hàng |
| `POST` | `/webhooks/shop-redact` | Compliance: xóa toàn bộ dữ liệu shop |
| `GET` | `/api/pay-link/{orderId}` | Link và QR cho extension; yêu cầu Shopify session token |
| `GET` | `/healthz` | Healthcheck nội bộ |

`/api/pay-link/{orderId}` chấp nhận ID số hoặc Shopify Order GID đã URL-encode, với header `Authorization: Bearer <Shopify session token>`. Response chỉ trả dữ liệu checkout của đúng shop trong claim `dest`.

## Chạy cho dev

Yêu cầu Node.js 22. Không chạy `npm install`; dự án chỉ dùng Node built-in.

```bash
cd /opt/monapay-shopify
cp .env.example .env
# Điền credentials và tạo APP_SECRET_KEY ngẫu nhiên trước khi chạy.
set -a
source .env
set +a
node server.js
```

Ứng dụng không tự đọc file `.env`. Production dùng `EnvironmentFile` của systemd. `APP_SECRET_KEY` cần giữ ổn định và backup an toàn; đổi hoặc mất key sẽ làm các token/secret đã lưu không giải mã được.

Chạy test:

```bash
npm test
# tương đương: node --test test/app.test.js test/crypto.test.js
```

Node 22.22 trong workspace không tự quét directory khi chạy `node --test test/`; cần liệt kê file như trên.

## Liên kết Partner app và dev store

Partner organization: `5161213`. Development store: `monapay-dev.myshopify.com`.

1. Thay `REPLACE_WITH_SHOPIFY_API_KEY` trong `shopify.app.toml` bằng client ID của app.
2. Trong Shopify Dev Dashboard, đặt App URL `https://shopify.monapay.vn` và allowed redirect URL `https://shopify.monapay.vn/auth/callback`.
3. Kiểm scopes là `read_orders,write_orders` và webhook API version là `2026-07`.
4. Chạy `shopify app deploy` để phát hành cấu hình năm webhook trong `shopify.app.toml`.
5. Cài bằng `https://shopify.monapay.vn/auth?shop=monapay-dev.myshopify.com`.

OAuth cũng đăng ký shop-specific `orders/create` và `app/uninstalled` theo yêu cầu v1. Webhook ID và order ID đều được chống trùng, nên delivery lặp không tạo thêm checkout.

## Test trọn luồng sandbox trên dev store

1. Bật sandbox trong trang cài đặt app.
2. Tạo đơn VND với manual payment **Chuyển khoản MONA Pay**. Kiểm đơn có `monapay-pending` và `MONA Pay link`.
3. Mở link `https://pay.monapay.vn/c/<token>`. Trang phải ghi rõ đây là phiên thử; không chuyển tiền thật.
4. Trong my.monapay.vn, tìm checkout theo mã `SP<order_number>` để lấy VA `SBX…`. Lấy Bearer token bằng client credentials, rồi bắn giao dịch giả đúng VA, amount và order code:

```bash
curl -X POST https://api.monapay.vn/api/v1/sandbox/transactions \
  -H "Authorization: Bearer $MONA_TOKEN" \
  -H "X-Client-Secret: $MONA_CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"virtual_account_number":"SBX...","amount":150000,"description":"SP1001","transaction_code":"SANDBOX-SP1001-01"}'
```

5. Kiểm MONA Pay phát `CHECKOUT_PAID`; Shopify có sale transaction `gateway: MONA Pay`, đơn thành `paid` và tag là `monapay-paid`.
6. Gửi lại cùng `transaction_code`; ứng dụng phải trả 200 và không tạo transaction thứ hai.

Nên thử thêm đơn sai currency, đơn dùng cổng khác và checkout thiếu tiền. Các trường hợp đó không được đánh dấu Shopify là đã thanh toán.

## Deploy Ubuntu với systemd và Nginx

Các file mẫu nằm trong `deploy/`.

```bash
sudo useradd --system --home /var/lib/monapay-shopify --shell /usr/sbin/nologin monapay-shopify
sudo install -d -o monapay-shopify -g monapay-shopify -m 0700 /var/lib/monapay-shopify
sudo install -d -o root -g root -m 0755 /opt/monapay-shopify
sudo cp -a . /opt/monapay-shopify/
sudo install -o root -g root -m 0600 .env.example /etc/monapay-shopify.env
sudo install -o root -g root -m 0644 deploy/monapay-shopify.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/nginx-shopify.monapay.vn.conf /etc/nginx/sites-available/shopify.monapay.vn
sudo ln -s /etc/nginx/sites-available/shopify.monapay.vn /etc/nginx/sites-enabled/shopify.monapay.vn
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now monapay-shopify
```

Điền secret thật trong `/etc/monapay-shopify.env` trước khi start. Nginx chuyển nguyên request body tới Node; không thêm JSON parser/proxy làm serialize lại body webhook. Cấp chứng chỉ TLS cho `shopify.monapay.vn` trước khi bật server block 443.

Kiểm sau deploy:

```bash
curl -fsS http://127.0.0.1:8793/healthz
curl -fsS https://shopify.monapay.vn/healthz
systemctl status monapay-shopify
journalctl -u monapay-shopify -n 100 --no-pager
```

## Dữ liệu và bảo mật

- Store mặc định là `$DATA_DIR/store.json`, file mode `0600`, thư mục mode `0700`.
- Ghi file qua temporary file + atomic rename, và dùng lock file chống hai process ghi đè nhau.
- Shopify access token, MONA Client Secret và MONA webhook secret được mã hóa AES-256-GCM bằng key dẫn xuất từ `APP_SECRET_KEY`.
- HMAC Shopify và MONA Pay luôn tính trên raw request bytes. Timestamp MONA Pay lệch quá 300 giây bị từ chối.
- Ứng dụng không lưu tên, email, địa chỉ hoặc ID khách hàng. `customers/data_request` và `customers/redact` vì vậy chỉ xác thực, ghi audit log tối thiểu và trả 200.
- JSON store phù hợp một instance v1. Không chạy nhiều node cùng lúc nếu không dùng shared filesystem; trước khi scale ngang cần chuyển sang database có unique constraints.

## Thank-you extension

Backend đã sẵn sàng cho Checkout UI extension. Xem `extensions/thank-you/README.md`. Extension phải lấy Order GID cùng session token của Shopify, gọi `/api/pay-link/{orderId}`, poll ngắn khi nhận 404, rồi hiện nút **Thanh toán qua MONA Pay** và QR do backend trả về. Không tự tính amount ở client.

## Checklist nộp Shopify App Store

- Hoàn thiện listing tiếng Việt/Anh, icon, screenshot và mô tả rõ đây là manual bank-transfer automation.
- Privacy policy: `https://monapay.vn/chinh-sach-bao-mat`.
- Support email: `info@themona.global`.
- Quay video demo: cài app → cấu hình key → tạo manual order → mở hosted checkout → sandbox transaction → Shopify order paid.
- Deploy và dùng Shopify automated check kiểm đủ ba compliance webhooks; invalid HMAC phải nhận 401.
- Khai báo đúng việc app đọc/ghi đơn hàng và hoàn tất biểu mẫu protected customer data nếu Shopify yêu cầu.
- Cung cấp reviewer test credentials và hướng dẫn tạo manual payment method.
- Test uninstall/reinstall, xóa shop data, retry webhook và key rotation.
- Chuyển thank-you extension từ scaffold CLI thành extension production rồi deploy cùng app version.

Lưu ý kỹ thuật: REST Admin API đã là legacy và Shopify yêu cầu public app mới dùng GraphQL Admin API. Brief v1 yêu cầu rõ các REST endpoint `webhooks.json`, `orders/{id}.json` và `transactions.json`, nên bản này giữ đúng hợp đồng để chạy dev store. Trước khi gửi review App Store, cần xác nhận với Shopify hoặc chuyển các thao tác còn lại sang GraphQL; đây là gate bắt buộc, không nên bỏ qua.

Tài liệu tham chiếu:

- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
- https://shopify.dev/docs/apps/build/webhooks/subscribe
- https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
- https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens
- https://monapay.vn/docs/api/trang-thanh-toan.md
- https://monapay.vn/docs/api/xac-thuc.md
- https://monapay.vn/docs/api/sandbox.md
