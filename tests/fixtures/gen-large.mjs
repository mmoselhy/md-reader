// Writes tests/fixtures/large.md (~1 MB) by repeating sample.md. Usage: node tests/fixtures/gen-large.mjs [sizeBytes]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const target = Number(process.argv[2] ?? 1024 * 1024);
const body = readFileSync(join(here, 'sample.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');

const parts = [];
let size = 0;
for (let i = 0; size < target; i++) {
  const chunk = `\n# Copy ${i}\n\n${body}`;
  parts.push(chunk);
  size += Buffer.byteLength(chunk);
}
writeFileSync(join(here, 'large.md'), parts.join(''));
console.log(`wrote large.md: ${size} bytes, ${parts.length} copies`);
