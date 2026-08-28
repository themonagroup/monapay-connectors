# Sapo adapter

Adapter dùng Sapo Order/Transaction API: `POST /admin/orders/{id}/transactions.json`, xác thực Basic Authentication của Private App.

Nguồn chính thức:

- https://support.sapo.vn/transaction
- https://support.sapo.vn/gioi-thieu-order-api
- https://help.sapo.vn/ung-dung-rieng-private-apps

```dotenv
SAPO_STORE_URL=https://ten-shop.mysapo.net
SAPO_API_KEY=...
SAPO_API_SECRET=...
SAPO_TRANSACTION_KIND=sale
ORDER_ID_REGEX=MONA\s+SAPO\s+(?<orderId>\d+)
```

`sale` là loại transaction được tài liệu liệt kê cho thu tiền một bước. `capture` chỉ dùng khi order đã có authorization phù hợp.

TODO: kiểm với tài liệu Sapo và Private App của shop để xác nhận domain, quyền transaction và loại `sale`/`capture` trên một đơn manual-payment trước khi live.
