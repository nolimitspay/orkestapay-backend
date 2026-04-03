const router = require('express').Router();
const db = require('../db');
router.get('/',       (req, res) => res.json(db.getAll('emailTemplates')));
router.get('/:id',    (req, res) => { const t = db.getById('emailTemplates', req.params.id); t ? res.json(t) : res.status(404).json({ error: 'Not found' }); });
router.post('/',      (req, res) => res.json(db.insert('emailTemplates', req.body)));
router.put('/:id',    (req, res) => res.json(db.update('emailTemplates', req.params.id, req.body)));
router.delete('/:id', (req, res) => { db.delete('emailTemplates', req.params.id); res.json({ success: true }); });
module.exports = router;
