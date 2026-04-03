// pixels.js
const router = require('express').Router();
const db = require('../db');
router.get('/',       (req, res) => res.json(db.getAll('pixels')));
router.post('/',      (req, res) => res.json(db.insert('pixels', req.body)));
router.put('/:id',    (req, res) => res.json(db.update('pixels', req.params.id, req.body)));
router.delete('/:id', (req, res) => { db.delete('pixels', req.params.id); res.json({ success: true }); });
module.exports = router;
