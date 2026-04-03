/**
 * OrkestaPay - TailoredPayments Integration
 * Docs: https://docs.tailoredpayments.com
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

function getClient(credentials) {
  const apiKey = credentials?.apiKey || process.env.TAILORED_API_KEY;
  const baseURL = credentials?.baseUrl || process.env.TAILORED_BASE_URL || 'https://api.tailoredpayments.com/v1';
  if (!apiKey) throw new Error('TailoredPayments API key not configured');

  return axios.create({
    baseURL,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Merchant-Id': credentials?.merchantId || process.env.TAILORED_MERCHANT_ID,
    },
  });
}

/**
 * Charge via TailoredPayments
 */
async function charge({ amount, currency, customerId, paymentMethodId, description, metadata, credentials }) {
  const client = getClient(credentials);

  const payload = {
    amount: Math.round(amount * 100),
    currency: currency.toUpperCase(),
    customer_id: customerId,
    payment_method_id: paymentMethodId,
    description,
    idempotency_key: uuidv4(),
    metadata: metadata || {},
  };

  const { data } = await client.post('/payments', payload);

  if (data.status !== 'succeeded' && data.status !== 'COMPLETED') {
    throw new Error(`TailoredPayments charge failed: ${data.error || data.message || 'Unknown error'}`);
  }

  return { id: data.id, status: data.status };
}

/**
 * Create recurring subscription via TailoredPayments
 */
async function createSubscription({ customerId, planId, amount, currency, interval, intervalCount, trialDays, metadata, credentials }) {
  const client = getClient(credentials);

  let resolvedPlanId = planId;

  // Create plan if not provided
  if (!resolvedPlanId) {
    const { data: plan } = await client.post('/plans', {
      amount: Math.round(amount * 100),
      currency: currency.toUpperCase(),
      interval: interval || 'month',
      interval_count: intervalCount || 1,
      name: metadata?.planName || 'OrkestaPay Subscription',
      metadata: metadata || {},
    });
    resolvedPlanId = plan.id;
  }

  const payload = {
    customer_id: customerId,
    plan_id: resolvedPlanId,
    trial_period_days: trialDays || 0,
    metadata: metadata || {},
    idempotency_key: uuidv4(),
  };

  const { data } = await client.post('/subscriptions', payload);

  return {
    id: data.id,
    status: data.status,
    nextBillingDate: data.next_billing_date || data.current_period_end,
  };
}

/**
 * Cancel subscription via TailoredPayments
 */
async function cancelSubscription({ externalId, credentials }) {
  const client = getClient(credentials);
  await client.delete(`/subscriptions/${externalId}`);
}

/**
 * List customers with payment methods
 */
async function listCustomersWithMethods({ dateFrom, dateTo, credentials }) {
  const client = getClient(credentials);
  const params = {};
  if (dateFrom) params.created_after = dateFrom;
  if (dateTo) params.created_before = dateTo;

  const { data } = await client.get('/customers', { params });
  return (data.customers || data.data || []).map(c => ({
    id: c.id,
    email: c.email,
    name: c.name || c.full_name,
    hasMethod: !!(c.payment_methods?.length || c.default_payment_method),
    methodCount: c.payment_methods?.length || (c.default_payment_method ? 1 : 0),
  }));
}

module.exports = { charge, createSubscription, cancelSubscription, listCustomersWithMethods };
