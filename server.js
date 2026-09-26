const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ==========================================
// CONFIGURAÇÕES & VARIÁVEIS DE AMBIENTE
// ==========================================
const isVercel = !!process.env.VERCEL;
const DB_PATH = process.env.DB_PATH || (isVercel ? path.join('/tmp', 'upplay.db') : path.join(__dirname, 'data', 'upplay.db'));
const SESSION_SECRET = process.env.SESSION_SECRET || 'upplay-secret-salt-2026-vanta';
const APK_DOWNLOAD_URL = process.env.APK_DOWNLOAD_URL || 'https://gestaoseguro.top/play/upplay-streaming';
const DATA_RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '90', 10);

// ==========================================
// BANCO DE DADOS (SQLite Nativo Node v24)
// ==========================================
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

// Criação de tabelas com integridade
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    id TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    ip_prefix TEXT,
    FOREIGN KEY(admin_id) REFERENCES admins(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS active_visitors (
    client_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL,
    page TEXT NOT NULL,
    device_type TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    client_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    button_location TEXT,
    page_path TEXT NOT NULL,
    referrer_domain TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    device_type TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    ip_display TEXT NOT NULL,
    user_agent TEXT,
    is_bot INTEGER DEFAULT 0,
    dedup_token TEXT UNIQUE,
    created_at TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_ms ON events(created_at_ms);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_cid ON events(client_id);
  CREATE INDEX IF NOT EXISTS idx_active_seen ON active_visitors(last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_exp ON admin_sessions(expires_at);
`);

// ==========================================
// UTILITÁRIOS DE SEGURANÇA E SESSÃO
// ==========================================
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, storedHash) {
  try {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch {
    return false;
  }
}

function hashIp(ip) {
  if (!ip) return 'unknown';
  const cleanIp = ip.replace(/^::ffff:/, '').replace(/:\d+$/, '');
  return crypto.createHmac('sha256', SESSION_SECRET).update(cleanIp).digest('hex').slice(0, 16);
}

function maskIpForDisplay(ip) {
  if (!ip) return 'Desconhecido';
  const cleanIp = ip.replace(/^::ffff:/, '').replace(/:\d+$/, '');
  if (cleanIp.includes('.')) {
    const parts = cleanIp.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.***.***`;
    }
  }
  if (cleanIp.includes(':')) {
    const parts = cleanIp.split(':');
    return `${parts[0]}:${parts[1]}:****`;
  }
  return 'Anônimo';
}

function isBot(userAgent) {
  if (!userAgent) return 0;
  const botRegex = /bot|spider|crawl|slurp|facebookexternalhit|bingbot|googlebot|lighthouse|headless|curl|wget|python|bytespider|yandex/i;
  return botRegex.test(userAgent) ? 1 : 0;
}

function sanitizeUrlParam(value) {
  if (!value) return null;
  // Remove potenciais tokens ou caracteres perigosos
  return String(value).slice(0, 100).replace(/[^\w\-\.]/g, '');
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() ||
         req.headers['x-real-ip'] ||
         req.socket.remoteAddress || '';
}

function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers['cookie'];
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

function authenticateAdmin(req) {
  const cookies = parseCookies(req);
  let sessionId = cookies['upplay_admin_session'];

  if (!sessionId) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      sessionId = authHeader.slice(7).trim();
    }
  }

  if (!sessionId && req.url) {
    try {
      const parsed = url.parse(req.url, true);
      if (parsed.query && parsed.query.auth_token) {
        sessionId = parsed.query.auth_token;
      }
    } catch {}
  }

  if (!sessionId) return null;

  const session = db.prepare(`
    SELECT s.*, a.username 
    FROM admin_sessions s
    JOIN admins a ON s.admin_id = a.id
    WHERE s.id = ? AND s.expires_at > ?
  `).get(sessionId, Date.now());

  return session || null;
}

// Limpeza periódica de visitantes inativos e sessões expiradas
setInterval(() => {
  try {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24h
    db.prepare('DELETE FROM active_visitors WHERE last_seen_at < ?').run(Date.now() - 300000);
    db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(Date.now());
    
    // Retenção configurada (padrão 90 dias)
    const retentionCutoff = Date.now() - (DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    db.prepare('DELETE FROM events WHERE created_at_ms < ?').run(retentionCutoff);
  } catch (err) {
    console.error('[DB Cleanup Error]:', err.message);
  }
}, 60000);

// ==========================================
// CLI PARA CRIAÇÃO/RESET DO ADMINISTRADOR
// ==========================================
const args = process.argv.slice(2);
if (args[0] === '--create-admin' || args[0] === '--init-admin') {
  const username = args[1] || 'admin';
  const password = args[2] || 'UpPlay2026!';
  
  const { salt, hash } = hashPassword(password);
  const now = new Date().toISOString();

  try {
    const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
    if (existing) {
      db.prepare('UPDATE admins SET password_hash = ?, salt = ? WHERE username = ?').run(hash, salt, username);
      console.log(`[Admin] Senha do administrador "${username}" atualizada com sucesso!`);
    } else {
      db.prepare('INSERT INTO admins (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)').run(username, hash, salt, now);
      console.log(`[Admin] Administrador "${username}" criado com sucesso!`);
    }
    console.log(`[Admin] Usuário: ${username} | Senha configurada`);
  } catch (err) {
    console.error('[Admin Error]:', err.message);
  }
  process.exit(0);
}

// Garante que exista ao menos 1 administrador padrão caso o banco esteja vazio
const adminCount = db.prepare('SELECT COUNT(*) as count FROM admins').get();
if (adminCount.count === 0) {
  const defaultUser = process.env.INITIAL_ADMIN_USER || 'admin';
  const defaultPass = process.env.INITIAL_ADMIN_PASS || 'UpPlay2026!';
  const { salt, hash } = hashPassword(defaultPass);
  db.prepare('INSERT INTO admins (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)').run(
    defaultUser, hash, salt, new Date().toISOString()
  );
  console.log(`[UpPlay] Administrador inicial configurado: ${defaultUser}`);
}

// ==========================================
// MIME TYPES E SERVIÇO DE ARQUIVOS ESTÁTICOS
// ==========================================
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

    // Suporte a streaming parcial (HTTP 206) para vídeos e áudio
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

    const headers = {
      'Content-Type': contentType,
      'Content-Length': totalSize,
      'Accept-Ranges': 'bytes',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
    };

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { // 1MB limit
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Cache simples anti-duplicação de download (5 segundos por IP)
const recentDownloads = new Map();

// ==========================================
// ROTEADOR PRINCIPAL DO SERVIDOR
// ==========================================
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();
  const clientIp = getClientIp(req);
  const userAgent = req.headers['user-agent'] || '';

  // Headers de CORS para permitir telemetria mesmo com abertura via file:///
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ------------------------------------------
  // 1. ROTA CONTROLADA: /download
  // ------------------------------------------
  if (pathname === '/download') {
    const rangeHeader = req.headers['range'];
    const isPartial = rangeHeader && !rangeHeader.startsWith('bytes=0-');
    const isBotReq = isBot(userAgent);
    const ipH = hashIp(clientIp);
    const fromLocation = ['header', 'hero', 'install', 'footer', 'page_baixar'].includes(parsedUrl.query.from)
      ? parsedUrl.query.from
      : 'direct';

    const now = Date.now();
    const lastReq = recentDownloads.get(ipH);
    const isDuplicate = lastReq && (now - lastReq < 5000);

    // Registra métrica somente se NÃO for bot, NÃO for download parcial e NÃO for duplicação recente
    if (!isPartial && !isBotReq && !isDuplicate) {
      recentDownloads.set(ipH, now);

      const clientId = parsedUrl.query.cid || 'server_' + crypto.randomUUID().slice(0, 8);
      const sessionId = parsedUrl.query.sid || 'dl_session';
      const device = /android|iphone|ipad|mobile/i.test(userAgent) ? 'mobile' : 'desktop';
      const dedupToken = `dl_${ipH}_${Math.floor(now / 5000)}`;

      try {
        db.prepare(`
          INSERT OR IGNORE INTO events (
            event_type, client_id, session_id, button_location, page_path,
            device_type, ip_hash, ip_display, user_agent, is_bot, dedup_token,
            created_at, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'download_request',
          clientId,
          sessionId,
          fromLocation,
          '/download',
          device,
          ipH,
          maskIpForDisplay(clientIp),
          userAgent.slice(0, 255),
          0,
          dedupToken,
          new Date().toISOString(),
          now
        );
      } catch (err) {
        console.error('[Download Log Error]:', err.message);
      }
    }

    // Entrega ou Redirecionamento do APK
    if (APK_DOWNLOAD_URL) {
      res.writeHead(302, { 'Location': APK_DOWNLOAD_URL });
      return res.end();
    }

    // Se houver APK local no diretório assets/downloads ou assets
    const localApkPaths = [
      path.join(__dirname, 'assets', 'downloads', 'UpPlay.apk'),
      path.join(__dirname, 'assets', 'UpPlay.apk'),
      path.join(__dirname, 'assets', 'upplay.apk')
    ];

    for (const localPath of localApkPaths) {
      if (fs.existsSync(localPath)) {
        const stats = fs.statSync(localPath);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Length': stats.size,
          'Content-Disposition': 'attachment; filename="UpPlay.apk"'
        });
        return fs.createReadStream(localPath).pipe(res);
      }
    }

    // Fallback gracioso com tela explicativa se o APK ainda não estiver fisicamente hospedado
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title>Solicitação de Download — UpPlay</title>
        <link rel="stylesheet" href="/assets/css/styles.css"/>
        <style>
          body { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
          .download-box { background: var(--bg-surface); border: 1px solid var(--border-medium); border-radius: var(--radius-lg); padding: 40px 32px; max-width: 520px; text-align: center; }
          .badge-ok { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; background: rgba(34, 197, 94, 0.15); color: #22c55e; border-radius: var(--radius-pill); font-weight: 700; font-size: 0.8125rem; margin-bottom: 16px; }
        </style>
      </head>
      <body>
        <div class="download-box">
          <div class="badge-ok">✓ Solicitação Registrada</div>
          <h2 style="margin-bottom: 12px; font-size: 1.45rem;">Download Oficial UpPlay</h2>
          <p style="color: var(--text-secondary); margin-bottom: 20px; font-size: 0.9375rem; line-height: 1.5;">
            Sua solicitação de download foi contabilizada com sucesso no servidor.
          </p>
          <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); padding: 16px; border-radius: var(--radius-md); font-size: 0.84375rem; color: var(--text-muted); text-align: left; margin-bottom: 24px;">
            <strong>Nota de Integração:</strong> Para entregar o arquivo binário real aos visitantes, preencha a variável de ambiente <code>APK_DOWNLOAD_URL</code> com o link direto do APK ou coloque o arquivo em <code>assets/downloads/UpPlay.apk</code>.
          </div>
          <a href="/" class="btn-primary" style="display: inline-flex;">Voltar ao site</a>
        </div>
      </body>
      </html>
    `);
  }

  // ------------------------------------------
  // 2. API DE RASTREAMENTO: /api/track/ping
  // ------------------------------------------
  if (pathname === '/api/track/ping' && method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const clientId = data.client_id;
      const sessionId = data.session_id || 'session';
      const page = (data.page || '/').slice(0, 100);
      const device = ['mobile', 'desktop', 'tablet'].includes(data.device_type) ? data.device_type : 'desktop';

      // Ignora pings vindos do painel administrativo
      if (page.startsWith('/admin')) {
        return jsonResponse(res, 200, { ok: true, ignored: true });
      }

      if (clientId && !isBot(userAgent)) {
        db.prepare(`
          INSERT INTO active_visitors (client_id, session_id, last_seen_at, page, device_type)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(client_id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            page = excluded.page,
            device_type = excluded.device_type,
            session_id = excluded.session_id
        `).run(clientId, sessionId, Date.now(), page, device);
      }

      return jsonResponse(res, 200, { ok: true });
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid payload' });
    }
  }

  // ------------------------------------------
  // 3. API DE RASTREAMENTO: /api/track/event
  // ------------------------------------------
  if (pathname === '/api/track/event' && method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const eventType = data.event_type;
      const clientId = data.client_id;
      const sessionId = data.session_id || 'session';
      const buttonLocation = data.button_location || null;
      const pagePath = (data.page_path || '/').slice(0, 100);
      const deviceType = ['mobile', 'desktop', 'tablet'].includes(data.device_type) ? data.device_type : 'desktop';
      const referrerDomain = sanitizeUrlParam(data.referrer_domain);
      const utmSource = sanitizeUrlParam(data.utm_source);
      const utmMedium = sanitizeUrlParam(data.utm_medium);
      const utmCampaign = sanitizeUrlParam(data.utm_campaign);
      const dedupToken = data.dedup_token ? String(data.dedup_token).slice(0, 64) : null;

      // Exclui acessos do /admin das métricas públicas
      if (pagePath.startsWith('/admin')) {
        return jsonResponse(res, 200, { ok: true, ignored: true });
      }

      const botFlag = isBot(userAgent);
      const ipH = hashIp(clientIp);
      const ipDisplay = maskIpForDisplay(clientIp);
      const now = Date.now();
      const isoDate = new Date().toISOString();

      if (clientId && ['pageview', 'click_download', 'download_request'].includes(eventType)) {
        db.prepare(`
          INSERT OR IGNORE INTO events (
            event_type, client_id, session_id, button_location, page_path,
            referrer_domain, utm_source, utm_medium, utm_campaign, device_type,
            ip_hash, ip_display, user_agent, is_bot, dedup_token, created_at, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          eventType, clientId, sessionId, buttonLocation, pagePath,
          referrerDomain, utmSource, utmMedium, utmCampaign, deviceType,
          ipH, ipDisplay, userAgent.slice(0, 255), botFlag, dedupToken, isoDate, now
        );
      }

      return jsonResponse(res, 200, { ok: true });
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid event payload' });
    }
  }

  // ------------------------------------------
  // 4. AUTENTICAÇÃO: /api/auth/*
  // ------------------------------------------
  if (pathname === '/api/auth/login' && method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const username = (data.username || '').trim();
      const password = (data.password || '');

      if (!username || !password) {
        return jsonResponse(res, 400, { error: 'Informe usuário e senha.' });
      }

      const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
      if (!admin || !verifyPassword(password, admin.salt, admin.password_hash)) {
        return jsonResponse(res, 401, { error: 'Credenciais inválidas.' });
      }

      // Cria sessão de 24 horas
      const sessionId = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + (24 * 60 * 60 * 1000);
      const nowIso = new Date().toISOString();

      db.prepare(`
        INSERT INTO admin_sessions (id, admin_id, expires_at, created_at, ip_prefix)
        VALUES (?, ?, ?, ?, ?)
      `).run(sessionId, admin.id, expiresAt, nowIso, maskIpForDisplay(clientIp));

      db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(nowIso, admin.id);

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `upplay_admin_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
      });
      return res.end(JSON.stringify({ ok: true, username: admin.username }));
    } catch {
      return jsonResponse(res, 500, { error: 'Erro interno ao autenticar.' });
    }
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const cookies = parseCookies(req);
    const sessionId = cookies['upplay_admin_session'];
    if (sessionId) {
      db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(sessionId);
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `upplay_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const session = authenticateAdmin(req);
    if (!session) {
      return jsonResponse(res, 401, { authenticated: false });
    }
    return jsonResponse(res, 200, { authenticated: true, username: session.username });
  }

  // ------------------------------------------
  // 5. APIS ADMINISTRATIVAS: /api/admin/*
  // ------------------------------------------
  if (pathname.startsWith('/api/admin/')) {
    const session = authenticateAdmin(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'Acesso não autorizado. Efetue login no painel.' });
    }

    // A. Visitantes ativos em tempo real (últimos 60s)
    if (pathname === '/api/admin/active-visitors' && method === 'GET') {
      const activeWindow = Date.now() - 60000;
      const row = db.prepare(`
        SELECT COUNT(DISTINCT client_id) as active_count
        FROM active_visitors
        WHERE last_seen_at > ?
      `).get(activeWindow);

      return jsonResponse(res, 200, {
        active_now: row.active_count || 0,
        window_seconds: 60,
        updated_at: new Date().toISOString()
      });
    }

    // B. Métricas completas consolidadas com filtros
    if (pathname === '/api/admin/metrics' && method === 'GET') {
      const period = parsedUrl.query.period || 'today';
      const now = new Date();
      let startMs = 0;
      let endMs = Date.now();

      // Ajuste de fuso horário America/Sao_Paulo (UTC-3)
      const spOffsetMs = -3 * 60 * 60 * 1000;
      const spNow = new Date(now.getTime() + spOffsetMs);

      if (period === 'today') {
        const startOfDay = new Date(Date.UTC(spNow.getUTCFullYear(), spNow.getUTCMonth(), spNow.getUTCDate(), 3, 0, 0));
        startMs = startOfDay.getTime();
      } else if (period === '7d') {
        startMs = Date.now() - (7 * 24 * 60 * 60 * 1000);
      } else if (period === '30d') {
        startMs = Date.now() - (30 * 24 * 60 * 60 * 1000);
      } else if (period === 'custom') {
        const customStart = parsedUrl.query.start ? new Date(parsedUrl.query.start).getTime() : 0;
        const customEnd = parsedUrl.query.end ? new Date(parsedUrl.query.end).getTime() + (24 * 60 * 60 * 1000) : Date.now();
        startMs = isNaN(customStart) ? 0 : customStart;
        endMs = isNaN(customEnd) ? Date.now() : customEnd;
      }

      // 1. Visitantes ativos agora (sempre últimos 60s)
      const activeRow = db.prepare(`
        SELECT COUNT(DISTINCT client_id) as count 
        FROM active_visitors 
        WHERE last_seen_at > ?
      `).get(Date.now() - 60000);

      // 2. Visitantes únicos no período
      const uniqueVisitorsRow = db.prepare(`
        SELECT COUNT(DISTINCT client_id) as count 
        FROM events 
        WHERE is_bot = 0 AND created_at_ms >= ? AND created_at_ms <= ?
      `).get(startMs, endMs);

      // Total de Pageviews e Sessões
      const pageviewsRow = db.prepare(`
        SELECT COUNT(*) as count 
        FROM events 
        WHERE event_type = 'pageview' AND is_bot = 0 AND created_at_ms >= ? AND created_at_ms <= ?
      `).get(startMs, endMs);

      const sessionsRow = db.prepare(`
        SELECT COUNT(DISTINCT session_id) as count 
        FROM events 
        WHERE is_bot = 0 AND created_at_ms >= ? AND created_at_ms <= ?
      `).get(startMs, endMs);

      // 3. Cliques em Baixar
      const clicksRow = db.prepare(`
        SELECT COUNT(*) as total_clicks, COUNT(DISTINCT client_id) as unique_clickers 
        FROM events 
        WHERE event_type = 'click_download' AND is_bot = 0 AND created_at_ms >= ? AND created_at_ms <= ?
      `).get(startMs, endMs);

      // 4. Solicitações de Download
      const downloadsRow = db.prepare(`
        SELECT COUNT(*) as total_requests, COUNT(DISTINCT client_id) as unique_requesters 
        FROM events 
        WHERE event_type = 'download_request' AND is_bot = 0 AND created_at_ms >= ? AND created_at_ms <= ?
      `).get(startMs, endMs);

      // 5. Taxa de clique (visitantes únicos que clicaram / visitantes únicos totais)
      const uniqueVisitors = uniqueVisitorsRow.count || 0;
      const uniqueClickers = clicksRow.unique_clickers || 0;
      const clickRate = uniqueVisitors > 0 ? ((uniqueClickers / uniqueVisitors) * 100).toFixed(1) : '0.0';

      // Desempenho por posição do botão
      const buttonLocations = db.prepare(`
        SELECT button_location, COUNT(*) as count, COUNT(DISTINCT client_id) as unique_users
        FROM events
        WHERE event_type = 'click_download' AND is_bot = 0 AND created_at_ms >= ? AND created_at_ms <= ?
        GROUP BY button_location
        ORDER BY count DESC
      `).all(startMs, endMs);

      // Distribuição por Dispositivo
      const devices = db.prepare(`
        SELECT device_type, COUNT(DISTINCT client_id) as count
        FROM events
        WHERE is_bot = 0 AND created_at_ms >= ? AND created_at_ms <= ?
        GROUP BY device_type
      `).all(startMs, endMs);

      // Origem por Domínio de Referência
      const referrers = db.prepare(`
        SELECT COALESCE(referrer_domain, 'Direto / Nenhum') as domain, COUNT(*) as count
        FROM events
        WHERE event_type = 'pageview' AND is_bot = 0 AND created_at_ms >= ? AND created_at_ms <= ?
        GROUP BY domain
        ORDER BY count DESC
        LIMIT 6
      `).all(startMs, endMs);

      // Origem por UTMs
      const utms = db.prepare(`
        SELECT 
          COALESCE(utm_source, '(direto)') as source,
          COALESCE(utm_medium, '(nenhum)') as medium,
          COALESCE(utm_campaign, '(nenhuma)') as campaign,
          COUNT(*) as count
        FROM events
        WHERE event_type = 'pageview' AND is_bot = 0 AND created_at_ms >= ? AND created_at_ms <= ? AND (utm_source IS NOT NULL OR utm_campaign IS NOT NULL)
        GROUP BY source, medium, campaign
        ORDER BY count DESC
        LIMIT 6
      `).all(startMs, endMs);

      // Série Temporal para o Gráfico (Agrupado por hora ou por dia)
      const isSingleDay = (endMs - startMs) <= (28 * 60 * 60 * 1000);
      const timePoints = [];

      if (isSingleDay) {
        // Agrupar por hora (24h)
        for (let h = 0; h < 24; h++) {
          const slotStart = startMs + (h * 3600 * 1000);
          const slotEnd = slotStart + (3600 * 1000);
          if (slotStart > endMs) break;

          const stats = db.prepare(`
            SELECT 
              SUM(CASE WHEN event_type = 'pageview' THEN 1 ELSE 0 END) as views,
              SUM(CASE WHEN event_type = 'click_download' THEN 1 ELSE 0 END) as clicks,
              SUM(CASE WHEN event_type = 'download_request' THEN 1 ELSE 0 END) as downloads
            FROM events
            WHERE is_bot = 0 AND created_at_ms >= ? AND created_at_ms < ?
          `).get(slotStart, slotEnd);

          timePoints.push({
            label: `${String(h).padStart(2, '0')}:00`,
            views: stats.views || 0,
            clicks: stats.clicks || 0,
            downloads: stats.downloads || 0
          });
        }
      } else {
        // Agrupar por dia
        const daysCount = Math.min(30, Math.ceil((endMs - startMs) / (24 * 3600 * 1000)));
        for (let d = daysCount - 1; d >= 0; d--) {
          const dayStart = endMs - ((d + 1) * 24 * 3600 * 1000);
          const dayEnd = endMs - (d * 24 * 3600 * 1000);
          const dateObj = new Date(dayEnd);
          const dateLabel = `${String(dateObj.getDate()).padStart(2, '0')}/${String(dateObj.getMonth() + 1).padStart(2, '0')}`;

          const stats = db.prepare(`
            SELECT 
              SUM(CASE WHEN event_type = 'pageview' THEN 1 ELSE 0 END) as views,
              SUM(CASE WHEN event_type = 'click_download' THEN 1 ELSE 0 END) as clicks,
              SUM(CASE WHEN event_type = 'download_request' THEN 1 ELSE 0 END) as downloads
            FROM events
            WHERE is_bot = 0 AND created_at_ms >= ? AND created_at_ms < ?
          `).get(dayStart, dayEnd);

          timePoints.push({
            label: dateLabel,
            views: stats.views || 0,
            clicks: stats.clicks || 0,
            downloads: stats.downloads || 0
          });
        }
      }

      return jsonResponse(res, 200, {
        period,
        timezone: 'America/Sao_Paulo',
        active_now: activeRow.count || 0,
        unique_visitors: uniqueVisitors,
        total_pageviews: pageviewsRow.count || 0,
        total_sessions: sessionsRow.count || 0,
        total_clicks: clicksRow.total_clicks || 0,
        unique_clickers: uniqueClickers,
        total_download_requests: downloadsRow.total_requests || 0,
        unique_requesters: downloadsRow.unique_requesters || 0,
        click_rate: clickRate,
        button_locations: buttonLocations,
        devices: devices,
        referrers: referrers,
        utms: utms,
        timeline: timePoints
      });
    }

    // C. Lista de Eventos Recentes
    if (pathname === '/api/admin/events' && method === 'GET') {
      const limit = Math.min(50, parseInt(parsedUrl.query.limit || '20', 10));
      const events = db.prepare(`
        SELECT id, event_type, button_location, page_path, device_type, ip_display, created_at, is_bot
        FROM events
        ORDER BY created_at_ms DESC
        LIMIT ?
      `).all(limit);

      return jsonResponse(res, 200, { events });
    }
  }

  // ------------------------------------------
  // 6. ROTAS VISUAIS DO PAINEL: /admin e /admin/login
  // ------------------------------------------
  if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin/index.html') {
    const session = authenticateAdmin(req);
    if (!session) {
      res.writeHead(302, { 'Location': '/admin/login' });
      return res.end();
    }
    if (parsedUrl.query.auth_token) {
      res.setHeader('Set-Cookie', `upplay_admin_session=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
    }
    return serveStatic(req, res, path.join(__dirname, 'admin', 'index.html'));
  }

  if (pathname === '/admin/login' || pathname === '/admin/login.html') {
    const session = authenticateAdmin(req);
    if (session) {
      res.writeHead(302, { 'Location': '/admin' });
      return res.end();
    }
    return serveStatic(req, res, path.join(__dirname, 'admin', 'login.html'));
  }

  // Arquivos estáticos do painel administrativo (/admin/*)
  if (pathname.startsWith('/admin/')) {
    const relativePath = pathname.replace(/^\/admin\//, '');
    const fullPath = path.join(__dirname, 'admin', relativePath);
    if (fs.existsSync(fullPath)) {
      return serveStatic(req, res, fullPath);
    }
  }

  // ------------------------------------------
  // 7. PÁGINA INTERMEDIÁRIA DE DOWNLOAD: /baixar
  // ------------------------------------------
  if (pathname === '/baixar' || pathname === '/baixar/' || pathname === '/baixar.html') {
    return serveStatic(req, res, path.join(__dirname, 'baixar.html'));
  }

  // ------------------------------------------
  // 8. ARQUIVOS ESTÁTICOS DO SITE (/ e /assets/*)
  // ------------------------------------------
  let staticPath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  
  // Previne Directory Traversal
  if (!staticPath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Proibido');
  }

  fs.stat(staticPath, (err, stats) => {
    if (!err && stats.isFile()) {
      return serveStatic(req, res, staticPath);
    }
    if (!err && stats.isDirectory()) {
      const indexFile = path.join(staticPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        return serveStatic(req, res, indexFile);
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — Recurso não encontrado.');
  });
});

// Inicialização do Servidor (se executado diretamente)
if (require.main === module || !process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`  UpPlay Web & Admin Server Ativo na porta ${PORT}`);
    console.log(`  Site público:  http://localhost:${PORT}/`);
    console.log(`  Painel Admin:  http://localhost:${PORT}/admin`);
    console.log(`  Fuso horário:  America/Sao_Paulo (UTC-3)`);
    console.log(`  Banco de dados SQLite: ${DB_PATH}`);
    console.log(`=======================================================`);
  });
}

module.exports = server;
