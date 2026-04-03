const router = require('express').Router();
const db = require('../db');
const orchestrator = require('../services/orchestrator.service');

// GET all payments (with optional filters)
router.get('/', (req, res) => {
  let payments = db.getAll('payments');
  const { status, gateway, dateFrom, dateTo, search } = req.query;
  if (status)   payments = payments.filter(p => p.status === status);
  if (gateway)  payments = payments.filter(p => p.gatewayId === gateway);
  if (dateFrom) payments = payments.filter(p => new Date(p.createdAt) >= new Date(dateFrom));
  if (dateTo)   payments = payments.filter(p => new Date(p.createdAt) <= new Date(dateTo));
  if (search)   payments = payments.filter(p => p.email?.includes(search) || p.id?.includes(search));
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
    const updated = db.update('payments', req.params.id, { status: 'REFUNDED', refundedAt: new Date().toISOString() });
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

module.exports = router;
