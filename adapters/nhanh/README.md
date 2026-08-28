# Nhanh.vn adapter

Adapter dùng Open API v3 `POST /v3.0/order/edit?appId=...&businessId=...`, ghi `payment.transferAmount` và `payment.code` từ webhook MONA Pay.

Nguồn chính thức:

- https://apidocs.nhanh.vn/v3/order/edit
- https://apidocs.nhanh.vn/v3
- https://apidocs.nhanh.vn/app

```dotenv
NHANH_APP_ID=123
NHANH_BUSINESS_ID=456
NHANH_ACCESS_TOKEN=...
NHANH_TRANSFER_ACCOUNT_ID=789
# Chỉ set sau khi đối chiếu Order Status của doanh nghiệp:
# NHANH_PAID_STATUS_ID=...
ORDER_ID_REGEX=MONA\s+NHANH\s+(?<orderId>\d+)
```

API v3 dùng raw JSON và header `Authorization` chứa access token. Token có hạn một năm và không có refresh token tự động theo tài liệu.

Mặc định adapter chỉ ghi nhận số tiền chuyển khoản/mã giao dịch. TODO: kiểm với tài liệu Nhanh.vn và workflow doanh nghiệp xem có cần đổi `info.status`; chỉ đặt `NHANH_PAID_STATUS_ID` bằng ID trạng thái lấy từ API/constants của chính tài khoản, không hard-code phỏng đoán.
