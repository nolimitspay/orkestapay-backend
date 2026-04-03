/**
 * OrkestaPay - Square Integration
 * Docs: https://developer.squareup.com/docs
 */

const { v4: uuidv4 } = require('uuid');

function getSquareClient(credentials) {
  const { Client, Environment } = require('square');
  const token = credentials?.accessToken || process.env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error('Square access token not configured');

  const env = (credentials?.environment || process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase();
  return new Client({
    accessToken: token,
    environment: env === 'sandbox' ? Environment.Sandbox : Environment.Production,
  });
}

/**
 * Charge a Square customer (one-time)
 */
async function charge({ amount, currency, customerId, paymentMethodId, description, metadata, credentials }) {
  const client = getSquareClient(credentials);
  const locationId = credentials?.locationId || process.env.SQUARE_LOCATION_ID;
  if (!locationId) throw new Error('Square location ID not configured');

  const amountMoney = { amount: BigInt(Math.round(amount * 100)), currency: currency.toUpperCase() };

  const body = {
    sourceId: paymentMethodId || customerId,
    idempotencyKey: uuidv4(),
    amountMoney,
    locationId,
    note: description,
    referenceId: metadata?.orderId,
    customerId,
  };

  const { result, statusCode } = await client.paymentsApi.createPayment(body);

  if (statusCode !== 200 || result.payment?.status !== 'COMPLETED') {
    throw new Error(`Square payment failed: ${result.errors?.[0]?.detail || 'Unknown error'}`);
  }

  return { id: result.payment.id, status: result.payment.status };
}

/**
 * Create Square subscription
 */
async function createSubscription({ customerId, amount, currency, interval, intervalCount, trialDays, metadata, credentials }) {
  const client = getSquareClient(credentials);
  const locationId = credentials?.locationId || process.env.SQUARE_LOCATION_ID;

  // First create a catalog plan (simplified)
  const cadenceMap = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'ANNUAL' };
  const cadence = cadenceMap[interval] || 'MONTHLY';

  const planBody = {
    idempotencyKey: uuidv4(),
    object: {
      type: 'SUBSCRIPTION_PLAN',
      id: `#plan_${uuidv4().replace(/-/g, '')}`,
      subscriptionPlanData: {
        name: metadata?.planName || 'OrkestaPay Plan',
        phases: [{
          cadence,
          periods: intervalCount || 1,
          recurringPriceMoney: { amount: BigInt(Math.round(amount * 100)), currency: currency.toUpperCase() },
        }],
      },
    },
  };

  const { result: planResult } = await client.catalogApi.upsertCatalogObject(planBody);
  const planId = planResult.catalogObject?.id;

  const startDate = new Date();
  if (trialDays) startDate.setDate(startDate.getDate() + trialDays);

  const subBody = {
    idempotencyKey: uuidv4(),
    locationId,
    planId,
    customerId,
    startDate: startDate.toISOString().split('T')[0],
  };

  const { result: subResult } = await client.subscriptionsApi.createSubscription(subBody);

  const nextDate = subResult.subscription?.chargedThroughDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return { id: subResult.subscription?.id, status: subResult.subscription?.status, nextBillingDate: nextDate };
}

/**
 * Cancel Square subscription
 */
async function cancelSubscription({ externalId, credentials }) {
  const client = getSquareClient(credentials);
  await client.subscriptionsApi.cancelSubscription(externalId);
}

/**
 * List Square customers with cards (for batch)
 */
async function listCustomersWithMethods({ credentials }) {
  const client = getSquareClient(credentials);
  const { result } = await client.customersApi.listCustomers({ sortOrder: 'DESC' });
  const customers = result.customers || [];

  return customers.map(c => ({
    id: c.id,
    email: c.emailAddress,
    name: `${c.givenName || ''} ${c.familyName || ''}`.trim(),
    hasMethod: !!(c.cards && c.cards.length > 0),
    methodCount: c.cards?.length || 0,
  }));
}

module.exports = { charge, createSubscription, cancelSubscription, listCustomersWithMethods };
