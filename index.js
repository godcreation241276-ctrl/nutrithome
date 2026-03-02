const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fs = require('fs');
const csv = require('csv-parser');

const app = express();
app.use(cors());
app.use(express.json());

const db = new sqlite3.Database('./database.db');

/* -------------------------
   TABLES
------------------------- */
db.serialize(() => {

  db.run(`
    CREATE TABLE IF NOT EXISTS menu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      name TEXT,
      price INTEGER,
      calories INTEGER,
      image TEXT,
      active TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT,
      customer_phone TEXT,
      customer_address TEXT,
      items TEXT,
      total INTEGER,
      status TEXT DEFAULT 'NEW',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

/* -------------------------
   MENU IMPORT
------------------------- */
app.get('/import-menu', (req, res) => {
  db.run('DELETE FROM menu', () => {
    fs.createReadStream('./uploads/menu.csv')
      .pipe(csv())
      .on('data', row => {
        db.run(
          `INSERT INTO menu (category,name,price,calories,image,active)
           VALUES (?,?,?,?,?,?)`,
          [
            row.category_name,
            row.catalogue_name,
            row.current_price,
            0,
            row.image_url || '',
            'yes'
          ]
        );
      })
      .on('end', () => {
        res.json({ status: 'Menu imported' });
      });
  });
});

/* -------------------------
   MENU API
------------------------- */
app.get('/menu', (req, res) => {
  db.all(
    `SELECT * FROM menu WHERE active='yes' ORDER BY category`,
    [],
    (err, rows) => res.json(rows)
  );
});

/* -------------------------
   SAVE ORDER
------------------------- */
app.post('/order', (req, res) => {

  const { customer_name, customer_phone, customer_address, items, total } = req.body;

  db.run(
    `INSERT INTO orders 
     (customer_name, customer_phone, customer_address, items, total, status)
     VALUES (?,?,?,?,?,'NEW')`,
    [
      customer_name,
      customer_phone,
      customer_address,
      JSON.stringify(items),
      total
    ],
    function () {
      res.json({ orderId: this.lastID });
    }
  );
});

/* -------------------------
   ADMIN: GET ORDERS
------------------------- */
app.get('/admin/orders', (req, res) => {
  db.all(
    `SELECT * FROM orders ORDER BY id DESC`,
    [],
    (err, rows) => res.json(rows)
  );
});

/* -------------------------
   ADMIN: UPDATE STATUS
------------------------- */
app.post('/admin/order-status', (req, res) => {
  const { orderId, status } = req.body;

  db.run(
    `UPDATE orders SET status=? WHERE id=?`,
    [status, orderId],
    () => res.json({ success: true })
  );
});

/* -------------------------
   ADMIN DASHBOARD SUMMARY
   (FIXED DATE FILTER VERSION)
------------------------- */
app.get('/admin/summary', (req, res) => {

  db.all(
    `
    SELECT * FROM orders 
    WHERE date(created_at) = date('now','localtime')
    `,
    [],
    (err, rows) => {

      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'DB error' });
      }

      let totalRevenue = 0;
      let totalOrders = rows.length;
      let pending = 0;
      let accepted = 0;

      rows.forEach(o => {
        totalRevenue += o.total;

        if (o.status === 'NEW') pending++;
        if (o.status === 'ACCEPTED') accepted++;
      });

      res.json({
        totalOrders,
        totalRevenue,
        pending,
        accepted
      });
    }
  );
});

/* -------------------------
   STATIC + START
------------------------- */
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});