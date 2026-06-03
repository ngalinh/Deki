// Auto-migrate: tạo tables + insert super admin lúc server start
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function runMigrations() {
    try {
        // Đọc init.sql
        const sqlPath = path.join(__dirname, '..', 'init.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');

        // Split theo `;` để chạy từng statement (bỏ comments + empty lines)
        const statements = sql
            .split(';')
            .map(s => s.replace(/--[^\n]*/g, '').trim())
            .filter(s => s.length > 0);

        const pool = db.getPool();
        for (const stmt of statements) {
            await pool.query(stmt);
        }
        console.log(`[migrate] Đã chạy ${statements.length} statement từ init.sql`);

        // Migration: thêm cột staff_name vào deki_permissions nếu chưa có
        // (CREATE TABLE IF NOT EXISTS sẽ không thêm cột mới khi table đã tồn tại)
        try {
            const cols = await db.query(
                `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'deki_permissions'
                   AND COLUMN_NAME = 'staff_name'`
            );
            if (cols.length === 0) {
                await pool.query(`ALTER TABLE deki_permissions ADD COLUMN staff_name VARCHAR(128) AFTER name`);
                console.log('[migrate] Đã thêm cột staff_name vào deki_permissions');
            }
        } catch (e) {
            console.error('[migrate] staff_name migration error:', e.message);
        }

        // Migration: thêm cột phone vào deki_customers nếu chưa có
        try {
            const cols = await db.query(
                `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'deki_customers'
                   AND COLUMN_NAME = 'phone'`
            );
            if (cols.length === 0) {
                await pool.query(`ALTER TABLE deki_customers ADD COLUMN phone VARCHAR(32) NOT NULL DEFAULT '' AFTER name`);
                console.log('[migrate] Đã thêm cột phone vào deki_customers');
            }
        } catch (e) {
            console.error('[migrate] phone migration error:', e.message);
        }

        // Migration: đổi unique key từ (name) sang (name, phone)
        // → khách cùng tên khác SĐT được tách thành 2 khách riêng
        try {
            // 1) Chuẩn hóa phone NULL → '' (composite unique cần phone không NULL)
            await pool.query(`UPDATE deki_customers SET phone = '' WHERE phone IS NULL`);

            // 2) Đảm bảo cột phone NOT NULL DEFAULT ''
            await pool.query(`ALTER TABLE deki_customers MODIFY COLUMN phone VARCHAR(32) NOT NULL DEFAULT ''`).catch(() => {});

            // 3) Lấy danh sách index hiện có
            const indexes = await db.query(
                `SELECT DISTINCT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deki_customers'`
            );
            const indexNames = indexes.map(i => i.INDEX_NAME);

            // 4) Drop unique index cũ trên `name` (tên index mặc định = 'name')
            if (indexNames.includes('name')) {
                await pool.query(`ALTER TABLE deki_customers DROP INDEX name`);
                console.log('[migrate] Đã drop unique index cũ trên name');
            }

            // 5) Thêm composite unique (name, phone) nếu chưa có
            if (!indexNames.includes('uniq_name_phone')) {
                await pool.query(`ALTER TABLE deki_customers ADD UNIQUE KEY uniq_name_phone (name, phone)`);
                console.log('[migrate] Đã thêm unique key (name, phone)');
            }
        } catch (e) {
            console.error('[migrate] unique key migration error:', e.message);
        }

        // Insert super admin từ env (nếu chưa có)
        const superAdmin = (process.env.DEKI_SUPER_ADMIN || '').toLowerCase().trim();
        if (superAdmin) {
            await db.query(
                `INSERT INTO deki_permissions (email, name, is_admin)
                 VALUES (?, ?, 1)
                 ON DUPLICATE KEY UPDATE is_admin = 1`,
                [superAdmin, superAdmin.split('@')[0]]
            );
            console.log(`[migrate] Super admin ready: ${superAdmin}`);
        }
    } catch (err) {
        console.error('[migrate] Error:', err.message);
        throw err;
    }
}

module.exports = { runMigrations };
