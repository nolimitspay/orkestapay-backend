const router = require('express').Router();
const db = require('../db');

router.get('/kpis', (req, res) => {
  const payments = db.getAll('payments');
  const succeeded = payments.filter(p => p.status === 'SUCCEEDED');
  const today = new Date().toDateString();
  const todayOk = succeeded.filter(p => new Date(p.createdAt).toDateString() === today);
  const subs = db.getAll('subscriptions');
  res.json({
    totalRevenue: succeeded.reduce((s,p) => s+(p.amountInEUR||p.amount||0),0).toFixed(2),
    todayRevenue: todayOk.reduce((s,p) => s+(p.amountInEUR||p.amount||0),0).toFixed(2),
    todaySales: todayOk.length,
    totalPayments: payments.length,
    succeededPayments: succeeded.length,
    activeSubscriptions: subs.filter(s=>s.status==='ACTIVE').length,
    conversionRate: payments.length ? (succeeded.length/payments.length*100).toFixed(1) : '0',
  });
});

module.exports = router;
