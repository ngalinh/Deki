-- Migration: thêm cột name vào table permissions
-- Chạy nếu DB đã có table permissions cũ (không có cột name)

ALTER TABLE permissions ADD COLUMN name VARCHAR(128) AFTER email;
