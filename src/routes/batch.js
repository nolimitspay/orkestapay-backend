const router = require('express').Router();
const orchestrator = require('../services/orchestrator.service');
const stripeService  = require('../services/stripe.service');
const squareService  = require('../services/square.service');
const tailoredService = require('../services/tailored.service');
const db = require('../db');

// POST execute batch charge
router.post('/charge', async (req, res) => {
  try {
    const { customerIds, amount, currency, description, gatewayId } = req.body;
    if (!customerIds?.length) return res.status(400).json({ error: 'customerIds required' });
    if (!amount) return res.status(400).json({ error: 'amount required' });

    const result = await orchestrator.batchCharge({ customerIds, amount, currency, description, gatewayId });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST fetch customers for a gateway (preview before charging)
router.post('/customers', async (req, res) => {
  try {
    const { psp, gatewayId, dateFrom, dateTo } = req.body;
    const gateway = gatewayId ? db.getById('gateways', gatewayId) : null;
    const credentials = gateway?.credentials;

    const svcMap = { STRIPE: stripeService, SQUARE: squareService, TAILORED: tailoredService };
    const svc = svcMap[psp || gateway?.psp];
    if (!svc) return res.status(400).json({ error: `Unknown PSP: ${psp || gateway?.psp}` });

    const customers = await svc.listCustomersWithMethods({ dateFrom, dateTo, credentials });
    res.json({ customers, total: customers.length, withMethod: customers.filter(c => c.hasMethod).length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
