/**
 * NoLimitsPay - Gateway Setup & Advanced Routes v2.0
 * All routes needed for the platform to work
 */

const express = require('express');
const router = express.Router();
const https = require('https');
const crypto = require('crypto');

// ── IN-MEMORY STORE (no db dependency issues) ────────────────────────────────
let _settings = {
  aiRouting: { enabled: false },
  fraudSettings: { enabled: true, maxAttemptsPerIp: 3, maxAmountPerIp: 50000, blockDisposableEmails: true },
  dailyReport: { enabled: false, hour: 23, recipients: [] },
  autoSubscription: { enabled: false, price: '', delayDays: 30, interval: 'month' },
  routing: 'percentage',
  retryAttempts: 3,
};
let _fraudAttempts = [];
let _aiDecisions = [];
let _orders = []; // pending orders from Shopify script

// ── STRIPE VALIDATION ─────────────────────────────────────────────────────────

router.post('/validate-stripe', async (req, res) => {
  const { secretKey } = req.body;
  if (!secretKey) return res.status(400).json({ valid: false, error: 'Secret Key requerida' });
  if (!secretKey.startsWith('sk_live_') && !secretKey.startsWith('sk_test_')) {
    return res.status(400).json({ valid: false, error: 'La clave debe empezar por sk_live_ o sk_test_' });
  }
  try {
    const result = await stripeRequest('GET', '/v1/account', null, secretKey);
    if (result.error) return res.json({ valid: false, error: result.error.message });
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
    const existing = await stripeRequest('GET', '/v1/webhook_endpoints?limit=20', null, secretKey);
    if (existing.data) {
      const found = existing.data.find(w => w.url === webhookUrl && !w.deleted);
      if (found) return res.json({ success: true, webhookId: found.id, alreadyExisted: true, message: 'Webhook ya configurado ✓' });
    }
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
    res.json({ success: true, webhookId: webhook.id, webhookSecret: webhook.secret, url: webhook.url, message: 'Webhook creado automáticamente ✓' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── SQUARE VALIDATION ─────────────────────────────────────────────────────────

router.post('/validate-square', async (req, res) => {
  const { accessToken, environment } = req.body;
  if (!accessToken) return res.status(400).json({ valid: false, error: 'Access Token requerido' });
  const host = environment === 'sandbox' ? 'connect.squareupsandbox.com' : 'connect.squareup.com';
  try {
    const result = await squareRequest('GET', '/v2/merchants', null, accessToken, host);
    if (result.errors) return res.json({ valid: false, error: result.errors[0]?.detail || 'Token inválido' });
    const merchant = result.merchant?.[0] || {};
    res.json({ valid: true, merchant: { id: merchant.id, name: merchant.business_name || 'Tu negocio Square', country: merchant.country, currency: merchant.currency } });
  } catch (e) {
    res.status(500).json({ valid: false, error: 'Error conectando con Square: ' + e.message });
  }
});

router.post('/square-locations', async (req, res) => {
  const { accessToken, environment } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'Access Token requerido' });
  const host = environment === 'sandbox' ? 'connect.squareupsandbox.com' : 'connect.squareup.com';
  try {
    const result = await squareRequest('GET', '/v2/locations', null, accessToken, host);
    if (result.errors) throw new Error(result.errors[0]?.detail);
    res.json({ locations: result.locations || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FRAUD DETECTION ───────────────────────────────────────────────────────────

router.post('/fraud-check', (req, res) => {
  const { ip, email, amount } = req.body;
  const settings = _settings.fraudSettings;
  if (!settings.enabled) return res.json({ allowed: true });
  const now = Date.now();
  const oneHour = 3600000;
  _fraudAttempts = _fraudAttempts.filter(a => now - a.timestamp < 86400000);
  const ipAttempts = _fraudAttempts.filter(a => a.ip === ip && (now - a.timestamp) < oneHour);
  if (ipAttempts.length >= (settings.maxAttemptsPerIp || 3)) {
    _fraudAttempts.push({ ip, email, amount, timestamp: now, blocked: true, reason: 'Demasiados intentos' });
    return res.json({ allowed: false, reason: 'Demasiados intentos de pago desde tu IP. Inténtalo más tarde.' });
  }
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
  if (!_settings.aiRouting?.enabled) return res.json({ applied: false, reason: 'IA de routing desactivada' });
  try {
    const db = require('../db');
    const payments = db.getAll ? (db.getAll('payments') || []) : [];
    const gateways = db.getAll ? (db.getAll('gateways') || []) : [];
    if (payments.length < 10) return res.json({ applied: false, reason: 'Se necesitan al menos 10 pagos' });
    const sevenDays = 7 * 86400000;
    const recent = payments.filter(p => Date.now() - new Date(p.createdAt || 0).getTime() < sevenDays);
    const stats = {};
    gateways.forEach(g => {
      const gwPayments = recent.filter(p => p.gatewayId === g.id);
      const succeeded = gwPayments.filter(p => p.status === 'SUCCEEDED').length;
      const total = gwPayments.length;
      stats[g.id] = { name: g.name, total, succeeded, rate: total > 0 ? (succeeded / total * 100).toFixed(1) : 0 };
    });
    const active = gateways.filter(g => g.active && stats[g.id]?.total > 0);
    if (active.length < 2) return res.json({ applied: false, reason: 'Se necesitan al menos 2 pasarelas activas' });
    const totalRate = active.reduce((s, g) => s + parseFloat(stats[g.id].rate), 0);
    const decisions = [];
    for (const g of active) {
      const newPct = totalRate > 0 ? Math.round((parseFloat(stats[g.id].rate) / totalRate) * 100) : Math.round(100 / active.length);
      const oldPct = g.trafficPct || 0;
      if (Math.abs(newPct - oldPct) >= 5) {
        if (db.update) db.update('gateways', g.id, { trafficPct: newPct });
        decisions.push({ gateway: g.name, oldPct, newPct, successRate: stats[g.id].rate, reason: `Tasa de éxito: ${stats[g.id].rate}%` });
      }
    }
    if (decisions.length > 0) { _aiDecisions.unshift({ decisions, timestamp: new Date().toISOString() }); _aiDecisions = _aiDecisions.slice(0, 20); }
    res.json({ applied: decisions.length > 0, decisions, message: decisions.length > 0 ? `IA ajustó ${decisions.length} pasarela(s)` : 'Ya están optimizados' });
  } catch (e) {
    res.status(500).json({ applied: false, error: e.message });
  }
});

router.get('/ai-history', (req, res) => res.json(_aiDecisions));

// ── SETTINGS ──────────────────────────────────────────────────────────────────

router.get('/settings', (req, res) => res.json(_settings));

router.post('/settings', (req, res) => {
  const { aiRouting, fraudSettings, dailyReport, autoSubscription, routing, retryAttempts } = req.body;
  if (aiRouting !== undefined) _settings.aiRouting = aiRouting;
  if (fraudSettings !== undefined) _settings.fraudSettings = fraudSettings;
  if (dailyReport !== undefined) _settings.dailyReport = dailyReport;
  if (autoSubscription !== undefined) _settings.autoSubscription = autoSubscription;
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
    const todayPayments = payments.filter(p => new Date(p.createdAt || 0).getTime() >= startOfDay);
    const succeeded = todayPayments.filter(p => p.status === 'SUCCEEDED');
    const failed = todayPayments.filter(p => p.status === 'FAILED');
    const totalRevenue = succeeded.reduce((s, p) => s + (p.amount || 0), 0);
    const byGateway = {};
    succeeded.forEach(p => {
      const gw = p.gateway || 'Unknown';
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
      const params = [];
      for (const [key, value] of Object.entries(body)) {
        if (Array.isArray(value)) value.forEach(v => params.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`));
        else params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
      postData = params.join('&');
    }
    const options = {
      hostname: 'api.stripe.com', path, method,
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
    };
    const req = https.request(options, resp => {
      let raw = '';
      resp.on('data', d => raw += d);
      resp.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON from Stripe')); } });
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
      hostname: host, path, method,
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
      resp.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON from Square')); } });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

module.exports = router;

/**
 * NoLimitsPay - Subscription Vault Routes
 * Handles Card on File for Square AND Stripe vault
 * Add these routes to gateway-setup.js
 */

// ── SQUARE: SAVE CARD ON FILE (Vault) ─────────────────────────────────────────
// POST /api/setup/square-save-card
// Called after successful Square payment to save card for future charges
router.post('/square-save-card', async (req, res) => {
  const { accessToken, environment, nonce, customerEmail, customerName, locationId } = req.body;

  if (!accessToken || !nonce || !customerEmail) {
    return res.status(400).json({ error: 'accessToken, nonce y customerEmail son obligatorios' });
  }

  const host = environment === 'sandbox'
    ? 'connect.squareupsandbox.com'
    : 'connect.squareup.com';

  try {
    // 1. Create or find Square customer
    const customersRes = await squareRequest('GET',
      `/v2/customers?query[filter][email_address][exact]=${encodeURIComponent(customerEmail)}`,
      null, accessToken, host
    );

    let customerId;
    if (customersRes.customers?.length > 0) {
      customerId = customersRes.customers[0].id;
    } else {
      const newCustomer = await squareRequest('POST', '/v2/customers', {
        email_address: customerEmail,
        given_name: (customerName || customerEmail).split(' ')[0],
        family_name: (customerName || '').split(' ').slice(1).join(' ') || '',
        reference_id: `nlp_${Date.now()}`,
      }, accessToken, host);

      if (newCustomer.errors) throw new Error(newCustomer.errors[0]?.detail || 'Error creando cliente Square');
      customerId = newCustomer.customer.id;
    }

    // 2. Save card on file using the payment nonce
    const cardRes = await squareRequest('POST', `/v2/customers/${customerId}/cards`, {
      card_nonce: nonce,
      billing_address: { country: 'ES' },
      cardholder_name: customerName || customerEmail,
    }, accessToken, host);

    if (cardRes.errors) throw new Error(cardRes.errors[0]?.detail || 'Error guardando tarjeta');

    const card = cardRes.card;

    res.json({
      success: true,
      customerId,
      cardId: card.id,
      last4: card.last_4,
      brand: card.card_brand,
      expMonth: card.exp_month,
      expYear: card.exp_year,
      message: 'Tarjeta guardada para cobros futuros ✓',
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── SQUARE: CHARGE STORED CARD ────────────────────────────────────────────────
// POST /api/setup/square-charge-card
// Called by the orchestrator for recurring subscription charges
router.post('/square-charge-card', async (req, res) => {
  const { accessToken, environment, customerId, cardId, amount, currency, locationId, note } = req.body;

  if (!accessToken || !cardId || !amount || !locationId) {
    return res.status(400).json({ error: 'accessToken, cardId, amount y locationId son obligatorios' });
  }

  const host = environment === 'sandbox'
    ? 'connect.squareupsandbox.com'
    : 'connect.squareup.com';

  try {
    const crypto = require('crypto');
    const idempotencyKey = crypto.randomBytes(16).toString('hex');

    const paymentRes = await squareRequest('POST', '/v2/payments', {
      source_id: cardId,           // The stored card ID (Card on File)
      customer_id: customerId,
      idempotency_key: idempotencyKey,
      amount_money: {
        amount: Math.round(amount * 100),  // Square uses cents
        currency: (currency || 'EUR').toUpperCase(),
      },
      location_id: locationId,
      note: note || 'NoLimitsPay subscription charge',
      autocomplete: true,
    }, accessToken, host);

    if (paymentRes.errors) throw new Error(paymentRes.errors[0]?.detail || 'Error cobrando');

    const payment = paymentRes.payment;
    res.json({
      success: true,
      paymentId: payment.id,
      status: payment.status,
      amount: payment.amount_money?.amount / 100,
      currency: payment.amount_money?.currency,
      message: `Cobro de €${amount} procesado ✓`,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── CREATE SUBSCRIPTION (unified for all gateways) ───────────────────────────
// POST /api/setup/create-subscription
router.post('/create-subscription', async (req, res) => {
  const { gateway, secretKey, accessToken, environment, locationId,
          customerEmail, customerName, paymentMethodId, cardId, customerId,
          priceAmount, currency, intervalDays, interval } = req.body;

  if (!gateway || !customerEmail || !priceAmount) {
    return res.status(400).json({ error: 'gateway, customerEmail y priceAmount son obligatorios' });
  }

  // ── STRIPE ──────────────────────────────────────────────────────────────────
  if (gateway === 'STRIPE') {
    if (!secretKey) return res.status(400).json({ error: 'secretKey requerida para Stripe' });

    try {
      // Find or create customer
      const existingRes = await stripeRequest('GET',
        `/v1/customers?email=${encodeURIComponent(customerEmail)}&limit=1`, null, secretKey);
      let stripeCustomerId;

      if (existingRes.data?.length > 0) {
        stripeCustomerId = existingRes.data[0].id;
      } else {
        const newCustomer = await stripeRequest('POST', '/v1/customers', {
          email: customerEmail,
          name: customerName || customerEmail,
        }, secretKey);
        if (newCustomer.error) throw new Error(newCustomer.error.message);
        stripeCustomerId = newCustomer.id;
      }

      // Attach payment method
      if (paymentMethodId) {
        await stripeRequest('POST', `/v1/payment_methods/${paymentMethodId}/attach`,
          { customer: stripeCustomerId }, secretKey);
        await stripeRequest('POST', `/v1/customers/${stripeCustomerId}`,
          { 'invoice_settings[default_payment_method]': paymentMethodId }, secretKey);
      }

      // Create price
      const stripeInterval = ['day', 'week', 'month', 'year'].includes(interval) ? interval : 'month';
      const price = await stripeRequest('POST', '/v1/prices', {
        unit_amount: Math.round(parseFloat(priceAmount) * 100),
        currency: (currency || 'eur').toLowerCase(),
        'recurring[interval]': stripeInterval,
        'product_data[name]': 'NoLimitsPay Subscription',
      }, secretKey);
      if (price.error) throw new Error(price.error.message);

      // Create subscription with trial
      const trialDays = parseInt(intervalDays) || 30;
      const trialEnd = Math.floor(Date.now() / 1000) + (trialDays * 86400);
      const subBody = { customer: stripeCustomerId, 'items[0][price]': price.id, trial_end: trialEnd };
      if (paymentMethodId) subBody.default_payment_method = paymentMethodId;

      const subscription = await stripeRequest('POST', '/v1/subscriptions', subBody, secretKey);
      if (subscription.error) throw new Error(subscription.error.message);

      res.json({
        success: true,
        gateway: 'STRIPE',
        subscriptionId: subscription.id,
        customerId: stripeCustomerId,
        status: subscription.status,
        firstChargeDate: new Date(trialEnd * 1000).toLocaleDateString('es-ES'),
        message: `Suscripción Stripe creada. Primer cobro en ${trialDays} días.`,
      });
    } catch (e) {
      res.status(500).json({ success: false, gateway: 'STRIPE', error: e.message });
    }

  // ── SQUARE (via Card on File vault) ─────────────────────────────────────────
  } else if (gateway === 'SQUARE') {
    // Square subscriptions use Card on File stored in our vault
    // The card must have been saved with /api/setup/square-save-card after the first payment

    if (!cardId || !customerId) {
      return res.status(400).json({
        error: 'Square requiere cardId y customerId (tarjeta guardada en el vault). Asegúrate de que el pago inicial guardó la tarjeta.',
        setup: 'Llama a /api/setup/square-save-card después del primer pago para guardar la tarjeta.',
      });
    }

    // Save subscription info in db - orchestrator will charge on schedule
    try {
      const db = require('../db');
      const trialDays = parseInt(intervalDays) || 30;
      const firstChargeDate = new Date(Date.now() + (trialDays * 86400000));

      const subscription = db.insert ? db.insert('squareSubscriptions', {
        gateway: 'SQUARE',
        customerId,
        cardId,
        customerEmail,
        locationId,
        priceAmount: parseFloat(priceAmount),
        currency: currency || 'EUR',
        interval: interval || 'month',
        firstChargeDate: firstChargeDate.toISOString(),
        nextChargeDate: firstChargeDate.toISOString(),
        status: 'ACTIVE',
        environment: environment || 'production',
      }) : { id: `sq_sub_${Date.now()}` };

      res.json({
        success: true,
        gateway: 'SQUARE',
        subscriptionId: subscription.id,
        customerId,
        cardId,
        firstChargeDate: firstChargeDate.toLocaleDateString('es-ES'),
        message: `Suscripción Square configurada. Primer cobro en ${trialDays} días usando tarjeta guardada (Card on File).`,
      });
    } catch (e) {
      res.status(500).json({ success: false, gateway: 'SQUARE', error: e.message });
    }

  // ── TAILOREDPAYMENTS ─────────────────────────────────────────────────────────
  } else if (gateway === 'TAILORED') {
    res.json({
      success: false,
      gateway: 'TAILORED',
      manual: true,
      message: 'TailoredPayments gestiona los cobros recurrentes a través de su propio sistema. Contacta con tu gestor para configurar cobros recurrentes.',
    });
  } else {
    res.status(400).json({ error: 'Gateway no reconocida: STRIPE, SQUARE o TAILORED' });
  }
});


module.exports = router;
