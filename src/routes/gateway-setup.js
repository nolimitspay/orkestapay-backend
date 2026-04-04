/**
 * NoLimitsPay - Gateway Setup & Advanced Routes
 * Funciona con cualquier db.js que tenga getAll/insert/update/delete
 */

const express = require('express');
const router = express.Router();
const https = require('https');

// ── SIMPLE IN-MEMORY STORE (fallback si db no tiene métodos) ─────────────────
// Esto garantiza que el servidor nunca crashea por métodos faltantes de db
let _settings = {
  aiRouting: { enabled: false },
  fraudSettings: { enabled: true, maxAttemptsPerIp: 3, maxAmountPerIp: 50000, blockDisposableEmails: true },
  dailyReport: { enabled: false, hour: 23, recipients: [] },
  routing: 'percentage',
  retryAttempts: 3,
};
let _fraudAttempts = [];
let _aiDecisions = [];

// ── STRIPE VALIDATION ─────────────────────────────────────────────────────────

router.post('/validate-stripe', async (req, res) => {
  const { secretKey } = req.body;

  if (!secretKey) return res.status(400).json({ valid: false, error: 'Secret Key requerida' });
  if (!secretKey.startsWith('sk_live_') && !secretKey.startsWith('sk_test_')) {
    return res.status(400).json({ valid: false, error: 'La clave debe empezar por sk_live_ o sk_test_' });
  }

  try {
    const result = await stripeRequest('GET', '/v1/account', null, secretKey);
    if (result.error) {
      return res.json({ valid: false, error: result.error.message || 'Clave inválida' });
    }
    res.json({
      valid: true,
      account: {
        id: result.id,
        name: result.business_profile?.name || result.display_name || 'Tu cuenta Stripe',
        email: result.email,
        country: result.country,
        currency: result.default_currency,
        chargesEnabled: result.charges_enabled,
        payoutsEnabled: result.payouts_enabled,
        isLive: secretKey.startsWith('sk_live_'),
      }
    });
  } catch (e) {
    res.status(500).json({ valid: false, error: 'Error conectando con Stripe: ' + e.message });
  }
});

// ── STRIPE WEBHOOK AUTO-CREATION ──────────────────────────────────────────────

router.post('/create-stripe-webhook', async (req, res) => {
  const { secretKey, backendUrl } = req.body;
  if (!secretKey || !backendUrl) return res.status(400).json({ success: false, error: 'Faltan parámetros' });

  const webhookUrl = `${backendUrl}/api/webhooks/stripe`;

  try {
    // Check if already exists
    const existing = await stripeRequest('GET', '/v1/webhook_endpoints?limit=20', null, secretKey);
    if (existing.data) {
      const found = existing.data.find(w => w.url === webhookUrl && !w.deleted);
      if (found) return res.json({ success: true, webhookId: found.id, alreadyExisted: true, message: 'Webhook ya configurado ✓' });
    }

    // Create new webhook
    const webhook = await stripeRequest('POST', '/v1/webhook_endpoints', {
      url: webhookUrl,
      'enabled_events[]': [
        'payment_intent.succeeded',
        'payment_intent.payment_failed',
        'customer.subscription.created',
        'customer.subscription.deleted',
        'invoice.payment_succeeded',
        'invoice.payment_failed',
        'charge.refunded',
      ],
    }, secretKey);

    if (webhook.error) throw new Error(webhook.error.message);

    res.json({
      success: true,
      webhookId: webhook.id,
      webhookSecret: webhook.secret,
      url: webhook.url,
      message: 'Webhook creado automáticamente ✓'
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── SQUARE VALIDATION ─────────────────────────────────────────────────────────

router.post('/validate-square', async (req, res) => {
  const { accessToken, environment } = req.body;
  if (!accessToken) return res.status(400).json({ valid: false, error: 'Access Token requerido' });

  const host = (environment === 'sandbox')
    ? 'connect.squareupsandbox.com'
    : 'connect.squareup.com';

  try {
    const result = await squareRequest('GET', '/v2/merchants', null, accessToken, host);
    if (result.errors) {
      return res.json({ valid: false, error: result.errors[0]?.detail || 'Token inválido' });
    }
    const merchant = result.merchant?.[0] || {};
    res.json({
      valid: true,
      merchant: {
        id: merchant.id,
        name: merchant.business_name || 'Tu negocio Square',
        country: merchant.country,
        currency: merchant.currency,
        status: merchant.status,
      }
    });
  } catch (e) {
    res.status(500).json({ valid: false, error: 'Error conectando con Square: ' + e.message });
  }
});

router.post('/square-locations', async (req, res) => {
  const { accessToken, environment } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'Access Token requerido' });

  const host = (environment === 'sandbox')
    ? 'connect.squareupsandbox.com'
    : 'connect.squareup.com';

  try {
    const result = await squareRequest('GET', '/v2/locations', null, accessToken, host);
    if (result.errors) throw new Error(result.errors[0]?.detail);
    res.json({ locations: result.locations || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STRIPE CREATE SUBSCRIPTION ────────────────────────────────────────────────
// Se llama cuando un cliente completa un pago y tiene suscripción asignada

router.post('/create-subscription', async (req, res) => {
  const { secretKey, customerEmail, customerName, paymentMethodId, priceAmount, currency, intervalDays, interval } = req.body;

  if (!secretKey || !customerEmail || !priceAmount) {
    return res.status(400).json({ error: 'Faltan parámetros: secretKey, customerEmail, priceAmount' });
  }

  try {
    // 1. Create or get Stripe customer
    const customersRes = await stripeRequest('GET', `/v1/customers?email=${encodeURIComponent(customerEmail)}&limit=1`, null, secretKey);
    let customerId;

    if (customersRes.data?.length > 0) {
      customerId = customersRes.data[0].id;
    } else {
      const newCustomer = await stripeRequest('POST', '/v1/customers', {
        email: customerEmail,
        name: customerName || customerEmail,
      }, secretKey);
      if (newCustomer.error) throw new Error(newCustomer.error.message);
      customerId = newCustomer.id;
    }

    // 2. Attach payment method if provided
    if (paymentMethodId) {
      await stripeRequest('POST', `/v1/payment_methods/${paymentMethodId}/attach`, { customer: customerId }, secretKey);
      await stripeRequest('POST', `/v1/customers/${customerId}`, { 'invoice_settings[default_payment_method]': paymentMethodId }, secretKey);
    }

    // 3. Create price
    const stripeInterval = interval === 'day' ? 'day' : interval === 'week' ? 'week' : interval === 'year' ? 'year' : 'month';
    const price = await stripeRequest('POST', '/v1/prices', {
      unit_amount: Math.round(priceAmount * 100),
      currency: (currency || 'eur').toLowerCase(),
      'recurring[interval]': stripeInterval,
      'product_data[name]': 'NoLimitsPay Subscription',
    }, secretKey);
    if (price.error) throw new Error(price.error.message);

    // 4. Create subscription with trial (delay)
    const trialDays = intervalDays || 30;
    const trialEnd = Math.floor(Date.now() / 1000) + (trialDays * 86400);

    const subBody = {
      customer: customerId,
      'items[0][price]': price.id,
      trial_end: trialEnd,
    };
    if (paymentMethodId) subBody.default_payment_method = paymentMethodId;

    const subscription = await stripeRequest('POST', '/v1/subscriptions', subBody, secretKey);
    if (subscription.error) throw new Error(subscription.error.message);

    res.json({
      success: true,
      subscriptionId: subscription.id,
      customerId,
      status: subscription.status,
      trialEnd: new Date(trialEnd * 1000).toLocaleDateString('es-ES'),
      message: `Suscripción creada. Primer cobro en ${trialDays} días.`,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── FRAUD DETECTION ───────────────────────────────────────────────────────────

router.post('/fraud-check', (req, res) => {
  const { ip, email, amount } = req.body;
  const settings = _settings.fraudSettings;

  if (!settings.enabled) return res.json({ allowed: true });

  const now = Date.now();
  const oneHour = 3600000;

  // Clean old attempts
  _fraudAttempts = _fraudAttempts.filter(a => now - a.timestamp < 86400000);

  // Check IP attempts in last hour
  const ipAttempts = _fraudAttempts.filter(a => a.ip === ip && (now - a.timestamp) < oneHour);
  if (ipAttempts.length >= (settings.maxAttemptsPerIp || 3)) {
    _fraudAttempts.push({ ip, email, amount, timestamp: now, blocked: true, reason: 'Demasiados intentos' });
    return res.json({ allowed: false, reason: 'Demasiados intentos de pago desde tu IP. Inténtalo más tarde.' });
  }

  // Check disposable emails
  if (settings.blockDisposableEmails && email) {
    const disposable = ['mailinator.com', 'tempmail.com', 'guerrillamail.com', 'yopmail.com', 'trashmail.com', 'throwam.com'];
    const domain = email.split('@')[1]?.toLowerCase();
    if (disposable.includes(domain)) {
      _fraudAttempts.push({ ip, email, amount, timestamp: now, blocked: true, reason: 'Email desechable' });
      return res.json({ allowed: false, reason: 'Por favor usa una dirección de email válida.' });
    }
  }

  _fraudAttempts.push({ ip, email, amount, timestamp: now, blocked: false });
  res.json({ allowed: true });
});

router.get('/fraud-stats', (req, res) => {
  const now = Date.now();
  const today = _fraudAttempts.filter(a => (now - a.timestamp) < 86400000);
  res.json({
    totalToday: today.length,
    blockedToday: today.filter(a => a.blocked).length,
    allowedToday: today.filter(a => !a.blocked).length,
    recentBlocked: today.filter(a => a.blocked).slice(-10).reverse(),
  });
});

// ── AI ROUTING ────────────────────────────────────────────────────────────────

router.post('/ai-routing', async (req, res) => {
  if (!_settings.aiRouting?.enabled) {
    return res.json({ applied: false, reason: 'IA de routing desactivada' });
  }

  try {
    const db = require('../db');
    const payments = db.getAll ? db.getAll('payments') : [];
    const gateways = db.getAll ? db.getAll('gateways') : [];

    if (!payments || payments.length < 10) {
      return res.json({ applied: false, reason: 'Se necesitan al menos 10 pagos para que la IA aprenda' });
    }

    const sevenDays = 7 * 86400000;
    const recent = payments.filter(p => Date.now() - new Date(p.createdAt || p.created_at).getTime() < sevenDays);

    const stats = {};
    gateways.forEach(g => {
      const gwPayments = recent.filter(p => p.gatewayId === g.id || p.gateway_id === g.id);
      const succeeded = gwPayments.filter(p => p.status === 'SUCCEEDED' || p.status === 'succeeded').length;
      const total = gwPayments.length;
      stats[g.id] = { name: g.name, total, succeeded, rate: total > 0 ? (succeeded / total * 100).toFixed(1) : 0 };
    });

    const active = gateways.filter(g => g.active && stats[g.id]?.total > 0);
    if (active.length < 2) return res.json({ applied: false, reason: 'Se necesitan al menos 2 pasarelas activas con datos' });

    const totalRate = active.reduce((s, g) => s + parseFloat(stats[g.id].rate), 0);
    const decisions = [];

    for (const g of active) {
      const newPct = totalRate > 0 ? Math.round((parseFloat(stats[g.id].rate) / totalRate) * 100) : Math.round(100 / active.length);
      const oldPct = g.trafficPct || 0;
      if (Math.abs(newPct - oldPct) >= 5) {
        if (db.update) db.update('gateways', g.id, { trafficPct: newPct });
        decisions.push({ gateway: g.name, oldPct, newPct, successRate: stats[g.id].rate, reason: `Tasa de éxito: ${stats[g.id].rate}% (${stats[g.id].succeeded}/${stats[g.id].total} pagos)` });
      }
    }

    if (decisions.length > 0) {
      _aiDecisions.unshift({ decisions, timestamp: new Date().toISOString(), stats });
      _aiDecisions = _aiDecisions.slice(0, 20);
    }

    res.json({ applied: decisions.length > 0, decisions, stats, message: decisions.length > 0 ? `IA ajustó ${decisions.length} pasarela(s)` : 'Los porcentajes ya están optimizados' });
  } catch (e) {
    res.status(500).json({ applied: false, error: e.message });
  }
});

router.get('/ai-history', (req, res) => {
  res.json(_aiDecisions);
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  res.json(_settings);
});

router.post('/settings', (req, res) => {
  const { aiRouting, fraudSettings, dailyReport, routing, retryAttempts } = req.body;
  if (aiRouting !== undefined) _settings.aiRouting = aiRouting;
  if (fraudSettings !== undefined) _settings.fraudSettings = fraudSettings;
  if (dailyReport !== undefined) _settings.dailyReport = dailyReport;
  if (routing !== undefined) _settings.routing = routing;
  if (retryAttempts !== undefined) _settings.retryAttempts = retryAttempts;
  res.json({ ok: true, settings: _settings });
});

// ── DAILY REPORT ──────────────────────────────────────────────────────────────

router.post('/send-daily-report', async (req, res) => {
  try {
    const db = require('../db');
    const payments = db.getAll ? (db.getAll('payments') || []) : [];
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const todayPayments = payments.filter(p => new Date(p.createdAt || p.created_at || 0).getTime() >= startOfDay);
    const succeeded = todayPayments.filter(p => p.status === 'SUCCEEDED' || p.status === 'succeeded');
    const failed = todayPayments.filter(p => p.status === 'FAILED' || p.status === 'failed');
    const totalRevenue = succeeded.reduce((s, p) => s + (p.amount || 0), 0);

    const byGateway = {};
    succeeded.forEach(p => {
      const gw = p.gateway || p.psp || 'Unknown';
      if (!byGateway[gw]) byGateway[gw] = { count: 0, amount: 0 };
      byGateway[gw].count++;
      byGateway[gw].amount += p.amount || 0;
    });

    res.json({
      success: true,
      reportData: {
        date: today.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        totalPayments: todayPayments.length,
        succeeded: succeeded.length,
        failed: failed.length,
        totalRevenue: (totalRevenue / 100).toFixed(2),
        conversionRate: todayPayments.length > 0 ? ((succeeded.length / todayPayments.length) * 100).toFixed(1) : '0',
        byGateway,
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HTTP HELPERS ──────────────────────────────────────────────────────────────

function stripeRequest(method, path, body, secretKey) {
  return new Promise((resolve, reject) => {
    let postData = null;
    if (body) {
      // Handle arrays (enabled_events[])
      const params = [];
      for (const [key, value] of Object.entries(body)) {
        if (Array.isArray(value)) {
          value.forEach(v => params.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`));
        } else {
          params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
        }
      }
      postData = params.join('&');
    }

    const options = {
      hostname: 'api.stripe.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
    };

    const req = https.request(options, resp => {
      let raw = '';
      resp.on('data', d => raw += d);
      resp.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Invalid JSON from Stripe: ' + raw.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function squareRequest(method, path, body, token, host) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: host,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-17',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
    };
    const req = https.request(options, resp => {
      let raw = '';
      resp.on('data', d => raw += d);
      resp.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Invalid JSON from Square: ' + raw.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

module.exports = router;
