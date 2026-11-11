'use strict';

/**
 * Ma liste de courses — serveur
 * ------------------------------------------------------------------
 * - Liste partagée par lien secret (aucun compte, aucun mot de passe)
 * - Synchronisation temps réel via Server-Sent Events (SSE)
 * - Stockage : PostgreSQL si DATABASE_URL est défini (production Railway),
 *   sinon fichier JSON local (aperçu / développement).
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

const MAX_NAME = 120;
const MAX_QTY = 40;
const MAX_CATEGORY = 60;
const MAX_ITEMS = 300;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// En-têtes de sécurité (pas de X-Frame-Options : l’aperçu s’affiche dans une iframe)
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function newId(bytes = 12) {
  // 12 octets => 16 caractères base64url : impossible à deviner au hasard
  return crypto.randomBytes(bytes).toString('base64url');
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanName(value) {
  let name = cleanText(value, MAX_NAME);
  // "Pommes · 4" saisi d'un coup dans le champ principal
  const split = name.match(/^(.*?)\s*[·•]\s*([^·•]{1,40})$/);
  if (split && split[1].trim()) {
    return { name: split[1].trim(), quantity: split[2].trim() };
  }
  return { name, quantity: '' };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function nowIso() {
  return new Date().toISOString();
}

function publicList(list) {
  return {
    id: list.id,
    revision: Number(list.revision) || 0,
    createdAt: list.created_at || list.createdAt || nowIso(),
    updatedAt: list.updated_at || list.updatedAt || nowIso(),
    items: (list.items || []).map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity || '',
      category: item.category || '',
      done: Boolean(item.done),
      createdAt: item.created_at || item.createdAt,
      updatedAt: item.updated_at || item.updatedAt,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Stockage                                                            */
/* ------------------------------------------------------------------ */

let store = null;
let storageMode = 'file'; // 'postgres' | 'file'
let storageError = null;
let dbPool = null;

/** ---------- Stockage PostgreSQL ---------- */
function createPgStore(pool) {
  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS lists (
          id          TEXT PRIMARY KEY,
          revision    INTEGER NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS items (
          id          TEXT PRIMARY KEY,
          list_id     TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          quantity    TEXT NOT NULL DEFAULT '',
          category    TEXT NOT NULL DEFAULT '',
          done        BOOLEAN NOT NULL DEFAULT false,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      // Bases existantes : ajoute la colonne sans perdre les listes en cours
      await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '';`);
      await pool.query(`CREATE INDEX IF NOT EXISTS items_list_id_idx ON items (list_id);`);
    },

    async createList() {
      const id = newId();
      const { rows } = await pool.query(
        'INSERT INTO lists (id, revision) VALUES ($1, 1) RETURNING *',
        [id]
      );
      return publicList({ ...rows[0], items: [] });
    },

    async getList(id) {
      const { rows } = await pool.query('SELECT * FROM lists WHERE id = $1', [id]);
      if (!rows[0]) return null;
      const items = await pool.query(
        'SELECT * FROM items WHERE list_id = $1 ORDER BY created_at ASC, id ASC',
        [id]
      );
      return publicList({ ...rows[0], items: items.rows });
    },

    async addItem(listId, { name, quantity, category = '' }) {
      const list = await pool.query('SELECT id FROM lists WHERE id = $1', [listId]);
      if (!list.rows[0]) throw httpError(404, 'Liste introuvable.');

      const count = await pool.query('SELECT count(*)::int AS n FROM items WHERE list_id = $1', [listId]);
      if (count.rows[0].n >= MAX_ITEMS) throw httpError(400, 'La liste est pleine (300 articles maximum).');

      await pool.query(
        'INSERT INTO items (id, list_id, name, quantity, category) VALUES ($1, $2, $3, $4, $5)',
        [newId(), listId, name, quantity, category]
      );
      return this.touch(listId);
    },

    async updateItem(listId, itemId, patch) {
      const sets = [];
      const values = [listId, itemId];
      let i = 3;
      if (patch.name !== undefined) { sets.push(`name = $${i++}`); values.push(patch.name); }
      if (patch.quantity !== undefined) { sets.push(`quantity = $${i++}`); values.push(patch.quantity); }
      if (patch.category !== undefined) { sets.push(`category = $${i++}`); values.push(patch.category); }
      if (patch.done !== undefined) { sets.push(`done = $${i++}`); values.push(patch.done); }
      if (!sets.length) return this.getList(listId);

      sets.push('updated_at = now()');
      const { rowCount } = await pool.query(
        `UPDATE items SET ${sets.join(', ')} WHERE list_id = $1 AND id = $2`,
        values
      );
      if (!rowCount) throw httpError(404, 'Article introuvable.');
      return this.touch(listId);
    },

    async deleteItem(listId, itemId) {
      const { rowCount } = await pool.query(
        'DELETE FROM items WHERE list_id = $1 AND id = $2',
        [listId, itemId]
      );
      if (!rowCount) throw httpError(404, 'Article introuvable.');
      return this.touch(listId);
    },

    async touch(listId) {
      await pool.query(
        'UPDATE lists SET revision = revision + 1, updated_at = now() WHERE id = $1',
        [listId]
      );
      return this.getList(listId);
    },

    async close() {
      await pool.end();
    },
  };
}

/** ---------- Stockage fichier JSON (aperçu / local) ---------- */
function createFileStore() {
  let data = { lists: [] };
  let writeQueue = Promise.resolve();

  function persist() {
    const snapshot = JSON.stringify(data);
    writeQueue = writeQueue.then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DATA_FILE}.tmp`;
      await fsp.writeFile(tmp, snapshot);
      await fsp.rename(tmp, DATA_FILE);
    }).catch((err) => {
      console.error('[store] écriture impossible :', err.message);
    });
    return writeQueue;
  }

  function find(listId) {
    const list = data.lists.find((l) => l.id === listId);
    if (!list) throw httpError(404, 'Liste introuvable.');
    return list;
  }

  function snapshot(list) {
    return publicList({
      ...list,
      items: [...list.items].sort((a, b) =>
        a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at)
      ),
    });
  }

  return {
    async init() {
      try {
        const raw = await fsp.readFile(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.lists)) data = parsed;
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('[store] fichier illisible, on repart à vide :', err.message);
      }
    },

    async createList() {
      const list = {
        id: newId(),
        revision: 1,
        created_at: nowIso(),
        updated_at: nowIso(),
        items: [],
      };
      data.lists.push(list);
      await persist();
      return snapshot(list);
    },

    async getList(listId) {
      const list = data.lists.find((l) => l.id === listId);
      return list ? snapshot(list) : null;
    },

    async addItem(listId, { name, quantity, category = '' }) {
      const list = find(listId);
      if (list.items.length >= MAX_ITEMS) throw httpError(400, 'La liste est pleine (300 articles maximum).');
      list.items.push({
        id: newId(),
        name,
        quantity,
        category,
        done: false,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return this.touch(listId);
    },

    async updateItem(listId, itemId, patch) {
      const list = find(listId);
      const item = list.items.find((it) => it.id === itemId);
      if (!item) throw httpError(404, 'Article introuvable.');
      if (patch.name !== undefined) item.name = patch.name;
      if (patch.quantity !== undefined) item.quantity = patch.quantity;
      if (patch.category !== undefined) item.category = patch.category;
      if (patch.done !== undefined) item.done = patch.done;
      item.updated_at = nowIso();
      return this.touch(listId);
    },

    async deleteItem(listId, itemId) {
      const list = find(listId);
      const index = list.items.findIndex((it) => it.id === itemId);
      if (index === -1) throw httpError(404, 'Article introuvable.');
      list.items.splice(index, 1);
      return this.touch(listId);
    },

    async touch(listId) {
      const list = find(listId);
      list.revision = (list.revision || 0) + 1;
      list.updated_at = nowIso();
      await persist();
      return snapshot(list);
    },

    async close() {
      await writeQueue;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Temps réel (SSE)                                                    */
/* ------------------------------------------------------------------ */

const subscribers = new Map(); // listId -> Set<res>

function subscribe(listId, res) {
  if (!subscribers.has(listId)) subscribers.set(listId, new Set());
  subscribers.get(listId).add(res);
  res.on('close', () => {
    const set = subscribers.get(listId);
    if (!set) return;
    set.delete(res);
    if (!set.size) subscribers.delete(listId);
  });
}

function broadcast(listId, list) {
  const set = subscribers.get(listId);
  if (!set || !set.size) return;
  const frame = `event: list\ndata: ${JSON.stringify({ list, at: nowIso() })}\n\n`;
  for (const res of set) {
    try {
      res.write(frame);
    } catch {
      set.delete(res);
    }
  }
}

// Battement de cœur pour garder les connexions ouvertes à travers les proxys
setInterval(() => {
  for (const set of subscribers.values()) {
    for (const res of set) {
      try {
        res.write(': ping\n\n');
      } catch {
        set.delete(res);
      }
    }
  }
}, 25000).unref();

/* ------------------------------------------------------------------ */
/* Routes API                                                          */
/* ------------------------------------------------------------------ */

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    storage: storageMode,
    databaseConfigured: storageMode === 'postgres',
    warning: storageMode === 'postgres' ? null : storageError || null,
    time: nowIso(),
  });
});

app.post('/api/lists', asyncRoute(async (req, res) => {
  const list = await store.createList();
  res.status(201).json({ list });
}));

app.get('/api/lists/:id', asyncRoute(async (req, res) => {
  const list = await store.getList(req.params.id);
  if (!list) throw httpError(404, 'Cette liste n’existe pas ou a été supprimée.');
  res.json({ list });
}));

// Flux temps réel : toute modification est poussée à tous les appareils
app.get('/api/lists/:id/events', asyncRoute(async (req, res) => {
  const list = await store.getList(req.params.id);
  if (!list) throw httpError(404, 'Cette liste n’existe pas ou a été supprimée.');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ revision: list.revision })}\n\n`);
  res.write(`event: list\ndata: ${JSON.stringify({ list, at: nowIso() })}\n\n`);

  subscribe(req.params.id, res);
  req.on('close', () => res.end());
}));

app.post('/api/lists/:id/items', asyncRoute(async (req, res) => {
  const raw = req.body && req.body.name;
  const cleaned = cleanName(raw);
  const name = cleaned.name;
  if (!name) throw httpError(400, 'Écris le nom de l’article.');

  const quantity = cleanText(req.body.quantity, MAX_QTY) || cleaned.quantity;
  const category = cleanText(req.body.category, MAX_CATEGORY);
  const list = await store.addItem(req.params.id, { name, quantity, category });
  broadcast(req.params.id, list);
  res.status(201).json({ list });
}));

app.patch('/api/lists/:id/items/:itemId', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.name !== undefined) {
    const name = cleanText(body.name, MAX_NAME);
    if (!name) throw httpError(400, 'Le nom de l’article ne peut pas être vide.');
    patch.name = name;
  }
  if (body.quantity !== undefined) patch.quantity = cleanText(body.quantity, MAX_QTY);
  if (body.category !== undefined) patch.category = cleanText(body.category, MAX_CATEGORY);
  if (body.done !== undefined) patch.done = Boolean(body.done);
  if (!Object.keys(patch).length) throw httpError(400, 'Aucune modification fournie.');

  const list = await store.updateItem(req.params.id, req.params.itemId, patch);
  broadcast(req.params.id, list);
  res.json({ list });
}));

app.delete('/api/lists/:id/items/:itemId', asyncRoute(async (req, res) => {
  const list = await store.deleteItem(req.params.id, req.params.itemId);
  broadcast(req.params.id, list);
  res.json({ list });
}));

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], etag: true, maxAge: 0 }));

// Lien de partage : /l/<id secret>
app.get('/l/:id', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Ressource introuvable.' });
  }
  return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({
    error: status >= 500 ? 'Une erreur est survenue. Réessaie dans un instant.' : err.message,
  });
});

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

function sslFor(url) {
  // En local et sur le réseau interne Railway, PostgreSQL ne parle pas SSL.
  // Pour une URL publique (proxy Railway, Neon, Supabase…), on accepte le certificat managé.
  if (/localhost|127\.0\.0\.1|railway\.internal|host\.docker\.internal/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectPostgres(url, attempts = 5) {
  const { Pool } = require('pg');
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pool = new Pool({
      connectionString: url,
      ssl: sslFor(url),
      max: 8,
      connectionTimeoutMillis: 8000,
    });
    try {
      const pgStore = createPgStore(pool);
      await pgStore.init();
      dbPool = pool;
      return pgStore;
    } catch (err) {
      lastError = err;
      try { await pool.end(); } catch { /* ignore */ }
      if (attempt < attempts) {
        console.warn(`[store] PostgreSQL indisponible (essai ${attempt}/${attempts}) : ${err.message}`);
        await sleep(2000 * attempt);
      }
    }
  }
  throw lastError;
}

async function initStore() {
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      store = await connectPostgres(url);
      storageMode = 'postgres';
      storageError = null;
      console.log('[store] PostgreSQL connecté — partage actif entre les appareils.');
      return;
    } catch (err) {
      storageError = `Connexion PostgreSQL impossible : ${err.message}`;
      console.error('[store] ' + storageError);
      dbPool = null;
    }
  } else {
    storageError =
      'DATABASE_URL n’est pas défini : les données sont enregistrées dans un fichier local ' +
      '(data/store.json). Le partage entre appareils fonctionne sur ce serveur, mais il n’est pas ' +
      'persistant sur Railway — ajoutez la variable DATABASE_URL après avoir créé la base PostgreSQL.';
    console.warn('[store] ' + storageError);
  }

  store = createFileStore();
  await store.init();
  storageMode = 'file';
}

async function start() {
  await initStore();
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ma liste de courses — http://localhost:${PORT} (stockage : ${storageMode})`);
  });

  const shutdown = async (signal) => {
    console.log(`\n[server] ${signal} reçu, arrêt en cours…`);
    server.close();
    for (const set of subscribers.values()) for (const res of set) res.end();
    try { if (store) await store.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[server] démarrage impossible :', err);
  process.exit(1);
});
