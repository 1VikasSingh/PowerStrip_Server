// Smart Power Strip - cloud dashboard (Render)
// The ESP32 polls POST /api/device/sync; the browser uses the same /api/* routes as the local page.
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const DEVICE_KEY = process.env.DEVICE_KEY || 'Power_Strip_001';
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.DASH_PASS || 'Sparsa@123';
const PORT = process.env.PORT || 3000;

if (!DEVICE_KEY || !DASH_PASS) {
  console.error('Set DEVICE_KEY and DASH_PASS environment variables.');
  process.exit(1);
}

const ONLINE_WINDOW_MS = 30000;  // device counts as online if it synced within this time
const WATCH_WINDOW_MS = 30000;   // a browser polled /api/status within this time

const state = { status: null, schedules: null, logs: '', lastSeen: 0, lastView: 0 };
const queue = new Map();         // key -> { path, params }

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/healthz', (req, res) => res.send('ok'));

// ---------- ESP32 endpoint (device key) ----------
app.post('/api/device/sync', (req, res) => {
  if (!safeEqual(req.get('x-device-key') || '', DEVICE_KEY)) {
    return res.status(401).json({ error: 'bad device key' });
  }
  const b = req.body || {};
  if (b.status && typeof b.status === 'object') state.status = b.status;
  if (Array.isArray(b.schedules)) state.schedules = b.schedules;
  if (typeof b.logs === 'string') state.logs = b.logs;
  state.lastSeen = Date.now();

  const commands = [...queue.values()];
  queue.clear();
  const watching = Date.now() - state.lastView < WATCH_WINDOW_MS;
  res.json({ commands, next_ms: (watching || commands.length) ? 2000 : 10000 });
});

// ---------- Browser auth (HTTP Basic) ----------
app.use((req, res, next) => {
  const h = req.get('authorization') || '';
  if (h.startsWith('Basic ')) {
    const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    if (safeEqual(u, DASH_USER) && safeEqual(rest.join(':'), DASH_PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Smart Power Strip"');
  res.status(401).send('Login required');
});

// ---------- Browser API (same routes as the ESP32 local page) ----------
function enqueue(key, apiPath, params) {
  const old = queue.get(key);
  let merged = { ...(old ? old.params : {}), ...params };
  if (apiPath === '/api/dongle') {
    // manual ON/OFF and auto-mode toggle must not be mixed from different clicks
    if ('state' in params) delete merged.auto;
    if ('auto' in params) delete merged.state;
  }
  queue.set(key, { path: apiPath, params: merged });
}

function str(v) { return String(v === undefined ? '' : v).slice(0, 32); }

app.get('/api/status', (req, res) => {
  state.lastView = Date.now();
  const now = Date.now();
  const online = state.lastSeen > 0 && now - state.lastSeen < ONLINE_WINDOW_MS;
  res.json({
    ...(state.status || {}),
    has_data: !!state.status,
    device_online: online,
    last_seen_s: state.lastSeen ? Math.round((now - state.lastSeen) / 1000) : -1,
    pending: queue.size,
  });
});

app.get('/api/schedules', (req, res) => res.json(state.schedules || []));

app.get('/api/logs', (req, res) => res.type('text/plain').send(state.logs || ''));

app.get('/download/csv', (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="powerstrip_recent.csv"');
  res.type('text/csv').send(state.logs || 'No data yet');
});

app.post('/api/relay', (req, res) => {
  const s = str(req.body.state);
  if (s !== '0' && s !== '1') return res.status(400).json({ error: 'state must be 0 or 1' });
  enqueue('relay', '/api/relay', { state: s });
  res.json({ status: 'queued' });
});

app.post('/api/timer', (req, res) => {
  const h = parseInt(req.body.hours, 10) || 0;
  const m = parseInt(req.body.mins, 10) || 0;
  if (h * 60 + m <= 0 || h < 0 || m < 0 || h > 23 || m > 59) return res.status(400).json({ error: 'invalid time' });
  enqueue('timer', '/api/timer', { hours: String(h), mins: String(m) });
  res.json({ status: 'queued' });
});

app.post('/api/pir', (req, res) => {
  const p = {};
  for (const k of ['enabled', 'autoon', 'timeout']) if (req.body[k] !== undefined) p[k] = str(req.body[k]);
  enqueue('pir', '/api/pir', p);
  if (state.status) {
    if (p.enabled !== undefined) state.status.pir_enabled = p.enabled === '1';
    if (p.autoon !== undefined) state.status.pir_autoon = p.autoon === '1';
    if (p.timeout !== undefined) state.status.pir_timeout = parseInt(p.timeout, 10) || state.status.pir_timeout;
  }
  res.json({ status: 'queued' });
});

app.post('/api/dongle', (req, res) => {
  const p = {};
  for (const k of ['auto', 'state', 'interval_min', 'on_sec', 'threshold']) {
    if (req.body[k] !== undefined) p[k] = str(req.body[k]);
  }
  enqueue('dongle', '/api/dongle', p);
  res.json({ status: 'queued' });
});

app.post('/api/schedule', (req, res) => {
  const id = parseInt(req.body.id, 10);
  const on = str(req.body.on), off = str(req.body.off);
  const re = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!(id >= 0 && id < 8) || !re.test(on) || !re.test(off)) return res.status(400).json({ error: 'invalid values' });
  const days = (parseInt(req.body.days, 10) || 0) & 0x7f;
  const enabled = str(req.body.enabled) === '1' ? '1' : '0';
  enqueue('schedule' + id, '/api/schedule', { id: String(id), enabled, on, off, days: String(days) });
  if (state.schedules && state.schedules[id]) {
    Object.assign(state.schedules[id], { enabled: enabled === '1', on, off, days });
  }
  res.json({ status: 'queued' });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log('Smart Power Strip cloud on port ' + PORT));
