/**
 * OrkestaPay - Webhook Delivery Service
 * Dispatches events to configured endpoints with exponential backoff retries
 */

const axios = require('axios');
const crypto = require('crypto');
const db = require('../db');
const { logger } = require('../utils/logger');

const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1000;

function sign(payload) {
  const secret = process.env.WEBHOOK_SECRET || 'orkestapay-secret';
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

async function deliverToEndpoint(hook, event, payload, attempt = 0) {
  try {
    const signature = sign(payload);
    await axios.post(hook.url, payload, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'X-OrkestaPay-Event': event,
        'X-OrkestaPay-Signature': signature,
        'X-OrkestaPay-Attempt': attempt + 1,
      },
    });

    db.insert('webhookLogs', {
      webhookId: hook.id, event, status: 'delivered',
      attempt: attempt + 1, responseCode: 200,
    });
    logger.info(`Webhook delivered: ${event} → ${hook.url}`);

  } catch (err) {
    const status = err.response?.status || 0;
    db.insert('webhookLogs', {
      webhookId: hook.id, event, status: 'failed',
      attempt: attempt + 1, responseCode: status, error: err.message,
    });

    if (attempt < MAX_RETRIES - 1) {
      const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
      logger.warn(`Webhook failed (attempt ${attempt + 1}), retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      return deliverToEndpoint(hook, event, payload, attempt + 1);
    } else {
      logger.error(`Webhook permanently failed after ${MAX_RETRIES} attempts: ${event} → ${hook.url}`);
    }
  }
}

async function dispatch(event, data) {
  const hooks = db.query('webhooks', h => h.active && (h.events.includes(event) || h.events.includes('*')));
  if (!hooks.length) return;

  const payload = {
    id: require('uuid').v4(),
    event,
    created: new Date().toISOString(),
    data,
  };

  await Promise.allSettled(hooks.map(h => deliverToEndpoint(h, event, payload)));
}

module.exports = { dispatch, sign };
