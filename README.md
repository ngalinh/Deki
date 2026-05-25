# Deki

CRM web app để quản lý khách hàng, đơn hàng, và phân tích doanh thu cho Basso.

## Tính năng

- **Dashboard**: Thống kê tổng quan (khách hàng, đơn hàng, doanh thu, TB/khách) + biểu đồ doanh thu theo tuần/tháng/năm + pie chart phân nhóm + bar chart top website
- **Khách hàng**: Danh sách khách với search, filter (phân nhóm/website/nhân viên), phân trang, popup chi tiết
- **Báo cáo & Phân tích**: Top 10 website, phân nhóm khách hàng, top 10 khách doanh thu cao - filter theo tuần/tháng/năm/tùy chọn ngày
- **Lọc khách hàng**: Filter nâng cao 8 tiêu chí, export Excel
- **Import Excel**: Upload `DS_DONHANG.xlsx` để tự động build data (parse theo ngày, tổng hợp orders/customers)
- **Persistence**: Lưu localStorage, không mất khi reload

## Tech stack

- HTML/CSS/JavaScript vanilla
- [Chart.js](https://www.chartjs.org/) - biểu đồ
- [SheetJS](https://sheetjs.com/) - parse/export Excel
- Inter font

## Cách dùng

1. Mở `index.html` trong trình duyệt
2. Vào tab **Khách hàng** → click **"Cập nhật từ Excel"**
3. Chọn file Excel format `DS_DONHANG.xlsx` (cột: Thời gian hoàn thành, Mã Đơn Hàng, Khách Hàng, Brand, Phân nhóm, Nhân viên duyệt đơn, Website, Thành tiền)

## Brand colors

- Primary (Teal): `#00BCD4`
- Secondary (Navy): `#003D5C`
- Accent (Orange): `#FFB84D`
