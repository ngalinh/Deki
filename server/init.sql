-- Deki CRM database schema
-- Chạy: mysql -u root -p deki_crm < init.sql

CREATE DATABASE IF NOT EXISTS deki_crm DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE deki_crm;

-- Bảng customers: thông tin tổng hợp khách (cached aggregates)
CREATE TABLE IF NOT EXISTS customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    segment VARCHAR(64),
    total_orders INT DEFAULT 0,
    total_revenue DECIMAL(18, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_segment (segment),
    INDEX idx_revenue (total_revenue DESC)
) ENGINE=InnoDB;

-- Bảng orders: chi tiết từng đơn hàng
CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    order_code VARCHAR(64) UNIQUE,
    order_date DATE,
    website VARCHAR(255),
    brand VARCHAR(64),
    employee VARCHAR(128),
    amount DECIMAL(18, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    INDEX idx_customer (customer_id),
    INDEX idx_date (order_date),
    INDEX idx_website (website),
    INDEX idx_brand (brand),
    INDEX idx_employee (employee)
) ENGINE=InnoDB;

-- Bảng permissions: phân quyền user truy cập Deki (giống Xeko's user-permissions.json)
CREATE TABLE IF NOT EXISTS permissions (
    email VARCHAR(255) PRIMARY KEY,
    is_admin TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
