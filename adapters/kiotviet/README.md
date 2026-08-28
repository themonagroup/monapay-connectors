# KiotViet adapter

Adapter lấy OAuth2 client-credentials token, sau đó gọi `POST https://public.kiotapi.com/payments` với `method: "Transfer"`, `amount`, `accountId`, `invoiceId`.

Nguồn chính thức:

- https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-ket-noi-api/public-api/ (mục 2.14.2 Thanh toán hóa đơn)
- https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-ket-noi-api/ket-noi-api/

```dotenv
KIOTVIET_CLIENT_ID=...
KIOTVIET_CLIENT_SECRET=...
KIOTVIET_RETAILER=ma-gian-hang
KIOTVIET_ACCOUNT_ID=12345
ORDER_ID_REGEX=MONA\s+KIOTVIET\s+(?<orderId>\d+)
```

`orderId` ở connector phải là **ID hóa đơn** KiotViet, không phải code đơn đặt hàng. `KIOTVIET_ACCOUNT_ID` là tài khoản ngân hàng tương ứng với phương thức Transfer.

TODO: kiểm với tài liệu KiotViet theo đúng ngành hàng của shop (Retail/FnB/Salon/Hotel dùng base API khác nhau) và tạo một invoice nợ trong gian hàng test trước khi live. File này chỉ triển khai Public API Retail đã dẫn nguồn.
