const express = require('express');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Admin password is configured in Northflank.
// Default for the first setup: 2026
const ADMIN_PASSWORD = process.env.MULTISTAFF_ADMIN_PASSWORD || '2026';
const adminSessions = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000;

function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now() + SESSION_TTL);
  return token;
}

function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expiresAt = adminSessions.get(token);

  if (!expiresAt || expiresAt < Date.now()) {
    if (token) adminSessions.delete(token);
    return res.status(401).json({ error: 'Требуется пароль администратора' });
  }

  next();
}

let credential;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set');
  credential = admin.credential.cert(JSON.parse(raw));
} catch (e) {
  console.error('Firebase configuration error:', e.message);
  process.exit(1);
}

admin.initializeApp({ credential });
const db = admin.firestore();
const docRef = db.doc('Cinema/atmosfera/StaffSchedule/main');

const defaultState = {
  employees: [
    { id: 1, name: 'Александр', role: 'УС' },
    { id: 2, name: 'Анна', role: 'УС' },
    { id: 3, name: 'Максим', role: 'МС' },
    { id: 4, name: 'Ольга', role: 'УС' }
  ],
  shifts: []
};

function validState(s) {
  return s && Array.isArray(s.employees) && Array.isArray(s.shifts) &&
    s.employees.every(e => e && Number.isFinite(Number(e.id)) && typeof e.name === 'string' && typeof e.role === 'string') &&
    s.shifts.every(x => x && Number.isFinite(Number(x.id)) && Number.isFinite(Number(x.employeeId)) &&
      typeof x.date === 'string' && typeof x.start === 'string' && typeof x.end === 'string');
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/admin/login', (req, res) => {
  const password = String(req.body?.password || '');
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }

  const token = createAdminSession();
  res.json({ ok: true, token, expiresIn: SESSION_TTL });
});

app.get('/api/state', async (req, res) => {
  try {
    const snap = await docRef.get();
    if (!snap.exists) return res.json({ exists: false, data: defaultState, updatedAt: null });

    const d = snap.data() || {};
    const data = {
      employees: Array.isArray(d.employees) ? d.employees : [],
      shifts: Array.isArray(d.shifts) ? d.shifts : []
    };
    const updatedAt = d.updatedAt && typeof d.updatedAt.toDate === 'function'
      ? d.updatedAt.toDate().toISOString()
      : null;

    res.json({ exists: true, data, updatedAt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось получить общий график' });
  }
});

app.put('/api/state', requireAdmin, async (req, res) => {
  try {
    const data = req.body;
    if (!validState(data)) return res.status(400).json({ error: 'Некорректные данные графика' });

    await docRef.set({
      employees: data.employees,
      shifts: data.shifts,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: false });

    const snap = await docRef.get();
    const updatedAt = snap.data()?.updatedAt?.toDate?.().toISOString() || new Date().toISOString();

    res.json({ ok: true, updatedAt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось сохранить общий график' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`MultiStaff server listening on ${port}`));
