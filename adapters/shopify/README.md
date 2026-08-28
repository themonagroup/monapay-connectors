# Shopify adapter

Adapter gọi Admin GraphQL mutation `orderMarkAsPaid(input: {id})`, mutation chính thức dùng để ghi nhận khoản thanh toán nhận ngoài checkout.

Nguồn chính thức:

- https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderMarkAsPaid
- https://shopify.dev/docs/api/admin-graphql/latest/input-objects/OrderMarkAsPaidInput
- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin

Biến bắt buộc:

```dotenv
SHOPIFY_SHOP=example.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_...
SHOPIFY_API_VERSION=2026-07
ORDER_ID_REGEX=MONA\s+SHOPIFY\s+(?<orderId>\d+)
```

Cần app Shopify đã install, Admin API access token và scope `write_orders` (thường thêm `read_orders` để đối soát). Chốt một API version còn được Shopify hỗ trợ thay vì dùng `latest` trong production.

TODO: kiểm với tài liệu Shopify và test shop trước khi live rằng đơn dùng manual payment còn positive outstanding balance; mutation sẽ trả `userErrors` nếu đơn đã paid hoặc không còn số dư.
