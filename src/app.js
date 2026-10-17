import {
  clampScroll,
  clampZoom,
  classifyLink,
  createHistory,
  nextThemeMode,
  resolveTheme,
  showMode,
  stepZoom,
} from './logic.js';

const THEME_KEY = 'mdread.theme';
const ZOOM_KEY = 'mdread.zoom';

const els = {
  title: document.getElementById('doc-title'),
  openBtn: document.getElementById('open-btn'),
  themeBtn: document.getElementById('theme-btn'),
  banner: document.getElementById('error-banner'),
  errorText: document.getElementById('error-text'),
  dismiss: document.getElementById('error-dismiss'),
  view: document.getElementById('view'),
  doc: document.getElementById('doc'),
  empty: document.getElementById('empty'),
  emptyOpen: document.getElementById('empty-open'),
  overlay: document.getElementById('drag-overlay'),
};

let currentPath = null;
let history = createHistory();
let historyEpoch = 0;
let uncommitted = 0;
let themeMode = 'system';
let zoom = 100;
let requestId = 0;
let readyCalled = false;
/** Progressive append still in flight, so a fragment click can wait for its nodes. */
let pendingRest = null;
let pendingRestSeq = 0;
/** Head painted at startup; the rest is fetched only after mark_ready. */
let deferredRest = null;
let dialogOpen = false;
let dragOver = false;
/** file-changed path seen before the first document is on screen. */
let pendingChange = null;

function beginRequest() {
  requestId += 1;
  return requestId;
}

function isCurrent(id) {
  return id === requestId;
}

function tauri() {
  return typeof window !== 'undefined' ? window.__TAURI__ : undefined;
}

function coreInvoke(command, args) {
  const core = tauri() && tauri().core;
  if (!core || typeof core.invoke !== 'function') {
    return Promise.reject('Reader bridge is unavailable');
  }
  return args === undefined ? core.invoke(command) : core.invoke(command, args);
}

function errorMessage(err) {
  if (typeof err === 'string' && err.trim()) return err;
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === 'object') {
    if (typeof err.message === 'string' && err.message) return err.message;
    if (typeof err.error === 'string' && err.error) return err.error;
  }
  return 'Something went wrong';
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.replaceAll('/', '\\').toLowerCase() === b.replaceAll('/', '\\').toLowerCase();
}

function isDoc(value) {
  return !!value
    && typeof value === 'object'
    && typeof value.path === 'string'
    && typeof value.html === 'string';
}

function fileTitle(doc) {
  if (typeof doc.title === 'string' && doc.title.trim()) return doc.title;
  const parts = doc.path.split(/[/\\]/);
  return parts[parts.length - 1] || doc.path || 'mdread';
}

function readThemeMode() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

function systemPrefersDark() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches === true;
  } catch {
    return false;
  }
}

function applyTheme(mode) {
  themeMode = mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'system';
  try {
    localStorage.setItem(THEME_KEY, themeMode);
  } catch {
    /* keep the in-memory mode */
  }
  document.documentElement.dataset.theme = resolveTheme(themeMode, systemPrefersDark());
  els.themeBtn.dataset.mode = themeMode;
  const label = `Theme: ${themeMode}`;
  els.themeBtn.setAttribute('aria-label', label);
  els.themeBtn.title = `${label} (Ctrl+T)`;
}

function cycleTheme() {
  applyTheme(nextThemeMode(themeMode));
}

function readZoom() {
  try {
    const raw = localStorage.getItem(ZOOM_KEY);
    if (raw === null) return 100;
    return clampZoom(raw);
  } catch {
    return 100;
  }
}

function applyZoom(next) {
  zoom = clampZoom(next);
  els.doc.style.setProperty('--zoom', String(zoom / 100));
  try {
    localStorage.setItem(ZOOM_KEY, String(zoom));
  } catch {
    /* the column still uses the in-memory zoom */
  }
}

function changeZoom(direction) {
  applyZoom(stepZoom(zoom, direction));
}

function showError(err) {
  els.errorText.textContent = errorMessage(err);
  els.banner.hidden = false;
}

function hideError() {
  els.banner.hidden = true;
  els.errorText.textContent = '';
}

function setWindowTitle(title) {
  document.title = title;
  const api = tauri() && tauri().window;
  if (!api || typeof api.getCurrentWindow !== 'function') return;
  try {
    const result = api.getCurrentWindow().setTitle(title);
    if (result && typeof result.then === 'function') result.catch(() => {});
  } catch {
    /* document.title still matches */
  }
}

function showEmpty() {
  currentPath = null;
  history = createHistory();
  uncommitted = 0;
  historyEpoch += 1;
  els.doc.innerHTML = '';
  els.doc.hidden = true;
  els.empty.hidden = false;
  els.title.textContent = 'mdread';
  els.title.removeAttribute('title');
  setWindowTitle('mdread');
  els.view.scrollTop = 0;
}

function paint(doc) {
  currentPath = doc.path;
  // The previous body is gone; its append must not resolve a fragment in this one.
  pendingRest = null;
  pendingRestSeq = 0;
  // Set before innerHTML so the head's first layout already skips off-screen blocks.
  // null and undefined both mean unsplit (the backend may not have landed yet).
  els.doc.classList.toggle('is-large', doc.restId != null);
  els.doc.innerHTML = doc.html;
  els.doc.hidden = false;
  els.empty.hidden = true;
  const name = fileTitle(doc);
  els.title.textContent = name;
  els.title.title = doc.path;
  setWindowTitle(`${name} — mdread`);
  hideError();
}

function fragmentElement(fragment) {
  if (typeof fragment !== 'string' || !fragment) return null;
  let id = fragment;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    id = fragment;
  }
  if (id.startsWith('#')) id = id.slice(1);
  if (!id) return null;
  const el = document.getElementById(id);
  if (!el || !els.view.contains(el)) return null;
  return el;
}

function scrollToFragment(fragment) {
  const el = fragmentElement(fragment);
  if (el) {
    scrollToBlock(el, -12);
    return;
  }
  // Tied to the rest's own request: a click during a newer open must not scroll that open.
  const pending = pendingRest;
  const seq = pendingRestSeq;
  const path = currentPath;
  if (!pending) {
    els.view.scrollTop = 0;
    return;
  }
  pending.then(() => {
    if (!isCurrent(seq) || !samePath(currentPath, path)) return;
    const again = fragmentElement(fragment);
    if (again) scrollToBlock(again, -12);
    else els.view.scrollTop = 0;
  });
}

/** Top-level block of the document column that contains `el`. */
function blockOf(el) {
  let node = el;
  while (node && node.parentElement !== els.doc) node = node.parentElement;
  return node;
}

/**
 * Puts `el` at the top of the view, shifted by `offset` px. Its block is laid out for real first:
 * under content-visibility a placeholder height would put the offset in the wrong place.
 */
function scrollToBlock(el, offset) {
  const block = blockOf(el) || el;
  block.style.contentVisibility = 'visible';
  el.scrollIntoView({ block: 'start' });
  const maxTop = els.view.scrollHeight - els.view.clientHeight;
  els.view.scrollTop = clampScroll(els.view.scrollTop + offset, maxTop);
  block.style.contentVisibility = '';
}

/** First block at the top of the view and how far it is scrolled past; null at the very top. */
function captureAnchor() {
  const blocks = els.doc.children;
  if (els.view.scrollTop <= 0 || blocks.length === 0) return null;
  const viewTop = els.view.getBoundingClientRect().top;
  // Blocks stack top to bottom, so binary-search the first one whose bottom is below the edge.
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].getBoundingClientRect().bottom > viewTop) hi = mid;
    else lo = mid + 1;
  }
  // Signed: negative when the block starts below the edge (padding or a margin gap above it).
  return { index: lo, offset: viewTop - blocks[lo].getBoundingClientRect().top };
}

function restoreAnchor(anchor) {
  if (!anchor) {
    els.view.scrollTop = 0;
    return;
  }
  const block = els.doc.children[anchor.index];
  if (!block) {
    els.view.scrollTop = els.view.scrollHeight; // the document got shorter
    return;
  }
  scrollToBlock(block, anchor.offset);
}

function commitHistory(doc, opts) {
  if (opts.historyMode !== 'seed' && opts.historyMode !== 'push') return;
  if (opts.historyMode === 'seed') history = createHistory();
  history.push(doc.path);
  uncommitted = 0;
  historyEpoch += 1;
}

function placeDocument(doc, opts, restHtml) {
  const anchor = opts.keepPosition ? captureAnchor() : null;
  paint(doc);
  if (typeof restHtml === 'string') els.doc.insertAdjacentHTML('beforeend', restHtml);
  commitHistory(doc, opts);
  if (opts.fragment) scrollToFragment(opts.fragment);
  else restoreAnchor(anchor);
}

/**
 * Fetch the rest and append it only if this request is still the one on screen.
 * Resolves either way so a fragment click waiting on it can retry or give up.
 */
function appendRestLater(doc, seq) {
  const path = doc.path;
  const task = coreInvoke('doc_rest', { id: doc.restId })
    .then((rest) => {
      if (!isCurrent(seq) || !samePath(currentPath, path)) return;
      if (typeof rest !== 'string') {
        showError('Could not load the rest of the document');
        return;
      }
      els.doc.insertAdjacentHTML('beforeend', rest);
    })
    .catch((err) => {
      if (!isCurrent(seq) || !samePath(currentPath, path)) return;
      showError(err);
    })
    .finally(() => {
      if (pendingRest === task) {
        pendingRest = null;
        pendingRestSeq = 0;
      }
    });
  pendingRest = task;
  pendingRestSeq = seq;
  return task;
}

/** Rest first, then head + rest in one turn, so the anchor or fragment can land. */
async function showPositioned(doc, opts) {
  const seq = requestId;
  let restHtml = null;
  let restError = null;
  try {
    const rest = await coreInvoke('doc_rest', { id: doc.restId });
    // currentPath still names the document on screen; the sequence is the staleness check.
    if (!isCurrent(seq)) return;
    if (typeof rest !== 'string') restError = 'Could not load the rest of the document';
    else restHtml = rest;
  } catch (err) {
    if (!isCurrent(seq)) return;
    restError = err;
  }
  placeDocument(doc, opts, restHtml);
  if (restError) showError(restError);
}

function showOpened(doc, options) {
  const opts = options || {};
  const mode = showMode({ fragment: opts.fragment, keepPosition: opts.keepPosition });
  if (mode === 'positioned' && doc.restId != null) return showPositioned(doc, opts);
  placeDocument(doc, opts, null);
  if (doc.restId == null) return Promise.resolve();
  // Startup calls mark_ready in this same turn, before the rest crosses IPC.
  if (opts.deferRest) {
    deferredRest = { doc, seq: requestId };
    return Promise.resolve();
  }
  return appendRestLater(doc, requestId);
}

function acceptDoc(seq, doc) {
  if (!isCurrent(seq)) return null;
  if (!isDoc(doc)) {
    showError('Could not open the file');
    return null;
  }
  return doc;
}

async function openFresh(path) {
  if (typeof path !== 'string' || !path) return;
  const seq = beginRequest();
  try {
    const doc = acceptDoc(seq, await coreInvoke('open_file', { path }));
    if (!doc) return;
    await showOpened(doc, { historyMode: 'seed' });
  } catch (err) {
    if (!isCurrent(seq)) return;
    showError(err);
  }
}

async function openMarkdown(path, fragment) {
  const seq = beginRequest();
  try {
    const doc = acceptDoc(seq, await coreInvoke('open_file', { path }));
    if (!doc) return;
    await showOpened(doc, { historyMode: 'push', fragment: fragment || null });
  } catch (err) {
    if (!isCurrent(seq)) return;
    showError(err);
  }
}

async function reloadKeepingScroll() {
  if (!currentPath) return;
  const path = currentPath;
  const seq = beginRequest();
  try {
    const doc = acceptDoc(seq, await coreInvoke('open_file', { path }));
    if (!doc) return;
    await showOpened(doc, { keepPosition: true });
  } catch (err) {
    if (!isCurrent(seq)) return;
    showError(err);
  }
}

function rollbackUncommitted() {
  while (uncommitted < 0 && history.canForward()) {
    history.forward();
    uncommitted += 1;
  }
  while (uncommitted > 0 && history.canBack()) {
    history.back();
    uncommitted -= 1;
  }
  uncommitted = 0;
}

async function goHistory(direction) {
  if (!(direction < 0 ? history.canBack() : history.canForward())) return;
  const path = direction < 0 ? history.back() : history.forward();
  uncommitted += direction < 0 ? -1 : 1;
  const epoch = ++historyEpoch;
  if (typeof path !== 'string' || !path) {
    rollbackUncommitted();
    return;
  }
  const seq = beginRequest();
  try {
    const doc = await coreInvoke('open_file', { path });
    if (epoch !== historyEpoch) return;
    if (!isCurrent(seq)) {
      rollbackUncommitted();
      return;
    }
    if (!isDoc(doc)) {
      rollbackUncommitted();
      showError('Could not open the file');
      return;
    }
    uncommitted = 0;
    await showOpened(doc);
  } catch (err) {
    if (epoch !== historyEpoch) return;
    rollbackUncommitted();
    if (!isCurrent(seq)) return;
    showError(err);
  }
}

async function openDialog() {
  if (dialogOpen) return;
  const dialog = tauri() && tauri().dialog;
  if (!dialog || typeof dialog.open !== 'function') {
    showError('Open dialog is unavailable');
    return;
  }
  dialogOpen = true;
  let picked;
  try {
    picked = await dialog.open({
      title: 'Open a Markdown file',
      multiple: false,
      directory: false,
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
  } catch (err) {
    showError(err);
    return;
  } finally {
    dialogOpen = false;
  }
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (typeof path === 'string' && path) openFresh(path);
}

function closestAnchor(target) {
  if (!(target instanceof Element)) return null;
  return target.closest('a');
}

function handleLink(anchor) {
  const href = anchor.getAttribute('href');
  const localPath = anchor.getAttribute('data-local-path');
  const kind = classifyLink({ href, localPath });
  if (kind === 'fragment') {
    scrollToFragment(href.slice(href.indexOf('#') + 1));
    return;
  }
  if (kind === 'external') {
    const opener = tauri() && tauri().opener;
    if (!opener || typeof opener.openUrl !== 'function') {
      showError('Could not open the link');
      return;
    }
    opener.openUrl(href).catch((err) => showError(err));
    return;
  }
  if (kind === 'markdown') {
    // A history step still in flight owns the stack; pushing now would truncate
    // from the speculative index instead of the document on screen.
    if (uncommitted !== 0) return;
    openMarkdown(localPath, anchor.getAttribute('data-fragment'));
    return;
  }
  if (kind === 'local') {
    const opener = tauri() && tauri().opener;
    if (!opener || typeof opener.revealItemInDir !== 'function') {
      showError('Could not show the file');
      return;
    }
    opener.revealItemInDir(localPath).catch((err) => showError(err));
  }
}

function setDragOver(next) {
  if (dragOver === next) return;
  dragOver = next;
  els.overlay.hidden = !next;
}

function wireDrag() {
  const webviewApi = tauri() && tauri().webview;
  if (!webviewApi || typeof webviewApi.getCurrentWebview !== 'function') return;
  let webview;
  try {
    webview = webviewApi.getCurrentWebview();
  } catch {
    return;
  }
  if (!webview || typeof webview.onDragDropEvent !== 'function') return;
  webview.onDragDropEvent((event) => {
    const payload = event && event.payload;
    const type = payload && payload.type;
    if (type === 'enter' || type === 'over') {
      setDragOver(true);
      return;
    }
    if (type === 'leave') {
      setDragOver(false);
      return;
    }
    if (type === 'drop') {
      setDragOver(false);
      const paths = payload.paths;
      const first = Array.isArray(paths)
        ? paths.find((item) => typeof item === 'string' && item.length > 0)
        : null;
      if (first) openFresh(first);
    }
  }).catch(() => {});
}

function onFileChanged(event) {
  const path = event && event.payload && event.payload.path;
  if (typeof path !== 'string' || !path) return;
  if (!currentPath) {
    pendingChange = path;
    return;
  }
  if (!samePath(path, currentPath)) return;
  reloadKeepingScroll();
}

function onFileRemoved(event) {
  const path = event && event.payload && event.payload.path;
  if (!currentPath || !samePath(path, currentPath)) return;
  showError('File was deleted or moved');
}

function wireFileEvents() {
  const events = tauri() && tauri().event;
  if (!events || typeof events.listen !== 'function') return Promise.resolve();
  const changed = events.listen('file-changed', onFileChanged).catch(() => {});
  const removed = events.listen('file-removed', onFileRemoved).catch(() => {});
  return Promise.all([changed, removed]).then(() => {});
}

function zoomDirection(event) {
  if (!event.ctrlKey || event.altKey) return null;
  if (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0') return 0;
  if (event.key === '+' || event.key === '=' || event.code === 'Equal' || event.code === 'NumpadAdd') return 1;
  if (event.key === '-' || event.key === '_' || event.code === 'Minus' || event.code === 'NumpadSubtract') return -1;
  return null;
}

function onKeyDown(event) {
  const ctrl = event.ctrlKey && !event.altKey;
  if (event.key === 'F5' || (ctrl && (event.key === 'r' || event.key === 'R'))) {
    event.preventDefault();
    if (!event.repeat) reloadKeepingScroll();
    return;
  }
  if (ctrl && !event.shiftKey && (event.key === 'o' || event.key === 'O')) {
    event.preventDefault();
    if (!event.repeat) openDialog();
    return;
  }
  if (ctrl && !event.shiftKey && (event.key === 't' || event.key === 'T')) {
    event.preventDefault();
    if (!event.repeat) cycleTheme();
    return;
  }
  const direction = zoomDirection(event);
  if (direction !== null) {
    event.preventDefault();
    changeZoom(direction);
    return;
  }
  if (event.altKey && !event.ctrlKey && !event.shiftKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    if (!event.repeat) goHistory(-1);
    return;
  }
  if (event.altKey && !event.ctrlKey && !event.shiftKey && event.key === 'ArrowRight') {
    event.preventDefault();
    if (!event.repeat) goHistory(1);
  }
}

function wireUi() {
  els.openBtn.addEventListener('click', () => openDialog());
  els.emptyOpen.addEventListener('click', () => openDialog());
  els.themeBtn.addEventListener('click', () => cycleTheme());
  els.dismiss.addEventListener('click', () => {
    const wasFocused = document.activeElement === els.dismiss;
    hideError();
    if (wasFocused) els.openBtn.focus();
  });
  document.addEventListener('click', (event) => {
    const anchor = closestAnchor(event.target);
    if (!anchor) return;
    event.preventDefault();
    handleLink(anchor);
  });
  document.addEventListener('auxclick', (event) => {
    if (event.button === 1 && closestAnchor(event.target)) event.preventDefault();
    if (event.button === 3 || event.button === 4) event.preventDefault();
  }, true);
  window.addEventListener('mousedown', (event) => {
    if (event.button === 1 && closestAnchor(event.target)) event.preventDefault();
    if (event.button === 3 || event.button === 4) event.preventDefault();
  }, true);
  window.addEventListener('mouseup', (event) => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    goHistory(event.button === 3 ? -1 : 1);
  }, true);
  window.addEventListener('keydown', onKeyDown, true);
}

// mark_ready runs in this turn, immediately after the head (or the empty state
// or the error) is in the DOM, and before a split document's rest is fetched.
// requestAnimationFrame does not fire while the Tauri window is still hidden.
function markReady() {
  if (readyCalled) return;
  readyCalled = true;
  coreInvoke('mark_ready').catch(() => {});
}

async function start() {
  let followReload = false;
  try {
    applyZoom(readZoom());
    applyTheme(readThemeMode());
    wireUi();
    wireDrag();
    await wireFileEvents();

    const seq = beginRequest();
    let doc = null;
    let startupError = null;
    try {
      doc = await coreInvoke('initial_doc');
    } catch (err) {
      startupError = err;
    }
    if (isCurrent(seq)) {
      if (isDoc(doc)) {
        showOpened(doc, { historyMode: 'seed', deferRest: true });
        followReload = !!(pendingChange && samePath(pendingChange, currentPath));
        pendingChange = null;
      } else {
        pendingChange = null;
        showEmpty();
      }
      if (startupError) showError(startupError);
    }
  } catch (err) {
    showError(err);
  } finally {
    markReady();
  }
  const restJob = deferredRest;
  deferredRest = null;
  if (followReload) reloadKeepingScroll();
  else if (restJob) appendRestLater(restJob.doc, restJob.seq);
}

start();
