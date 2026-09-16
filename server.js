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
const legacyStaffScheduleRefs = [
  db.doc('Cinema/atmosfera/StaffSchedule/main'),
  db.doc('Cinema/atmosfera/StaffSchedules/main')
];

(async () => {
  try {
    let snap = await staffSchedulesRef.get();
    console.log('[FIREBASE] StaffShedules read: OK');
    console.log('[FIREBASE] StaffShedules exists:', snap.exists);

    // If the new collection is empty, recover data from the old collection(s).
    // This never reads, deletes or writes anything in Users.
    if (!snap.exists || !hasScheduleData(snap.data() || {})) {
      for (const legacyRef of legacyStaffScheduleRefs) {
        const legacy = await legacyRef.get();
        if (legacy.exists && hasScheduleData(legacy.data() || {})) {
          await staffSchedulesRef.set({ ...legacy.data(), migratedFrom: legacyRef.path, migratedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: false });
          snap = await staffSchedulesRef.get();
          console.log('[FIREBASE] Migrated existing website schedule from', legacyRef.path, 'to', staffSchedulesRef.path);
          break;
        }
      }
    }

    if (snap.exists) {
      const d = snap.data() || {};
      console.log('[FIREBASE] StaffShedules fields:', Object.keys(d).join(', ') || '(empty document)');
      console.log('[FIREBASE] StaffShedules employees:', Array.isArray(d.employees) ? d.employees.length : 0);
      console.log('[FIREBASE] StaffShedules shifts:', Array.isArray(d.shifts) ? d.shifts.length : 0);
    }
  } catch (err) {
    console.error('[FIREBASE] StaffSchedule read failed:', err.message);
  }
})();

const defaultState = { employees: [], shifts: [] };
function scheduleSnapshotData(d) {
  return {
    employees: Array.isArray(d?.employees) ? d.employees : [],
    shifts: Array.isArray(d?.shifts) ? d.shifts : []
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

app.get('/api/state', async (req, res) => {
  try {
    const snap = await staffSchedulesRef.get();

    if (!snap.exists) {
      return res.json({
        exists: false,
        initialized: false,
        data: defaultState,
        updatedAt: null
      });
    }

    const d = snap.data() || {};

    // StaffShedules is the SINGLE source of truth.
    // Never read employees from Users or any other collection.
    const { employees, shifts } = scheduleSnapshotData(d);
    const initialized = hasScheduleData({ employees, shifts });

    const updatedAt = d.updatedAt && typeof d.updatedAt.toDate === 'function'
      ? d.updatedAt.toDate().toISOString()
      : null;

    res.json({
      exists: true,
      initialized,
      data: { employees, shifts },
      updatedAt
    });
  } catch (e) {
    console.error('[API] state read failed:', e);
    res.status(500).json({ error: 'Не удалось получить общий график' });
  }
});

app.put('/api/state', requireAdmin, async (req, res) => {
  try {
    const data = req.body;

    if (!validState(data)) {
      return res.status(400).json({ error: 'Некорректные данные графика' });
    }

    // A blank payload is never allowed to wipe the shared schedule.
    if (!hasScheduleData(data)) {
      return res.status(409).json({ error: 'Пустой график не сохраняется, чтобы не потерять сотрудников и смены' });
    }

    // Employees and their shifts are saved together in StaffShedules.
    await staffSchedulesRef.set({
      employees: data.employees,
      shifts: data.shifts,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: false });

    const snap = await staffSchedulesRef.get();
    const updatedAt = snap.data()?.updatedAt?.toDate?.().toISOString() || new Date().toISOString();

    res.json({ ok: true, updatedAt });
  } catch (e) {
    console.error('[API] state save failed:', e);
    res.status(500).json({ error: 'Не удалось сохранить общий график' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const port = process.env.PORT || 3000;
const server = app.listen(port, '0.0.0.0', () => {
  console.log('[READY] MultiStaff server listening on', port);
});

server.on('error', (err) => {
  console.error('[SERVER ERROR]', err);
});
