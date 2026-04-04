const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'orkestapay_secret';

// ── ENSURE DEFAULT ADMIN EXISTS ───────────────────────────────────────────────
function ensureAdmin() {
  const users = db.getAll('users');
  if (!users.length) {
    db.insert('users', {
      email: process.env.ADMIN_EMAIL || 'admin@nolimitspay.com',
      password: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10),
      role: 'admin',
      name: 'Admin',
    });
  }
}
ensureAdmin();

// ── MIDDLEWARE: Verify JWT ────────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(header.split(' ')[1], SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acceso restringido a administradores' });
  next();
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  const users = db.getAll('users');
  const user = users.find(u => u.email === email);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Email o contraseña incorrectos' });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role, name: user.name }
  });
});

// ── GET /api/auth/users — List all users (admin only) ────────────────────────
router.get('/users', auth, adminOnly, (req, res) => {
  const users = db.getAll('users');
  // Never return passwords
  res.json(users.map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    plan: u.plan || null,
    createdAt: u.createdAt,
  })));
});

// ── POST /api/auth/register — Create new user (admin only) ───────────────────
router.post('/register', auth, adminOnly, (req, res) => {
  const { name, email, password, plan } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nombre, email y contraseña son obligatorios' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres' });
  }

  const existing = db.getAll('users').find(u => u.email === email);
  if (existing) return res.status(409).json({ error: 'Ya existe un usuario con este email' });

  const user = db.insert('users', {
    name,
    email,
    password: bcrypt.hashSync(password, 10),
    role: 'user',
    plan: plan || null,
  });

  res.status(201).json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    plan: user.plan,
    createdAt: user.createdAt,
  });
});

// ── PUT /api/auth/users/:id/plan — Update user plan (admin only) ──────────────
router.put('/users/:id/plan', auth, adminOnly, (req, res) => {
  const { id } = req.params;
  const { plan } = req.body;

  const users = db.getAll('users');
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const updated = db.update('users', id, { plan });
  res.json({ id: updated.id, name: updated.name, email: updated.email, plan: updated.plan });
});

// ── DELETE /api/auth/users/:id — Delete user (admin only) ────────────────────
router.delete('/users/:id', auth, adminOnly, (req, res) => {
  const { id } = req.params;

  const users = db.getAll('users');
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (user.role === 'admin') return res.status(403).json({ error: 'No se puede eliminar el administrador' });

  db.delete('users', id);
  res.json({ ok: true, message: 'Usuario eliminado' });
});

// ── GET /api/auth/me — Get current user ──────────────────────────────────────
router.get('/me', auth, (req, res) => {
  const users = db.getAll('users');
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan });
});

module.exports = { router };
