const router = require('express').Router();
const db = require('../db');
const crypto = require('crypto');
const orchestrator = require('../services/orchestrator.service');

// ── In-memory pending orders (fast access for nlp.js flow) ───────────────────
let _pendingOrders = [];

// GET all payments (with optional filters)
router.get('/', (req, res) => {
  let payments = db.getAll('payments');
  const { status, gateway, dateFrom, dateTo, search } = req.query;
  if (status) payments = payments.filter(p => p.status === status);
  if (gateway) payments = payments.filter(p => p.gatewayId === gateway);
  if (dateFrom) payments = payments.filter(p => new Date(p.createdAt) >= new Date(dateFrom));
  if (dateTo) payments = payments.filter(p => new Date(p.createdAt) <= new Date(dateTo));
  if (search) payments = payments.filter(p => p.email?.includes(search) || p.id?.includes(search));
  payments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ payments, total: payments.length });
});

// GET single payment
router.get('/:id', (req, res) => {
  const p = db.getById('payments', req.params.id);
  if (!p) return res.status(404).json({ error: 'Payment not found' });
  res.json(p);
});

// POST process a payment
router.post('/', async (req, res) => {
  try {
    const result = await orchestrator.processPayment(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST refund a payment
router.post('/:id/refund', async (req, res) => {
  try {
    const payment = db.getById('payments', req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    const updated = db.update('payments', req.params.id, {
      status: 'REFUNDED',
      refundedAt: new Date().toISOString()
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET dashboard KPIs
router.get('/stats/kpis', (req, res) => {
  const payments = db.getAll('payments');
  const succeeded = payments.filter(p => p.status === 'SUCCEEDED');
  const today = new Date().toDateString();
  const todayPayments = succeeded.filter(p => new Date(p.createdAt).toDateString() === today);
  res.json({
    totalPayments: payments.length,
    succeededCount: succeeded.length,
    totalRevenue: succeeded.reduce((s, p) => s + (p.amountInEUR || p.amount || 0), 0).toFixed(2),
    todayRevenue: todayPayments.reduce((s, p) => s + (p.amountInEUR || p.amount || 0), 0).toFixed(2),
    todaySales: todayPayments.length,
    conversionRate: payments.length ? (succeeded.length / payments.length * 100).toFixed(1) : '0',
  });
});

// ── POST /api/payments/create-order ──────────────────────────────────────────
// Called by nlp.js when customer clicks checkout in Shopify
// Creates a pending order and returns orderId for the checkout page
router.post('/create-order', (req, res) => {
  // Allow cross-origin (called from Shopify stores)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const { shopId, shopName, items, amount, currency, itemCount } = req.body;

  if (!shopId || !amount) {
    return res.status(400).json({ error: 'shopId and amount are required' });
  }

  // Generate unique order ID
  const orderId = 'nlp_' + crypto.randomBytes(8).toString('hex');

  const order = {
    orderId,
    shopId,
    shopName: shopName || shopId,
    items: items || [],
    amount: parseInt(amount) || 0,
    currency: currency || 'EUR',
    itemCount: itemCount || 1,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
  };

  // Store in memory for fast access
  _pendingOrders.push(order);
  if (_pendingOrders.length > 500) _pendingOrders = _pendingOrders.slice(-500);

  // Also try to persist to db
  try { db.insert('pendingOrders', order); } catch {}

  res.json({
    orderId,
    amount: order.amount,
    currency: order.currency,
    shopName: order.shopName,
  });
});

// ── OPTIONS /api/payments/create-order ───────────────────────────────────────
// Preflight CORS for Shopify cross-origin requests
router.options('/create-order', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});

// ── GET /api/payments/order/:orderId ─────────────────────────────────────────
// Called by checkout.html to get order details (amount, items, shop name)
router.get('/order/:orderId', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { orderId } = req.params;

  // Check memory first
  let order = _pendingOrders.find(o => o.orderId === orderId);

  // Fallback to db
  if (!order) {
    try {
      const orders = db.getAll('pendingOrders') || [];
      order = orders.find(o => o.orderId === orderId);
    } catch {}
  }

  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

module.exports = router;
