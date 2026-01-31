// ============================================
// PRIZE STORE SERVICE
// ============================================
// A small Express API that owns the PostgreSQL
// connection. Both your webapp (via the bot
// server) and your gift transactor talk to
// this single service to read/write prizes.
//
// Deploy this as its OWN Railway service.
// Set its DATABASE_URL env var to the
// connection string from your Railway
// PostgreSQL addon.
// ============================================

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// ============================================
// DATABASE CONNECTION
// ============================================
// Railway gives you DATABASE_URL automatically
// when you link the PostgreSQL addon to this
// service. It looks like:
//   postgres://user:pass@host:port/dbname

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Log connection status on startup
pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool error:', err.message);
});

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
// Called by: your bot server, right after a
//           spin wheel win (gift type only).
//
// Body: { prize_id, gift_name, user_id, username }
//
// Creates a new prize row with status = pending
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
// Called by: your gift transactor, to verify
//           a prize exists and belongs to the
//           right user before sending the gift.
//
// Returns the full prize row.
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
// Called by: webapp, to show a user's inventory.
//
// Returns all prizes for that user.
// ============================================

app.get('/prizes', async (req, res) => {
  const { user_id, status } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id query param is required' });
  }

  try {
    let query = 'SELECT * FROM prizes WHERE user_id = $1';
    const params = [user_id];

    // Optional: filter by status (pending, claiming, claimed, failed)
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
// Called by: your gift transactor, to update
//           the status after it attempts to
//           send the gift.
//
// Body: { status, error_message (optional) }
//
// Valid status transitions:
//   pending  → claiming   (transactor picked it up)
//   claiming → claimed    (transactor confirms success)
//   claiming → failed     (transactor reports failure)
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
// Called by: your gift transactor, ONLY after
//           status is "claimed". Cleans up the
//           row so it doesn't grow forever.
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
  // Test the connection
  try {
    const result = await pool.query('SELECT 1');
    console.log('✅ PostgreSQL connected');
  } catch (err) {
    console.error('❌ Cannot connect to PostgreSQL:', err.message);
    console.error('   Make sure DATABASE_URL is set and the addon is linked.');
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
