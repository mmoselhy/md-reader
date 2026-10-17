import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const harness = fileURLToPath(new URL('./split-harness.mjs', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));

const scenarios = [
  'startup-split',
  'startup-null-rest',
  'startup-missing-rest-large',
  'startup-error',
  'startup-file-changed',
  'startup-other-file-changed',
  'progressive-rest-error',
  'rest-not-string',
  'stale-rest-dropped-on-open',
  'fragment-in-head',
  'fragment-waits-for-rest',
  'fragment-missing-after-rest',
  'fragment-stale-after-new-request',
  'reload-positioned',
  'reload-unsplit',
  'reload-rest-error',
  'positioned-fragment',
  'positioned-fragment-unsplit',
  'positioned-rest-error',
  'positioned-stale-rejection',
  'file-changed-drops-pending-rest',
  'history-back-drops-rest',
  'drop-open',
  'rest-id-zero',
];

for (const name of scenarios) {
  test(name, async () => {
    const child = spawn(process.execPath, [harness, name], { cwd: root, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(code, 0, stderr || stdout || `scenario ${name} failed`);
  });
}
