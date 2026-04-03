const router = require('express').Router();
const db = require('../db');
const orchestrator = require('../services/orchestrator.service');

// GET all subscriptions
router.get('/', (req, res) => {
  let subs = db.getAll('subscriptions');
  const { status, customerId } = req.query;
  if (status) subs = subs.filter(s => s.status === status);
  if (customerId) subs = subs.filter(s => s.customerId === customerId);
  subs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ subscriptions: subs, total: subs.length });
});

// GET single subscription
router.get('/:id', (req, res) => {
  const s = db.getById('subscriptions', req.params.id);
  if (!s) return res.status(404).json({ error: 'Subscription not found' });
  res.json(s);
});

// POST create subscription
router.post('/', async (req, res) => {
  try {
    const sub = await orchestrator.createSubscription(req.body);
    res.json(sub);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE cancel subscription
router.delete('/:id', async (req, res) => {
  try {
    const result = await orchestrator.cancelSubscription(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT update subscription (pause/resume)
router.put('/:id/pause', (req, res) => {
  const updated = db.update('subscriptions', req.params.id, { status: 'PAUSED' });
  res.json(updated);
});

router.put('/:id/resume', (req, res) => {
  const updated = db.update('subscriptions', req.params.id, { status: 'ACTIVE' });
  res.json(updated);
});

module.exports = router;
