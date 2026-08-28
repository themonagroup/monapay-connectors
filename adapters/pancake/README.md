# Pancake POS adapter — cần xác minh

Nguồn chính thức tìm thấy:

- https://docs.pancake.biz/pos/st-f13/st-p1?lang=vi (Open API overview)
- https://docs.pancake.biz/pos/api/ (Open API workspace, cần quyền/JavaScript để xem schema đầy đủ)
- https://docs.pancake.biz/pos/st-f13/st-p3?lang=vi (order status & processing flow)

Tài liệu public xác nhận có Open API và flow trạng thái đơn, nhưng phần đã truy cập không đủ để chốt endpoint/payload “đã thanh toán”. Vì vậy adapter **không bịa endpoint** và sẽ từ chối khởi động cho tới khi Mon lấy schema từ tài khoản Pancake POS/Partner rồi điền cấu hình đã xác minh:

```dotenv
# TODO: kiểm với tài liệu Pancake POS và thay bằng endpoint thật.
PANCAKE_MARK_PAID_URL_TEMPLATE=https://<verified-host>/<verified-path>/{{orderId}}
PANCAKE_MARK_PAID_METHOD=<POST|PUT|PATCH>
PANCAKE_AUTH_HEADER=<verified-header-name>
PANCAKE_AUTH_VALUE=<verified-token-format>
PANCAKE_MARK_PAID_BODY_TEMPLATE={"<verified-field>":"<verified-value>","amount":"{{amount}}","reference":"{{transactionCode}}"}
ORDER_ID_REGEX=MONA\s+PANCAKE\s+(?<orderId>[A-Za-z0-9_-]+)
```

Các placeholder hỗ trợ trong URL/body: `{{orderId}}`, `{{amount}}`, `{{transactionCode}}`. Đây chỉ là cấu trúc gọi có cấu hình, không khẳng định tên field ví dụ là schema Pancake.

TODO: kiểm với tài liệu Pancake POS: endpoint, HTTP method, kiểu auth, status/field thanh toán, id đơn dùng internal ID hay code, và response thành công.
