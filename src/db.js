/**
 * NoLimitsPay — db.js
 * 
 * Base de datos persistente.
 * 
 * PROBLEMA ANTERIOR: Usaba un archivo JSON local (./data/orkestapay.json)
 * que se borraba cada vez que Render reiniciaba el servidor.
 * 
 * SOLUCIÓN: Los datos críticos (pasarelas, usuarios, tiendas) se guardan
 * en variables de entorno en Render. El resto usa el archivo JSON como
 * caché en memoria con respaldo en disco cuando esté disponible.
 * 
 * CONFIGURACIÓN EN RENDER:
 * Ve a tu servicio en Render → Environment → Add Environment Variable:
 *   NLP_GATEWAYS  → (se rellena automáticamente al guardar)
 *   NLP_USERS     → (se rellena automáticamente al guardar)
 *   NLP_SHOPS     → (se rellena automáticamente al guardar)
 *   NLP_SETTINGS  → (se rellena automáticamente al guardar)
 */

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const PERSISTENT_COLLECTIONS = ['gateways', 'users', 'shops', 'settings'];
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/orkestapay.json');

const DEFAULT_DATA = {
  gateways: [],
  payments: [],
  subscriptions: [],
  customers: [],
  shops: [],
  webhooks: [],
  pixels: [],
  pendingOrders: [],
  checkoutSessions: [],
  emailTemplates: [
    { id: uuidv4(), name: 'Cart Recovery', subject: '¡Tu carrito te espera!', html: '<h1>Hola {{name}}, dejaste algo en tu carrito.</h1>', active: true, type: 'cart_recovery', updatedAt: new Date().toISOString() },
    { id: uuidv4(), name: 'Order Confirmation', subject: 'Pedido confirmado ✓', html: '<h1>¡Gracias por tu pedido, {{name}}!</h1><p>Tu pago de {{amount}} ha sido procesado.</p>', active: true, type: 'order_confirmation', updatedAt: new Date().toISOString() },
    { id: uuidv4(), name: 'Tracking Update', subject: 'Tu pedido está en camino #{{order_id}}', html: '<h1>Tu pedido está en camino</h1><p>Seguimiento: <strong>{{tracking_number}}</strong></p>', active: true, type: 'tracking', updatedAt: new Date().toISOString() }
  ],
  webhookLogs: [],
  settings: { routing: 'percentage', retryAttempts: 5, retryBackoff: 'exponential' }
};

let _data = null;

function loadFromEnv() {
  const loaded = {};
  for (const col of PERSISTENT_COLLECTIONS) {
    const envVal = process.env['NLP_' + col.toUpperCase()];
    if (envVal) {
      try {
        loaded[col] = JSON.parse(envVal);
        console.log(`[DB] Loaded ${col} from env`);
      } catch(e) { console.warn(`[DB] Bad env NLP_${col.toUpperCase()}`); }
    }
  }
  return loaded;
}

function saveToFile() {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(_data, null, 2), 'utf8');
  } catch(e) { /* Render ephemeral fs — not critical */ }
}

function persistToEnv(collection) {
  try {
    process.env['NLP_' + collection.toUpperCase()] = JSON.stringify(_data[collection]);
  } catch(e) {}
}

function ensureAdminUser() {
  if (!_data.users) _data.users = [];
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@nolimitspay.com';
  const adminPass  = process.env.ADMIN_PASSWORD || 'admin123';
  if (!_data.users.find(u => u.email === adminEmail)) {
    _data.users.push({ id: uuidv4(), email: adminEmail, password: adminPass, role: 'admin', name: 'Admin', createdAt: new Date().toISOString() });
  }
}

function init() {
  _data = JSON.parse(JSON.stringify(DEFAULT_DATA));
  // 1. Cargar desde archivo local si existe
  try {
    if (fs.existsSync(DB_PATH)) {
      _data = { ..._data, ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
      console.log('[DB] Loaded from file');
    }
  } catch(e) { console.warn('[DB] No local file, using defaults'); }
  // 2. Variables de entorno tienen prioridad (sobreviven reinicios)
  Object.assign(_data, loadFromEnv());
  // 3. Asegurar admin
  ensureAdminUser();
  console.log('[DB] Ready — gateways:', _data.gateways.length, '| shops:', _data.shops.length, '| users:', _data.users.length);
  return _data;
}

function getAll(collection) {
  if (!_data) init();
  return _data[collection] || [];
}

function getById(collection, id) {
  return getAll(collection).find(i => i.id === id) || null;
}

function insert(collection, item) {
  if (!_data) init();
  if (!_data[collection]) _data[collection] = [];
  const newItem = { id: uuidv4(), createdAt: new Date().toISOString(), ...item };
  _data[collection].push(newItem);
  if (PERSISTENT_COLLECTIONS.includes(collection)) { persistToEnv(collection); saveToFile(); }
  return newItem;
}

function update(collection, id, updates) {
  if (!_data) init();
  const idx = (_data[collection] || []).findIndex(i => i.id === id);
  if (idx === -1) return null;
  _data[collection][idx] = { ..._data[collection][idx], ...updates, updatedAt: new Date().toISOString() };
  if (PERSISTENT_COLLECTIONS.includes(collection)) { persistToEnv(collection); saveToFile(); }
  return _data[collection][idx];
}

function remove(collection, id) {
  if (!_data) init();
  if (!_data[collection]) return false;
  const before = _data[collection].length;
  _data[collection] = _data[collection].filter(i => i.id !== id);
  const removed = _data[collection].length < before;
  if (removed && PERSISTENT_COLLECTIONS.includes(collection)) { persistToEnv(collection); saveToFile(); }
  return removed;
}

function getSetting(key) {
  if (!_data) init();
  return (_data.settings || {})[key];
}

function setSetting(key, value) {
  if (!_data) init();
  if (!_data.settings) _data.settings = {};
  _data.settings[key] = value;
  persistToEnv('settings');
  saveToFile();
  return value;
}

function exportForEnv() {
  const out = {};
  for (const col of PERSISTENT_COLLECTIONS) {
    out['NLP_' + col.toUpperCase()] = JSON.stringify(_data[col] || (col === 'settings' ? {} : []));
  }
  return out;
}

module.exports = { init, getAll, getById, insert, update, delete: remove, getSetting, setSetting, exportForEnv };
