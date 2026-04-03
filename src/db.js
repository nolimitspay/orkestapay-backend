const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DB_PATH || './data/orkestapay.json';

const DEFAULT_DATA = {
  gateways: [],
  payments: [],
  subscriptions: [],
  customers: [],
  shops: [],
  webhooks: [],
  pixels: [],
  emailTemplates: [
    {
      id: uuidv4(), name: 'Cart Recovery', subject: '¡Tu carrito te espera!',
      html: '<h1>Hola {{name}}, dejaste algo en tu carrito.</h1><p>Completa tu compra aquí: <a href="{{checkout_url}}">Finalizar pedido</a></p>',
      active: true, type: 'cart_recovery', updatedAt: new Date().toISOString()
    },
    {
      id: uuidv4(), name: 'Order Confirmation', subject: 'Pedido confirmado ✓',
      html: '<h1>¡Gracias por tu pedido, {{name}}!</h1><p>Tu pago de {{amount}} ha sido procesado correctamente.</p>',
      active: true, type: 'order_confirmation', updatedAt: new Date().toISOString()
    },
    {
      id: uuidv4(), name: 'Tracking Update', subject: 'Tu pedido está en camino #{{order_id}}',
      html: '<h1>Tu pedido está en camino</h1><p>Número de seguimiento: <strong>{{tracking_number}}</strong></p><p><a href="{{tracking_url}}">Seguir pedido</a></p>',
      active: true, type: 'tracking', updatedAt: new Date().toISOString()
    }
  ],
  webhookLogs: [],
  settings: { routing: 'percentage', retryAttempts: 5, retryBackoff: 'exponential' }
};

function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function read() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) return JSON.parse(JSON.stringify(DEFAULT_DATA));
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch (e) { return JSON.parse(JSON.stringify(DEFAULT_DATA)); }
}

function write(data) {
  ensureDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

const db = {
  init() {
    if (!fs.existsSync(DB_PATH)) {
      write(JSON.parse(JSON.stringify(DEFAULT_DATA)));
      console.log('✅ OrkestaPay DB initialized');
    }
  },

  // Generic CRUD
  getAll(table) { return read()[table] || []; },
  getById(table, id) { return (read()[table] || []).find(r => r.id === id); },
  insert(table, data) {
    const db = read();
    const record = { id: uuidv4(), createdAt: new Date().toISOString(), ...data };
    db[table] = [...(db[table] || []), record];
    write(db);
    return record;
  },
  update(table, id, data) {
    const store = read();
    store[table] = (store[table] || []).map(r => r.id === id ? { ...r, ...data, updatedAt: new Date().toISOString() } : r);
    write(store);
    return store[table].find(r => r.id === id);
  },
  delete(table, id) {
    const store = read();
    store[table] = (store[table] || []).filter(r => r.id !== id);
    write(store);
  },
  query(table, fn) { return (read()[table] || []).filter(fn); },
  getSetting(key) { return read().settings?.[key]; },
  setSetting(key, val) {
    const store = read();
    store.settings = { ...(store.settings || {}), [key]: val };
    write(store);
  }
};

module.exports = db;
