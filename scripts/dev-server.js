const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const apiHandler = require('../api/index.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT_DIR = path.resolve(__dirname, '..');

// CLI PARA CRIAÇÃO DE ADMIN LOCAL
const args = process.argv.slice(2);
if (args[0] === '--create-admin' || args[0] === '--init-admin') {
  console.log('[Admin] Para criar um administrador, configure INITIAL_ADMIN_USER e INITIAL_ADMIN_PASS no ambiente.');
  process.exit(0);
}

// MIME TYPES E ARQUIVOS ESTÁTICOS LOCAIS
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.apk': 'application/vnd.android.package-archive',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res, filePath) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — Página ou recurso não encontrado.');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const totalSize = stats.size;
    const range = req.headers['range'];

    if (range && ext === '.mp4') {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      const chunkSize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType
      });

      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': totalSize,
      'Cache-Control': ext === '.mp4' || ext === '.png' || ext === '.jpg' 
        ? 'public, max-age=86400' 
        : 'public, max-age=0, must-revalidate'
    });

    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // 1. Delegação de rotas de API e download
  if (pathname.startsWith('/api/') || pathname === '/download') {
    return apiHandler(req, res);
  }

  // 2. Rotas do Painel Administrativo
  if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin/index.html') {
    return serveStatic(req, res, path.join(ROOT_DIR, 'admin', 'index.html'));
  }

  if (pathname === '/admin/login' || pathname === '/admin/login.html') {
    return serveStatic(req, res, path.join(ROOT_DIR, 'admin', 'login.html'));
  }

  if (pathname.startsWith('/admin/')) {
    const rel = pathname.replace(/^\/admin\//, '');
    const p = path.join(ROOT_DIR, 'admin', rel);
    if (fs.existsSync(p)) return serveStatic(req, res, p);
  }

  // 3. Rota /baixar
  if (pathname === '/baixar' || pathname === '/baixar/' || pathname === '/baixar.html') {
    return serveStatic(req, res, path.join(ROOT_DIR, 'baixar.html'));
  }

  // 4. Arquivos estáticos da raiz e assets
  let staticPath = path.join(ROOT_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!staticPath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    return res.end('403 Proibido');
  }

  fs.stat(staticPath, (err, stats) => {
    if (!err && stats.isFile()) {
      return serveStatic(req, res, staticPath);
    }
    if (!err && stats.isDirectory()) {
      const index = path.join(staticPath, 'index.html');
      if (fs.existsSync(index)) return serveStatic(req, res, index);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — Recurso não encontrado.');
  });
});

if (require.main === module || !process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`UpPlay Dev Server Ativo em http://localhost:${PORT}/`);
  });
}

module.exports = server;
