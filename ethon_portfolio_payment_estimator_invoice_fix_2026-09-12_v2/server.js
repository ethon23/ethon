import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const PORT = 3000;
const SESSION_TTL = 28800; // 8 hours

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });

function envv(key, fallback = '') {
  const val = process.env[key];
  return val === undefined || val === null ? fallback : String(val);
}

function getStoredAdminHash() {
  try {
    const local = readJsonFile(DATA_FILE, {});
    return local?.settings?.adminPasswordHash || '';
  } catch { return ''; }
}

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPasswordHash(password, encoded) {
  try {
    const [algo, salt, expected] = String(encoded || '').split('$');
    if (algo !== 'scrypt' || !salt || !expected) return false;
    const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

function currentAdminPassword() {
  const stored = getStoredAdminHash();
  return stored ? null : envv('ADMIN_PASSWORD', 'admin123');
}

function adminSecret() {
  const stored = getStoredAdminHash();
  const base = envv('APP_SECRET', '');
  return crypto.createHash('sha256').update(base + '|ethon-cms-secret|' + (stored || envv('ADMIN_PASSWORD', 'admin123'))).digest('hex');
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payloadStr, secret) {
  const b64 = base64url(payloadStr);
  const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  try {
    const rawPayload = Buffer.from(parts[0], 'base64url').toString('utf8');
    const expectedSig = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expectedSig))) return false;
    const data = JSON.parse(rawPayload);
    return Boolean(data && data.exp && data.exp > Math.floor(Date.now() / 1000));
  } catch {
    return false;
  }
}

// In-memory rate limiter
const rateLimits = new Map();
function checkRateLimit(bucket, ip, limit, windowSec = 60) {
  const key = `${bucket}|${ip}`;
  const now = Math.floor(Date.now() / 1000);
  let timestamps = rateLimits.get(key) || [];
  timestamps = timestamps.filter(t => now - t < windowSec);
  if (timestamps.length >= limit) {
    return false;
  }
  timestamps.push(now);
  rateLimits.set(key, timestamps);
  return true;
}

function rateLimitMiddleware(bucket, limit, windowSec = 60) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || '0.0.0.0';
    if (!checkRateLimit(bucket, ip, limit, windowSec)) {
      res.setHeader('Retry-After', String(windowSec));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    next();
  };
}

function readJsonFile(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function atomicJsonWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function supabaseEnabled() {
  return Boolean(envv('SUPABASE_URL') && envv('SUPABASE_SERVICE_ROLE_KEY'));
}

async function supabaseRequest(endpoint, method = 'GET', body = null, extraHeaders = []) {
  const url = envv('SUPABASE_URL').replace(/\/+$/, '') + endpoint;
  const headers = {
    'apikey': envv('SUPABASE_SERVICE_ROLE_KEY'),
    'Authorization': `Bearer ${envv('SUPABASE_SERVICE_ROLE_KEY')}`,
    'Content-Type': 'application/json',
  };
  for (const h of extraHeaders) {
    const [k, v] = h.split(': ');
    if (k && v) headers[k] = v;
  }
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${await resp.text()}`);
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

function defaultState() {
  const projects = readJsonFile(path.join(ROOT, 'seed-projects.json'), []);
  const tests = readJsonFile(path.join(ROOT, 'seed-testimonials.json'), []);
  const local = readJsonFile(DATA_FILE, {});
  return {
    projects: Array.isArray(local.projects) ? local.projects : (Array.isArray(projects) ? projects : []),
    testimonials: Array.isArray(local.testimonials) ? local.testimonials : (Array.isArray(tests) ? tests : []),
    messages: Array.isArray(local.messages) ? local.messages : [],
    conversations: Array.isArray(local.conversations) ? local.conversations : [],
    settings: (local.settings && typeof local.settings === 'object' && !Array.isArray(local.settings)) ? local.settings : {}
  };
}

let dbCache = null;

function loadDb() {
  if (dbCache) return dbCache;
  const local = defaultState();
  dbCache = local;
  return dbCache;
}

function saveDb(db) {
  dbCache = db;
  try {
    atomicJsonWrite(DATA_FILE, db);
  } catch (err) {
    console.error('Error saving data.json:', err);
  }

  if (supabaseEnabled()) {
    const payload = { id: 1, data: db, updated_at: new Date().toISOString() };
    supabaseRequest('/rest/v1/cms_state?id=eq.1', 'PATCH', payload, ['Prefer: return=minimal'])
      .catch(err => console.error('Supabase save error:', err));
  }
}

function publicSettings(s) {
  const copy = { ...s };
  const sensitive = [
    'paymentBank', 'paymentAccountName', 'paymentAccount', 'paymentSwift',
    'paymentRouting', 'paymentBankLabel', 'paymentAccountNameLabel',
    'paymentAccountLabel', 'paymentSwiftLabel', 'paymentRoutingLabel'
  ];
  for (const k of sensitive) {
    delete copy[k];
  }
  return copy;
}

function uploadDataUrl(data, origName = 'media') {
  const match = data.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw new Error('Invalid upload format.');
  const mime = match[1].toLowerCase();
  const allowed = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
    'application/x-rar-compressed': 'rar',
    'application/vnd.rar': 'rar',
    'text/plain': 'txt',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
  };
  if (!allowed[mime]) throw new Error('Unsupported file type.');
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 10 * 1024 * 1024) throw new Error('File must be under 10MB.');

  const safe = (origName || 'media').replace(/[^A-Za-z0-9._-]+/g, '-');
  const ext = allowed[mime];
  const finalName = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}-${safe.endsWith('.' + ext) ? safe : safe + '.' + ext}`;
  const filePath = path.join(UPLOAD_DIR, finalName);
  fs.writeFileSync(filePath, buf);
  return `/uploads/${finalName}`;
}

function reorder(list, ids) {
  const map = new Map();
  for (const item of list) {
    map.set(String(item.id || ''), item);
  }
  const out = [];
  for (const id of ids) {
    const k = String(id);
    if (map.has(k)) {
      out.push(map.get(k));
      map.delete(k);
    }
  }
  for (const remaining of map.values()) {
    out.push(remaining);
  }
  return out;
}

function newId() {
  return crypto.randomBytes(10).toString('hex');
}

const app = express();

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(cookieParser());

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Admin Authentication check
function isAdmin(req) {
  const token = req.cookies?.ethon_admin;
  if (!token) return false;
  return verifyToken(token, adminSecret());
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Health check
app.get(['/health', '/api/health'], (req, res) => {
  res.json({ ok: true, service: 'ethon-cms', chat: true, storage: supabaseEnabled() ? 'supabase' : 'local' });
});

// Public API
app.get('/api/public', (req, res) => {
  const db = loadDb();
  res.json({
    projects: (db.projects || []).filter(x => x.published !== false),
    testimonials: (db.testimonials || []).filter(x => x.published !== false),
    settings: publicSettings(db.settings || {})
  });
});

// Analytics tracking
app.post('/api/track/visit', rateLimitMiddleware('visit', 60, 60), (req, res) => {
  const db = loadDb();
  db.settings = db.settings || {};
  db.settings.visitorCount = (Number(db.settings.visitorCount) || 0) + 1;
  db.settings.profileViews = (Number(db.settings.profileViews) || 0) + 1;
  const history = Array.isArray(db.settings.visitorHistory) ? db.settings.visitorHistory : [];
  history.push({ at: new Date().toISOString(), count: db.settings.visitorCount });
  db.settings.visitorHistory = history.slice(-30);
  saveDb(db);
  res.json({ visitorCount: db.settings.visitorCount, profileViews: db.settings.profileViews });
});

app.get('/api/track/cv', (req, res) => {
  const db = loadDb();
  db.settings = db.settings || {};
  db.settings.cvDownloads = (Number(db.settings.cvDownloads) || 0) + 1;
  saveDb(db);
  res.redirect(302, '/assets/ui_ux_cv.pdf');
});

async function sendPaymentVoucherEmail({to, name, voucherUrl, voucherNo, amount, currency, method, service}) {
  const apiKey = envv('RESEND_API_KEY', '').trim();
  const from = envv('RESEND_FROM_EMAIL', '').trim();
  if (!apiKey || !from || !to) return { sent: false, skipped: true };
  const safe = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#090812;color:#222;padding:28px"><div style="max-width:620px;margin:auto;background:#fff;border-radius:18px;padding:28px"><h2 style="margin:0 0 8px">Payment voucher ready</h2><p>Hello ${safe(name)}, your payment request has been recorded.</p><p><b>Amount:</b> ${safe(amount)} ${safe(currency)}<br><b>Payment method:</b> ${safe(method)}<br><b>Service:</b> ${safe(service)}<br><b>Voucher:</b> ${safe(voucherNo)}</p><p style="margin:24px 0"><a href="${safe(voucherUrl)}" style="display:inline-block;background:#7b3ff2;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">View / Download Voucher</a></p><p style="color:#777;font-size:12px">Keep this link for your payment request record.</p></div></body></html>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: {'Authorization': `Bearer ${apiKey}`, 'Content-Type':'application/json'},
      body: JSON.stringify({from, to:[to], subject:`Payment Voucher ${voucherNo}`, html})
    });
    const data = await r.json().catch(()=>({}));
    if (!r.ok) return { sent:false, error:data?.message || 'Email provider rejected the request.' };
    return { sent:true, id:data?.id || '' };
  } catch (err) { return { sent:false, error:err?.message || 'Email delivery failed.' }; }
}

function paymentGatewayUrl(db, method, currency, amount) {
  const m = String(method || '').trim().toUpperCase();
  const c = String(currency || 'USD').trim().toUpperCase();
  const keyMap = { 'STRIPE':'paymentStripeUrl','PAYPAL':'paymentPaypalUrl','PAYONEER':'paymentPayoneerUrl','GOOGLE PAY':'paymentGooglePayUrl','BINANCE PAY':'paymentBinanceUrl','BKASH':'paymentBkashUrl' };
  const generic = String(db.settings?.[keyMap[m]] || '').trim();
  let map = {};
  try { map = typeof db.settings?.paymentGatewayCurrencyUrls === 'string' ? JSON.parse(db.settings.paymentGatewayCurrencyUrls || '{}') : (db.settings?.paymentGatewayCurrencyUrls || {}); } catch { map = {}; }
  const selected = String(map?.[m]?.[c] || map?.[m]?.[c.toLowerCase()] || '').trim() || generic;
  return selected.replace(/\{currency\}/gi,c).replace(/\{amount\}/gi,String(amount));
}

function paymentGatewayUrls(db, methods, currency, amount) {
  const list = Array.isArray(methods) ? methods : [methods];
  const out = [];
  for (const method of list) {
    const m = String(method || '').trim().toUpperCase();
    if (!m) continue;
    const url = paymentGatewayUrl(db, m, currency, amount);
    out.push({ method: m, url });
  }
  return out;
}

// Contact form
app.post('/api/contact', rateLimitMiddleware('contact', 8, 300), (req, res) => {
  const { name = '', email = '', phone = '', service = '', budget = '', message = '' } = req.body || {};
  const tName = String(name).trim();
  const tEmail = String(email).trim();
  const tMsg = String(message).trim();

  if (!tName || !tEmail.includes('@') || !tMsg) {
    return res.status(400).json({ error: 'Valid name, email and message are required.' });
  }
  if (tMsg.length > 5000) {
    return res.status(400).json({ error: 'Message is too long.' });
  }

  const now = new Date().toISOString();
  const db = loadDb();
  const msgObj = {
    id: newId(),
    name: tName.slice(0, 120),
    email: tEmail.slice(0, 180),
    phone: String(phone).slice(0, 60),
    service: String(service).slice(0, 120),
    budget: String(budget).slice(0, 80),
    message: tMsg,
    createdAt: now,
    read: false
  };

  const voucherNo = `ETH-PV-${now.slice(0,10).replace(/-/g,'')}-${String(msgObj.id).slice(-6).toUpperCase()}`;
  msgObj.voucherNo = voucherNo;
  msgObj.gatewayUrl = '';

  db.messages = db.messages || [];
  db.messages.unshift(msgObj);

  db.conversations = db.conversations || [];
  let conv = db.conversations.find(c => String(c.email || '').toLowerCase() === tEmail.toLowerCase());
  if (!conv) {
    conv = {
      id: newId(),
      name: tName,
      email: tEmail,
      createdAt: now,
      updatedAt: now,
      messages: [],
      source: 'contact'
    };
    db.conversations.push(conv);
  }
  conv.messages = conv.messages || [];
  conv.messages.push({
    id: newId(),
    from: 'visitor',
    channel: 'contact',
    text: tMsg,
    createdAt: now
  });
  conv.updatedAt = now;

  saveDb(db);
  res.status(201).json({ ok: true });
});

// Payment request
app.post('/api/payment', rateLimitMiddleware('payment', 8, 300), (req, res) => {
  const { name = '', email = '', phone = '', service = '', amount = 0, currency = 'USD', method = '', methods = [], message = '', estimator = null } = req.body || {};
  const tName = String(name).trim();
  const tEmail = String(email).trim();
  const numAmount = Number(amount) || 0;
  const chosenMethods = [...new Set((Array.isArray(methods) && methods.length ? methods : [method]).map(x => String(x || '').trim().toUpperCase()).filter(Boolean))];
  const tMethod = chosenMethods.join(', ');

  if (!tName || !tEmail.includes('@') || numAmount <= 0 || !chosenMethods.length) {
    return res.status(400).json({ error: 'Name, email, amount and at least one payment method are required.' });
  }

  const currRaw = String(currency || 'USD').trim().toUpperCase();
  const curr = ['USD','GBP','EUR','BDT'].includes(currRaw) ? currRaw : 'USD';
  const now = new Date().toISOString();
  const db = loadDb();

  const msgText = `Payment request · ${tMethod} · ${numAmount} ${curr}${message ? ' · ' + String(message).trim() : ''}`;
  const msgObj = {
    id: newId(),
    name: tName,
    email: tEmail,
    phone: String(phone).slice(0, 60),
    service: String(service).slice(0, 120),
    amount: numAmount,
    currency: curr,
    budget: `${numAmount} ${curr}`,
    message: msgText,
    createdAt: now,
    read: false,
    type: 'payment',
    paymentMethod: tMethod,
    paymentMethods: chosenMethods,
    gatewayUrls,
    estimator: estimator && typeof estimator === 'object' ? estimator : null,
    status: 'pending'
  };

  const gatewayUrls = paymentGatewayUrls(db, chosenMethods, curr, numAmount);
  const gatewayUrl = gatewayUrls.find(x => x.url)?.url || '';
  const voucherNo = `ETH-PV-${now.slice(0,10).replace(/-/g,'')}-${String(msgObj.id).slice(-6).toUpperCase()}`;
  msgObj.voucherNo = voucherNo;
  msgObj.gatewayUrl = gatewayUrl;

  db.messages = db.messages || [];
  db.messages.unshift(msgObj);

  db.conversations = db.conversations || [];
  let conv = db.conversations.find(c => String(c.email || '').toLowerCase() === tEmail.toLowerCase());
  if (!conv) {
    conv = {
      id: newId(),
      name: tName,
      email: tEmail,
      createdAt: now,
      updatedAt: now,
      messages: [],
      source: 'payment'
    };
    db.conversations.push(conv);
  }
  conv.messages = conv.messages || [];
  const publicOrigin = `${req.protocol}://${req.get('host')}`;
  const voucherUrl = `${publicOrigin}/payment-voucher.html?id=${encodeURIComponent(msgObj.id)}`;
  const invoiceUrl = `${publicOrigin}/invoice.html?id=${encodeURIComponent(msgObj.id)}`;
  conv.messages.push({
    id: newId(),
    from: 'visitor',
    channel: 'payment',
    text: `${msgText} · Voucher ${voucherNo}`,
    voucherUrl,
    createdAt: now
  });
  conv.updatedAt = now;

  saveDb(db);
  sendPaymentVoucherEmail({to:tEmail, name:tName, voucherUrl, voucherNo, amount:numAmount, currency:curr, method:tMethod, service:String(service).slice(0,120)})
    .then(result => { if (!result.sent && !result.skipped) console.warn('Payment voucher email:', result.error); })
    .catch(err => console.warn('Payment voucher email:', err?.message || err));
  res.status(201).json({
    ok: true,
    paymentRequestId: msgObj.id,
    voucherNo,
    voucherUrl: `/payment-voucher.html?id=${encodeURIComponent(msgObj.id)}`,
    invoiceUrl: `/invoice.html?id=${encodeURIComponent(msgObj.id)}`,
    gatewayUrl: msgObj.gatewayUrl,
    gatewayUrls
  });
});

// Public, read-only voucher verification data.
app.get('/api/payment/:id', (req, res) => {
  const demoId = 'DEMO-PAYMENT-VOUCHER';
  if (String(req.params.id) === demoId) {
    return res.json({
      voucherNo: 'ETH-PV-DEMO-0001', paymentRequestId: demoId, status: 'pending',
      name: 'Demo Client', email: 'demo@example.com', phone: '+880 1XXX XXXXXX',
      service: 'UI/UX Design', amount: 750, currency: 'USD', paymentMethod: 'STRIPE', paymentMethods: ['STRIPE'], gatewayUrls: [], invoiceUrl: `/invoice.html?id=${demoId}`,
      message: 'Demo voucher for testing the premium payment voucher page.',
      createdAt: new Date().toISOString(), gatewayUrl: ''
    });
  }
  const db = loadDb();
  const row = (db.messages || []).find(x => x.type === 'payment' && String(x.id) === String(req.params.id));
  if (!row) return res.status(404).json({ error: 'Payment voucher not found.' });
  res.json({
    voucherNo: row.voucherNo || `ETH-PV-${String(row.id).slice(-10).toUpperCase()}`,
    paymentRequestId: row.id, status: row.status || 'pending',
    name: row.name || '', email: row.email || '', phone: row.phone || '', service: row.service || '',
    amount: Number(row.amount || 0), currency: row.currency || 'USD', paymentMethod: row.paymentMethod || '',
    paymentMethods: Array.isArray(row.paymentMethods) ? row.paymentMethods : String(row.paymentMethod || '').split(',').map(x=>x.trim()).filter(Boolean),
    gatewayUrls: Array.isArray(row.gatewayUrls) ? row.gatewayUrls : [],
    invoiceUrl: `/invoice.html?id=${encodeURIComponent(row.id)}`,
    estimator: row.estimator || null,
    message: String(row.message || '').replace(/^Payment request\s*·\s*[^·]+\s*·\s*[^·]+\s*·\s*/i, '').slice(0,5000),
    createdAt: row.createdAt || '', gatewayUrl: row.gatewayUrl || ''
  });
});


function saveChatAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  if (attachments.length > 5) throw new Error('You can attach up to 5 files.');
  let total = 0;
  return attachments.map(a => {
    const data = String(a?.data || '');
    const name = String(a?.name || 'attachment').slice(0,180);
    const size = Number(a?.size || 0);
    if (!data) throw new Error('Invalid attachment.');
    total += size || Math.floor((data.length * 3) / 4);
    if (total > 10 * 1024 * 1024) throw new Error('Total attachments must be under 10MB.');
    const url = uploadDataUrl(data, name);
    return { name, size: size || 0, type: String(a?.type || ''), url };
  });
}

// Chat endpoints
app.post('/api/chat/start', rateLimitMiddleware('chat-start', 10, 300), (req, res) => {
  const { name = '', email = '' } = req.body || {};
  const tName = String(name).trim();
  const tEmail = String(email).trim();

  if (!tName || !tEmail.includes('@')) {
    return res.status(400).json({ error: 'Valid name and email are required.' });
  }

  const now = new Date().toISOString();
  const db = loadDb();
  db.conversations = db.conversations || [];
  let conv = db.conversations.find(c => String(c.email || '').toLowerCase() === tEmail.toLowerCase());
  if (!conv) {
    conv = {
      id: newId(),
      name: tName,
      email: tEmail,
      createdAt: now,
      updatedAt: now,
      messages: [],
      chatUnread: 0,
      source: 'chat'
    };
    db.conversations.push(conv);
  } else {
    conv.source = 'chat';
    conv.chatUnread = Number(conv.chatUnread) || 0;
    conv.updatedAt = now;
  }

  saveDb(db);
  res.json({ conversationId: conv.id });
});

app.get('/api/chat/:id', (req, res) => {
  const db = loadDb();
  const conv = (db.conversations || []).find(c => String(c.id) === String(req.params.id));
  if (!conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  res.json(conv.messages || []);
});

app.post('/api/chat/:id', rateLimitMiddleware('chat-send', 30, 300), (req, res) => {
  const text = String(req.body?.text || '').trim();
  const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  if (!text && rawAttachments.length === 0) return res.status(400).json({ error: 'Message or attachment is required.' });
  if (text.length > 4000) return res.status(400).json({ error: 'Message is too long.' });

  const db = loadDb();
  const conv = (db.conversations || []).find(c => String(c.id) === String(req.params.id));
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

  let attachments = [];
  try { attachments = saveChatAttachments(rawAttachments); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const now = new Date().toISOString();
  const msg = { id: newId(), from: 'visitor', channel: 'chat', text, attachments, createdAt: now };
  conv.messages = conv.messages || [];
  const hadVisitorMessage = conv.messages.some(m => m && m.from === 'visitor' && m.channel === 'chat');
  conv.messages.push(msg);
  conv.chatUnread = (Number(conv.chatUnread) || 0) + 1;
  conv.source = 'chat';
  conv.updatedAt = now;

  // Auto-reply only after the client has actually sent their first chat message.
  // Never inject the greeting when the chat is merely opened.
  if (!hadVisitorMessage) {
    const autoMessage = String(db.settings?.chatAutoMessage || '').trim();
    const hasAutoReply = conv.messages.some(m => m && m.from === 'admin' && m.automated === true);
    if (autoMessage && !hasAutoReply) {
      conv.messages.push({ id: newId(), from: 'admin', channel: 'chat', text: autoMessage, createdAt: new Date().toISOString(), automated: true });
    }
  }

  saveDb(db);
  res.status(201).json(msg);
});

// Admin auth
app.post('/api/admin/login', rateLimitMiddleware('login', 8, 300), (req, res) => {
  const inputPass = String(req.body?.password || '');
  const stored = getStoredAdminHash();
  const valid = stored ? verifyPasswordHash(inputPass, stored) : (inputPass && inputPass === envv('ADMIN_PASSWORD', 'admin123'));
  if (!inputPass || !valid) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const payload = JSON.stringify({
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
    nonce: crypto.randomBytes(8).toString('hex')
  });
  const token = signToken(payload, adminSecret());
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie('ethon_admin', token, {
    maxAge: SESSION_TTL * 1000,
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/'
  });
  res.json({ ok: true });
});

app.post('/api/admin/password', requireAdmin, rateLimitMiddleware('password-change', 5, 300), (req, res) => {
  const current = String(req.body?.currentPassword || '');
  const next = String(req.body?.newPassword || '');
  const stored = getStoredAdminHash();
  const validCurrent = stored ? verifyPasswordHash(current, stored) : current === envv('ADMIN_PASSWORD', 'admin123');
  if (!validCurrent) return res.status(401).json({ error: 'Current password is incorrect.' });
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const db = loadDb();
  db.settings = db.settings || {};
  db.settings.adminPasswordHash = passwordHash(next);
  saveDb(db);
  res.clearCookie('ethon_admin', { path: '/' });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('ethon_admin', { path: '/' });
  res.json({ ok: true });
});

// Admin overview & management
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const db = loadDb();
  res.json(db);
});

app.patch('/api/admin/messages/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const msg = (db.messages || []).find(m => String(m.id) === String(req.params.id));
  if (!msg) return res.status(404).json({ error: 'Not found' });

  Object.assign(msg, req.body);
  saveDb(db);
  res.json(msg);
});

app.post('/api/admin/conversations/:id/read', requireAdmin, (req, res) => {
  const db = loadDb();
  const conv = (db.conversations || []).find(c => String(c.id) === String(req.params.id));
  if (!conv) return res.status(404).json({ error: 'Not found' });
  conv.chatUnread = 0;
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/conversations/:id', requireAdmin, (req, res) => {
  const text = String(req.body?.text || '').trim();
  const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  if (!text && rawAttachments.length === 0) return res.status(400).json({ error: 'Message or attachment is required.' });

  const db = loadDb();
  const conv = (db.conversations || []).find(c => String(c.id) === String(req.params.id));
  if (!conv) return res.status(404).json({ error: 'Not found' });

  let attachments = [];
  try { attachments = saveChatAttachments(rawAttachments); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const now = new Date().toISOString();
  const msg = { id: newId(), from: 'admin', channel: 'chat', text, attachments, createdAt: now };
  conv.messages = conv.messages || [];
  conv.messages.push(msg);
  conv.chatUnread = 0;
  conv.updatedAt = now;
  saveDb(db);
  res.status(201).json(msg);
});

app.post('/api/admin/projects/reorder', requireAdmin, (req, res) => {
  const db = loadDb();
  db.projects = reorder(db.projects || [], Array.isArray(req.body?.ids) ? req.body.ids : []);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/testimonials/reorder', requireAdmin, (req, res) => {
  const db = loadDb();
  db.testimonials = reorder(db.testimonials || [], Array.isArray(req.body?.ids) ? req.body.ids : []);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/projects', requireAdmin, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Project title is required.' });

  let image = String(b.image || '');
  if (b.imageData) {
    try {
      image = uploadDataUrl(b.imageData, b.imageName || 'media');
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  const proj = {
    id: newId(),
    title,
    category: String(b.category || '').trim(),
    role: String(b.role || '').trim(),
    description: String(b.description || '').trim(),
    image,
    caseStudy: String(b.caseStudy || ''),
    live: String(b.live || ''),
    featured: Boolean(b.featured),
    published: b.published !== false,
    source: 'admin'
  };

  const db = loadDb();
  db.projects = db.projects || [];
  db.projects.push(proj);
  saveDb(db);
  res.status(201).json(proj);
});

app.put('/api/admin/projects/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const proj = (db.projects || []).find(p => String(p.id) === String(req.params.id));
  if (!proj) return res.status(404).json({ error: 'Not found' });

  const b = req.body || {};
  const fields = ['title', 'category', 'role', 'description', 'caseStudy', 'live', 'featured', 'published'];
  for (const k of fields) {
    if (k in b) proj[k] = b[k];
  }
  if (b.imageData) {
    try {
      proj.image = uploadDataUrl(b.imageData, b.imageName || 'media');
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  saveDb(db);
  res.json({ ok: true });
});

app.delete('/api/admin/projects/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const idx = (db.projects || []).findIndex(p => String(p.id) === String(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  db.projects.splice(idx, 1);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/testimonials', requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const text = String(b.text || '').trim();
  if (!name || !text) return res.status(400).json({ error: 'Name and testimonial text are required.' });

  let avatar = String(b.avatar || '');
  if (b.imageData) {
    try {
      avatar = uploadDataUrl(b.imageData, b.imageName || 'media');
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  const test = {
    id: newId(),
    name,
    role: String(b.role || '').trim(),
    text,
    rating: Number(b.rating) || 5,
    avatar,
    location: String(b.location || '').trim(),
    flagSvg: String(b.flagSvg || ''),
    published: b.published !== false,
    source: 'admin'
  };

  const db = loadDb();
  db.testimonials = db.testimonials || [];
  db.testimonials.push(test);
  saveDb(db);
  res.status(201).json(test);
});

app.put('/api/admin/testimonials/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const test = (db.testimonials || []).find(t => String(t.id) === String(req.params.id));
  if (!test) return res.status(404).json({ error: 'Not found' });

  const b = req.body || {};
  const fields = ['name', 'role', 'text', 'rating', 'location', 'flagSvg', 'published'];
  for (const k of fields) {
    if (k in b) test[k] = b[k];
  }
  if (b.imageData) {
    try {
      test.avatar = uploadDataUrl(b.imageData, b.imageName || 'media');
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  saveDb(db);
  res.json({ ok: true });
});

app.delete('/api/admin/testimonials/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const idx = (db.testimonials || []).findIndex(t => String(t.id) === String(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  db.testimonials.splice(idx, 1);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/media', requireAdmin, rateLimitMiddleware('media', 30, 300), (req, res) => {
  const { data, name } = req.body || {};
  if (!data) return res.status(400).json({ error: 'No media data provided.' });
  try {
    const url = uploadDataUrl(String(data), String(name || 'media'));
    res.status(201).json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const db = loadDb();
  db.settings = db.settings || {};
  Object.assign(db.settings, req.body || {});
  saveDb(db);
  res.json(db.settings);
});

// Clean URL redirects & routes
app.get(['/index.html', '/index.htm'], (req, res) => {
  res.redirect(301, '/');
});

app.get('/checkout.html', (req, res) => {
  res.redirect(301, '/checkout');
});

app.get(['/checkout', '/checkout/'], (req, res) => {
  res.sendFile(path.join(ROOT, 'checkout.html'));
});

// Legacy checkout-info URLs now resolve to the single unified checkout flow.
app.get(['/checkout-info', '/checkout-info/', '/checkout-info.html'], (req, res) => {
  res.redirect(301, '/checkout');
});

// Admin page route
app.get(['/admin', '/admin/'], (req, res) => {
  res.sendFile(path.join(ROOT, 'admin.html'));
});

// Secure attachment download endpoint
app.get('/api/chat/download', (req, res) => {
  const raw = String(req.query.file || '');
  const base = path.basename(raw);
  if (!base || base !== raw || base.includes('..')) return res.status(400).send('Invalid file.');
  const filePath = path.join(UPLOAD_DIR, base);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found.');
  res.download(filePath, base, {
    dotfiles: 'deny',
    headers: { 'Cache-Control': 'private, max-age=3600' }
  });
});

// Publicly readable chat uploads so attachment links can open/preview in the browser.
app.use('/uploads', express.static(UPLOAD_DIR, { etag: true, maxAge: '1h', dotfiles: 'deny' }));

// Static assets
app.use(express.static(ROOT, {
  etag: true,
  maxAge: '1h'
}));

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
