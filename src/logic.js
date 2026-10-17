// Pure UI rules. No DOM and no Tauri.

const THEME_MODES = ['system', 'light', 'dark'];
const MD_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn']);
const ZOOM_MIN = 70;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;

/** Cycles system → light → dark → system. Unknown values behave as system. */
export function nextThemeMode(mode) {
  const index = THEME_MODES.indexOf(mode);
  const current = index === -1 ? 0 : index;
  return THEME_MODES[(current + 1) % THEME_MODES.length];
}

/** Resolves system from `systemDark`. Any mode other than light or dark follows the system. */
export function resolveTheme(mode, systemDark) {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return systemDark ? 'dark' : 'light';
}

/**
 * Nearest 10% step inside 70–200. Non-numeric values (and nullish / blank
 * strings) fall back to 100 so a bad stored zoom cannot blank the page.
 */
export function clampZoom(value) {
  if (value === null || value === undefined || value === '') return 100;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 100;
  const stepped = Math.round(n / ZOOM_STEP) * ZOOM_STEP;
  if (stepped < ZOOM_MIN) return ZOOM_MIN;
  if (stepped > ZOOM_MAX) return ZOOM_MAX;
  return stepped;
}

/** `direction` > 0 zooms in one step, < 0 zooms out one step, 0 resets to 100. */
export function stepZoom(current, direction) {
  if (direction === 0) return 100;
  if (!(direction > 0) && !(direction < 0)) return clampZoom(current);
  const delta = direction > 0 ? ZOOM_STEP : -ZOOM_STEP;
  return clampZoom(clampZoom(current) + delta);
}

/** True for .md .markdown .mdown .mkd .mkdn, any case, including Windows paths. */
export function isMarkdownPath(path) {
  if (typeof path !== 'string') return false;
  let value = path.trim().replaceAll('/', '\\');
  if (!value) return false;
  while (value.length > 3 && value.endsWith('\\')) value = value.slice(0, -1);
  const slash = value.lastIndexOf('\\');
  const base = slash === -1 ? value : value.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot < 0) return false;
  return MD_EXTS.has(base.slice(dot).toLowerCase());
}

/**
 * Classify a clicked anchor.
 * `localPath` (data-local-path) wins: the backend already resolved it.
 * Otherwise only a pure `#fragment` or an http(s)/mailto URL is actionable.
 */
export function classifyLink(input) {
  const source = input && typeof input === 'object' ? input : {};
  const localPath = typeof source.localPath === 'string' ? source.localPath.trim() : '';
  const href = typeof source.href === 'string' ? source.href.trim() : '';
  if (localPath) return isMarkdownPath(localPath) ? 'markdown' : 'local';
  if (!href) return 'ignore';
  if (href.startsWith('#')) return 'fragment';
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href);
  if (!match) return 'ignore';
  const scheme = match[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return 'external';
  return 'ignore';
}

/**
 * Session history of document paths opened by following links.
 * `push` after `back` drops the forward tail.
 */
export function createHistory() {
  /** @type {unknown[]} */
  let entries = [];
  let index = -1;
  return {
    push(path) {
      entries = entries.slice(0, index + 1);
      entries.push(path);
      index = entries.length - 1;
    },
    back() {
      if (index <= 0) return null;
      index -= 1;
      return entries[index];
    },
    forward() {
      if (index >= entries.length - 1) return null;
      index += 1;
      return entries[index];
    },
    canBack() {
      return index > 0;
    },
    canForward() {
      return index < entries.length - 1;
    },
  };
}

/** Clamp a scroll offset into [0, maxTop]. Non-finite inputs become 0. */
export function clampScroll(top, maxTop) {
  const max = Number(maxTop);
  const limit = Number.isFinite(max) && max > 0 ? max : 0;
  const value = Number(top);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value > limit) return limit;
  return value;
}
