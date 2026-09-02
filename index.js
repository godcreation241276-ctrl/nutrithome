const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error('Database connection error:', err.message);
  else console.log('SQLite database connected');
});

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
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID || '';
// Optional testing-only OTP. Do not configure this in production.
const CUSTOMER_LOGIN_TEST_OTP = process.env.CUSTOMER_LOGIN_TEST_OTP || '';
const CUSTOMER_SESSION_DAYS = 30;


function adminAuth(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'ADMIN_KEY is not configured on server' });
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function addColumnIfMissing(table, definition) {
  db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error(`Migration failed for ${table}.${definition}:`, err.message);
    }
  });
}

/* -------------------------
   TABLES + SAFE MIGRATIONS
------------------------- */
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS menu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      name TEXT,
      description TEXT DEFAULT '',
      price INTEGER,
      calories INTEGER DEFAULT 0,
      image TEXT,
      active TEXT DEFAULT 'yes',
      variants TEXT DEFAULT '[]'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT,
      customer_phone TEXT,
      customer_address TEXT,
      latitude REAL,
      longitude REAL,
      items TEXT,
      total INTEGER,
      status TEXT DEFAULT 'NEW',
      delivery_provider TEXT,
      delivery_booking_id TEXT,
      delivery_status TEXT,
      delivery_tracking_url TEXT,
      delivery_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      token TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS customer_sessions (
      token TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS customer_otps (
      phone TEXT PRIMARY KEY,
      otp_hash TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      attempts INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      menu_id INTEGER NOT NULL,
      customer_phone TEXT NOT NULL,
      rating INTEGER NOT NULL,
      review TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(order_id, menu_id)
    )
  `);

  // Existing installations may not have these columns yet.
  addColumnIfMissing('orders', 'latitude REAL');
  addColumnIfMissing('orders', 'longitude REAL');
  addColumnIfMissing('orders', 'delivery_provider TEXT');
  addColumnIfMissing('orders', 'delivery_booking_id TEXT');
  addColumnIfMissing('orders', 'delivery_status TEXT');
  addColumnIfMissing('orders', 'delivery_tracking_url TEXT');
  addColumnIfMissing('orders', 'delivery_error TEXT');
  addColumnIfMissing('menu', "variants TEXT DEFAULT '[]'");
  addColumnIfMissing('menu', "description TEXT DEFAULT ''");
  addColumnIfMissing('orders', "track_token TEXT DEFAULT ''");
});

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
    .on('end', () => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run('DELETE FROM menu', (deleteErr) => {
          if (deleteErr) {
            db.run('ROLLBACK');
            return callback(deleteErr);
          }

          const stmt = db.prepare(`
            INSERT INTO menu (category,name,description,price,calories,image,active,variants)
            VALUES (?,?,?,?,?,?,?,?)
          `);
          let insertError = null;
          for (const item of menuRows) {
            stmt.run([item.category, item.name, item.description, item.price, item.calories, item.image, item.active, JSON.stringify(item.variants)], (err) => {
              if (err && !insertError) insertError = err;
            });
          }
          stmt.finalize((finalizeErr) => {
            const err = finalizeErr || insertError;
            if (err) {
              db.run('ROLLBACK');
              return callback(err);
            }
            db.run('COMMIT', (commitErr) => callback(commitErr, menuRows.length));
          });
        });
      });
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
    if (CUSTOMER_LOGIN_TEST_OTP) {
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
    res.json({ success: true, message: 'OTP sent' });
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
      res.json({ success: true, token, customer: { phone } });
    });
  };

  if (CUSTOMER_LOGIN_TEST_OTP) {
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
  db.run(`INSERT OR IGNORE INTO push_tokens(token) VALUES(?)`, [token], (err) => {
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
     WHERE date(created_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`,
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
app.listen(PORT, () => console.log(`Nutri Home server running on port ${PORT}`));
