/**
 * OrkestaPay - Payment Orchestrator Service
 * Handles routing, failover, and retries across Stripe, Square, TailoredPayments
 */

const stripeService     = require('./stripe.service');
const squareService     = require('./square.service');
const tailoredService   = require('./tailored.service');
const db                = require('../db');
const { logger }        = require('../utils/logger');
const webhookService    = require('./webhook.service');

const PSP_MAP = {
  STRIPE:   stripeService,
  SQUARE:   squareService,
  TAILORED: tailoredService,
};

/**
 * Select a gateway based on routing strategy:
 *  - 'percentage' : weighted random selection
 *  - 'priority'   : first active gateway
 *  - 'round_robin': cycle through active gateways
 */
function selectGateway(gateways, strategy = 'percentage') {
  const active = gateways.filter(g => g.active);
  if (!active.length) throw new Error('No active payment gateways configured');

  if (strategy === 'priority') return active[0];

  if (strategy === 'round_robin') {
    const idx = (db.getSetting('rrIndex') || 0) % active.length;
    db.setSetting('rrIndex', idx + 1);
    return active[idx];
  }

  // Percentage-based (default)
  const totalPct = active.reduce((s, g) => s + (g.trafficPct || 0), 0);
  if (totalPct === 0) return active[0];
  let rand = Math.random() * totalPct;
  for (const gw of active) {
    rand -= (gw.trafficPct || 0);
    if (rand <= 0) return gw;
  }
  return active[active.length - 1];
}

/**
 * Process a one-time payment
 */
async function processPayment({ amount, currency = 'EUR', customerId, paymentMethodId, description, metadata, gatewayId }) {
  const gateways = db.getAll('gateways');
  const candidates = gatewayId ? gateways.filter(g => g.id === gatewayId) : gateways;
  const strategy = db.getSetting('routing') || 'percentage';

  let lastError = null;
  const maxRetries = parseInt(db.getSetting('retryAttempts') || 3);

  // Try up to maxRetries gateways (failover)
  const tried = new Set();
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const available = candidates.filter(g => g.active && !tried.has(g.id));
    if (!available.length) break;

    const gateway = selectGateway(available, strategy);
    tried.add(gateway.id);

    try {
      logger.info(`Attempting payment via ${gateway.psp} (${gateway.name}) attempt ${attempt + 1}`);
      const svc = PSP_MAP[gateway.psp];
      if (!svc) throw new Error(`Unknown PSP: ${gateway.psp}`);

      const result = await svc.charge({
        amount, currency, customerId,
        paymentMethodId: paymentMethodId || gateway.defaultPaymentMethodId,
        description, metadata,
        credentials: gateway.credentials
      });

      // Save payment record
      const payment = db.insert('payments', {
        status: 'SUCCEEDED',
        amount, currency, amountInEUR: convertToEUR(amount, currency),
        gateway: gateway.name, gatewayId: gateway.id, psp: gateway.psp,
        externalId: result.id,
        customerId, description, metadata,
        attempts: attempt + 1,
      });

      // Fire webhook
      await webhookService.dispatch('payment.succeeded', payment);
      return payment;

    } catch (err) {
      lastError = err;
      logger.warn(`Payment failed on ${gateway.name}: ${err.message}`);

      // Save failed attempt
      db.insert('payments', {
        status: 'FAILED', amount, currency,
        gateway: gateway.name, gatewayId: gateway.id, psp: gateway.psp,
        error: err.message, attempts: attempt + 1, customerId,
      });

      // Fire webhook for failure
      await webhookService.dispatch('payment.failed', { amount, currency, gateway: gateway.name, error: err.message });
    }
  }

  throw new Error(`All payment attempts failed. Last error: ${lastError?.message}`);
}

/**
 * Create a subscription (recurring payment)
 */
async function createSubscription({ customerId, planId, amount, currency = 'EUR', interval, intervalCount = 1, trialDays, gatewayId, metadata }) {
  const gateways = db.getAll('gateways');
  const gateway = gatewayId
    ? gateways.find(g => g.id === gatewayId && g.active)
    : selectGateway(gateways.filter(g => g.active), db.getSetting('routing') || 'percentage');

  if (!gateway) throw new Error('No active gateway found for subscription');

  const svc = PSP_MAP[gateway.psp];
  const result = await svc.createSubscription({
    customerId, planId, amount, currency,
    interval, intervalCount, trialDays, metadata,
    credentials: gateway.credentials
  });

  const sub = db.insert('subscriptions', {
    status: 'ACTIVE',
    customerId, planId, amount, currency,
    interval, intervalCount, trialDays: trialDays || 0,
    gateway: gateway.name, gatewayId: gateway.id, psp: gateway.psp,
    externalId: result.id,
    nextBillingDate: result.nextBillingDate,
    metadata,
  });

  await webhookService.dispatch('subscription.created', sub);
  return sub;
}

/**
 * Cancel a subscription
 */
async function cancelSubscription(subscriptionId) {
  const sub = db.getById('subscriptions', subscriptionId);
  if (!sub) throw new Error('Subscription not found');

  const gateway = db.getById('gateways', sub.gatewayId);
  if (!gateway) throw new Error('Gateway not found');

  const svc = PSP_MAP[gateway.psp];
  await svc.cancelSubscription({ externalId: sub.externalId, credentials: gateway.credentials });

  const updated = db.update('subscriptions', subscriptionId, { status: 'CANCELLED', cancelledAt: new Date().toISOString() });
  await webhookService.dispatch('subscription.cancelled', updated);
  return updated;
}

/**
 * Batch payment: charge a list of customers
 */
async function batchCharge({ customerIds, amount, currency = 'EUR', description, gatewayId }) {
  const results = { total: customerIds.length, success: 0, failed: 0, results: [] };

  for (const customerId of customerIds) {
    try {
      const payment = await processPayment({ amount, currency, customerId, description, gatewayId });
      results.success++;
      results.results.push({ customerId, status: 'success', paymentId: payment.id });
    } catch (err) {
      results.failed++;
      results.results.push({ customerId, status: 'failed', error: err.message });
    }
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  await webhookService.dispatch('batch.completed', results);
  return results;
}

function convertToEUR(amount, currency) {
  const rates = { EUR: 1, USD: 0.92, GBP: 1.17, JPY: 0.006 };
  return +(amount * (rates[currency] || 1)).toFixed(2);
}

module.exports = { processPayment, createSubscription, cancelSubscription, batchCharge, selectGateway };
