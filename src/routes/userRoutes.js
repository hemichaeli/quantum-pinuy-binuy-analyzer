const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const crypto = require('crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'quantum_salt_2026').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// GET /api/users
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, is_active, last_login, created_at FROM users ORDER BY created_at DESC`
    );
    res.json({ success: true, users: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/users/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'email and password required' });
    const hash = hashPassword(password);
    const { rows } = await pool.query(
      `SELECT id, name, email, role, is_active FROM users WHERE email = $1 AND password_hash = $2`,
      [email.toLowerCase(), hash]
    );
    if (rows.length === 0) return res.status(401).json({ success: false, error: 'Invalid credentials' });
    const user = rows[0];
    if (!user.is_active) return res.status(403).json({ success: false, error: 'Account is disabled' });

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO user_sessions (user_id, token, expires_at, created_at) VALUES ($1, $2, $3, NOW())`,
      [user.id, token, expiresAt]
    );
    await pool.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [user.id]);

    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/users/logout
router.post('/logout', async (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) await pool.query(`DELETE FROM user_sessions WHERE token = $1`, [token]).catch(() => {});
  res.json({ success: true });
});

// POST /api/users - create user
router.post('/', async (req, res) => {
  try {
    const { name, email, password, role = 'agent' } = req.body;
    if (!name || !email || !password) return res.status(400).json({ success: false, error: 'name, email, password required' });
    const validRoles = ['admin', 'manager', 'agent', 'viewer'];
    if (!validRoles.includes(role)) return res.status(400).json({ success: false, error: `Invalid role. Valid: ${validRoles.join(', ')}` });
    const hash = hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active, created_at) VALUES ($1,$2,$3,$4,true,NOW()) RETURNING id, name, email, role, is_active, created_at`,
      [name, email.toLowerCase(), hash, role]
    );
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'Email already exists' });
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/users/:id
router.put('/:id', async (req, res) => {
  try {
    const { name, email, role, is_active } = req.body;
    const { rows } = await pool.query(
      `UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email), role = COALESCE($3, role), is_active = COALESCE($4, is_active), updated_at = NOW() WHERE id = $5 RETURNING id, name, email, role, is_active`,
      [name, email, role, is_active, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/users/:id/password
router.put('/:id/password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    const hash = hashPassword(password);
    await pool.query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [hash, req.params.id]);
    res.json({ success: true, message: 'Password updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/users/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: 'User deactivated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/users/activity
router.get('/activity', async (req, res) => {
  try {
    const { limit = 50, user_id } = req.query;
    let q = `SELECT al.*, u.name as user_name FROM activity_log al LEFT JOIN users u ON al.user_id = u.id WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (user_id) { q += ` AND al.user_id = $${pi}`; params.push(user_id); pi++; }
    q += ` ORDER BY al.created_at DESC LIMIT $${pi}`; params.push(parseInt(limit));
    const { rows } = await pool.query(q, params);
    res.json({ success: true, activity: rows });
  } catch (err) {
    res.json({ success: true, activity: [] });
  }
});

// GET /api/users/roles
router.get('/roles', (req, res) => {
  res.json({
    success: true,
    roles: [
      { id: 'admin', name: 'מנהל מערכת', permissions: ['all'] },
      { id: 'manager', name: 'מנהל', permissions: ['read', 'write', 'export', 'manage_leads'] },
      { id: 'agent', name: 'סוכן', permissions: ['read', 'write', 'manage_leads'] },
      { id: 'viewer', name: 'צופה', permissions: ['read'] }
    ]
  });
});

module.exports = router;
