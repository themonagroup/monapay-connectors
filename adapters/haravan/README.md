# Haravan adapter

Adapter tạo transaction cho order qua `POST /com/orders/{order_id}/transactions.json`. Token cần scope `com.write_orders`.

Nguồn chính thức:

- https://docs.haravan.com/docs/omni-apis/transactions/
- https://docs.haravan.com/docs/omni-apis/orders/
- https://docs.haravan.com/docs/get-started/overview/

```dotenv
HARAVAN_ACCESS_TOKEN=...
HARAVAN_TRANSACTION_KIND=Sale
ORDER_ID_REGEX=MONA\s+HARAVAN\s+(?<orderId>\d+)
```

`Sale` phù hợp với khoản thu ngoài hệ thống không có authorization trước. Nếu flow Haravan của shop đã tạo authorization/pending transaction, dùng `Capture` sau khi kiểm đúng trạng thái và số tiền.

TODO: kiểm với tài liệu Haravan và đơn test của chính shop để chốt `Sale` hay `Capture`; không đổi `financial_status` trực tiếp vì tài liệu ghi trường này chỉ set khi tạo order.
