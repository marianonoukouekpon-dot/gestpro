/**
 * AgentControl - Système complet de contrôle d'agents & Points de Relais
 * Stockage : serveur (data/store.json) si disponible, sinon IndexedDB + localStorage
 */

// ===================== STATE & DB =====================
const DB_NAME = 'AgentControlDB';
const DB_VERSION = 2;
const API_BASE = './api';
let db = null;
let useServer = false; // true si le serveur AgentControl répond
let currentUser = null;
let currentView = 'dashboard';
let mapWatchId = null;
let html5QrCode = null;
let pendingConfirmPoint = null; // point scanné en attente de confirmation
const CONFIRM_INTERVAL_MS = 60 * 60 * 1000; // 1 heure

// Format QR : AGENTCONTROL|POINT|{pointId}
function makeQRPayload(pointId) {
  return `AGENTCONTROL|POINT|${pointId}`;
}
function parseQRPayload(text) {
  if (!text || typeof text !== 'string') return null;
  const parts = text.trim().split('|');
  if (parts.length === 3 && parts[0] === 'AGENTCONTROL' && parts[1] === 'POINT') {
    return { pointId: parts[2] };
  }
  // Fallback : accepter juste l'ID du point
  if (text.startsWith('p') || text.startsWith('id_')) return { pointId: text.trim() };
  return null;
}

const DEFAULT_DATA = {
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
  ]
};

// ===================== STOCKAGE LOCAL (sans serveur) =====================
// IndexedDB principal + miroir localStorage pour résilience hors-ligne
const LS_PREFIX = 'ac_db_';
const STORAGE_KEYS = ['users', 'points', 'checkins', 'assignments', 'initialized'];

function openDB() {
  return new Promise((resolve) => {
    // Pas d'IndexedDB (file:// strict, navigateur privé, etc.) → localStorage seul
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      db = null;
      resolve(null);
      return;
    }
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      resolve(val);
    };
    // Timeout : ne jamais bloquer l'écran de chargement
    const timer = setTimeout(() => {
      console.warn('IndexedDB timeout — bascule localStorage');
      db = null;
      finish(null);
    }, 4000);

    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => {
        clearTimeout(timer);
        console.warn('IndexedDB erreur — bascule localStorage', request.error);
        db = null;
        finish(null);
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        db = request.result;
        db.onversionchange = () => {
          try { db.close(); } catch (_) {}
        };
        finish(db);
      };
      request.onupgradeneeded = (e) => {
        try {
          const database = e.target.result;
          if (!database.objectStoreNames.contains('store')) {
            database.createObjectStore('store');
          }
        } catch (err) {
          console.warn(err);
        }
      };
      request.onblocked = () => {
        clearTimeout(timer);
        console.warn('IndexedDB bloqué — bascule localStorage');
        db = null;
        finish(null);
      };
    } catch (err) {
      clearTimeout(timer);
      console.warn(err);
      db = null;
      finish(null);
    }
  });
}

function lsGet(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw == null) return undefined;
    return JSON.parse(raw);
  } catch (_) {
    return undefined;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    return true;
  } catch (err) {
    // Quota dépassé (photos) : tenter sans photos pour les check-ins
    if (key === 'checkins' && Array.isArray(value)) {
      try {
        const light = value.map(c => {
          if (!c || !c.photo) return c;
          const { photo, ...rest } = c;
          return { ...rest, photo: null, photoOmitted: true };
        });
        localStorage.setItem(LS_PREFIX + key, JSON.stringify(light));
        return true;
      } catch (_) {}
    }
    console.warn('localStorage miroir échoué:', key, err);
    return false;
  }
}

/** Détecte si le serveur AgentControl (API) est disponible */
async function detectServer() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(API_BASE + '/health', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      useServer = !!(j && j.ok);
    } else {
      useServer = false;
    }
  } catch (_) {
    useServer = false;
  }
  return useServer;
}

async function apiGet(key) {
  const r = await fetch(API_BASE + '/data/' + encodeURIComponent(key), { cache: 'no-store' });
  if (!r.ok) throw new Error('API GET ' + key + ' : ' + r.status);
  return r.json();
}

async function apiPut(key, value) {
  const r = await fetch(API_BASE + '/data/' + encodeURIComponent(key), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || ('API PUT ' + key + ' : ' + r.status));
  }
  return r.json();
}

async function apiPostCheckin(checkin) {
  const r = await fetch(API_BASE + '/checkins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(checkin)
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || ('API POST checkin : ' + r.status));
  }
  return r.json();
}

async function localDbGet(key) {
  if (!db) {
    const fromLs = lsGet(key);
    return fromLs !== undefined ? fromLs : undefined;
  }
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('store', 'readonly');
      const req = tx.objectStore('store').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        const fallback = lsGet(key);
        if (fallback !== undefined) resolve(fallback);
        else reject(req.error);
      };
    } catch (err) {
      const fallback = lsGet(key);
      if (fallback !== undefined) resolve(fallback);
      else reject(err);
    }
  });
}

async function localDbSet(key, value) {
  lsSet(key, value);
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('store', 'readwrite');
      tx.objectStore('store').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch (_) {
      resolve();
    }
  });
}

async function dbGet(key) {
  if (useServer && ['users', 'points', 'checkins', 'assignments'].includes(key)) {
    try {
      const data = await apiGet(key);
      // Cache local pour lecture hors-ligne
      await localDbSet(key, data);
      return data;
    } catch (err) {
      console.warn('Lecture serveur échouée, fallback local:', key, err);
    }
  }
  return localDbGet(key);
}

async function dbSet(key, value) {
  // Toujours cacher en local
  await localDbSet(key, value);

  if (useServer && ['users', 'points', 'checkins', 'assignments'].includes(key)) {
    try {
      await apiPut(key, value);
    } catch (err) {
      console.warn('Écriture serveur échouée (données gardées en local):', key, err);
      // On ne bloque pas : le cache local reste valide ; prochaine sync possible
    }
  }
}

async function initData() {
  await detectServer();

  if (useServer) {
    // Charger depuis le serveur et peupler le cache local
    try {
      for (const k of ['users', 'points', 'checkins', 'assignments']) {
        const v = await apiGet(k);
        await localDbSet(k, v);
      }
      await localDbSet('initialized', true);
      updateStorageBadge();
      return;
    } catch (err) {
      console.warn('Init serveur échouée, passage en mode local:', err);
      useServer = false;
    }
  }

  const existing = await localDbGet('initialized');
  if (!existing) {
    const recovered = {};
    let hasRecovery = false;
    for (const k of ['users', 'points', 'checkins', 'assignments']) {
      const v = lsGet(k);
      if (v !== undefined) {
        recovered[k] = v;
        hasRecovery = true;
      }
    }
    if (hasRecovery) {
      await localDbSet('users', recovered.users || DEFAULT_DATA.users);
      await localDbSet('points', recovered.points || DEFAULT_DATA.points);
      await localDbSet('checkins', recovered.checkins || DEFAULT_DATA.checkins);
      await localDbSet('assignments', recovered.assignments || DEFAULT_DATA.assignments);
    } else {
      await localDbSet('users', DEFAULT_DATA.users);
      await localDbSet('points', DEFAULT_DATA.points);
      await localDbSet('checkins', DEFAULT_DATA.checkins);
      await localDbSet('assignments', DEFAULT_DATA.assignments);
    }
    await localDbSet('initialized', true);
  } else {
    for (const k of STORAGE_KEYS) {
      const v = await localDbGet(k);
      if (v !== undefined) lsSet(k, v);
    }
  }
  updateStorageBadge();
}

async function getUsers() { return (await dbGet('users')) || []; }
async function getPoints() { return (await dbGet('points')) || []; }
async function getCheckins() { return (await dbGet('checkins')) || []; }
async function getAssignments() { return (await dbGet('assignments')) || []; }

async function saveUsers(data) { await dbSet('users', data); }
async function savePoints(data) { await dbSet('points', data); }
async function saveCheckins(data) { await dbSet('checkins', data); }
async function saveAssignments(data) { await dbSet('assignments', data); }

/**
 * Enregistre un pointage :
 * - sur le serveur (partagé entre tous les utilisateurs) si disponible
 * - sinon en local (IndexedDB + localStorage)
 */
async function persistCheckin(checkin) {
  checkin.savedLocally = true;
  checkin.offline = typeof navigator !== 'undefined' ? !navigator.onLine : false;
  checkin.savedOnServer = false;

  // Toujours écrire en local d'abord
  const localList = (await localDbGet('checkins')) || [];
  if (!localList.some(c => c.id === checkin.id)) {
    localList.push(checkin);
    await localDbSet('checkins', localList);
  }

  if (useServer) {
    try {
      await apiPostCheckin(checkin);
      checkin.savedOnServer = true;
      // Rafraîchir le cache local depuis le serveur
      try {
        const remote = await apiGet('checkins');
        await localDbSet('checkins', remote);
      } catch (_) {}
      return checkin;
    } catch (err) {
      console.warn('Pointage non envoyé au serveur, conservé en local:', err);
      // Garde locale OK
    }
  }

  const verify = (await localDbGet('checkins')) || [];
  if (!verify.some(c => c.id === checkin.id)) {
    throw new Error('Échec de la sauvegarde du pointage');
  }
  return checkin;
}

/**
 * Envoie au serveur les pointages encore uniquement locaux (mode hors-ligne → reprise).
 * Ainsi l’admin voit partout les mouvements même s’ils ont été faits sans réseau.
 */
async function syncPendingCheckins() {
  if (!useServer) return { sent: 0 };
  const localList = (await localDbGet('checkins')) || [];
  const pending = localList.filter(c => c && c.id && !c.savedOnServer);
  let sent = 0;
  for (const c of pending) {
    try {
      await apiPostCheckin(c);
      c.savedOnServer = true;
      sent++;
    } catch (err) {
      console.warn('Sync pointage différé échouée:', c.id, err);
    }
  }
  if (sent > 0) {
    try {
      const remote = await apiGet('checkins');
      // Fusionner : garder les flags savedOnServer côté local
      const byId = new Map((remote || []).map(r => [r.id, r]));
      for (const c of localList) {
        if (c.savedOnServer && byId.has(c.id)) {
          byId.get(c.id).savedOnServer = true;
        } else if (c.savedOnServer && !byId.has(c.id)) {
          byId.set(c.id, c);
        }
      }
      await localDbSet('checkins', Array.from(byId.values()));
    } catch (_) {
      await localDbSet('checkins', localList);
    }
  }
  return { sent };
}

let adminRefreshTimer = null;
function startAdminLiveRefresh() {
  stopAdminLiveRefresh();
  if (!useServer || !currentUser || currentUser.role !== 'admin') return;
  // Rafraîchit les mouvements toutes les 45 s pour l’admin (n’importe où dans le monde)
  adminRefreshTimer = setInterval(async () => {
    if (!useServer || !currentUser || currentUser.role !== 'admin') {
      stopAdminLiveRefresh();
      return;
    }
    if (document.hidden) return;
    try {
      await detectServer();
      if (!useServer) return;
      await syncPendingCheckins();
      if (['dashboard', 'checkins', 'reports'].includes(currentView)) {
        await renderView(currentView);
      }
    } catch (e) {
      console.warn('Rafraîchissement admin:', e);
    }
  }, 45000);
}
function stopAdminLiveRefresh() {
  if (adminRefreshTimer) {
    clearInterval(adminRefreshTimer);
    adminRefreshTimer = null;
  }
}

function updateStorageBadge() {
  const local = document.getElementById('local-badge');
  if (!local) return;
  local.classList.remove('hidden');
  local.classList.add('inline-flex');
  if (useServer) {
    local.textContent = 'Serveur';
    local.title = 'Données partagées sur le serveur — l’admin voit les mouvements depuis n’importe où dans le monde';
    local.className = 'inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30';
  } else {
    local.textContent = 'Local';
    local.title = 'Données stockées dans ce navigateur uniquement';
    local.className = 'inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/25';
  }
}

// ===================== UTILS =====================
function uid() {
  return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function toast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  el.classList.remove('hidden', 'hide');
  el.classList.add('show');
  clearTimeout(el._toastTimer);
  el._toastTimer = setTimeout(() => {
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => {
      el.classList.add('hidden');
      el.classList.remove('hide');
    }, 300);
  }, duration);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000; // mètres
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Échappe le HTML pour éviter de casser le DOM / XSS dans les templates */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ===================== AUTH =====================
async function login(username, password) {
  const users = await getUsers();
  const user = users.find(u => u.username === username && u.password === password && u.active);
  if (!user) {
    toast('Identifiants incorrects');
    return false;
  }
  currentUser = { ...user };
  delete currentUser.password;
  localStorage.setItem('ac_session', JSON.stringify(currentUser));
  return true;
}

function logout() {
  currentUser = null;
  stopAdminLiveRefresh();
  localStorage.removeItem('ac_session');
  showLogin();
}

function restoreSession() {
  try {
    const raw = localStorage.getItem('ac_session');
    if (raw) {
      currentUser = JSON.parse(raw);
      return true;
    }
  } catch (e) {}
  return false;
}

// ===================== UI HELPERS =====================
function showLogin() {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('main-app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.body.classList.remove('app-ready');
}

function updateConnectivityBadge() {
  const offline = document.getElementById('offline-badge');
  const local = document.getElementById('local-badge');
  if (local) {
    local.classList.remove('hidden');
    local.classList.add('inline-flex');
  }
  if (!offline) return;
  if (navigator.onLine) {
    offline.classList.add('hidden');
    offline.classList.remove('inline-flex');
  } else {
    offline.classList.remove('hidden');
    offline.classList.add('inline-flex');
  }
}

function showApp() {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('main-app').classList.remove('hidden');
  document.body.classList.add('app-ready');
  document.getElementById('header-user').textContent = currentUser.name;
  document.getElementById('header-role').textContent = currentUser.role === 'admin' ? 'Administrateur' : 'Agent terrain';
  updateConnectivityBadge();
  updateStorageBadge();
  renderNav();
  navigate(currentUser.role === 'admin' ? 'dashboard' : 'agent-home');
  if (useServer && currentUser.role === 'admin') {
    startAdminLiveRefresh();
    syncPendingCheckins().catch(() => {});
  }
}

function renderNav() {
  const nav = document.getElementById('nav-tabs');
  const isAdmin = currentUser.role === 'admin';
  const tabs = isAdmin
    ? [
        { id: 'dashboard', label: 'Tableau de bord', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
        { id: 'points', label: 'Points de relais', icon: 'M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z' },
        { id: 'agents', label: 'Agents', icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z' },
        { id: 'checkins', label: 'Présences', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
        { id: 'reports', label: 'Rapports', icon: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' }
      ]
    : [
        { id: 'agent-home', label: 'Accueil', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
        { id: 'agent-checkin', label: 'Pointer', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
        { id: 'agent-history', label: 'Historique', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' }
      ];

  nav.innerHTML = tabs.map(t => `
    <button data-view="${t.id}" class="nav-tab flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition whitespace-nowrap
      ${currentView === t.id ? 'border-primary-600 text-primary-600' : 'border-transparent text-slate-500 hover:text-slate-700'}">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${t.icon}"/></svg>
      ${t.label}
    </button>
  `).join('');

  nav.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.view));
  });
}

let navToken = 0;

function navigate(view) {
  currentView = view;
  renderNav();
  // Arrêter le scan QR si on quitte la vue pointage
  if (view !== 'agent-checkin' && html5QrCode) {
    stopQRScan().catch(() => {});
  }
  const content = document.getElementById('content');
  if (!content) return;
  const token = ++navToken;
  content.classList.remove('page-enter');
  content.innerHTML = '<div class="flex justify-center py-16"><div class="relative w-12 h-12"><div class="absolute inset-0 rounded-full border-4 border-primary-100"></div><div class="absolute inset-0 rounded-full border-4 border-transparent border-t-primary-500 animate-spin"></div></div></div>';
  setTimeout(async () => {
    if (token !== navToken) return; // navigation plus récente en cours
    try {
      await renderView(view);
    } catch (err) {
      console.error(err);
      if (token !== navToken) return;
      content.innerHTML = `<div class="card p-6 text-center text-red-600"><p class="font-medium">Erreur d'affichage</p><p class="text-sm mt-1 text-slate-500">${escapeHtml(err.message || String(err))}</p></div>`;
      return;
    }
    if (token !== navToken) return;
    content.querySelectorAll('.hero-banner').forEach(h => {
      if (!h.querySelector('.hero-shine')) {
        const shine = document.createElement('div');
        shine.className = 'hero-shine';
        h.appendChild(shine);
      }
    });
    content.classList.remove('page-enter');
    void content.offsetWidth;
    content.classList.add('page-enter');
  }, 40);
}

// ===================== VIEWS =====================
async function renderView(view) {
  const content = document.getElementById('content');
  switch (view) {
    case 'dashboard': content.innerHTML = await viewDashboard(); break;
    case 'points': content.innerHTML = await viewPoints(); break;
    case 'agents': content.innerHTML = await viewAgents(); break;
    case 'checkins': content.innerHTML = await viewCheckins(); break;
    case 'reports': content.innerHTML = await viewReports(); break;
    case 'agent-home': content.innerHTML = await viewAgentHome(); break;
    case 'agent-checkin': content.innerHTML = await viewAgentCheckin(); break;
    case 'agent-confirm': content.innerHTML = await viewAgentConfirm(); break;
    case 'agent-history': content.innerHTML = await viewAgentHistory(); break;
    default: content.innerHTML = '<p>Vue non trouvée</p>';
  }
  bindViewEvents(view);
}

// ---------- DASHBOARD ----------
async function viewDashboard() {
  const [points, users, checkins] = await Promise.all([getPoints(), getUsers(), getCheckins()]);
  const agents = users.filter(u => u.role === 'agent' && u.active);
  const today = todayISO();
  const todayCheckins = checkins.filter(c => c.timestamp.startsWith(today));
  const presentAgentIds = [...new Set(todayCheckins.map(c => c.agentId))];

  // Derniers check-ins
  const recent = [...checkins].sort((a,b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 8);

  return `
    <div class="space-y-6">
      <div class="hero-banner p-5 sm:p-6 animate-scale-in">
        <div class="relative z-10">
          <p class="text-sky-200 text-xs font-medium uppercase tracking-wider mb-1">Administration</p>
          <h2 class="text-xl sm:text-2xl font-bold">Tableau de bord</h2>
          <p class="text-sky-100/80 text-sm mt-1">${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>
      </div>

      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 stagger">
        <div class="card stat-card p-4">
          <div class="flex items-center gap-2 mb-1">
            <div class="icon-bubble w-8 h-8 bg-primary-100 text-primary-600">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
            </div>
            <p class="text-xs text-slate-500 font-medium">Agents actifs</p>
          </div>
          <p class="text-2xl font-bold text-slate-800 mt-1">${agents.length}</p>
        </div>
        <div class="card stat-card p-4">
          <div class="flex items-center gap-2 mb-1">
            <div class="w-8 h-8 rounded-lg bg-sky-100 text-sky-600 flex items-center justify-center">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/></svg>
            </div>
            <p class="text-xs text-slate-500 font-medium">Points de relais</p>
          </div>
          <p class="text-2xl font-bold text-slate-800 mt-1">${points.filter(p=>p.active).length}</p>
        </div>
        <div class="card stat-card p-4">
          <div class="flex items-center gap-2 mb-1">
            <div class="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
            <p class="text-xs text-slate-500 font-medium">Présents aujourd'hui</p>
          </div>
          <p class="text-2xl font-bold text-emerald-600 mt-1">${presentAgentIds.length}</p>
        </div>
        <div class="card stat-card p-4">
          <div class="flex items-center gap-2 mb-1">
            <div class="w-8 h-8 rounded-lg bg-violet-100 text-violet-600 flex items-center justify-center">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
            <p class="text-xs text-slate-500 font-medium">Check-ins du jour</p>
          </div>
          <p class="text-2xl font-bold text-primary-600 mt-1">${todayCheckins.length}</p>
        </div>
      </div>

      <div class="card overflow-hidden animate-slide-up" style="animation-delay:0.25s;animation-fill-mode:both">
        <div class="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-gradient-to-r from-slate-50 to-white">
          <h3 class="font-semibold text-slate-800 flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse-soft"></span>
            Dernières présences
          </h3>
          <button data-goto="checkins" class="text-sm text-primary-600 font-medium hover:underline">Voir tout</button>
        </div>
        <div class="divide-y divide-slate-50">
          ${recent.length === 0 ? `
            <div class="p-10 text-center">
              <div class="w-16 h-16 mx-auto mb-3 rounded-2xl bg-slate-100 flex items-center justify-center">
                <svg class="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
              </div>
              <p class="text-slate-400 text-sm">Aucun check-in pour le moment</p>
            </div>` :
            recent.map(c => {
              const agent = users.find(u => u.id === c.agentId);
              const point = points.find(p => p.id === c.pointId);
              return `
                <div class="px-4 py-3 flex items-center gap-3 hover:bg-slate-50/80 transition">
                  <div class="w-10 h-10 rounded-full bg-gradient-to-br from-primary-400 to-primary-600 text-white flex items-center justify-center font-bold text-sm shadow-sm">${(agent?.name||'?').charAt(0)}</div>
                  <div class="flex-1 min-w-0">
                    <p class="font-medium text-slate-800 truncate">${agent?.name || 'Inconnu'}</p>
                    <p class="text-xs text-slate-500 truncate">${point?.name || '—'} · ${formatDate(c.timestamp)}</p>
                  </div>
                  <span class="badge ${c.status === 'ok' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}">${c.status === 'ok' ? 'Validé' : 'Hors zone'}</span>
                </div>`;
            }).join('')
          }
        </div>
      </div>
    </div>`;
}

// Mapping des images QR pré-générées (par id de point)
const QR_IMAGES = {
  p1: 'QR_p1_Point_Relais_Cocody.png',
  p2: 'QR_p2_Point_Relais_Plateau.png',
  p3: 'QR_p3_Point_Relais_Yopougon.png',
  p4: 'QR_p4_Point_Relais_Bouake_Centre.png'
};

// ---------- POINTS DE RELAIS ----------
async function viewPoints() {
  const points = await getPoints();
  return `
    <div class="space-y-4">
      <div class="hero-banner p-5 animate-scale-in flex items-center justify-between gap-3 flex-wrap">
        <div class="relative z-10">
          <p class="text-sky-200 text-xs font-medium uppercase tracking-wider mb-1">Gestion</p>
          <h2 class="text-xl font-bold">Points de relais</h2>
          <p class="text-sky-100/80 text-sm mt-0.5">Codes QR uniques à imprimer sur site</p>
        </div>
        <button id="btn-add-point" class="btn relative z-10 bg-white text-primary-700 hover:bg-sky-50 text-sm font-semibold shadow-lg shrink-0">+ Ajouter</button>
      </div>
      <div class="space-y-3 stagger" id="points-list">
        ${points.map(p => {
          const qrSrc = QR_IMAGES[p.id];
          return `
          <div class="card p-4" data-id="${p.id}">
            <div class="flex items-start gap-3">
              ${qrSrc
                ? `<img src="${qrSrc}" alt="QR ${p.name}" class="qr-thumb shrink-0" loading="lazy" onerror="this.style.display='none'" />`
                : `<div class="w-14 h-14 rounded-xl bg-gradient-to-br from-primary-50 to-primary-100 flex items-center justify-center shrink-0 border border-primary-100">
                    <svg class="w-6 h-6 text-primary-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/></svg>
                  </div>`}
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <h3 class="font-semibold text-slate-800">${p.name}</h3>
                  <span class="badge ${p.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}">${p.active ? 'Actif' : 'Inactif'}</span>
                </div>
                <p class="text-sm text-slate-500 mt-0.5">${p.address || '—'}</p>
                <p class="text-xs text-slate-400 mt-1">Rayon : ${p.radius || 100} m · ID: ${p.id}</p>
              </div>
              <div class="flex gap-1 shrink-0">
                <button class="btn-qr-point p-2 rounded-lg hover:bg-primary-50 text-primary-600 transition" data-id="${p.id}" title="Voir / Imprimer le code QR">
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"/></svg>
                </button>
                <button class="btn-edit-point p-2 rounded-lg hover:bg-slate-100 text-slate-500 transition" data-id="${p.id}" title="Modifier">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                </button>
                <button class="btn-del-point p-2 rounded-lg hover:bg-red-50 text-red-500 transition" data-id="${p.id}" title="Supprimer">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
              </div>
            </div>
          </div>`;
        }).join('') || `
          <div class="text-center py-12">
            <div class="w-20 h-20 mx-auto mb-4 rounded-3xl bg-slate-100 flex items-center justify-center">
              <svg class="w-10 h-10 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/></svg>
            </div>
            <p class="text-slate-400">Aucun point de relais</p>
          </div>`}
      </div>
    </div>`;
}

// ---------- AGENTS ----------
async function viewAgents() {
  const [users, assignments, points] = await Promise.all([getUsers(), getAssignments(), getPoints()]);
  const agents = users.filter(u => u.role === 'agent');
  return `
    <div class="space-y-4">
      <div class="hero-banner p-5 animate-scale-in flex items-center justify-between gap-3 flex-wrap">
        <div class="relative z-10">
          <p class="text-sky-200 text-xs font-medium uppercase tracking-wider mb-1">Équipe</p>
          <h2 class="text-xl font-bold">Agents</h2>
          <p class="text-sky-100/80 text-sm mt-0.5">Assignation aux points de relais</p>
        </div>
        <button id="btn-add-agent" class="btn relative z-10 bg-white text-primary-700 hover:bg-sky-50 text-sm font-semibold shadow-lg shrink-0">+ Ajouter</button>
      </div>
      <div class="space-y-3 stagger">
        ${agents.map(a => {
          const assign = assignments.find(x => x.agentId === a.id);
          const pointNames = (assign?.pointIds || []).map(pid => points.find(p => p.id === pid)?.name).filter(Boolean);
          return `
            <div class="card p-4">
              <div class="flex items-start justify-between gap-3">
                <div class="flex items-center gap-3">
                  <div class="w-11 h-11 rounded-full bg-gradient-to-br from-primary-400 to-primary-600 text-white flex items-center justify-center font-bold shadow-md shadow-primary-500/20">${a.name.charAt(0)}</div>
                  <div>
                    <h3 class="font-semibold">${a.name}</h3>
                    <p class="text-sm text-slate-500">@${a.username} ${a.phone ? '· ' + a.phone : ''}</p>
                    <p class="text-xs text-slate-400 mt-1">${pointNames.length ? pointNames.join(', ') : 'Aucun point assigné'}</p>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <span class="badge ${a.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}">${a.active ? 'Actif' : 'Inactif'}</span>
                  <button class="btn-edit-agent p-2 rounded-lg hover:bg-slate-100 text-slate-500 transition" data-id="${a.id}">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                  </button>
                </div>
              </div>
            </div>`;
        }).join('') || '<p class="text-center text-slate-400 py-8">Aucun agent</p>'}
      </div>
    </div>`;
}

// ---------- CHECK-INS (Admin) ----------
async function viewCheckins() {
  const [checkins, users, points] = await Promise.all([getCheckins(), getUsers(), getPoints()]);
  const sorted = [...checkins].sort((a,b) => b.timestamp.localeCompare(a.timestamp));
  return `
    <div class="space-y-4">
      <div class="hero-banner p-5 animate-scale-in">
        <div class="relative z-10">
          <p class="text-sky-200 text-xs font-medium uppercase tracking-wider mb-1">Suivi</p>
          <h2 class="text-xl font-bold">Historique des présences</h2>
        </div>
      </div>
      <div class="card overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-slate-50 text-slate-600 text-left">
              <tr>
                <th class="px-4 py-3 font-medium">Date / Heure</th>
                <th class="px-4 py-3 font-medium">Agent</th>
                <th class="px-4 py-3 font-medium">Point de relais</th>
                <th class="px-4 py-3 font-medium">Méthode</th>
                <th class="px-4 py-3 font-medium">Statut</th>
                <th class="px-4 py-3 font-medium">Distance</th>
                <th class="px-4 py-3 font-medium">Photo</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${sorted.length === 0 ? '<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400">Aucun enregistrement</td></tr>' :
                sorted.map(c => {
                  const agent = users.find(u => u.id === c.agentId);
                  const point = points.find(p => p.id === c.pointId);
                  return `<tr class="hover:bg-slate-50">
                    <td class="px-4 py-3 whitespace-nowrap">${formatDate(c.timestamp)}</td>
                    <td class="px-4 py-3 font-medium">${c.agentName || agent?.name || '—'}</td>
                    <td class="px-4 py-3">${c.pointName || point?.name || '—'}</td>
                    <td class="px-4 py-3"><span class="badge ${c.method==='qr'?'bg-primary-100 text-primary-700':'bg-slate-100 text-slate-600'}">${c.method==='qr'?'Scan QR':'Manuel'}</span></td>
                    <td class="px-4 py-3"><span class="badge ${c.status==='ok'?'bg-emerald-100 text-emerald-700':'bg-amber-100 text-amber-700'}">${c.status==='ok'?'Validé':'Hors zone'}</span></td>
                    <td class="px-4 py-3">${c.distance != null ? Math.round(c.distance)+' m' : '—'}</td>
                    <td class="px-4 py-3">${c.photo ? `<button class="btn-view-photo text-primary-600 underline text-xs" data-photo="${c.id}">Voir</button>` : '—'}</td>
                  </tr>`;
                }).join('')
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

// ---------- REPORTS ----------
async function viewReports() {
  const [checkins, users, points] = await Promise.all([getCheckins(), getUsers(), getPoints()]);
  const agents = users.filter(u => u.role === 'agent');
  const today = todayISO();
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    last7.push(d.toISOString().slice(0,10));
  }

  const byDay = last7.map(day => ({
    day,
    count: checkins.filter(c => c.timestamp.startsWith(day)).length
  }));

  const byAgent = agents.map(a => ({
    name: a.name,
    total: checkins.filter(c => c.agentId === a.id).length,
    today: checkins.filter(c => c.agentId === a.id && c.timestamp.startsWith(today)).length
  }));

  return `
    <div class="space-y-6">
      <div class="hero-banner p-5 animate-scale-in">
        <div class="relative z-10">
          <p class="text-sky-200 text-xs font-medium uppercase tracking-wider mb-1">Analyse</p>
          <h2 class="text-xl font-bold">Rapports</h2>
        </div>
      </div>
      <div class="card p-5">
        <h3 class="font-semibold mb-4">Check-ins des 7 derniers jours</h3>
        <div class="flex items-end gap-2 h-32">
          ${byDay.map(d => {
            const max = Math.max(...byDay.map(x => x.count), 1);
            const h = Math.round((d.count / max) * 100);
            return `<div class="flex-1 flex flex-col items-center gap-1">
              <span class="text-xs font-medium text-slate-600">${d.count}</span>
              <div class="w-full bg-primary-100 rounded-t-lg relative" style="height:${Math.max(h,4)}%">
                <div class="absolute inset-0 bg-primary-500 rounded-t-lg"></div>
              </div>
              <span class="text-[10px] text-slate-400">${d.day.slice(8)}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="card overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-100"><h3 class="font-semibold">Performance par agent</h3></div>
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-slate-600 text-left">
            <tr><th class="px-4 py-3">Agent</th><th class="px-4 py-3">Aujourd'hui</th><th class="px-4 py-3">Total</th></tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            ${byAgent.map(a => `<tr><td class="px-4 py-3 font-medium">${a.name}</td><td class="px-4 py-3">${a.today}</td><td class="px-4 py-3">${a.total}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <button id="btn-export-csv" class="btn btn-secondary">Exporter CSV (tous les check-ins)</button>
    </div>`;
}

// ---------- AGENT HOME ----------
async function viewAgentHome() {
  const [points, assignments, checkins] = await Promise.all([getPoints(), getAssignments(), getCheckins()]);
  const assign = assignments.find(a => a.agentId === currentUser.id);
  const myPoints = points.filter(p => assign?.pointIds?.includes(p.id) && p.active);
  const today = todayISO();
  const myToday = checkins.filter(c => c.agentId === currentUser.id && c.timestamp.startsWith(today));

  return `
    <div class="space-y-5">
      <div class="hero-banner p-5 sm:p-6 animate-scale-in">
        <div class="relative z-10">
          <p class="text-sky-200 text-xs font-medium uppercase tracking-wider mb-1">Agent terrain</p>
          <h2 class="text-xl sm:text-2xl font-bold">Bonjour, ${currentUser.name.split(' ')[0]} 👋</h2>
          <p class="text-sky-100/80 text-sm mt-1">Voici vos points de relais du jour</p>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3 stagger">
        <div class="card stat-card p-4 text-center">
          <div class="w-10 h-10 mx-auto mb-2 rounded-xl bg-primary-100 text-primary-600 flex items-center justify-center">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </div>
          <p class="text-2xl font-bold text-primary-600">${myToday.length}</p>
          <p class="text-xs text-slate-500 mt-1">Check-ins aujourd'hui</p>
        </div>
        <div class="card stat-card p-4 text-center">
          <div class="w-10 h-10 mx-auto mb-2 rounded-xl bg-sky-100 text-sky-600 flex items-center justify-center">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/></svg>
          </div>
          <p class="text-2xl font-bold text-slate-800">${myPoints.length}</p>
          <p class="text-xs text-slate-500 mt-1">Points assignés</p>
        </div>
      </div>
      <div class="space-y-3">
        <h3 class="font-semibold text-slate-700 animate-slide-up">Vos points de relais</h3>
        <div class="stagger space-y-3">
        ${myPoints.length === 0 ? `
          <div class="card p-8 text-center">
            <div class="w-14 h-14 mx-auto mb-3 rounded-2xl bg-slate-100 flex items-center justify-center">
              <svg class="w-7 h-7 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/></svg>
            </div>
            <p class="text-slate-400 text-sm">Aucun point assigné. Contactez votre responsable.</p>
          </div>` :
          myPoints.map(p => {
            const done = myToday.some(c => c.pointId === p.id);
            const qrSrc = QR_IMAGES[p.id];
            return `
              <div class="card p-4 flex items-center gap-3">
                ${qrSrc
                  ? `<img src="${qrSrc}" alt="" class="qr-thumb shrink-0" loading="lazy" onerror="this.style.display='none';this.nextElementSibling&&this.nextElementSibling.classList.remove('hidden')" /><div class="hidden w-10 h-10 rounded-xl ${done ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-500'} flex items-center justify-center shrink-0">${done ? '✓' : '📍'}</div>`
                  : `<div class="w-10 h-10 rounded-xl ${done ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-500'} flex items-center justify-center shrink-0">${done ? '✓' : '📍'}</div>`}
                <div class="flex-1 min-w-0">
                  <p class="font-medium truncate">${p.name}</p>
                  <p class="text-xs text-slate-500 truncate">${p.address || ''}</p>
                </div>
                ${done ? '<span class="badge bg-emerald-100 text-emerald-700">Fait</span>' : '<span class="badge bg-amber-100 text-amber-700">À faire</span>'}
              </div>`;
          }).join('')
        }
        </div>
      </div>
      <button data-goto="agent-checkin" class="btn btn-primary w-full py-3.5 text-base animate-slide-up shadow-lg shadow-primary-600/25">
        <span class="inline-flex items-center gap-2">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"/></svg>
          Pointer maintenant
        </span>
      </button>
    </div>`;
}

// ---------- AGENT CHECK-IN ----------
async function viewAgentCheckin() {
  const [points, assignments] = await Promise.all([getPoints(), getAssignments()]);
  const assign = assignments.find(a => a.agentId === currentUser.id);
  const myPoints = points.filter(p => assign?.pointIds?.includes(p.id) && p.active);

  return `
    <div class="space-y-5">
      <div class="hero-banner p-5 animate-scale-in">
        <div class="relative z-10">
          <p class="text-sky-200 text-xs font-medium uppercase tracking-wider mb-1">Pointage</p>
          <h2 class="text-xl font-bold">Pointer une présence</h2>
          <p class="text-sky-100/80 text-sm mt-1">QR ou manuel · ${useServer ? 'enregistrement sur le serveur (visible par l’admin partout)' : 'enregistrement local (serveur non détecté)'}</p>
        </div>
      </div>

      <!-- BLOC SCAN QR (principal) -->
      <div class="card p-4 space-y-3 border-2 border-primary-200 bg-primary-50/30">
        <div class="flex items-center gap-2">
          <span class="text-2xl">📷</span>
          <div>
            <p class="font-semibold text-slate-800">Scanner le code QR du point</p>
            <p class="text-xs text-slate-500">Chaque code correspond à un point de relais précis</p>
          </div>
        </div>
        <div id="qr-reader" class="w-full overflow-hidden rounded-xl bg-black/5" style="min-height:0"></div>
        <button id="btn-start-scan" class="btn btn-primary w-full py-3">Démarrer le scan QR</button>
        <button id="btn-stop-scan" class="btn btn-secondary w-full py-2.5 hidden">Arrêter le scan</button>
        <div id="scan-result" class="hidden p-3 rounded-xl bg-emerald-50 text-emerald-800 text-sm font-medium"></div>
      </div>

      <div class="relative flex items-center gap-3">
        <div class="flex-1 h-px bg-slate-200"></div>
        <span class="text-xs text-slate-400">ou sélection manuelle</span>
        <div class="flex-1 h-px bg-slate-200"></div>
      </div>

      <div>
        <label class="block text-sm font-medium text-slate-600 mb-1.5">Point de relais</label>
        <select id="checkin-point" class="input">
          <option value="">— Choisir —</option>
          ${myPoints.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
        </select>
      </div>

      <div class="card p-4 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-slate-600">Votre position GPS</span>
          <button id="btn-locate" class="text-sm text-primary-600 font-medium">Actualiser</button>
        </div>
        <div id="location-status" class="text-sm text-slate-500">En attente de géolocalisation...</div>
        <div id="location-details" class="hidden text-xs text-slate-400 font-mono"></div>
        <div id="distance-info" class="hidden"></div>
      </div>

      <div>
        <label class="block text-sm font-medium text-slate-600 mb-1.5">Photo de preuve (recommandé)</label>
        <div class="flex gap-3">
          <label class="btn btn-secondary flex-1 text-center cursor-pointer">
            <input type="file" id="checkin-photo" accept="image/*" capture="environment" class="hidden" />
            📷 Prendre / Choisir
          </label>
        </div>
        <div id="photo-preview" class="mt-3 hidden">
          <img id="photo-img" class="w-full max-h-48 object-cover rounded-xl border border-slate-200" />
        </div>
      </div>

      <div>
        <label class="block text-sm font-medium text-slate-600 mb-1.5">Commentaire / Rapport (optionnel)</label>
        <textarea id="checkin-note" class="input" rows="2" placeholder="Ex: Contrôle effectué, stock OK..."></textarea>
      </div>

      <div class="p-3 rounded-xl bg-slate-100 text-sm text-slate-600">
        <strong>Agent identifié :</strong> ${currentUser.name} (@${currentUser.username})
      </div>

      <button id="btn-submit-checkin" class="btn btn-primary w-full py-3.5 text-base" disabled>
        Valider le pointage
      </button>
    </div>`;
}

// ---------- AGENT CONFIRM (après scan QR) ----------
async function viewAgentConfirm() {
  if (!pendingConfirmPoint) {
    return `
      <div class="text-center py-12 space-y-4">
        <p class="text-slate-500">Aucun point scanné.</p>
        <button data-goto="agent-checkin" class="btn btn-primary">Scanner un code QR</button>
      </div>`;
  }

  const point = pendingConfirmPoint;
  const checkins = await getCheckins();
  const myAtPoint = checkins
    .filter(c => c.agentId === currentUser.id && c.pointId === point.id)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const last = myAtPoint[0] || null;
  let canConfirm = true;
  let remainingMs = 0;
  let remainingText = '';

  if (last) {
    const lastTime = new Date(last.timestamp).getTime();
    const elapsed = Date.now() - lastTime;
    if (elapsed < CONFIRM_INTERVAL_MS) {
      canConfirm = false;
      remainingMs = CONFIRM_INTERVAL_MS - elapsed;
      const mins = Math.ceil(remainingMs / 60000);
      remainingText = mins >= 60
        ? `${Math.floor(mins / 60)} h ${mins % 60} min`
        : `${mins} min`;
    }
  }

  const nextConfirmAt = last
    ? new Date(new Date(last.timestamp).getTime() + CONFIRM_INTERVAL_MS)
    : null;

  return `
    <div class="space-y-5">
      <div class="text-center">
        <div class="w-16 h-16 mx-auto rounded-2xl bg-primary-100 text-primary-600 flex items-center justify-center text-3xl mb-3">📍</div>
        <h2 class="text-xl font-bold text-slate-800">Confirmer votre présence</h2>
        <p class="text-slate-500 text-sm mt-1">Vous devez confirmer toutes les heures</p>
      </div>

      <div class="card p-5 space-y-3">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center text-xl">🏢</div>
          <div>
            <p class="font-semibold text-slate-800">${point.name}</p>
            <p class="text-sm text-slate-500">${point.address || ''}</p>
          </div>
        </div>
        <div class="border-t border-slate-100 pt-3 text-sm text-slate-600">
          <p><strong>Agent :</strong> ${currentUser.name}</p>
          <p class="mt-1"><strong>Identifiant :</strong> @${currentUser.username}</p>
        </div>
      </div>

      ${last ? `
        <div class="card p-4 ${canConfirm ? 'bg-amber-50 border-amber-100' : 'bg-emerald-50 border-emerald-100'}">
          <p class="text-sm font-medium ${canConfirm ? 'text-amber-800' : 'text-emerald-800'}">
            ${canConfirm
              ? '⏰ Vous pouvez confirmer à nouveau'
              : `✅ Présence déjà confirmée. Prochaine confirmation dans <strong>${remainingText}</strong>`}
          </p>
          <p class="text-xs mt-1 ${canConfirm ? 'text-amber-600' : 'text-emerald-600'}">
            Dernière confirmation : ${formatDate(last.timestamp)}
            ${nextConfirmAt && !canConfirm ? ` · Prochaine à ${formatTime(nextConfirmAt.toISOString())}` : ''}
          </p>
        </div>
      ` : `
        <div class="card p-4 bg-primary-50 border-primary-100">
          <p class="text-sm text-primary-800">Première confirmation pour ce point aujourd’hui.</p>
        </div>
      `}

      <div class="card p-4 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-slate-600">Position GPS</span>
          <button id="btn-locate-confirm" class="text-sm text-primary-600 font-medium">Actualiser</button>
        </div>
        <div id="location-status-confirm" class="text-sm text-slate-500">En attente de géolocalisation...</div>
        <div id="distance-info-confirm" class="hidden"></div>
      </div>

      <div>
        <label class="block text-sm font-medium text-slate-600 mb-1.5">Photo (optionnel)</label>
        <label class="btn btn-secondary w-full text-center cursor-pointer">
          <input type="file" id="confirm-photo" accept="image/*" capture="environment" class="hidden" />
          📷 Prendre une photo
        </label>
        <div id="confirm-photo-preview" class="mt-3 hidden">
          <img id="confirm-photo-img" class="w-full max-h-40 object-cover rounded-xl border" />
        </div>
      </div>

      <div>
        <label class="block text-sm font-medium text-slate-600 mb-1.5">Commentaire (optionnel)</label>
        <textarea id="confirm-note" class="input" rows="2" placeholder="Ex: Présent sur le site..."></textarea>
      </div>

      <button id="btn-confirm-presence" class="btn btn-primary w-full py-4 text-base ${canConfirm ? '' : 'opacity-50 cursor-not-allowed'}" ${canConfirm ? '' : 'disabled'}>
        ${canConfirm ? '✅ Confirmer ma présence' : `⏳ Disponible dans ${remainingText}`}
      </button>

      <button data-goto="agent-checkin" class="btn btn-secondary w-full">Scanner un autre point</button>
    </div>`;
}

// ---------- AGENT HISTORY ----------
async function viewAgentHistory() {
  const [checkins, points] = await Promise.all([getCheckins(), getPoints()]);
  const mine = checkins.filter(c => c.agentId === currentUser.id).sort((a,b) => b.timestamp.localeCompare(a.timestamp));
  return `
    <div class="space-y-4">
      <div class="hero-banner p-5 animate-scale-in">
        <div class="relative z-10">
          <p class="text-sky-200 text-xs font-medium uppercase tracking-wider mb-1">Historique</p>
          <h2 class="text-xl font-bold">Mes pointages</h2>
        </div>
      </div>
      <div class="space-y-3 stagger">
        ${mine.length === 0 ? `
          <div class="card p-10 text-center">
            <div class="w-14 h-14 mx-auto mb-3 rounded-2xl bg-slate-100 flex items-center justify-center">
              <svg class="w-7 h-7 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
            <p class="text-slate-400 text-sm">Aucun pointage pour le moment</p>
          </div>` :
          mine.map(c => {
            const point = points.find(p => p.id === c.pointId);
            return `
              <div class="card p-4">
                <div class="flex items-start justify-between gap-2">
                  <div>
                    <p class="font-medium">${point?.name || '—'}</p>
                    <p class="text-xs text-slate-500 mt-0.5">${formatDate(c.timestamp)}</p>
                    ${c.note ? `<p class="text-sm text-slate-600 mt-2">${c.note}</p>` : ''}
                  </div>
                  <span class="badge ${c.status==='ok'?'bg-emerald-100 text-emerald-700':'bg-amber-100 text-amber-700'}">${c.status==='ok'?'Validé':'Hors zone'}</span>
                </div>
                ${c.photo ? `<img src="${c.photo}" class="mt-3 w-full max-h-40 object-cover rounded-xl" />` : ''}
              </div>`;
          }).join('')
        }
      </div>
    </div>`;
}

// ===================== EVENTS & LOGIC =====================
function bindViewEvents(view) {
  // Global goto buttons
  document.querySelectorAll('[data-goto]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.goto));
  });

  if (view === 'points') {
    document.getElementById('btn-add-point')?.addEventListener('click', () => openPointModal());
    document.querySelectorAll('.btn-edit-point').forEach(btn => {
      btn.addEventListener('click', async () => {
        const points = await getPoints();
        const p = points.find(x => x.id === btn.dataset.id);
        if (p) openPointModal(p);
      });
    });
    document.querySelectorAll('.btn-del-point').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Supprimer ce point de relais ?')) return;
        let points = await getPoints();
        points = points.filter(p => p.id !== btn.dataset.id);
        await savePoints(points);
        toast('Point supprimé');
        navigate('points');
      });
    });
    document.querySelectorAll('.btn-qr-point').forEach(btn => {
      btn.addEventListener('click', async () => {
        const points = await getPoints();
        const p = points.find(x => x.id === btn.dataset.id);
        if (p) showQRModal(p);
      });
    });
  }

  if (view === 'agents') {
    document.getElementById('btn-add-agent')?.addEventListener('click', () => openAgentModal());
    document.querySelectorAll('.btn-edit-agent').forEach(btn => {
      btn.addEventListener('click', async () => {
        const users = await getUsers();
        const a = users.find(x => x.id === btn.dataset.id);
        if (a) openAgentModal(a);
      });
    });
  }

  if (view === 'checkins') {
    document.querySelectorAll('.btn-view-photo').forEach(btn => {
      btn.addEventListener('click', async () => {
        const checkins = await getCheckins();
        const c = checkins.find(x => x.id === btn.dataset.photo);
        if (c?.photo) showPhotoModal(c.photo);
      });
    });
  }

  if (view === 'reports') {
    document.getElementById('btn-export-csv')?.addEventListener('click', exportCSV);
  }

  if (view === 'agent-checkin') {
    initCheckinLogic();
  }

  if (view === 'agent-confirm') {
    initConfirmLogic();
  }
}

// ---------- POINT MODAL ----------
function openPointModal(point = null) {
  const isEdit = !!point;
  const html = `
    <div class="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4" id="modal-overlay">
      <div class="bg-white rounded-3xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div class="p-5 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white">
          <h3 class="font-bold text-lg">${isEdit ? 'Modifier' : 'Nouveau'} point de relais</h3>
          <button id="modal-close" class="p-2 rounded-lg hover:bg-slate-100">✕</button>
        </div>
        <div class="p-5 space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1">Nom *</label>
            <input id="m-name" class="input" value="${escapeHtml(point?.name || '')}" placeholder="Ex: Point Relais Cocody" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Adresse</label>
            <input id="m-address" class="input" value="${escapeHtml(point?.address || '')}" placeholder="Adresse ou description" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-medium mb-1">Latitude *</label>
              <input id="m-lat" type="number" step="any" class="input" value="${point?.lat != null ? point.lat : ''}" placeholder="5.3600" />
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">Longitude *</label>
              <input id="m-lng" type="number" step="any" class="input" value="${point?.lng != null ? point.lng : ''}" placeholder="-3.9900" />
            </div>
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Rayon de validation (mètres)</label>
            <input id="m-radius" type="number" class="input" value="${point?.radius || 150}" />
          </div>
          <div class="flex items-center gap-2">
            <input type="checkbox" id="m-active" ${point?.active !== false ? 'checked' : ''} class="w-4 h-4" />
            <label for="m-active" class="text-sm">Point actif</label>
          </div>
          <button id="btn-use-my-location" class="btn btn-secondary w-full text-sm">📍 Utiliser ma position actuelle</button>
          <button id="btn-save-point" class="btn btn-primary w-full py-3">${isEdit ? 'Enregistrer' : 'Créer'}</button>
        </div>
      </div>
    </div>`;
  document.getElementById('modal-root').innerHTML = html;

  document.getElementById('modal-close').onclick = closeModal;
  document.getElementById('modal-overlay').onclick = (e) => { if (e.target.id === 'modal-overlay') closeModal(); };

  document.getElementById('btn-use-my-location').onclick = () => {
    if (!navigator.geolocation) return toast('Géolocalisation non supportée');
    navigator.geolocation.getCurrentPosition(pos => {
      document.getElementById('m-lat').value = pos.coords.latitude.toFixed(6);
      document.getElementById('m-lng').value = pos.coords.longitude.toFixed(6);
      toast('Position récupérée');
    }, () => toast('Impossible d\'obtenir la position'));
  };

  document.getElementById('btn-save-point').onclick = async () => {
    const name = document.getElementById('m-name').value.trim();
    const lat = parseFloat(document.getElementById('m-lat').value);
    const lng = parseFloat(document.getElementById('m-lng').value);
    if (!name || isNaN(lat) || isNaN(lng)) return toast('Nom, latitude et longitude obligatoires');
    const data = {
      id: point?.id || uid(),
      name,
      address: document.getElementById('m-address').value.trim(),
      lat, lng,
      radius: parseInt(document.getElementById('m-radius').value) || 150,
      active: document.getElementById('m-active').checked
    };
    let points = await getPoints();
    if (isEdit) points = points.map(p => p.id === data.id ? data : p);
    else points.push(data);
    await savePoints(points);
    toast(isEdit ? 'Point mis à jour' : 'Point créé');
    closeModal();
    navigate('points');
  };
}

// ---------- AGENT MODAL ----------
async function openAgentModal(agent = null) {
  const isEdit = !!agent;
  const [points, assignments] = await Promise.all([getPoints(), getAssignments()]);
  const currentAssign = assignments.find(a => a.agentId === agent?.id)?.pointIds || [];

  const html = `
    <div class="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4" id="modal-overlay">
      <div class="bg-white rounded-3xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div class="p-5 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white">
          <h3 class="font-bold text-lg">${isEdit ? 'Modifier' : 'Nouvel'} agent</h3>
          <button id="modal-close" class="p-2 rounded-lg hover:bg-slate-100">✕</button>
        </div>
        <div class="p-5 space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1">Nom complet *</label>
            <input id="m-name" class="input" value="${escapeHtml(agent?.name || '')}" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Identifiant *</label>
            <input id="m-username" class="input" value="${escapeHtml(agent?.username || '')}" ${isEdit ? 'disabled' : ''} />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">${isEdit ? 'Nouveau mot de passe (optionnel)' : 'Mot de passe *'}</label>
            <input id="m-password" type="password" class="input" value="${isEdit ? '' : 'agent123'}" placeholder="${isEdit ? 'Laisser vide pour ne pas changer' : ''}" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Téléphone</label>
            <input id="m-phone" class="input" value="${escapeHtml(agent?.phone || '')}" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">Points de relais assignés</label>
            <div class="space-y-2 max-h-40 overflow-y-auto">
              ${points.filter(p => p.active).map(p => `
                <label class="flex items-center gap-2 text-sm">
                  <input type="checkbox" class="m-point-cb" value="${p.id}" ${currentAssign.includes(p.id) ? 'checked' : ''} />
                  ${p.name}
                </label>
              `).join('') || '<p class="text-slate-400 text-sm">Aucun point actif</p>'}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <input type="checkbox" id="m-active" ${agent?.active !== false ? 'checked' : ''} class="w-4 h-4" />
            <label for="m-active" class="text-sm">Agent actif</label>
          </div>
          <button id="btn-save-agent" class="btn btn-primary w-full py-3">${isEdit ? 'Enregistrer' : 'Créer'}</button>
        </div>
      </div>
    </div>`;
  document.getElementById('modal-root').innerHTML = html;
  document.getElementById('modal-close').onclick = closeModal;
  document.getElementById('modal-overlay').onclick = (e) => { if (e.target.id === 'modal-overlay') closeModal(); };

  document.getElementById('btn-save-agent').onclick = async () => {
    const name = document.getElementById('m-name').value.trim();
    const username = document.getElementById('m-username').value.trim();
    if (!name || !username) return toast('Nom et identifiant obligatoires');
    let users = await getUsers();
    if (!isEdit && users.some(u => u.username === username)) return toast('Identifiant déjà utilisé');

    const pwdInput = document.getElementById('m-password')?.value || '';
    const data = {
      id: agent?.id || uid(),
      username,
      name,
      phone: document.getElementById('m-phone').value.trim(),
      role: 'agent',
      active: document.getElementById('m-active').checked,
      password: isEdit
        ? (pwdInput.trim() ? pwdInput : agent.password)
        : (pwdInput || 'agent123')
    };
    if (isEdit) users = users.map(u => u.id === data.id ? { ...u, ...data } : u);
    else users.push(data);
    await saveUsers(users);

    // Assignments
    const selected = [...document.querySelectorAll('.m-point-cb:checked')].map(cb => cb.value);
    let assigns = await getAssignments();
    assigns = assigns.filter(a => a.agentId !== data.id);
    assigns.push({ agentId: data.id, pointIds: selected });
    await saveAssignments(assigns);

    toast(isEdit ? 'Agent mis à jour' : 'Agent créé');
    closeModal();
    navigate('agents');
  };
}

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

function showPhotoModal(src) {
  document.getElementById('modal-root').innerHTML = `
    <div class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 modal-backdrop" id="modal-overlay">
      <div class="relative max-w-lg w-full modal-panel">
        <button id="modal-close" class="absolute -top-10 right-0 text-white text-2xl hover:scale-110 transition">✕</button>
        <img src="${src}" class="w-full rounded-2xl shadow-2xl" />
      </div>
    </div>`;
  document.getElementById('modal-close').onclick = closeModal;
  document.getElementById('modal-overlay').onclick = (e) => { if (e.target.id === 'modal-overlay') closeModal(); };
}

// ---------- QR CODE MODAL (Admin) ----------
function showQRModal(point) {
  const payload = makeQRPayload(point.id);
  const safeName = escapeHtml(point.name || '');
  const safeAddr = escapeHtml(point.address || '');
  document.getElementById('modal-root').innerHTML = `
    <div class="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4 modal-backdrop" id="modal-overlay">
      <div class="bg-white rounded-3xl w-full max-w-sm overflow-hidden modal-panel shadow-2xl">
        <div class="p-5 border-b border-slate-100 flex items-center justify-between">
          <h3 class="font-bold text-lg">Code QR – ${safeName}</h3>
          <button id="modal-close" class="p-2 rounded-lg hover:bg-slate-100 transition">✕</button>
        </div>
        <div class="p-6 flex flex-col items-center">
          <div id="qrcode-container" class="bg-white p-3 rounded-xl border border-slate-200 min-h-[220px] flex items-center justify-center"></div>
          <p class="text-sm text-slate-600 mt-4 text-center font-medium">${safeName}</p>
          <p class="text-xs text-slate-400 mt-1 text-center">${safeAddr}</p>
          <p class="text-[10px] text-slate-300 mt-2 font-mono break-all">${escapeHtml(payload)}</p>
          <p class="text-xs text-slate-500 mt-4 text-center">Imprimez ce code et placez-le au point de relais.<br>L’agent le scanne pour signaler sa présence.</p>
          <button id="btn-print-qr" class="btn btn-primary w-full mt-4">Imprimer / Télécharger</button>
        </div>
      </div>
    </div>`;
  document.getElementById('modal-close').onclick = closeModal;
  document.getElementById('modal-overlay').onclick = (e) => { if (e.target.id === 'modal-overlay') closeModal(); };

  const container = document.getElementById('qrcode-container');
  container.innerHTML = '';
  if (typeof QRCode === 'undefined') {
    container.innerHTML = '<p class="text-sm text-red-500 text-center p-4">Librairie QR non chargée. Rechargez la page (connexion internet requise la 1re fois).</p>';
  } else {
    try {
      new QRCode(container, {
        text: payload,
        width: 220,
        height: 220,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });
    } catch (err) {
      container.innerHTML = '<p class="text-sm text-red-500 text-center p-4">Erreur génération QR</p>';
      console.error(err);
    }
  }

  document.getElementById('btn-print-qr').onclick = () => {
    const canvas = container.querySelector('canvas');
    const img = container.querySelector('img');
    const src = canvas ? canvas.toDataURL('image/png') : (img ? img.src : null);
    if (src) {
      const link = document.createElement('a');
      link.download = `QR_${(point.name || 'point').replace(/\s+/g, '_')}.png`;
      link.href = src;
      link.click();
      toast('QR téléchargé');
    } else {
      window.print();
    }
  };
}

// ---------- CHECK-IN LOGIC ----------
let currentPosition = null;
let selectedPoint = null;
let photoData = null;
let scanMethod = null; // 'qr' | 'manual'

/** Compresse une photo pour le stockage local (évite les quotas IndexedDB/localStorage) */
function compressImageFile(file, maxSide = 960, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxSide / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        try {
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (err) {
          resolve(reader.result);
        }
      };
      img.onerror = () => resolve(reader.result);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

let qrScanBusy = false;

function initCheckinLogic() {
  currentPosition = null;
  selectedPoint = null;
  photoData = null;
  scanMethod = null;
  qrScanBusy = false;
  if (html5QrCode) {
    stopQRScan().catch(() => {});
  }

  const pointSelect = document.getElementById('checkin-point');
  const btnLocate = document.getElementById('btn-locate');
  const btnSubmit = document.getElementById('btn-submit-checkin');
  const photoInput = document.getElementById('checkin-photo');
  const btnStartScan = document.getElementById('btn-start-scan');
  const btnStopScan = document.getElementById('btn-stop-scan');

  if (pointSelect) {
    pointSelect.addEventListener('change', async () => {
      const points = await getPoints();
      selectedPoint = points.find(p => p.id === pointSelect.value) || null;
      scanMethod = selectedPoint ? 'manual' : null;
      updateDistanceInfo();
      updateSubmitState();
    });
  }

  if (btnLocate) btnLocate.addEventListener('click', getLocation);
  getLocation();

  if (photoInput) {
    photoInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        photoData = await compressImageFile(file);
      } catch (_) {
        photoData = null;
      }
      if (photoData) {
        document.getElementById('photo-preview')?.classList.remove('hidden');
        const img = document.getElementById('photo-img');
        if (img) img.src = photoData;
      }
    });
  }

  if (btnSubmit) btnSubmit.addEventListener('click', submitCheckin);

  btnStartScan?.addEventListener('click', startQRScan);
  btnStopScan?.addEventListener('click', () => stopQRScan());
}

async function startQRScan() {
  const readerEl = document.getElementById('qr-reader');
  const btnStart = document.getElementById('btn-start-scan');
  const btnStop = document.getElementById('btn-stop-scan');
  const resultEl = document.getElementById('scan-result');

  if (!window.Html5Qrcode) {
    toast('Bibliothèque de scan non chargée. Vérifiez votre connexion et rechargez.');
    return;
  }
  if (qrScanBusy) return;

  // Stopper un éventuel scan précédent
  await stopQRScan();

  try {
    qrScanBusy = true;
    html5QrCode = new Html5Qrcode('qr-reader');
    btnStart?.classList.add('hidden');
    btnStop?.classList.remove('hidden');
    resultEl?.classList.add('hidden');
    if (readerEl) readerEl.style.minHeight = '260px';

    let handled = false;
    await html5QrCode.start(
      { facingMode: 'environment' },
      { fps: 8, qrbox: { width: 220, height: 220 } },
      async (decodedText) => {
        if (handled) return;
        handled = true;
        const parsed = parseQRPayload(decodedText);
        if (!parsed) {
          handled = false;
          toast('Code QR non reconnu');
          return;
        }
        try {
          await stopQRScan();
        } catch (_) {}
        const points = await getPoints();
        const point = points.find(p => p.id === parsed.pointId);
        if (!point) {
          toast('Point de relais inconnu dans la base');
          return;
        }
        const assignments = await getAssignments();
        const assign = assignments.find(a => a.agentId === currentUser.id);
        if (assign && assign.pointIds && assign.pointIds.length && !assign.pointIds.includes(point.id)) {
          toast('Attention : ce point ne vous est pas assigné');
        }

        pendingConfirmPoint = point;
        scanMethod = 'qr';
        selectedPoint = point;
        toast('Point scanné : ' + point.name);
        navigate('agent-confirm');
      },
      () => {}
    );
  } catch (err) {
    console.error(err);
    qrScanBusy = false;
    toast('Impossible d\'accéder à la caméra. Autorisez l\'accès ou utilisez HTTPS/localhost.');
    btnStart?.classList.remove('hidden');
    btnStop?.classList.add('hidden');
    try {
      if (html5QrCode) {
        await html5QrCode.clear();
      }
    } catch (_) {}
    html5QrCode = null;
  }
}

async function stopQRScan() {
  const btnStart = document.getElementById('btn-start-scan');
  const btnStop = document.getElementById('btn-stop-scan');
  const readerEl = document.getElementById('qr-reader');
  const scanner = html5QrCode;
  html5QrCode = null;
  qrScanBusy = false;
  if (scanner) {
    try {
      const state = typeof scanner.getState === 'function' ? scanner.getState() : null;
      // 2 = SCANNING in html5-qrcode
      if (state === 2 || state == null) {
        await scanner.stop();
      }
    } catch (_) {}
    try {
      scanner.clear();
    } catch (_) {}
  }
  if (btnStart) btnStart.classList.remove('hidden');
  if (btnStop) btnStop.classList.add('hidden');
  if (readerEl) {
    readerEl.style.minHeight = '0';
    readerEl.innerHTML = '';
  }
}

function getLocation() {
  const status = document.getElementById('location-status');
  const details = document.getElementById('location-details');
  if (!status) return;
  if (!navigator.geolocation) {
    status.textContent = 'Géolocalisation non supportée par ce navigateur';
    status.className = 'text-sm text-red-500';
    return;
  }
  status.textContent = 'Localisation en cours...';
  status.className = 'text-sm text-slate-500';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      currentPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      status.textContent = `Position obtenue (±${Math.round(pos.coords.accuracy)} m)`;
      status.className = 'text-sm text-emerald-600';
      if (details) {
        details.classList.remove('hidden');
        details.textContent = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
      }
      updateDistanceInfo();
      updateSubmitState();
    },
    (err) => {
      status.textContent = 'GPS indisponible : ' + (err.message || 'permission refusée') + ' — vous pouvez quand même pointer';
      status.className = 'text-sm text-amber-600';
      currentPosition = null;
      updateSubmitState();
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
}

function updateDistanceInfo() {
  const el = document.getElementById('distance-info');
  if (!el) return;
  if (!currentPosition || !selectedPoint || selectedPoint.lat == null || selectedPoint.lng == null) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const dist = haversine(currentPosition.lat, currentPosition.lng, selectedPoint.lat, selectedPoint.lng);
  const radius = selectedPoint.radius || 150;
  const ok = dist <= radius;
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="mt-2 p-3 rounded-xl ${ok ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'} text-sm">
      Distance au point : <strong>${Math.round(dist)} m</strong>
      (rayon autorisé : ${radius} m)<br>
      ${ok ? '✅ Vous êtes dans la zone' : '⚠️ Vous êtes hors de la zone (le pointage sera marqué "Hors zone")'}
    </div>`;
}

function updateSubmitState() {
  const btn = document.getElementById('btn-submit-checkin');
  if (!btn) return;
  // Point requis ; GPS recommandé mais pas obligatoire (fonctionne 100% hors-ligne)
  btn.disabled = !selectedPoint;
}

async function submitCheckin() {
  if (!selectedPoint) {
    toast('Choisissez un point de relais');
    return;
  }

  const btn = document.getElementById('btn-submit-checkin');
  if (btn) {
    btn.disabled = true;
    btn.textContent = useServer ? 'Enregistrement serveur...' : 'Enregistrement local...';
  }

  const note = document.getElementById('checkin-note')?.value.trim() || '';
  let dist = null;
  let status = 'ok';
  let lat = null, lng = null, accuracy = null;

  if (currentPosition && selectedPoint.lat != null) {
    lat = currentPosition.lat;
    lng = currentPosition.lng;
    accuracy = currentPosition.accuracy;
    dist = haversine(lat, lng, selectedPoint.lat, selectedPoint.lng);
    const radius = selectedPoint.radius || 150;
    status = dist <= radius ? 'ok' : 'out';
  } else if (!currentPosition) {
    status = 'ok'; // pointage local sans GPS (hors-ligne / permission refusée)
  }

  const checkin = {
    id: uid(),
    agentId: currentUser.id,
    agentName: currentUser.name,
    agentUsername: currentUser.username,
    pointId: selectedPoint.id,
    pointName: selectedPoint.name,
    timestamp: new Date().toISOString(),
    lat,
    lng,
    accuracy,
    distance: dist,
    status,
    method: scanMethod || 'manual',
    note: note || null,
    photo: photoData || null,
    savedLocally: true,
    offline: typeof navigator !== 'undefined' ? !navigator.onLine : true
  };

  try {
    await persistCheckin(checkin);
    const onServer = checkin.savedOnServer || useServer;
    const where = onServer ? 'sur le serveur' : 'localement';
    const msg = !currentPosition
      ? `Pointage enregistré ${where} (sans GPS) 💾`
      : status === 'ok'
        ? `Présence validée et enregistrée ${where} ✅`
        : `Pointage enregistré ${where} (hors zone) 💾`;
    toast(msg, 3500);
    if (html5QrCode) stopQRScan();
    navigate('agent-home');
  } catch (err) {
    console.error(err);
    toast('Erreur de sauvegarde : ' + (err.message || 'réessayez'));
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Valider le pointage';
    }
  }
}

// ---------- CONFIRM PRESENCE (page après scan QR, toutes les 1h) ----------
let confirmPhotoData = null;
let confirmPosition = null;

function initConfirmLogic() {
  confirmPhotoData = null;
  confirmPosition = null;

  document.getElementById('btn-locate-confirm')?.addEventListener('click', getConfirmLocation);
  getConfirmLocation();

  document.getElementById('confirm-photo')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      confirmPhotoData = await compressImageFile(file);
    } catch (_) {
      confirmPhotoData = null;
    }
    if (confirmPhotoData) {
      document.getElementById('confirm-photo-preview')?.classList.remove('hidden');
      const img = document.getElementById('confirm-photo-img');
      if (img) img.src = confirmPhotoData;
    }
  });

  document.getElementById('btn-confirm-presence')?.addEventListener('click', confirmPresence);
}

function getConfirmLocation() {
  const status = document.getElementById('location-status-confirm');
  const distEl = document.getElementById('distance-info-confirm');
  if (!status) return;
  if (!navigator.geolocation) {
    status.textContent = 'Géolocalisation non supportée';
    status.className = 'text-sm text-red-500';
    return;
  }
  status.textContent = 'Localisation en cours...';
  status.className = 'text-sm text-slate-500';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      confirmPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      status.textContent = `Position obtenue (±${Math.round(pos.coords.accuracy)} m)`;
      status.className = 'text-sm text-emerald-600';
      if (pendingConfirmPoint && distEl) {
        const dist = haversine(confirmPosition.lat, confirmPosition.lng, pendingConfirmPoint.lat, pendingConfirmPoint.lng);
        const radius = pendingConfirmPoint.radius || 150;
        const ok = dist <= radius;
        distEl.classList.remove('hidden');
        distEl.innerHTML = `<div class="mt-2 p-3 rounded-xl text-sm ${ok ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}">
          Distance : <strong>${Math.round(dist)} m</strong> (rayon ${radius} m) — ${ok ? '✅ Dans la zone' : '⚠️ Hors zone'}
        </div>`;
      }
    },
    (err) => {
      status.textContent = 'Erreur GPS : ' + (err.message || 'Permission refusée');
      status.className = 'text-sm text-red-500';
      confirmPosition = null;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

async function confirmPresence() {
  if (!pendingConfirmPoint) {
    toast('Aucun point sélectionné');
    return;
  }

  // Vérifier l'intervalle de 1 heure
  const checkins = await getCheckins();
  const myAtPoint = checkins
    .filter(c => c.agentId === currentUser.id && c.pointId === pendingConfirmPoint.id)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const last = myAtPoint[0];
  if (last) {
    const elapsed = Date.now() - new Date(last.timestamp).getTime();
    if (elapsed < CONFIRM_INTERVAL_MS) {
      const mins = Math.ceil((CONFIRM_INTERVAL_MS - elapsed) / 60000);
      toast(`Veuillez attendre encore ${mins} min avant de reconfirmer`);
      return;
    }
  }

  const pos = confirmPosition || { lat: null, lng: null, accuracy: null };
  let dist = null;
  let status = 'ok';
  if (pos.lat != null && pendingConfirmPoint.lat != null) {
    dist = haversine(pos.lat, pos.lng, pendingConfirmPoint.lat, pendingConfirmPoint.lng);
    status = dist <= (pendingConfirmPoint.radius || 150) ? 'ok' : 'out';
  }

  const note = document.getElementById('confirm-note')?.value.trim() || '';

  const checkin = {
    id: uid(),
    agentId: currentUser.id,
    agentName: currentUser.name,
    agentUsername: currentUser.username,
    pointId: pendingConfirmPoint.id,
    pointName: pendingConfirmPoint.name,
    timestamp: new Date().toISOString(),
    lat: pos.lat,
    lng: pos.lng,
    accuracy: pos.accuracy,
    distance: dist,
    status,
    method: 'qr',
    note: note || null,
    photo: confirmPhotoData || null,
    type: 'hourly_confirm',
    savedLocally: true,
    offline: typeof navigator !== 'undefined' ? !navigator.onLine : true
  };

  try {
    await persistCheckin(checkin);
    const where = checkin.savedOnServer || useServer ? 'sur le serveur' : 'localement';
    toast(`Présence confirmée · enregistrée ${where} ✅`, 3500);
    navigate('agent-confirm');
  } catch (err) {
    console.error(err);
    toast('Erreur de sauvegarde : ' + (err.message || 'réessayez'));
  }
}

// ---------- EXPORT CSV ----------
async function exportCSV() {
  const [checkins, users, points] = await Promise.all([getCheckins(), getUsers(), getPoints()]);
  const rows = [['Date', 'Agent', 'Identifiant', 'Point de relais', 'Méthode', 'Statut', 'Distance (m)', 'Note']];
  checkins.forEach(c => {
    const agent = users.find(u => u.id === c.agentId);
    const point = points.find(p => p.id === c.pointId);
    rows.push([
      formatDate(c.timestamp),
      c.agentName || agent?.name || '',
      c.agentUsername || agent?.username || '',
      c.pointName || point?.name || '',
      c.method === 'qr' ? 'Scan QR' : 'Manuel',
      c.status === 'ok' ? 'Validé' : 'Hors zone',
      c.distance != null ? Math.round(c.distance) : '',
      c.note || ''
    ]);
  });
  const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `presences_${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Export CSV téléchargé');
}

// ===================== INIT =====================
async function init() {
  // Fileté de secours : ne jamais rester bloqué sur "Chargement..."
  const safety = setTimeout(() => {
    const loading = document.getElementById('loading');
    if (loading && !loading.classList.contains('hidden')) {
      console.warn('Démarrage forcé après timeout');
      try { showLogin(); } catch (_) {
        loading.classList.add('hidden');
        document.getElementById('login-screen')?.classList.remove('hidden');
      }
    }
  }, 6000);

  try {
    await openDB();
    try {
      await initData();
    } catch (e) {
      console.warn('initData fallback local', e);
      // Garantir des données minimales en localStorage
      if (lsGet('users') === undefined) {
        lsSet('users', DEFAULT_DATA.users);
        lsSet('points', DEFAULT_DATA.points);
        lsSet('checkins', DEFAULT_DATA.checkins);
        lsSet('assignments', DEFAULT_DATA.assignments);
        lsSet('initialized', true);
      }
    }

    const btnLogin = document.getElementById('btn-login');
    const pwd = document.getElementById('login-password');
    const btnLogout = document.getElementById('btn-logout');

    if (btnLogin) {
      btnLogin.addEventListener('click', async () => {
        const u = document.getElementById('login-username')?.value.trim() || '';
        const p = document.getElementById('login-password')?.value || '';
        if (await login(u, p)) showApp();
      });
    }
    if (pwd) {
      pwd.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('btn-login')?.click();
      });
    }
    if (btnLogout) btnLogout.addEventListener('click', logout);

    if (restoreSession()) {
      showApp();
    } else {
      showLogin();
    }

    document.addEventListener('visibilitychange', () => {
      document.documentElement.classList.toggle('animations-paused', document.hidden);
    });

    window.addEventListener('online', async () => {
      await detectServer();
      updateConnectivityBadge();
      updateStorageBadge();
      if (useServer) {
        const { sent } = await syncPendingCheckins();
        if (sent > 0) toast(sent + ' pointage(s) synchronisé(s) sur le serveur');
        startAdminLiveRefresh();
      }
    });
    window.addEventListener('offline', () => {
      updateConnectivityBadge();
      updateStorageBadge();
    });
    updateConnectivityBadge();
    updateStorageBadge();
    if (useServer && currentUser && currentUser.role === 'admin') {
      startAdminLiveRefresh();
    }
  } catch (err) {
    console.error(err);
    try {
      showLogin();
      toast('Démarrage en mode secours : ' + (err.message || 'erreur'));
    } catch (_) {
      const loading = document.getElementById('loading');
      if (loading) {
        loading.innerHTML = `<div class="text-white text-center p-6"><p class="text-lg font-medium">Erreur de démarrage</p><p class="text-sm text-slate-400 mt-2">${err && err.message ? err.message : err}</p><button onclick="location.reload()" class="mt-4 px-4 py-2 bg-sky-500 rounded-xl">Recharger</button></div>`;
      }
    }
  } finally {
    clearTimeout(safety);
  }
}

// Démarrer dès que possible (DOM prêt)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { init(); });
} else {
  init();
}
