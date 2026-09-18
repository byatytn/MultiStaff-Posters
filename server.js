const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const admin = require('firebase-admin');

const app = express();
app.use(express.json({ limit: '1mb' }));

console.log('[BOOT] MultiStaff starting...');
console.log('[BOOT] Node:', process.version);
console.log('[BOOT] PID:', process.pid);
console.log('[BOOT] PORT:', process.env.PORT || 3000);

const ADMIN_PASSWORD = process.env.MULTISTAFF_ADMIN_PASSWORD || '2026';
const SESSION_TTL = 6 * 60 * 60 * 1000;

// Адмін-сесія має переживати перезапуск Node/хостингу.
// Токен містить час завершення та захищений HMAC-підписом.
// Якщо MULTISTAFF_SESSION_SECRET заданий у середовищі — використовуємо його;
// інакше стабільно виводимо секрет із поточного адмін-пароля.
const SESSION_SECRET = process.env.MULTISTAFF_SESSION_SECRET ||
  crypto.createHash('sha256').update('multistaff-session:'+ADMIN_PASSWORD).digest('hex');

function createAdminSession() {
  const expiresAt = Date.now() + SESSION_TTL;
  const payload = Buffer.from(JSON.stringify({ exp: expiresAt })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + signature;
}

function verifyAdminSession(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');

  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return false;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(data.exp) && data.exp > Date.now();
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!verifyAdminSession(token)) {
    return res.status(401).json({ error: 'Требуется пароль администратора' });
  }

  next();
}

function loadFirebaseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) return JSON.parse(raw.trim());

  for (const key of ['FIREBASE_SERVICE_ACCOUNT', 'GOOGLE_APPLICATION_CREDENTIALS_JSON']) {
    const value = process.env[key];
    if (value && value.trim()) return JSON.parse(value.trim());
  }

  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
  if (filePath && fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  const firebaseKeys = Object.keys(process.env).filter(k => /FIREBASE|GOOGLE.*CREDENTIAL/i.test(k));
  console.error('Firebase configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is not available.');
  console.error('Firebase-related environment keys visible to the process:', firebaseKeys.join(', ') || '(none)');
  throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set');
}

let credential;
try {
  const serviceAccount = loadFirebaseServiceAccount();
  credential = admin.credential.cert(serviceAccount);
  console.log('Firebase service-account configuration loaded successfully.');
} catch (e) {
  console.error('Firebase configuration error:', e.message);
  process.exit(1);
}

admin.initializeApp({ credential });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

process.on('SIGTERM', () => {
  console.warn('[SHUTDOWN] SIGTERM received from the platform.');
  console.warn('[SHUTDOWN] PID:', process.pid);
  process.exit(0);
});

process.on('SIGINT', () => {
  console.warn('[SHUTDOWN] SIGINT received.');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});

setInterval(() => {
  const m = process.memoryUsage();
  console.log('[HEARTBEAT] pid=%s rss=%sMB heap=%sMB uptime=%ss',
    process.pid,
    Math.round(m.rss / 1024 / 1024),
    Math.round(m.heapUsed / 1024 / 1024),
    Math.round(process.uptime())
  );
}, 60000).unref();

// IMPORTANT:
// Staff and shifts for this website live ONLY in StaffShedules.
// There is deliberately NO connection to Cinema/atmosfera/Users.
// Users is used by other MultiStaff systems and is never modified here.
// Website source of truth: Cinema/atmosfera/StaffShedules/main.
const staffSchedulesRef = db.doc('Cinema/atmosfera/StaffShedules/main');
// Legacy path from an earlier build. It is read only for a one-time migration.
async function refreshScheduleCache() {
  try {
    const snap = await staffSchedulesRef.get();
    if (!snap.exists) {
      scheduleCache = { employees: [], shifts: [], updatedAt: null, loaded: true };
      console.log('[FIREBASE] StaffShedules exists: false');
      return;
    }

    const d = snap.data() || {};
    const clean = cleanScheduleData(d);
    const updatedAt = d.updatedAt && typeof d.updatedAt.toDate === 'function'
      ? d.updatedAt.toDate().toISOString()
      : null;

    scheduleCache = {
      employees: clean.employees,
      shifts: clean.shifts,
      updatedAt,
      loaded: true
    };

    console.log('[FIREBASE] StaffShedules read: OK');
    console.log('[FIREBASE] StaffShedules exists: true');
    console.log('[FIREBASE] StaffShedules fields:', Object.keys(d).join(', ') || '(empty document)');
    console.log('[FIREBASE] StaffShedules employees (raw):',
      Array.isArray(d.employees) ? d.employees.length :
      (d.employees && typeof d.employees === 'object' ? Object.keys(d.employees).length : 0));
    console.log('[FIREBASE] StaffShedules employees (website):', clean.employees.length);
    console.log('[FIREBASE] StaffShedules shifts (website):', clean.shifts.length);
  } catch (err) {
    console.error('[FIREBASE] StaffShedules read failed:', err.message);
    // Do not mark the cache as loaded on a failed read.
  }
}

refreshScheduleCache();

const defaultState = { employees: [], shifts: [] };

// Keep a memory snapshot for the website API.
// The browser must not wait for a Firestore read on every /api/state request.
// Firestore is still the source of truth; this cache is refreshed at startup
// and after every successful website save.
let scheduleCache = {
  employees: [],
  shifts: [],
  updatedAt: null,
  loaded: false
};
function scheduleSnapshotData(d) {
  // Firestore StaffShedules stores employees as a MAP:
  // employees: { "1": {id: 1, name: "...", role: "..."}, ... }
  // Shifts remain an ARRAY.
  // The map key is the authoritative employee ID. We do not read Users.
  let employees = [];
  if (Array.isArray(d?.employees)) {
    employees = d.employees;
  } else if (d?.employees && typeof d.employees === 'object') {
    employees = Object.entries(d.employees).map(([key, value]) => {
      const e = value && typeof value === 'object' ? { ...value } : {};
      const keyId = Number(key);
      const nestedId = Number(e.id);
      // Existing StaffShedules data uses the map key as the employee ID.
      // This also fixes older records where nested id values were duplicated.
      e.id = Number.isFinite(keyId) ? keyId : nestedId;
      return e;
    });
  }

  const shifts = Array.isArray(d?.shifts) ? d.shifts.map(s => {
    const rawDate = s?.date;
    let date = '';
    if (typeof rawDate === 'string') {
      // StaffShedules normally stores YYYY-MM-DD. Older records may contain
      // an ISO datetime; the calendar works with local calendar dates only.
      date = rawDate.slice(0, 10);
    } else if (rawDate && typeof rawDate.toDate === 'function') {
      const dt = rawDate.toDate();
      date = [
        dt.getFullYear(),
        String(dt.getMonth() + 1).padStart(2, '0'),
        String(dt.getDate()).padStart(2, '0')
      ].join('-');
    }

    return {
      ...s,
      date,
      employeeId: Number.isFinite(Number(s?.employeeId)) ? Number(s.employeeId) : s?.employeeId,
      id: Number.isFinite(Number(s?.id)) ? Number(s.id) : s?.id
    };
  }) : [];

  // Normalize the two fields used for calendar matching. This keeps old
  // StaffShedules records compatible without touching Users or changing the
  // Firestore source data.
  return { employees, shifts };
}

function cleanScheduleData(d) {
  // No Users filtering, no guessed ID ranges, and no deletion.
  // StaffShedules is the only source of website employees and shifts.
  return scheduleSnapshotData(d);
}

function firestoreScheduleData(state) {
  // Keep the existing Firestore schema: employees are stored as a MAP,
  // while shifts are stored as an ARRAY.
  const employees = {};
  for (const e of state.employees) {
    employees[String(e.id)] = {
      ...e,
      id: Number(e.id)
    };
  }
  return {
    employees,
    shifts: state.shifts
  };
}

function validState(s) {
  return s && Array.isArray(s.employees) && Array.isArray(s.shifts) &&
    s.employees.every(e =>
      e &&
      Number.isFinite(Number(e.id)) &&
      typeof e.name === 'string' &&
      typeof e.role === 'string'
    ) &&
    s.shifts.every(x =>
      x &&
      Number.isFinite(Number(x.id)) &&
      Number.isFinite(Number(x.employeeId)) &&
      typeof x.date === 'string' &&
      typeof x.start === 'string' &&
      typeof x.end === 'string'
    );
}

function hasScheduleData(s) {
  return !!(s && (
    (Array.isArray(s.employees) && s.employees.length > 0) ||
    (Array.isArray(s.shifts) && s.shifts.length > 0)
  ));
}


// Dashboard API: current date, today's cinema sessions and the shared air-alert state.
app.get('/api/dashboard', async (req, res) => {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const part = type => parts.find(x => x.type === type)?.value;
    const dateStr = part('year') + '-' + part('month') + '-' + part('day');

    const cinemaRef = db.collection('Cinema').doc('atmosfera');
    const scheduleSnap = await cinemaRef.collection('Schedules').doc(dateStr).get();
    const sessions = scheduleSnap.exists && Array.isArray(scheduleSnap.data()?.sessions)
      ? scheduleSnap.data().sessions : [];

    const alarmSnap = await cinemaRef.collection('BotConfig').doc('airAlertState').get();
    const alarmState = alarmSnap.exists ? (alarmSnap.data() || {}) : {};
    const level = String(alarmState.alertLevel || '').toLowerCase();
    const active = !alarmState.ignored && (level === 'red' || level === 'yellow') && !!alarmState.startedAt;

    res.json({
      ok: true,
      date: dateStr,
      sessionsToday: sessions.length,
      alarm: {
        ok: true,
        active,
        level: active ? level : null,
        startedAt: active ? alarmState.startedAt : null
      }
    });
  } catch (e) {
    console.error('[API] dashboard failed:', e);
    res.status(500).json({ ok: false, error: 'Не удалось загрузить данные главной' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, pid: process.pid, uptime: Math.round(process.uptime()) });
});

app.post('/api/admin/login', (req, res) => {
  const password = String(req.body?.password || '');

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }

  const token = createAdminSession();
  res.json({ ok: true, token, expiresIn: SESSION_TTL });
});

app.get('/api/state', (req, res) => {
  // IMPORTANT: never block the browser on Firestore here.
  // The cache is populated from StaffShedules at startup and after saves.
  // Users is never read.
  console.log('[API] /api/state -> employees=%d shifts=%d loaded=%s',
    scheduleCache.employees.length,
    scheduleCache.shifts.length,
    scheduleCache.loaded
  );

  res.json({
    exists: scheduleCache.loaded,
    initialized: hasScheduleData(scheduleCache),
    loading: !scheduleCache.loaded,
    data: {
      employees: scheduleCache.employees,
      shifts: scheduleCache.shifts
    },
    updatedAt: scheduleCache.updatedAt
  });
});

app.put('/api/state', requireAdmin, async (req, res) => {
  try {
    const data = req.body;

    if (!validState(data)) {
      return res.status(400).json({ error: 'Некорректные данные графика' });
    }

    const clean = cleanScheduleData(data);

    // A blank payload is never allowed to wipe the shared schedule.
    if (!hasScheduleData(clean)) {
      return res.status(409).json({ error: 'Пустой график не сохраняется, чтобы не потерять сотрудников и смены' });
    }

    // Preserve the real StaffShedules schema: employees MAP + shifts ARRAY.
    // Users is never read or modified.
    const firestoreData = firestoreScheduleData(clean);
    await staffSchedulesRef.set({
      ...firestoreData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: false });

    const snap = await staffSchedulesRef.get();
    const updatedAt = snap.data()?.updatedAt?.toDate?.().toISOString() || new Date().toISOString();

    // Update the API snapshot only after Firestore has accepted the save.
    scheduleCache = {
      employees: clean.employees,
      shifts: clean.shifts,
      updatedAt,
      loaded: true
    };

    res.json({ ok: true, updatedAt });
  } catch (e) {
    console.error('[API] state save failed:', e);
    res.status(500).json({ error: 'Не удалось сохранить общий график' });
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: res => res.setHeader('Cache-Control', 'no-store, max-age=0')
}));
app.get(/.*/, (req, res) => {
  // The schedule UI changes frequently. Never let the browser/proxy keep an old index.html.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = process.env.PORT || 3000;
const server = app.listen(port, '0.0.0.0', () => {
  console.log('[READY] MultiStaff server listening on', port);
});

server.on('error', (err) => {
  console.error('[SERVER ERROR]', err);
});
