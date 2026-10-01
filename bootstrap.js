const fs=require('fs');
const Module=require('module');
const path=require('path');
const serverPath=path.join(__dirname,'server.js');
let source=fs.readFileSync(serverPath,'utf8');
const marker="app.use(express.static(path.join(__dirname, 'public'), {";
if(!source.includes(marker)) throw new Error('MultiStaff bootstrap: server.js injection marker not found');
const injected=`
// Kassa workflow constructor storage. Data lives in Cinema/ManagerAssist/Orders/kassa.
app.get('/api/kassa', async (req, res) => {
  if (!firebaseReady || !db) return res.status(503).json({ error: 'Firebase недоступний на сервері' });
  try {
    const ref = db.collection('Cinema').doc('ManagerAssist').collection('Orders').doc('kassa');
    const snap = await ref.get();
    const data = snap.exists ? (snap.data() || {}) : {};
    res.json({ nodes: Array.isArray(data.nodes) ? data.nodes : [], edges: Array.isArray(data.edges) ? data.edges : [], updatedAt: data.updatedAt && typeof data.updatedAt.toDate === 'function' ? data.updatedAt.toDate().toISOString() : null });
  } catch (e) {
    console.error('[API] kassa read failed:', e);
    res.status(500).json({ error: 'Не удалось загрузить схему кассы' });
  }
});
app.put('/api/kassa', requireAdmin, async (req, res) => {
  if (!firebaseReady || !db) return res.status(503).json({ error: 'Firebase недоступний на сервері' });
  try {
    const nodes = Array.isArray(req.body?.nodes) ? req.body.nodes : [];
    const edges = Array.isArray(req.body?.edges) ? req.body.edges : [];
    if (nodes.length > 500 || edges.length > 1000) return res.status(400).json({ error: 'Схема занадто велика' });
    const safeNodes = nodes.map(n => ({ id: String(n.id || ''), text: String(n.text || '').slice(0,120), x: Number(n.x) || 0, y: Number(n.y) || 0 })).filter(n => n.id && Number.isFinite(n.x) && Number.isFinite(n.y));
    const ids = new Set(safeNodes.map(n => n.id));
    const safeEdges = edges.map(e => ({ id: String(e.id || ''), from: String(e.from || ''), to: String(e.to || '') })).filter(e => e.id && ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
    const ref = db.collection('Cinema').doc('ManagerAssist').collection('Orders').doc('kassa');
    await ref.set({ nodes: safeNodes, edges: safeEdges, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.json({ ok: true, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[API] kassa save failed:', e);
    res.status(500).json({ error: 'Не удалось сохранить схему кассы' });
  }
});
`;
source=source.replace(marker,injected+'\n'+marker);
const m=new Module(serverPath,module);
m.filename=serverPath;m.paths=Module._nodeModulePaths(__dirname);m._compile(source,serverPath);
