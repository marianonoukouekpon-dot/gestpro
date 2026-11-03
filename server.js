/**
 * AgentControl — Serveur d'hébergement
 * Sert les fichiers statiques + API JSON pour persister les données sur le serveur.
 * Aucune dépendance npm : Node.js natif uniquement.
 *
 * Démarrage :  node server.js
 * Puis ouvrir : http://localhost:8080
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

const DEFAULT_STORE = {
  users: [
    { id: 'u1', username: 'admin', password: 'admin123', name: 'Administrateur', role: 'admin', active: true },
    { id: 'u2', username: 'agent1', password: 'agent123', name: 'Kouassi Jean', role: 'agent', active: true, phone: '0700000001' },
    { id: 'u3', username: 'agent2', password: 'agent123', name: 'Awa Traoré', role: 'agent', active: true, phone: '0700000002' }
  ],
  points: [
    { id: 'p1', name: 'Point Relais Cocody', address: 'Cocody, Abidjan', lat: 5.3600, lng: -3.9900, radius: 150, active: true },
    { id: 'p2', name: 'Point Relais Plateau', address: 'Plateau, Abidjan', lat: 5.3200, lng: -4.0200, radius: 120, active: true },
    { id: 'p3', name: 'Point Relais Yopougon', address: 'Yopougon, Abidjan', lat: 5.3400, lng: -4.0800, radius: 180, active: true },
    { id: 'p4', name: 'Point Relais Bouaké Centre', address: 'Bouaké', lat: 7.6900, lng: -5.0300, radius: 200, active: true }
  ],
  checkins: [],
  assignments: [
    { agentId: 'u2', pointIds: ['p1', 'p2', 'p3'] },
    { agentId: 'u3', pointIds: ['p2', 'p3', 'p4'] }
  ],
  initialized: true
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

// ——— Stockage fichier (verrou simple en mémoire) ———
let writeQueue = Promise.resolve();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_STORE, null, 2), 'utf8');
  }
}

function readStore() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { ...DEFAULT_STORE, ...data };
  } catch (err) {
    console.error('Lecture store échouée, réinitialisation:', err.message);
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_STORE, null, 2), 'utf8');
    return { ...DEFAULT_STORE };
  }
}

function writeStore(store) {
  ensureDataDir();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function withStore(mutator) {
  writeQueue = writeQueue.then(() => {
    const store = readStore();
    const result = mutator(store);
    writeStore(store);
    return result;
  }).catch((err) => {
    console.error('Erreur écriture store:', err);
    throw err;
  });
  return writeQueue;
}

// ——— Helpers HTTP ———
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 15 * 1024 * 1024; // 15 Mo (photos)
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX) {
        reject(new Error('Corps trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : null);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const clean = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(ROOT, clean);
  if (!full.startsWith(ROOT)) return null;
  return full;
}

function serveStatic(req, res, urlPath) {
  let filePath = safePath(urlPath === '/' ? '/index.html' : urlPath);
  if (!filePath) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!path.extname(filePath) && fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || ext === '.js' ? 'no-cache' : 'public, max-age=86400'
    });
    res.end(data);
  });
}

// ——— API ———
async function handleApi(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // Santé
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, mode: 'server', storage: 'file', file: 'data/store.json' });
  }

  // Tout le store
  if (pathname === '/api/data' && req.method === 'GET') {
    return sendJson(res, 200, readStore());
  }

  // Une clé : users | points | checkins | assignments
  const keyMatch = pathname.match(/^\/api\/data\/(users|points|checkins|assignments)$/);
  if (keyMatch) {
    const key = keyMatch[1];
    if (req.method === 'GET') {
      const store = readStore();
      return sendJson(res, 200, store[key] ?? []);
    }
    if (req.method === 'PUT') {
      try {
        const body = await readBody(req);
        await withStore((store) => {
          store[key] = body;
          store.initialized = true;
        });
        return sendJson(res, 200, { ok: true, key });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }
  }

  // Ajout atomique d'un check-in (évite les écrasements concurrents)
  if (pathname === '/api/checkins' && req.method === 'POST') {
    try {
      const checkin = await readBody(req);
      if (!checkin || !checkin.id) {
        return sendJson(res, 400, { ok: false, error: 'checkin invalide' });
      }
      await withStore((store) => {
        if (!Array.isArray(store.checkins)) store.checkins = [];
        const exists = store.checkins.some((c) => c.id === checkin.id);
        if (!exists) store.checkins.push(checkin);
        store.initialized = true;
      });
      return sendJson(res, 201, { ok: true, id: checkin.id });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  sendJson(res, 404, { ok: false, error: 'API introuvable' });
}

// ——— Serveur ———
ensureDataDir();

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || 'localhost';
    const u = new URL(req.url || '/', `http://${host}`);
    const pathname = u.pathname;

    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname);
    }
    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Erreur serveur');
    }
  }
});

// Écoute sur toutes les interfaces (0.0.0.0) pour accès distant (pas seulement localhost)
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  AgentControl — serveur démarré (accès mondial)');
  console.log('  → Local   : http://localhost:' + PORT);
  console.log('  → Réseau  : http://<IP-de-cette-machine>:' + PORT);
  console.log('  → Public  : utilisez l’URL fournie par votre hébergeur (Railway, Render, VPS…)');
  console.log('  Données partagées : data/store.json (visibles par l’admin partout dans le monde)');
  console.log('');
});
