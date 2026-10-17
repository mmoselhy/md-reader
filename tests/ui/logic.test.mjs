import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampScroll,
  clampZoom,
  classifyLink,
  createHistory,
  isMarkdownPath,
  nextThemeMode,
  resolveTheme,
  stepZoom,
} from '../../src/logic.js';

test('nextThemeMode cycles system → light → dark → system', () => {
  assert.equal(nextThemeMode('system'), 'light');
  assert.equal(nextThemeMode('light'), 'dark');
  assert.equal(nextThemeMode('dark'), 'system');
  assert.equal(nextThemeMode(nextThemeMode(nextThemeMode('system'))), 'system');
});

test('nextThemeMode treats unknown values as system', () => {
  assert.equal(nextThemeMode(undefined), 'light');
  assert.equal(nextThemeMode(null), 'light');
  assert.equal(nextThemeMode(''), 'light');
  assert.equal(nextThemeMode('LIGHT'), 'light');
  assert.equal(nextThemeMode('blue'), 'light');
});

test('resolveTheme honors an explicit mode and follows the system otherwise', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme(undefined, true), 'dark');
  assert.equal(resolveTheme('nope', false), 'light');
});

test('clampZoom snaps to 10% and clamps both ends', () => {
  assert.equal(clampZoom(70), 70);
  assert.equal(clampZoom(200), 200);
  assert.equal(clampZoom(100), 100);
  assert.equal(clampZoom(75), 80);
  assert.equal(clampZoom(74), 70);
  assert.equal(clampZoom(195), 200);
  assert.equal(clampZoom(194), 190);
  assert.equal(clampZoom(69), 70);
  assert.equal(clampZoom(0), 70);
  assert.equal(clampZoom(-40), 70);
  assert.equal(clampZoom(201), 200);
  assert.equal(clampZoom(10000), 200);
  assert.equal(clampZoom('130'), 130);
  assert.equal(clampZoom('200.4'), 200);
});

test('clampZoom falls back to 100 for empty or non-numeric values', () => {
  assert.equal(clampZoom(Number.NaN), 100);
  assert.equal(clampZoom(Number.POSITIVE_INFINITY), 100);
  assert.equal(clampZoom('nope'), 100);
  assert.equal(clampZoom(''), 100);
  assert.equal(clampZoom(null), 100);
  assert.equal(clampZoom(undefined), 100);
});

test('stepZoom moves one 10% step, clamps both ends, and resets', () => {
  assert.equal(stepZoom(100, 1), 110);
  assert.equal(stepZoom(100, -1), 90);
  assert.equal(stepZoom(70, -1), 70);
  assert.equal(stepZoom(71, -1), 70);
  assert.equal(stepZoom(200, 1), 200);
  assert.equal(stepZoom(191, 1), 200);
  assert.equal(stepZoom(199, 1), 200);
  assert.equal(stepZoom(150, 0), 100);
  assert.equal(stepZoom(70, 0), 100);
  assert.equal(stepZoom(200, 0), 100);
  assert.equal(stepZoom(100, 5), 110);
  assert.equal(stepZoom(100, -4), 90);
  assert.equal(stepZoom('nope', 1), 110);
  assert.equal(stepZoom(140, 'in'), 140);
});

test('isMarkdownPath accepts the markdown extensions in any case', () => {
  assert.equal(isMarkdownPath('notes.md'), true);
  assert.equal(isMarkdownPath('notes.MD'), true);
  assert.equal(isMarkdownPath('notes.MarkDown'), true);
  assert.equal(isMarkdownPath('notes.markdown'), true);
  assert.equal(isMarkdownPath('notes.mdown'), true);
  assert.equal(isMarkdownPath('notes.mkd'), true);
  assert.equal(isMarkdownPath('notes.mkdn'), true);
  assert.equal(isMarkdownPath('NOTES.MKDN'), true);
  assert.equal(isMarkdownPath('C:\\docs\\A.MD'), true);
  assert.equal(isMarkdownPath('C:/docs/sub/a.Md'), true);
  assert.equal(isMarkdownPath('C:\\docs\\sub\\a.markdown\\'), true);
});

test('isMarkdownPath rejects non-markdown and empty values', () => {
  assert.equal(isMarkdownPath('notes.txt'), false);
  assert.equal(isMarkdownPath('notes.md.txt'), false);
  assert.equal(isMarkdownPath('notes'), false);
  assert.equal(isMarkdownPath('notes.md.bak'), false);
  assert.equal(isMarkdownPath(''), false);
  assert.equal(isMarkdownPath('   '), false);
  assert.equal(isMarkdownPath(null), false);
  assert.equal(isMarkdownPath(undefined), false);
  assert.equal(isMarkdownPath(12), false);
});

test('classifyLink identifies fragments, web URLs, and missing hrefs', () => {
  assert.equal(classifyLink({ href: '#x' }), 'fragment');
  assert.equal(classifyLink({ href: '#tables' }), 'fragment');
  assert.equal(classifyLink({ href: '#' }), 'fragment');
  assert.equal(classifyLink({ href: '  #section  ' }), 'fragment');
  assert.equal(classifyLink({ href: 'https://example.com' }), 'external');
  assert.equal(classifyLink({ href: 'http://example.com/a' }), 'external');
  assert.equal(classifyLink({ href: 'HTTPS://example.com' }), 'external');
  assert.equal(classifyLink({ href: 'mailto:someone@example.com' }), 'external');
  assert.equal(classifyLink({ href: 'MAILTO:someone@example.com' }), 'external');
  assert.equal(classifyLink({}), 'ignore');
  assert.equal(classifyLink({ href: undefined }), 'ignore');
  assert.equal(classifyLink({ href: '' }), 'ignore');
  assert.equal(classifyLink({ href: '   ' }), 'ignore');
  assert.equal(classifyLink(), 'ignore');
});

test('classifyLink ignores non-http schemes and unresolved relative links', () => {
  assert.equal(classifyLink({ href: 'javascript:alert(1)' }), 'ignore');
  assert.equal(classifyLink({ href: 'tel:123' }), 'ignore');
  assert.equal(classifyLink({ href: 'file:///C:/a.md' }), 'ignore');
  assert.equal(classifyLink({ href: 'ftp://example.com/a.md' }), 'ignore');
  assert.equal(classifyLink({ href: 'other.md' }), 'ignore');
  assert.equal(classifyLink({ href: 'notes.txt' }), 'ignore');
  assert.equal(classifyLink({ href: '//example.com' }), 'ignore');
});

test('classifyLink uses data-local-path for markdown and other local files', () => {
  assert.equal(classifyLink({ href: 'A.MD', localPath: 'C:\\docs\\A.MD' }), 'markdown');
  assert.equal(classifyLink({ href: 'note.markdown', localPath: 'C:\\docs\\note.markdown' }), 'markdown');
  assert.equal(classifyLink({ href: 'a.mdown', localPath: 'C:/docs/a.mdown' }), 'markdown');
  assert.equal(classifyLink({ href: 'a.mkd', localPath: 'C:\\docs\\a.mkd' }), 'markdown');
  assert.equal(classifyLink({ href: 'a.mkdn', localPath: 'C:\\docs\\a.MKDN' }), 'markdown');
  assert.equal(classifyLink({ href: 'notes.txt', localPath: 'C:\\docs\\notes.txt' }), 'local');
  assert.equal(classifyLink({ href: 'pixel.png', localPath: 'C:\\docs\\images\\pixel.png' }), 'local');
  assert.equal(classifyLink({ localPath: 'C:\\docs\\readme.md' }), 'markdown');
  assert.equal(
    classifyLink({ href: '#section', localPath: 'C:\\docs\\other.md' }),
    'markdown',
  );
  assert.equal(classifyLink({ href: 'https://example.com', localPath: 'C:\\docs\\notes.txt' }), 'local');
  assert.equal(classifyLink({ href: '#x', localPath: '   ' }), 'fragment');
});

test('history starts empty and moves one step at a time', () => {
  const history = createHistory();
  assert.equal(history.canBack(), false);
  assert.equal(history.canForward(), false);
  assert.equal(history.back(), null);
  assert.equal(history.forward(), null);

  history.push('a');
  assert.equal(history.canBack(), false);
  assert.equal(history.canForward(), false);
  assert.equal(history.back(), null);
  assert.equal(history.forward(), null);

  history.push('b');
  history.push('c');
  assert.equal(history.canBack(), true);
  assert.equal(history.canForward(), false);
  assert.equal(history.back(), 'b');
  assert.equal(history.canBack(), true);
  assert.equal(history.canForward(), true);
  assert.equal(history.back(), 'a');
  assert.equal(history.canBack(), false);
  assert.equal(history.back(), null);
  assert.equal(history.forward(), 'b');
  assert.equal(history.forward(), 'c');
  assert.equal(history.forward(), null);
  assert.equal(history.canForward(), false);
});

test('history push after back truncates forward entries', () => {
  const history = createHistory();
  history.push('a');
  history.push('b');
  history.push('c');
  assert.equal(history.back(), 'b');
  assert.equal(history.back(), 'a');
  assert.equal(history.canForward(), true);
  history.push('d');
  assert.equal(history.canForward(), false);
  assert.equal(history.canBack(), true);
  assert.equal(history.back(), 'a');
  assert.equal(history.canBack(), false);
  assert.equal(history.forward(), 'd');
  assert.equal(history.forward(), null);
  assert.equal(history.canForward(), false);
});

test('history instances do not share entries', () => {
  const a = createHistory();
  const b = createHistory();
  a.push('a');
  a.push('b');
  assert.equal(b.canBack(), false);
  assert.equal(b.back(), null);
  assert.equal(a.back(), 'a');
});

test('clampScroll keeps offsets inside the scroll range', () => {
  assert.equal(clampScroll(10, 100), 10);
  assert.equal(clampScroll(0, 100), 0);
  assert.equal(clampScroll(100, 100), 100);
  assert.equal(clampScroll(-5, 100), 0);
  assert.equal(clampScroll(150, 100), 100);
  assert.equal(clampScroll(50, 0), 0);
  assert.equal(clampScroll(50, -10), 0);
  assert.equal(clampScroll(Number.NaN, 100), 0);
  assert.equal(clampScroll(10, Number.NaN), 0);
  assert.equal(clampScroll(Number.POSITIVE_INFINITY, 80), 0);
  assert.equal(clampScroll('40', '80'), 40);
  assert.equal(clampScroll('90', '80'), 80);
});
