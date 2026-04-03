const router = require('express').Router();
const db = require('../db');
const stripeService = require('../services/stripe.service');

// CRUD for webhook endpoints
router.get('/',       (req, res) => res.json(db.getAll('webhooks')));
router.post('/',      (req, res) => res.json(db.insert('webhooks', { ...req.body, events: req.body.events || ['*'] })));
router.put('/:id',    (req, res) => res.json(db.update('webhooks', req.params.id, req.body)));
router.delete('/:id', (req, res) => { db.delete('webhooks', req.params.id); res.json({ success: true }); });

// Webhook logs
router.get('/logs',   (req, res) => {
  const logs = db.getAll('webhookLogs');
  logs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(logs.slice(0, 100));
});

// Stripe incoming webhook handler
router.post('/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const event = stripeService.constructWebhookEvent(req.body, sig);
    // Map Stripe events to OrkestaPay events
    const eventMap = {
      'payment_intent.succeeded': 'payment.succeeded',
      'payment_intent.payment_failed': 'payment.failed',
      'customer.subscription.created': 'subscription.created',
      'customer.subscription.deleted': 'subscription.cancelled',
      'invoice.paid': 'rebill.success',
    };
    const orkEvent = eventMap[event.type];
    if (orkEvent) {
      const { dispatch } = require('../services/webhook.service');
      await dispatch(orkEvent, event.data.object);
    }
    res.json({ received: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
