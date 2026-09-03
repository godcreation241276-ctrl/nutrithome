const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not configured');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function pgSql(sql) {
  let i = 0;
  return String(sql)
    .replace(/datetime\('now',\s*\?\)/gi, "(CURRENT_TIMESTAMP + (?::interval))")
    .replace(/datetime\(expires_at\)\s*>\s*datetime\('now'\)/gi, "expires_at > CURRENT_TIMESTAMP")
    .replace(/datetime\('now','\+5 minutes'\)/gi, "(CURRENT_TIMESTAMP + INTERVAL '5 minutes')")
    .replace(/\bINSERT OR IGNORE INTO\b/gi, "INSERT INTO")
    .replace(/\?/g, () => `$${++i}`);
}

const db = {
  all(sql, params = [], callback) {
    pool.query(pgSql(sql), params)
      .then(r => callback(null, r.rows))
      .catch(callback);
  },
  get(sql, params = [], callback) {
    pool.query(pgSql(sql), params)
      .then(r => callback(null, r.rows[0]))
      .catch(callback);
  },
  run(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    params = params || [];
    let q = pgSql(sql);

    // SQLite INSERT OR IGNORE compatibility used by push_tokens.
    if (/^\s*INSERT\s+INTO\s+push_tokens/i.test(q) && !/ON CONFLICT/i.test(q)) {
      q += ' ON CONFLICT (token) DO NOTHING';
    }

    const isInsert = /^\s*INSERT\s+INTO/i.test(q);
    if (isInsert && !/\bRETURNING\b/i.test(q)) q += ' RETURNING id';

    pool.query(q, params)
      .then(r => {
        const ctx = {
          lastID: r.rows?.[0]?.id,
          changes: r.rowCount || 0
        };
        if (callback) callback.call(ctx, null);
      })
      .catch(err => {
        if (callback) callback.call({ lastID: undefined, changes: 0 }, err);
      });
  }
};

const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DELIVERY_PROVIDER = (process.env.DELIVERY_PROVIDER || 'shiprocket_quick').toLowerCase();
const DELIVERY_API_BASE = process.env.DELIVERY_API_BASE || '';
const DELIVERY_API_TOKEN = process.env.DELIVERY_API_TOKEN || '';
const DELIVERY_API_KEY = process.env.DELIVERY_API_KEY || '';
const DELIVERY_PICKUP_NAME = process.env.DELIVERY_PICKUP_NAME || 'Nutri Home';
const DELIVERY_PICKUP_PHONE = process.env.DELIVERY_PICKUP_PHONE || '';
const DELIVERY_PICKUP_ADDRESS = process.env.DELIVERY_PICKUP_ADDRESS || '';
const DELIVERY_PICKUP_LAT = process.env.DELIVERY_PICKUP_LAT || '';
const DELIVERY_PICKUP_LNG = process.env.DELIVERY_PICKUP_LNG || '';
const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY || '';
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID || ''; // legacy SendOTP flow only
const MSG91_WIDGET_ID = process.env.MSG91_WIDGET_ID || '';
const MSG91_WIDGET_TOKEN = process.env.MSG91_WIDGET_TOKEN || '';
const MSG91_WIDGET_VERIFY_URL = 'https://control.msg91.com/api/v5/widget/verifyAccessToken';
// Optional testing-only OTP. Do not configure this in production.
const CUSTOMER_LOGIN_TEST_OTP = process.env.CUSTOMER_LOGIN_TEST_OTP || '';
const CUSTOMER_SESSION_DAYS = 30;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_REQUESTS_PER_HOUR = 5;
const OTP_MAX_VERIFY_ATTEMPTS = 5;
const ALLOW_TEST_OTP = process.env.ALLOW_TEST_OTP === 'true' && process.env.NODE_ENV !== 'production';


function adminAuth(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'ADMIN_KEY is not configured on server' });
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS menu (
      id BIGSERIAL PRIMARY KEY,
      category TEXT,
      name TEXT,
      description TEXT DEFAULT '',
      price INTEGER,
      calories INTEGER DEFAULT 0,
      image TEXT,
      active TEXT DEFAULT 'yes',
      variants TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      customer_name TEXT,
      customer_phone TEXT,
      customer_address TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      items TEXT,
      total INTEGER,
      status TEXT DEFAULT 'NEW',
      delivery_provider TEXT,
      delivery_booking_id TEXT,
      delivery_status TEXT,
      delivery_tracking_url TEXT,
      delivery_error TEXT,
      track_token TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS push_tokens (
      token TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customer_sessions (
      token TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_otps (
      phone TEXT PRIMARY KEY,
      otp_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS otp_request_limits (
      phone TEXT PRIMARY KEY,
      window_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      request_count INTEGER NOT NULL DEFAULT 0,
      last_sent_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL,
      menu_id BIGINT NOT NULL,
      customer_phone TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      review TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(order_id, menu_id)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reviews_customer_phone ON reviews(customer_phone);
    CREATE INDEX IF NOT EXISTS idx_reviews_menu_id ON reviews(menu_id);
  `);

  // Safe migrations for future/partially-created PostgreSQL databases.
  await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS variants TEXT DEFAULT '[]'`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_provider TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_booking_id TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_status TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_tracking_url TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_error TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS track_token TEXT DEFAULT ''`);

  console.log('Neon PostgreSQL database connected and schema ready');
}


/* -------------------------
   IMAGE PATH RESOLVER
------------------------- */
function resolveMenuImage(imageUrl) {
  if (!imageUrl) return '';

  let value = String(imageUrl).trim();
  if (!value || ['null', 'undefined'].includes(value.toLowerCase())) return '';

  try {
    if (value.startsWith('http://') || value.startsWith('https://')) {
      value = new URL(value).pathname;
    }
  } catch (_) {}

  value = value.replace(/\\/g, '/');
  const originalFilename = path.basename(value);
  const candidates = [...new Set([
    originalFilename,
    originalFilename.toLowerCase(),
    originalFilename.replace(/\s+/g, '-'),
    originalFilename.toLowerCase().replace(/\s+/g, '-'),
    originalFilename.toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-')
  ])];

  for (const filename of candidates) {
    const fullPath = path.join(__dirname, 'public', 'images', 'menu', filename);
    if (fs.existsSync(fullPath)) return `/images/menu/${filename}`;
  }

  console.warn(`Menu image not found: ${imageUrl}`);
  return '';
}


/* -------------------------
   MENU IMAGE UPLOAD
------------------------- */
const menuImageDir = path.join(__dirname, 'public', 'images', 'menu');
fs.mkdirSync(menuImageDir, { recursive: true });

function safeImageBaseName(value) {
  return String(value || 'menu')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'menu';
}

const imageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, menuImageDir),
  filename: (_req, file, cb) => {
    const originalExt = path.extname(file.originalname || '').toLowerCase();
    const allowedExt = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = allowedExt.includes(originalExt)
      ? (originalExt === '.jpeg' ? '.jpg' : originalExt)
      : '.jpg';

    cb(null, `${safeImageBaseName(path.basename(file.originalname || 'menu', originalExt))}_${Date.now()}${ext}`);
  }
});

const uploadMenuImage = multer({
  storage: imageStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype || '')) {
      return cb(new Error('Only JPG, PNG or WEBP images are allowed'));
    }
    cb(null, true);
  }
});

app.post('/admin/menu-image', adminAuth, uploadMenuImage.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'image file required' });
  res.json({
    success: true,
    url: `/images/menu/${req.file.filename}`,
    filename: req.file.filename
  });
});

app.delete('/admin/menu-image', adminAuth, (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });

  // Remote image URLs are only detached from the item; they are not deleted remotely.
  if (/^https?:\/\//i.test(url)) {
    return res.json({ success: true, deletedFile: false, remote: true });
  }

  const filename = path.basename(url);
  const filePath = path.join(menuImageDir, filename);

  if (!filePath.startsWith(menuImageDir)) {
    return res.status(400).json({ error: 'Invalid image path' });
  }

  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true, deletedFile: !err });
  });
});

function parseVariants(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normaliseVariants(value) {
  return parseVariants(value)
    .map((v, index) => ({
      id: String(v.id || `v_${Date.now()}_${index}`),
      label: String(v.label || '').trim(),
      price: Number(v.price) || 0
    }))
    .filter(v => v.label && v.price > 0);
}

function attachParsedVariants(rows) {
  return (rows || []).map(row => ({
    ...row,
    variants: parseVariants(row.variants)
  }));
}

/* -------------------------
   MENU IMPORT
------------------------- */
function importMenuFromCSV(callback) {
  const csvPath = path.join(__dirname, 'uploads', 'menu.csv');
  if (!fs.existsSync(csvPath)) return callback(new Error('uploads/menu.csv file not found'));

  const menuRows = [];
  fs.createReadStream(csvPath)
    .pipe(csv())
    .on('data', (row) => {
      const name = String(row.catalogue_name || '').trim();
      if (!name) return;
      menuRows.push({
        category: String(row.category_name || '').trim(),
        name,
        description: String(row.description || row.item_description || '').trim(),
        price: Number.parseInt(row.current_price, 10) || 0,
        calories: 0,
        image: resolveMenuImage(row.image_url),
        active: 'yes',
        variants: []
      });
    })
    .on('error', callback)
    .on('end', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM menu');
        for (const item of menuRows) {
          await client.query(
            `INSERT INTO menu (category,name,description,price,calories,image,active,variants)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [item.category, item.name, item.description, item.price, item.calories, item.image, item.active, JSON.stringify(item.variants)]
          );
        }
        await client.query('COMMIT');
        callback(null, menuRows.length);
      } catch (e) {
        await client.query('ROLLBACK');
        callback(e);
      } finally {
        client.release();
      }
    });
}

// Protected because this route deletes and rebuilds the menu table.
app.post('/admin/import-menu', adminAuth, (req, res) => {
  importMenuFromCSV((err, count) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, status: 'Menu imported', itemsImported: count });
  });
});

/* -------------------------
   PUBLIC MENU API
------------------------- */
app.get('/menu', (req, res) => {
  db.all(
    `SELECT m.*,
            COALESCE(r.rating_avg, 0) AS rating_avg,
            COALESCE(r.rating_count, 0) AS rating_count
     FROM menu m
     LEFT JOIN (
       SELECT menu_id, ROUND(AVG(rating), 1) AS rating_avg, COUNT(*) AS rating_count
       FROM reviews
       GROUP BY menu_id
     ) r ON r.menu_id = m.id
     WHERE m.active='yes'
     ORDER BY m.category,m.id`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Unable to load menu' });
      res.json(attachParsedVariants(rows));
    }
  );
});


/* -------------------------
   CUSTOMER MOBILE LOGIN + ORDERS + REVIEWS
------------------------- */
function cleanIndianPhone(value) {
  const phone = String(value || '').replace(/\D/g, '').slice(-10);
  return /^[6-9]\d{9}$/.test(phone) ? phone : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function customerAuth(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'Login required' });

  db.get(
    `SELECT token,phone FROM customer_sessions
     WHERE token=? AND datetime(expires_at) > datetime('now')`,
    [token],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'Unable to validate session' });
      if (!row) return res.status(401).json({ error: 'Session expired. Please login again.' });
      req.customer = { phone: row.phone, token: row.token };
      next();
    }
  );
}


function maskPhone(phone) {
  const p = String(phone || '');
  return p.length === 10 ? `******${p.slice(-4)}` : 'mobile number';
}

async function checkOtpRequestLimit(phone) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT phone,window_started_at,request_count,last_sent_at
       FROM otp_request_limits WHERE phone=$1 FOR UPDATE`,
      [phone]
    );

    const now = Date.now();
    if (!current.rows[0]) {
      await client.query(
        `INSERT INTO otp_request_limits(phone,window_started_at,request_count,last_sent_at)
         VALUES($1,CURRENT_TIMESTAMP,1,CURRENT_TIMESTAMP)`,
        [phone]
      );
      await client.query('COMMIT');
      return { allowed: true, retryAfter: OTP_RESEND_SECONDS };
    }

    const row = current.rows[0];
    const windowStart = new Date(row.window_started_at).getTime();
    const lastSent = row.last_sent_at ? new Date(row.last_sent_at).getTime() : 0;

    if (now - lastSent < OTP_RESEND_SECONDS * 1000) {
      await client.query('ROLLBACK');
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((OTP_RESEND_SECONDS * 1000 - (now - lastSent)) / 1000)),
        reason: 'cooldown'
      };
    }

    if (now - windowStart >= 60 * 60 * 1000) {
      await client.query(
        `UPDATE otp_request_limits
         SET window_started_at=CURRENT_TIMESTAMP,request_count=1,last_sent_at=CURRENT_TIMESTAMP
         WHERE phone=$1`,
        [phone]
      );
      await client.query('COMMIT');
      return { allowed: true, retryAfter: OTP_RESEND_SECONDS };
    }

    if (Number(row.request_count || 0) >= OTP_MAX_REQUESTS_PER_HOUR) {
      await client.query('ROLLBACK');
      return {
        allowed: false,
        retryAfter: Math.max(60, Math.ceil((60 * 60 * 1000 - (now - windowStart)) / 1000)),
        reason: 'hourly_limit'
      };
    }

    await client.query(
      `UPDATE otp_request_limits
       SET request_count=request_count+1,last_sent_at=CURRENT_TIMESTAMP
       WHERE phone=$1`,
      [phone]
    );
    await client.query('COMMIT');
    return { allowed: true, retryAfter: OTP_RESEND_SECONDS };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function cleanupCustomerAuthData() {
  try {
    await pool.query(`DELETE FROM customer_sessions WHERE expires_at <= CURRENT_TIMESTAMP`);
    await pool.query(`DELETE FROM customer_otps WHERE expires_at <= CURRENT_TIMESTAMP`);
    await pool.query(`DELETE FROM otp_request_limits WHERE window_started_at < CURRENT_TIMESTAMP - INTERVAL '2 days'`);
  } catch (e) {
    console.warn('Customer auth cleanup failed:', e.message);
  }
}

async function sendMsg91Otp(phone) {
  const mobile = `91${phone}`;
  const url = new URL('https://control.msg91.com/api/v5/otp');
  url.searchParams.set('template_id', MSG91_TEMPLATE_ID);
  url.searchParams.set('mobile', mobile);
  url.searchParams.set('authkey', MSG91_AUTH_KEY);
  url.searchParams.set('otp_length', '6');

  const r = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text }; }
  if (!r.ok || String(data.type || '').toLowerCase() === 'error') {
    throw new Error(data.message || `OTP service failed (${r.status})`);
  }
  return data;
}

async function verifyMsg91Otp(phone, otp) {
  const url = new URL('https://control.msg91.com/api/v5/otp/verify');
  url.searchParams.set('otp', otp);
  url.searchParams.set('mobile', `91${phone}`);
  const r = await fetch(url, {
    headers: { authkey: MSG91_AUTH_KEY, Accept: 'application/json' }
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text }; }
  const msg = String(data.message || '').toLowerCase();
  const ok = r.ok && !msg.includes('invalid') && !msg.includes('expired') && String(data.type || '').toLowerCase() !== 'error';
  if (!ok) throw new Error(data.message || 'Invalid or expired OTP');
  return data;
}


function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return {};
  }
}

function findIdentifierValue(value, depth = 0) {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findIdentifierValue(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  const preferred = ['identifier', 'mobile', 'phone', 'mobile_number', 'phone_number', 'user_identifier'];
  for (const key of preferred) {
    if (value[key] != null && ['string','number'].includes(typeof value[key])) return String(value[key]);
  }
  for (const item of Object.values(value)) {
    const found = findIdentifierValue(item, depth + 1);
    if (found) return found;
  }
  return '';
}

function phoneFromVerifiedWidgetData(verificationData, accessToken) {
  // MSG91's verified access-token response for this widget returns the
  // verified mobile inside the response message string rather than as a
  // dedicated mobile/phone field.
  const fromMessage = cleanIndianPhone(verificationData?.message);
  if (fromMessage) return fromMessage;

  const direct = findIdentifierValue(verificationData);
  const claims = decodeJwtPayload(accessToken);
  const fromClaims = findIdentifierValue(claims);
  const candidate = direct || fromClaims;
  if (!candidate) return '';
  return cleanIndianPhone(candidate);
}


async function verifyMsg91WidgetAccessToken(accessToken) {
  if (!MSG91_AUTH_KEY) throw new Error('MSG91_AUTH_KEY is not configured');
  const token = String(accessToken || '').trim();
  if (!token || token.length < 20) throw new Error('Invalid MSG91 verification token');

  const r = await fetch(MSG91_WIDGET_VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ authkey: MSG91_AUTH_KEY, 'access-token': token })
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text }; }

  const jwtClaims = decodeJwtPayload(token);

  const type = String(data.type || data.status || '').toLowerCase();
  const message = String(data.message || data.error || '').toLowerCase();
  if (!r.ok || type === 'error' || type === 'failed' || message.includes('invalid') || message.includes('expired') || message.includes('unauthor')) {
    throw new Error(data.message || data.error || 'MSG91 verification failed');
  }
  return data;
}

app.get('/customer/otp-widget-config', (_req, res) => {
  if (!MSG91_WIDGET_ID || !MSG91_WIDGET_TOKEN) {
    return res.status(503).json({ error: 'MSG91 OTP Widget is not configured on server' });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ widgetId: MSG91_WIDGET_ID, tokenAuth: MSG91_WIDGET_TOKEN });
});

app.post('/customer/widget-login', async (req, res) => {
  const phone = cleanIndianPhone(req.body?.phone);
  const accessToken = String(req.body?.accessToken || '').trim();
  const requestId = String(req.body?.requestId || '').trim();
  if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number' });
  if (!accessToken) return res.status(400).json({ error: 'MSG91 verification token is required' });

  try {
    const verification = await verifyMsg91WidgetAccessToken(accessToken);
    const tokenClaims = decodeJwtPayload(accessToken);
    const tokenRequestId = String(tokenClaims?.requestId || tokenClaims?.reqId || '').trim();
    const verifiedPhone = phoneFromVerifiedWidgetData(verification, accessToken);
    if (!verifiedPhone) {
      return res.status(401).json({ error: 'Could not confirm the verified mobile number from MSG91 token' });
    }
    if (verifiedPhone !== phone) {
      return res.status(401).json({ error: 'Verified mobile number does not match login number' });
    }

    createCustomerSession(phone, (err, token) => {
      if (err) return res.status(500).json({ error: 'Could not create login session' });
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, token, customer: { phone } });
    });
  } catch (e) {
    res.status(401).json({ error: e.message || 'OTP verification failed' });
  }
});

function createCustomerSession(phone, callback) {
  const token = crypto.randomBytes(32).toString('hex');
  db.run(
    `INSERT INTO customer_sessions(token,phone,expires_at)
     VALUES(?,?,datetime('now', ?))`,
    [token, phone, `+${CUSTOMER_SESSION_DAYS} days`],
    (err) => callback(err, token)
  );
}

app.post('/customer/request-otp', async (req, res) => {
  const phone = cleanIndianPhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number' });

  try {
    const limit = await checkOtpRequestLimit(phone);
    if (!limit.allowed) {
      return res.status(429).json({
        error: limit.reason === 'hourly_limit'
          ? 'Too many OTP requests. Please try again later.'
          : `Please wait ${limit.retryAfter} seconds before requesting another OTP.`,
        retryAfter: limit.retryAfter
      });
    }
    if (ALLOW_TEST_OTP && CUSTOMER_LOGIN_TEST_OTP) {
      db.run(
        `INSERT INTO customer_otps(phone,otp_hash,expires_at,attempts)
         VALUES(?,?,datetime('now','+5 minutes'),0)
         ON CONFLICT(phone) DO UPDATE SET
           otp_hash=excluded.otp_hash,
           expires_at=excluded.expires_at,
           attempts=0`,
        [phone, sha256(CUSTOMER_LOGIN_TEST_OTP)],
        (err) => {
          if (err) return res.status(500).json({ error: 'Could not create OTP' });
          res.json({ success: true, testMode: true, message: 'Test OTP is configured on the server.' });
        }
      );
      return;
    }

    if (!MSG91_AUTH_KEY || !MSG91_TEMPLATE_ID) {
      return res.status(503).json({
        error: 'Mobile OTP service is not configured yet. Configure MSG91_AUTH_KEY and MSG91_TEMPLATE_ID.'
      });
    }

    await sendMsg91Otp(phone);
    res.json({ success: true, message: `OTP sent to ${maskPhone(phone)}`, retryAfter: OTP_RESEND_SECONDS });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Unable to send OTP' });
  }
});

app.post('/customer/verify-otp', async (req, res) => {
  const phone = cleanIndianPhone(req.body?.phone);
  const otp = String(req.body?.otp || '').replace(/\D/g, '').slice(0, 8);
  if (!phone || otp.length < 4) return res.status(400).json({ error: 'Phone and OTP are required' });

  const finish = () => {
    createCustomerSession(phone, (err, token) => {
      if (err) return res.status(500).json({ error: 'Could not create login session' });
      res.json({ success: true, token, customer: { phone }, sessionDays: CUSTOMER_SESSION_DAYS });
    });
  };

  if (ALLOW_TEST_OTP && CUSTOMER_LOGIN_TEST_OTP) {
    db.get(
      `SELECT * FROM customer_otps
       WHERE phone=? AND datetime(expires_at) > datetime('now')`,
      [phone],
      (err, row) => {
        if (err) return res.status(500).json({ error: 'Could not verify OTP' });
        if (!row || row.attempts >= 5 || row.otp_hash !== sha256(otp)) {
          if (row) db.run(`UPDATE customer_otps SET attempts=attempts+1 WHERE phone=?`, [phone]);
          return res.status(401).json({ error: 'Invalid or expired OTP' });
        }
        db.run(`DELETE FROM customer_otps WHERE phone=?`, [phone], () => finish());
      }
    );
    return;
  }

  if (!MSG91_AUTH_KEY || !MSG91_TEMPLATE_ID) {
    return res.status(503).json({ error: 'Mobile OTP service is not configured yet.' });
  }

  try {
    await verifyMsg91Otp(phone, otp);
    finish();
  } catch (e) {
    res.status(401).json({ error: e.message || 'Invalid or expired OTP' });
  }
});

app.get('/customer/me', customerAuth, (req, res) => {
  res.json({ phone: req.customer.phone });
});

app.post('/customer/logout', customerAuth, (req, res) => {
  db.run(`DELETE FROM customer_sessions WHERE token=?`, [req.customer.token], () => {
    res.json({ success: true });
  });
});


app.get('/customer/active-orders', customerAuth, (req, res) => {
  db.all(
    `SELECT id,customer_phone,items,total,status,created_at
     FROM orders
     WHERE customer_phone=?
       AND status NOT IN ('DELIVERED','CANCELLED')
     ORDER BY id DESC
     LIMIT 20`,
    [req.customer.phone],
    (err, orders) => {
      if (err) return res.status(500).json({ error: 'Unable to load active orders' });
      res.json((orders || []).map(o => ({
        ...o,
        items: parseVariants(o.items)
      })));
    }
  );
});

app.get('/customer/order/:id', customerAuth, (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: 'Invalid order id' });
  }

  db.get(
    `SELECT id,customer_phone,items,total,status,created_at
     FROM orders
     WHERE id=? AND customer_phone=?`,
    [orderId, req.customer.phone],
    (err, order) => {
      if (err) return res.status(500).json({ error: 'Unable to load order' });
      if (!order) return res.status(404).json({ error: 'Order not found' });
      res.json({
        ...order,
        items: parseVariants(order.items)
      });
    }
  );
});

app.get('/customer/orders', customerAuth, (req, res) => {
  db.all(
    `SELECT * FROM orders WHERE customer_phone=? ORDER BY id DESC LIMIT 100`,
    [req.customer.phone],
    (err, orders) => {
      if (err) return res.status(500).json({ error: 'Unable to load order history' });

      db.all(
        `SELECT * FROM reviews WHERE customer_phone=? ORDER BY id DESC`,
        [req.customer.phone],
        (reviewErr, reviews) => {
          if (reviewErr) return res.status(500).json({ error: 'Unable to load reviews' });
          const byOrder = new Map();
          for (const r of reviews || []) {
            if (!byOrder.has(Number(r.order_id))) byOrder.set(Number(r.order_id), []);
            byOrder.get(Number(r.order_id)).push(r);
          }

          res.json((orders || []).map(o => ({
            ...o,
            items: parseVariants(o.items),
            reviews: byOrder.get(Number(o.id)) || []
          })));
        }
      );
    }
  );
});

app.post('/customer/reviews', customerAuth, (req, res) => {
  const orderId = Number(req.body?.order_id);
  const menuId = Number(req.body?.menu_id);
  const rating = Number(req.body?.rating);
  const review = String(req.body?.review || '').trim().slice(0, 700);

  if (!Number.isInteger(orderId) || !Number.isInteger(menuId) || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Valid order, item and 1-5 star rating are required' });
  }

  db.get(
    `SELECT * FROM orders WHERE id=? AND customer_phone=?`,
    [orderId, req.customer.phone],
    (err, order) => {
      if (err) return res.status(500).json({ error: 'Unable to validate order' });
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.status !== 'DELIVERED') return res.status(400).json({ error: 'Rating is available only after delivery' });

      const items = parseVariants(order.items);
      if (!items.some(x => Number(x.id) === menuId)) {
        return res.status(400).json({ error: 'This item was not part of the delivered order' });
      }

      db.run(
        `INSERT INTO reviews(order_id,menu_id,customer_phone,rating,review)
         VALUES(?,?,?,?,?)
         ON CONFLICT(order_id,menu_id) DO UPDATE SET
           rating=excluded.rating,
           review=excluded.review,
           created_at=CURRENT_TIMESTAMP`,
        [orderId, menuId, req.customer.phone, rating, review],
        function (saveErr) {
          if (saveErr) return res.status(500).json({ error: 'Could not save rating' });
          res.json({ success: true });
        }
      );
    }
  );
});

/* -------------------------
   PUSH NOTIFICATION
------------------------- */
async function notifyBusiness(order) {
  db.all(`SELECT token FROM push_tokens`, [], async (err, rows) => {
    if (err || !rows || rows.length === 0) return;

    const messages = rows.map((r) => ({
      to: r.token,
      sound: 'default',
      title: '🔔 New Nutri Home Order',
      body: `Order #${order.id} • ₹${order.total}`,
      data: { orderId: order.id }
    }));

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages)
      });
      if (!response.ok) console.error('Expo push failed:', response.status, await response.text());
    } catch (e) {
      console.error('Expo push error:', e.message);
    }
  });
}

/* -------------------------
   SAVE ORDER
------------------------- */
app.post('/order', (req, res) => {
  const { customer_name, customer_phone, customer_address, latitude, longitude, items } = req.body;

  const cleanName = String(customer_name || '').trim().slice(0, 80);
  const cleanPhone = String(customer_phone || '').replace(/\D/g, '').slice(-10);
  const cleanAddress = String(customer_address || '').trim().slice(0, 350);

  if (!cleanName || !/^[6-9]\d{9}$/.test(cleanPhone) || !cleanAddress || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'Required order information is missing or invalid' });
  }
  if (items.length > 50) return res.status(400).json({ success: false, error: 'Too many cart lines' });

  const ids = [...new Set(items.map(x => Number(x.id)).filter(Number.isInteger))];
  if (!ids.length) return res.status(400).json({ success: false, error: 'Invalid cart items' });
  const placeholders = ids.map(() => '?').join(',');

  db.all(`SELECT * FROM menu WHERE active='yes' AND id IN (${placeholders})`, ids, (menuErr, rows) => {
    if (menuErr) return res.status(500).json({ success: false, error: 'Unable to validate menu' });
    const byId = new Map((rows || []).map(r => [Number(r.id), { ...r, variants: parseVariants(r.variants) }]));
    const finalItems = [];
    let finalTotal = 0;

    for (const requestItem of items) {
      const item = byId.get(Number(requestItem.id));
      const qty = Math.min(20, Math.max(1, Number.parseInt(requestItem.qty, 10) || 0));
      if (!item || qty <= 0) return res.status(400).json({ success: false, error: 'One or more menu items are unavailable' });

      let variant = null;
      let unitPrice = Number(item.price) || 0;
      if (Array.isArray(item.variants) && item.variants.length) {
        variant = item.variants.find(v => String(v.id) === String(requestItem.variant_id || ''));
        if (!variant && requestItem.variant) variant = item.variants.find(v => String(v.label) === String(requestItem.variant));
        if (!variant) return res.status(400).json({ success: false, error: `Please select a valid size for ${item.name}` });
        unitPrice = Number(variant.price) || 0;
      }
      if (unitPrice <= 0) return res.status(400).json({ success: false, error: `Invalid price for ${item.name}` });
      const lineTotal = unitPrice * qty;
      finalTotal += lineTotal;
      finalItems.push({ id: item.id, name: item.name, variant: variant?.label || null, variant_id: variant?.id || null, price: unitPrice, qty, line_total: lineTotal });
    }

    const trackToken = crypto.randomBytes(24).toString('hex');

    db.run(
      `INSERT INTO orders
       (customer_name,customer_phone,customer_address,latitude,longitude,items,total,status,track_token)
       VALUES (?,?,?,?,?,?,?,'NEW',?)`,
      [cleanName, cleanPhone, cleanAddress, latitude == null ? null : Number(latitude), longitude == null ? null : Number(longitude), JSON.stringify(finalItems), finalTotal, trackToken],
      function (err) {
        if (err) return res.status(500).json({ success: false, error: 'Order could not be saved' });
        const order = { id: this.lastID, customer_name: cleanName, customer_phone: cleanPhone, customer_address: cleanAddress, latitude: latitude == null ? null : Number(latitude), longitude: longitude == null ? null : Number(longitude), items: finalItems, total: finalTotal, status: 'NEW' };
        notifyBusiness(order);
        res.json({ success: true, orderId: this.lastID, total: finalTotal, status: 'NEW', trackingToken: trackToken });
      }
    );
  });
});


/* -------------------------
   CUSTOMER ORDER TRACKING (NO LOGIN REQUIRED)
------------------------- */
app.get('/order-track', (req, res) => {
  const orderId = Number(req.query.order_id);
  const token = String(req.query.token || '').trim();

  if (!Number.isInteger(orderId) || orderId <= 0 || token.length < 20) {
    return res.status(400).json({ error: 'Invalid tracking link' });
  }

  db.get(
    `SELECT id,items,total,status,created_at
     FROM orders
     WHERE id=? AND track_token=?`,
    [orderId, token],
    (err, order) => {
      if (err) return res.status(500).json({ error: 'Unable to load tracking status' });
      if (!order) return res.status(404).json({ error: 'Order tracking not found' });

      res.json({
        id: order.id,
        items: parseVariants(order.items),
        total: Number(order.total || 0),
        status: order.status,
        created_at: order.created_at
      });
    }
  );
});

/* -------------------------
   DELIVERY ADAPTER
------------------------- */
function requireDeliveryConfig() {
  const missing = [];
  if (!DELIVERY_API_BASE) missing.push('DELIVERY_API_BASE');
  if (!DELIVERY_API_TOKEN && !DELIVERY_API_KEY) missing.push('DELIVERY_API_TOKEN or DELIVERY_API_KEY');
  if (!DELIVERY_PICKUP_PHONE) missing.push('DELIVERY_PICKUP_PHONE');
  if (!DELIVERY_PICKUP_ADDRESS) missing.push('DELIVERY_PICKUP_ADDRESS');
  return missing;
}

function buildDeliveryHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (DELIVERY_API_TOKEN) headers.Authorization = `Bearer ${DELIVERY_API_TOKEN}`;
  if (DELIVERY_API_KEY) headers['x-api-key'] = DELIVERY_API_KEY;
  return headers;
}

function normalizeDeliveryResponse(j) {
  return {
    bookingId: String(j.booking_id || j.order_id || j.shipment_id || j.id || ''),
    status: String(j.status || j.delivery_status || 'BOOKED'),
    trackingUrl: j.tracking_url || j.track_url || j.tracking_link || '',
    raw: j
  };
}

async function bookDelivery(order) {
  const missing = requireDeliveryConfig();
  if (missing.length) {
    const e = new Error(`Delivery integration not configured: ${missing.join(', ')}`);
    e.code = 'DELIVERY_NOT_CONFIGURED';
    throw e;
  }

  const payload = {
    reference_id: String(order.id),
    order_id: String(order.id),
    amount: Number(order.total || 0),
    payment_mode: 'PREPAID',
    package: { description: 'Prepared food order', weight_kg: 1 },
    pickup: {
      name: DELIVERY_PICKUP_NAME,
      phone: DELIVERY_PICKUP_PHONE,
      address: DELIVERY_PICKUP_ADDRESS,
      latitude: DELIVERY_PICKUP_LAT ? Number(DELIVERY_PICKUP_LAT) : undefined,
      longitude: DELIVERY_PICKUP_LNG ? Number(DELIVERY_PICKUP_LNG) : undefined
    },
    drop: {
      name: order.customer_name,
      phone: order.customer_phone,
      address: order.customer_address,
      latitude: order.latitude == null ? undefined : Number(order.latitude),
      longitude: order.longitude == null ? undefined : Number(order.longitude)
    }
  };

  const r = await fetch(DELIVERY_API_BASE, {
    method: 'POST',
    headers: buildDeliveryHeaders(),
    body: JSON.stringify(payload)
  });

  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch (_) { j = { message: text }; }

  if (!r.ok) {
    const e = new Error(j.message || j.error || `Delivery booking failed (${r.status})`);
    e.providerResponse = j;
    throw e;
  }
  return normalizeDeliveryResponse(j);
}

async function bookDeliveryForOrderId(orderId) {
  const order = await new Promise((resolve, reject) => {
    db.get(`SELECT * FROM orders WHERE id=?`, [orderId], (err, row) => err ? reject(err) : resolve(row));
  });

  if (!order) throw new Error('Order not found');
  if (!order.customer_address) throw new Error('Customer address missing');

  if (order.delivery_booking_id) {
    return {
      alreadyBooked: true,
      bookingId: order.delivery_booking_id,
      status: order.delivery_status || 'BOOKED',
      trackingUrl: order.delivery_tracking_url || ''
    };
  }

  try {
    const d = await bookDelivery(order);
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE orders
         SET delivery_provider=?,delivery_booking_id=?,delivery_status=?,delivery_tracking_url=?,delivery_error=NULL
         WHERE id=?`,
        [DELIVERY_PROVIDER, d.bookingId, d.status, d.trackingUrl, orderId],
        (err) => err ? reject(err) : resolve()
      );
    });
    return d;
  } catch (e) {
    await new Promise((resolve) => {
      db.run(
        `UPDATE orders SET delivery_provider=?,delivery_status='BOOKING_FAILED',delivery_error=? WHERE id=?`,
        [DELIVERY_PROVIDER, String(e.message || e), orderId],
        () => resolve()
      );
    });
    throw e;
  }
}

/* -------------------------
   ADMIN PUSH TOKEN
------------------------- */
app.post('/admin/register-push-token', adminAuth, (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  db.run(`INSERT INTO push_tokens(token) VALUES(?) ON CONFLICT (token) DO NOTHING`, [token], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

/* -------------------------
   ADMIN ORDERS
------------------------- */
app.get('/admin/orders', adminAuth, (req, res) => {
  db.all(`SELECT * FROM orders ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/admin/order-status', adminAuth, (req, res) => {
  const { orderId, status } = req.body;
  const allowed = ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'];
  if (!orderId || !allowed.includes(status)) return res.status(400).json({ error: 'Invalid orderId/status' });

  db.run(`UPDATE orders SET status=? WHERE id=?`, [status, orderId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, updated: this.changes });
  });
});

app.post('/admin/ready-and-book-rider', adminAuth, async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  try {
    await new Promise((resolve, reject) => {
      db.run(`UPDATE orders SET status='READY' WHERE id=?`, [orderId], (err) => err ? reject(err) : resolve());
    });
    const delivery = await bookDeliveryForOrderId(orderId);
    res.json({ success: true, orderStatus: 'READY', delivery });
  } catch (e) {
    res.status(e.code === 'DELIVERY_NOT_CONFIGURED' ? 503 : 500).json({
      success: false,
      orderStatus: 'READY',
      error: e.message
    });
  }
});

app.post('/admin/book-rider', adminAuth, async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  try {
    const delivery = await bookDeliveryForOrderId(orderId);
    res.json({ success: true, delivery });
  } catch (e) {
    res.status(e.code === 'DELIVERY_NOT_CONFIGURED' ? 503 : 500).json({ success: false, error: e.message });
  }
});

/* -------------------------
   ADMIN MENU CRUD
------------------------- */
app.get('/admin/menu', adminAuth, (req, res) => {
  db.all(`SELECT * FROM menu ORDER BY category,name`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(attachParsedVariants(rows));
  });
});

app.post('/admin/menu', adminAuth, (req, res) => {
  const { category, name, description = '', price, image = '', active = 'yes', variants = [] } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

  const normalizedImage = resolveMenuImage(image) || String(image || '').trim();
  const normalizedVariants = normaliseVariants(variants);

  db.run(
    `INSERT INTO menu(category,name,description,price,calories,image,active,variants)
     VALUES(?,?,?,?,0,?,?,?)`,
    [
      String(category || '').trim(),
      String(name).trim(),
      String(description || '').trim().slice(0, 600),
      Number(price) || 0,
      normalizedImage,
      active === 'no' ? 'no' : 'yes',
      JSON.stringify(normalizedVariants)
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID, variants: normalizedVariants });
    }
  );
});

app.put('/admin/menu/:id', adminAuth, (req, res) => {
  const { category, name, description = '', price, image = '', active = 'yes', variants = [] } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

  const normalizedImage = resolveMenuImage(image) || String(image || '').trim();
  const normalizedVariants = normaliseVariants(variants);

  db.run(
    `UPDATE menu SET category=?,name=?,description=?,price=?,image=?,active=?,variants=? WHERE id=?`,
    [
      String(category || '').trim(),
      String(name).trim(),
      String(description || '').trim().slice(0, 600),
      Number(price) || 0,
      normalizedImage,
      active === 'no' ? 'no' : 'yes',
      JSON.stringify(normalizedVariants),
      req.params.id
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, updated: this.changes, variants: normalizedVariants });
    }
  );
});

app.delete('/admin/menu/:id', adminAuth, (req, res) => {
  db.get(`SELECT image FROM menu WHERE id=?`, [req.params.id], (getErr, row) => {
    if (getErr) return res.status(500).json({ error: getErr.message });

    db.run(`DELETE FROM menu WHERE id=?`, [req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });

      // If this was a locally uploaded image and no other item uses it, remove it.
      const image = String(row?.image || '');
      if (image.startsWith('/images/menu/')) {
        db.get(`SELECT COUNT(*) AS count FROM menu WHERE image=?`, [image], (_countErr, countRow) => {
          if (Number(countRow?.count || 0) === 0) {
            fs.unlink(path.join(menuImageDir, path.basename(image)), () => {});
          }
        });
      }

      res.json({ success: true, deleted: this.changes });
    });
  });
});

/* -------------------------
   ADMIN SUMMARY (IST)
------------------------- */
app.get('/admin/summary', adminAuth, (req, res) => {
  db.all(
    `SELECT * FROM orders
     WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'DB error' });

      const summary = {
        totalOrders: rows.length,
        totalRevenue: 0,
        pending: 0,
        accepted: 0,
        preparing: 0,
        ready: 0,
        delivered: 0,
        cancelled: 0
      };

      for (const o of rows) {
        summary.totalRevenue += Number(o.total) || 0;
        if (o.status === 'NEW') summary.pending++;
        if (o.status === 'ACCEPTED') summary.accepted++;
        if (o.status === 'PREPARING') summary.preparing++;
        if (o.status === 'READY') summary.ready++;
        if (o.status === 'DELIVERED') summary.delivered++;
        if (o.status === 'CANCELLED') summary.cancelled++;
      }

      res.json(summary);
    }
  );
});

/* -------------------------
   CUSTOMER PWA + GEO HELPERS
------------------------- */
app.get(['/order', '/order/'], (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'order', 'index.html'));
});

app.get('/reverse-geocode', async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Valid lat/lng required' });
  }
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'NutriHomeFoods/1.0 (nutrihomefoods.com)', 'Accept-Language': 'en-IN,en;q=0.9' } });
    if (!r.ok) throw new Error(`Reverse geocode failed (${r.status})`);
    const data = await r.json();
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ address: data.display_name || '', source: 'OpenStreetMap Nominatim' });
  } catch (e) {
    res.status(502).json({ error: 'Address lookup unavailable' });
  }
});

/* -------------------------
   HEALTH + STATIC + START
------------------------- */
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'Nutri Home', timestamp: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/manifest\.webmanifest$|sw\.js$|index\.html$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    else if (/\.(css|js|png|jpg|jpeg|webp|svg)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}));

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await pool.query('SELECT 1');
    await initDatabase();
    await cleanupCustomerAuthData();
    app.listen(PORT, () => console.log(`Nutri Home server running on port ${PORT} with Neon PostgreSQL`));
  } catch (err) {
    console.error('Fatal PostgreSQL startup error:', err);
    process.exit(1);
  }
}

startServer();
