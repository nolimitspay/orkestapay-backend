// shops.js - NoLimitsPay
const router = require('express').Router();
const db = require('../db');

// GET all shops
router.get('/', (req, res) => res.json(db.getAll('shops')));

// POST create shop
router.post('/', (req, res) => {
  const shop = db.insert('shops', req.body);
  res.json(shop);
});

// PUT update shop
router.put('/:id', (req, res) => res.json(db.update('shops', req.params.id, req.body)));

// DELETE shop
router.delete('/:id', (req, res) => {
  db.delete('shops', req.params.id);
  res.json({ success: true });
});

// ── GET /:shopId/script-config ────────────────────────────────────────────────
// Called by nlp.js on every Shopify page load to get shop configuration
// Must be CORS-open since it's called from external Shopify stores
router.get('/:shopId/script-config', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { shopId } = req.params;
  const shops = db.getAll('shops');
  const shop = shops.find(s => s.id === shopId);

  if (!shop) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  // Return only public config — never sensitive data
  res.json({
    shopId: shop.id,
    name: shop.name || shop.url || shopId,
    logo: shop.logo || '',
    successUrl: shop.successUrl || '',
    timer: shop.timer || 480,
    active: shop.active !== false,
  });
});

module.exports = router;
