// ============================================
// PRIZE STORE SERVICE
// ============================================
// Deploy as its own Railway service.
// Link your PostgreSQL addon to it —
// the DATABASE_URL variable will be set
// automatically via ${{ Postgres.DATABASE_URL }}
// ============================================

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// ============================================
// DATABASE CONNECTION
// ============================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool error:', err.message);
});

// ============================================
// AUTO-CREATE TABLE ON STARTUP
// ============================================
// This runs once when the service starts.
// IF NOT EXISTS means it's safe to run every
// single time — it does nothing if the table
// already exists.
// ============================================

async function initDatabase() {
  const createTable = `
    CREATE TABLE IF NOT EXISTS prizes (
      prize_id        TEXT        PRIMARY KEY,
      gift_name       TEXT        NOT NULL,
      user_id         BIGINT      NOT NULL,
      username        TEXT,
      status          TEXT        NOT NULL DEFAULT 'pending',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      error_message   TEXT
    );
  `;

  const createIndexUser = `
    CREATE INDEX IF NOT EXISTS idx_prizes_user_id ON prizes (user_id);
  `;

  const createIndexStatus = `
    CREATE INDEX IF NOT EXISTS idx_prizes_status ON prizes (status);
  `;

  await pool.query(createTable);
  await pool.query(createIndexUser);
  await pool.query(createIndexStatus);

  console.log('✅ Database table ready');
}

// ============================================
// HEALTH CHECK
// ============================================

app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as db_time');
    res.json({
      status: 'online',
      service: 'prize-store',
      db_time: result.rows[0].db_time
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// ============================================
// POST /prizes
// ============================================
// Called by: webapp, right after a gift is won.
// Body: { prize_id, gift_name, user_id, username }
// ============================================

app.post('/prizes', async (req, res) => {
  const { prize_id, gift_name, user_id, username } = req.body;

  if (!prize_id || !gift_name || !user_id) {
    return res.status(400).json({
      error: 'Missing required fields: prize_id, gift_name, user_id'
    });
  }

  try {
    await pool.query(
      `INSERT INTO prizes (prize_id, gift_name, user_id, username, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (prize_id) DO NOTHING`,
      [prize_id, gift_name, user_id, username || null]
    );

    console.log(`✅ Prize stored: ${prize_id} | ${gift_name} | user ${user_id}`);
    res.status(201).json({ success: true, prize_id });

  } catch (err) {
    console.error('❌ POST /prizes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /prizes/:prize_id
// ============================================
// Called by: gift transactor, to verify a prize
//           exists before sending the gift.
// ============================================

app.get('/prizes/:prize_id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM prizes WHERE prize_id = $1',
      [req.params.prize_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prize not found' });
    }

    res.json(result.rows[0]);

  } catch (err) {
    console.error('❌ GET /prizes/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /prizes?user_id=123
// ============================================
// Called by: webapp, to load a user's inventory.
// ============================================

app.get('/prizes', async (req, res) => {
  const { user_id, status } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id query param is required' });
  }

  try {
    let query = 'SELECT * FROM prizes WHERE user_id = $1';
    const params = [user_id];

    if (status) {
      query += ' AND status = $2';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);

  } catch (err) {
    console.error('❌ GET /prizes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// PATCH /prizes/:prize_id
// ============================================
// Called by: gift transactor, to update status.
// Body: { status, error_message (optional) }
// ============================================

app.patch('/prizes/:prize_id', async (req, res) => {
  const { status, error_message } = req.body;
  const { prize_id } = req.params;

  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  const allowed = ['pending', 'claiming', 'claimed', 'failed'];
  if (!allowed.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${allowed.join(', ')}`
    });
  }

  try {
    const result = await pool.query(
      `UPDATE prizes
       SET status = $1,
           error_message = $2,
           updated_at = NOW()
       WHERE prize_id = $3
       RETURNING *`,
      [status, error_message || null, prize_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prize not found' });
    }

    console.log(`📊 Prize ${prize_id} status → ${status}`);
    res.json(result.rows[0]);

  } catch (err) {
    console.error('❌ PATCH /prizes/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// DELETE /prizes/:prize_id
// ============================================
// Called by: gift transactor, ONLY after the
//           prize status is "claimed".
// ============================================

app.delete('/prizes/:prize_id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM prizes WHERE prize_id = $1 AND status = $2 RETURNING *',
      [req.params.prize_id, 'claimed']
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Prize not found or not in "claimed" status'
      });
    }

    console.log(`🗑️  Prize deleted: ${req.params.prize_id}`);
    res.json({ success: true, deleted: result.rows[0] });

  } catch (err) {
    console.error('❌ DELETE /prizes/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// STARTUP
// ============================================

const PORT = process.env.PORT || 3002;

async function start() {
  try {
    await initDatabase();
    console.log('✅ PostgreSQL connected and ready');
  } catch (err) {
    console.error('❌ Cannot connect to PostgreSQL:', err.message);
    console.error('   Make sure DATABASE_URL is set.');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('🗄️  PRIZE STORE SERVICE');
    console.log('═══════════════════════════════════════════');
    console.log(`🌐 Running on port ${PORT}`);
    console.log('');
    console.log('📡 Endpoints:');
    console.log('   POST   /prizes          → store a new prize');
    console.log('   GET    /prizes?user_id= → get user prizes');
    console.log('   GET    /prizes/:id      → get one prize');
    console.log('   PATCH  /prizes/:id      → update status');
    console.log('   DELETE /prizes/:id      → remove claimed prize');
    console.log('═══════════════════════════════════════════');
  });
}

start();
