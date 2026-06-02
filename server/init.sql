-- Deki CRM database schema (prefix `deki_` để tránh conflict trong DB shared `basso_platform`)
-- Chạy: mysql -u <user> -p basso_platform < init.sql

-- Bảng deki_customers: thông tin tổng hợp khách (cached aggregates)
CREATE TABLE IF NOT EXISTS deki_customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    phone VARCHAR(32),
    segment VARCHAR(64),
    total_orders INT DEFAULT 0,
    total_revenue DECIMAL(18, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_segment (segment),
    INDEX idx_revenue (total_revenue DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bảng deki_orders: chi tiết từng đơn hàng
CREATE TABLE IF NOT EXISTS deki_orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    order_code VARCHAR(64) UNIQUE,
    order_date DATE,
    website VARCHAR(255),
    brand VARCHAR(64),
    employee VARCHAR(128),
    amount DECIMAL(18, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES deki_customers(id) ON DELETE CASCADE,
    INDEX idx_customer (customer_id),
    INDEX idx_date (order_date),
    INDEX idx_website (website),
    INDEX idx_brand (brand),
    INDEX idx_employee (employee)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bảng deki_permissions: phân quyền user truy cập Deki
--   name       : tên hiển thị trong app
--   staff_name : tên nhân viên duyệt đơn trong Excel (vd: "Linh Thảo", "Kênh CO")
--                non-admin chỉ thấy được đơn có employee = staff_name của họ
CREATE TABLE IF NOT EXISTS deki_permissions (
    email VARCHAR(255) PRIMARY KEY,
    name VARCHAR(128),
    staff_name VARCHAR(128),
    is_admin TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
