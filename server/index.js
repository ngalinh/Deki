require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const db = require('./src/db');
const { requireAuth, verifyBassoSession, isDekiAdmin, hasAccess, clearSessionCache } = require('./src/auth');
const { runMigrations } = require('./src/migrate');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));

// ===== Serve frontend (root-level files) =====
const ROOT_DIR = path.resolve(__dirname, '..');
app.use(express.static(ROOT_DIR, { index: false }));

// ===== Health =====
app.get('/health', (req, res) => res.json({ ok: true }));

// ===== Auth: /api/me =====
// Frontend tự gọi để check login + lấy roles + isDekiAdmin
app.get('/api/me', async (req, res) => {
    const cookie = req.headers.cookie || '';
    const user = await verifyBassoSession(cookie);
    if (!user) {
        return res.status(401).json({
            success: false,
            error: 'Chưa đăng nhập basso.vn',
            code: 'NOT_LOGGED_IN'
        });
    }
    const access = await hasAccess(user.email);
    if (!access) {
        return res.status(403).json({
            success: false,
            error: 'Bạn chưa được phân quyền sử dụng Deki. Liên hệ admin để được cấp quyền.',
            code: 'NO_DEKI_ACCESS',
            email: user.email
        });
    }
    user.isDekiAdmin = await isDekiAdmin(user.email);
    res.json({ success: true, user });
});

// ===== Customers API =====

// GET /api/customers - list customers KÈM allOrders + monthlyData + dailyData để frontend tính chart
app.get('/api/customers', requireAuth(), async (req, res) => {
    try {
        const [customers, allOrders] = await Promise.all([
            db.query(`
                SELECT id, name, segment,
                       total_orders AS orders, total_revenue AS revenue
                FROM deki_customers ORDER BY total_revenue DESC
            `),
            db.query(`
                SELECT customer_id, order_code, DATE_FORMAT(order_date, '%d-%b-%Y') AS date,
                       order_date, website, brand, employee, amount
                FROM deki_orders ORDER BY order_date DESC
            `)
        ]);

        // Group orders by customer_id
        const byCustomer = new Map();
        for (const o of allOrders) {
            const arr = byCustomer.get(o.customer_id) || [];
            arr.push(o);
            byCustomer.set(o.customer_id, arr);
        }

        const result = customers.map(c => {
            const orders = byCustomer.get(c.id) || [];
            const websites = new Set();
            const brands = new Set();
            const employees = new Set();
            const monthlyData = {};
            const dailyData = {};
            const allOrdersOut = [];

            for (const o of orders) {
                if (o.website && o.website !== 'N/A') websites.add(o.website);
                if (o.brand) brands.add(o.brand);
                if (o.employee) employees.add(o.employee);

                const amount = Number(o.amount) || 0;
                allOrdersOut.push({
                    code: o.order_code || '',
                    date: o.date || '',
                    website: o.website || '',
                    brand: o.brand || '',
                    employee: o.employee || '',
                    amount
                });

                if (o.order_date) {
                    const ymd = o.order_date instanceof Date
                        ? o.order_date.toISOString().slice(0, 10)
                        : String(o.order_date).slice(0, 10);
                    const ym = ymd.slice(0, 7);

                    if (!monthlyData[ym]) monthlyData[ym] = { orders: 0, revenue: 0 };
                    monthlyData[ym].orders += 1;
                    monthlyData[ym].revenue += amount;

                    if (!dailyData[ymd]) dailyData[ymd] = { orders: 0, revenue: 0 };
                    dailyData[ymd].orders += 1;
                    dailyData[ymd].revenue += amount;
                }
            }

            return {
                id: c.id,
                name: c.name,
                segment: c.segment,
                orders: Number(c.orders) || 0,
                revenue: Number(c.revenue) || 0,
                websites: Array.from(websites),
                brands: Array.from(brands),
                employees: Array.from(employees),
                monthlyData,
                dailyData,
                allOrders: allOrdersOut
            };
        });
        res.json({ success: true, data: result });
    } catch (e) {
        console.error('[api/customers] error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/customers/:id/orders - all orders của 1 khách
app.get('/api/customers/:id/orders', requireAuth(), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const orders = await db.query(`
            SELECT order_code AS code, DATE_FORMAT(order_date, '%d-%b-%Y') AS date,
                   website, brand, employee, amount
            FROM deki_orders WHERE customer_id = ?
            ORDER BY order_date DESC
        `, [id]);
        const result = orders.map(o => ({ ...o, amount: Number(o.amount) || 0 }));
        res.json({ success: true, data: result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/customers/import - upload Excel, parse, bulk insert
app.post('/api/customers/import', requireAuth(), upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Thiếu file Excel' });
    }
    try {
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

        // Detect header row
        let headerRowIndex = -1;
        for (let i = 0; i < Math.min(rows.length, 10); i++) {
            if (rows[i] && rows[i].some(cell => cell && String(cell).toLowerCase().includes('khách hàng'))) {
                headerRowIndex = i;
                break;
            }
        }
        if (headerRowIndex === -1) {
            return res.status(400).json({ success: false, error: 'Không tìm thấy header (cột "Khách Hàng")' });
        }

        const headers = rows[headerRowIndex].map(h => h ? String(h).toLowerCase().trim() : '');
        const colIdx = {
            date: headers.findIndex(h => h.includes('thời gian')),
            code: headers.findIndex(h => h.includes('mã đơn')),
            customer: headers.findIndex(h => h.includes('khách hàng')),
            brand: headers.findIndex(h => h === 'brand'),
            segment: headers.findIndex(h => h.includes('phân nhóm')),
            employee: headers.findIndex(h => h.includes('nhân viên')),
            website: headers.findIndex(h => h === 'website'),
            total: headers.findIndex(h => h.includes('thành tiền'))
        };
        if (colIdx.customer === -1 || colIdx.total === -1) {
            return res.status(400).json({ success: false, error: 'Thiếu cột bắt buộc (Khách Hàng, Thành tiền)' });
        }

        const dataRows = rows.slice(headerRowIndex + 1).filter(r => r && r[colIdx.customer]);

        // Parse rows → list orders + customers
        const customersMap = new Map(); // name → { segment }
        const orders = [];

        for (const row of dataRows) {
            const name = String(row[colIdx.customer]).trim();
            if (!name) continue;
            const segment = colIdx.segment !== -1 && row[colIdx.segment] ? String(row[colIdx.segment]).trim() : null;
            if (!customersMap.has(name)) customersMap.set(name, { segment });

            const dateVal = row[colIdx.date];
            let orderDate = null;
            if (dateVal) {
                if (dateVal instanceof Date) {
                    orderDate = dateVal.toISOString().slice(0, 10);
                } else if (typeof dateVal === 'number') {
                    const epoch = new Date(1899, 11, 30);
                    const d = new Date(epoch.getTime() + dateVal * 86400000);
                    orderDate = d.toISOString().slice(0, 10);
                } else {
                    const str = String(dateVal).trim();
                    const m1 = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
                    if (m1) {
                        const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
                        const mm = months[m1[2].toLowerCase()];
                        if (mm) orderDate = `${m1[3]}-${mm}-${m1[1].padStart(2, '0')}`;
                    } else {
                        const m2 = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                        if (m2) orderDate = `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
                    }
                }
            }

            orders.push({
                customerName: name,
                code: colIdx.code !== -1 && row[colIdx.code] ? String(row[colIdx.code]).trim() : null,
                date: orderDate,
                website: colIdx.website !== -1 && row[colIdx.website] ? String(row[colIdx.website]).trim() : null,
                brand: colIdx.brand !== -1 && row[colIdx.brand] ? String(row[colIdx.brand]).trim() : null,
                employee: colIdx.employee !== -1 && row[colIdx.employee] ? String(row[colIdx.employee]).trim() : null,
                amount: Number(row[colIdx.total]) || 0
            });
        }

        // Insert customers (UPSERT)
        const conn = await db.getPool().getConnection();
        try {
            await conn.beginTransaction();

            // Upsert customers
            for (const [name, info] of customersMap) {
                await conn.execute(
                    `INSERT INTO deki_customers (name, segment) VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE segment = COALESCE(VALUES(segment), segment)`,
                    [name, info.segment]
                );
            }

            // Fetch customer id map
            const [custRows] = await conn.execute('SELECT id, name FROM deki_customers');
            const idMap = new Map(custRows.map(r => [r.name, r.id]));

            // Insert orders (skip duplicate codes)
            let inserted = 0;
            const batchSize = 500;
            for (let i = 0; i < orders.length; i += batchSize) {
                const batch = orders.slice(i, i + batchSize);
                const values = [];
                const placeholders = [];
                for (const o of batch) {
                    const cid = idMap.get(o.customerName);
                    if (!cid) continue;
                    placeholders.push('(?, ?, ?, ?, ?, ?, ?)');
                    values.push(cid, o.code, o.date, o.website, o.brand, o.employee, o.amount);
                }
                if (placeholders.length > 0) {
                    const sql = `INSERT IGNORE INTO deki_orders
                        (customer_id, order_code, order_date, website, brand, employee, amount)
                        VALUES ${placeholders.join(', ')}`;
                    const [r] = await conn.execute(sql, values);
                    inserted += r.affectedRows;
                }
            }

            // Update customer aggregates
            await conn.execute(`
                UPDATE deki_customers c
                LEFT JOIN (
                    SELECT customer_id, COUNT(*) AS cnt, SUM(amount) AS total
                    FROM deki_orders GROUP BY customer_id
                ) o ON o.customer_id = c.id
                SET c.total_orders = COALESCE(o.cnt, 0), c.total_revenue = COALESCE(o.total, 0)
            `);

            await conn.commit();

            res.json({
                success: true,
                customers: customersMap.size,
                orders_inserted: inserted,
                orders_total: orders.length
            });
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
    } catch (e) {
        console.error('[api/import] error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== Permissions API (admin only) =====

function requireAdmin() {
    return (req, res, next) => {
        if (!req.user || !req.user.isDekiAdmin) {
            return res.status(403).json({ success: false, error: 'Chỉ admin mới được phép' });
        }
        next();
    };
}

// GET /api/permissions - list users
app.get('/api/permissions', requireAuth(), requireAdmin(), async (req, res) => {
    try {
        const rows = await db.query('SELECT email, name, is_admin, created_at FROM deki_permissions ORDER BY created_at DESC');
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/permissions - add/update user
app.post('/api/permissions', requireAuth(), requireAdmin(), async (req, res) => {
    try {
        const { email, name, is_admin } = req.body;
        if (!email) return res.status(400).json({ success: false, error: 'Thiếu email' });
        const cleanEmail = String(email).toLowerCase().trim();
        await db.query(
            `INSERT INTO deki_permissions (email, name, is_admin) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), is_admin = VALUES(is_admin)`,
            [cleanEmail, name || null, is_admin ? 1 : 0]
        );
        clearSessionCache(); // để user nhìn thấy tên/quyền mới ngay
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/permissions/:email - remove user
app.delete('/api/permissions/:email', requireAuth(), requireAdmin(), async (req, res) => {
    try {
        const email = String(req.params.email).toLowerCase().trim();
        // Không cho xóa chính mình
        if (email === req.user.email) {
            return res.status(400).json({ success: false, error: 'Không thể xóa chính mình' });
        }
        await db.query('DELETE FROM deki_permissions WHERE email = ?', [email]);
        clearSessionCache();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/customers - xóa toàn bộ data (chỉ admin)
app.delete('/api/customers', requireAuth(), async (req, res) => {
    if (!req.user.isDekiAdmin) {
        return res.status(403).json({ success: false, error: 'Chỉ admin được phép xóa' });
    }
    try {
        await db.query('DELETE FROM deki_orders');
        await db.query('DELETE FROM deki_customers');
        res.json({ success: true, message: 'Đã xóa toàn bộ data' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// SPA fallback: gửi index.html cho mọi route không match (trừ /api)
app.get(/^(?!\/api|\/health).*/, (req, res) => {
    res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

// Start: chạy migrations rồi mới listen
(async () => {
    try {
        await runMigrations();
    } catch (e) {
        console.error('[startup] Migration failed, server vẫn start nhưng API có thể lỗi:', e.message);
    }
    app.listen(PORT, () => {
        console.log(`Deki server listening on port ${PORT}`);
    });
})();
