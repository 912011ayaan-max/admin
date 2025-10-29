// Simple License Server (Node.js/Express)
// NOTE: For production, move licenses.json OUTSIDE any static web root.

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose');

const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // Change in production
const DATA_DIR = path.join(__dirname, 'server_data');
const DATA_FILE = path.join(DATA_DIR, 'licenses.json');
const MONGODB_URI = process.env.MONGODB_URI || '';

// --- Data layer: MongoDB (preferred) or JSON fallback ---
let useMongo = false;

if (MONGODB_URI) {
  useMongo = true;
  mongoose.set('strictQuery', true);
  mongoose
    .connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => {
      console.error('MongoDB connection failed, falling back to JSON storage:', err.message);
      useMongo = false;
    });
}

if (!useMongo) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ customers: [] }, null, 2));
}

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch (e) { return { customers: [] }; }
}
function writeData(obj) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
}

function genId(prefix='id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}
function genLicenseKey() {
  function block() { return Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4).padEnd(4,'X'); }
  return `LIC-${block()}-${block()}-${block()}-${block()}`;
}
function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}
function isExpired(iso) {
  return new Date(iso).getTime() <= Date.now();
}

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE'], allowedHeaders: ['Content-Type','X-Admin-Auth'] }));
app.use(express.json());

// Simple admin auth middleware
function requireAdmin(req, res, next) {
  const hdr = req.headers['x-admin-auth'];
  if (!hdr || hdr !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// --- Mongo models ---
let CustomerModel;
if (useMongo) {
  const ActivationSchema = new mongoose.Schema({
    deviceId: { type: String, required: true },
    activatedAt: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now }
  }, { _id: false });

  const CustomerSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true },
    licenseKey: { type: String, required: true, unique: true, index: true },
    status: { type: String, default: 'active' },
    maxDevices: { type: Number, default: 2 },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    activations: { type: [ActivationSchema], default: [] }
  });

  CustomerModel = mongoose.model('Customer', CustomerSchema);
}

async function mongoCreateCustomer({ name, email, months, maxDevices }) {
  const expiresAt = new Date(addMonths(new Date().toISOString(), Number(months) || 6));
  const doc = await CustomerModel.create({ name, email, licenseKey: genLicenseKey(), status: 'active', maxDevices, expiresAt });
  return doc;
}
async function mongoListCustomers() {
  const docs = await CustomerModel.find({}).sort({ createdAt: -1 }).lean();
  return docs.map(d => ({ ...d, id: String(d._id) }));
}
async function mongoFindById(id) {
  return await CustomerModel.findById(id);
}
async function mongoFindByLicense(licenseKey) {
  return await CustomerModel.findOne({ licenseKey });
}
async function mongoSave(doc) { await doc.save(); }

// Create customer & license
app.post('/api/customers', requireAdmin, (req, res) => {
  (async () => {
    const { name, email, months = 6, maxDevices = 2 } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });
    try {
      if (useMongo) {
        const doc = await mongoCreateCustomer({ name, email, months, maxDevices });
        const out = doc.toObject();
        out.id = String(doc._id);
        return res.json(out);
      } else {
        const db = readData();
        const customer = {
          id: genId('cust'), name, email, licenseKey: genLicenseKey(), status: 'active', maxDevices,
          createdAt: new Date().toISOString(), expiresAt: addMonths(new Date().toISOString(), Number(months) || 6), activations: []
        };
        db.customers.push(customer);
        writeData(db);
        return res.json(customer);
      }
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'create failed' });
    }
  })();
});

// List customers
app.get('/api/customers', requireAdmin, (req, res) => {
  (async () => {
    if (useMongo) {
      const customers = await mongoListCustomers();
      return res.json({ customers });
    } else {
      const db = readData();
      return res.json({ customers: db.customers });
    }
  })();
});

// Renew expiry
app.put('/api/customers/:id/renew', requireAdmin, (req, res) => {
  (async () => {
    const { months = 3 } = req.body || {};
    if (useMongo) {
      const c = await mongoFindById(req.params.id);
      if (!c) return res.status(404).json({ error: 'not found' });
      const baseDate = isExpired(c.expiresAt) ? new Date().toISOString() : c.expiresAt;
      c.expiresAt = addMonths(baseDate, Number(months) || 3);
      await mongoSave(c);
      const out = c.toObject(); out.id = String(c._id);
      return res.json(out);
    } else {
      const db = readData();
      const c = db.customers.find(x => x.id === req.params.id);
      if (!c) return res.status(404).json({ error: 'not found' });
      const baseDate = isExpired(c.expiresAt) ? new Date().toISOString() : c.expiresAt;
      c.expiresAt = addMonths(baseDate, Number(months) || 3);
      writeData(db);
      return res.json(c);
    }
  })();
});

// Ban / Unban
app.put('/api/customers/:id/ban', requireAdmin, (req, res) => {
  (async () => {
    const { banned = true } = req.body || {};
    if (useMongo) {
      const c = await mongoFindById(req.params.id);
      if (!c) return res.status(404).json({ error: 'not found' });
      c.status = banned ? 'banned' : (isExpired(c.expiresAt) ? 'expired' : 'active');
      await mongoSave(c);
      const out = c.toObject(); out.id = String(c._id);
      return res.json(out);
    } else {
      const db = readData();
      const c = db.customers.find(x => x.id === req.params.id);
      if (!c) return res.status(404).json({ error: 'not found' });
      c.status = banned ? 'banned' : (isExpired(c.expiresAt) ? 'expired' : 'active');
      writeData(db);
      return res.json(c);
    }
  })();
});

// Activate license for a device
app.post('/api/licenses/activate', (req, res) => {
  (async () => {
    const { licenseKey, deviceId } = req.body || {};
    if (!licenseKey || !deviceId) return res.status(400).json({ error: 'licenseKey and deviceId required' });
    if (useMongo) {
      const c = await mongoFindByLicense(licenseKey);
      if (!c) return res.status(404).json({ status: 'invalid', error: 'invalid license' });
      if (c.status === 'banned') return res.status(403).json({ status: 'banned' });
      if (isExpired(c.expiresAt)) {
        c.status = 'expired';
        await mongoSave(c);
        return res.status(403).json({ status: 'expired', expiresAt: c.expiresAt });
      }
      const existing = (c.activations || []).find(a => a.deviceId === deviceId);
      if (!existing) {
        if ((c.activations?.length || 0) >= c.maxDevices) {
          return res.status(403).json({ status: 'limit_exceeded', maxDevices: c.maxDevices });
        }
        c.activations.push({ deviceId, activatedAt: new Date().toISOString(), lastSeen: new Date().toISOString() });
      } else {
        existing.lastSeen = new Date().toISOString();
      }
      c.status = 'active';
      await mongoSave(c);
      return res.json({ status: 'active', expiresAt: c.expiresAt, deviceId, customerName: c.name });
    } else {
      const db = readData();
      const c = db.customers.find(x => x.licenseKey === licenseKey);
      if (!c) return res.status(404).json({ status: 'invalid', error: 'invalid license' });
      if (c.status === 'banned') return res.status(403).json({ status: 'banned' });
      if (isExpired(c.expiresAt)) {
        c.status = 'expired';
        writeData(db);
        return res.status(403).json({ status: 'expired', expiresAt: c.expiresAt });
      }
      const existing = c.activations.find(a => a.deviceId === deviceId);
      if (!existing) {
        if ((c.activations?.length || 0) >= c.maxDevices) {
          return res.status(403).json({ status: 'limit_exceeded', maxDevices: c.maxDevices });
        }
        c.activations.push({ deviceId, activatedAt: new Date().toISOString(), lastSeen: new Date().toISOString() });
      } else {
        existing.lastSeen = new Date().toISOString();
      }
      c.status = 'active';
      writeData(db);
      return res.json({ status: 'active', expiresAt: c.expiresAt, deviceId, customerName: c.name });
    }
  })();
});

// Verify license status
app.get('/api/licenses/verify', (req, res) => {
  (async () => {
    const licenseKey = req.query.key;
    const deviceId = req.query.deviceId;
    if (!licenseKey || !deviceId) return res.status(400).json({ error: 'key and deviceId required' });
    if (useMongo) {
      const c = await mongoFindByLicense(licenseKey);
      if (!c) return res.status(404).json({ status: 'invalid' });
      const activation = (c.activations || []).find(a => a.deviceId === deviceId);
      if (!activation) return res.status(403).json({ status: 'not_activated' });
      activation.lastSeen = new Date().toISOString();
      let status = c.status;
      if (status !== 'banned') status = isExpired(c.expiresAt) ? 'expired' : 'active';
      c.status = status;
      await mongoSave(c);
      return res.json({ status, expiresAt: c.expiresAt });
    } else {
      const db = readData();
      const c = db.customers.find(x => x.licenseKey === licenseKey);
      if (!c) return res.status(404).json({ status: 'invalid' });
      const activation = c.activations.find(a => a.deviceId === deviceId);
      if (!activation) return res.status(403).json({ status: 'not_activated' });
      activation.lastSeen = new Date().toISOString();
      let status = c.status;
      if (status !== 'banned') status = isExpired(c.expiresAt) ? 'expired' : 'active';
      c.status = status;
      writeData(db);
      return res.json({ status, expiresAt: c.expiresAt });
    }
  })();
});

app.listen(PORT, () => {
  console.log(`License server running on http://localhost:${PORT}`);
});