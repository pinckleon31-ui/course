'use strict';

/* ============================================================
   Ma liste de courses — logique client
   - route /            : accueil (créer une liste)
   - route /l/<secret>  : la liste partagée
   - thème clair / sombre (mémorisé, suit le système par défaut)
   - synchronisation temps réel (SSE) + secours par interrogation
   - mises à jour optimistes : l’interface répond tout de suite,
     puis se recale sur la version du serveur ; en cas d’échec,
     on annule et on propose « Réessayer ».
   ============================================================ */

const LAST_LIST_KEY = 'mlc:lastListId';
const THEME_KEY = 'mlc:theme';

const el = (id) => document.getElementById(id);

const ui = {
  viewHome: el('viewHome'),
  viewList: el('viewList'),
  viewMissing: el('viewMissing'),

  topbar: document.querySelector('.topbar'),
  createBtn: el('createBtn'),
  resumeBtn: el('resumeBtn'),
  resumeName: el('resumeName'),

  addForm: el('addForm'),
  nameInput: el('nameInput'),
  qtyInput: el('qtyInput'),
  addBtn: el('addBtn'),
  addError: el('addError'),
  catBtn: el('catBtn'),
  catBtnLabel: el('catBtnLabel'),

  copyBtn: el('copyBtn'),
  copyLabel: el('copyLabel'),
  headerShare: el('headerShare'),
  brandLink: el('brandLink'),
  themeToggle: el('themeToggle'),

  progressText: el('progressText'),
  progress: el('progress'),
  progressBar: el('progressBar'),
  syncState: el('syncState'),
  syncText: el('syncText'),

  todoList: el('todoList'),
  doneList: el('doneList'),
  todoCount: el('todoCount'),
  doneCount: el('doneCount'),
  emptyState: el('emptyState'),
  emptyCta: el('emptyCta'),
  doneEmpty: el('doneEmpty'),

  toast: el('toast'),
  toastText: el('toastText'),
  toastAction: el('toastAction'),

  banner: el('storageBanner'),
  bannerTitle: el('storageBannerTitle'),
  bannerText: el('storageBannerText'),
  bannerDetailsBtn: el('storageDetailsBtn'),
  bannerDetails: el('storageDetails'),
  bannerClose: el('storageBannerClose'),

  editDialog: el('editDialog'),
  editTitle: el('editTitle'),
  editForm: el('editForm'),
  editName: el('editName'),
  editQty: el('editQty'),
  editCategory: el('editCategory'),
  categorySuggestions: el('categorySuggestions'),
  editError: el('editError'),
  editSave: el('editSave'),
  editCancel: el('editCancel'),
  editDelete: el('editDelete'),
  deleteConfirm: el('deleteConfirm'),
  deleteQuestion: el('deleteQuestion'),
  confirmDelete: el('confirmDelete'),
  cancelDelete: el('cancelDelete'),

  catDialog: el('catDialog'),
  catForm: el('catForm'),
  catOptions: el('catOptions'),
  newCatInput: el('newCatInput'),
  createCatBtn: el('createCatBtn'),
  closeCatBtn: el('closeCatBtn'),
  catError: el('catError'),
};

const state = {
  view: 'home',
  listId: null,
  list: { id: null, revision: 0, items: [] },
  adding: false,
  editing: null,
  pendingCategory: '',
  source: null,
  pollTimer: null,
  bannerDismissed: false,
  dbOnline: null,
};

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

const clone = (value) => JSON.parse(JSON.stringify(value));

const plural = (n, singular, pluralForm) => `${n} ${n > 1 ? pluralForm : singular}`;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...options,
    });
  } catch {
    throw new Error('Pas de connexion. Vérifie ton réseau puis réessaie.');
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch { /* réponse vide */ }

  if (!response.ok) {
    const message = (payload && payload.error) || 'La modification n’a pas pu être enregistrée.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

let toastTimer = null;
function showToast(message, { error = false, action = null, duration = 3200 } = {}) {
  clearTimeout(toastTimer);
  ui.toastText.textContent = message;
  ui.toast.classList.toggle('is-error', Boolean(error));
  ui.toastAction.hidden = !action;
  ui.toastAction.textContent = action ? action.label : 'Réessayer';
  ui.toastAction.onclick = action
    ? () => {
        hideToast();
        action.onClick();
      }
    : null;
  ui.toast.hidden = false;
  requestAnimationFrame(() => ui.toast.classList.add('is-visible'));
  toastTimer = setTimeout(hideToast, action ? Math.max(duration, 7000) : duration);
}

function hideToast() {
  clearTimeout(toastTimer);
  ui.toast.classList.remove('is-visible');
  setTimeout(() => {
    if (!ui.toast.classList.contains('is-visible')) ui.toast.hidden = true;
  }, 220);
}

const SYNC_MESSAGES = {
  connecting: 'Connexion…',
  live: 'Synchronisé',
  polling: 'Synchronisé',
  offline: 'Reconnexion…',
  error: 'Hors connexion',
};

function setSync(kind, text) {
  ui.syncState.classList.remove('is-live', 'is-offline', 'is-error');
  if (kind === 'live' || kind === 'polling') ui.syncState.classList.add('is-live');
  else if (kind === 'offline') ui.syncState.classList.add('is-offline');
  else if (kind === 'error') ui.syncState.classList.add('is-error');

  ui.syncText.textContent = text || SYNC_MESSAGES[kind] || '';
  ui.syncState.title =
    kind === 'live'
      ? 'Les modifications apparaissent en direct sur les autres appareils'
      : kind === 'offline' || kind === 'error'
        ? 'Connexion perdue — les modifications seront réessayées'
        : 'Connexion au serveur';
}

/* ------------------------------------------------------------------ */
/* Thème clair / sombre                                                */
/* ------------------------------------------------------------------ */

function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function mediaQuery(query) {
  if (typeof window.matchMedia !== 'function') {
    return { matches: false, addEventListener: null, addListener: null };
  }
  return window.matchMedia(query);
}

const prefersDark = () => mediaQuery('(prefers-color-scheme: dark)');

function systemTheme() {
  return prefersDark().matches ? 'dark' : 'light';
}

function applyTheme(theme, { persist = false } = {}) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0d1411' : '#f6f7f4');
  const label = theme === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre';
  ui.themeToggle.setAttribute('aria-label', label);
  ui.themeToggle.title = theme === 'dark' ? 'Mode clair' : 'Mode sombre';
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch { /* mode privé */ }
  }
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next, { persist: true });
}

/* ------------------------------------------------------------------ */
/* Sous-catégories (repas, rayons…)                                    */
/* ------------------------------------------------------------------ */

function categoryStorageKey() {
  return state.listId ? `mlc:category:${state.listId}` : null;
}

function readStoredCategory() {
  const key = categoryStorageKey();
  if (!key) return '';
  try {
    return cleanCategory(localStorage.getItem(key));
  } catch {
    return '';
  }
}

function setPendingCategory(value) {
  state.pendingCategory = cleanCategory(value);
  const key = categoryStorageKey();
  if (key) {
    try {
      localStorage.setItem(key, state.pendingCategory);
    } catch { /* mode privé */ }
  }
  updateCategoryUi();
}

function updateCategoryUi() {
  const value = state.pendingCategory;
  ui.catBtnLabel.textContent = value || 'Catégorie';
  ui.catBtn.classList.toggle('is-set', Boolean(value));
  ui.catBtn.title = value
    ? `Catégorie : ${value} — toucher pour changer`
    : 'Choisir une catégorie (repas, rayon…)';
  ui.catBtn.setAttribute(
    'aria-label',
    value ? `Catégorie : ${value}. Changer de catégorie` : 'Choisir une catégorie'
  );

  ui.categorySuggestions.replaceChildren(
    ...availableCategories().map((category) => {
      const option = document.createElement('option');
      option.value = category;
      return option;
    })
  );
}

function categoryOption(value) {
  const active = state.pendingCategory === value;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `cat-option${active ? ' is-active' : ''}`;
  button.dataset.category = value;
  button.setAttribute('aria-pressed', active ? 'true' : 'false');

  const name = document.createElement('span');
  name.className = 'cat-option-name';
  name.textContent = value || 'Sans catégorie';

  const count = document.createElement('span');
  count.className = 'cat-option-count';
  count.textContent = String(countByCategory(value));

  button.append(name, count);
  return button;
}

function renderCategoryOptions() {
  ui.catOptions.replaceChildren(
    categoryOption(''),
    ...availableCategories().map((category) => categoryOption(category))
  );
}

function openCategoryPicker() {
  if (!state.listId) return;
  renderCategoryOptions();
  ui.newCatInput.value = '';
  ui.catError.hidden = true;
  ui.catDialog.showModal();
}

function chooseCategory(value) {
  setPendingCategory(value);
  if (ui.catDialog.open) ui.catDialog.close();
  ui.nameInput.focus({ preventScroll: true });
}

function createCategory() {
  const value = cleanCategory(ui.newCatInput.value);
  if (!value) {
    ui.catError.textContent = 'Écris un nom de catégorie (ex. Repas du lundi).';
    ui.catError.hidden = false;
    ui.newCatInput.focus();
    return;
  }
  const existing = availableCategories().find(
    (category) => category.toLocaleLowerCase('fr') === value.toLocaleLowerCase('fr')
  );
  chooseCategory(existing || value);
}

/* ------------------------------------------------------------------ */
/* Rendu                                                               */
/* ------------------------------------------------------------------ */

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>';
const PENCIL_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14.5 6.5 3 3"/></svg>';

function itemRow(item) {
  const li = document.createElement('li');
  li.className = `item${item.done ? ' is-done' : ''}`;
  li.dataset.id = item.id;

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'item-check';
  check.setAttribute('role', 'checkbox');
  check.setAttribute('aria-checked', item.done ? 'true' : 'false');
  check.setAttribute(
    'aria-label',
    item.done ? `Décocher ${item.name}` : `Marquer ${item.name} comme acheté`
  );
  check.dataset.action = 'toggle';
  check.innerHTML = `<span class="check-box">${CHECK_SVG}</span>`;

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'item-main';
  main.dataset.action = 'edit';
  main.setAttribute('aria-label', `Modifier ${item.name}`);
  main.innerHTML =
    `<span class="item-name">${escapeHtml(item.name)}</span>` +
    (item.quantity ? `<span class="item-qty">${escapeHtml(item.quantity)}</span>` : '');

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'item-edit';
  edit.dataset.action = 'edit';
  edit.setAttribute('aria-label', `Options de ${item.name}`);
  edit.innerHTML = PENCIL_SVG;

  li.append(check, main, edit);
  return li;
}

function renderProgress(todo, done) {
  const total = todo + done;

  if (total === 0) {
    ui.progressText.textContent = 'Liste vide';
    ui.progress.hidden = true;
    ui.progress.setAttribute('aria-valuenow', '0');
    ui.progressBar.style.width = '0%';
    return;
  }

  ui.progress.hidden = false;
  const percent = Math.round((done / total) * 100);
  ui.progressBar.style.width = `${percent}%`;
  ui.progress.setAttribute('aria-valuenow', String(percent));

  if (done === 0) {
    ui.progressText.textContent = `${plural(todo, 'article', 'articles')} à acheter`;
  } else if (todo === 0) {
    ui.progressText.textContent = `Tout est acheté · ${done}/${total}`;
  } else {
    ui.progressText.textContent = `${done} sur ${total} acheté${done > 1 ? 's' : ''}`;
  }
}

const CATEGORY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h3.2a2 2 0 0 1 1.4.6l7 7a2.5 2.5 0 0 1 0 3.5l-2.6 2.6a2.5 2.5 0 0 1-3.5 0l-7-7A2 2 0 0 1 4 10.2Z"/><circle cx="8" cy="9" r="1.3" fill="currentColor" stroke="none"/></svg>';

const MAX_CATEGORY = 60;

function cleanCategory(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CATEGORY);
}

/** Catégories présentes dans la liste, dans l’ordre d’apparition. */
function listCategories() {
  const seen = new Set();
  const order = [];
  for (const item of state.list.items || []) {
    const category = item.category || '';
    if (category && !seen.has(category)) {
      seen.add(category);
      order.push(category);
    }
  }
  return order;
}

function availableCategories() {
  const categories = listCategories();
  const pending = state.pendingCategory;
  if (pending && !categories.includes(pending)) return [...categories, pending];
  return categories;
}

function countByCategory(category) {
  return (state.list.items || []).filter((item) => (item.category || '') === category).length;
}

function groupByCategory(items) {
  const order = [];
  const map = new Map();
  for (const item of items) {
    const key = item.category || '';
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key).push(item);
  }

  // Les articles sans catégorie restent en tête quand d’autres sont classés
  if (order.length > 1 && map.has('')) {
    order.splice(order.indexOf(''), 1);
    order.unshift('');
  }
  return order.map((key) => ({ key, items: map.get(key) }));
}

function categoryGroupRow(key, groupItems) {
  const li = document.createElement('li');
  li.className = 'cat-group';

  const title = document.createElement('h3');
  title.className = `cat-group-title${key ? '' : ' is-empty'}`;
  title.innerHTML =
    `${CATEGORY_ICON}<span class="cat-name">${escapeHtml(key || 'Sans catégorie')}</span>` +
    `<span class="count">${groupItems.length}</span>`;

  const list = document.createElement('ul');
  list.className = 'cat-group-items';
  list.setAttribute('aria-label', key || 'Sans catégorie');
  list.append(...groupItems.map(itemRow));

  li.append(title, list);
  return li;
}

function renderList(container, items) {
  const hasCategories = items.some((item) => item.category);
  if (!hasCategories) {
    container.replaceChildren(...items.map(itemRow));
    return;
  }
  container.replaceChildren(
    ...groupByCategory(items).map((group) => categoryGroupRow(group.key, group.items))
  );
}

function renderItems() {
  const items = state.list.items || [];
  const todo = items.filter((item) => !item.done);
  const done = items.filter((item) => item.done);

  renderList(ui.todoList, todo);
  renderList(ui.doneList, done);

  ui.todoCount.textContent = String(todo.length);
  ui.doneCount.textContent = String(done.length);

  ui.emptyState.hidden = todo.length > 0 || done.length > 0;
  ui.doneEmpty.hidden = done.length > 0;

  renderProgress(todo.length, done.length);
  updateCategoryUi();
}

function applyList(list, { fromServer = true } = {}) {
  if (!list) return;
  if (fromServer && state.list && list.revision < state.list.revision) return;
  state.list = list;
  renderItems();
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function showView(view) {
  state.view = view;
  ui.viewHome.hidden = view !== 'home';
  ui.viewList.hidden = view !== 'list';
  ui.viewMissing.hidden = view !== 'missing';
  ui.headerShare.hidden = view !== 'list';

  document.title =
    view === 'missing' ? 'Liste introuvable — Ma liste de courses' : 'Ma liste de courses';

  window.scrollTo({ top: 0, behavior: 'auto' });
}

function pathForList(id) {
  return `/l/${id}`;
}

function goTo(path, { replace = false } = {}) {
  if (replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  route();
}

async function createList() {
  if (state.adding) return;
  state.adding = true;
  ui.createBtn.disabled = true;
  ui.createBtn.querySelector('span').textContent = 'Création…';
  try {
    const { list } = await api('/api/lists', { method: 'POST', body: '{}' });
    rememberList(list.id);
    state.list = list;
    goTo(pathForList(list.id));
  } catch (error) {
    showToast(error.message, {
      error: true,
      action: { label: 'Réessayer', onClick: createList },
    });
  } finally {
    state.adding = false;
    ui.createBtn.disabled = false;
    ui.createBtn.querySelector('span').textContent = 'Créer une liste';
  }
}

function rememberList(id) {
  try {
    localStorage.setItem(LAST_LIST_KEY, id);
  } catch { /* mode privé : on ignore */ }
}

function lastList() {
  try {
    return localStorage.getItem(LAST_LIST_KEY);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Chargement d’une liste                                              */
/* ------------------------------------------------------------------ */

async function loadList(id) {
  stopRealtime();
  state.listId = id;
  state.pendingCategory = readStoredCategory();
  state.list = { id, revision: 0, items: [] };
  showView('list');
  renderItems();
  setSync('connecting');

  try {
    const { list } = await api(`/api/lists/${encodeURIComponent(id)}`);
    rememberList(id);
    applyList(list);
    startRealtime(id);
    checkStorageMode();

    if (list.items.length === 0 && mediaQuery('(hover: hover) and (pointer: fine)').matches) {
      ui.nameInput.focus({ preventScroll: true });
    }
  } catch (error) {
    if (error.status === 404) {
      showView('missing');
      return;
    }
    setSync('error');
    showToast(error.message, {
      error: true,
      action: { label: 'Réessayer', onClick: () => loadList(id) },
    });
  }
}

async function checkStorageMode() {
  if (state.dbOnline !== null) return;
  try {
    const health = await api('/api/health');
    state.dbOnline = Boolean(health.databaseConfigured);
    if (!state.dbOnline) {
      ui.bannerTitle.textContent = 'Aperçu : base de données non connectée';
      ui.bannerText.textContent =
        'Les listes sont enregistrées sur ce serveur d’aperçu (fichier local), pas dans PostgreSQL. ' +
        'Le partage fonctionne entre deux navigateurs ouverts sur ce serveur, mais les données peuvent ' +
        'être perdues au redémarrage. Après déploiement sur Railway avec DATABASE_URL, le partage et la ' +
        'conservation des listes sont durables.';
      ui.banner.hidden = state.bannerDismissed;
    } else {
      ui.banner.hidden = true;
    }
  } catch {
    state.dbOnline = null;
  }
}

/* ------------------------------------------------------------------ */
/* Temps réel                                                          */
/* ------------------------------------------------------------------ */

function stopRealtime() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  stopPolling();
}

function startRealtime(id) {
  stopRealtime();

  if (typeof window.EventSource === 'function') {
    const source = new EventSource(`/api/lists/${encodeURIComponent(id)}/events`);
    state.source = source;

    source.addEventListener('open', () => {
      setSync('live');
      stopPolling();
    });

    source.addEventListener('list', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && data.list) {
          applyList(data.list);
          setSync('live');
        }
      } catch { /* ignore */ }
    });

    source.addEventListener('error', () => {
      setSync('offline');
      startPolling(id);
    });
  } else {
    startPolling(id);
    setSync('polling');
  }
}

function startPolling(id) {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const { list } = await api(`/api/lists/${encodeURIComponent(id)}`);
      applyList(list);
      if (!state.source || state.source.readyState === 2) setSync('polling');
    } catch {
      setSync('offline');
    }
  }, 6000);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function onVisibility() {
  if (document.hidden || !state.listId) return;
  try {
    const { list } = await api(`/api/lists/${encodeURIComponent(state.listId)}`);
    applyList(list);
    if (state.source && state.source.readyState === 2) startRealtime(state.listId);
  } catch { /* silencieux */ }
}

/* ------------------------------------------------------------------ */
/* Mutations optimistes                                                */
/* ------------------------------------------------------------------ */

async function mutate({ applyLocally, request, errorMessage }) {
  const previous = clone(state.list);
  const optimistic = clone(state.list);
  applyLocally(optimistic);
  state.list = optimistic;
  renderItems();

  try {
    const result = await request();
    if (result && result.list) applyList(result.list);
    return true;
  } catch (error) {
    state.list = previous;
    renderItems();
    showToast(error.message || errorMessage, {
      error: true,
      action: {
        label: 'Réessayer',
        onClick: () => mutate({ applyLocally, request, errorMessage }),
      },
    });
    if (error.status === 404) loadList(state.listId);
    return false;
  }
}

function itemPath(itemId) {
  return `/api/lists/${encodeURIComponent(state.listId)}/items/${encodeURIComponent(itemId)}`;
}

function itemsPath() {
  return `/api/lists/${encodeURIComponent(state.listId)}/items`;
}

function findItem(id) {
  return (state.list.items || []).find((item) => item.id === id);
}

async function addItem(event) {
  if (event) event.preventDefault();
  if (!state.listId) return;

  const rawName = ui.nameInput.value.trim();
  const quantity = ui.qtyInput.value.trim();

  let name = rawName;
  let qty = quantity;
  const split = rawName.match(/^(.*?)\s*[·•]\s*([^·•]{1,40})$/);
  if (split && split[1].trim()) {
    name = split[1].trim();
    qty = qty || split[2].trim();
  }

  if (!name) {
    ui.addError.textContent = 'Écris le nom d’un article avant d’appuyer sur Ajouter.';
    ui.addError.hidden = false;
    ui.nameInput.setAttribute('aria-invalid', 'true');
    ui.nameInput.focus();
    return;
  }

  hideAddError();

  const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const category = state.pendingCategory;

  const optimisticItem = {
    id: tempId,
    name,
    quantity: qty,
    category,
    done: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  ui.nameInput.value = '';
  ui.qtyInput.value = '';

  await mutate({
    applyLocally: (list) => {
      list.items.push(optimisticItem);
      list.revision += 1;
    },
    request: () =>
      api(itemsPath(), {
        method: 'POST',
        body: JSON.stringify({ name, quantity: qty, category }),
      }),
    errorMessage: 'Impossible d’ajouter l’article. Vérifie ta connexion puis réessaie.',
  });

  ui.nameInput.focus({ preventScroll: true });
}

function hideAddError() {
  ui.addError.hidden = true;
  ui.addError.textContent = '';
  ui.nameInput.removeAttribute('aria-invalid');
}

function toggleItem(itemId) {
  const item = findItem(itemId);
  if (!item) return;
  const nextDone = !item.done;

  mutate({
    applyLocally: (list) => {
      const target = list.items.find((it) => it.id === itemId);
      if (target) target.done = nextDone;
      list.revision += 1;
    },
    request: () =>
      api(itemPath(itemId), {
        method: 'PATCH',
        body: JSON.stringify({ done: nextDone }),
      }),
    errorMessage: nextDone
      ? 'Impossible de cocher l’article. Réessaie.'
      : 'Impossible de décocher l’article. Réessaie.',
  });
}

/* ------------------------------------------------------------------ */
/* Feuille d’édition                                                   */
/* ------------------------------------------------------------------ */

function openEdit(itemId) {
  const item = findItem(itemId);
  if (!item) return;
  state.editing = item;
  ui.editName.value = item.name;
  ui.editQty.value = item.quantity || '';
  ui.editCategory.value = item.category || '';
  ui.editError.hidden = true;
  ui.deleteConfirm.hidden = true;
  ui.editDelete.hidden = false;
  ui.editForm.querySelector('.sheet-actions').hidden = false;
  ui.editTitle.textContent = item.done ? 'Article acheté' : 'Modifier l’article';
  ui.editDialog.showModal();
  setTimeout(() => ui.editName.focus({ preventScroll: true }), 60);
}

function closeEdit() {
  state.editing = null;
  ui.editDialog.close();
}

async function saveEdit(event) {
  if (event) event.preventDefault();
  const item = state.editing;
  if (!item) return;

  const name = ui.editName.value.trim();
  const quantity = ui.editQty.value.trim();
  const category = cleanCategory(ui.editCategory.value);
  if (!name) {
    ui.editError.textContent = 'Le nom de l’article ne peut pas être vide.';
    ui.editError.hidden = false;
    ui.editName.focus();
    return;
  }

  ui.editError.hidden = true;
  closeEdit();

  await mutate({
    applyLocally: (list) => {
      const target = list.items.find((it) => it.id === item.id);
      if (target) {
        target.name = name;
        target.quantity = quantity;
        target.category = category;
      }
      list.revision += 1;
    },
    request: () =>
      api(itemPath(item.id), {
        method: 'PATCH',
        body: JSON.stringify({ name, quantity, category }),
      }),
    errorMessage: 'Impossible d’enregistrer la modification. Réessaie.',
  });
}

async function deleteItem() {
  const item = state.editing;
  if (!item) return;
  closeEdit();

  const removed = { ...item };
  const ok = await mutate({
    applyLocally: (list) => {
      list.items = list.items.filter((it) => it.id !== item.id);
      list.revision += 1;
    },
    request: () => api(itemPath(item.id), { method: 'DELETE' }),
    errorMessage: 'Impossible de supprimer l’article. Réessaie.',
  });

  if (ok) {
    showToast('Article supprimé', {
      duration: 5000,
      action: { label: 'Annuler', onClick: () => restoreItem(removed) },
    });
  }
}

async function restoreItem(item) {
  await mutate({
    applyLocally: (list) => {
      list.items.push({ ...item });
      list.revision += 1;
    },
    request: async () => {
      const created = await api(itemsPath(), {
        method: 'POST',
        body: JSON.stringify({
          name: item.name,
          quantity: item.quantity || '',
          category: item.category || '',
        }),
      });
      if (!item.done || !created || !created.list) return created;

      const candidate = created.list.items.find(
        (it) => !it.done && it.name === item.name && (it.quantity || '') === (item.quantity || '')
      );
      if (!candidate) return created;

      return api(itemPath(candidate.id), {
        method: 'PATCH',
        body: JSON.stringify({ done: true }),
      });
    },
    errorMessage: 'Impossible de restaurer l’article. Réessaie.',
  });
}

/* ------------------------------------------------------------------ */
/* Lien de partage                                                     */
/* ------------------------------------------------------------------ */

function shareUrl() {
  return `${window.location.origin}${pathForList(state.listId)}`;
}

let copyTimer = null;
function markCopied() {
  ui.copyBtn.classList.add('is-copied');
  ui.copyLabel.textContent = 'Lien copié';
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    ui.copyBtn.classList.remove('is-copied');
    ui.copyLabel.textContent = 'Copier le lien de partage';
  }, 2400);
}

async function copyLink() {
  if (!state.listId) return;
  const url = shareUrl();

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
    } else {
      const area = document.createElement('textarea');
      area.value = url;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, url.length);
      document.execCommand('copy');
      area.remove();
    }
    showToast('Lien copié');
    markCopied();
  } catch {
    showToast(`Copie impossible. Voici le lien à partager : ${url}`, { duration: 9000 });
  }
}

async function shareLink() {
  if (!state.listId) return;
  const url = shareUrl();

  if (navigator.share && window.isSecureContext) {
    try {
      await navigator.share({
        title: 'Ma liste de courses',
        text: 'Voici notre liste de courses partagée :',
        url,
      });
      return;
    } catch (error) {
      if (error && error.name === 'AbortError') return;
    }
  }
  copyLink();
}

/* ------------------------------------------------------------------ */
/* Écouteurs                                                           */
/* ------------------------------------------------------------------ */

ui.createBtn.addEventListener('click', createList);

ui.resumeBtn.addEventListener('click', () => {
  const id = lastList();
  if (id) goTo(pathForList(id));
});

ui.addForm.addEventListener('submit', addItem);

ui.catBtn.addEventListener('click', openCategoryPicker);
ui.catOptions.addEventListener('click', (event) => {
  const button = event.target.closest('.cat-option');
  if (!button) return;
  chooseCategory(button.dataset.category || '');
});
ui.createCatBtn.addEventListener('click', createCategory);
ui.closeCatBtn.addEventListener('click', () => ui.catDialog.close());
function submitNewCategory() {
  if (cleanCategory(ui.newCatInput.value)) createCategory();
  else ui.catDialog.close();
}
ui.catForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitNewCategory();
});
ui.newCatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitNewCategory();
  }
});
ui.catDialog.addEventListener('click', (event) => {
  if (event.target === ui.catDialog) ui.catDialog.close();
});
ui.nameInput.addEventListener('input', () => {
  if (ui.nameInput.getAttribute('aria-invalid') === 'true') hideAddError();
});
ui.qtyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addItem();
  }
});

ui.emptyCta.addEventListener('click', () => {
  ui.nameInput.focus();
  ui.nameInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

ui.copyBtn.addEventListener('click', copyLink);
ui.headerShare.addEventListener('click', shareLink);
ui.themeToggle.addEventListener('click', toggleTheme);
ui.brandLink.addEventListener('click', (event) => {
  event.preventDefault();
  goTo('/');
});

function handleListClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const row = button.closest('.item');
  if (!row) return;
  if (button.dataset.action === 'toggle') toggleItem(row.dataset.id);
  else openEdit(row.dataset.id);
}
ui.todoList.addEventListener('click', handleListClick);
ui.doneList.addEventListener('click', handleListClick);

ui.editForm.addEventListener('submit', saveEdit);
ui.editCancel.addEventListener('click', closeEdit);
ui.editDelete.addEventListener('click', () => {
  const item = state.editing;
  ui.deleteQuestion.textContent = item ? `Supprimer « ${item.name} » ?` : 'Supprimer cet article ?';
  ui.deleteConfirm.hidden = false;
  ui.editDelete.hidden = true;
  ui.editForm.querySelector('.sheet-actions').hidden = true;
  ui.confirmDelete.focus();
});
ui.cancelDelete.addEventListener('click', () => {
  ui.deleteConfirm.hidden = true;
  ui.editDelete.hidden = false;
  ui.editForm.querySelector('.sheet-actions').hidden = false;
});
ui.confirmDelete.addEventListener('click', deleteItem);

ui.editDialog.addEventListener('click', (event) => {
  if (event.target === ui.editDialog) closeEdit();
});
ui.editDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeEdit();
});

ui.bannerClose.addEventListener('click', () => {
  state.bannerDismissed = true;
  ui.banner.hidden = true;
});
ui.bannerDetailsBtn.addEventListener('click', () => {
  ui.bannerDetails.hidden = !ui.bannerDetails.hidden;
  ui.bannerDetailsBtn.textContent = ui.bannerDetails.hidden
    ? 'Voir comment activer le partage durable'
    : 'Masquer les détails';
});

window.addEventListener('popstate', route);
window.addEventListener('online', () => {
  if (state.listId) onVisibility();
});
window.addEventListener('offline', () => setSync('offline'));

window.addEventListener(
  'scroll',
  () => {
    ui.topbar.classList.toggle('is-scrolled', window.scrollY > 6);
  },
  { passive: true }
);

// Barre d’espace ? Non : « / » place le curseur dans le champ d’ajout
document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  ) {
    return;
  }
  if (state.view !== 'list' || ui.editDialog.open) return;
  event.preventDefault();
  ui.nameInput.focus();
});

// Le thème suit le système tant que l’utilisateur n’a pas choisi explicitement
const mediaTheme = prefersDark();
const onSystemThemeChange = (event) => {
  if (!storedTheme()) applyTheme(event.matches ? 'dark' : 'light');
};
if (mediaTheme.addEventListener) mediaTheme.addEventListener('change', onSystemThemeChange);
else if (mediaTheme.addListener) mediaTheme.addListener(onSystemThemeChange);

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

function route() {
  hideToast();
  const match = window.location.pathname.match(/^\/l\/([A-Za-z0-9_-]{4,64})\/?$/);

  if (match) {
    const id = match[1];
    if (state.listId === id && state.view === 'list') return;
    loadList(id);
    return;
  }

  if (window.location.pathname === '/' || window.location.pathname === '') {
    stopRealtime();
    state.listId = null;
    refreshHome();
    showView('home');
    return;
  }

  showView('missing');
}

function refreshHome() {
  const id = lastList();
  ui.resumeBtn.hidden = !id;
  if (id) {
    ui.resumeName.textContent = `Lien …${id.slice(-6)}`;
    api(`/api/lists/${encodeURIComponent(id)}`)
      .then(({ list }) => {
        const todo = list.items.filter((item) => !item.done).length;
        const done = list.items.length - todo;
        ui.resumeName.textContent = list.items.length
          ? `${todo} à acheter · ${done} acheté${done > 1 ? 's' : ''}`
          : 'Liste vide';
      })
      .catch(() => {
        ui.resumeBtn.hidden = true;
      });
  }
}

applyTheme(document.documentElement.getAttribute('data-theme') || systemTheme());
ui.topbar.classList.toggle('is-scrolled', window.scrollY > 6);
route();
