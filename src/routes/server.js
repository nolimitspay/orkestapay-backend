require('dotenv').config();
const { router: authRouter } = require('./routes/auth');
const fs = require('fs');
const path = require('path');

// Create data directory if needed
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { logger } = require('./utils/logger');
const db = require('./db');

const app = express();

// ── CORS - Allow all origins (required for nlp.js Shopify script) ────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());

// ── Security middleware ──────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }));

// ── Raw body for Stripe webhooks (must be before json()) ──
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

app.use(express.json());

// ── Init DB ──────────────────────────────────
db.init();

// ── Routes ────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/gateways', require('./routes/gateways'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/batch', require('./routes/batch'));
app.use('/api/shops', require('./routes/shops'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/pixels', require('./routes/pixels'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/setup', require('./routes/gateway-setup'));
app.use('/api/checkout', require('./routes/checkout'));

// ── Serve nlp.js script for Shopify ──────────────────────────────────────────
app.get('/nlp.js', (req, res) => {
  const nlpPath = path.join(__dirname, '../public/nlp.js');
  if (fs.existsSync(nlpPath)) {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(nlpPath);
  } else {
    res.status(404).json({ error: 'nlp.js not found' });
  }
});

// ── Health check ─────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0.0', name: 'NoLimitsPay' }));

// ── Global error handler ──────────────────────
app.use((err, req, res, next) => {
  logger.error(err.message, { stack: err.stack });
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  logger.info(`🚀 NoLimitsPay backend running on http://localhost:${PORT}`);
});

// ── Keep alive ping every 14 min ──────────────────────────────────────────────
setInterval(() => {
  const https = require('https');
  https.get('https://orkestapay-backend.onrender.com/health', () => {}).on('error', () => {});
}, 14 * 60 * 1000);

module.exports = app;
