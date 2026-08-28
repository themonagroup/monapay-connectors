# WooCommerce adapter

Adapter gọi WooCommerce REST API v3 `PUT /wp-json/wc/v3/orders/{id}` với `{ "set_paid": true }`.

Nguồn chính thức:

- https://woocommerce.github.io/woocommerce-rest-api-docs/#update-an-order
- https://woocommerce.github.io/woocommerce-rest-api-docs/#order-properties (`set_paid`)
- https://developer.woocommerce.com/docs/apis/rest-api/

```dotenv
WOOCOMMERCE_STORE_URL=https://shop.example.com
WOOCOMMERCE_CONSUMER_KEY=ck_...
WOOCOMMERCE_CONSUMER_SECRET=cs_...
ORDER_ID_REGEX=MONA\s+WOOCOMMERCE\s+(?<orderId>\d+)
```

Tạo REST API key có quyền Read/Write và luôn dùng HTTPS để Basic Auth không lộ secret. `orderId` phải là internal order ID của WooCommerce.

TODO: chạy staging order với đúng plugin/gateway của shop để xác nhận hook phát sinh từ `set_paid` không gây gửi email hoặc automation ngoài ý muốn.
