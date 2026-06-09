-- Deki CRM database schema (prefix `deki_` để tránh conflict trong DB shared `basso_platform`)
-- Chạy: mysql -u <user> -p basso_platform < init.sql

-- Bảng deki_customers: thông tin tổng hợp khách (cached aggregates)
-- Khách phân biệt theo (name, phone): cùng tên khác SĐT = 2 khách riêng
CREATE TABLE IF NOT EXISTS deki_customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(32) NOT NULL DEFAULT '',
    segment VARCHAR(64),
    total_orders INT DEFAULT 0,
    total_revenue DECIMAL(18, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_name_phone (name, phone),
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

-- ===== CÔNG VIỆC: Follow khách =====
CREATE TABLE IF NOT EXISTS deki_follow_customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(32),
    nhom_khach VARCHAR(32),           -- khach_le / ctv / seller
    fb_link VARCHAR(512),
    nguon_khach VARCHAR(32),          -- Facebook / Zalo / Tiktok / Instagram / Threads
    nganh_hang VARCHAR(32),           -- Order / Nhập hàng
    nhu_cau_website VARCHAR(255),
    nhu_cau_sp TEXT,
    tinh_trang VARCHAR(64),           -- Inbox khách / Khách inbox / Mời deal / Mời hàng stock / Đã mua hàng / Dừng inbox
    ngay_lien_he DATE,
    tags TEXT,                        -- JSON array string
    ghi_chu TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_phone (phone),
    INDEX idx_tinh_trang (tinh_trang)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lịch sử liên hệ (mỗi lần đổi tình trạng + ngày liên hệ → 1 dòng)
CREATE TABLE IF NOT EXISTS deki_follow_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    follow_id INT NOT NULL,
    tinh_trang VARCHAR(64),
    ngay_lien_he DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (follow_id) REFERENCES deki_follow_customers(id) ON DELETE CASCADE,
    INDEX idx_follow (follow_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tag tùy chỉnh cho Follow khách (preset + CSKH tự tạo)
CREATE TABLE IF NOT EXISTS deki_follow_tags (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===== CÔNG VIỆC: Bàn giao =====
CREATE TABLE IF NOT EXISTS deki_handover_tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ngay_thang DATE,
    task VARCHAR(64),                 -- Giao hàng / Xử lý issue / Hàng stock
    cong_viec TEXT,
    tinh_trang VARCHAR(16) DEFAULT 'pending',  -- pending / done
    nguoi_lam VARCHAR(16),            -- cskh / sale
    ghi_chu TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ngay (ngay_thang),
    INDEX idx_task (task),
    INDEX idx_tinh_trang (tinh_trang),
    INDEX idx_nguoi_lam (nguoi_lam)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
