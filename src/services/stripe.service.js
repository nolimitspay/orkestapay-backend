/**
 * OrkestaPay - Stripe Integration
 * Docs: https://stripe.com/docs/api
 */

function getStripe(credentials) {
  const Stripe = require('stripe');
  const key = credentials?.secretKey || process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Stripe secret key not configured');
  return new Stripe(key, { apiVersion: '2023-10-16' });
}

/**
 * Create or retrieve a Stripe customer
 */
async function createOrGetCustomer({ email, name, metadata, credentials }) {
  const stripe = getStripe(credentials);
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length > 0) return existing.data[0];
  return stripe.customers.create({ email, name, metadata });
}

/**
 * Charge a customer (one-time)
 */
async function charge({ amount, currency, customerId, paymentMethodId, description, metadata, credentials }) {
  const stripe = getStripe(credentials);
  const amountCents = Math.round(amount * 100);

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: currency.toLowerCase(),
    customer: customerId,
    payment_method: paymentMethodId,
    confirm: true,
    off_session: true,
    description,
    metadata: metadata || {},
  });

  if (paymentIntent.status !== 'succeeded') {
    throw new Error(`Stripe payment intent status: ${paymentIntent.status}`);
  }

  return { id: paymentIntent.id, status: paymentIntent.status };
}

/**
 * Create a subscription (recurring billing)
 */
async function createSubscription({ customerId, planId, amount, currency, interval, intervalCount, trialDays, metadata, credentials }) {
  const stripe = getStripe(credentials);

  // Create or retrieve price
  let price;
  if (planId) {
    price = await stripe.prices.retrieve(planId);
  } else {
    // Create product + price dynamically
    const product = await stripe.products.create({
      name: metadata?.productName || 'OrkestaPay Subscription',
      metadata: metadata || {},
    });
    price = await stripe.prices.create({
      unit_amount: Math.round(amount * 100),
      currency: currency.toLowerCase(),
      recurring: { interval: interval || 'month', interval_count: intervalCount || 1 },
      product: product.id,
    });
  }

  const subData = {
    customer: customerId,
    items: [{ price: price.id }],
    metadata: metadata || {},
  };
  if (trialDays) subData.trial_period_days = trialDays;

  const subscription = await stripe.subscriptions.create(subData);

  const nextDate = new Date(subscription.current_period_end * 1000).toISOString();
  return { id: subscription.id, status: subscription.status, nextBillingDate: nextDate };
}

/**
 * Cancel a subscription
 */
async function cancelSubscription({ externalId, credentials }) {
  const stripe = getStripe(credentials);
  await stripe.subscriptions.cancel(externalId);
}

/**
 * List customers with saved payment methods (for batch)
 */
async function listCustomersWithMethods({ dateFrom, dateTo, credentials }) {
  const stripe = getStripe(credentials);
  const params = { limit: 100 };
  if (dateFrom) params.created = { gte: Math.floor(new Date(dateFrom).getTime() / 1000) };
  if (dateTo) params.created = { ...params.created, lte: Math.floor(new Date(dateTo).getTime() / 1000) };

  const customers = await stripe.customers.list(params);
  const result = [];
  for (const c of customers.data) {
    const methods = await stripe.paymentMethods.list({ customer: c.id, type: 'card' });
    result.push({ id: c.id, email: c.email, name: c.name, hasMethod: methods.data.length > 0, methodCount: methods.data.length });
  }
  return result;
}

/**
 * Construct and verify Stripe webhook
 */
function constructWebhookEvent(payload, signature) {
  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

module.exports = { charge, createSubscription, cancelSubscription, createOrGetCustomer, listCustomersWithMethods, constructWebhookEvent };
