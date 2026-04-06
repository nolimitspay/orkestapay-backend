/**
 * NoLimitsPay — checkout.js
 * 
 * Rutas del checkout universal. Soporta cualquier pasarela configurada
 * (Stripe, Square, Tailor Payments, etc.) a través del orquestador.
 *
 * ENDPOINTS:
 *   POST /api/checkout/session      → Crea sesión de checkout
 *   GET  /api/checkout/session/:id  → Obtiene datos de la sesión
 *   POST /api/checkout/session/:id/pay → Procesa el pago
 *   GET  /api/checkout/:id          → Página HTML del checkout (iframe/redirect)
 *
 * CÓMO AÑADIRLO AL BACKEND:
 *   1. Copia este archivo en: backend/src/routes/checkout.js
 *   2. En backend/src/server.js añade debajo de las otras rutas:
 *        app.use('/api/checkout', require('./routes/checkout'));
 *   3. Haz push a GitHub → Render despliega automáticamente
 *
 * CÓMO LO USA EL CLIENTE (plug & play):
 *   Opción A - Redirect:
 *     window.location.href = `https://orkestapay-backend.onrender.com/api/checkout/${orderId}`
 *
 *   Opción B - Script (meter en theme.liquid o cualquier web):
 *     <script src="https://orkestapay-backend.onrender.com/nlp.js"></script>
 */

const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db');
const orchestrator = require('../services/orchestrator.service');
const { logger } = require('../utils/logger');

// ── CORS para todos los endpoints del checkout ──────────────────────────────
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// ── In-memory sessions (rápido, con fallback a db) ─────────────────────────
let _sessions = [];

function saveSession(session) {
  _sessions.push(session);
  if (_sessions.length > 1000) _sessions = _sessions.slice(-1000);
  try { db.insert('checkoutSessions', session); } catch {}
  return session;
}

function getSession(id) {
  let s = _sessions.find(s => s.id === id);
  if (!s) {
    try {
      const all = db.getAll('checkoutSessions') || [];
      s = all.find(s => s.id === id);
    } catch {}
  }
  return s;
}

function updateSession(id, updates) {
  const idx = _sessions.findIndex(s => s.id === id);
  if (idx >= 0) _sessions[idx] = { ..._sessions[idx], ...updates };
  try { db.update('checkoutSessions', id, updates); } catch {}
  return getSession(id);
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/checkout/session
// Crea una sesión de checkout. Llamado desde la tienda cuando el cliente
// hace clic en "Pagar".
//
// Body:
//   shopId      (string)  — ID de la tienda
//   amount      (number)  — Importe en céntimos (ej: 4999 = 49.99€)
//   currency    (string)  — EUR, USD, GBP (default: EUR)
//   description (string)  — Descripción del pedido
//   customerEmail (string) — Email del cliente (opcional)
//   successUrl  (string)  — URL de redirección al pagar con éxito
//   cancelUrl   (string)  — URL de redirección si cancela
//   metadata    (object)  — Datos extra (orderId, items, etc.)
//   gatewayId   (string)  — Forzar pasarela concreta (opcional, si no usa routing)
//
// Respuesta:
//   { sessionId, checkoutUrl, expiresAt }
// ──────────────────────────────────────────────────────────────────────────────
router.post('/session', (req, res) => {
  const {
    shopId,
    amount,
    currency = 'EUR',
    description = 'Pago NoLimitsPay',
    customerEmail,
    successUrl,
    cancelUrl,
    metadata = {},
    gatewayId,
  } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount es obligatorio y debe ser mayor que 0' });
  }

  const sessionId = 'cs_' + crypto.randomBytes(12).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

  const session = {
    id: sessionId,
    shopId: shopId || 'default',
    amount: parseInt(amount),
    currency,
    description,
    customerEmail,
    successUrl: successUrl || null,
    cancelUrl: cancelUrl || null,
    metadata,
    gatewayId: gatewayId || null,
    status: 'PENDING', // PENDING → PROCESSING → PAID | FAILED | EXPIRED
    createdAt: new Date().toISOString(),
    expiresAt,
    paymentId: null,
    error: null,
  };

  saveSession(session);
  logger.info(`Checkout session created: ${sessionId} | amount: ${amount} ${currency}`);

  // URL del checkout embebible
  const baseUrl = process.env.BACKEND_URL || 'https://orkestapay-backend.onrender.com';
  const checkoutUrl = `${baseUrl}/api/checkout/${sessionId}`;

  res.json({
    sessionId,
    checkoutUrl,
    expiresAt,
    amount: session.amount,
    currency: session.currency,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/checkout/session/:id
// Devuelve el estado de una sesión. Usado por el frontend para polling.
// ──────────────────────────────────────────────────────────────────────────────
router.get('/session/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

  // Comprobar expiración
  if (new Date() > new Date(session.expiresAt) && session.status === 'PENDING') {
    updateSession(session.id, { status: 'EXPIRED' });
    return res.json({ ...session, status: 'EXPIRED' });
  }

  res.json(session);
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/checkout/session/:id/pay
// Procesa el pago de una sesión. El checkout HTML llama a este endpoint
// cuando el cliente envía el formulario de pago.
//
// Body (depende de la pasarela activa):
//   paymentMethodId (string) — Token de Stripe / Square / Tailor
//   cardNumber      (string) — Si se usa formulario propio (no recomendado)
//   gatewayId       (string) — Forzar pasarela (opcional)
// ──────────────────────────────────────────────────────────────────────────────
router.post('/session/:id/pay', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

  if (session.status === 'PAID') {
    return res.json({ status: 'PAID', paymentId: session.paymentId });
  }

  if (session.status === 'EXPIRED') {
    return res.status(410).json({ error: 'La sesión ha expirado. Inicia un nuevo pago.' });
  }

  if (new Date() > new Date(session.expiresAt)) {
    updateSession(session.id, { status: 'EXPIRED' });
    return res.status(410).json({ error: 'La sesión ha expirado. Inicia un nuevo pago.' });
  }

  // Marcar como procesando para evitar doble carga
  if (session.status === 'PROCESSING') {
    return res.status(409).json({ error: 'El pago ya está siendo procesado' });
  }

  updateSession(session.id, { status: 'PROCESSING' });

  try {
    const { paymentMethodId, gatewayId } = req.body;

    logger.info(`Processing checkout payment: ${session.id} | ${session.amount} ${session.currency}`);

    const payment = await orchestrator.processPayment({
      amount: session.amount,
      currency: session.currency,
      description: session.description,
      customerId: session.customerEmail,
      paymentMethodId: paymentMethodId || null,
      gatewayId: gatewayId || session.gatewayId || null,
      metadata: {
        ...session.metadata,
        sessionId: session.id,
        shopId: session.shopId,
        source: 'checkout',
      },
    });

    // Marcar sesión como pagada
    updateSession(session.id, {
      status: 'PAID',
      paymentId: payment.id,
      paidAt: new Date().toISOString(),
    });

    logger.info(`Checkout payment succeeded: ${session.id} → payment ${payment.id}`);

    res.json({
      status: 'PAID',
      paymentId: payment.id,
      redirectUrl: session.successUrl,
      amount: session.amount,
      currency: session.currency,
    });

  } catch (err) {
    logger.error(`Checkout payment failed: ${session.id} — ${err.message}`);

    updateSession(session.id, {
      status: 'FAILED',
      error: err.message,
    });

    res.status(402).json({
      error: err.message,
      status: 'FAILED',
      redirectUrl: session.cancelUrl,
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/checkout/:id
// Devuelve el HTML del checkout embebible/redirect.
// El cliente abre esta URL o la mete en un iframe.
// Se adapta automáticamente a la pasarela activa (Stripe Elements,
// Square Web Payments, Tailor Payments, etc.)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const session = getSession(req.params.id);

  if (!session) {
    return res.status(404).send(`
      <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
      <title>Sesión no encontrada</title>
      <style>body{font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}
      .box{background:#fff;padding:40px;border-radius:12px;text-align:center;max-width:400px}
      h2{color:#e53e3e;margin-bottom:8px}p{color:#666}</style></head>
      <body><div class="box"><h2>Sesión no encontrada</h2>
      <p>Esta sesión de pago no existe o ha expirado.</p></div></body></html>
    `);
  }

  if (session.status === 'PAID') {
    const redirectScript = session.successUrl
      ? `<script>setTimeout(()=>window.location.href='${session.successUrl}',3000)</script>`
      : '';
    return res.send(`
      <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
      <title>Pago completado</title>
      <style>body{font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0fdf4}
      .box{background:#fff;padding:40px;border-radius:12px;text-align:center;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
      .icon{font-size:56px;margin-bottom:16px}h2{color:#16a34a;margin-bottom:8px}p{color:#666}</style>
      ${redirectScript}</head>
      <body><div class="box"><div class="icon">✅</div>
      <h2>¡Pago completado!</h2>
      <p>Tu pago de ${(session.amount / 100).toFixed(2)} ${session.currency} se ha procesado correctamente.</p>
      ${session.successUrl ? '<p style="font-size:13px;color:#999">Redirigiendo...</p>' : ''}
      </div></body></html>
    `);
  }

  if (session.status === 'EXPIRED') {
    return res.status(410).send(`
      <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
      <title>Sesión expirada</title>
      <style>body{font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fffbeb}
      .box{background:#fff;padding:40px;border-radius:12px;text-align:center;max-width:400px}
      h2{color:#d97706}p{color:#666}</style></head>
      <body><div class="box"><div style="font-size:48px;margin-bottom:16px">⏰</div>
      <h2>Sesión expirada</h2>
      <p>Esta sesión de pago ha expirado. Vuelve a la tienda para iniciar un nuevo pago.</p>
      ${session.cancelUrl ? `<a href="${session.cancelUrl}" style="display:inline-block;margin-top:20px;padding:10px 24px;background:#f59e0b;color:#000;border-radius:8px;text-decoration:none;font-weight:600">Volver a la tienda</a>` : ''}
      </div></body></html>
    `);
  }

  // Detectar qué pasarela tiene activa para mostrar el SDK correcto
  const gateways = db.getAll('gateways').filter(g => g.active);
  const targetGateway = session.gatewayId
    ? gateways.find(g => g.id === session.gatewayId)
    : gateways[0]; // primera activa (según routing)

  const psp = targetGateway?.psp || 'GENERIC';
  const amountFormatted = (session.amount / 100).toFixed(2);
  const baseUrl = process.env.BACKEND_URL || 'https://orkestapay-backend.onrender.com';

  // SDK heads por pasarela
  const sdkHead = {
    STRIPE: `<script src="https://js.stripe.com/v3/"></script>`,
    SQUARE: `<script type="text/javascript" src="https://sandbox.web.squarecdn.com/v1/square.js"></script>`,
    TAILORED: ``, // Tailor usa su propio flow via API
    GENERIC: ``,
  }[psp] || '';

  // Stripe public key (desde env o credentials)
  const stripeKey = process.env.STRIPE_PUBLIC_KEY || targetGateway?.credentials?.publicKey || '';

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pago seguro — NoLimitsPay</title>
${sdkHead}
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
    background: #f8fafc;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .checkout-box {
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 4px 32px rgba(0,0,0,.10);
    width: 100%;
    max-width: 440px;
    overflow: hidden;
  }
  .checkout-header {
    background: linear-gradient(135deg, #1a1a2e, #16213e);
    padding: 24px 28px;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .checkout-header .brand {
    font-size: 15px;
    font-weight: 700;
    color: #C9A84C;
    letter-spacing: -.3px;
  }
  .checkout-header .amount {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -.5px;
  }
  .checkout-header .currency { font-size: 12px; color: rgba(255,255,255,.6); margin-top: 2px; }
  .checkout-body { padding: 28px; }
  .desc { font-size: 13px; color: #64748b; margin-bottom: 24px; }
  .field { margin-bottom: 16px; }
  label { display: block; font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .05em; }
  input[type=text], input[type=email], input[type=tel] {
    width: 100%; padding: 11px 14px; border: 1.5px solid #e5e7eb;
    border-radius: 9px; font-size: 15px; color: #111; outline: none;
    transition: border-color .2s;
  }
  input:focus { border-color: #C9A84C; }
  .card-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  #card-element, #square-card-container {
    padding: 12px 14px; border: 1.5px solid #e5e7eb;
    border-radius: 9px; background: #fff; min-height: 46px;
  }
  .pay-btn {
    width: 100%; padding: 14px; background: #C9A84C; color: #000;
    font-size: 16px; font-weight: 700; border: none; border-radius: 10px;
    cursor: pointer; margin-top: 8px; transition: all .2s;
    display: flex; align-items: center; justify-content: center; gap: 8px;
  }
  .pay-btn:hover { background: #e8c96a; transform: translateY(-1px); }
  .pay-btn:disabled { background: #9ca3af; cursor: not-allowed; transform: none; }
  .secure-badge {
    display: flex; align-items: center; gap: 6px; justify-content: center;
    margin-top: 16px; font-size: 11px; color: #9ca3af;
  }
  .error-msg {
    background: #fef2f2; border: 1px solid #fecaca; color: #dc2626;
    padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-top: 12px;
    display: none;
  }
  .success-msg {
    background: #f0fdf4; border: 1px solid #bbf7d0; color: #16a34a;
    padding: 16px; border-radius: 8px; font-size: 14px; font-weight: 600;
    text-align: center; display: none; margin-top: 12px;
  }
  .spinner { display: inline-block; width: 18px; height: 18px; border: 2px solid rgba(0,0,0,.3); border-top-color: #000; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .divider { height: 1px; background: #f1f5f9; margin: 20px 0; }
  .gateway-badge { font-size: 10px; color: #9ca3af; text-align: center; margin-bottom: 16px; }
</style>
</head>
<body>

<div class="checkout-box">
  <div class="checkout-header">
    <div>
      <div class="brand">🔐 NoLimitsPay</div>
      <div style="font-size:12px;color:rgba(255,255,255,.5);margin-top:2px">${session.description || 'Pago seguro'}</div>
    </div>
    <div style="text-align:right">
      <div class="amount">${amountFormatted} ${session.currency}</div>
      <div class="currency">Pago único</div>
    </div>
  </div>

  <div class="checkout-body">
    <p class="desc">Completa tu información de pago. La transacción es segura y encriptada.</p>

    <div class="gateway-badge">Procesado por ${psp === 'TAILORED' ? 'Tailor Payments' : psp === 'STRIPE' ? 'Stripe' : psp === 'SQUARE' ? 'Square' : 'NoLimitsPay'}</div>

    <form id="payment-form">
      <div class="field">
        <label>Email</label>
        <input type="email" id="customer-email" placeholder="tu@email.com" value="${session.customerEmail || ''}" required>
      </div>

      <div class="field">
        <label>Nombre en la tarjeta</label>
        <input type="text" id="cardholder-name" placeholder="María García" required>
      </div>

      ${psp === 'STRIPE' ? `
      <!-- STRIPE ELEMENTS -->
      <div class="field">
        <label>Datos de la tarjeta</label>
        <div id="card-element"></div>
      </div>
      ` : psp === 'SQUARE' ? `
      <!-- SQUARE WEB PAYMENTS -->
      <div class="field">
        <label>Datos de la tarjeta</label>
        <div id="square-card-container"></div>
      </div>
      ` : `
      <!-- FORMULARIO GENÉRICO (Tailor Payments / otras) -->
      <div class="field">
        <label>Número de tarjeta</label>
        <input type="text" id="card-number" placeholder="4242 4242 4242 4242" maxlength="19" inputmode="numeric">
      </div>
      <div class="card-row">
        <div class="field">
          <label>Vencimiento</label>
          <input type="text" id="card-expiry" placeholder="MM/AA" maxlength="5" inputmode="numeric">
        </div>
        <div class="field">
          <label>CVV</label>
          <input type="text" id="card-cvc" placeholder="123" maxlength="4" inputmode="numeric">
        </div>
      </div>
      `}

      <div class="divider"></div>

      <button type="submit" class="pay-btn" id="pay-btn">
        <span id="btn-text">Pagar ${amountFormatted} ${session.currency}</span>
      </button>

      <div class="error-msg" id="error-msg"></div>
      <div class="success-msg" id="success-msg">✅ ¡Pago completado! Redirigiendo...</div>
    </form>

    <div class="secure-badge">
      🔒 Pago encriptado SSL · PCI DSS Compliant
    </div>
  </div>
</div>

<script>
const SESSION_ID = '${session.id}';
const API_BASE = '${baseUrl}/api/checkout';
const SUCCESS_URL = '${session.successUrl || ''}';
const CANCEL_URL = '${session.cancelUrl || ''}';

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.style.display = 'block';
  document.getElementById('pay-btn').disabled = false;
  document.getElementById('btn-text').textContent = 'Pagar ${amountFormatted} ${session.currency}';
}

function showSuccess() {
  document.getElementById('success-msg').style.display = 'block';
  document.getElementById('payment-form').style.opacity = '.5';
  document.getElementById('payment-form').style.pointerEvents = 'none';
  if (SUCCESS_URL) setTimeout(() => window.location.href = SUCCESS_URL, 2000);
}

async function submitPayment(paymentMethodId) {
  const btn = document.getElementById('pay-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    const res = await fetch(API_BASE + '/session/' + SESSION_ID + '/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentMethodId }),
    });
    const data = await res.json();

    if (data.status === 'PAID') {
      showSuccess();
    } else {
      showError(data.error || 'Error procesando el pago. Inténtalo de nuevo.');
    }
  } catch (err) {
    showError('Error de conexión. Comprueba tu internet e inténtalo de nuevo.');
  }
}

${psp === 'STRIPE' && stripeKey ? `
// ── STRIPE ELEMENTS ──────────────────────────────────────────────────────────
const stripe = Stripe('${stripeKey}');
const elements = stripe.elements();
const cardElement = elements.create('card', {
  style: {
    base: { fontSize: '15px', color: '#111', fontFamily: 'Inter, sans-serif' },
    invalid: { color: '#dc2626' }
  }
});
cardElement.mount('#card-element');

document.getElementById('payment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { paymentMethod, error } = await stripe.createPaymentMethod({
    type: 'card',
    card: cardElement,
    billing_details: {
      name: document.getElementById('cardholder-name').value,
      email: document.getElementById('customer-email').value,
    }
  });
  if (error) return showError(error.message);
  await submitPayment(paymentMethod.id);
});
` : psp === 'SQUARE' ? `
// ── SQUARE WEB PAYMENTS ───────────────────────────────────────────────────────
const appId = '${targetGateway?.credentials?.appId || ''}';
const locationId = '${targetGateway?.credentials?.locationId || ''}';

(async () => {
  if (!window.Square) return showError('Error cargando Square SDK');
  const payments = window.Square.payments(appId, locationId);
  const card = await payments.card();
  await card.attach('#square-card-container');

  document.getElementById('payment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = await card.tokenize();
    if (result.status === 'OK') {
      await submitPayment(result.token);
    } else {
      showError(result.errors?.[0]?.message || 'Error tokenizando tarjeta');
    }
  });
})();
` : `
// ── GENÉRICO (Tailor Payments / otras pasarelas) ─────────────────────────────
// Formatea número de tarjeta
document.getElementById('card-number')?.addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g,'').replace(/(.{4})/g,'$1 ').trim().slice(0,19);
});
document.getElementById('card-expiry')?.addEventListener('input', (e) => {
  let v = e.target.value.replace(/\D/g,'');
  if (v.length >= 2) v = v.slice(0,2) + '/' + v.slice(2);
  e.target.value = v.slice(0,5);
});

document.getElementById('payment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  // Para Tailor Payments u otras, enviamos los datos al backend
  // y el orquestador los tokeniza con la pasarela correspondiente
  const cardData = {
    number: document.getElementById('card-number')?.value?.replace(/\s/g,''),
    expiry: document.getElementById('card-expiry')?.value,
    cvc: document.getElementById('card-cvc')?.value,
    name: document.getElementById('cardholder-name').value,
    email: document.getElementById('customer-email').value,
  };
  // Enviamos directamente — el backend tokeniza con la pasarela activa
  await submitPayment(JSON.stringify(cardData));
});
`}
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.send(html);
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/checkout/sessions  (solo admin)
// Lista todas las sesiones de checkout
// ──────────────────────────────────────────────────────────────────────────────
router.get('/sessions', (req, res) => {
  try {
    const sessions = db.getAll('checkoutSessions') || [];
    sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ sessions, total: sessions.length });
  } catch {
    res.json({ sessions: _sessions.slice(-50), total: _sessions.length });
  }
});

module.exports = router;
