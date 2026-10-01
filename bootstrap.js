const fs=require('fs');
const Module=require('module');
const path=require('path');
const serverPath=path.join(__dirname,'server.js');
let source=fs.readFileSync(serverPath,'utf8');
const marker="app.use(express.static(path.join(__dirname, 'public'), {";
if(!source.includes(marker)) throw new Error('MultiStaff bootstrap: server.js injection marker not found');
const injected=`
// ManagerAssist notes storage. Data lives in Cinema/ManagerAssist/Orders/notes.
app.get('/api/notes', async (req, res) => {
  if (!firebaseReady || !db) return res.status(503).json({ error: 'Firebase недоступний на сервері' });
  try {
    const ref = db.collection('Cinema').doc('ManagerAssist').collection('Orders').doc('notes');
    const snap = await ref.get();
    const data = snap.exists ? (snap.data() || {}) : {};
    res.json({
      notes: Array.isArray(data.notes) ? data.notes : [],
      updatedAt: data.updatedAt && typeof data.updatedAt.toDate === 'function' ? data.updatedAt.toDate().toISOString() : null
    });
  } catch (e) {
    console.error('[API] notes read failed:', e);
    res.status(500).json({ error: 'Не удалось загрузить заметки' });
  }
});

app.put('/api/notes', requireAdmin, async (req, res) => {
  if (!firebaseReady || !db) return res.status(503).json({ error: 'Firebase недоступний на сервері' });
  try {
    const notes = Array.isArray(req.body?.notes) ? req.body.notes : [];
    if (notes.length > 200) return res.status(400).json({ error: 'Слишком много заметок' });

    const safeNotes = notes.map(n => ({
      id: String(n.id || '').slice(0, 100),
      title: String(n.title || '').trim().slice(0, 80),
      content: String(n.content || '').trim().slice(0, 5000),
      createdAt: String(n.createdAt || '').slice(0, 50),
      updatedAt: String(n.updatedAt || '').slice(0, 50)
    })).filter(n => n.id && n.title && n.content);

    const ref = db.collection('Cinema').doc('ManagerAssist').collection('Orders').doc('notes');
    await ref.set({ notes: safeNotes, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.json({ ok: true, notes: safeNotes, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[API] notes save failed:', e);
    res.status(500).json({ error: 'Не удалось сохранить заметки' });
  }
});

// Shared ManagerAssist navigation. Inject the menu into the main HTML fallback
// without changing the existing schedule page markup.
app.use((req, res, next) => {
  const originalSendFile = res.sendFile.bind(res);
  res.sendFile = (filePath, options, callback) => {
    if (!String(filePath).toLowerCase().endsWith('.html')) {
      return originalSendFile(filePath, options, callback);
    }
    fs.readFile(filePath, 'utf8', (err, html) => {
      if (err) return callback ? callback(err) : next(err);
      const script = '<script src="/menu.js"></script>';
      const output = html.includes('/menu.js') ? html : html.replace(/<\/body>/i, script + '</body>');
      res.type('html').send(output);
    });
  };
  next();
});
`;
source=source.replace(marker,injected+'\n'+marker);
const m=new Module(serverPath,module);
m.filename=serverPath;m.paths=Module._nodeModulePaths(__dirname);m._compile(source,serverPath);
