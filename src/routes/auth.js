const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const router = express.Router();

const SECRET = process.env.JWT_SECRET || 'orkestapay_secret';

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

router.post('/login', (req, res) => {
  const { email, password } = req.body;
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
  res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
});

module.exports = { router };