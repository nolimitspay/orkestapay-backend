/**
 * NoLimitsPay - Advanced Gateway Setup Routes
 * Handles real-time validation, auto webhook creation, fraud detection, AI routing
 */

const express = require('express');
const router = express.Router();
const https = require('https');
const db = require('../db');
const { logger } = require('../utils/logger');

// ── STRIPE VALIDATION & AUTO-SETUP ──────────────────────────────────────────

/**
 * Validate a Stripe Secret Key in real time
 * POST /api/setup/validate-stripe
 */
router.post('/validate-stripe', async (req, res) => {
  const { secretKey } = req.body;
  if (!secretKey || !secretKey.startsWith('sk_')) {
    return res.status(400).json({ valid: false, error: 'La clave debe empezar por sk_live_ o sk_test_' });
  }

  try {
    // Call Stripe API to validate the key
    const stripeRes = await stripeRequest('GET', '/v1/account', null, secretKey);
    if (stripeRes.error) {
      return res.json({ valid: false, error: 'Clave inválida: ' + stripeRes.error.message });
    }
    res.json({
      valid: true,
      account: {
        id: stripeRes.id,
        name: stripeRes.business_profile?.name || stripeRes.display_name || 'Tu cuenta Stripe',
        email: stripeRes.email,
        country: stripeRes.country,
        currency: stripeRes.default_currency,
        chargesEnabled: stripeRes.charges_enabled,
        payoutsEnabled: stripeRes.payouts_enabled,
      }
    });
  } catch (e) {
    res.status(500).json({ valid: false, error: 'Error conectando con Stripe: ' + e.message });
  }
});

/**
 * Create webhook automatically in Stripe account
 * POST /api/setup/create-stripe-webhook
 */
router.post('/create-stripe-webhook', async (req, res) => {
  const { secretKey, backendUrl } = req.body;
  if (!secretKey || !backendUrl) return res.status(400).json({ error: 'Faltan parámetros' });

  const webhookUrl = `${backendUrl}/api/webhooks/stripe`;

  try {
    // Check if webhook already exists
    const existing = await stripeRequest('GET', '/v1/webhook_endpoints?limit=10', null, secretKey);
    const alreadyExists = existing.data?.find(w => w.url === webhookUrl && !w.deleted);
    if (alreadyExists) {
      return res.json({ success: true, webhookId: alreadyExists.id, alreadyExisted: true, message: 'Webhook ya configurado' });
    }

    // Create webhook
    const webhook = await stripeRequest('POST', '/v1/webhook_endpoints', {
      url: webhookUrl,
      enabled_events: [
        'payment_intent.succeeded',
        'payment_intent.payment_failed',
        'payment_intent.created',
        'customer.subscription.created',
        'customer.subscription.deleted',
        'invoice.payment_succeeded',
        'invoice.payment_failed',
        'charge.refunded',
      ],
      description: 'NoLimitsPay auto-configured webhook',
    }, secretKey);

    if (webhook.error) throw new Error(webhook.error.message);

    res.json({
      success: true,
      webhookId: webhook.id,
      webhookSecret: webhook.secret, // whsec_...
      url: webhook.url,
      message: 'Webhook creado automáticamente ✓'
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * Get Stripe account publishable key
 * POST /api/setup/get-stripe-pk
 */
router.post('/get-stripe-pk', async (req, res) => {
  const { secretKey } = req.body;
  try {
    const keys = await stripeRequest('GET', '/v1/account/capabilities', null, secretKey);
    // Derive publishable key prefix from secret key
    const isLive = secretKey.startsWith('sk_live_');
    const prefix = isLive ? 'pk_live_' : 'pk_test_';
    res.json({ prefix, isLive, message: `Usa tu Publishable Key que empieza por ${prefix}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SQUARE VALIDATION ────────────────────────────────────────────────────────

/**
 * Validate Square Access Token
 * POST /api/setup/validate-square
 */
router.post('/validate-square', async (req, res) => {
  const { accessToken, environment } = req.body;
  if (!accessToken) return res.status(400).json({ valid: false, error: 'Token requerido' });

  const host = environment === 'sandbox' ? 'connect.squareupsandbox.com' : 'connect.squareup.com';

  try {
    const result = await squareRequest('GET', '/v2/merchants', null, accessToken, host);
    if (result.errors) {
      return res.json({ valid: false, error: result.errors[0]?.detail || 'Token inválido' });
    }
    const merchant = result.merchant?.[0];
    res.json({
      valid: true,
      merchant: {
        id: merchant?.id,
        name: merchant?.business_name || 'Tu negocio Square',
        country: merchant?.country,
        currency: merchant?.currency,
      }
    });
  } catch (e) {
    res.status(500).json({ valid: false, error: e.message });
  }
});

/**
 * Get Square Locations
 * POST /api/setup/square-locations
 */
router.post('/square-locations', async (req, res) => {
  const { accessToken, environment } = req.body;
  const host = environment === 'sandbox' ? 'connect.squareupsandbox.com' : 'connect.squareup.com';

  try {
    const result = await squareRequest('GET', '/v2/locations', null, accessToken, host);
    if (result.errors) throw new Error(result.errors[0]?.detail);
    res.json({ locations: result.locations || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FRAUD DETECTION ──────────────────────────────────────────────────────────

/**
 * Check if a payment attempt is suspicious
 * POST /api/setup/fraud-check
 */
router.post('/fraud-check', (req, res) => {
  const { ip, email, amount, cardLast4 } = req.body;
  const settings = db.getSetting('fraudSettings') || { enabled: true, maxAttemptsPerIp: 3, maxAmountPerIp: 50000, blockDisposableEmails: true };

  if (!settings.enabled) return res.json({ allowed: true, reason: 'Detector de fraude desactivado' });

  const attempts = db.getAll('fraudAttempts') || [];
  const now = Date.now();
  const oneHour = 3600000;
  const oneDay = 86400000;

  // Check IP attempts in last hour
  const ipAttempts = attempts.filter(a => a.ip === ip && (now - a.timestamp) < oneHour);
  if (ipAttempts.length >= (settings.maxAttemptsPerIp || 3)) {
    logFraud({ ip, email, reason: 'Demasiados intentos desde esta IP', amount });
    return res.json({ allowed: false, reason: 'Demasiados intentos de pago desde tu IP. Inténtalo más tarde.' });
  }

  // Check amount per IP in last day
  const ipAmount = attempts.filter(a => a.ip === ip && (now - a.timestamp) < oneDay).reduce((s, a) => s + (a.amount || 0), 0);
  if (ipAmount + amount > (settings.maxAmountPerIp || 50000)) {
    logFraud({ ip, email, reason: 'Límite de importe diario por IP superado', amount });
    return res.json({ allowed: false, reason: 'Límite de transacciones diarias superado para esta IP.' });
  }

  // Check disposable email domains
  if (settings.blockDisposableEmails) {
    const disposable = ['mailinator.com', 'tempmail.com', 'guerrillamail.com', 'throwam.com', 'sharklasers.com', 'yopmail.com', 'trashmail.com'];
    const domain = email?.split('@')[1]?.toLowerCase();
    if (disposable.includes(domain)) {
      logFraud({ ip, email, reason: 'Email desechable detectado', amount });
      return res.json({ allowed: false, reason: 'Por favor usa una dirección de email válida.' });
    }
  }

  // Check duplicate card in last 24h
  if (cardLast4) {
    const cardAttempts = attempts.filter(a => a.cardLast4 === cardLast4 && a.email !== email && (now - a.timestamp) < oneDay);
    if (cardAttempts.length > 0) {
      logFraud({ ip, email, reason: 'Tarjeta usada con múltiples emails', amount });
      return res.json({ allowed: false, reason: 'Esta tarjeta ha sido marcada como sospechosa.' });
    }
  }

  // Log this attempt
  db.insert('fraudAttempts', { ip, email, amount, cardLast4, timestamp: now, allowed: true });

  res.json({ allowed: true });
});

function logFraud(data) {
  db.insert('fraudAttempts', { ...data, timestamp: Date.now(), allowed: false, blocked: true });
  logger.warn('Fraud attempt blocked', data);
}

/**
 * Get fraud stats
 * GET /api/setup/fraud-stats
 */
router.get('/fraud-stats', (req, res) => {
  const attempts = db.getAll('fraudAttempts') || [];
  const now = Date.now();
  const oneDay = 86400000;
  const today = attempts.filter(a => (now - a.timestamp) < oneDay);
  res.json({
    totalToday: today.length,
    blockedToday: today.filter(a => a.blocked).length,
    allowedToday: today.filter(a => !a.blocked).length,
    recentBlocked: attempts.filter(a => a.blocked).slice(-10).reverse(),
  });
});

// ── AI ROUTING ───────────────────────────────────────────────────────────────

/**
 * AI Routing decision engine
 * Analyzes payment history to suggest optimal gateway percentages
 * POST /api/setup/ai-routing
 */
router.post('/ai-routing', (req, res) => {
  const settings = db.getSetting('aiRouting') || { enabled: false };
  if (!settings.enabled) return res.json({ applied: false, reason: 'IA de routing desactivada' });

  const payments = db.getAll('payments') || [];
  const gateways = db.getAll('gateways') || [];

  if (payments.length < 10) return res.json({ applied: false, reason: 'Se necesitan al menos 10 pagos para que la IA aprenda' });

  // Analyze success rate per gateway in last 7 days
  const sevenDays = 7 * 86400000;
  const recent = payments.filter(p => Date.now() - new Date(p.createdAt).getTime() < sevenDays);

  const stats = {};
  gateways.forEach(g => {
    const gwPayments = recent.filter(p => p.gatewayId === g.id);
    const succeeded = gwPayments.filter(p => p.status === 'SUCCEEDED').length;
    const total = gwPayments.length;
    stats[g.id] = {
      name: g.name,
      total,
      succeeded,
      rate: total > 0 ? (succeeded / total * 100).toFixed(1) : 0,
      currentPct: g.trafficPct || 0,
    };
  });

  // Calculate new percentages based on success rates
  const active = gateways.filter(g => g.active && stats[g.id]?.total > 0);
  if (active.length < 2) return res.json({ applied: false, reason: 'Se necesitan al menos 2 pasarelas activas con datos' });

  const totalRate = active.reduce((s, g) => s + parseFloat(stats[g.id].rate), 0);
  const decisions = [];

  active.forEach(g => {
    const newPct = totalRate > 0 ? Math.round((parseFloat(stats[g.id].rate) / totalRate) * 100) : Math.round(100 / active.length);
    const oldPct = g.trafficPct || 0;
    if (Math.abs(newPct - oldPct) >= 5) {
      db.update('gateways', g.id, { trafficPct: newPct });
      decisions.push({
        gateway: g.name,
        oldPct,
        newPct,
        successRate: stats[g.id].rate,
        reason: `Tasa de éxito: ${stats[g.id].rate}% (${stats[g.id].succeeded}/${stats[g.id].total} pagos)`,
      });
    }
  });

  // Save decision to history
  if (decisions.length > 0) {
    db.insert('aiDecisions', { decisions, timestamp: new Date().toISOString(), stats });
    logger.info('AI Routing applied', { decisions });
  }

  res.json({ applied: decisions.length > 0, decisions, stats, message: decisions.length > 0 ? `IA ajustó ${decisions.length} pasarela(s)` : 'Los porcentajes están optimizados' });
});

/**
 * Get AI routing history
 * GET /api/setup/ai-history
 */
router.get('/ai-history', (req, res) => {
  const history = db.getAll('aiDecisions') || [];
  res.json(history.slice(-20).reverse());
});

// ── SETTINGS ─────────────────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  res.json({
    aiRouting: db.getSetting('aiRouting') || { enabled: false },
    fraudSettings: db.getSetting('fraudSettings') || { enabled: true, maxAttemptsPerIp: 3, maxAmountPerIp: 50000, blockDisposableEmails: true },
    dailyReport: db.getSetting('dailyReport') || { enabled: false, hour: 23, recipients: [] },
    routing: db.getSetting('routing') || 'percentage',
    retryAttempts: db.getSetting('retryAttempts') || 3,
  });
});

router.post('/settings', (req, res) => {
  const { aiRouting, fraudSettings, dailyReport, routing, retryAttempts } = req.body;
  if (aiRouting !== undefined) db.setSetting('aiRouting', aiRouting);
  if (fraudSettings !== undefined) db.setSetting('fraudSettings', fraudSettings);
  if (dailyReport !== undefined) db.setSetting('dailyReport', dailyReport);
  if (routing !== undefined) db.setSetting('routing', routing);
  if (retryAttempts !== undefined) db.setSetting('retryAttempts', retryAttempts);
  res.json({ ok: true });
});

// ── DAILY PDF REPORT ─────────────────────────────────────────────────────────

router.post('/send-daily-report', async (req, res) => {
  try {
    const payments = db.getAll('payments') || [];
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

    const todayPayments = payments.filter(p => new Date(p.createdAt).getTime() >= startOfDay);
    const succeeded = todayPayments.filter(p => p.status === 'SUCCEEDED');
    const failed = todayPayments.filter(p => p.status === 'FAILED');
    const totalRevenue = succeeded.reduce((s, p) => s + (p.amount || 0), 0);

    // Group by gateway
    const byGateway = {};
    succeeded.forEach(p => {
      if (!byGateway[p.gateway]) byGateway[p.gateway] = { count: 0, amount: 0 };
      byGateway[p.gateway].count++;
      byGateway[p.gateway].amount += p.amount || 0;
    });

    const reportData = {
      date: today.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      totalPayments: todayPayments.length,
      succeeded: succeeded.length,
      failed: failed.length,
      totalRevenue: (totalRevenue / 100).toFixed(2),
      conversionRate: todayPayments.length > 0 ? ((succeeded.length / todayPayments.length) * 100).toFixed(1) : '0',
      byGateway,
    };

    res.json({ success: true, reportData, message: 'Informe generado correctamente' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HELPERS ───────────────────────────────────────────────────────────────────

function stripeRequest(method, path, body, secretKey) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(flattenObject(body)).toString() : null;
    const options = {
      hostname: 'api.stripe.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, resp => {
      let raw = '';
      resp.on('data', d => raw += d);
      resp.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function squareRequest(method, path, body, token, host) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: host,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-17',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, resp => {
      let raw = '';
      resp.on('data', d => raw += d);
      resp.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function flattenObject(obj, prefix = '') {
  return Object.keys(obj).reduce((acc, key) => {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (typeof obj[key] === 'object' && !Array.isArray(obj[key]) && obj[key] !== null) {
      Object.assign(acc, flattenObject(obj[key], fullKey));
    } else if (Array.isArray(obj[key])) {
      obj[key].forEach((v, i) => { acc[`${fullKey}[]`] = v; });
    } else {
      acc[fullKey] = obj[key];
    }
    return acc;
  }, {});
}

module.exports = router;
