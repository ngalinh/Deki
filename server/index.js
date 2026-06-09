require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const db = require('./src/db');
const { requireAuth, requireApiKey, verifyBassoSession, isDekiAdmin, hasAccess, clearSessionCache, DEV_MODE, getDevUser } = require('./src/auth');
const { runMigrations } = require('./src/migrate');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));

// ===== Serve frontend (root-level files) =====
const ROOT_DIR = path.resolve(__dirname, '..');
// Không cache index.html → mỗi lần reload luôn lấy bản mới nhất (tránh dính JS cũ)
app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html')) res.set('Cache-Control', 'no-store');
    next();
});
app.use(express.static(ROOT_DIR, { index: false }));

// Helper middleware: chỉ cho admin
function requireAdmin() {
    return (req, res, next) => {
        if (!req.user || !req.user.isDekiAdmin) {
            return res.status(403).json({ success: false, error: 'Chỉ admin mới được phép' });
        }
        next();
    };
}

// ===== Health =====
app.get('/health', (req, res) => res.json({ ok: true }));

// ===== Auth: /api/me =====
// Frontend tự gọi để check login + lấy roles + isDekiAdmin
app.get('/api/me', async (req, res) => {
    if (DEV_MODE) return res.json({ success: true, user: getDevUser() });
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
// Phân quyền: admin thấy hết, non-admin chỉ thấy đơn của mình (employee = staffName)
app.get('/api/customers', requireAuth(), async (req, res) => {
    try {
        const isAdmin = !!req.user.isDekiAdmin;
        const staffName = req.user.staffName;

        // Non-admin chưa được map staff_name → không thấy gì
        if (!isAdmin && !staffName) {
            return res.json({
                success: true,
                data: [],
                notice: 'Tài khoản chưa được map với tên nhân viên. Liên hệ admin để được cấp.'
            });
        }

        // Build query — filter orders theo employee nếu không phải admin
        const orderWhere = isAdmin ? '' : 'WHERE employee = ?';
        const orderParams = isAdmin ? [] : [staffName];

        const allOrders = await db.query(
            `SELECT customer_id, order_code, DATE_FORMAT(order_date, '%d-%b-%Y') AS date,
                    order_date, website, brand, employee, amount
             FROM deki_orders ${orderWhere}
             ORDER BY order_date DESC`,
            orderParams
        );

        // Lấy danh sách customer_id có orders sau khi filter
        const customerIds = [...new Set(allOrders.map(o => o.customer_id))];
        let customers = [];
        if (isAdmin) {
            customers = await db.query(`
                SELECT id, name, phone, segment, total_orders AS orders, total_revenue AS revenue
                FROM deki_customers ORDER BY total_revenue DESC
            `);
        } else if (customerIds.length > 0) {
            // Non-admin: chỉ lấy customers có orders → tính orders/revenue từ filtered orders
            const placeholders = customerIds.map(() => '?').join(',');
            customers = await db.query(
                `SELECT id, name, phone, segment FROM deki_customers WHERE id IN (${placeholders})`,
                customerIds
            );
            // Compute orders/revenue per customer từ filtered orders
            const stats = new Map();
            for (const o of allOrders) {
                const s = stats.get(o.customer_id) || { orders: 0, revenue: 0 };
                s.orders += 1;
                s.revenue += Number(o.amount) || 0;
                stats.set(o.customer_id, s);
            }
            customers = customers.map(c => ({
                ...c,
                orders: stats.get(c.id)?.orders || 0,
                revenue: stats.get(c.id)?.revenue || 0
            })).sort((a, b) => b.revenue - a.revenue);
        }

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
                phone: c.phone || '',
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

// GET /api/customers/:id/orders - all orders của 1 khách (filter theo staffName nếu non-admin)
app.get('/api/customers/:id/orders', requireAuth(), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const isAdmin = !!req.user.isDekiAdmin;
        const staffName = req.user.staffName;
        if (!isAdmin && !staffName) return res.json({ success: true, data: [] });

        const where = isAdmin ? 'WHERE customer_id = ?' : 'WHERE customer_id = ? AND employee = ?';
        const params = isAdmin ? [id] : [id, staffName];

        const orders = await db.query(
            `SELECT order_code AS code, DATE_FORMAT(order_date, '%d-%b-%Y') AS date,
                    website, brand, employee, amount
             FROM deki_orders ${where} ORDER BY order_date DESC`,
            params
        );
        const result = orders.map(o => ({ ...o, amount: Number(o.amount) || 0 }));
        res.json({ success: true, data: result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/customers/import - upload Excel, parse, bulk insert (admin only)
app.post('/api/customers/import', requireAuth(), requireAdmin(), upload.single('file'), async (req, res) => {
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
            phone: headers.findIndex(h => h.includes('điện thoại') || h.includes('sđt') || h.includes('số đt')),
            brand: headers.findIndex(h => h === 'brand'),
            segment: headers.findIndex(h => h.includes('phân nhóm')),
            employee: headers.findIndex(h => h.includes('nhân viên')),
            website: headers.findIndex(h => h === 'website'),
            tyGia: headers.findIndex(h => h.includes('tỷ giá') || h.includes('tỉ giá')),
            shipQt: headers.findIndex(h => h.includes('ship quốc tế')),
            phuThu: headers.findIndex(h => h.includes('phụ thu')),
            giamGia: headers.findIndex(h => h === 'giảm giá' || (h.includes('giảm giá') && !h.includes('lý do'))),
            lyDoGiamGia: headers.findIndex(h => h.includes('lý do')),
            total: headers.findIndex(h => h.includes('thành tiền'))
        };
        if (colIdx.customer === -1 || colIdx.total === -1) {
            return res.status(400).json({ success: false, error: 'Thiếu cột bắt buộc (Khách Hàng, Thành tiền)' });
        }

        const dataRows = rows.slice(headerRowIndex + 1).filter(r => r && r[colIdx.customer]);

        // Parse rows → list orders + customers
        // Key khách = name + phone → cùng tên khác SĐT là 2 khách riêng
        const custKey = (name, phone) => `${name} ${phone || ''}`;
        const customersMap = new Map(); // key → { name, phone, segment }
        const orders = [];

        for (const row of dataRows) {
            const name = String(row[colIdx.customer]).trim();
            if (!name) continue;
            const segment = colIdx.segment !== -1 && row[colIdx.segment] ? String(row[colIdx.segment]).trim() : null;
            const phone = colIdx.phone !== -1 && row[colIdx.phone] != null ? String(row[colIdx.phone]).trim() : '';
            const key = custKey(name, phone);
            if (!customersMap.has(key)) {
                customersMap.set(key, { name, phone, segment });
            } else if (segment && !customersMap.get(key).segment) {
                customersMap.get(key).segment = segment;
            }

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

            const numAt = (i) => (i !== -1 && row[i] != null && row[i] !== '') ? (Number(row[i]) || 0) : 0;
            orders.push({
                customerKey: key,
                code: colIdx.code !== -1 && row[colIdx.code] ? String(row[colIdx.code]).trim() : null,
                date: orderDate,
                website: colIdx.website !== -1 && row[colIdx.website] ? String(row[colIdx.website]).trim() : null,
                brand: colIdx.brand !== -1 && row[colIdx.brand] ? String(row[colIdx.brand]).trim() : null,
                employee: colIdx.employee !== -1 && row[colIdx.employee] ? String(row[colIdx.employee]).trim() : null,
                tyGia: numAt(colIdx.tyGia),
                shipQt: numAt(colIdx.shipQt),
                phuThu: numAt(colIdx.phuThu),
                giamGia: numAt(colIdx.giamGia),
                lyDoGiamGia: colIdx.lyDoGiamGia !== -1 && row[colIdx.lyDoGiamGia] ? String(row[colIdx.lyDoGiamGia]).trim() : null,
                amount: Number(row[colIdx.total]) || 0
            });
        }

        // Insert customers (UPSERT)
        const conn = await db.getPool().getConnection();
        try {
            await conn.beginTransaction();

            // Upsert customers (theo name + phone)
            for (const info of customersMap.values()) {
                await conn.execute(
                    `INSERT INTO deki_customers (name, phone, segment) VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        segment = COALESCE(VALUES(segment), segment)`,
                    [info.name, info.phone, info.segment]
                );
            }

            // Fetch customer id map (key = name + phone)
            const [custRows] = await conn.execute('SELECT id, name, phone FROM deki_customers');
            const idMap = new Map(custRows.map(r => [custKey(r.name, r.phone), r.id]));

            // Insert orders (skip duplicate codes)
            let inserted = 0;
            const batchSize = 500;
            for (let i = 0; i < orders.length; i += batchSize) {
                const batch = orders.slice(i, i + batchSize);
                const values = [];
                const placeholders = [];
                for (const o of batch) {
                    const cid = idMap.get(o.customerKey);
                    if (!cid) continue;
                    placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
                    values.push(cid, o.code, o.date, o.website, o.brand, o.employee,
                        o.tyGia, o.shipQt, o.phuThu, o.giamGia, o.lyDoGiamGia, o.amount);
                }
                if (placeholders.length > 0) {
                    const sql = `INSERT IGNORE INTO deki_orders
                        (customer_id, order_code, order_date, website, brand, employee,
                         ty_gia, ship_quoc_te, phu_thu, giam_gia, ly_do_giam_gia, amount)
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

// GET /api/permissions - list users
app.get('/api/permissions', requireAuth(), requireAdmin(), async (req, res) => {
    try {
        const rows = await db.query('SELECT email, name, staff_name, is_admin, created_at FROM deki_permissions ORDER BY created_at DESC');
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/employees - danh sách tên nhân viên trong dữ liệu (cho admin chọn map)
app.get('/api/employees', requireAuth(), requireAdmin(), async (req, res) => {
    try {
        const rows = await db.query(
            `SELECT DISTINCT employee FROM deki_orders
             WHERE employee IS NOT NULL AND employee != ''
             ORDER BY employee`
        );
        res.json({ success: true, data: rows.map(r => r.employee) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/permissions - add/update user
app.post('/api/permissions', requireAuth(), requireAdmin(), async (req, res) => {
    try {
        const { email, name, staff_name, is_admin } = req.body;
        if (!email) return res.status(400).json({ success: false, error: 'Thiếu email' });
        const cleanEmail = String(email).toLowerCase().trim();
        await db.query(
            `INSERT INTO deki_permissions (email, name, staff_name, is_admin) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), staff_name = VALUES(staff_name), is_admin = VALUES(is_admin)`,
            [cleanEmail, name || null, staff_name || null, is_admin ? 1 : 0]
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

// ===== Partner API (server-to-server, auth bằng API key) =====
// Cho Zalo CRM tra thông tin khách + đơn theo SĐT. KHÔNG dùng session basso, không scope theo nhân viên.
// GET /api/partner/customer-by-phone?phone=09xxxxxxxx
app.get('/api/partner/customer-by-phone', requireApiKey(), async (req, res) => {
    try {
        const raw = String(req.query.phone || '').trim();
        const digits = raw.replace(/\D/g, '');
        if (digits.length < 8) {
            return res.status(400).json({ success: false, error: 'SĐT không hợp lệ' });
        }
        // Khớp theo 9 chữ số cuối (lõi số VN) → bỏ qua khác biệt 0/+84/khoảng trắng.
        const core = digits.slice(-9);
        const customers = await db.query(
            `SELECT id, name, phone, segment, total_orders, total_revenue
             FROM deki_customers WHERE REPLACE(REPLACE(phone,' ',''),'+','') LIKE CONCAT('%', ?) LIMIT 1`,
            [core]
        );
        if (customers.length === 0) {
            return res.json({ success: true, found: false, customer: null, orders: [] });
        }
        const c = customers[0];
        const orders = await db.query(
            `SELECT order_code AS code, DATE_FORMAT(order_date, '%d-%m-%Y') AS date,
                    website, brand, employee, amount
             FROM deki_orders WHERE customer_id = ? ORDER BY order_date DESC`,
            [c.id]
        );
        res.json({
            success: true,
            found: true,
            customer: {
                id: c.id, name: c.name, phone: c.phone || '', segment: c.segment,
                totalOrders: Number(c.total_orders) || 0,
                totalRevenue: Number(c.total_revenue) || 0,
            },
            orders: orders.map(o => ({ ...o, amount: Number(o.amount) || 0 })),
        });
    } catch (e) {
        console.error('[api/partner/customer-by-phone] error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/partner/segments-by-phones - tra phân nhóm + tổng đơn/doanh thu cho NHIỀU SĐT 1 lần.
// Body: { phones: ["09...", ...] } → { success, map: { "<phone gốc>": { segment, totalOrders, totalRevenue } } }
app.post('/api/partner/segments-by-phones', requireApiKey(), async (req, res) => {
    try {
        const phones = Array.isArray(req.body?.phones) ? req.body.phones : [];
        const coreOf = (p) => String(p || '').replace(/\D/g, '').slice(-9);
        const cores = [...new Set(phones.map(coreOf).filter(c => c.length >= 8))];
        if (cores.length === 0) return res.json({ success: true, map: {} });
        const placeholders = cores.map(() => '?').join(',');
        const rows = await db.query(
            `SELECT phone, segment, total_orders, total_revenue FROM deki_customers
             WHERE RIGHT(REPLACE(REPLACE(phone,' ',''),'+',''), 9) IN (${placeholders})`,
            cores
        );
        const byCore = new Map();
        for (const r of rows) byCore.set(coreOf(r.phone), r);
        const map = {};
        for (const p of phones) {
            const r = byCore.get(coreOf(p));
            if (r) map[p] = { segment: r.segment || '', totalOrders: Number(r.total_orders) || 0, totalRevenue: Number(r.total_revenue) || 0 };
        }
        res.json({ success: true, map });
    } catch (e) {
        console.error('[api/partner/segments-by-phones] error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== ĐƠN HÀNG: danh sách đơn (như Excel) + lọc nhân viên/thời gian + phân trang =====
app.get('/api/orders', requireAuth(), async (req, res) => {
    try {
        const isAdmin = !!req.user.isDekiAdmin;
        const staffName = req.user.staffName;
        if (!isAdmin && !staffName) return res.json({ success: true, data: [], total: 0, page: 1, pageSize: 50 });

        const where = [], params = [];
        if (isAdmin) {
            if (req.query.employee) { where.push('o.employee = ?'); params.push(req.query.employee); }
        } else {
            where.push('o.employee = ?'); params.push(staffName);
        }
        if (req.query.from) { where.push('o.order_date >= ?'); params.push(req.query.from); }
        if (req.query.to) { where.push('o.order_date <= ?'); params.push(req.query.to); }
        const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
        const offset = (page - 1) * pageSize;

        const totalRow = await db.query(`SELECT COUNT(*) AS cnt FROM deki_orders o ${whereSql}`, params);
        const total = Number(totalRow[0]?.cnt) || 0;

        // LIMIT/OFFSET inline (đã validate là số nguyên → an toàn)
        const rows = await db.query(
            `SELECT DATE_FORMAT(o.order_date,'%d-%m-%Y') AS date, o.order_code AS code,
                    c.name AS customer, c.phone AS phone, c.segment AS segment,
                    o.brand, o.employee, o.website,
                    o.ty_gia, o.ship_quoc_te, o.phu_thu, o.giam_gia, o.ly_do_giam_gia, o.amount
             FROM deki_orders o JOIN deki_customers c ON c.id = o.customer_id
             ${whereSql} ORDER BY o.order_date DESC, o.id DESC
             LIMIT ${pageSize} OFFSET ${offset}`,
            params
        );
        res.json({
            success: true,
            data: rows.map(r => ({
                ...r,
                ty_gia: Number(r.ty_gia) || 0,
                ship_quoc_te: Number(r.ship_quoc_te) || 0,
                phu_thu: Number(r.phu_thu) || 0,
                giam_gia: Number(r.giam_gia) || 0,
                amount: Number(r.amount) || 0
            })),
            total, page, pageSize
        });
    } catch (e) {
        console.error('[api/orders] error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== CÔNG VIỆC: Follow khách =====

// GET /api/follow - list follow customers (kèm tags, history, cờ "đã mua hàng")
app.get('/api/follow', requireAuth(), async (req, res) => {
    try {
        const rows = await db.query(`SELECT * FROM deki_follow_customers ORDER BY ngay_lien_he DESC, id DESC`);
        const histories = await db.query(`SELECT follow_id, tinh_trang, DATE_FORMAT(ngay_lien_he, '%Y-%m-%d') AS ngay_lien_he, created_at
                                          FROM deki_follow_history ORDER BY created_at DESC`);
        const histByFollow = new Map();
        for (const h of histories) {
            const arr = histByFollow.get(h.follow_id) || [];
            arr.push({ tinh_trang: h.tinh_trang, ngay_lien_he: h.ngay_lien_he, created_at: h.created_at });
            histByFollow.set(h.follow_id, arr);
        }

        // Map SĐT (9 số cuối) → có trong đơn hàng?
        const boughtCores = new Set(
            (await db.query(`SELECT RIGHT(REPLACE(REPLACE(phone,' ',''),'+',''), 9) AS core FROM deki_customers WHERE phone <> ''`))
                .map(r => r.core).filter(c => c && c.length >= 8)
        );

        const data = rows.map(r => {
            const core = String(r.phone || '').replace(/\D/g, '').slice(-9);
            const bought = core.length >= 8 && boughtCores.has(core);
            let tags = [];
            try { tags = r.tags ? JSON.parse(r.tags) : []; } catch { tags = []; }
            // nhu_cau_website: JSON array; fallback nếu là chuỗi đơn cũ
            let websites = [];
            if (r.nhu_cau_website) {
                try {
                    const parsed = JSON.parse(r.nhu_cau_website);
                    websites = Array.isArray(parsed) ? parsed : [String(r.nhu_cau_website)];
                } catch { websites = [String(r.nhu_cau_website)]; }
            }
            return {
                id: r.id, name: r.name, phone: r.phone || '', nhom_khach: r.nhom_khach || '',
                fb_link: r.fb_link || '', nguon_khach: r.nguon_khach || '', nganh_hang: r.nganh_hang || '',
                nhu_cau_website: websites, nhu_cau_sp: r.nhu_cau_sp || '',
                tinh_trang: bought ? 'Đã mua hàng' : (r.tinh_trang || ''),
                bought,
                ngay_lien_he: r.ngay_lien_he ? new Date(r.ngay_lien_he).toISOString().slice(0, 10) : '',
                tags, ghi_chu: r.ghi_chu || '',
                history: histByFollow.get(r.id) || []
            };
        });
        res.json({ success: true, data });
    } catch (e) {
        console.error('[api/follow] error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/follow - thêm khách follow
app.post('/api/follow', requireAuth(), async (req, res) => {
    try {
        const b = req.body || {};
        if (!b.name) return res.status(400).json({ success: false, error: 'Thiếu tên khách hàng' });
        const tags = Array.isArray(b.tags) ? JSON.stringify(b.tags) : '[]';
        const websites = Array.isArray(b.nhu_cau_website) ? JSON.stringify(b.nhu_cau_website) : (b.nhu_cau_website || null);
        const result = await db.query(
            `INSERT INTO deki_follow_customers
             (name, phone, nhom_khach, fb_link, nguon_khach, nganh_hang, nhu_cau_website, nhu_cau_sp, tinh_trang, ngay_lien_he, tags, ghi_chu)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [b.name, b.phone || null, b.nhom_khach || null, b.fb_link || null, b.nguon_khach || null,
             b.nganh_hang || null, websites, b.nhu_cau_sp || null,
             b.tinh_trang || null, b.ngay_lien_he || null, tags, b.ghi_chu || null]
        );
        // Ghi history nếu có tình trạng / ngày liên hệ
        if (b.tinh_trang || b.ngay_lien_he) {
            await db.query(`INSERT INTO deki_follow_history (follow_id, tinh_trang, ngay_lien_he) VALUES (?,?,?)`,
                [result.insertId, b.tinh_trang || null, b.ngay_lien_he || null]);
        }
        res.json({ success: true, id: result.insertId });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// PUT /api/follow/:id - cập nhật
app.put('/api/follow/:id', requireAuth(), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const b = req.body || {};
        // Lấy bản ghi cũ để biết tình trạng/ngày có đổi không
        const old = await db.query(`SELECT tinh_trang, DATE_FORMAT(ngay_lien_he,'%Y-%m-%d') AS ngay_lien_he FROM deki_follow_customers WHERE id = ?`, [id]);
        if (old.length === 0) return res.status(404).json({ success: false, error: 'Không tìm thấy' });
        const tags = Array.isArray(b.tags) ? JSON.stringify(b.tags) : '[]';
        const websites = Array.isArray(b.nhu_cau_website) ? JSON.stringify(b.nhu_cau_website) : (b.nhu_cau_website || null);
        await db.query(
            `UPDATE deki_follow_customers SET
             name=?, phone=?, nhom_khach=?, fb_link=?, nguon_khach=?, nganh_hang=?,
             nhu_cau_website=?, nhu_cau_sp=?, tinh_trang=?, ngay_lien_he=?, tags=?, ghi_chu=?
             WHERE id=?`,
            [b.name, b.phone || null, b.nhom_khach || null, b.fb_link || null, b.nguon_khach || null,
             b.nganh_hang || null, websites, b.nhu_cau_sp || null,
             b.tinh_trang || null, b.ngay_lien_he || null, tags, b.ghi_chu || null, id]
        );
        // Ghi history nếu tình trạng HOẶC ngày liên hệ thay đổi
        const changed = (b.tinh_trang || '') !== (old[0].tinh_trang || '') ||
                        (b.ngay_lien_he || '') !== (old[0].ngay_lien_he || '');
        if (changed && (b.tinh_trang || b.ngay_lien_he)) {
            await db.query(`INSERT INTO deki_follow_history (follow_id, tinh_trang, ngay_lien_he) VALUES (?,?,?)`,
                [id, b.tinh_trang || null, b.ngay_lien_he || null]);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/follow/:id
app.delete('/api/follow/:id', requireAuth(), async (req, res) => {
    try {
        await db.query(`DELETE FROM deki_follow_customers WHERE id = ?`, [Number(req.params.id)]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/follow-tags - danh sách tag
app.get('/api/follow-tags', requireAuth(), async (req, res) => {
    try {
        const rows = await db.query(`SELECT name FROM deki_follow_tags ORDER BY name`);
        res.json({ success: true, data: rows.map(r => r.name) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/follow-tags - tạo tag mới
app.post('/api/follow-tags', requireAuth(), async (req, res) => {
    try {
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ success: false, error: 'Thiếu tên tag' });
        await db.query(`INSERT IGNORE INTO deki_follow_tags (name) VALUES (?)`, [name]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== CÔNG VIỆC: Bàn giao =====

// GET /api/handover - list (filters: from, to, task, tinh_trang, nguoi_lam)
app.get('/api/handover', requireAuth(), async (req, res) => {
    try {
        const where = [], params = [];
        if (req.query.from) { where.push('ngay_thang >= ?'); params.push(req.query.from); }
        if (req.query.to) { where.push('ngay_thang <= ?'); params.push(req.query.to); }
        if (req.query.task) { where.push('task = ?'); params.push(req.query.task); }
        if (req.query.tinh_trang) { where.push('tinh_trang = ?'); params.push(req.query.tinh_trang); }
        if (req.query.nguoi_lam) { where.push('nguoi_lam = ?'); params.push(req.query.nguoi_lam); }
        const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const rows = await db.query(
            `SELECT id, DATE_FORMAT(ngay_thang,'%Y-%m-%d') AS ngay_thang, task, cong_viec, tinh_trang, nguoi_lam, ghi_chu
             FROM deki_handover_tasks ${whereSql} ORDER BY ngay_thang DESC, id DESC`,
            params
        );
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error('[api/handover] error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/handover
app.post('/api/handover', requireAuth(), async (req, res) => {
    try {
        const b = req.body || {};
        const result = await db.query(
            `INSERT INTO deki_handover_tasks (ngay_thang, task, cong_viec, tinh_trang, nguoi_lam, ghi_chu)
             VALUES (?,?,?,?,?,?)`,
            [b.ngay_thang || null, b.task || null, b.cong_viec || null,
             b.tinh_trang || 'pending', b.nguoi_lam || null, b.ghi_chu || null]
        );
        res.json({ success: true, id: result.insertId });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// PUT /api/handover/:id
app.put('/api/handover/:id', requireAuth(), async (req, res) => {
    try {
        const b = req.body || {};
        await db.query(
            `UPDATE deki_handover_tasks SET ngay_thang=?, task=?, cong_viec=?, tinh_trang=?, nguoi_lam=?, ghi_chu=? WHERE id=?`,
            [b.ngay_thang || null, b.task || null, b.cong_viec || null,
             b.tinh_trang || 'pending', b.nguoi_lam || null, b.ghi_chu || null, Number(req.params.id)]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/handover/:id
app.delete('/api/handover/:id', requireAuth(), async (req, res) => {
    try {
        await db.query(`DELETE FROM deki_handover_tasks WHERE id = ?`, [Number(req.params.id)]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// SPA fallback: gửi index.html cho mọi route không match (trừ /api)
app.get(/^(?!\/api|\/health).*/, (req, res) => {
    res.set('Cache-Control', 'no-store');
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
