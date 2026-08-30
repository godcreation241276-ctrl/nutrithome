const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

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
      price INTEGER,
      calories INTEGER DEFAULT 0,
      image TEXT,
      active TEXT DEFAULT 'yes'
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

  // Existing installations may not have these columns yet.
  addColumnIfMissing('orders', 'latitude REAL');
  addColumnIfMissing('orders', 'longitude REAL');
  addColumnIfMissing('orders', 'delivery_provider TEXT');
  addColumnIfMissing('orders', 'delivery_booking_id TEXT');
  addColumnIfMissing('orders', 'delivery_status TEXT');
  addColumnIfMissing('orders', 'delivery_tracking_url TEXT');
  addColumnIfMissing('orders', 'delivery_error TEXT');
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
        price: Number.parseInt(row.current_price, 10) || 0,
        calories: 0,
        image: resolveMenuImage(row.image_url),
        active: 'yes'
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
            INSERT INTO menu (category,name,price,calories,image,active)
            VALUES (?,?,?,?,?,?)
          `);
          let insertError = null;
          for (const item of menuRows) {
            stmt.run([item.category, item.name, item.price, item.calories, item.image, item.active], (err) => {
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
  db.all(`SELECT * FROM menu WHERE active='yes' ORDER BY category,id`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Unable to load menu' });
    res.json(rows);
  });
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
  const {
    customer_name,
    customer_phone,
    customer_address,
    latitude,
    longitude,
    items,
    total
  } = req.body;

  if (!customer_name || !customer_phone || !customer_address || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'Required order information is missing' });
  }

  const finalTotal = Number.parseInt(total, 10) || 0;
  if (finalTotal <= 0) return res.status(400).json({ success: false, error: 'Invalid order total' });

  db.run(
    `INSERT INTO orders
     (customer_name,customer_phone,customer_address,latitude,longitude,items,total,status)
     VALUES (?,?,?,?,?,?,?,'NEW')`,
    [
      String(customer_name).trim(),
      String(customer_phone).trim(),
      String(customer_address).trim(),
      latitude == null ? null : Number(latitude),
      longitude == null ? null : Number(longitude),
      JSON.stringify(items),
      finalTotal
    ],
    function (err) {
      if (err) return res.status(500).json({ success: false, error: 'Order could not be saved' });

      const order = {
        id: this.lastID,
        customer_name: String(customer_name).trim(),
        customer_phone: String(customer_phone).trim(),
        customer_address: String(customer_address).trim(),
        latitude: latitude == null ? null : Number(latitude),
        longitude: longitude == null ? null : Number(longitude),
        items,
        total: finalTotal,
        status: 'NEW'
      };

      notifyBusiness(order);
      res.json({ success: true, orderId: this.lastID, status: 'NEW' });
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
    res.json(rows);
  });
});

app.post('/admin/menu', adminAuth, (req, res) => {
  const { category, name, price, image = '', active = 'yes' } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

  const normalizedImage = resolveMenuImage(image) || String(image || '').trim();
  db.run(
    `INSERT INTO menu(category,name,price,calories,image,active) VALUES(?,?,?,0,?,?)`,
    [String(category || '').trim(), String(name).trim(), Number(price) || 0, normalizedImage, active === 'no' ? 'no' : 'yes'],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.put('/admin/menu/:id', adminAuth, (req, res) => {
  const { category, name, price, image = '', active = 'yes' } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

  const normalizedImage = resolveMenuImage(image) || String(image || '').trim();
  db.run(
    `UPDATE menu SET category=?,name=?,price=?,image=?,active=? WHERE id=?`,
    [String(category || '').trim(), String(name).trim(), Number(price) || 0, normalizedImage, active === 'no' ? 'no' : 'yes', req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, updated: this.changes });
    }
  );
});

app.delete('/admin/menu/:id', adminAuth, (req, res) => {
  db.run(`DELETE FROM menu WHERE id=?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
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
   HEALTH + STATIC + START
------------------------- */
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'Nutri Home', timestamp: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nutri Home server running on port ${PORT}`));
