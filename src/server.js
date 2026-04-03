require('dotenv').config();
const fs = require('fs');
const path = require('path');
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recurive: true });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { logger } = require('./utils/logger');
const db = require('./db');

const app = express();

// ── Security middleware ──────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }));

// ── Raw body for Stripe webhooks (must be before json()) ──
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

app.use(express.json());

// ── Init DB ──────────────────────────────────
db.init();

// ── Routes ────────────────────────────────────
app.use('/api/gateways',       require('./routes/gateways'));
app.use('/api/payments',       require('./routes/payments'));
app.use('/api/subscriptions',  require('./routes/subscriptions'));
app.use('/api/batch',          require('./routes/batch'));
app.use('/api/shops',          require('./routes/shops'));
app.use('/api/webhooks',       require('./routes/webhooks'));
app.use('/api/pixels',         require('./routes/pixels'));
app.use('/api/templates',      require('./routes/templates'));
app.use('/api/dashboard',      require('./routes/dashboard'));

// ── Health check ─────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0', name: 'OrkestaPay' }));

// ── Global error handler ──────────────────────
app.use((err, req, res, next) => {
  logger.error(err.message, { stack: err.stack });
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  logger.info(`🚀 OrkestaPay backend running on http://localhost:${PORT}`);
});

module.exports = app;
