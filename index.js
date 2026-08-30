const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const app = express();

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database('./database.db', (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
  } else {
    console.log('SQLite database connected');
  }
});

/* =========================================================
   TABLES
========================================================= */

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
      items TEXT,
      total INTEGER,
      status TEXT DEFAULT 'NEW',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

});


/* =========================================================
   IMAGE PATH HELPER
   Fixes:
   Tawa-paratha.jpg -> tawa-paratha.jpg
   Laccha-paratha.jpg -> laccha-paratha.jpg
   Spaces / uppercase / old absolute URLs
========================================================= */

function resolveMenuImage(imageUrl) {

  if (!imageUrl) {
    return '';
  }

  let value = String(imageUrl).trim();

  if (
    value === '' ||
    value.toLowerCase() === 'null' ||
    value.toLowerCase() === 'undefined'
  ) {
    return '';
  }

  /*
    If CSV contains complete URL:
    https://nutrihomefoods.com/images/menu/Tawa-paratha.jpg

    convert it first to:
    /images/menu/Tawa-paratha.jpg
  */

  try {
    if (value.startsWith('http://') || value.startsWith('https://')) {
      const parsed = new URL(value);
      value = parsed.pathname;
    }
  } catch (err) {
    console.log('Could not parse image URL:', value);
  }

  value = value.replace(/\\/g, '/');

  const originalFilename = path.basename(value);

  /*
    Candidate filenames.
    We check actual filesystem instead of blindly changing filename.
  */

  const candidates = [
    originalFilename,

    originalFilename.toLowerCase(),

    originalFilename
      .toLowerCase()
      .replace(/\s+/g, '-'),

    originalFilename
      .replace(/\s+/g, '-'),

    originalFilename
      .toLowerCase()
      .replace(/_/g, '-')
      .replace(/\s+/g, '-')
  ];

  const uniqueCandidates = [...new Set(candidates)];

  for (const filename of uniqueCandidates) {

    const fullPath = path.join(
      __dirname,
      'public',
      'images',
      'menu',
      filename
    );

    if (fs.existsSync(fullPath)) {

      const finalUrl = `/images/menu/${filename}`;

      console.log(
        `Image matched: ${imageUrl} -> ${finalUrl}`
      );

      return finalUrl;
    }
  }

  /*
    No matching file found.
    Empty value causes frontend placeholder image to load.
  */

  console.warn(
    `Image file NOT found for: ${imageUrl}`
  );

  return '';
}


/* =========================================================
   MENU IMPORT FUNCTION
========================================================= */

function importMenuFromCSV(callback) {

  const csvPath = path.join(
    __dirname,
    'uploads',
    'menu.csv'
  );

  if (!fs.existsSync(csvPath)) {

    const err = new Error(
      'uploads/menu.csv file not found'
    );

    console.error(err.message);

    if (callback) callback(err);

    return;
  }


  const menuRows = [];

  /*
    First read complete CSV.
    We DO NOT delete current menu until CSV has been read successfully.
  */

  fs.createReadStream(csvPath)

    .pipe(csv())

    .on('data', (row) => {

      const category =
        String(row.category_name || '').trim();

      const name =
        String(row.catalogue_name || '').trim();

      const price =
        parseInt(row.current_price, 10) || 0;

      const image =
        resolveMenuImage(row.image_url);


      if (!name) {
        console.warn(
          'Skipping menu row because catalogue_name is empty'
        );

        return;
      }


      menuRows.push({
        category,
        name,
        price,
        calories: 0,
        image,
        active: 'yes'
      });

    })

    .on('error', (err) => {

      console.error(
        'CSV reading error:',
        err
      );

      if (callback) callback(err);

    })

    .on('end', () => {

      console.log(
        `CSV successfully read. ${menuRows.length} menu items found.`
      );


      /*
        Use transaction.
        Either complete menu imports,
        or DB rolls back.
      */

      db.serialize(() => {

        db.run('BEGIN TRANSACTION');


        db.run(
          'DELETE FROM menu',
          (deleteErr) => {

            if (deleteErr) {

              console.error(
                'Menu delete error:',
                deleteErr
              );

              db.run('ROLLBACK');

              if (callback) callback(deleteErr);

              return;
            }


            const stmt = db.prepare(`
              INSERT INTO menu
              (
                category,
                name,
                price,
                calories,
                image,
                active
              )
              VALUES (?, ?, ?, ?, ?, ?)
            `);


            let insertError = null;


            menuRows.forEach((item) => {

              stmt.run(
                [
                  item.category,
                  item.name,
                  item.price,
                  item.calories,
                  item.image,
                  item.active
                ],
                (err) => {

                  if (err) {

                    insertError = err;

                    console.error(
                      'Menu insert error:',
                      item.name,
                      err.message
                    );
                  }
                }
              );

            });


            stmt.finalize((finalizeErr) => {

              if (finalizeErr || insertError) {

                const error =
                  finalizeErr || insertError;

                db.run('ROLLBACK');

                console.error(
                  'Menu import rolled back:',
                  error
                );

                if (callback) callback(error);

                return;
              }


              db.run(
                'COMMIT',
                (commitErr) => {

                  if (commitErr) {

                    console.error(
                      'Commit error:',
                      commitErr
                    );

                    if (callback) {
                      callback(commitErr);
                    }

                    return;
                  }


                  console.log(
                    `Menu imported successfully: ${menuRows.length} items`
                  );


                  if (callback) {
                    callback(
                      null,
                      menuRows.length
                    );
                  }

                }
              );

            });

          }
        );

      });

    });

}


/* =========================================================
   MANUAL MENU IMPORT API

   IMPORTANT:
   This intentionally DOES NOT run automatically on restart.

   Use manually only when menu.csv has been verified.
========================================================= */

app.get('/import-menu', (req, res) => {

  importMenuFromCSV((err, count) => {

    if (err) {

      return res.status(500).json({
        success: false,
        status: 'Menu import failed',
        error: err.message
      });

    }


    res.json({
      success: true,
      status: 'Menu imported',
      itemsImported: count
    });

  });

});


/* =========================================================
   MENU API
========================================================= */

app.get('/menu', (req, res) => {

  db.all(
    `
    SELECT *
    FROM menu
    WHERE active = 'yes'
    ORDER BY category, id
    `,
    [],
    (err, rows) => {

      if (err) {

        console.error(
          'Menu API DB error:',
          err
        );

        return res.status(500).json({
          error: 'Unable to load menu'
        });

      }

      res.json(rows);

    }
  );

});


/* =========================================================
   SAVE ORDER
========================================================= */

app.post('/order', (req, res) => {

  const {
    customer_name,
    customer_phone,
    customer_address,
    items,
    total
  } = req.body;


  if (
    !customer_name ||
    !customer_phone ||
    !customer_address ||
    !Array.isArray(items) ||
    items.length === 0
  ) {

    return res.status(400).json({
      success: false,
      error: 'Required order information is missing'
    });

  }


  const finalTotal =
    parseInt(total, 10) || 0;


  db.run(
    `
    INSERT INTO orders
    (
      customer_name,
      customer_phone,
      customer_address,
      items,
      total,
      status
    )
    VALUES (?, ?, ?, ?, ?, 'NEW')
    `,
    [
      customer_name.trim(),
      customer_phone.trim(),
      customer_address.trim(),
      JSON.stringify(items),
      finalTotal
    ],
    function (err) {

      if (err) {

        console.error(
          'Order save error:',
          err
        );

        return res.status(500).json({
          success: false,
          error: 'Order could not be saved'
        });

      }


      res.json({
        success: true,
        orderId: this.lastID
      });

    }
  );

});


/* =========================================================
   ADMIN: GET ORDERS
========================================================= */

app.get('/admin/orders', (req, res) => {

  db.all(
    `
    SELECT *
    FROM orders
    ORDER BY id DESC
    `,
    [],
    (err, rows) => {

      if (err) {

        console.error(
          'Admin orders DB error:',
          err
        );

        return res.status(500).json({
          error: 'Unable to load orders'
        });

      }


      res.json(rows);

    }
  );

});


/* =========================================================
   ADMIN: UPDATE ORDER STATUS
========================================================= */

app.post('/admin/order-status', (req, res) => {

  const {
    orderId,
    status
  } = req.body;


  const allowedStatuses = [
    'NEW',
    'ACCEPTED',
    'PREPARING',
    'READY',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'CANCELLED'
  ];


  if (
    !orderId ||
    !allowedStatuses.includes(status)
  ) {

    return res.status(400).json({
      success: false,
      error: 'Invalid order status'
    });

  }


  db.run(
    `
    UPDATE orders
    SET status = ?
    WHERE id = ?
    `,
    [
      status,
      orderId
    ],
    function (err) {

      if (err) {

        console.error(
          'Order status update error:',
          err
        );

        return res.status(500).json({
          success: false,
          error: 'Unable to update order'
        });

      }


      res.json({
        success: true,
        updated: this.changes
      });

    }
  );

});


/* =========================================================
   ADMIN DASHBOARD SUMMARY
========================================================= */

app.get('/admin/summary', (req, res) => {

  db.all(
    `
    SELECT *
    FROM orders
    WHERE date(created_at, 'localtime')
          =
          date('now', 'localtime')
    `,
    [],
    (err, rows) => {

      if (err) {

        console.error(
          'Summary DB error:',
          err
        );

        return res.status(500).json({
          error: 'DB error'
        });

      }


      let totalRevenue = 0;
      let totalOrders = rows.length;
      let pending = 0;
      let accepted = 0;


      rows.forEach((order) => {

        totalRevenue +=
          Number(order.total) || 0;


        if (order.status === 'NEW') {
          pending++;
        }


        if (order.status === 'ACCEPTED') {
          accepted++;
        }

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


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get('/health', (req, res) => {

  res.json({
    status: 'OK',
    service: 'Nutri Home',
    timestamp: new Date().toISOString()
  });

});


/* =========================================================
   STATIC WEBSITE
========================================================= */

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);


/* =========================================================
   START SERVER
========================================================= */

const PORT =
  process.env.PORT || 3000;


app.listen(PORT, () => {

  console.log(
    `Nutri Home server running on port ${PORT}`
  );

});
