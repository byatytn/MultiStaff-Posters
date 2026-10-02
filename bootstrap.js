const fs = require('fs');
const Module = require('module');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

// Keep the HTML navigation injection here, but keep all API routes in
// server.js. In particular, notes must use the manager-scoped API from
// server.js so notes cannot be shared between manager accounts.
const marker = "app.use(express.static(path.join(__dirname, 'public'), {";
if (!source.includes(marker)) {
  throw new Error('MultiStaff bootstrap: server.js injection marker not found');
}

const injected = `
// Shared ManagerAssist navigation.
// Inject the menu into the main HTML fallback without changing the existing
// schedule page markup. Static public pages can include menu.js themselves.
app.use((req, res, next) => {
  const originalSendFile = res.sendFile.bind(res);
  res.sendFile = (filePath, options, callback) => {
    if (!String(filePath).toLowerCase().endsWith('.html')) {
      return originalSendFile(filePath, options, callback);
    }

    fs.readFile(filePath, 'utf8', (err, html) => {
      if (err) return callback ? callback(err) : next(err);

      const script = '<script src="/menu.js"></script>';
      let output = html;

      // Do not use a regex here: this code is compiled from a template string
      // and escaping the closing HTML tag can accidentally produce invalid JS.
      // A plain string replacement is deterministic and safe for our pages.
      if (!html.includes('/menu.js')) {
        const closingBody = '</body>';
        const bodyIndex = html.toLowerCase().lastIndexOf(closingBody);
        output = bodyIndex >= 0
          ? html.slice(0, bodyIndex) + script + html.slice(bodyIndex)
          : html + script;
      }

      res.type('html').send(output);
    });
  };
  next();
});
`;

source = source.replace(marker, injected + '\n' + marker);

const m = new Module(serverPath, module);
m.filename = serverPath;
m.paths = Module._nodeModulePaths(__dirname);
m._compile(source, serverPath);
