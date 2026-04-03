// gateways.js
const router = require('express').Router();
const db = require('../db');

router.get('/',     (req, res) => res.json(db.getAll('gateways')));
router.get('/:id',  (req, res) => { const g = db.getById('gateways', req.params.id); g ? res.json(g) : res.status(404).json({ error: 'Not found' }); });
router.post('/',    (req, res) => res.json(db.insert('gateways', req.body)));
router.put('/:id',  (req, res) => res.json(db.update('gateways', req.params.id, req.body)));
router.delete('/:id', (req, res) => { db.delete('gateways', req.params.id); res.json({ success: true }); });

module.exports = router;
