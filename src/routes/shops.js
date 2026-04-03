// shops.js
const router = require('express').Router();
const db = require('../db');
router.get('/',       (req, res) => res.json(db.getAll('shops')));
router.post('/',      (req, res) => res.json(db.insert('shops', req.body)));
router.put('/:id',    (req, res) => res.json(db.update('shops', req.params.id, req.body)));
router.delete('/:id', (req, res) => { db.delete('shops', req.params.id); res.json({ success: true }); });
module.exports = router;
