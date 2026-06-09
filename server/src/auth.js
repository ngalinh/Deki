// Auth gate: verify Basso session cookie (giống Xeko)
const crypto = require('crypto');
const db = require('./db');

const BASSO_AUTH_URL = process.env.BASSO_AUTH_URL || 'https://ai.basso.vn/platform/api/auth/session';
const CACHE_TTL_MS = 30 * 1000;
const SUPER_ADMIN_EMAIL = (process.env.DEKI_SUPER_ADMIN || '').toLowerCase().trim();

// DEV mode: chạy local KHÔNG cần cookie basso.vn. Bật bằng DEKI_DEV_MODE=1 trong .env.
// Khi bật → mọi request coi như super admin (dev@local). TUYỆT ĐỐI không bật trên production.
const DEV_MODE = process.env.DEKI_DEV_MODE === '1';
const DEV_USER = { email: SUPER_ADMIN_EMAIL || 'dev@local', name: 'Dev (local)', staffNames: [], roles: ['admin'], isDekiAdmin: true };

const sessionCache = new Map();

function hashCookie(cookie) {
    return crypto.createHash('sha256').update(cookie).digest('hex');
}

async function verifyBassoSession(cookieHeader) {
    if (!cookieHeader) return null;

    const key = hashCookie(cookieHeader);
    const cached = sessionCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    try {
        const response = await fetch(BASSO_AUTH_URL, {
            method: 'GET',
            headers: { Cookie: cookieHeader, Accept: 'application/json' }
        });
        const data = await response.json().catch(() => ({}));
        if (!data || data.success !== true || !data.user || !data.user.username) {
            sessionCache.set(key, { user: null, expiresAt: Date.now() + CACHE_TTL_MS });
            return null;
        }
        const u = data.user;
        const email = String(u.username).toLowerCase().trim();

        // Lấy thông tin từ DB permissions (tên hiển thị + DANH SÁCH tên nhân viên để filter)
        let dbName = null, staffNames = [];
        try {
            const rows = await db.query('SELECT name, staff_name FROM deki_permissions WHERE email = ?', [email]);
            if (rows.length > 0) {
                dbName = rows[0].name || null;
                const raw = rows[0].staff_name;
                if (raw) {
                    try {
                        const parsed = JSON.parse(raw);
                        staffNames = Array.isArray(parsed) ? parsed : [String(raw)];
                    } catch { staffNames = [String(raw)]; }
                }
            }
        } catch {}

        const user = {
            email,
            name: dbName || u.full_name || u.fullName || u.display_name || u.displayName || u.name || u.username,
            staffNames,
            roles: Array.isArray(u.roles) ? u.roles : [],
            raw: u
        };
        sessionCache.set(key, { user, expiresAt: Date.now() + CACHE_TTL_MS });
        return user;
    } catch (e) {
        console.error('[auth] verifyBassoSession error:', e.message);
        return null;
    }
}

// Check permissions từ table `permissions` + super admin từ env
async function hasAccess(email) {
    if (!email) return false;
    if (email === SUPER_ADMIN_EMAIL) return true;
    try {
        const rows = await db.query('SELECT email FROM deki_permissions WHERE email = ?', [email]);
        return rows.length > 0;
    } catch (e) {
        console.error('[auth] hasAccess DB error:', e.message);
        return false;
    }
}

async function isDekiAdmin(email) {
    if (!email) return false;
    if (email === SUPER_ADMIN_EMAIL) return true;
    try {
        const rows = await db.query('SELECT is_admin FROM deki_permissions WHERE email = ?', [email]);
        return rows.length > 0 && rows[0].is_admin === 1;
    } catch {
        return false;
    }
}

function requireAuth() {
    return async (req, res, next) => {
        if (DEV_MODE) { req.user = { ...DEV_USER }; return next(); }
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
        req.user = user;
        next();
    };
}

function clearSessionCache() {
    sessionCache.clear();
}

// Auth server-to-server bằng API key (cho Zalo CRM gọi, không qua session basso).
// Set DEKI_API_KEY trong .env. Header: X-Api-Key.
function requireApiKey() {
    return (req, res, next) => {
        const expected = (process.env.DEKI_API_KEY || '').trim();
        if (!expected) {
            return res.status(503).json({ success: false, error: 'DEKI_API_KEY chưa cấu hình' });
        }
        const got = (req.headers['x-api-key'] || '').toString().trim();
        if (got !== expected) {
            return res.status(401).json({ success: false, error: 'API key không hợp lệ' });
        }
        next();
    };
}

module.exports = {
    verifyBassoSession, requireAuth, requireApiKey, hasAccess, isDekiAdmin, clearSessionCache,
    DEV_MODE, getDevUser: () => ({ ...DEV_USER })
};
