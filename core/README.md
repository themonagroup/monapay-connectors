# MONA Pay connector core

Server Node.js 18+ zero-dependency nhận `POST /webhooks/monapay`, xác thực HMAC-SHA256 trên **raw body** bằng `sdk/node/dist`, tách mã đơn từ `orderId` hoặc `description`, rồi gọi adapter nền tảng. `GET /healthz` dùng cho healthcheck.

## Cấu hình

Không có `dotenv`; truyền biến bằng systemd/Docker/runtime. Bắt buộc:

- `CONNECTOR_PLATFORM`: `shopify`, `haravan`, `sapo`, `kiotviet`, `nhanh`, `pancake` hoặc `woocommerce`.
- `MONA_WEBHOOK_SECRET`: trùng `secret_key` của webhook MONA Pay.
- Biến riêng của adapter trong `../adapters/<platform>/README.md`.

`ORDER_ID_REGEX` là regex tùy chỉnh. Nếu có named group `orderId`, core lấy group đó; nếu không thì lấy group đầu tiên/toàn match. Ví dụ `MONA\\s+SHOPIFY\\s+(?<orderId>\\d+)`. Mặc định nhận mô tả dạng `MONA SHOPIFY 12345` hoặc mã `DH10234`, `ORDER-10234`.

Mỗi lệnh adapter được thử tối đa 3 lần với backoff 250/500 ms. Timeout từng lần mặc định 2.000 ms và bị giới hạn tối đa 2.500 ms để còn phản hồi MONA Pay trong 10 giây. Core chỉ đánh dấu đơn với giao dịch `income`.

Chống trùng trong tiến trình dùng `transaction_code` với TTL 24 giờ. Khi chạy nhiều replica hoặc cần chống trùng qua lần restart, phải thay lớp cache bằng database có unique constraint trên `transaction_code`.

## Chạy local

```bash
set -a
. /etc/monapay-connector.env
set +a
node connectors/core/server.js
curl --fail http://127.0.0.1:8787/healthz
```

## Triển khai VPS theo luật MONA

Chạy bằng user không có quyền root và chỉ bind loopback. Ví dụ systemd:

```ini
[Unit]
Description=MONA Pay connector
After=network-online.target

[Service]
User=monapay-connector
Group=monapay-connector
WorkingDirectory=/opt/monapay
EnvironmentFile=/etc/monapay-connector.env
ExecStart=/usr/bin/node /opt/monapay/connectors/core/server.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

File env nên thuộc `root:monapay-connector`, mode `640`. Không log token/secret. Nginx là lớp public duy nhất:

```nginx
location = /webhooks/monapay {
    limit_except POST { deny all; }
    client_max_body_size 1m;
    proxy_pass http://127.0.0.1:8787;
    proxy_connect_timeout 2s;
    proxy_read_timeout 10s;
}
```

TLS kết thúc tại Nginx. Không public `/healthz`; monitor từ loopback. Nếu dùng Dockerfile từ repo root:

```bash
docker build -f connectors/core/Dockerfile -t monapay-connector .
docker run --rm --network host --env-file /etc/monapay-connector.env monapay-connector
```

`--network host` là chủ ý để process trong container vẫn bind `127.0.0.1` và Nginx trên host truy cập được. Không chạy container bằng root và không bind `0.0.0.0` nếu chưa có firewall/reverse proxy được duyệt.
