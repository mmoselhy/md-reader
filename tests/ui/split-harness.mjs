// Drives src/app.js against a fake DOM. One scenario per process (app.js starts on import).
import assert from 'node:assert/strict';

const PATH_A = 'C:\\docs\\a.md';
const PATH_B = 'C:\\docs\\b.md';
const PATH_C = 'C:\\docs\\c.md';

const log = [];
const calls = [];
const byId = new Map();
const documentListeners = {};
const windowListeners = {};

let docEl;
let viewEl;
let emptyEl;
let bannerEl;
let errorText;
let dialogWait = null;
let onFileChanged = null;
let onDragDrop = null;

class Element {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = '';
    this.hidden = false;
    this.textContent = '';
    this.title = '';
    this.classList = createClassList();
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.parentElement = null;
    this.listeners = {};
    this._html = '';
    const style = {};
    style.setProperty = (name, value) => {
      style[name] = value;
    };
    this.style = style;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
  }

  focus() {}

  closest(selector) {
    let node = this;
    while (node) {
      if (selector === 'a' && node.tagName === 'A') return node;
      node = node.parentElement;
    }
    return null;
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  getBoundingClientRect() {
    if (this === viewEl) return { top: 0, bottom: 800, left: 0, right: 600, width: 600, height: 800 };
    const index = docEl.children.indexOf(this);
    const top = index < 0 ? 0 : index * 200;
    return { top, bottom: top + 200, left: 0, right: 600, width: 600, height: 200 };
  }

  scrollIntoView() {
    log.push({ kind: 'scroll', id: this.id });
  }

  set innerHTML(value) {
    log.push({
      kind: 'html',
      value: String(value),
      isLarge: this.id === 'doc' ? this.classList.contains('is-large') : undefined,
    });
    for (const child of this.children) unregister(child);
    this.children = [];
    this._html = String(value);
    for (const child of parseElements(this._html, this)) this.children.push(child);
  }

  get innerHTML() {
    return this._html;
  }

  insertAdjacentHTML(position, html) {
    if (position !== 'beforeend') throw new Error(`unsupported position ${position}`);
    log.push({ kind: 'append', value: html });
    this._html += html;
    for (const child of parseElements(html, this)) this.children.push(child);
  }
}

function createClassList() {
  const names = new Set();
  return {
    toggle(name, force) {
      const on = force === undefined ? !names.has(name) : Boolean(force);
      if (on) names.add(name);
      else names.delete(name);
      return on;
    },
    contains(name) {
      return names.has(name);
    },
  };
}

function unregister(el) {
  if (el.id && byId.get(el.id) === el) byId.delete(el.id);
  el.parentElement = null;
  for (const child of el.children) unregister(child);
}

function parseElements(html, parent) {
  const nodes = [];
  const re = /<([A-Za-z][\w-]*)([^>]*)>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = re.exec(html))) {
    const el = new Element(match[1]);
    el.parentElement = parent;
    const attrRe = /([^\s=]+)="([^"]*)"/g;
    let attr;
    while ((attr = attrRe.exec(match[2]))) {
      el.setAttribute(attr[1], attr[2]);
      if (attr[1] === 'id') {
        el.id = attr[2];
        byId.set(el.id, el);
      }
    }
    el._html = match[3];
    el.textContent = match[3].replace(/<[^>]+>/g, '');
    nodes.push(el);
  }
  return nodes;
}

function shell(id, tag) {
  const el = new Element(tag);
  el.id = id;
  byId.set(id, el);
  return el;
}

function install() {
  docEl = shell('doc', 'article');
  viewEl = shell('view', 'div');
  emptyEl = shell('empty', 'div');
  bannerEl = shell('error-banner', 'div');
  errorText = shell('error-text', 'p');
  const title = shell('doc-title', 'p');
  const openBtn = shell('open-btn', 'button');
  const themeBtn = shell('theme-btn', 'button');
  const dismiss = shell('error-dismiss', 'button');
  const emptyOpen = shell('empty-open', 'button');
  const overlay = shell('drag-overlay', 'div');

  docEl.hidden = true;
  bannerEl.hidden = true;
  overlay.hidden = true;
  emptyEl.hidden = false;
  title.textContent = 'mdread';
  docEl.parentElement = viewEl;
  emptyEl.parentElement = viewEl;
  viewEl.scrollHeight = 5000;
  viewEl.clientHeight = 800;
  let scrollTop = 0;
  Object.defineProperty(viewEl, 'scrollTop', {
    get() {
      return scrollTop;
    },
    set(value) {
      scrollTop = Number(value) || 0;
      log.push({ kind: 'scrollTop', value: scrollTop });
    },
  });

  const documentElement = new Element('html');
  globalThis.Element = Element;
  globalThis.document = {
    documentElement,
    title: 'mdread',
    activeElement: null,
    getElementById(id) {
      return byId.get(id) || null;
    },
    addEventListener(type, fn) {
      (documentListeners[type] || (documentListeners[type] = [])).push(fn);
    },
  };
  globalThis.localStorage = {
    getItem() {
      return null;
    },
    setItem() {},
  };
  globalThis.window = {
    __TAURI__: {
      core: { invoke },
      dialog: {
        open() {
          log.push({ kind: 'dialog' });
          return new Promise((resolve, reject) => {
            dialogWait = { resolve, reject };
          });
        },
      },
      event: {
        listen(name, cb) {
          if (name === 'file-changed') onFileChanged = cb;
          else if (name === 'file-removed') { /* kept so the app can subscribe */ }
          else throw new Error(`unexpected event ${name}`);
          return Promise.resolve();
        },
      },
      webview: {
        getCurrentWebview() {
          return {
            onDragDropEvent(cb) {
              onDragDrop = cb;
              return Promise.resolve();
            },
          };
        },
      },
      window: {
        getCurrentWindow() {
          return {
            setTitle() {
              return Promise.resolve();
            },
          };
        },
      },
      opener: {
        openUrl() {
          return Promise.resolve();
        },
        revealItemInDir() {
          return Promise.resolve();
        },
      },
    },
    matchMedia() {
      return { matches: false };
    },
    addEventListener(type, fn) {
      (windowListeners[type] || (windowListeners[type] = [])).push(fn);
    },
  };
}

function invoke(command, args) {
  const call = {
    command,
    args: args === undefined ? null : args,
    done: command === 'mark_ready',
  };
  calls.push(call);
  log.push({ kind: 'invoke', command, args: call.args });
  if (command === 'mark_ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    call.resolve = (value) => {
      call.done = true;
      resolve(value);
    };
    call.reject = (err) => {
      call.done = true;
      reject(err);
    };
  });
}

function pending(command) {
  const open = calls.filter((call) => call.command === command && !call.done);
  if (open.length !== 1) {
    throw new Error(
      `expected one pending ${command}, found ${open.length}; `
      + `calls=${calls.map((call) => call.command + (call.done ? '*' : '')).join(',')}; `
      + `banner=${errorText.textContent}`,
    );
  }
  return open[0];
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

async function boot() {
  install();
  await import('../../src/app.js');
  await flush();
  return pending('initial_doc');
}

function makeDoc(over = {}) {
  return {
    path: PATH_A,
    title: 'a.md',
    html: '<h1 id="top">Top</h1>',
    restId: null,
    renderMs: 1,
    ...over,
  };
}

function click(target) {
  const event = {
    target,
    preventDefault() {
      event.defaultPrevented = true;
    },
    defaultPrevented: false,
  };
  for (const fn of documentListeners.click || []) fn(event);
}

function keydown(partial) {
  const event = {
    key: partial.key,
    code: partial.code || '',
    ctrlKey: !!partial.ctrlKey,
    altKey: !!partial.altKey,
    shiftKey: !!partial.shiftKey,
    repeat: !!partial.repeat,
    preventDefault() {
      event.defaultPrevented = true;
    },
    defaultPrevented: false,
  };
  for (const fn of windowListeners.keydown || []) fn(event);
}

function fileChanged(path) {
  if (!onFileChanged) throw new Error('file-changed is not wired');
  onFileChanged({ payload: { path } });
}

function drop(paths) {
  if (!onDragDrop) throw new Error('drag-drop is not wired');
  onDragDrop({ payload: { type: 'drop', paths } });
}

function readyCount() {
  return calls.filter((call) => call.command === 'mark_ready').length;
}

function commandNames() {
  return calls.map((call) => call.command);
}

function lastHtml() {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i].kind === 'html') return log[i];
  }
  return null;
}

async function showInitial(doc) {
  const initial = await boot();
  let saw = null;
  initial.resolve(doc);
  queueMicrotask(() => {
    saw = {
      html: docEl.innerHTML,
      appends: log.filter((entry) => entry.kind === 'append').length,
      commands: commandNames().slice(),
    };
  });
  await flush();
  return saw;
}

async function startupSplit() {
  const head = '<h1 id="top">Top</h1>';
  const rest = '<h2 id="tail">Tail</h2>';
  const saw = await showInitial(makeDoc({ html: head, restId: 7, renderMs: 4 }));
  assert.equal(saw.html, head);
  assert.equal(saw.appends, 0);
  assert.deepEqual(saw.commands, ['initial_doc', 'mark_ready', 'doc_rest']);
  const painted = log.find((entry) => entry.kind === 'html' && entry.value === head);
  assert.equal(painted.isLarge, true);
  assert.equal(docEl.classList.contains('is-large'), true);
  assert.equal(docEl.hidden, false);
  assert.equal(emptyEl.hidden, true);
  assert.equal(document.getElementById('doc-title').textContent, 'a.md');
  const restCall = pending('doc_rest');
  assert.deepEqual(restCall.args, { id: 7 });
  assert.equal(document.getElementById('tail'), null);
  restCall.resolve(rest);
  await flush();
  assert.equal(docEl.innerHTML, head + rest);
  assert.ok(document.getElementById('tail'));
  assert.equal(readyCount(), 1);
  assert.equal(bannerEl.hidden, true);
}

async function startupNullRest() {
  const html = '<h1 id="top">Top</h1><p id="all">All</p>';
  const saw = await showInitial(makeDoc({ html, restId: null }));
  assert.equal(saw.html, html);
  assert.deepEqual(saw.commands, ['initial_doc', 'mark_ready']);
  assert.equal(log.find((entry) => entry.kind === 'html' && entry.value === html).isLarge, false);
  assert.equal(docEl.classList.contains('is-large'), false);
  assert.equal(calls.some((call) => call.command === 'doc_rest'), false);
}

async function startupMissingRestLarge() {
  const html = `<p id="big">${'x'.repeat(300 * 1024)}</p>`;
  const doc = makeDoc({ html });
  delete doc.restId;
  const saw = await showInitial(doc);
  assert.equal(saw.html.length, html.length);
  assert.equal(document.getElementById('big') !== null, true);
  assert.deepEqual(saw.commands, ['initial_doc', 'mark_ready']);
  assert.equal(log.find((entry) => entry.kind === 'html').isLarge, false);
  assert.equal(calls.some((call) => call.command === 'doc_rest'), false);
}

async function startupError() {
  const initial = await boot();
  initial.reject('File not found: C:\\missing.md');
  await flush();
  assert.equal(emptyEl.hidden, false);
  assert.equal(docEl.hidden, true);
  assert.equal(bannerEl.hidden, false);
  assert.equal(errorText.textContent, 'File not found: C:\\missing.md');
  assert.deepEqual(commandNames(), ['initial_doc', 'mark_ready']);
  assert.equal(readyCount(), 1);
}

async function startupFileChanged() {
  const head = '<h1 id="top">First</h1>';
  const nextHead = '<h1 id="top">Second</h1>';
  const rest = '<p id="tail">Rest</p>';
  const initial = await boot();
  fileChanged(PATH_A);
  initial.resolve(makeDoc({ html: head, restId: 3 }));
  await flush();
  assert.equal(docEl.innerHTML, head);
  assert.deepEqual(commandNames(), ['initial_doc', 'mark_ready', 'open_file']);
  assert.deepEqual(calls.at(-1).args, { path: PATH_A });
  const opened = pending('open_file');
  opened.resolve(makeDoc({ html: nextHead, restId: 4 }));
  await flush();
  assert.equal(docEl.innerHTML, head);
  const restCall = pending('doc_rest');
  assert.deepEqual(restCall.args, { id: 4 });
  let saw = null;
  restCall.resolve(rest);
  queueMicrotask(() => {
    saw = docEl.innerHTML;
  });
  await flush();
  assert.equal(saw, nextHead + rest);
  assert.equal(log[log.findIndex((entry) => entry.kind === 'html' && entry.value === nextHead) + 1].kind, 'append');
}

async function startupOtherFileChanged() {
  const head = '<h1 id="top">Top</h1>';
  const initial = await boot();
  fileChanged(PATH_B);
  const saw = await (async () => {
    let shot = null;
    initial.resolve(makeDoc({ html: head, restId: 2 }));
    queueMicrotask(() => {
      shot = commandNames().slice();
    });
    await flush();
    return shot;
  })();
  assert.deepEqual(saw, ['initial_doc', 'mark_ready', 'doc_rest']);
  assert.equal(calls.some((call) => call.command === 'open_file'), false);
}

async function progressiveRestError() {
  const head = '<h1 id="top">Top</h1>';
  await showInitial(makeDoc({ html: head, restId: 5 }));
  pending('doc_rest').reject('Stale document part');
  await flush();
  assert.equal(docEl.innerHTML, head);
  assert.equal(docEl.classList.contains('is-large'), true);
  assert.equal(log.some((entry) => entry.kind === 'append'), false);
  assert.equal(bannerEl.hidden, false);
  assert.equal(errorText.textContent, 'Stale document part');
  assert.equal(readyCount(), 1);
}

async function restNotString() {
  const head = '<h1 id="top">Top</h1>';
  await showInitial(makeDoc({ html: head, restId: 5 }));
  pending('doc_rest').resolve(12);
  await flush();
  assert.equal(docEl.innerHTML, head);
  assert.equal(bannerEl.hidden, false);
  assert.equal(errorText.textContent, 'Could not load the rest of the document');
  assert.equal(log.some((entry) => entry.kind === 'append'), false);
}

async function staleRestDroppedOnOpen() {
  const head = '<h1 id="top">Head A</h1>';
  const headB = '<p id="b">Head B</p>';
  await showInitial(makeDoc({ html: head, restId: 1 }));
  keydown({ key: 'o', ctrlKey: true });
  assert.ok(dialogWait);
  dialogWait.resolve(PATH_B);
  await flush();
  const opening = pending('open_file');
  assert.deepEqual(opening.args, { path: PATH_B });
  pending('doc_rest').resolve('<p id="ghost">GHOST</p>');
  await flush();
  assert.equal(docEl.innerHTML, head);
  assert.equal(document.getElementById('ghost'), null);
  opening.resolve(makeDoc({ path: PATH_B, title: 'b.md', html: headB, restId: null }));
  await flush();
  assert.equal(docEl.innerHTML, headB);
  assert.equal(docEl.classList.contains('is-large'), false);
  assert.equal(document.getElementById('ghost'), null);
  assert.equal(bannerEl.hidden, true);
  assert.equal(readyCount(), 1);
}

async function fragmentInHead() {
  const head = '<h1 id="top">Top</h1><a href="#top" id="jump">Top</a>';
  const rest = '<p id="tail">Tail</p>';
  await showInitial(makeDoc({ html: head, restId: 6 }));
  click(document.getElementById('jump'));
  await flush();
  assert.equal(log.some((entry) => entry.kind === 'scroll' && entry.id === 'top'), true);
  assert.equal(log.some((entry) => entry.kind === 'append'), false);
  pending('doc_rest').resolve(rest);
  await flush();
  assert.equal(docEl.innerHTML, head + rest);
  assert.equal(readyCount(), 1);
}

async function fragmentWaitsForRest() {
  const head = '<h1 id="top">Top</h1><a href="#a%20b" id="jump">Jump</a>';
  const rest = '<h2 id="a b">Tail</h2>';
  await showInitial(makeDoc({ html: head, restId: 6 }));
  viewEl.scrollTop = 80;
  click(document.getElementById('jump'));
  await flush();
  assert.equal(log.some((entry) => entry.kind === 'scroll'), false);
  assert.equal(viewEl.scrollTop, 80);
  pending('doc_rest').resolve(rest);
  await flush();
  assert.equal(docEl.innerHTML, head + rest);
  assert.equal(log.some((entry) => entry.kind === 'scroll' && entry.id === 'a b'), true);
}

async function fragmentMissingAfterRest() {
  const head = '<a href="#missing" id="jump">Jump</a>';
  const rest = '<p id="tail">Tail</p>';
  await showInitial(makeDoc({ html: head, restId: 6 }));
  viewEl.scrollTop = 80;
  click(document.getElementById('jump'));
  pending('doc_rest').resolve(rest);
  await flush();
  assert.equal(viewEl.scrollTop, 0);
  assert.equal(log.some((entry) => entry.kind === 'scroll'), false);
  assert.equal(docEl.innerHTML, head + rest);
}

async function fragmentStaleAfterNewRequest() {
  const head = '<h1 id="top">Top</h1><a href="#tail" id="jump">Jump</a>';
  await showInitial(makeDoc({ html: head, restId: 6 }));
  keydown({ key: 'o', ctrlKey: true });
  dialogWait.resolve(PATH_B);
  await flush();
  const opening = pending('open_file');
  viewEl.scrollTop = 80;
  click(document.getElementById('jump'));
  pending('doc_rest').resolve('<h2 id="tail">Tail</h2>');
  await flush();
  assert.equal(docEl.innerHTML, head);
  assert.equal(viewEl.scrollTop, 80);
  assert.equal(log.some((entry) => entry.kind === 'scroll'), false);
  assert.equal(bannerEl.hidden, true);
  opening.resolve(makeDoc({ path: PATH_B, title: 'b.md', html: '<p id="b">B</p>', restId: null }));
  await flush();
  assert.equal(docEl.innerHTML, '<p id="b">B</p>');
}

async function reloadPositioned() {
  const head = '<h1 id="top">Old</h1>';
  const rest = '<p id="old-tail">Old tail</p>';
  const nextHead = '<h1 id="top">New</h1>';
  const nextRest = '<p id="new-tail">New tail</p>';
  await showInitial(makeDoc({ html: head, restId: 1 }));
  pending('doc_rest').resolve(rest);
  await flush();
  viewEl.scrollTop = 150;
  keydown({ key: 'F5' });
  await flush();
  const opened = pending('open_file');
  assert.deepEqual(opened.args, { path: PATH_A });
  opened.resolve(makeDoc({ html: nextHead, restId: 9 }));
  await flush();
  assert.equal(docEl.innerHTML, head + rest);
  const restCall = pending('doc_rest');
  assert.deepEqual(restCall.args, { id: 9 });
  let saw = null;
  restCall.resolve(nextRest);
  queueMicrotask(() => {
    saw = docEl.innerHTML;
  });
  await flush();
  assert.equal(saw, nextHead + nextRest);
  const htmlAt = log.findIndex((entry) => entry.kind === 'html' && entry.value === nextHead);
  assert.equal(log[htmlAt].isLarge, true);
  assert.equal(log[htmlAt + 1].kind, 'append');
  assert.equal(log[htmlAt + 1].value, nextRest);
  assert.equal(log.some((entry) => entry.kind === 'scroll'), true);
  assert.equal(readyCount(), 1);
}

async function reloadUnsplit() {
  const html = '<h1 id="top">Old</h1>';
  const next = '<h1 id="top">New</h1>';
  await showInitial(makeDoc({ html, restId: null }));
  viewEl.scrollTop = 150;
  keydown({ key: 'F5' });
  await flush();
  let saw = null;
  pending('open_file').resolve(makeDoc({ html: next, restId: null }));
  queueMicrotask(() => {
    saw = docEl.innerHTML;
  });
  await flush();
  assert.equal(saw, next);
  assert.equal(calls.some((call) => call.command === 'doc_rest'), false);
  assert.equal(log.find((entry) => entry.kind === 'html' && entry.value === next).isLarge, false);
  assert.equal(log.some((entry) => entry.kind === 'scroll'), true);
}

async function reloadRestError() {
  const nextHead = '<h1 id="kept">Kept</h1>';
  await showInitial(makeDoc({ html: '<h1 id="top">Old</h1>', restId: null }));
  keydown({ key: 'F5' });
  await flush();
  pending('open_file').resolve(makeDoc({ html: nextHead, restId: 3 }));
  await flush();
  assert.equal(docEl.innerHTML, '<h1 id="top">Old</h1>');
  pending('doc_rest').reject('Could not read the rest');
  await flush();
  assert.equal(docEl.innerHTML, nextHead);
  assert.equal(docEl.classList.contains('is-large'), true);
  assert.equal(log.some((entry) => entry.kind === 'append'), false);
  assert.equal(bannerEl.hidden, false);
  assert.equal(errorText.textContent, 'Could not read the rest');
}

async function positionedFragment() {
  const headA = `<p id="top">A</p><a href="b.md#tail" data-local-path="${PATH_B}" data-fragment="tail" id="to-b">B</a>`;
  const headB = '<h1 id="top">B head</h1>';
  const restB = '<h2 id="tail">B tail</h2>';
  await showInitial(makeDoc({ html: headA, restId: null }));
  click(document.getElementById('to-b'));
  await flush();
  const opened = pending('open_file');
  assert.deepEqual(opened.args, { path: PATH_B });
  opened.resolve(makeDoc({ path: PATH_B, title: 'b.md', html: headB, restId: 8 }));
  await flush();
  assert.equal(docEl.innerHTML, headA);
  const restCall = pending('doc_rest');
  assert.deepEqual(restCall.args, { id: 8 });
  let saw = null;
  restCall.resolve(restB);
  queueMicrotask(() => {
    saw = docEl.innerHTML;
  });
  await flush();
  assert.equal(saw, headB + restB);
  assert.equal(log.filter((entry) => entry.kind === 'scroll').at(-1).id, 'tail');
  assert.equal(document.getElementById('doc-title').textContent, 'b.md');
  assert.equal(readyCount(), 1);
}

async function positionedFragmentUnsplit() {
  const headA = `<a href="b.md#top" data-local-path="${PATH_B}" data-fragment="top" id="to-b">B</a>`;
  const htmlB = '<h1 id="top">Whole B</h1>';
  await showInitial(makeDoc({ html: headA, restId: null }));
  click(document.getElementById('to-b'));
  await flush();
  let saw = null;
  pending('open_file').resolve(makeDoc({ path: PATH_B, title: 'b.md', html: htmlB, restId: null }));
  queueMicrotask(() => {
    saw = docEl.innerHTML;
  });
  await flush();
  assert.equal(saw, htmlB);
  assert.equal(calls.some((call) => call.command === 'doc_rest'), false);
  assert.equal(log.some((entry) => entry.kind === 'scroll' && entry.id === 'top'), true);
}

async function positionedRestError() {
  const headA = '<h1 id="top">A</h1>';
  const headB = '<h1 id="top">B head</h1>';
  const link = `<a href="b.md#tail" data-local-path="${PATH_B}" data-fragment="tail" id="to-b">B</a>`;
  await showInitial(makeDoc({ html: headA + link, restId: null }));
  click(document.getElementById('to-b'));
  await flush();
  pending('open_file').resolve(makeDoc({ path: PATH_B, title: 'b.md', html: headB, restId: 4 }));
  await flush();
  pending('doc_rest').reject('Rest missing');
  await flush();
  assert.equal(docEl.innerHTML, headB);
  assert.equal(log.some((entry) => entry.kind === 'append'), false);
  assert.equal(bannerEl.hidden, false);
  assert.equal(errorText.textContent, 'Rest missing');
  assert.equal(docEl.classList.contains('is-large'), true);
  keydown({ key: 'ArrowLeft', altKey: true });
  await flush();
  assert.deepEqual(pending('open_file').args, { path: PATH_A });
}

async function positionedStaleRejection() {
  const htmlA = '<h1 id="top">Stay</h1>';
  const link = `<a href="b.md#tail" data-local-path="${PATH_B}" data-fragment="tail" id="to-b">B</a>`;
  await showInitial(makeDoc({ html: htmlA + link, restId: null }));
  click(document.getElementById('to-b'));
  await flush();
  pending('open_file').resolve(makeDoc({ path: PATH_B, title: 'b.md', html: '<h1 id="b">B</h1>', restId: 4 }));
  await flush();
  const restCall = pending('doc_rest');
  assert.equal(docEl.innerHTML, htmlA + link);
  keydown({ key: 'F5' });
  await flush();
  const reload = pending('open_file');
  assert.deepEqual(reload.args, { path: PATH_A });
  restCall.reject('Stale document part');
  await flush();
  assert.equal(bannerEl.hidden, true);
  assert.equal(docEl.innerHTML, htmlA + link);
  assert.equal(log.some((entry) => entry.kind === 'append'), false);
}

async function fileChangedDropsPendingRest() {
  const head = '<h1 id="top">Head</h1>';
  const head2 = '<h1 id="top">Head 2</h1>';
  const rest2 = '<p id="tail">Rest 2</p>';
  await showInitial(makeDoc({ html: head, restId: 1 }));
  const oldRest = pending('doc_rest');
  fileChanged(PATH_A);
  await flush();
  const opened = pending('open_file');
  oldRest.resolve('<p id="ghost">GHOST</p>');
  await flush();
  assert.equal(docEl.innerHTML, head);
  assert.equal(document.getElementById('ghost'), null);
  opened.resolve(makeDoc({ html: head2, restId: 2 }));
  await flush();
  assert.equal(docEl.innerHTML, head);
  let saw = null;
  pending('doc_rest').resolve(rest2);
  queueMicrotask(() => {
    saw = docEl.innerHTML;
  });
  await flush();
  assert.equal(saw, head2 + rest2);
  assert.equal(docEl.innerHTML.includes('GHOST'), false);
}

async function historyBackDropsRest() {
  const headA = `<p id="a">A</p><a href="b.md" data-local-path="${PATH_B}" id="to-b">B</a>`;
  const headB = '<h1 id="b">B head</h1>';
  const restB = '<p id="b-tail">B tail</p>';
  await showInitial(makeDoc({ html: headA, restId: null }));
  click(document.getElementById('to-b'));
  await flush();
  pending('open_file').resolve(makeDoc({ path: PATH_B, title: 'b.md', html: headB, restId: 3 }));
  await flush();
  assert.equal(docEl.innerHTML, headB);
  assert.equal(lastHtml().isLarge, true);
  assert.equal(log.some((entry) => entry.kind === 'append'), false);
  const restCall = pending('doc_rest');
  assert.equal(readyCount(), 1);
  keydown({ key: 'ArrowLeft', altKey: true });
  await flush();
  const back = pending('open_file');
  assert.deepEqual(back.args, { path: PATH_A });
  restCall.resolve(restB);
  await flush();
  assert.equal(docEl.innerHTML, headB);
  assert.equal(document.getElementById('b-tail'), null);
  back.resolve(makeDoc({ html: headA, restId: null }));
  await flush();
  assert.equal(docEl.innerHTML, headA);
  assert.equal(docEl.classList.contains('is-large'), false);
  keydown({ key: 'ArrowRight', altKey: true });
  await flush();
  pending('open_file').resolve(makeDoc({ path: PATH_B, title: 'b.md', html: headB, restId: 11 }));
  await flush();
  assert.equal(docEl.innerHTML, headB);
  assert.deepEqual(pending('doc_rest').args, { id: 11 });
}

async function dropOpen() {
  const head = '<h1 id="c">C</h1>';
  const rest = '<p id="c-tail">C tail</p>';
  await showInitial(makeDoc({ html: '<p id="a">A</p>', restId: null }));
  drop(['', PATH_C, PATH_B]);
  await flush();
  const opened = pending('open_file');
  assert.deepEqual(opened.args, { path: PATH_C });
  let saw = null;
  opened.resolve(makeDoc({ path: PATH_C, title: 'c.md', html: head, restId: 15 }));
  queueMicrotask(() => {
    saw = { html: docEl.innerHTML, commands: commandNames().slice() };
  });
  await flush();
  assert.equal(saw.html, head);
  assert.equal(saw.commands.at(-1), 'doc_rest');
  assert.equal(readyCount(), 1);
  assert.equal(lastHtml().isLarge, true);
  pending('doc_rest').resolve(rest);
  await flush();
  assert.equal(docEl.innerHTML, head + rest);
}

async function restIdZero() {
  const saw = await showInitial(makeDoc({ html: '<h1 id="top">Top</h1>', restId: 0 }));
  assert.deepEqual(saw.commands, ['initial_doc', 'mark_ready', 'doc_rest']);
  assert.deepEqual(pending('doc_rest').args, { id: 0 });
  assert.equal(log.find((entry) => entry.kind === 'html').isLarge, true);
}

const scenarios = {
  'startup-split': startupSplit,
  'startup-null-rest': startupNullRest,
  'startup-missing-rest-large': startupMissingRestLarge,
  'startup-error': startupError,
  'startup-file-changed': startupFileChanged,
  'startup-other-file-changed': startupOtherFileChanged,
  'progressive-rest-error': progressiveRestError,
  'rest-not-string': restNotString,
  'stale-rest-dropped-on-open': staleRestDroppedOnOpen,
  'fragment-in-head': fragmentInHead,
  'fragment-waits-for-rest': fragmentWaitsForRest,
  'fragment-missing-after-rest': fragmentMissingAfterRest,
  'fragment-stale-after-new-request': fragmentStaleAfterNewRequest,
  'reload-positioned': reloadPositioned,
  'reload-unsplit': reloadUnsplit,
  'reload-rest-error': reloadRestError,
  'positioned-fragment': positionedFragment,
  'positioned-fragment-unsplit': positionedFragmentUnsplit,
  'positioned-rest-error': positionedRestError,
  'positioned-stale-rejection': positionedStaleRejection,
  'file-changed-drops-pending-rest': fileChangedDropsPendingRest,
  'history-back-drops-rest': historyBackDropsRest,
  'drop-open': dropOpen,
  'rest-id-zero': restIdZero,
};

process.on('unhandledRejection', (err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

const name = process.argv[2];
const scenario = scenarios[name];
if (!scenario) {
  console.error(`unknown scenario ${name}`);
  process.exit(1);
}
scenario().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
